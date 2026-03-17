import { Router } from "express";
import { mkdir } from "node:fs/promises";
import { z } from "zod";
import {
  getAdapterMetadata,
  getAdapterModels,
  runAdapterEnvironmentTest
} from "bopodev-agent-sdk";
import { AgentCreateRequestSchema, AgentUpdateRequestSchema } from "bopodev-contracts";
import {
  appendAuditEvent,
  createAgent,
  createApprovalRequest,
  deleteAgent,
  getApprovalRequest,
  listAgents,
  listApprovalRequests,
  updateAgent
} from "bopodev-db";
import type { AppContext } from "../context";
import { sendError, sendOk } from "../http";
import {
  normalizeRuntimeConfig,
  parseRuntimeConfigFromAgentRow,
  resolveRuntimeModelForProvider,
  requiresRuntimeCwd,
  runtimeConfigToDb,
  runtimeConfigToStateBlobPatch
} from "../lib/agent-config";
import { resolveHiringDelegate } from "../lib/hiring-delegate";
import { resolveOpencodeRuntimeModel } from "../lib/opencode-model";
import { assertRuntimeCwdForCompany, hasText, resolveDefaultRuntimeCwdForCompany } from "../lib/workspace-policy";
import { requireCompanyScope } from "../middleware/company-scope";
import { requireBoardRole, requirePermission } from "../middleware/request-actor";
import { createGovernanceRealtimeEvent, serializeStoredApproval } from "../realtime/governance";
import {
  publishOfficeOccupantForAgent,
  publishOfficeOccupantForApproval
} from "../realtime/office-space";
import { isApprovalRequired } from "../services/governance-service";

const legacyRuntimeConfigSchema = z.object({
  runtimeCommand: z.string().optional(),
  runtimeArgs: z.array(z.string()).optional(),
  runtimeCwd: z.string().optional(),
  runtimeTimeoutMs: z.number().int().positive().max(600000).optional(),
  runtimeModel: z.string().optional(),
  runtimeThinkingEffort: z.enum(["auto", "low", "medium", "high"]).optional(),
  bootstrapPrompt: z.string().optional(),
  runtimeTimeoutSec: z.number().int().nonnegative().optional(),
  interruptGraceSec: z.number().int().nonnegative().optional(),
  runtimeEnv: z.record(z.string(), z.string()).optional(),
  runPolicy: z
    .object({
      sandboxMode: z.enum(["workspace_write", "full_access"]).optional(),
      allowWebSearch: z.boolean().optional()
    })
    .optional()
});

const createAgentSchema = AgentCreateRequestSchema.extend({
  ...legacyRuntimeConfigSchema.shape
});

const updateAgentSchema = AgentUpdateRequestSchema.extend({
  ...legacyRuntimeConfigSchema.shape
});

const runtimePreflightSchema = z.object({
  providerType: z.enum([
    "claude_code",
    "codex",
    "cursor",
    "opencode",
    "gemini_cli",
    "openai_api",
    "anthropic_api",
    "http",
    "shell"
  ]),
  runtimeConfig: z.record(z.string(), z.unknown()).optional(),
  ...legacyRuntimeConfigSchema.shape
});
const UPDATE_AGENT_ALLOWED_KEYS = new Set([
  "managerAgentId",
  "role",
  "name",
  "providerType",
  "status",
  "heartbeatCron",
  "monthlyBudgetUsd",
  "canHireAgents",
  "runtimeConfig",
  "runtimeCommand",
  "runtimeArgs",
  "runtimeCwd",
  "runtimeTimeoutMs",
  "runtimeModel",
  "runtimeThinkingEffort",
  "bootstrapPrompt",
  "runtimeTimeoutSec",
  "interruptGraceSec",
  "runtimeEnv",
  "runPolicy"
]);
const UPDATE_RUNTIME_CONFIG_ALLOWED_KEYS = new Set([
  "runtimeCommand",
  "runtimeArgs",
  "runtimeCwd",
  "runtimeEnv",
  "runtimeModel",
  "runtimeThinkingEffort",
  "bootstrapPrompt",
  "runtimeTimeoutSec",
  "interruptGraceSec",
  "runPolicy"
]);

function toAgentResponse(agent: Record<string, unknown>) {
  return {
    ...agent,
    monthlyBudgetUsd:
      typeof agent.monthlyBudgetUsd === "number" ? agent.monthlyBudgetUsd : Number(agent.monthlyBudgetUsd ?? 0),
    usedBudgetUsd: typeof agent.usedBudgetUsd === "number" ? agent.usedBudgetUsd : Number(agent.usedBudgetUsd ?? 0)
  };
}

function providerRequiresNamedModel(providerType: string) {
  return providerType !== "http" && providerType !== "shell";
}

function ensureNamedRuntimeModel(providerType: string, runtimeModel: string | undefined) {
  if (!providerRequiresNamedModel(providerType)) {
    return true;
  }
  return hasText(runtimeModel);
}

export function createAgentsRouter(ctx: AppContext) {
  const router = Router();
  router.use(requireCompanyScope);

  router.get("/", async (req, res) => {
    const rows = await listAgents(ctx.db, req.companyId!);
    return sendOk(
      res,
      rows.map((row) => toAgentResponse(row as unknown as Record<string, unknown>))
    );
  });

  router.get("/hiring-delegate", async (req, res) => {
    const rows = await listAgents(ctx.db, req.companyId!);
    const resolution = resolveHiringDelegate(
      rows.map((row) => ({
        id: row.id,
        name: row.name,
        role: row.role,
        status: row.status,
        canHireAgents: row.canHireAgents
      }))
    );
    return sendOk(res, {
      delegate: resolution.delegate,
      reason: resolution.reason
    });
  });

  router.get("/leadership-diagnostics", async (req, res) => {
    const rows = await listAgents(ctx.db, req.companyId!);
    return sendOk(
      res,
      rows.map((row) => {
        const normalizedRole = row.role.trim().toLowerCase();
        const isLeadership = normalizedRole === "ceo" || Boolean(row.canHireAgents);
        const issues: string[] = [];
        const hasBootstrapPrompt = hasText(row.bootstrapPrompt);
        if (isLeadership && !hasBootstrapPrompt) {
          issues.push("missing_bootstrap_prompt");
        }
        if (isLeadership && !providerSupportsSkillInjection(row.providerType)) {
          issues.push("provider_without_runtime_skill_injection");
        }
        return {
          agentId: row.id,
          name: row.name,
          role: row.role,
          providerType: row.providerType,
          canHireAgents: Boolean(row.canHireAgents),
          isLeadership,
          hasBootstrapPrompt,
          supportsSkillInjection: providerSupportsSkillInjection(row.providerType),
          issues
        };
      })
    );
  });

  router.get("/runtime-default-cwd", async (req, res) => {
    let runtimeCwd: string;
    try {
      runtimeCwd = await resolveDefaultRuntimeCwdForCompany(ctx.db, req.companyId!);
      runtimeCwd = assertRuntimeCwdForCompany(req.companyId!, runtimeCwd, "runtimeCwd");
    } catch (error) {
      return sendError(res, String(error), 422);
    }
    await mkdir(runtimeCwd, { recursive: true });
    return sendOk(res, { runtimeCwd });
  });

  router.get("/adapter-metadata", async (_req, res) => {
    return sendOk(res, { adapters: getAdapterMetadata() });
  });

  router.get("/adapter-models/:providerType", async (req, res) => {
    const providerType = req.params.providerType;
    if (!runtimePreflightSchema.shape.providerType.safeParse(providerType).success) {
      return sendError(res, `Unsupported provider type: ${providerType}`, 422);
    }
    const defaultRuntimeCwd = await resolveDefaultRuntimeCwdForCompany(ctx.db, req.companyId!);
    let runtimeConfig: ReturnType<typeof normalizeRuntimeConfig>;
    try {
      runtimeConfig = normalizeRuntimeConfig({
        runtimeConfig: req.body?.runtimeConfig,
        defaultRuntimeCwd
      });
      runtimeConfig = enforceRuntimeCwdPolicy(req.companyId!, runtimeConfig);
    } catch (error) {
      return sendError(res, String(error), 422);
    }
    const typedProviderType = providerType as
      | "claude_code"
      | "codex"
      | "cursor"
      | "opencode"
      | "gemini_cli"
      | "openai_api"
      | "anthropic_api"
      | "http"
      | "shell";
    const models = await getAdapterModels(typedProviderType, {
      command: runtimeConfig.runtimeCommand,
      args: runtimeConfig.runtimeArgs,
      cwd: runtimeConfig.runtimeCwd,
      env: runtimeConfig.runtimeEnv,
      model: runtimeConfig.runtimeModel,
      thinkingEffort: runtimeConfig.runtimeThinkingEffort,
      timeoutMs: runtimeConfig.runtimeTimeoutSec > 0 ? runtimeConfig.runtimeTimeoutSec * 1000 : undefined,
      interruptGraceSec: runtimeConfig.interruptGraceSec,
      runPolicy: runtimeConfig.runPolicy
    });
    return sendOk(res, { providerType: typedProviderType, models });
  });

  router.post("/runtime-preflight", async (req, res) => {
    const parsed = runtimePreflightSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(res, parsed.error.message, 422);
    }
    const defaultRuntimeCwd = await resolveDefaultRuntimeCwdForCompany(ctx.db, req.companyId!);
    let runtimeConfig: ReturnType<typeof normalizeRuntimeConfig>;
    try {
      runtimeConfig = normalizeRuntimeConfig({
        runtimeConfig: parsed.data.runtimeConfig,
        legacy: {
          runtimeCommand: parsed.data.runtimeCommand,
          runtimeArgs: parsed.data.runtimeArgs,
          runtimeCwd: parsed.data.runtimeCwd,
          runtimeTimeoutMs: parsed.data.runtimeTimeoutMs,
          runtimeModel: parsed.data.runtimeModel,
          runtimeThinkingEffort: parsed.data.runtimeThinkingEffort,
          bootstrapPrompt: parsed.data.bootstrapPrompt,
          runtimeTimeoutSec: parsed.data.runtimeTimeoutSec,
          interruptGraceSec: parsed.data.interruptGraceSec,
          runtimeEnv: parsed.data.runtimeEnv,
          runPolicy: parsed.data.runPolicy
        },
        defaultRuntimeCwd
      });
      runtimeConfig = enforceRuntimeCwdPolicy(req.companyId!, runtimeConfig);
    } catch (error) {
      return sendError(res, String(error), 422);
    }

    if (runtimeConfig.runtimeCwd) {
      await mkdir(runtimeConfig.runtimeCwd, { recursive: true });
    }

    const timeoutMs =
      runtimeConfig.runtimeTimeoutSec > 0 ? Math.min(runtimeConfig.runtimeTimeoutSec * 1000, 45_000) : undefined;
    const result = await runAdapterEnvironmentTest(parsed.data.providerType, {
      command: runtimeConfig.runtimeCommand,
      args: runtimeConfig.runtimeArgs,
      cwd: runtimeConfig.runtimeCwd,
      env: runtimeConfig.runtimeEnv,
      model: runtimeConfig.runtimeModel,
      thinkingEffort: runtimeConfig.runtimeThinkingEffort,
      runPolicy: runtimeConfig.runPolicy,
      timeoutMs,
      interruptGraceSec: runtimeConfig.interruptGraceSec,
      retryCount: 0
    });
    return sendOk(res, {
      status: result.status,
      testedAt: result.testedAt,
      checks: result.checks
    });
  });

  router.post("/", async (req, res) => {
    const requireCreate = requirePermission("agents:write");
    requireCreate(req, res, () => {});
    if (res.headersSent) {
      return;
    }
    if (req.actor?.type === "agent") {
      const companyAgents = await listAgents(ctx.db, req.companyId!);
      const requestingAgent = companyAgents.find((row) => row.id === req.actor?.id);
      if (!requestingAgent) {
        return sendError(res, "Requesting agent not found.", 403);
      }
      if (!requestingAgent.canHireAgents) {
        return sendError(res, "This agent is not allowed to create new agents.", 403);
      }
    }
    const parsed = createAgentSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(res, parsed.error.message, 422);
    }
    const defaultRuntimeCwd = await resolveDefaultRuntimeCwdForCompany(ctx.db, req.companyId!);
    let runtimeConfig: ReturnType<typeof normalizeRuntimeConfig>;
    try {
      runtimeConfig = normalizeRuntimeConfig({
        runtimeConfig: parsed.data.runtimeConfig,
        legacy: {
          runtimeCommand: parsed.data.runtimeCommand,
          runtimeArgs: parsed.data.runtimeArgs,
          runtimeCwd: parsed.data.runtimeCwd,
          runtimeTimeoutMs: parsed.data.runtimeTimeoutMs,
          runtimeModel: parsed.data.runtimeModel,
          runtimeThinkingEffort: parsed.data.runtimeThinkingEffort,
          bootstrapPrompt: parsed.data.bootstrapPrompt,
          runtimeTimeoutSec: parsed.data.runtimeTimeoutSec,
          interruptGraceSec: parsed.data.interruptGraceSec,
          runtimeEnv: parsed.data.runtimeEnv,
          runPolicy: parsed.data.runPolicy
        },
        defaultRuntimeCwd
      });
      runtimeConfig = enforceRuntimeCwdPolicy(req.companyId!, runtimeConfig);
    } catch (error) {
      return sendError(res, String(error), 422);
    }
    runtimeConfig.runtimeModel = await resolveOpencodeRuntimeModel(parsed.data.providerType, runtimeConfig);
    runtimeConfig.runtimeModel = resolveRuntimeModelForProvider(parsed.data.providerType, runtimeConfig.runtimeModel);
    if (!ensureNamedRuntimeModel(parsed.data.providerType, runtimeConfig.runtimeModel)) {
      return sendError(res, "A named runtime model is required for this provider.", 422);
    }
    if (requiresRuntimeCwd(parsed.data.providerType) && !hasText(runtimeConfig.runtimeCwd)) {
      return sendError(res, "Runtime working directory is required for this runtime provider.", 422);
    }
    if (requiresRuntimeCwd(parsed.data.providerType) && hasText(runtimeConfig.runtimeCwd)) {
      await mkdir(runtimeConfig.runtimeCwd!, { recursive: true });
    }

    const sourceIssueIds = normalizeSourceIssueIds(parsed.data.sourceIssueId, parsed.data.sourceIssueIds);
    const shouldRequestApproval = (parsed.data.requestApproval || req.actor?.type === "agent") && isApprovalRequired("hire_agent");
    if (shouldRequestApproval) {
      const duplicate = await findDuplicateHireRequest(ctx.db, req.companyId!, {
        role: parsed.data.role,
        managerAgentId: parsed.data.managerAgentId ?? null
      });
      if (duplicate) {
        return sendOk(res, {
          queuedForApproval: false,
          duplicate: true,
          existingAgentId: duplicate.existingAgentId ?? null,
          pendingApprovalId: duplicate.pendingApprovalId ?? null,
          message: duplicateMessage(duplicate)
        });
      }
      const approvalId = await createApprovalRequest(ctx.db, {
        companyId: req.companyId!,
        requestedByAgentId: req.actor?.type === "agent" ? req.actor.id : null,
        action: "hire_agent",
        payload: {
          ...parsed.data,
          runtimeConfig,
          sourceIssueIds
        }
      });
      const approval = await getApprovalRequest(ctx.db, req.companyId!, approvalId);
      if (approval) {
        ctx.realtimeHub?.publish(
          createGovernanceRealtimeEvent(req.companyId!, {
            type: "approval.created",
            approval: serializeStoredApproval(approval)
          })
        );
        await publishOfficeOccupantForApproval(ctx.db, ctx.realtimeHub, req.companyId!, approvalId);
      }
      return sendOk(res, { queuedForApproval: true, approvalId });
    }

    const agent = await createAgent(ctx.db, {
      companyId: req.companyId!,
      managerAgentId: parsed.data.managerAgentId,
      role: parsed.data.role,
      name: parsed.data.name,
      providerType: parsed.data.providerType,
      heartbeatCron: parsed.data.heartbeatCron,
      monthlyBudgetUsd: parsed.data.monthlyBudgetUsd.toFixed(4),
      canHireAgents: parsed.data.canHireAgents,
      ...runtimeConfigToDb(runtimeConfig),
      initialState: runtimeConfigToStateBlobPatch(runtimeConfig)
    });
    const auditActor = resolveAuditActor(req.actor);
    await appendAuditEvent(ctx.db, {
      companyId: req.companyId!,
      actorType: auditActor.actorType,
      actorId: auditActor.actorId,
      eventType: "agent.hired",
      entityType: "agent",
      entityId: agent.id,
      payload: {
        ...agent,
        sourceIssueIds
      }
    });
    await publishOfficeOccupantForAgent(ctx.db, ctx.realtimeHub, req.companyId!, agent.id);
    return sendOk(res, toAgentResponse(agent as unknown as Record<string, unknown>));
  });

  router.put("/:agentId", async (req, res) => {
    const requireUpdate = requirePermission("agents:write");
    requireUpdate(req, res, () => {});
    if (res.headersSent) {
      return;
    }
    const unsupportedKeys = listUnsupportedAgentUpdateKeys(req.body);
    if (unsupportedKeys.length > 0) {
      return sendError(
        res,
        `Unsupported agent update fields: ${unsupportedKeys.join(", ")}. Supported fields: ${Array.from(UPDATE_AGENT_ALLOWED_KEYS).join(", ")}.`,
        422
      );
    }

    const parsed = updateAgentSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(res, parsed.error.message, 422);
    }

    const existingAgent = (await listAgents(ctx.db, req.companyId!)).find((row) => row.id === req.params.agentId);
    if (!existingAgent) {
      return sendError(res, "Agent not found.", 404);
    }
    if (req.actor?.type === "agent") {
      if (req.actor.id !== req.params.agentId) {
        return sendError(res, "Agents can only update their own record.", 403);
      }
      const forbiddenFieldUpdates: string[] = [];
      if (parsed.data.canHireAgents !== undefined) {
        forbiddenFieldUpdates.push("canHireAgents");
      }
      if (parsed.data.status !== undefined) {
        forbiddenFieldUpdates.push("status");
      }
      if (parsed.data.monthlyBudgetUsd !== undefined) {
        forbiddenFieldUpdates.push("monthlyBudgetUsd");
      }
      if (parsed.data.providerType !== undefined) {
        forbiddenFieldUpdates.push("providerType");
      }
      if (parsed.data.managerAgentId !== undefined) {
        forbiddenFieldUpdates.push("managerAgentId");
      }
      if (forbiddenFieldUpdates.length > 0) {
        return sendError(
          res,
          `Agents cannot update restricted fields: ${forbiddenFieldUpdates.join(", ")}.`,
          403
        );
      }
    }
    const defaultRuntimeCwd = await resolveDefaultRuntimeCwdForCompany(ctx.db, req.companyId!);
    const existingRuntime = parseRuntimeConfigFromAgentRow(existingAgent as unknown as Record<string, unknown>);
    const effectiveProviderType = parsed.data.providerType ?? existingAgent.providerType;
    const hasRuntimeInput =
      parsed.data.runtimeConfig !== undefined ||
      parsed.data.runtimeCommand !== undefined ||
      parsed.data.runtimeArgs !== undefined ||
      parsed.data.runtimeCwd !== undefined ||
      parsed.data.runtimeTimeoutMs !== undefined ||
      parsed.data.runtimeModel !== undefined ||
      parsed.data.runtimeThinkingEffort !== undefined ||
      parsed.data.bootstrapPrompt !== undefined ||
      parsed.data.runtimeTimeoutSec !== undefined ||
      parsed.data.interruptGraceSec !== undefined ||
      parsed.data.runtimeEnv !== undefined ||
      parsed.data.runPolicy !== undefined;
    try {
      let nextRuntime = {
        ...existingRuntime,
        ...(hasRuntimeInput
          ? normalizeRuntimeConfig({
              runtimeConfig: {
                ...existingRuntime,
                ...(parsed.data.runtimeConfig ?? {})
              },
              legacy: {
                runtimeCommand: parsed.data.runtimeCommand,
                runtimeArgs: parsed.data.runtimeArgs,
                runtimeCwd: parsed.data.runtimeCwd,
                runtimeTimeoutMs: parsed.data.runtimeTimeoutMs,
                runtimeModel: parsed.data.runtimeModel,
                runtimeThinkingEffort: parsed.data.runtimeThinkingEffort,
                bootstrapPrompt: parsed.data.bootstrapPrompt,
                runtimeTimeoutSec: parsed.data.runtimeTimeoutSec ?? existingRuntime.runtimeTimeoutSec,
                interruptGraceSec: parsed.data.interruptGraceSec,
                runtimeEnv: parsed.data.runtimeEnv,
                runPolicy: parsed.data.runPolicy
              }
            })
          : {})
      };
      nextRuntime = enforceRuntimeCwdPolicy(req.companyId!, nextRuntime);
      nextRuntime.runtimeModel = await resolveOpencodeRuntimeModel(effectiveProviderType, nextRuntime);
      nextRuntime.runtimeModel = resolveRuntimeModelForProvider(effectiveProviderType, nextRuntime.runtimeModel);
      if (!ensureNamedRuntimeModel(effectiveProviderType, nextRuntime.runtimeModel)) {
        return sendError(res, "A named runtime model is required for this provider.", 422);
      }
      if (!nextRuntime.runtimeCwd && defaultRuntimeCwd) {
        nextRuntime.runtimeCwd = assertRuntimeCwdForCompany(req.companyId!, defaultRuntimeCwd, "runtimeCwd");
      }
      const effectiveRuntimeCwd = nextRuntime.runtimeCwd ?? "";
      if (requiresRuntimeCwd(effectiveProviderType) && !hasText(effectiveRuntimeCwd)) {
        return sendError(res, "Runtime working directory is required for this runtime provider.", 422);
      }
      if (requiresRuntimeCwd(effectiveProviderType) && hasText(effectiveRuntimeCwd)) {
        await mkdir(effectiveRuntimeCwd, { recursive: true });
      }
      const agent = await updateAgent(ctx.db, {
        companyId: req.companyId!,
        id: req.params.agentId,
        managerAgentId: parsed.data.managerAgentId,
        role: parsed.data.role,
        name: parsed.data.name,
        providerType: parsed.data.providerType,
        status: parsed.data.status,
        heartbeatCron: parsed.data.heartbeatCron,
        monthlyBudgetUsd:
          typeof parsed.data.monthlyBudgetUsd === "number" ? parsed.data.monthlyBudgetUsd.toFixed(4) : undefined,
        canHireAgents: parsed.data.canHireAgents,
        ...runtimeConfigToDb(nextRuntime),
        stateBlob: runtimeConfigToStateBlobPatch(nextRuntime)
      });
      if (!agent) {
        return sendError(res, "Agent not found.", 404);
      }

      const auditActor = resolveAuditActor(req.actor);
      await appendAuditEvent(ctx.db, {
        companyId: req.companyId!,
        actorType: auditActor.actorType,
        actorId: auditActor.actorId,
        eventType: "agent.updated",
        entityType: "agent",
        entityId: agent.id,
        payload: agent
      });
      await publishOfficeOccupantForAgent(ctx.db, ctx.realtimeHub, req.companyId!, agent.id);
      return sendOk(res, toAgentResponse(agent as unknown as Record<string, unknown>));
    } catch (error) {
      return sendError(res, String(error), 422);
    }
  });

  router.delete("/:agentId", async (req, res) => {
    requireBoardRole(req, res, () => {});
    if (res.headersSent) {
      return;
    }
    const deleted = await deleteAgent(ctx.db, req.companyId!, req.params.agentId);
    if (!deleted) {
      return sendError(res, "Agent not found.", 404);
    }

    const auditActor = resolveAuditActor(req.actor);
    await appendAuditEvent(ctx.db, {
      companyId: req.companyId!,
      actorType: auditActor.actorType,
      actorId: auditActor.actorId,
      eventType: "agent.deleted",
      entityType: "agent",
      entityId: req.params.agentId,
      payload: { id: req.params.agentId }
    });
    await publishOfficeOccupantForAgent(ctx.db, ctx.realtimeHub, req.companyId!, req.params.agentId);
    return sendOk(res, { deleted: true });
  });

  router.post("/:agentId/pause", async (req, res) => {
    requirePermission("agents:lifecycle")(req, res, () => {});
    if (res.headersSent) {
      return;
    }
    const agent = await updateAgent(ctx.db, {
      companyId: req.companyId!,
      id: req.params.agentId,
      status: "paused"
    });
    if (!agent) {
      return sendError(res, "Agent not found.", 404);
    }
    const auditActor = resolveAuditActor(req.actor);
    await appendAuditEvent(ctx.db, {
      companyId: req.companyId!,
      actorType: auditActor.actorType,
      actorId: auditActor.actorId,
      eventType: "agent.paused",
      entityType: "agent",
      entityId: agent.id,
      payload: { id: agent.id, status: agent.status }
    });
    await publishOfficeOccupantForAgent(ctx.db, ctx.realtimeHub, req.companyId!, agent.id);
    return sendOk(res, toAgentResponse(agent as unknown as Record<string, unknown>));
  });

  router.post("/:agentId/resume", async (req, res) => {
    requirePermission("agents:lifecycle")(req, res, () => {});
    if (res.headersSent) {
      return;
    }
    const agent = await updateAgent(ctx.db, {
      companyId: req.companyId!,
      id: req.params.agentId,
      status: "idle"
    });
    if (!agent) {
      return sendError(res, "Agent not found.", 404);
    }
    const auditActor = resolveAuditActor(req.actor);
    await appendAuditEvent(ctx.db, {
      companyId: req.companyId!,
      actorType: auditActor.actorType,
      actorId: auditActor.actorId,
      eventType: "agent.resumed",
      entityType: "agent",
      entityId: agent.id,
      payload: { id: agent.id, status: agent.status }
    });
    await publishOfficeOccupantForAgent(ctx.db, ctx.realtimeHub, req.companyId!, agent.id);
    return sendOk(res, toAgentResponse(agent as unknown as Record<string, unknown>));
  });

  router.post("/:agentId/terminate", async (req, res) => {
    requireBoardRole(req, res, () => {});
    if (res.headersSent) {
      return;
    }
    const agent = await updateAgent(ctx.db, {
      companyId: req.companyId!,
      id: req.params.agentId,
      status: "terminated"
    });
    if (!agent) {
      return sendError(res, "Agent not found.", 404);
    }
    const auditActor = resolveAuditActor(req.actor);
    await appendAuditEvent(ctx.db, {
      companyId: req.companyId!,
      actorType: auditActor.actorType,
      actorId: auditActor.actorId,
      eventType: "agent.terminated",
      entityType: "agent",
      entityId: agent.id,
      payload: { id: agent.id, status: agent.status }
    });
    await publishOfficeOccupantForAgent(ctx.db, ctx.realtimeHub, req.companyId!, agent.id);
    return sendOk(res, toAgentResponse(agent as unknown as Record<string, unknown>));
  });

  return router;
}

function listUnsupportedAgentUpdateKeys(payload: unknown) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return [] as string[];
  }
  const body = payload as Record<string, unknown>;
  const unsupported = Object.keys(body)
    .filter((key) => !UPDATE_AGENT_ALLOWED_KEYS.has(key))
    .sort();
  const runtimeConfig = body.runtimeConfig;
  if (runtimeConfig && typeof runtimeConfig === "object" && !Array.isArray(runtimeConfig)) {
    for (const key of Object.keys(runtimeConfig as Record<string, unknown>).sort()) {
      if (!UPDATE_RUNTIME_CONFIG_ALLOWED_KEYS.has(key)) {
        unsupported.push(`runtimeConfig.${key}`);
      }
    }
  }
  return unsupported;
}

function enforceRuntimeCwdPolicy(companyId: string, runtime: ReturnType<typeof normalizeRuntimeConfig>) {
  if (!runtime.runtimeCwd) {
    return runtime;
  }
  return {
    ...runtime,
    runtimeCwd: assertRuntimeCwdForCompany(companyId, runtime.runtimeCwd, "runtimeCwd")
  };
}

async function findDuplicateHireRequest(
  db: AppContext["db"],
  companyId: string,
  input: { role: string; managerAgentId: string | null }
) {
  const role = input.role.trim();
  const managerAgentId = input.managerAgentId ?? null;
  const agents = await listAgents(db, companyId);
  const existingAgent = agents.find(
    (agent) =>
      agent.role === role &&
      (agent.managerAgentId ?? null) === managerAgentId &&
      agent.status !== "terminated"
  );
  const approvals = await listApprovalRequests(db, companyId);
  const pendingApproval = approvals.find((approval) => {
    if (approval.status !== "pending" || approval.action !== "hire_agent") {
      return false;
    }
    const payload = parseApprovalPayload(approval.payloadJson);
    return payload.role === role && (payload.managerAgentId ?? null) === managerAgentId;
  });
  if (!existingAgent && !pendingApproval) {
    return null;
  }
  return {
    existingAgentId: existingAgent?.id ?? null,
    pendingApprovalId: pendingApproval?.id ?? null
  };
}

function parseApprovalPayload(payloadJson: string): { role?: string; managerAgentId?: string | null } {
  try {
    const parsed = JSON.parse(payloadJson) as Record<string, unknown>;
    return {
      role: typeof parsed.role === "string" ? parsed.role : undefined,
      managerAgentId: typeof parsed.managerAgentId === "string" ? parsed.managerAgentId : null
    };
  } catch {
    return {};
  }
}

function duplicateMessage(input: { existingAgentId: string | null; pendingApprovalId: string | null }) {
  if (input.existingAgentId && input.pendingApprovalId) {
    return `Duplicate hire request blocked: existing agent ${input.existingAgentId} and pending approval ${input.pendingApprovalId}.`;
  }
  if (input.existingAgentId) {
    return `Duplicate hire request blocked: existing agent ${input.existingAgentId}.`;
  }
  return `Duplicate hire request blocked: pending approval ${input.pendingApprovalId}.`;
}

function normalizeSourceIssueIds(sourceIssueId: string | undefined, sourceIssueIds: string[] | undefined) {
  const merged = new Set<string>();
  for (const value of [sourceIssueId, ...(sourceIssueIds ?? [])]) {
    const normalized = value?.trim();
    if (normalized) {
      merged.add(normalized);
    }
  }
  return Array.from(merged);
}

function providerSupportsSkillInjection(providerType: string) {
  return providerType === "codex" || providerType === "cursor" || providerType === "opencode" || providerType === "claude_code";
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
