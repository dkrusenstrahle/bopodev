import { appendAuditEvent } from "bopodev-db";
import { agents, eq, heartbeatRuns, max } from "bopodev-db";
import type { BopoDb } from "bopodev-db";
import type { RealtimeHub } from "../../realtime/hub";
import { findPendingProjectBudgetOverrideBlocksForAgent } from "./budget-override";
import { isHeartbeatDue } from "./cron";

export async function runHeartbeatSweep(
  db: BopoDb,
  companyId: string,
  options?: { requestId?: string; realtimeHub?: RealtimeHub }
) {
  const companyAgents = await db.select().from(agents).where(eq(agents.companyId, companyId));
  const latestRunByAgent = await listLatestRunByAgent(db, companyId);

  const now = new Date();
  const enqueuedJobIds: string[] = [];
  const dueAgents: Array<{ id: string }> = [];
  let skippedNotDue = 0;
  let skippedStatus = 0;
  let skippedBudgetBlocked = 0;
  let failedStarts = 0;
  const sweepStartedAt = Date.now();
  for (const agent of companyAgents) {
    if (agent.status !== "idle" && agent.status !== "running") {
      skippedStatus += 1;
      continue;
    }
    if (!isHeartbeatDue(agent.heartbeatCron, latestRunByAgent.get(agent.id) ?? null, now)) {
      skippedNotDue += 1;
      continue;
    }
    const blockedProjectIds = await findPendingProjectBudgetOverrideBlocksForAgent(db, companyId, agent.id);
    if (blockedProjectIds.length > 0) {
      skippedBudgetBlocked += 1;
      continue;
    }
    dueAgents.push({ id: agent.id });
  }
  const sweepConcurrency = resolveHeartbeatSweepConcurrency(dueAgents.length);
  const queueModule = await import("../heartbeat-queue-service");
  await runWithConcurrency(dueAgents, sweepConcurrency, async (agent) => {
    try {
      const job = await queueModule.enqueueHeartbeatQueueJob(db, {
        companyId,
        agentId: agent.id,
        jobType: "scheduler",
        priority: 80,
        idempotencyKey: options?.requestId ? `scheduler:${agent.id}:${options.requestId}` : null,
        payload: {}
      });
      enqueuedJobIds.push(job.id);
      queueModule.triggerHeartbeatQueueWorker(db, companyId, {
        requestId: options?.requestId,
        realtimeHub: options?.realtimeHub
      });
    } catch {
      failedStarts += 1;
    }
  });
  await appendAuditEvent(db, {
    companyId,
    actorType: "system",
    eventType: "heartbeat.sweep.completed",
    entityType: "company",
    entityId: companyId,
    correlationId: options?.requestId ?? null,
    payload: {
      runIds: enqueuedJobIds,
      startedCount: enqueuedJobIds.length,
      dueCount: dueAgents.length,
      failedStarts,
      skippedStatus,
      skippedNotDue,
      skippedBudgetBlocked,
      concurrency: sweepConcurrency,
      elapsedMs: Date.now() - sweepStartedAt,
      requestId: options?.requestId ?? null
    }
  });
  return enqueuedJobIds;
}

async function listLatestRunByAgent(db: BopoDb, companyId: string) {
  const rows = await db
    .select({
      agentId: heartbeatRuns.agentId,
      latestStartedAt: max(heartbeatRuns.startedAt)
    })
    .from(heartbeatRuns)
    .where(eq(heartbeatRuns.companyId, companyId))
    .groupBy(heartbeatRuns.agentId);
  const latestRunByAgent = new Map<string, Date>();
  for (const row of rows) {
    const startedAt = coerceDate(row.latestStartedAt);
    if (!startedAt) {
      continue;
    }
    latestRunByAgent.set(row.agentId, startedAt);
  }
  return latestRunByAgent;
}

function coerceDate(value: unknown) {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value === "string" || typeof value === "number") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

function resolveHeartbeatSweepConcurrency(dueAgentsCount: number) {
  const configured = Number(process.env.BOPO_HEARTBEAT_SWEEP_CONCURRENCY ?? "4");
  const fallback = 4;
  const normalized = Number.isFinite(configured) ? Math.floor(configured) : fallback;
  if (normalized < 1) {
    return 1;
  }
  const bounded = Math.min(normalized, 16);
  return Math.min(bounded, Math.max(1, dueAgentsCount));
}

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>
) {
  if (items.length === 0) {
    return;
  }
  const workerCount = Math.max(1, Math.min(Math.floor(concurrency), items.length));
  let cursor = 0;
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (cursor < items.length) {
        const index = cursor;
        cursor += 1;
        await worker(items[index] as T, index);
      }
    })
  );
}
