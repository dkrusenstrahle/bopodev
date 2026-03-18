import { Router } from "express";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { agents, heartbeatRuns, listHeartbeatQueueJobs } from "bopodev-db";
import type { AppContext } from "../context";
import { sendError, sendOk } from "../http";
import { requireCompanyScope } from "../middleware/company-scope";
import { requirePermission } from "../middleware/request-actor";
import {
  findPendingProjectBudgetOverrideBlocksForAgent,
  runHeartbeatSweep,
  stopHeartbeatRun
} from "../services/heartbeat-service";
import { enqueueHeartbeatQueueJob, triggerHeartbeatQueueWorker } from "../services/heartbeat-queue-service";

const runAgentSchema = z.object({
  agentId: z.string().min(1)
});
const runIdParamsSchema = z.object({
  runId: z.string().min(1)
});
const queueQuerySchema = z.object({
  status: z.enum(["pending", "running", "completed", "failed", "dead_letter", "canceled"]).optional(),
  agentId: z.string().min(1).optional(),
  jobType: z.enum(["manual", "scheduler", "resume", "redo", "comment_dispatch"]).optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional()
});

export function createHeartbeatRouter(ctx: AppContext) {
  const router = Router();
  router.use(requireCompanyScope);

  router.post("/run-agent", async (req, res) => {
    requirePermission("heartbeats:run")(req, res, () => {});
    if (res.headersSent) {
      return;
    }
    const parsed = runAgentSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(res, parsed.error.message, 422);
    }
    const [agent] = await ctx.db
      .select({ id: agents.id, status: agents.status })
      .from(agents)
      .where(and(eq(agents.companyId, req.companyId!), eq(agents.id, parsed.data.agentId)))
      .limit(1);
    if (!agent) {
      return sendError(res, "Agent not found.", 404);
    }
    if (agent.status === "paused" || agent.status === "terminated") {
      return sendError(res, `Agent is not invokable in status '${agent.status}'.`, 409);
    }
    const blockedProjectIds = await findPendingProjectBudgetOverrideBlocksForAgent(
      ctx.db,
      req.companyId!,
      parsed.data.agentId
    );
    if (blockedProjectIds.length > 0) {
      return sendError(
        res,
        `Agent is blocked by pending project budget approval for project(s): ${blockedProjectIds.join(", ")}.`,
        423
      );
    }

    const job = await enqueueHeartbeatQueueJob(ctx.db, {
      companyId: req.companyId!,
      agentId: parsed.data.agentId,
      jobType: "manual",
      priority: 30,
      idempotencyKey: req.requestId ? `manual:${parsed.data.agentId}:${req.requestId}` : null,
      payload: {}
    });
    triggerHeartbeatQueueWorker(ctx.db, req.companyId!, {
      requestId: req.requestId,
      realtimeHub: ctx.realtimeHub
    });
    return sendOk(res, {
      runId: null,
      jobId: job.id,
      requestId: req.requestId,
      status: "queued",
      message: "Heartbeat queued."
    });
  });

  router.post("/:runId/stop", async (req, res) => {
    requirePermission("heartbeats:run")(req, res, () => {});
    if (res.headersSent) {
      return;
    }
    const parsed = runIdParamsSchema.safeParse(req.params);
    if (!parsed.success) {
      return sendError(res, parsed.error.message, 422);
    }
    const stopResult = await stopHeartbeatRun(ctx.db, req.companyId!, parsed.data.runId, {
      requestId: req.requestId,
      trigger: "manual",
      actorId: req.actor?.id ?? undefined,
      realtimeHub: ctx.realtimeHub
    });
    if (!stopResult.ok) {
      if (stopResult.reason === "not_found") {
        return sendError(res, "Heartbeat run not found.", 404);
      }
      return sendError(res, `Heartbeat run is not stoppable in status '${stopResult.status}'.`, 409);
    }
    return sendOk(res, {
      runId: stopResult.runId,
      requestId: req.requestId,
      status: "stop_requested"
    });
  });

  async function rerunFromHistory(input: {
    mode: "resume" | "redo";
    runId: string;
    companyId: string;
    requestId?: string;
  }) {
    const [run] = await ctx.db
      .select({
        id: heartbeatRuns.id,
        status: heartbeatRuns.status,
        agentId: heartbeatRuns.agentId
      })
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.id, input.runId)))
      .limit(1);
    if (!run) {
      return { ok: false as const, statusCode: 404, message: "Heartbeat run not found." };
    }
    if (run.status === "started") {
      return { ok: false as const, statusCode: 409, message: "Run is still in progress and cannot be replayed yet." };
    }
    const [agent] = await ctx.db
      .select({ id: agents.id, status: agents.status })
      .from(agents)
      .where(and(eq(agents.companyId, input.companyId), eq(agents.id, run.agentId)))
      .limit(1);
    if (!agent) {
      return { ok: false as const, statusCode: 404, message: "Agent not found." };
    }
    if (agent.status === "paused" || agent.status === "terminated") {
      return { ok: false as const, statusCode: 409, message: `Agent is not invokable in status '${agent.status}'.` };
    }
    const blockedProjectIds = await findPendingProjectBudgetOverrideBlocksForAgent(ctx.db, input.companyId, run.agentId);
    if (blockedProjectIds.length > 0) {
      return {
        ok: false as const,
        statusCode: 423,
        message: `Agent is blocked by pending project budget approval for project(s): ${blockedProjectIds.join(", ")}.`
      };
    }
    const job = await enqueueHeartbeatQueueJob(ctx.db, {
      companyId: input.companyId,
      agentId: run.agentId,
      jobType: input.mode,
      priority: 30,
      idempotencyKey: input.requestId ? `${input.mode}:${run.agentId}:${run.id}:${input.requestId}` : null,
      payload: { sourceRunId: run.id }
    });
    triggerHeartbeatQueueWorker(ctx.db, input.companyId, {
      requestId: input.requestId,
      realtimeHub: ctx.realtimeHub
    });
    return {
      ok: true as const,
      runId: null,
      jobId: job.id,
      status: "queued" as const,
      message: "Heartbeat queued."
    };
  }

  router.post("/:runId/resume", async (req, res) => {
    requirePermission("heartbeats:run")(req, res, () => {});
    if (res.headersSent) {
      return;
    }
    const parsed = runIdParamsSchema.safeParse(req.params);
    if (!parsed.success) {
      return sendError(res, parsed.error.message, 422);
    }
    const result = await rerunFromHistory({
      mode: "resume",
      runId: parsed.data.runId,
      companyId: req.companyId!,
      requestId: req.requestId
    });
    if (!result.ok) {
      return sendError(res, result.message, result.statusCode);
    }
    return sendOk(res, {
      runId: result.runId,
      jobId: result.jobId,
      requestId: req.requestId,
      status: result.status,
      message: result.message
    });
  });

  router.post("/:runId/redo", async (req, res) => {
    requirePermission("heartbeats:run")(req, res, () => {});
    if (res.headersSent) {
      return;
    }
    const parsed = runIdParamsSchema.safeParse(req.params);
    if (!parsed.success) {
      return sendError(res, parsed.error.message, 422);
    }
    const result = await rerunFromHistory({
      mode: "redo",
      runId: parsed.data.runId,
      companyId: req.companyId!,
      requestId: req.requestId
    });
    if (!result.ok) {
      return sendError(res, result.message, result.statusCode);
    }
    return sendOk(res, {
      runId: result.runId,
      jobId: result.jobId,
      requestId: req.requestId,
      status: result.status,
      message: result.message
    });
  });

  router.post("/sweep", async (req, res) => {
    requirePermission("heartbeats:sweep")(req, res, () => {});
    if (res.headersSent) {
      return;
    }
    const runIds = await runHeartbeatSweep(ctx.db, req.companyId!, {
      requestId: req.requestId,
      realtimeHub: ctx.realtimeHub
    });
    return sendOk(res, { runIds, requestId: req.requestId });
  });

  router.get("/queue", async (req, res) => {
    requirePermission("heartbeats:run")(req, res, () => {});
    if (res.headersSent) {
      return;
    }
    const parsed = queueQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return sendError(res, parsed.error.message, 422);
    }
    const jobs = await listHeartbeatQueueJobs(ctx.db, {
      companyId: req.companyId!,
      status: parsed.data.status,
      agentId: parsed.data.agentId,
      jobType: parsed.data.jobType,
      limit: parsed.data.limit
    });
    return sendOk(res, { items: jobs });
  });

  return router;
}
