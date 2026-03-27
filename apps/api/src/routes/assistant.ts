import { Router } from "express";
import { z } from "zod";
import {
  createAssistantThread,
  getAssistantThreadById,
  getOrCreateAssistantThread,
  listAssistantMessages
} from "bopodev-db";
import type { AppContext } from "../context";
import { sendError, sendOk } from "../http";
import { requireCompanyScope } from "../middleware/company-scope";
import { ASK_ASSISTANT_BRAIN_IDS, listAskAssistantBrains } from "../services/company-assistant-brain";
import { getCompanyCeoPersona, runCompanyAssistantTurn } from "../services/company-assistant-service";

const brainEnum = z.enum(ASK_ASSISTANT_BRAIN_IDS);

const postMessageSchema = z.object({
  message: z.string().trim().min(1).max(16_000),
  /** Adapter / runtime used to answer (same catalog as hiring an agent). */
  brain: brainEnum.optional(),
  /** Active chat thread; omit to use latest-or-create for the company. */
  threadId: z.string().trim().min(1).optional()
});

export function createAssistantRouter(ctx: AppContext) {
  const router = Router();
  router.use(requireCompanyScope);

  router.get("/brains", (_req, res) => {
    return sendOk(res, { brains: listAskAssistantBrains() });
  });

  router.get("/messages", async (req, res) => {
    const companyId = req.companyId!;
    const qThread =
      typeof req.query.threadId === "string" && req.query.threadId.trim() ? req.query.threadId.trim() : "";
    let thread;
    if (qThread) {
      const found = await getAssistantThreadById(ctx.db, companyId, qThread);
      if (!found) {
        return sendError(res, "Chat thread not found.", 404);
      }
      thread = found;
    } else {
      thread = await getOrCreateAssistantThread(ctx.db, companyId);
    }
    const rawLimit = Number(req.query.limit ?? 100);
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.floor(rawLimit), 1), 200) : 100;
    const rows = await listAssistantMessages(ctx.db, thread.id, limit);
    const ceoPersona = await getCompanyCeoPersona(ctx.db, companyId);
    return sendOk(res, {
      threadId: thread.id,
      ceoPersona,
      messages: rows.map((m) => ({
        id: m.id,
        role: m.role,
        body: m.body,
        createdAt: m.createdAt instanceof Date ? m.createdAt.toISOString() : String(m.createdAt),
        metadata: m.metadataJson ? safeJsonParse(m.metadataJson) : null
      }))
    });
  });

  router.post("/messages", async (req, res) => {
    const parsed = postMessageSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(res, parsed.error.message, 422);
    }
    const companyId = req.companyId!;
    const actor = req.actor;
    const auditActorType =
      actor?.type === "agent" ? "agent" : actor?.type === "board" || actor?.type === "member" ? "human" : "human";
    const actorId = actor?.id?.trim() || "unknown";
    try {
      const result = await runCompanyAssistantTurn({
        db: ctx.db,
        companyId,
        userMessage: parsed.data.message,
        actorType: auditActorType,
        actorId,
        brain: parsed.data.brain,
        threadId: parsed.data.threadId
      });
      return sendOk(res, result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("Missing API key")) {
        return sendError(res, message, 503);
      }
      return sendError(res, message, 422);
    }
  });

  router.post("/threads", async (req, res) => {
    const companyId = req.companyId!;
    const thread = await createAssistantThread(ctx.db, companyId);
    return sendOk(res, { threadId: thread.id });
  });

  return router;
}

function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}
