import { mkdir } from "node:fs/promises";
import type { NextFunction, Request, Response } from "express";
import { Router } from "express";
import { z } from "zod";
import { CompanySchema } from "bopodev-contracts";
import { createAgent, createCompany, deleteCompany, listCompanies, updateCompany } from "bopodev-db";
import type { AppContext } from "../context";
import { sendError, sendOk, sendOkValidated } from "../http";
import { normalizeRuntimeConfig, resolveRuntimeModelForProvider, runtimeConfigToDb, runtimeConfigToStateBlobPatch } from "../lib/agent-config";
import { buildDefaultCeoBootstrapPrompt } from "../lib/ceo-bootstrap-prompt";
import { resolveOpencodeRuntimeModel } from "../lib/opencode-model";
import { resolveDefaultRuntimeCwdForCompany } from "../lib/workspace-policy";
import { canAccessCompany, requireBoardRole, requirePermission } from "../middleware/request-actor";
import { ensureCompanyBuiltinPluginDefaults } from "../services/plugin-runtime";
import { ensureCompanyBuiltinTemplateDefaults } from "../services/template-catalog";

const DEFAULT_AGENT_PROVIDER_ENV = "BOPO_DEFAULT_AGENT_PROVIDER";
const DEFAULT_AGENT_MODEL_ENV = "BOPO_DEFAULT_AGENT_MODEL";

const createCompanySchema = z.object({
  name: z.string().min(1),
  mission: z.string().optional(),
  providerType: z
    .enum(["codex", "claude_code", "cursor", "gemini_cli", "opencode", "openai_api", "anthropic_api", "shell"])
    .optional(),
  runtimeModel: z.string().optional()
});

const updateCompanySchema = z
  .object({
    name: z.string().min(1).optional(),
    mission: z.string().optional()
  })
  .refine((payload) => Object.keys(payload).length > 0, "At least one field must be provided.");

export function createCompaniesRouter(ctx: AppContext) {
  const router = Router();

  router.get("/", async (req, res) => {
    const companies = (await listCompanies(ctx.db)).map((company) => ({
      ...company,
      createdAt: company.createdAt instanceof Date ? company.createdAt.toISOString() : String(company.createdAt)
    }));
    if (req.actor?.type === "board") {
      return sendOkValidated(res, CompanySchema.array(), companies, "companies.list");
    }
    const visibleCompanyIds = new Set(req.actor?.companyIds ?? []);
    return sendOkValidated(
      res,
      CompanySchema.array(),
      companies.filter((company) => visibleCompanyIds.has(company.id)),
      "companies.list.filtered"
    );
  });

  router.post("/", requireBoardRole, async (req, res) => {
    const parsed = createCompanySchema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(res, parsed.error.message, 422);
    }
    const company = await createCompany(ctx.db, parsed.data);
    const providerType =
      parseAgentProvider(parsed.data.providerType) ??
      parseAgentProvider(process.env[DEFAULT_AGENT_PROVIDER_ENV]) ??
      "shell";
    const defaultRuntimeCwd = await resolveDefaultRuntimeCwdForCompany(ctx.db, company.id);
    await mkdir(defaultRuntimeCwd, { recursive: true });
    const requestedModel = parsed.data.runtimeModel?.trim() || process.env[DEFAULT_AGENT_MODEL_ENV]?.trim() || undefined;
    const resolvedRuntimeModel = resolveRuntimeModelForProvider(
      providerType,
      await resolveOpencodeRuntimeModel(
        providerType,
        normalizeRuntimeConfig({
          defaultRuntimeCwd,
          runtimeConfig: {
            runtimeModel: requestedModel,
            runtimeEnv: resolveSeedRuntimeEnv(providerType)
          }
        })
      )
    );
    const defaultRuntimeConfig = normalizeRuntimeConfig({
      defaultRuntimeCwd,
      runtimeConfig: {
        runtimeModel: resolvedRuntimeModel,
        bootstrapPrompt: buildDefaultCeoBootstrapPrompt(),
        runtimeEnv: resolveSeedRuntimeEnv(providerType),
        ...(providerType === "shell"
          ? {
              runtimeCommand: "echo",
              runtimeArgs: ["ceo bootstrap heartbeat"]
            }
          : {})
      }
    });
    await createAgent(ctx.db, {
      companyId: company.id,
      role: "CEO",
      roleKey: "ceo",
      title: "CEO",
      name: "CEO",
      providerType,
      heartbeatCron: "*/5 * * * *",
      monthlyBudgetUsd: "100.0000",
      canHireAgents: true,
      ...runtimeConfigToDb(defaultRuntimeConfig),
      initialState: runtimeConfigToStateBlobPatch(defaultRuntimeConfig)
    });
    await ensureCompanyBuiltinPluginDefaults(ctx.db, company.id);
    await ensureCompanyBuiltinTemplateDefaults(ctx.db, company.id);
    return sendOk(res, company);
  });

  router.put("/:companyId", requireCompanyWriteAccess, async (req, res) => {
    const parsed = updateCompanySchema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(res, parsed.error.message, 422);
    }

    const companyId = readCompanyIdParam(req);
    if (!companyId) {
      return sendError(res, "Missing company id.", 422);
    }
    const company = await updateCompany(ctx.db, { id: companyId, ...parsed.data });
    if (!company) {
      return sendError(res, "Company not found.", 404);
    }
    return sendOk(res, company);
  });

  router.delete("/:companyId", requireCompanyWriteAccess, async (req, res) => {
    const companyId = readCompanyIdParam(req);
    if (!companyId) {
      return sendError(res, "Missing company id.", 422);
    }
    const deleted = await deleteCompany(ctx.db, companyId);
    if (!deleted) {
      return sendError(res, "Company not found.", 404);
    }
    return sendOk(res, { deleted: true });
  });

  return router;
}

function requireCompanyWriteAccess(req: Request, res: Response, next: NextFunction) {
  const targetCompanyId = readCompanyIdParam(req);
  if (!targetCompanyId) {
    return sendError(res, "Missing company id.", 422);
  }
  if (!canAccessCompany(req, targetCompanyId)) {
    return sendError(res, "Actor does not have access to this company.", 403);
  }
  if (req.actor?.type === "board") {
    next();
    return;
  }
  return requirePermission("companies:write")(req, res, next);
}

function readCompanyIdParam(req: Request) {
  return typeof req.params.companyId === "string" ? req.params.companyId : null;
}

function parseAgentProvider(value: unknown) {
  if (
    value === "codex" ||
    value === "claude_code" ||
    value === "cursor" ||
    value === "gemini_cli" ||
    value === "opencode" ||
    value === "openai_api" ||
    value === "anthropic_api" ||
    value === "shell"
  ) {
    return value;
  }
  return null;
}

function resolveSeedRuntimeEnv(providerType: string): Record<string, string> {
  if (providerType === "codex" || providerType === "openai_api") {
    const key = (process.env.BOPO_OPENAI_API_KEY ?? process.env.OPENAI_API_KEY)?.trim();
    return key ? { OPENAI_API_KEY: key } : {};
  }
  if (providerType === "claude_code" || providerType === "anthropic_api") {
    const key = (process.env.BOPO_ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_API_KEY)?.trim();
    return key ? { ANTHROPIC_API_KEY: key } : {};
  }
  return {};
}
