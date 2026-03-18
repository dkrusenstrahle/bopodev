import { Router } from "express";
import { z } from "zod";
import { GoalSchema } from "bopodev-contracts";
import { appendAuditEvent, createApprovalRequest, createGoal, deleteGoal, getApprovalRequest, listGoals, updateGoal } from "bopodev-db";
import type { AppContext } from "../context";
import { sendError, sendOk, sendOkValidated } from "../http";
import { requireCompanyScope } from "../middleware/company-scope";
import { requirePermission } from "../middleware/request-actor";
import { createGovernanceRealtimeEvent, serializeStoredApproval } from "../realtime/governance";
import { publishAttentionSnapshot } from "../realtime/attention";
import { isApprovalRequired } from "../services/governance-service";

const createGoalSchema = z.object({
  projectId: z.string().optional(),
  parentGoalId: z.string().optional(),
  level: z.enum(["company", "project", "agent"]),
  title: z.string().min(1),
  description: z.string().optional(),
  activateNow: z.boolean().default(false)
});

const updateGoalSchema = z
  .object({
    projectId: z.string().nullable().optional(),
    parentGoalId: z.string().nullable().optional(),
    level: z.enum(["company", "project", "agent"]).optional(),
    title: z.string().min(1).optional(),
    description: z.string().nullable().optional(),
    status: z.enum(["draft", "active", "completed", "archived"]).optional()
  })
  .refine((payload) => Object.keys(payload).length > 0, "At least one field must be provided.");

export function createGoalsRouter(ctx: AppContext) {
  const router = Router();
  router.use(requireCompanyScope);

  router.get("/", async (req, res) => {
    return sendOkValidated(
      res,
      GoalSchema.array(),
      await listGoals(ctx.db, req.companyId!),
      "goals.list"
    );
  });

  router.post("/", async (req, res) => {
    requirePermission("goals:write")(req, res, () => {});
    if (res.headersSent) {
      return;
    }
    const parsed = createGoalSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(res, parsed.error.message, 422);
    }

    if (parsed.data.activateNow && isApprovalRequired("activate_goal")) {
      const approvalId = await createApprovalRequest(ctx.db, {
        companyId: req.companyId!,
        action: "activate_goal",
        payload: parsed.data
      });
      const approval = await getApprovalRequest(ctx.db, req.companyId!, approvalId);
      if (approval) {
        ctx.realtimeHub?.publish(
          createGovernanceRealtimeEvent(req.companyId!, {
            type: "approval.created",
            approval: serializeStoredApproval(approval)
          })
        );
        await publishAttentionSnapshot(ctx.db, ctx.realtimeHub, req.companyId!);
      }
      return sendOk(res, { queuedForApproval: true, approvalId });
    }

    const goal = await createGoal(ctx.db, {
      companyId: req.companyId!,
      projectId: parsed.data.projectId,
      parentGoalId: parsed.data.parentGoalId,
      level: parsed.data.level,
      title: parsed.data.title,
      description: parsed.data.description
    });
    await appendAuditEvent(ctx.db, {
      companyId: req.companyId!,
      actorType: "human",
      eventType: "goal.created",
      entityType: "goal",
      entityId: goal.id,
      payload: goal
    });
    return sendOk(res, goal);
  });

  router.put("/:goalId", async (req, res) => {
    requirePermission("goals:write")(req, res, () => {});
    if (res.headersSent) {
      return;
    }
    const parsed = updateGoalSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(res, parsed.error.message, 422);
    }

    const goal = await updateGoal(ctx.db, { companyId: req.companyId!, id: req.params.goalId, ...parsed.data });
    if (!goal) {
      return sendError(res, "Goal not found.", 404);
    }

    await appendAuditEvent(ctx.db, {
      companyId: req.companyId!,
      actorType: "human",
      eventType: "goal.updated",
      entityType: "goal",
      entityId: goal.id,
      payload: goal
    });
    return sendOk(res, goal);
  });

  router.delete("/:goalId", async (req, res) => {
    requirePermission("goals:write")(req, res, () => {});
    if (res.headersSent) {
      return;
    }
    const deleted = await deleteGoal(ctx.db, req.companyId!, req.params.goalId);
    if (!deleted) {
      return sendError(res, "Goal not found.", 404);
    }

    await appendAuditEvent(ctx.db, {
      companyId: req.companyId!,
      actorType: "human",
      eventType: "goal.deleted",
      entityType: "goal",
      entityId: req.params.goalId,
      payload: { id: req.params.goalId }
    });
    return sendOk(res, { deleted: true });
  });

  return router;
}
