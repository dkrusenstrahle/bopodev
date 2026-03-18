import { Router } from "express";
import { z } from "zod";
import { sendError, sendOkValidated } from "../http";
import { requireCompanyScope } from "../middleware/company-scope";
import type { AppContext } from "../context";
import {
  clearBoardAttentionDismissed,
  listBoardAttentionItems,
  markBoardAttentionAcknowledged,
  markBoardAttentionDismissed,
  markBoardAttentionResolved,
  markBoardAttentionSeen
} from "../services/attention-service";
import { BoardAttentionListResponseSchema } from "bopodev-contracts";
import { createAttentionRealtimeEvent } from "../realtime/attention";

const itemParamsSchema = z.object({
  itemKey: z.string().min(1)
});

export function createAttentionRouter(ctx: AppContext) {
  const router = Router();
  router.use(requireCompanyScope);

  // Canonical board action queue endpoint for Inbox and board attention UX.
  router.get("/", async (req, res) => {
    const actorId = req.actor?.id ?? "local-board";
    const items = await listBoardAttentionItems(ctx.db, req.companyId!, actorId);
    return sendOkValidated(res, BoardAttentionListResponseSchema, { actorId, items }, "attention.list");
  });

  router.post("/:itemKey/seen", async (req, res) => {
    const parsed = itemParamsSchema.safeParse(req.params);
    if (!parsed.success) {
      return sendError(res, parsed.error.message, 422);
    }
    const actorId = req.actor?.id ?? "local-board";
    await markBoardAttentionSeen(ctx.db, req.companyId!, actorId, parsed.data.itemKey);
    await publishAttentionUpdate(ctx, req.companyId!, actorId, parsed.data.itemKey);
    return sendOkValidated(res, z.object({ ok: z.literal(true) }), { ok: true }, "attention.seen");
  });

  router.post("/:itemKey/acknowledge", async (req, res) => {
    const parsed = itemParamsSchema.safeParse(req.params);
    if (!parsed.success) {
      return sendError(res, parsed.error.message, 422);
    }
    const actorId = req.actor?.id ?? "local-board";
    await markBoardAttentionAcknowledged(ctx.db, req.companyId!, actorId, parsed.data.itemKey);
    await publishAttentionUpdate(ctx, req.companyId!, actorId, parsed.data.itemKey);
    return sendOkValidated(res, z.object({ ok: z.literal(true) }), { ok: true }, "attention.acknowledge");
  });

  router.post("/:itemKey/dismiss", async (req, res) => {
    const parsed = itemParamsSchema.safeParse(req.params);
    if (!parsed.success) {
      return sendError(res, parsed.error.message, 422);
    }
    const actorId = req.actor?.id ?? "local-board";
    await markBoardAttentionDismissed(ctx.db, req.companyId!, actorId, parsed.data.itemKey);
    await publishAttentionUpdate(ctx, req.companyId!, actorId, parsed.data.itemKey);
    return sendOkValidated(res, z.object({ ok: z.literal(true) }), { ok: true }, "attention.dismiss");
  });

  router.post("/:itemKey/undismiss", async (req, res) => {
    const parsed = itemParamsSchema.safeParse(req.params);
    if (!parsed.success) {
      return sendError(res, parsed.error.message, 422);
    }
    const actorId = req.actor?.id ?? "local-board";
    await clearBoardAttentionDismissed(ctx.db, req.companyId!, actorId, parsed.data.itemKey);
    await publishAttentionUpdate(ctx, req.companyId!, actorId, parsed.data.itemKey);
    return sendOkValidated(res, z.object({ ok: z.literal(true) }), { ok: true }, "attention.undismiss");
  });

  router.post("/:itemKey/resolve", async (req, res) => {
    const parsed = itemParamsSchema.safeParse(req.params);
    if (!parsed.success) {
      return sendError(res, parsed.error.message, 422);
    }
    const actorId = req.actor?.id ?? "local-board";
    await markBoardAttentionResolved(ctx.db, req.companyId!, actorId, parsed.data.itemKey);
    await publishAttentionResolve(ctx, req.companyId!, actorId, parsed.data.itemKey);
    return sendOkValidated(res, z.object({ ok: z.literal(true) }), { ok: true }, "attention.resolve");
  });

  return router;
}

async function publishAttentionUpdate(ctx: AppContext, companyId: string, actorId: string, itemKey: string) {
  const items = await listBoardAttentionItems(ctx.db, companyId, actorId);
  const item = items.find((entry) => entry.key === itemKey);
  if (!item) {
    return;
  }
  ctx.realtimeHub?.publish(
    createAttentionRealtimeEvent(companyId, {
      type: "attention.updated",
      item
    })
  );
}

async function publishAttentionResolve(ctx: AppContext, companyId: string, actorId: string, itemKey: string) {
  await publishAttentionUpdate(ctx, companyId, actorId, itemKey);
  ctx.realtimeHub?.publish(
    createAttentionRealtimeEvent(companyId, {
      type: "attention.resolved",
      key: itemKey
    })
  );
}
