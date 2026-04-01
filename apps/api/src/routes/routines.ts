import { Router } from "express";
import { appendAuditEvent, listAuditEvents } from "bopodev-db";
import {
  WorkRoutineCreateRequestSchema,
  WorkRoutineTriggerCreateRequestSchema,
  WorkRoutineUpdateRequestSchema,
  WorkRoutineTriggerUpdateRequestSchema
} from "bopodev-contracts";
import type { AppContext } from "../context";
import { sendError, sendOk } from "../http";
import { requireCompanyScope } from "../middleware/company-scope";
import { enforcePermission } from "../middleware/request-actor";
import { workLoopRuns, workLoops, workLoopTriggers } from "bopodev-db";
import {
  addWorkLoopTrigger,
  addWorkLoopTriggerFromPreset,
  dispatchLoopRun,
  getWorkLoop,
  listWorkLoopRuns,
  listWorkLoops,
  listWorkLoopTriggers,
  createWorkLoop,
  updateWorkLoop,
  updateWorkLoopTrigger,
  deleteWorkLoopTrigger
} from "../services/work-loop-service";

function serializeRoutine(row: typeof workLoops.$inferSelect) {
  let goalIds: string[] = [];
  try {
    goalIds = JSON.parse(row.goalIdsJson || "[]") as string[];
  } catch {
    goalIds = [];
  }
  return {
    id: row.id,
    companyId: row.companyId,
    projectId: row.projectId,
    parentIssueId: row.parentIssueId,
    goalIds,
    title: row.title,
    description: row.description,
    assigneeAgentId: row.assigneeAgentId,
    priority: row.priority,
    status: row.status,
    concurrencyPolicy: row.concurrencyPolicy,
    catchUpPolicy: row.catchUpPolicy,
    lastTriggeredAt: row.lastTriggeredAt ? row.lastTriggeredAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  };
}

function serializeTrigger(row: typeof workLoopTriggers.$inferSelect) {
  return {
    id: row.id,
    companyId: row.companyId,
    routineId: row.routineId,
    kind: row.kind,
    label: row.label,
    enabled: row.enabled,
    cronExpression: row.cronExpression,
    timezone: row.timezone,
    nextRunAt: row.nextRunAt ? row.nextRunAt.toISOString() : null,
    lastFiredAt: row.lastFiredAt ? row.lastFiredAt.toISOString() : null,
    lastResult: row.lastResult,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  };
}

function serializeRun(row: typeof workLoopRuns.$inferSelect) {
  return {
    id: row.id,
    companyId: row.companyId,
    routineId: row.routineId,
    triggerId: row.triggerId,
    source: row.source,
    status: row.status,
    triggeredAt: row.triggeredAt.toISOString(),
    idempotencyKey: row.idempotencyKey,
    linkedIssueId: row.linkedIssueId,
    coalescedIntoRunId: row.coalescedIntoRunId,
    failureReason: row.failureReason,
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  };
}

export function createRoutinesRouter(ctx: AppContext) {
  const router = Router();
  router.use(requireCompanyScope);

  router.get("/", async (req, res) => {
    if (!enforcePermission(req, res, "routines:read")) {
      return;
    }
    const rows = await listWorkLoops(ctx.db, req.companyId!);
    return sendOk(res, { data: rows.map(serializeRoutine) });
  });

  router.post("/", async (req, res) => {
    if (!enforcePermission(req, res, "routines:write")) {
      return;
    }
    const parsed = WorkRoutineCreateRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(res, parsed.error.message, 422);
    }
    try {
      const row = await createWorkLoop(ctx.db, {
        companyId: req.companyId!,
        projectId: parsed.data.projectId,
        parentIssueId: parsed.data.parentIssueId,
        goalIds: parsed.data.goalIds,
        title: parsed.data.title,
        description: parsed.data.description,
        assigneeAgentId: parsed.data.assigneeAgentId,
        priority: parsed.data.priority,
        status: parsed.data.status,
        concurrencyPolicy: parsed.data.concurrencyPolicy,
        catchUpPolicy: parsed.data.catchUpPolicy
      });
      if (!row) {
        return sendError(res, "Failed to create routine.", 500);
      }
      await appendAuditEvent(ctx.db, {
        companyId: req.companyId!,
        actorType: "human",
        actorId: req.actor?.id ?? null,
        eventType: "work_loop.created",
        entityType: "work_loop",
        entityId: row.id,
        correlationId: req.requestId ?? null,
        payload: { routineId: row.id, title: row.title }
      });
      return sendOk(res, { data: serializeRoutine(row) });
    } catch (e) {
      return sendError(res, e instanceof Error ? e.message : "Failed to create routine.", 422);
    }
  });

  router.get("/:routineId", async (req, res) => {
    if (!enforcePermission(req, res, "routines:read")) {
      return;
    }
    const routineId = req.params.routineId;
    const row = await getWorkLoop(ctx.db, req.companyId!, routineId);
    if (!row) {
      return sendError(res, "Routine not found.", 404);
    }
    const [triggers, recentRuns] = await Promise.all([
      listWorkLoopTriggers(ctx.db, req.companyId!, routineId),
      listWorkLoopRuns(ctx.db, req.companyId!, routineId, 30)
    ]);
    return sendOk(res, {
      data: {
        ...serializeRoutine(row),
        triggers: triggers.map(serializeTrigger),
        recentRuns: recentRuns.map(serializeRun)
      }
    });
  });

  router.patch("/:routineId", async (req, res) => {
    if (!enforcePermission(req, res, "routines:write")) {
      return;
    }
    const parsed = WorkRoutineUpdateRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(res, parsed.error.message, 422);
    }
    const row = await updateWorkLoop(ctx.db, req.companyId!, req.params.routineId, parsed.data);
    if (!row) {
      return sendError(res, "Routine not found.", 404);
    }
    await appendAuditEvent(ctx.db, {
      companyId: req.companyId!,
      actorType: "human",
      actorId: req.actor?.id ?? null,
      eventType: "work_loop.updated",
      entityType: "work_loop",
      entityId: row.id,
      correlationId: req.requestId ?? null,
      payload: { patch: parsed.data }
    });
    return sendOk(res, { data: serializeRoutine(row) });
  });

  router.post("/:routineId/run", async (req, res) => {
    if (!enforcePermission(req, res, "routines:run")) {
      return;
    }
    const routineId = req.params.routineId;
    const loop = await getWorkLoop(ctx.db, req.companyId!, routineId);
    if (!loop) {
      return sendError(res, "Routine not found.", 404);
    }
    const run = await dispatchLoopRun(ctx.db, {
      companyId: req.companyId!,
      loopId: routineId,
      triggerId: null,
      source: "manual",
      idempotencyKey: req.requestId ? `manual:${routineId}:${req.requestId}` : `manual:${routineId}:${Date.now()}`,
      realtimeHub: ctx.realtimeHub,
      requestId: req.requestId
    });
    if (!run) {
      return sendError(res, "Routine is not active or could not be dispatched.", 409);
    }
    await appendAuditEvent(ctx.db, {
      companyId: req.companyId!,
      actorType: "human",
      actorId: req.actor?.id ?? null,
      eventType: "work_loop.manual_run",
      entityType: "work_loop",
      entityId: routineId,
      correlationId: req.requestId ?? null,
      payload: { runId: run.id, status: run.status }
    });
    return sendOk(res, { data: serializeRun(run) });
  });

  router.get("/:routineId/runs", async (req, res) => {
    if (!enforcePermission(req, res, "routines:read")) {
      return;
    }
    const loop = await getWorkLoop(ctx.db, req.companyId!, req.params.routineId);
    if (!loop) {
      return sendError(res, "Routine not found.", 404);
    }
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
    const runs = await listWorkLoopRuns(ctx.db, req.companyId!, req.params.routineId, limit);
    return sendOk(res, { data: runs.map(serializeRun) });
  });

  router.get("/:routineId/activity", async (req, res) => {
    if (!enforcePermission(req, res, "routines:read")) {
      return;
    }
    const routineId = req.params.routineId;
    const loop = await getWorkLoop(ctx.db, req.companyId!, routineId);
    if (!loop) {
      return sendError(res, "Routine not found.", 404);
    }
    const events = await listAuditEvents(ctx.db, req.companyId!, 200);
    const filtered = events.filter((e) => e.entityType === "work_loop" && e.entityId === routineId);
    return sendOk(res, {
      data: filtered.map((e) => ({
        id: e.id,
        eventType: e.eventType,
        actorType: e.actorType,
        actorId: e.actorId,
        payload: JSON.parse(e.payloadJson || "{}") as Record<string, unknown>,
        createdAt: e.createdAt.toISOString()
      }))
    });
  });

  router.post("/:routineId/triggers", async (req, res) => {
    if (!enforcePermission(req, res, "routines:write")) {
      return;
    }
    const routineId = req.params.routineId;
    const loop = await getWorkLoop(ctx.db, req.companyId!, routineId);
    if (!loop) {
      return sendError(res, "Routine not found.", 404);
    }
    const parsed = WorkRoutineTriggerCreateRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(res, parsed.error.message, 422);
    }
    try {
      const body = parsed.data;
      const trigger =
        body.mode === "cron"
          ? await addWorkLoopTrigger(ctx.db, {
              companyId: req.companyId!,
              routineId,
              cronExpression: body.cronExpression,
              timezone: body.timezone,
              label: body.label ?? null,
              enabled: body.enabled
            })
          : await addWorkLoopTriggerFromPreset(ctx.db, {
              companyId: req.companyId!,
              routineId,
              preset: body.preset,
              hour24: body.hour24,
              minute: body.minute,
              dayOfWeek: body.preset === "weekly" ? (body.dayOfWeek ?? 1) : undefined,
              timezone: body.timezone,
              label: body.label ?? null,
              enabled: body.enabled
            });
      if (!trigger) {
        return sendError(res, "Failed to create trigger.", 500);
      }
      return sendOk(res, { data: serializeTrigger(trigger) });
    } catch (e) {
      return sendError(res, e instanceof Error ? e.message : "Failed to create trigger.", 422);
    }
  });

  router.patch("/:routineId/triggers/:triggerId", async (req, res) => {
    if (!enforcePermission(req, res, "routines:write")) {
      return;
    }
    const parsed = WorkRoutineTriggerUpdateRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(res, parsed.error.message, 422);
    }
    const loop = await getWorkLoop(ctx.db, req.companyId!, req.params.routineId);
    if (!loop) {
      return sendError(res, "Routine not found.", 404);
    }
    try {
      const row = await updateWorkLoopTrigger(ctx.db, req.companyId!, req.params.triggerId, parsed.data);
      if (!row || row.routineId !== req.params.routineId) {
        return sendError(res, "Trigger not found.", 404);
      }
      return sendOk(res, { data: serializeTrigger(row) });
    } catch (e) {
      return sendError(res, e instanceof Error ? e.message : "Failed to update trigger.", 422);
    }
  });

  router.delete("/:routineId/triggers/:triggerId", async (req, res) => {
    if (!enforcePermission(req, res, "routines:write")) {
      return;
    }
    const { routineId, triggerId } = req.params;
    const loop = await getWorkLoop(ctx.db, req.companyId!, routineId);
    if (!loop) {
      return sendError(res, "Routine not found.", 404);
    }
    const deleted = await deleteWorkLoopTrigger(ctx.db, req.companyId!, routineId, triggerId);
    if (!deleted) {
      return sendError(res, "Trigger not found.", 404);
    }
    await appendAuditEvent(ctx.db, {
      companyId: req.companyId!,
      actorType: "human",
      actorId: req.actor?.id ?? null,
      eventType: "work_loop.trigger_deleted",
      entityType: "work_loop",
      entityId: routineId,
      correlationId: req.requestId ?? null,
      payload: { triggerId }
    });
    return sendOk(res, { deleted: true });
  });

  return router;
}
