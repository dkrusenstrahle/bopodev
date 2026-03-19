import { Router } from "express";
import { z } from "zod";
import {
  addIssueComment,
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
import { publishAttentionSnapshot } from "../realtime/attention";
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

  // Deprecated compatibility shim:
  // board queue consumers should use /attention as the canonical source.
  // Keep this endpoint until all downstream consumers migrate.
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

    const auditActor = resolveAuditActor(req.actor);
    await appendAuditEvent(ctx.db, {
      companyId: req.companyId!,
      actorType: auditActor.actorType,
      actorId: auditActor.actorId,
      eventType: "governance.approval_resolved",
      entityType: "approval_request",
      entityId: parsed.data.approvalId,
      payload: resolution
    });

    if (resolution.execution.applied && resolution.execution.entityType && resolution.execution.entityId) {
      const eventType =
        resolution.action === "grant_plugin_capabilities"
          ? "plugin.capabilities_granted_from_approval"
          : resolution.action === "apply_template"
            ? "template.applied_from_approval"
          : resolution.execution.entityType === "agent"
          ? "agent.hired_from_approval"
          : resolution.execution.entityType === "goal"
            ? "goal.activated_from_approval"
            : "memory.promoted_from_approval";
      await appendAuditEvent(ctx.db, {
        companyId: req.companyId!,
        actorType: auditActor.actorType,
        actorId: auditActor.actorId,
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
      await publishAttentionSnapshot(ctx.db, ctx.realtimeHub, req.companyId!);
      await publishOfficeOccupantForApproval(ctx.db, ctx.realtimeHub, req.companyId!, approval.id);
      if (approval.requestedByAgentId) {
        await publishOfficeOccupantForAgent(ctx.db, ctx.realtimeHub, req.companyId!, approval.requestedByAgentId);
      }
      if (parsed.data.status === "approved" && resolution.action === "hire_agent" && resolution.execution.applied) {
        const hireContext = parseHireApprovalCommentContext(approval.payloadJson);
        if (hireContext.issueIds.length > 0) {
          const commentBody = buildHireApprovalIssueComment(hireContext.roleLabel);
          try {
            for (const issueId of hireContext.issueIds) {
              await addIssueComment(ctx.db, {
                companyId: req.companyId!,
                issueId,
                body: commentBody,
                authorType: auditActor.actorType === "agent" ? "agent" : "human",
                authorId: auditActor.actorId
              });
            }
          } catch (error) {
            await appendAuditEvent(ctx.db, {
              companyId: req.companyId!,
              actorType: "system",
              actorId: null,
              eventType: "governance.hire_approval_comment_failed",
              entityType: "approval_request",
              entityId: approval.id,
              payload: {
                error: String(error),
                issueIds: hireContext.issueIds
              }
            });
          }
        }
      }
    }

    if (resolution.execution.entityType === "agent" && resolution.execution.entityId) {
      await publishOfficeOccupantForAgent(ctx.db, ctx.realtimeHub, req.companyId!, resolution.execution.entityId);
    }

    return sendOk(res, resolution);
  });

  return router;
}

function resolveAuditActor(actor: { type: "board" | "member" | "agent"; id: string } | undefined) {
  if (!actor) {
    return { actorType: "human" as const, actorId: null as string | null };
  }
  if (actor.type === "agent") {
    return { actorType: "agent" as const, actorId: actor.id };
  }
  return { actorType: "human" as const, actorId: actor.id };
}

function parsePayload(payloadJson: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(payloadJson) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function parseHireApprovalCommentContext(payloadJson: string) {
  const payload = parsePayload(payloadJson);
  const issueIds = normalizeSourceIssueIds(
    typeof payload.sourceIssueId === "string" ? payload.sourceIssueId : undefined,
    Array.isArray(payload.sourceIssueIds) ? payload.sourceIssueIds : undefined
  );
  const roleLabel = resolveHireRoleLabel(payload);
  return { issueIds, roleLabel };
}

function normalizeSourceIssueIds(sourceIssueId?: string, sourceIssueIds?: unknown[]) {
  const normalized = new Set<string>();
  for (const entry of [sourceIssueId, ...(sourceIssueIds ?? [])]) {
    if (typeof entry !== "string") {
      continue;
    }
    const trimmed = entry.trim();
    if (trimmed.length > 0) {
      normalized.add(trimmed);
    }
  }
  return Array.from(normalized);
}

function resolveHireRoleLabel(payload: Record<string, unknown>) {
  const title = typeof payload.title === "string" ? payload.title.trim() : "";
  if (title.length > 0) {
    return title;
  }
  const role = typeof payload.role === "string" ? payload.role.trim() : "";
  if (role.length > 0) {
    return role;
  }
  const roleKey = typeof payload.roleKey === "string" ? payload.roleKey.trim() : "";
  if (roleKey.length > 0) {
    return roleKey.replace(/_/g, " ");
  }
  return null;
}

function buildHireApprovalIssueComment(roleLabel: string | null) {
  if (roleLabel) {
    return `Approved hiring of ${roleLabel}.`;
  }
  return "Approved hiring request.";
}
