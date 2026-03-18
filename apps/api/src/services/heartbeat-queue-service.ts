import { and, eq } from "drizzle-orm";
import {
  cancelHeartbeatJob,
  getHeartbeatRun,
  claimNextHeartbeatJob,
  enqueueHeartbeatJob,
  issueComments,
  markHeartbeatJobCompleted,
  markHeartbeatJobDeadLetter,
  markHeartbeatJobRetry,
  updateIssueCommentRecipients,
  type BopoDb
} from "bopodev-db";
import { parseIssueCommentRecipients } from "../lib/comment-recipients";
import type { RealtimeHub } from "../realtime/hub";
import { runHeartbeatForAgent } from "./heartbeat-service";

type QueueJobPayload = {
  sourceRunId?: string;
  wakeContext?: {
    reason?: string | null;
    commentId?: string | null;
    issueIds?: string[];
  };
  commentDispatch?: {
    commentId: string;
    issueId: string;
    recipientId: string;
  };
};

const activeCompanyQueueWorkers = new Set<string>();

export async function enqueueHeartbeatQueueJob(
  db: BopoDb,
  input: {
    companyId: string;
    agentId: string;
    jobType: "manual" | "scheduler" | "resume" | "redo" | "comment_dispatch";
    payload?: QueueJobPayload;
    priority?: number;
    idempotencyKey?: string | null;
    maxAttempts?: number;
    availableAt?: Date;
  }
) {
  return enqueueHeartbeatJob(db, {
    companyId: input.companyId,
    agentId: input.agentId,
    jobType: input.jobType,
    payload: input.payload ?? {},
    priority: input.priority ?? 100,
    idempotencyKey: input.idempotencyKey ?? null,
    maxAttempts: input.maxAttempts ?? 10,
    availableAt: input.availableAt
  });
}

export function triggerHeartbeatQueueWorker(
  db: BopoDb,
  companyId: string,
  options?: { requestId?: string; realtimeHub?: RealtimeHub; maxJobsPerSweep?: number }
) {
  if (activeCompanyQueueWorkers.has(companyId)) {
    return;
  }
  activeCompanyQueueWorkers.add(companyId);
  queueMicrotask(() => {
    void runHeartbeatQueueSweep(db, companyId, options)
      .catch((error) => {
        // eslint-disable-next-line no-console
        console.error("[heartbeat-queue] worker run failed", error);
      })
      .finally(() => {
        activeCompanyQueueWorkers.delete(companyId);
      });
  });
}

export async function runHeartbeatQueueSweep(
  db: BopoDb,
  companyId: string,
  options?: { requestId?: string; realtimeHub?: RealtimeHub; maxJobsPerSweep?: number }
) {
  const maxJobs = Math.max(1, Math.min(options?.maxJobsPerSweep ?? 50, 500));
  let processed = 0;
  while (processed < maxJobs) {
    const job = await claimNextHeartbeatJob(db, companyId);
    if (!job) {
      break;
    }
    processed += 1;
    try {
      await processHeartbeatQueueJob(db, {
        companyId,
        job: {
          id: job.id,
          agentId: job.agentId,
          jobType: job.jobType as "manual" | "scheduler" | "resume" | "redo" | "comment_dispatch",
          attemptCount: job.attemptCount,
          maxAttempts: job.maxAttempts,
          payload: (job.payload ?? {}) as QueueJobPayload
        },
        requestId: options?.requestId,
        realtimeHub: options?.realtimeHub
      });
    } catch (error) {
      await handleQueueRetryOrDeadLetter(db, {
        companyId,
        jobId: job.id,
        attemptCount: job.attemptCount,
        maxAttempts: job.maxAttempts,
        error: `Queue processing failed: ${String((error as Error)?.message ?? error)}`
      });
    }
  }
  return { processed };
}

async function processHeartbeatQueueJob(
  db: BopoDb,
  input: {
    companyId: string;
    job: {
      id: string;
      agentId: string;
      jobType: "manual" | "scheduler" | "resume" | "redo" | "comment_dispatch";
      attemptCount: number;
      maxAttempts: number;
      payload: QueueJobPayload;
    };
    requestId?: string;
    realtimeHub?: RealtimeHub;
  }
) {
  let runId: string | null = null;
  try {
    runId = await runHeartbeatForAgent(db, input.companyId, input.job.agentId, {
      trigger: input.job.jobType === "manual" || input.job.jobType === "resume" || input.job.jobType === "redo" ? "manual" : "scheduler",
      requestId: input.requestId,
      realtimeHub: input.realtimeHub,
      ...(input.job.jobType === "resume" || input.job.jobType === "redo" ? { mode: input.job.jobType } : {}),
      ...(input.job.payload.sourceRunId ? { sourceRunId: input.job.payload.sourceRunId } : {}),
      ...(input.job.payload.wakeContext ? { wakeContext: input.job.payload.wakeContext } : {})
    });
  } catch (error) {
    await handleQueueRetryOrDeadLetter(db, {
      companyId: input.companyId,
      jobId: input.job.id,
      attemptCount: input.job.attemptCount,
      maxAttempts: input.job.maxAttempts,
      error: `Heartbeat executor failed: ${String((error as Error)?.message ?? error)}`
    });
    return;
  }

  if (!runId) {
    await handleQueueRetryOrDeadLetter(db, {
      companyId: input.companyId,
      jobId: input.job.id,
      attemptCount: input.job.attemptCount,
      maxAttempts: input.job.maxAttempts,
      error: "Heartbeat execution returned no run id."
    });
    return;
  }

  const run = await getHeartbeatRun(db, input.companyId, runId);
  if (!run) {
    await handleQueueRetryOrDeadLetter(db, {
      companyId: input.companyId,
      jobId: input.job.id,
      attemptCount: input.job.attemptCount,
      maxAttempts: input.job.maxAttempts,
      heartbeatRunId: runId,
      error: "Heartbeat run record was not found after execution."
    });
    return;
  }

  if (run.status === "skipped" && String(run.message ?? "").toLowerCase().includes("already in progress")) {
    await markHeartbeatJobRetry(db, {
      companyId: input.companyId,
      id: input.job.id,
      heartbeatRunId: runId,
      retryAt: new Date(Date.now() + resolveRetryDelayMs(input.job.attemptCount)),
      error: "Agent busy, retry queued."
    });
    return;
  }

  if (run.status === "skipped") {
    if (isProjectBudgetHardStopMessage(run.message)) {
      await cancelHeartbeatJob(db, {
        companyId: input.companyId,
        id: input.job.id
      });
      return;
    }
    await handleQueueRetryOrDeadLetter(db, {
      companyId: input.companyId,
      jobId: input.job.id,
      attemptCount: input.job.attemptCount,
      maxAttempts: input.job.maxAttempts,
      heartbeatRunId: runId,
      error: run.message ?? "Heartbeat skipped."
    });
    await markCommentRecipientDeliveryIfNeeded(db, input.companyId, input.job.payload.commentDispatch, {
      deliveryStatus: "failed",
      dispatchedRunId: null,
      dispatchedAt: null
    });
    return;
  }

  await markHeartbeatJobCompleted(db, {
    companyId: input.companyId,
    id: input.job.id,
    heartbeatRunId: runId
  });
  await markCommentRecipientDeliveryIfNeeded(db, input.companyId, input.job.payload.commentDispatch, {
    deliveryStatus: "dispatched",
    dispatchedRunId: runId,
    dispatchedAt: new Date().toISOString()
  });
}

async function handleQueueRetryOrDeadLetter(
  db: BopoDb,
  input: {
    companyId: string;
    jobId: string;
    attemptCount: number;
    maxAttempts: number;
    error: string;
    heartbeatRunId?: string;
  }
) {
  if (input.attemptCount >= input.maxAttempts) {
    await markHeartbeatJobDeadLetter(db, {
      companyId: input.companyId,
      id: input.jobId,
      heartbeatRunId: input.heartbeatRunId ?? null,
      error: input.error
    });
    return;
  }
  await markHeartbeatJobRetry(db, {
    companyId: input.companyId,
    id: input.jobId,
    heartbeatRunId: input.heartbeatRunId ?? null,
    retryAt: new Date(Date.now() + resolveRetryDelayMs(input.attemptCount)),
    error: input.error
  });
}

function resolveRetryDelayMs(attemptCount: number) {
  const baseDelayMs = Number(process.env.BOPO_HEARTBEAT_QUEUE_RETRY_BASE_MS ?? 1000);
  const cappedAttempt = Math.max(0, Math.min(attemptCount, 8));
  return Math.max(500, baseDelayMs) * 2 ** cappedAttempt;
}

function isProjectBudgetHardStopMessage(message: string | null | undefined) {
  const normalized = String(message ?? "")
    .trim()
    .toLowerCase();
  return normalized.includes("project budget hard-stop");
}

async function markCommentRecipientDeliveryIfNeeded(
  db: BopoDb,
  companyId: string,
  dispatch: QueueJobPayload["commentDispatch"] | undefined,
  input: {
    deliveryStatus: "dispatched" | "failed";
    dispatchedRunId: string | null;
    dispatchedAt: string | null;
  }
) {
  if (!dispatch) {
    return;
  }
  const [comment] = await db
    .select({ recipientsJson: issueComments.recipientsJson })
    .from(issueComments)
    .where(and(eq(issueComments.companyId, companyId), eq(issueComments.id, dispatch.commentId)))
    .limit(1);
  if (!comment) {
    return;
  }
  const recipients = parseIssueCommentRecipients(comment.recipientsJson);
  let changed = false;
  const updatedRecipients = recipients.map((recipient) => {
    if (recipient.recipientType !== "agent" || recipient.recipientId !== dispatch.recipientId) {
      return recipient;
    }
    if (recipient.deliveryStatus !== "pending") {
      return recipient;
    }
    changed = true;
    return {
      ...recipient,
      deliveryStatus: input.deliveryStatus,
      dispatchedRunId: input.dispatchedRunId,
      dispatchedAt: input.dispatchedAt
    };
  });
  if (!changed) {
    return;
  }
  await updateIssueCommentRecipients(db, {
    companyId,
    issueId: dispatch.issueId,
    id: dispatch.commentId,
    recipients: updatedRecipients
  });
}

