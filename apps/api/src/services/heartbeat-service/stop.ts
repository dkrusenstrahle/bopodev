import { appendAuditEvent } from "bopodev-db";
import { and, eq, heartbeatRuns } from "bopodev-db";
import type { BopoDb } from "bopodev-db";
import type { RealtimeHub } from "../../realtime/hub";
import { getActiveHeartbeatRun } from "./active-runs";
import { publishHeartbeatRunStatus } from "./heartbeat-realtime";
import type { HeartbeatRunTrigger } from "./types";

export async function stopHeartbeatRun(
  db: BopoDb,
  companyId: string,
  runId: string,
  options?: { requestId?: string; actorId?: string; trigger?: HeartbeatRunTrigger; realtimeHub?: RealtimeHub }
) {
  const runTrigger = options?.trigger ?? "manual";
  const [run] = await db
    .select({
      id: heartbeatRuns.id,
      status: heartbeatRuns.status,
      agentId: heartbeatRuns.agentId
    })
    .from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.id, runId)))
    .limit(1);
  if (!run) {
    return { ok: false as const, reason: "not_found" as const };
  }
  if (run.status !== "started") {
    return { ok: false as const, reason: "invalid_status" as const, status: run.status };
  }
  const active = getActiveHeartbeatRun(runId);
  const cancelReason = "cancelled by stop request";
  const cancelRequestedAt = new Date().toISOString();
  if (active) {
    active.cancelReason = cancelReason;
    active.cancelRequestedAt = cancelRequestedAt;
    active.cancelRequestedBy = options?.actorId ?? null;
    active.abortController.abort(cancelReason);
  } else {
    const finishedAt = new Date();
    await db
      .update(heartbeatRuns)
      .set({
        status: "failed",
        finishedAt,
        message: "Heartbeat cancelled by stop request."
      })
      .where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.id, runId)));
    publishHeartbeatRunStatus(options?.realtimeHub, {
      companyId,
      runId,
      status: "failed",
      message: "Heartbeat cancelled by stop request.",
      finishedAt
    });
  }
  await appendAuditEvent(db, {
    companyId,
    actorType: "system",
    eventType: "heartbeat.cancel_requested",
    entityType: "heartbeat_run",
    entityId: runId,
    correlationId: options?.requestId ?? runId,
    payload: {
      agentId: run.agentId,
      trigger: runTrigger,
      requestId: options?.requestId ?? null,
      actorId: options?.actorId ?? null,
      inMemoryAbortRegistered: Boolean(active)
    }
  });
  if (!active) {
    await appendAuditEvent(db, {
      companyId,
      actorType: "system",
      eventType: "heartbeat.cancelled",
      entityType: "heartbeat_run",
      entityId: runId,
      correlationId: options?.requestId ?? runId,
      payload: {
        agentId: run.agentId,
        reason: cancelReason,
        trigger: runTrigger,
        requestId: options?.requestId ?? null,
        actorId: options?.actorId ?? null
      }
    });
  }
  return { ok: true as const, runId, agentId: run.agentId, status: run.status };
}
