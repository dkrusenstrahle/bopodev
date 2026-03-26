import { Router } from "express";
import { appendAuditEvent, listAuditEvents } from "bopodev-db";
import {
  WorkLoopCreateRequestSchema,
  WorkLoopTriggerCreateRequestSchema,
  WorkLoopUpdateRequestSchema,
  WorkLoopTriggerUpdateRequestSchema
} from "bopodev-contracts";
import type { AppContext } from "../context";
import { sendError, sendOk } from "../http";
import { requireCompanyScope } from "../middleware/company-scope";
import { enforcePermission } from "../middleware/request-actor";
import {
  workLoopRuns,
  workLoops,
  workLoopTriggers
} from "bopodev-db";
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

function serializeLoop(row: typeof workLoops.$inferSelect) {
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
    workLoopId: row.workLoopId,
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
    workLoopId: row.workLoopId,
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

export function createLoopsRouter(ctx: AppContext) {
  const router = Router();
  router.use(requireCompanyScope);

  router.get("/", async (req, res) => {
    if (!enforcePermission(req, res, "loops:read")) {
      return;
    }
    const rows = await listWorkLoops(ctx.db, req.companyId!);
    return sendOk(res, { data: rows.map(serializeLoop) });
  });

  router.post("/", async (req, res) => {
    if (!enforcePermission(req, res, "loops:write")) {
      return;
    }
    const parsed = WorkLoopCreateRequestSchema.safeParse(req.body);
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
        return sendError(res, "Failed to create work loop.", 500);
      }
      await appendAuditEvent(ctx.db, {
        companyId: req.companyId!,
        actorType: "human",
        actorId: req.actor?.id ?? null,
        eventType: "work_loop.created",
        entityType: "work_loop",
        entityId: row.id,
        correlationId: req.requestId ?? null,
        payload: { loopId: row.id, title: row.title }
      });
      return sendOk(res, { data: serializeLoop(row) });
    } catch (e) {
      return sendError(res, e instanceof Error ? e.message : "Failed to create work loop.", 422);
    }
  });

  router.get("/:loopId", async (req, res) => {
    if (!enforcePermission(req, res, "loops:read")) {
      return;
    }
    const loopId = req.params.loopId;
    const row = await getWorkLoop(ctx.db, req.companyId!, loopId);
    if (!row) {
      return sendError(res, "Work loop not found.", 404);
    }
    const [triggers, recentRuns] = await Promise.all([
      listWorkLoopTriggers(ctx.db, req.companyId!, loopId),
      listWorkLoopRuns(ctx.db, req.companyId!, loopId, 30)
    ]);
    return sendOk(res, {
      data: {
        ...serializeLoop(row),
        triggers: triggers.map(serializeTrigger),
        recentRuns: recentRuns.map(serializeRun)
      }
    });
  });

  router.patch("/:loopId", async (req, res) => {
    if (!enforcePermission(req, res, "loops:write")) {
      return;
    }
    const parsed = WorkLoopUpdateRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(res, parsed.error.message, 422);
    }
    const row = await updateWorkLoop(ctx.db, req.companyId!, req.params.loopId, parsed.data);
    if (!row) {
      return sendError(res, "Work loop not found.", 404);
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
    return sendOk(res, { data: serializeLoop(row) });
  });

  router.post("/:loopId/run", async (req, res) => {
    if (!enforcePermission(req, res, "loops:run")) {
      return;
    }
    const loopId = req.params.loopId;
    const loop = await getWorkLoop(ctx.db, req.companyId!, loopId);
    if (!loop) {
      return sendError(res, "Work loop not found.", 404);
    }
    const run = await dispatchLoopRun(ctx.db, {
      companyId: req.companyId!,
      loopId,
      triggerId: null,
      source: "manual",
      idempotencyKey: req.requestId ? `manual:${loopId}:${req.requestId}` : `manual:${loopId}:${Date.now()}`,
      realtimeHub: ctx.realtimeHub,
      requestId: req.requestId
    });
    if (!run) {
      return sendError(res, "Work loop is not active or could not be dispatched.", 409);
    }
    await appendAuditEvent(ctx.db, {
      companyId: req.companyId!,
      actorType: "human",
      actorId: req.actor?.id ?? null,
      eventType: "work_loop.manual_run",
      entityType: "work_loop",
      entityId: loopId,
      correlationId: req.requestId ?? null,
      payload: { runId: run.id, status: run.status }
    });
    return sendOk(res, { data: serializeRun(run) });
  });

  router.get("/:loopId/runs", async (req, res) => {
    if (!enforcePermission(req, res, "loops:read")) {
      return;
    }
    const loop = await getWorkLoop(ctx.db, req.companyId!, req.params.loopId);
    if (!loop) {
      return sendError(res, "Work loop not found.", 404);
    }
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
    const runs = await listWorkLoopRuns(ctx.db, req.companyId!, req.params.loopId, limit);
    return sendOk(res, { data: runs.map(serializeRun) });
  });

  router.get("/:loopId/activity", async (req, res) => {
    if (!enforcePermission(req, res, "loops:read")) {
      return;
    }
    const loopId = req.params.loopId;
    const loop = await getWorkLoop(ctx.db, req.companyId!, loopId);
    if (!loop) {
      return sendError(res, "Work loop not found.", 404);
    }
    const events = await listAuditEvents(ctx.db, req.companyId!, 200);
    const filtered = events.filter((e) => e.entityType === "work_loop" && e.entityId === loopId);
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

  router.post("/:loopId/triggers", async (req, res) => {
    if (!enforcePermission(req, res, "loops:write")) {
      return;
    }
    const loopId = req.params.loopId;
    const loop = await getWorkLoop(ctx.db, req.companyId!, loopId);
    if (!loop) {
      return sendError(res, "Work loop not found.", 404);
    }
    const parsed = WorkLoopTriggerCreateRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(res, parsed.error.message, 422);
    }
    try {
      const body = parsed.data;
      const trigger =
        body.mode === "cron"
          ? await addWorkLoopTrigger(ctx.db, {
              companyId: req.companyId!,
              workLoopId: loopId,
              cronExpression: body.cronExpression,
              timezone: body.timezone,
              label: body.label ?? null,
              enabled: body.enabled
            })
          : await addWorkLoopTriggerFromPreset(ctx.db, {
              companyId: req.companyId!,
              workLoopId: loopId,
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

  router.patch("/:loopId/triggers/:triggerId", async (req, res) => {
    if (!enforcePermission(req, res, "loops:write")) {
      return;
    }
    const parsed = WorkLoopTriggerUpdateRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(res, parsed.error.message, 422);
    }
    const loop = await getWorkLoop(ctx.db, req.companyId!, req.params.loopId);
    if (!loop) {
      return sendError(res, "Work loop not found.", 404);
    }
    try {
      const row = await updateWorkLoopTrigger(ctx.db, req.companyId!, req.params.triggerId, parsed.data);
      if (!row || row.workLoopId !== req.params.loopId) {
        return sendError(res, "Trigger not found.", 404);
      }
      return sendOk(res, { data: serializeTrigger(row) });
    } catch (e) {
      return sendError(res, e instanceof Error ? e.message : "Failed to update trigger.", 422);
    }
  });

  router.delete("/:loopId/triggers/:triggerId", async (req, res) => {
    if (!enforcePermission(req, res, "loops:write")) {
      return;
    }
    const { loopId, triggerId } = req.params;
    const loop = await getWorkLoop(ctx.db, req.companyId!, loopId);
    if (!loop) {
      return sendError(res, "Work loop not found.", 404);
    }
    const deleted = await deleteWorkLoopTrigger(ctx.db, req.companyId!, loopId, triggerId);
    if (!deleted) {
      return sendError(res, "Trigger not found.", 404);
    }
    await appendAuditEvent(ctx.db, {
      companyId: req.companyId!,
      actorType: "human",
      actorId: req.actor?.id ?? null,
      eventType: "work_loop.trigger_deleted",
      entityType: "work_loop",
      entityId: loopId,
      correlationId: req.requestId ?? null,
      payload: { triggerId }
    });
    return sendOk(res, { deleted: true });
  });

  return router;
}
