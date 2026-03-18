import { and, desc, eq, inArray, like } from "drizzle-orm";
import {
  agents,
  issueComments,
  updateIssueCommentRecipients,
  type BopoDb
} from "bopodev-db";
import type { RealtimeHub } from "../realtime/hub";
import { enqueueHeartbeatQueueJob, triggerHeartbeatQueueWorker } from "./heartbeat-queue-service";

type PersistedCommentRecipient = {
  recipientType: "agent" | "board" | "member";
  recipientId: string | null;
  deliveryStatus: "pending" | "dispatched" | "failed" | "skipped";
  dispatchedRunId: string | null;
  dispatchedAt: string | null;
  acknowledgedAt: string | null;
};

const COMMENT_DISPATCH_SWEEP_LIMIT = 100;
const activeCompanyDispatchRuns = new Set<string>();

export async function runIssueCommentDispatchSweep(
  db: BopoDb,
  companyId: string,
  options?: { requestId?: string; realtimeHub?: RealtimeHub; limit?: number }
) {
  const rows = await db
    .select({
      id: issueComments.id,
      issueId: issueComments.issueId,
      recipientsJson: issueComments.recipientsJson
    })
    .from(issueComments)
    .where(
      and(
        eq(issueComments.companyId, companyId),
        like(issueComments.recipientsJson, '%"deliveryStatus":"pending"%')
      )
    )
    .orderBy(desc(issueComments.createdAt))
    .limit(options?.limit ?? COMMENT_DISPATCH_SWEEP_LIMIT);

  for (const row of rows) {
    const recipients = parseIssueCommentRecipients(row.recipientsJson);
    if (!recipients.some((recipient) => recipient.deliveryStatus === "pending")) {
      continue;
    }
    const updatedRecipients = await dispatchCommentRecipients(db, {
      companyId,
      issueId: row.issueId,
      commentId: row.id,
      recipients,
      requestId: options?.requestId,
      realtimeHub: options?.realtimeHub
    });
    await updateIssueCommentRecipients(db, {
      companyId,
      issueId: row.issueId,
      id: row.id,
      recipients: updatedRecipients
    });
  }
}

export function triggerIssueCommentDispatchWorker(
  db: BopoDb,
  companyId: string,
  options?: { requestId?: string; realtimeHub?: RealtimeHub; limit?: number }
) {
  if (activeCompanyDispatchRuns.has(companyId)) {
    return;
  }
  activeCompanyDispatchRuns.add(companyId);
  queueMicrotask(() => {
    void runIssueCommentDispatchSweep(db, companyId, options)
      .catch((error) => {
        // eslint-disable-next-line no-console
        console.error("[comment-dispatch] immediate worker run failed", error);
      })
      .finally(() => {
        activeCompanyDispatchRuns.delete(companyId);
      });
  });
}

async function dispatchCommentRecipients(
  db: BopoDb,
  input: {
    companyId: string;
    issueId: string;
    commentId: string;
    recipients: PersistedCommentRecipient[];
    requestId?: string;
    realtimeHub?: RealtimeHub;
  }
) {
  if (input.recipients.length === 0) {
    return [];
  }
  const agentRecipientIds = input.recipients
    .filter((recipient) => recipient.recipientType === "agent" && recipient.recipientId)
    .map((recipient) => recipient.recipientId as string);
  const availableAgents = agentRecipientIds.length
    ? await db
        .select({ id: agents.id, status: agents.status })
        .from(agents)
        .where(and(eq(agents.companyId, input.companyId), inArray(agents.id, agentRecipientIds)))
    : [];
  const agentStatusById = new Map(availableAgents.map((agent) => [agent.id, agent.status]));
  const dispatchedRecipients: PersistedCommentRecipient[] = [];
  for (const recipient of input.recipients) {
    if (recipient.deliveryStatus !== "pending") {
      dispatchedRecipients.push(recipient);
      continue;
    }
    if (recipient.recipientType !== "agent" || !recipient.recipientId) {
      dispatchedRecipients.push(recipient);
      continue;
    }
    const status = agentStatusById.get(recipient.recipientId);
    if (!status || status === "paused" || status === "terminated") {
      dispatchedRecipients.push({
        ...recipient,
        deliveryStatus: "failed"
      });
      continue;
    }
    try {
      await enqueueHeartbeatQueueJob(db, {
        companyId: input.companyId,
        agentId: recipient.recipientId,
        jobType: "comment_dispatch",
        priority: 20,
        maxAttempts: 12,
        idempotencyKey: `comment_dispatch:${input.commentId}:${recipient.recipientId}`,
        payload: {
          wakeContext: {
            reason: "issue_comment_recipient",
            commentId: input.commentId,
            issueIds: [input.issueId]
          },
          commentDispatch: {
            commentId: input.commentId,
            issueId: input.issueId,
            recipientId: recipient.recipientId
          }
        }
      });
      triggerHeartbeatQueueWorker(db, input.companyId, {
        requestId: input.requestId,
        realtimeHub: input.realtimeHub
      });
      dispatchedRecipients.push(recipient);
      continue;
    } catch {
      dispatchedRecipients.push({
        ...recipient,
        deliveryStatus: "failed"
      });
      continue;
    }
  }
  return dispatchedRecipients;
}

function parseIssueCommentRecipients(raw: string | null) {
  if (!raw) {
    return [] as PersistedCommentRecipient[];
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [] as PersistedCommentRecipient[];
    }
    return parsed
      .map((entry) => {
        if (!entry || typeof entry !== "object") {
          return null;
        }
        const candidate = entry as Record<string, unknown>;
        const recipientTypeRaw = String(candidate.recipientType ?? "").trim();
        if (recipientTypeRaw !== "agent" && recipientTypeRaw !== "board" && recipientTypeRaw !== "member") {
          return null;
        }
        const recipientType = recipientTypeRaw as "agent" | "board" | "member";
        const deliveryStatusRaw = String(candidate.deliveryStatus ?? "").trim();
        const deliveryStatus =
          deliveryStatusRaw === "pending" ||
          deliveryStatusRaw === "dispatched" ||
          deliveryStatusRaw === "failed" ||
          deliveryStatusRaw === "skipped"
            ? deliveryStatusRaw
            : "pending";
        const recipientId =
          typeof candidate.recipientId === "string" && candidate.recipientId.trim().length > 0
            ? candidate.recipientId.trim()
            : null;
        const dispatchedRunId =
          typeof candidate.dispatchedRunId === "string" && candidate.dispatchedRunId.trim().length > 0
            ? candidate.dispatchedRunId.trim()
            : null;
        const dispatchedAt =
          typeof candidate.dispatchedAt === "string" && candidate.dispatchedAt.trim().length > 0
            ? candidate.dispatchedAt.trim()
            : null;
        const acknowledgedAt =
          typeof candidate.acknowledgedAt === "string" && candidate.acknowledgedAt.trim().length > 0
            ? candidate.acknowledgedAt.trim()
            : null;
        return {
          recipientType,
          recipientId,
          deliveryStatus,
          dispatchedRunId,
          dispatchedAt,
          acknowledgedAt
        } satisfies PersistedCommentRecipient;
      })
      .filter(Boolean) as PersistedCommentRecipient[];
  } catch {
    return [] as PersistedCommentRecipient[];
  }
}
