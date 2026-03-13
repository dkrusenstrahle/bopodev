import { Router } from "express";
import { z } from "zod";
import {
  appendAuditEvent,
  clearApprovalInboxDismissed,
  countPendingApprovalRequests,
  getApprovalRequest,
  listApprovalInboxStates,
  listApprovalRequests,
  markApprovalInboxDismissed,
  markApprovalInboxSeen
} from "bopodev-db";
import type { AppContext } from "../context";
import { sendError, sendOk } from "../http";
import { requireCompanyScope } from "../middleware/company-scope";
import { requirePermission } from "../middleware/request-actor";
import { createGovernanceRealtimeEvent, serializeStoredApproval } from "../realtime/governance";
import {
  publishOfficeOccupantForAgent,
  publishOfficeOccupantForApproval
} from "../realtime/office-space";
import { GovernanceError, resolveApproval } from "../services/governance-service";

const resolveSchema = z.object({
  approvalId: z.string().min(1),
  status: z.enum(["approved", "rejected", "overridden"])
});
const inboxMutationSchema = z.object({
  approvalId: z.string().min(1)
});
const RESOLVED_APPROVAL_INBOX_WINDOW_DAYS = 30;

export function createGovernanceRouter(ctx: AppContext) {
  const router = Router();
  router.use(requireCompanyScope);

  router.get("/approvals", async (req, res) => {
    const approvals = await listApprovalRequests(ctx.db, req.companyId!);
    return sendOk(
      res,
      approvals.map((approval) => ({
        ...approval,
        payload: parsePayload(approval.payloadJson)
      }))
    );
  });

  router.get("/approvals/pending-count", async (req, res) => {
    const count = await countPendingApprovalRequests(ctx.db, req.companyId!);
    return sendOk(res, { count });
  });

  router.get("/inbox", async (req, res) => {
    const actorId = req.actor?.id ?? "local-board";
    const [approvals, inboxStates] = await Promise.all([
      listApprovalRequests(ctx.db, req.companyId!),
      listApprovalInboxStates(ctx.db, req.companyId!, actorId)
    ]);
    const now = Date.now();
    const resolvedWindowMs = RESOLVED_APPROVAL_INBOX_WINDOW_DAYS * 24 * 60 * 60 * 1000;
    const inboxStateByApprovalId = new Map(inboxStates.map((state) => [state.approvalId, state]));
    const items = approvals
      .filter((approval) => {
        if (approval.status === "pending") {
          return true;
        }
        if (!approval.resolvedAt) {
          return false;
        }
        return now - approval.resolvedAt.getTime() <= resolvedWindowMs;
      })
      .map((approval) => {
        const inboxState = inboxStateByApprovalId.get(approval.id);
        return {
          approval: serializeStoredApproval(approval),
          seenAt: inboxState?.seenAt?.toISOString() ?? null,
          dismissedAt: inboxState?.dismissedAt?.toISOString() ?? null,
          isPending: approval.status === "pending"
        };
      });

    return sendOk(res, {
      actorId,
      resolvedWindowDays: RESOLVED_APPROVAL_INBOX_WINDOW_DAYS,
      items
    });
  });

  router.post("/inbox/:approvalId/seen", async (req, res) => {
    const parsed = inboxMutationSchema.safeParse(req.params);
    if (!parsed.success) {
      return sendError(res, parsed.error.message, 422);
    }
    const approval = await getApprovalRequest(ctx.db, req.companyId!, parsed.data.approvalId);
    if (!approval) {
      return sendError(res, "Approval request not found.", 404);
    }
    const actorId = req.actor?.id ?? "local-board";
    await markApprovalInboxSeen(ctx.db, {
      companyId: req.companyId!,
      actorId,
      approvalId: approval.id
    });
    return sendOk(res, { ok: true });
  });

  router.post("/inbox/:approvalId/dismiss", async (req, res) => {
    const parsed = inboxMutationSchema.safeParse(req.params);
    if (!parsed.success) {
      return sendError(res, parsed.error.message, 422);
    }
    const approval = await getApprovalRequest(ctx.db, req.companyId!, parsed.data.approvalId);
    if (!approval) {
      return sendError(res, "Approval request not found.", 404);
    }
    const actorId = req.actor?.id ?? "local-board";
    await markApprovalInboxDismissed(ctx.db, {
      companyId: req.companyId!,
      actorId,
      approvalId: approval.id
    });
    return sendOk(res, { ok: true });
  });

  router.post("/inbox/:approvalId/undismiss", async (req, res) => {
    const parsed = inboxMutationSchema.safeParse(req.params);
    if (!parsed.success) {
      return sendError(res, parsed.error.message, 422);
    }
    const approval = await getApprovalRequest(ctx.db, req.companyId!, parsed.data.approvalId);
    if (!approval) {
      return sendError(res, "Approval request not found.", 404);
    }
    const actorId = req.actor?.id ?? "local-board";
    await clearApprovalInboxDismissed(ctx.db, {
      companyId: req.companyId!,
      actorId,
      approvalId: approval.id
    });
    return sendOk(res, { ok: true });
  });

  router.post("/resolve", async (req, res) => {
    requirePermission("governance:resolve")(req, res, () => {});
    if (res.headersSent) {
      return;
    }
    const parsed = resolveSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(res, parsed.error.message, 422);
    }
    let resolution;
    try {
      resolution = await resolveApproval(ctx.db, req.companyId!, parsed.data.approvalId, parsed.data.status);
    } catch (error) {
      if (error instanceof GovernanceError) {
        return sendError(res, error.message, 422);
      }
      throw error;
    }

    await appendAuditEvent(ctx.db, {
      companyId: req.companyId!,
      actorType: "human",
      eventType: "governance.approval_resolved",
      entityType: "approval_request",
      entityId: parsed.data.approvalId,
      payload: resolution
    });

    if (resolution.execution.applied && resolution.execution.entityType && resolution.execution.entityId) {
      const eventType =
        resolution.action === "grant_plugin_capabilities"
          ? "plugin.capabilities_granted_from_approval"
          : resolution.execution.entityType === "agent"
          ? "agent.hired_from_approval"
          : resolution.execution.entityType === "goal"
            ? "goal.activated_from_approval"
            : "memory.promoted_from_approval";
      await appendAuditEvent(ctx.db, {
        companyId: req.companyId!,
        actorType: "human",
        eventType,
        entityType: resolution.execution.entityType,
        entityId: resolution.execution.entityId,
        payload: resolution.execution.entity ?? { id: resolution.execution.entityId }
      });
    }

    const approval = await getApprovalRequest(ctx.db, req.companyId!, parsed.data.approvalId);
    if (approval) {
      ctx.realtimeHub?.publish(
        createGovernanceRealtimeEvent(req.companyId!, {
          type: "approval.resolved",
          approval: serializeStoredApproval(approval)
        })
      );
      await publishOfficeOccupantForApproval(ctx.db, ctx.realtimeHub, req.companyId!, approval.id);
      if (approval.requestedByAgentId) {
        await publishOfficeOccupantForAgent(ctx.db, ctx.realtimeHub, req.companyId!, approval.requestedByAgentId);
      }
    }

    if (resolution.execution.entityType === "agent" && resolution.execution.entityId) {
      await publishOfficeOccupantForAgent(ctx.db, ctx.realtimeHub, req.companyId!, resolution.execution.entityId);
    }

    return sendOk(res, resolution);
  });

  return router;
}

function parsePayload(payloadJson: string) {
  try {
    const parsed = JSON.parse(payloadJson) as unknown;
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}
