import { nanoid } from "nanoid";
import { and, asc, desc, eq, inArray, isNotNull, isNull, lte, sql } from "drizzle-orm";
import {
  agents,
  appendAuditEvent,
  assertProjectBelongsToCompany,
  issues,
  type BopoDb,
  syncIssueGoals,
  workLoopRuns,
  workLoops,
  workLoopTriggers
} from "bopodev-db";
import type { RealtimeHub } from "../../realtime/hub";
import { enqueueHeartbeatQueueJob, triggerHeartbeatQueueWorker } from "../heartbeat-queue-service";
import {
  assertValidTimeZone,
  dailyCronAtLocalTime,
  floorToUtcMinute,
  nextCronFireAfter,
  validateCronExpression,
  weeklyCronAtLocalTime
} from "./loop-cron";

export const MAX_LOOP_CATCH_UP_RUNS = 25;

const OPEN_ISSUE_STATUSES = ["todo", "in_progress", "blocked", "in_review"] as const;

export type WorkLoopConcurrencyPolicy = "coalesce_if_active" | "skip_if_active" | "always_enqueue";
export type WorkLoopCatchUpPolicy = "skip_missed" | "enqueue_missed_with_cap";

export async function createWorkLoop(
  db: BopoDb,
  input: {
    companyId: string;
    projectId: string;
    parentIssueId?: string | null;
    goalIds?: string[];
    title: string;
    description?: string | null;
    assigneeAgentId: string;
    priority?: string;
    status?: string;
    concurrencyPolicy?: WorkLoopConcurrencyPolicy;
    catchUpPolicy?: WorkLoopCatchUpPolicy;
  }
) {
  const id = nanoid(14);
  await db.insert(workLoops).values({
    id,
    companyId: input.companyId,
    projectId: input.projectId,
    parentIssueId: input.parentIssueId ?? null,
    goalIdsJson: JSON.stringify(input.goalIds ?? []),
    title: input.title,
    description: input.description ?? null,
    assigneeAgentId: input.assigneeAgentId,
    priority: input.priority ?? "medium",
    status: input.status ?? "active",
    concurrencyPolicy: input.concurrencyPolicy ?? "coalesce_if_active",
    catchUpPolicy: input.catchUpPolicy ?? "skip_missed"
  });
  const [row] = await db.select().from(workLoops).where(eq(workLoops.id, id)).limit(1);
  return row ?? null;
}

export async function updateWorkLoop(
  db: BopoDb,
  companyId: string,
  loopId: string,
  patch: Partial<{
    title: string;
    description: string | null;
    assigneeAgentId: string;
    priority: string;
    status: string;
    concurrencyPolicy: WorkLoopConcurrencyPolicy;
    catchUpPolicy: WorkLoopCatchUpPolicy;
    parentIssueId: string | null;
    goalIds: string[];
    projectId: string;
  }>
) {
  const [existing] = await db
    .select()
    .from(workLoops)
    .where(and(eq(workLoops.id, loopId), eq(workLoops.companyId, companyId)))
    .limit(1);
  if (!existing) {
    return null;
  }
  await db
    .update(workLoops)
    .set({
      ...("title" in patch ? { title: patch.title } : {}),
      ...("description" in patch ? { description: patch.description } : {}),
      ...("assigneeAgentId" in patch ? { assigneeAgentId: patch.assigneeAgentId } : {}),
      ...("priority" in patch ? { priority: patch.priority } : {}),
      ...("status" in patch ? { status: patch.status } : {}),
      ...("concurrencyPolicy" in patch ? { concurrencyPolicy: patch.concurrencyPolicy } : {}),
      ...("catchUpPolicy" in patch ? { catchUpPolicy: patch.catchUpPolicy } : {}),
      ...("parentIssueId" in patch ? { parentIssueId: patch.parentIssueId } : {}),
      ...("goalIds" in patch ? { goalIdsJson: JSON.stringify(patch.goalIds ?? []) } : {}),
      ...("projectId" in patch ? { projectId: patch.projectId } : {}),
      updatedAt: new Date()
    })
    .where(eq(workLoops.id, loopId));
  const [row] = await db.select().from(workLoops).where(eq(workLoops.id, loopId)).limit(1);
  return row ?? null;
}

export async function getWorkLoop(db: BopoDb, companyId: string, loopId: string) {
  const [row] = await db
    .select()
    .from(workLoops)
    .where(and(eq(workLoops.id, loopId), eq(workLoops.companyId, companyId)))
    .limit(1);
  return row ?? null;
}

export async function listWorkLoops(db: BopoDb, companyId: string) {
  return db
    .select()
    .from(workLoops)
    .where(eq(workLoops.companyId, companyId))
    .orderBy(desc(workLoops.updatedAt), asc(workLoops.title));
}

export async function addWorkLoopTrigger(
  db: BopoDb,
  input: {
    companyId: string;
    workLoopId: string;
    cronExpression: string;
    timezone?: string;
    label?: string | null;
    enabled?: boolean;
  }
) {
  const err = validateCronExpression(input.cronExpression);
  if (err) {
    throw new Error(err);
  }
  const tz = input.timezone?.trim() || "UTC";
  assertValidTimeZone(tz);
  const id = nanoid(14);
  const start = nextCronFireAfter(input.cronExpression, tz, new Date(Date.now() - 60_000));
  await db.insert(workLoopTriggers).values({
    id,
    companyId: input.companyId,
    workLoopId: input.workLoopId,
    kind: "schedule",
    label: input.label ?? null,
    enabled: input.enabled ?? true,
    cronExpression: input.cronExpression.trim(),
    timezone: tz,
    nextRunAt: start ?? new Date()
  });
  const [row] = await db.select().from(workLoopTriggers).where(eq(workLoopTriggers.id, id)).limit(1);
  return row ?? null;
}

export async function addWorkLoopTriggerFromPreset(
  db: BopoDb,
  input: {
    companyId: string;
    workLoopId: string;
    preset: "daily" | "weekly";
    hour24: number;
    minute: number;
    timezone?: string;
    dayOfWeek?: number;
    label?: string | null;
    enabled?: boolean;
  }
) {
  const tz = input.timezone?.trim() || "UTC";
  assertValidTimeZone(tz);
  const cron =
    input.preset === "daily"
      ? dailyCronAtLocalTime(input.hour24, input.minute)
      : weeklyCronAtLocalTime(input.dayOfWeek ?? 1, input.hour24, input.minute);
  return addWorkLoopTrigger(db, {
    companyId: input.companyId,
    workLoopId: input.workLoopId,
    cronExpression: cron,
    timezone: tz,
    label: input.label,
    enabled: input.enabled
  });
}

export async function updateWorkLoopTrigger(
  db: BopoDb,
  companyId: string,
  triggerId: string,
  patch: Partial<{
    cronExpression: string;
    timezone: string;
    label: string | null;
    enabled: boolean;
  }>
) {
  const [existing] = await db
    .select()
    .from(workLoopTriggers)
    .where(and(eq(workLoopTriggers.id, triggerId), eq(workLoopTriggers.companyId, companyId)))
    .limit(1);
  if (!existing) {
    return null;
  }
  if (patch.cronExpression) {
    const verr = validateCronExpression(patch.cronExpression);
    if (verr) {
      throw new Error(verr);
    }
  }
  if (patch.timezone) {
    assertValidTimeZone(patch.timezone);
  }
  const cronExpr = patch.cronExpression?.trim() ?? existing.cronExpression;
  const tz = patch.timezone?.trim() ?? existing.timezone;
  let nextRunAt: Date | undefined;
  if (patch.cronExpression || patch.timezone) {
    nextRunAt = nextCronFireAfter(cronExpr, tz, new Date(Date.now() - 60_000)) ?? undefined;
  }
  await db
    .update(workLoopTriggers)
    .set({
      ...("cronExpression" in patch && patch.cronExpression ? { cronExpression: cronExpr } : {}),
      ...("timezone" in patch && patch.timezone ? { timezone: tz } : {}),
      ...("label" in patch ? { label: patch.label } : {}),
      ...("enabled" in patch ? { enabled: patch.enabled } : {}),
      ...(nextRunAt ? { nextRunAt } : {}),
      updatedAt: new Date()
    })
    .where(eq(workLoopTriggers.id, triggerId));
  const [row] = await db.select().from(workLoopTriggers).where(eq(workLoopTriggers.id, triggerId)).limit(1);
  return row ?? null;
}

export async function deleteWorkLoopTrigger(
  db: BopoDb,
  companyId: string,
  workLoopId: string,
  triggerId: string
): Promise<boolean> {
  const [existing] = await db
    .select()
    .from(workLoopTriggers)
    .where(
      and(
        eq(workLoopTriggers.id, triggerId),
        eq(workLoopTriggers.companyId, companyId),
        eq(workLoopTriggers.workLoopId, workLoopId)
      )
    )
    .limit(1);
  if (!existing) {
    return false;
  }
  await db.delete(workLoopTriggers).where(eq(workLoopTriggers.id, triggerId));
  return true;
}

export async function listWorkLoopTriggers(db: BopoDb, companyId: string, workLoopId: string) {
  return db
    .select()
    .from(workLoopTriggers)
    .where(and(eq(workLoopTriggers.companyId, companyId), eq(workLoopTriggers.workLoopId, workLoopId)))
    .orderBy(asc(workLoopTriggers.createdAt));
}

export async function listWorkLoopRuns(db: BopoDb, companyId: string, workLoopId: string, limit = 100) {
  return db
    .select()
    .from(workLoopRuns)
    .where(and(eq(workLoopRuns.companyId, companyId), eq(workLoopRuns.workLoopId, workLoopId)))
    .orderBy(desc(workLoopRuns.triggeredAt), desc(workLoopRuns.id))
    .limit(Math.min(500, Math.max(1, limit)));
}

async function findOpenIssueForLoop(db: BopoDb, companyId: string, loopId: string) {
  const rows = await db
    .select()
    .from(issues)
    .where(
      and(
        eq(issues.companyId, companyId),
        eq(issues.loopId, loopId),
        inArray(issues.status, [...OPEN_ISSUE_STATUSES])
      )
    )
    .orderBy(desc(issues.updatedAt), desc(issues.createdAt))
    .limit(5);
  return rows[0] ?? null;
}

function nextResultText(status: string, issueId?: string | null) {
  if (status === "issue_created" && issueId) {
    return `Created execution issue ${issueId}`;
  }
  if (status === "coalesced") {
    return "Coalesced into an existing open issue";
  }
  if (status === "skipped") {
    return "Skipped while an open issue exists";
  }
  if (status === "failed") {
    return "Execution failed";
  }
  return status;
}

export async function dispatchLoopRun(
  db: BopoDb,
  input: {
    companyId: string;
    loopId: string;
    triggerId: string | null;
    source: "schedule" | "manual";
    idempotencyKey?: string | null;
    realtimeHub?: RealtimeHub;
    requestId?: string | null;
    /** Advance schedule from this instant (missed-tick catch-up). Defaults to actual fire time. */
    anchorForScheduleAdvance?: Date;
  }
): Promise<(typeof workLoopRuns.$inferSelect) | null> {
  const run = await db.transaction(async (tx) => {
    const txDb = tx as unknown as BopoDb;
    await tx.execute(sql`select id from ${workLoops} where ${workLoops.id} = ${input.loopId} for update`);

    const [loop] = await txDb
      .select()
      .from(workLoops)
      .where(and(eq(workLoops.id, input.loopId), eq(workLoops.companyId, input.companyId)))
      .limit(1);
    if (!loop || loop.status !== "active") {
      return null;
    }

    await assertProjectBelongsToCompany(txDb, input.companyId, loop.projectId);

    if (input.idempotencyKey) {
      const [existing] = await txDb
        .select()
        .from(workLoopRuns)
        .where(
          and(
            eq(workLoopRuns.companyId, input.companyId),
            eq(workLoopRuns.workLoopId, input.loopId),
            eq(workLoopRuns.source, input.source),
            eq(workLoopRuns.idempotencyKey, input.idempotencyKey),
            input.triggerId ? eq(workLoopRuns.triggerId, input.triggerId) : isNull(workLoopRuns.triggerId)
          )
        )
        .orderBy(desc(workLoopRuns.createdAt))
        .limit(1);
      if (existing) {
        return existing;
      }
    }

    const [agent] = await txDb
      .select({ id: agents.id, status: agents.status })
      .from(agents)
      .where(and(eq(agents.companyId, input.companyId), eq(agents.id, loop.assigneeAgentId)))
      .limit(1);
    if (!agent || agent.status === "terminated" || agent.status === "paused") {
      const runId = nanoid(14);
      await txDb.insert(workLoopRuns).values({
        id: runId,
        companyId: input.companyId,
        workLoopId: loop.id,
        triggerId: input.triggerId,
        source: input.source,
        status: "failed",
        triggeredAt: new Date(),
        idempotencyKey: input.idempotencyKey ?? null,
        failureReason: "Assignee agent is not runnable",
        completedAt: new Date()
      });
      const [failedRow] = await txDb.select().from(workLoopRuns).where(eq(workLoopRuns.id, runId)).limit(1);
      return failedRow ?? null;
    }

    const triggeredAt = new Date();
    const scheduleAnchor = input.anchorForScheduleAdvance ?? triggeredAt;
    const runId = nanoid(14);
    await txDb.insert(workLoopRuns).values({
      id: runId,
      companyId: input.companyId,
      workLoopId: loop.id,
      triggerId: input.triggerId,
      source: input.source,
      status: "received",
      triggeredAt,
      idempotencyKey: input.idempotencyKey ?? null,
      payloadJson: "{}"
    });

    const policy = loop.concurrencyPolicy as WorkLoopConcurrencyPolicy;
    const activeIssue =
      policy === "always_enqueue" ? null : await findOpenIssueForLoop(txDb, input.companyId, loop.id);

    if (activeIssue && policy !== "always_enqueue") {
      const status = policy === "skip_if_active" ? "skipped" : "coalesced";
      await txDb
        .update(workLoopRuns)
        .set({
          status,
          linkedIssueId: activeIssue.id,
          coalescedIntoRunId: activeIssue.loopRunId,
          completedAt: triggeredAt,
          updatedAt: new Date()
        })
        .where(eq(workLoopRuns.id, runId));
      await txDb
        .update(workLoops)
        .set({
          lastTriggeredAt: triggeredAt,
          updatedAt: new Date()
        })
        .where(eq(workLoops.id, loop.id));
      if (input.triggerId) {
        const [tr] = await txDb
          .select()
          .from(workLoopTriggers)
          .where(eq(workLoopTriggers.id, input.triggerId))
          .limit(1);
        if (tr) {
          const nextAt = nextCronFireAfter(tr.cronExpression, tr.timezone, scheduleAnchor);
          await txDb
            .update(workLoopTriggers)
            .set({
              lastFiredAt: triggeredAt,
              lastResult: nextResultText(status, activeIssue.id),
              nextRunAt: nextAt ?? null,
              updatedAt: new Date()
            })
            .where(eq(workLoopTriggers.id, input.triggerId));
        }
      }
      const [updated] = await txDb.select().from(workLoopRuns).where(eq(workLoopRuns.id, runId)).limit(1);
      return updated ?? null;
    }

    let goalIds: string[] = [];
    try {
      goalIds = JSON.parse(loop.goalIdsJson || "[]") as string[];
    } catch {
      goalIds = [];
    }

    const issueId = nanoid(12);
    await txDb.insert(issues).values({
      id: issueId,
      companyId: input.companyId,
      projectId: loop.projectId,
      parentIssueId: loop.parentIssueId,
      title: loop.title,
      body: loop.description,
      status: "todo",
      priority: loop.priority,
      assigneeAgentId: loop.assigneeAgentId,
      labelsJson: JSON.stringify(["work-loop"]),
      tagsJson: "[]",
      loopId: loop.id,
      loopRunId: runId
    });
    if (goalIds.length > 0) {
      await syncIssueGoals(txDb, {
        companyId: input.companyId,
        issueId,
        projectId: loop.projectId,
        goalIds
      });
    }

    await txDb
      .update(workLoopRuns)
      .set({
        status: "issue_created",
        linkedIssueId: issueId,
        updatedAt: new Date()
      })
      .where(eq(workLoopRuns.id, runId));

    await txDb
      .update(workLoops)
      .set({
        lastTriggeredAt: triggeredAt,
        updatedAt: new Date()
      })
      .where(eq(workLoops.id, loop.id));

    if (input.triggerId) {
      const [tr] = await txDb
        .select()
        .from(workLoopTriggers)
        .where(eq(workLoopTriggers.id, input.triggerId))
        .limit(1);
      if (tr) {
        const nextAt = nextCronFireAfter(tr.cronExpression, tr.timezone, scheduleAnchor);
        await txDb
          .update(workLoopTriggers)
          .set({
            lastFiredAt: triggeredAt,
            lastResult: nextResultText("issue_created", issueId),
            nextRunAt: nextAt ?? null,
            updatedAt: new Date()
          })
          .where(eq(workLoopTriggers.id, input.triggerId));
      }
    }

    const [finalRun] = await txDb.select().from(workLoopRuns).where(eq(workLoopRuns.id, runId)).limit(1);
    return finalRun ?? null;
  });

  if (!run || run.status !== "issue_created" || !run.linkedIssueId) {
    return run;
  }

  try {
    const [loopRow] = await db
      .select({ assigneeAgentId: workLoops.assigneeAgentId })
      .from(workLoops)
      .where(eq(workLoops.id, input.loopId))
      .limit(1);
    if (!loopRow) {
      return run;
    }
    await enqueueHeartbeatQueueJob(db, {
      companyId: input.companyId,
      agentId: loopRow.assigneeAgentId,
      jobType: "manual",
      priority: 35,
      idempotencyKey: `loop_wake:${run.linkedIssueId}:${run.id}`,
      payload: {
        wakeContext: {
          reason: "loop_execution",
          issueIds: [run.linkedIssueId]
        }
      }
    });
    triggerHeartbeatQueueWorker(db, input.companyId, {
      requestId: input.requestId ?? undefined,
      realtimeHub: input.realtimeHub
    });
  } catch {
    // leave issue created; queue failure is observable via missing run
  }

  return run;
}

export async function runLoopSweep(
  db: BopoDb,
  companyId: string,
  options?: { requestId?: string | null; realtimeHub?: RealtimeHub }
) {
  const now = new Date();
  const due = await db
    .select({
      trigger: workLoopTriggers,
      loop: workLoops
    })
    .from(workLoopTriggers)
    .innerJoin(workLoops, eq(workLoopTriggers.workLoopId, workLoops.id))
    .where(
      and(
        eq(workLoopTriggers.companyId, companyId),
        eq(workLoops.companyId, companyId),
        eq(workLoopTriggers.enabled, true),
        eq(workLoopTriggers.kind, "schedule"),
        isNotNull(workLoopTriggers.nextRunAt),
        lte(workLoopTriggers.nextRunAt, now),
        eq(workLoops.status, "active")
      )
    )
    .orderBy(asc(workLoopTriggers.nextRunAt));

  let processed = 0;
  for (const row of due) {
    const trigger = row.trigger;
    const loop = row.loop;
    const catchUp = loop.catchUpPolicy as WorkLoopCatchUpPolicy;
    const nextRunAt = trigger.nextRunAt;
    if (!nextRunAt) {
      continue;
    }

    if (catchUp === "skip_missed") {
      const lateMs = now.getTime() - nextRunAt.getTime();
      if (lateMs > 90_000) {
        const bumped =
          nextCronFireAfter(trigger.cronExpression, trigger.timezone, new Date(now.getTime() - 60_000)) ??
          nextCronFireAfter(trigger.cronExpression, trigger.timezone, now);
        await db
          .update(workLoopTriggers)
          .set({
            nextRunAt: bumped,
            lastResult: "Skipped missed window (catch-up: skip missed)",
            updatedAt: new Date()
          })
          .where(eq(workLoopTriggers.id, trigger.id));
        continue;
      }
    }

    if (catchUp === "enqueue_missed_with_cap") {
      let cursor = new Date(nextRunAt.getTime());
      let n = 0;
      while (cursor <= now && n < MAX_LOOP_CATCH_UP_RUNS) {
        const tickKey = floorToUtcMinute(cursor).toISOString();
        await dispatchLoopRun(db, {
          companyId,
          loopId: loop.id,
          triggerId: trigger.id,
          source: "schedule",
          idempotencyKey: `schedule:${trigger.id}:${tickKey}`,
          anchorForScheduleAdvance: cursor,
          realtimeHub: options?.realtimeHub,
          requestId: options?.requestId
        });
        processed += 1;
        n += 1;
        const next = nextCronFireAfter(trigger.cronExpression, trigger.timezone, cursor);
        if (!next || next.getTime() <= cursor.getTime()) {
          break;
        }
        cursor = next;
      }
      continue;
    }

    const minuteKey = floorToUtcMinute(now).toISOString();
    await dispatchLoopRun(db, {
      companyId,
      loopId: loop.id,
      triggerId: trigger.id,
      source: "schedule",
      idempotencyKey: `schedule:${trigger.id}:${minuteKey}`,
      realtimeHub: options?.realtimeHub,
      requestId: options?.requestId
    });
    processed += 1;
  }

  await appendAuditEvent(db, {
    companyId,
    actorType: "system",
    eventType: "work_loop.sweep.completed",
    entityType: "company",
    entityId: companyId,
    correlationId: options?.requestId ?? null,
    payload: {
      processed,
      requestId: options?.requestId ?? null
    }
  });

  return { processed };
}
