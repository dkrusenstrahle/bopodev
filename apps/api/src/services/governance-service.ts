import { mkdir } from "node:fs/promises";
import { z } from "zod";
import {
  AGENT_ROLE_LABELS,
  AgentCreateRequestSchema,
  AgentRoleKeySchema,
  PluginInstallSourceTypeSchema,
  PluginManifestV2Schema,
  TemplateManifestDefault,
  TemplateManifestSchema
} from "bopodev-contracts";
import type { BopoDb } from "bopodev-db";
import {
  and,
  approvalRequests,
  agents,
  appendAuditEvent,
  appendPluginInstall,
  createAgent,
  createGoal,
  createIssue,
  createProject,
  createProjectWorkspace,
  getCurrentTemplateVersion,
  getTemplate,
  goals,
  listAgents,
  listIssues,
  listProjectWorkspaces,
  listProjects,
  projects,
  eq,
  updateProjectWorkspace,
  markPluginInstallsSuperseded,
  updatePluginConfig
} from "bopodev-db";
import {
  normalizeRuntimeConfig,
  resolveRuntimeModelForProvider,
  requiresRuntimeCwd,
  runtimeConfigToDb,
  runtimeConfigToStateBlobPatch
} from "../lib/agent-config";
import { resolveOpencodeRuntimeModel } from "../lib/opencode-model";
import {
  normalizeCompanyWorkspacePath,
  resolveProjectWorkspacePath
} from "../lib/instance-paths";
import { assertRuntimeCwdForCompany, hasText, resolveDefaultRuntimeCwdForCompany } from "../lib/workspace-policy";
import { appendDurableFact } from "./memory-file-service";
import { writePackagedPluginManifestToFilesystem } from "./plugin-manifest-loader";
import { registerPluginManifest } from "./plugin-runtime";
import { applyTemplateManifest } from "./template-apply-service";

const approvalGatedActions = new Set([
  "hire_agent",
  "activate_goal",
  "override_budget",
  "pause_agent",
  "terminate_agent",
  "promote_memory_fact",
  "grant_plugin_capabilities",
  "apply_template"
]);

const hireAgentPayloadSchema = AgentCreateRequestSchema.extend({
  sourceIssueId: z.string().min(1).optional(),
  sourceIssueIds: z.array(z.string().min(1)).default([]),
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
    .optional(),
  enabledSkillIds: z.array(z.string().min(1)).max(64).nullable().optional()
});

const activateGoalPayloadSchema = z.object({
  projectId: z.string().optional(),
  parentGoalId: z.string().optional(),
  ownerAgentId: z.string().optional(),
  level: z.enum(["company", "project", "agent"]),
  title: z.string().min(1),
  description: z.string().optional()
});
const promoteMemoryFactPayloadSchema = z.object({
  agentId: z.string().min(1),
  fact: z.string().min(1),
  sourceRunId: z.string().optional()
});
const grantPluginCapabilitiesPayloadSchema = z.object({
  pluginId: z.string().min(1),
  enabled: z.boolean().optional(),
  priority: z.number().int().min(0).max(1000).optional(),
  grantedCapabilities: z.array(z.string().min(1)).default([]),
  capabilityNamespaces: z.array(z.string().min(1)).default([]),
  config: z.record(z.string(), z.unknown()).default({}),
  sourceType: PluginInstallSourceTypeSchema.optional(),
  sourceRef: z.string().optional(),
  integrity: z.string().optional(),
  buildHash: z.string().optional(),
  manifestJson: z.string().optional(),
  install: z.boolean().default(true)
});
const applyTemplatePayloadSchema = z.object({
  templateId: z.string().min(1),
  templateVersion: z.string().min(1),
  variables: z.record(z.string(), z.unknown()).default({})
});
const overrideBudgetPayloadSchema = z
  .object({
    agentId: z.string().min(1).optional(),
    projectId: z.string().min(1).optional(),
    reason: z.string().optional(),
    additionalBudgetUsd: z.number().positive().optional(),
    revisedMonthlyBudgetUsd: z.number().positive().optional()
  })
  .refine(
    (value) => Boolean(value.agentId) || Boolean(value.projectId),
    "Budget override payload requires agentId or projectId."
  )
  .refine(
    (value) => !(value.agentId && value.projectId),
    "Budget override payload must target either agentId or projectId, not both."
  )
  .refine(
    (value) =>
      (typeof value.additionalBudgetUsd === "number" && value.additionalBudgetUsd > 0) ||
      (typeof value.revisedMonthlyBudgetUsd === "number" && value.revisedMonthlyBudgetUsd > 0),
    "Budget override payload requires additionalBudgetUsd or revisedMonthlyBudgetUsd."
  );
const pauseOrTerminateAgentPayloadSchema = z.object({
  agentId: z.string().min(1),
  reason: z.string().optional()
});
const AGENT_STARTUP_PROJECT_NAME = "Agent Onboarding";
const AGENT_STARTUP_TASK_MARKER = "[bopodev:onboarding:agent-startup:v1]";

export class GovernanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GovernanceError";
  }
}

export function isApprovalRequired(action: string) {
  return approvalGatedActions.has(action);
}

export async function resolveApproval(
  db: BopoDb,
  companyId: string,
  approvalId: string,
  status: "approved" | "rejected" | "overridden"
) {
  return db.transaction(async (tx) => {
    const [approval] = await tx
      .select()
      .from(approvalRequests)
      .where(and(eq(approvalRequests.companyId, companyId), eq(approvalRequests.id, approvalId)))
      .limit(1);

    if (!approval) {
      throw new GovernanceError("Approval request not found.");
    }
    if (approval.status !== "pending") {
      if (approval.status === status) {
        // Idempotent retry: requested state already applied.
        return {
          approvalId,
          action: approval.action,
          status: approval.status,
          execution: { applied: false }
        };
      }
      throw new GovernanceError("Approval request has already been resolved.");
    }

    let execution:
      | {
          applied: boolean;
          entityType?: "agent" | "goal" | "project" | "memory" | "template";
          entityId?: string;
          entity?: Record<string, unknown>;
        }
      | undefined;

    if (status === "approved") {
      execution = await applyApprovalAction(tx as unknown as BopoDb, companyId, approval.action, approval.payloadJson);
    }

    const [updated] = await tx
      .update(approvalRequests)
      .set({ status, resolvedAt: new Date() })
      .where(
        and(
          eq(approvalRequests.companyId, companyId),
          eq(approvalRequests.id, approvalId),
          eq(approvalRequests.status, "pending")
        )
      )
      .returning({ id: approvalRequests.id });

    if (!updated) {
      const [latest] = await tx
        .select()
        .from(approvalRequests)
        .where(and(eq(approvalRequests.companyId, companyId), eq(approvalRequests.id, approvalId)))
        .limit(1);
      if (latest && latest.status === status) {
        return {
          approvalId,
          action: approval.action,
          status: latest.status,
          execution: { applied: false }
        };
      }
      throw new GovernanceError("Approval request could not be resolved due to a concurrent update.");
    }

    return {
      approvalId,
      action: approval.action,
      status,
      execution: execution ?? { applied: false }
    };
  });
}

async function applyApprovalAction(db: BopoDb, companyId: string, action: string, payloadJson: string) {
  const payload = parsePayload(payloadJson);

  if (action === "hire_agent") {
    const parsed = hireAgentPayloadSchema.safeParse(payload);
    if (!parsed.success) {
      throw new GovernanceError("Approval payload for agent hiring is invalid.");
    }
    const sourceIssueIds = Array.from(
      new Set(
        [parsed.data.sourceIssueId, ...(parsed.data.sourceIssueIds ?? [])]
          .map((entry) => entry?.trim())
          .filter((entry): entry is string => Boolean(entry))
      )
    );
    const defaultRuntimeCwd = await resolveDefaultRuntimeCwdForCompany(db, companyId);
    let runtimeConfig = normalizeRuntimeConfig({
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
        runPolicy: parsed.data.runPolicy,
        enabledSkillIds: parsed.data.enabledSkillIds
      },
      defaultRuntimeCwd
    });
    const rc = parsed.data.runtimeConfig;
    const hasEnabledSkillIdsKey =
      rc !== undefined && rc !== null && typeof rc === "object" && "enabledSkillIds" in rc;
    if (!hasEnabledSkillIdsKey && parsed.data.enabledSkillIds === undefined) {
      runtimeConfig = { ...runtimeConfig, enabledSkillIds: [] };
    }
    if (runtimeConfig.runtimeCwd) {
      try {
        runtimeConfig.runtimeCwd = assertRuntimeCwdForCompany(companyId, runtimeConfig.runtimeCwd, "runtimeCwd");
      } catch (error) {
        throw new GovernanceError(String(error));
      }
    }
    runtimeConfig.runtimeModel = await resolveOpencodeRuntimeModel(parsed.data.providerType, runtimeConfig);
    runtimeConfig.runtimeModel = resolveRuntimeModelForProvider(parsed.data.providerType, runtimeConfig.runtimeModel);
    if (providerRequiresNamedModel(parsed.data.providerType) && !hasText(runtimeConfig.runtimeModel)) {
      throw new GovernanceError("Approval payload for agent hiring must include a named runtime model.");
    }
    if (requiresRuntimeCwd(parsed.data.providerType) && !hasText(runtimeConfig.runtimeCwd)) {
      throw new GovernanceError("Approval payload for agent hiring is missing runtime working directory.");
    }
    if (requiresRuntimeCwd(parsed.data.providerType) && hasText(runtimeConfig.runtimeCwd)) {
      await mkdir(runtimeConfig.runtimeCwd!, { recursive: true });
    }
    const existingAgents = await listAgents(db, companyId);
    const duplicate = existingAgents.find(
      (agent) =>
        ((parsed.data.roleKey && agent.roleKey === parsed.data.roleKey) ||
          (!parsed.data.roleKey && parsed.data.role && agent.role === parsed.data.role)) &&
        (agent.managerAgentId ?? null) === (parsed.data.managerAgentId ?? null) &&
        agent.status !== "terminated"
    );
    if (duplicate) {
      return {
        applied: false,
        entityType: "agent" as const,
        entityId: duplicate.id,
        entity: duplicate as unknown as Record<string, unknown>
      };
    }

    const agent = await createAgent(db, {
      companyId,
      managerAgentId: parsed.data.managerAgentId,
      role: resolveAgentRoleText(parsed.data.role, parsed.data.roleKey, parsed.data.title),
      roleKey: normalizeRoleKey(parsed.data.roleKey),
      title: normalizeTitle(parsed.data.title),
      capabilities: normalizeCapabilities(parsed.data.capabilities),
      name: parsed.data.name,
      providerType: parsed.data.providerType,
      heartbeatCron: parsed.data.heartbeatCron,
      monthlyBudgetUsd: parsed.data.monthlyBudgetUsd.toFixed(4),
      canHireAgents: parsed.data.canHireAgents,
      canAssignAgents: parsed.data.canAssignAgents,
      canCreateIssues: parsed.data.canCreateIssues,
      ...runtimeConfigToDb(runtimeConfig),
      initialState: runtimeConfigToStateBlobPatch(runtimeConfig)
    });
    const startupProjectId = await ensureAgentStartupProject(db, companyId);
    await ensureAgentStartupIssue(
      db,
      companyId,
      startupProjectId,
      agent.id,
      resolveAgentDisplayTitle(agent.title, agent.roleKey, agent.role)
    );

    return {
      applied: true,
      entityType: "agent" as const,
      entityId: agent.id,
      entity: {
        ...(agent as Record<string, unknown>),
        sourceIssueIds,
        delegationIntent: parsed.data.delegationIntent ?? null
      }
    };
  }

  if (action === "activate_goal") {
    const parsed = activateGoalPayloadSchema.safeParse(payload);
    if (!parsed.success) {
      throw new GovernanceError("Approval payload for goal activation is invalid.");
    }

    if (parsed.data.parentGoalId) {
      const [parentGoal] = await db
        .select({ id: goals.id })
        .from(goals)
        .where(and(eq(goals.companyId, companyId), eq(goals.id, parsed.data.parentGoalId)))
        .limit(1);

      if (!parentGoal) {
        throw new GovernanceError("Parent goal not found for activation request.");
      }
    }

    if (parsed.data.projectId) {
      const [project] = await db
        .select({ id: projects.id })
        .from(projects)
        .where(and(eq(projects.companyId, companyId), eq(projects.id, parsed.data.projectId)))
        .limit(1);

      if (!project) {
        throw new GovernanceError("Project not found for activation request.");
      }
    }

    const goal = await createGoal(db, {
      companyId,
      projectId: parsed.data.projectId,
      parentGoalId: parsed.data.parentGoalId,
      ownerAgentId: parsed.data.ownerAgentId,
      level: parsed.data.level,
      title: parsed.data.title,
      description: parsed.data.description
    });

    await db
      .update(goals)
      .set({ status: "active", updatedAt: new Date() })
      .where(and(eq(goals.companyId, companyId), eq(goals.id, goal.id)));

    return {
      applied: true,
      entityType: "goal" as const,
      entityId: goal.id,
      entity: { ...goal, status: "active" }
    };
  }

  if (action === "override_budget") {
    const parsed = overrideBudgetPayloadSchema.safeParse(payload);
    if (!parsed.success) {
      throw new GovernanceError("Approval payload for budget override is invalid.");
    }
    if (parsed.data.agentId) {
      const [agent] = await db
        .select({
          id: agents.id,
          monthlyBudgetUsd: agents.monthlyBudgetUsd,
          usedBudgetUsd: agents.usedBudgetUsd
        })
        .from(agents)
        .where(and(eq(agents.companyId, companyId), eq(agents.id, parsed.data.agentId)))
        .limit(1);
      if (!agent) {
        throw new GovernanceError("Agent not found for budget override request.");
      }
      const currentMonthlyBudget = Number(agent.monthlyBudgetUsd);
      const currentUsedBudget = Number(agent.usedBudgetUsd);
      const nextMonthlyBudget =
        typeof parsed.data.revisedMonthlyBudgetUsd === "number"
          ? parsed.data.revisedMonthlyBudgetUsd
          : currentMonthlyBudget + (parsed.data.additionalBudgetUsd ?? 0);
      if (!Number.isFinite(nextMonthlyBudget) || nextMonthlyBudget <= 0) {
        throw new GovernanceError("Budget override must resolve to a positive monthly budget.");
      }
      if (nextMonthlyBudget <= currentUsedBudget) {
        throw new GovernanceError("Budget override must exceed current used budget.");
      }
      await db
        .update(agents)
        .set({
          monthlyBudgetUsd: nextMonthlyBudget.toFixed(4),
          updatedAt: new Date()
        })
        .where(and(eq(agents.companyId, companyId), eq(agents.id, parsed.data.agentId)));
      return {
        applied: true,
        entityType: "agent" as const,
        entityId: parsed.data.agentId,
        entity: {
          agentId: parsed.data.agentId,
          previousMonthlyBudgetUsd: currentMonthlyBudget,
          monthlyBudgetUsd: nextMonthlyBudget,
          usedBudgetUsd: currentUsedBudget,
          reason: parsed.data.reason ?? null
        }
      };
    }
    const [project] = await db
      .select({
        id: projects.id,
        monthlyBudgetUsd: projects.monthlyBudgetUsd,
        usedBudgetUsd: projects.usedBudgetUsd
      })
      .from(projects)
      .where(and(eq(projects.companyId, companyId), eq(projects.id, parsed.data.projectId!)))
      .limit(1);
    if (!project) {
      throw new GovernanceError("Project not found for budget override request.");
    }
    const currentMonthlyBudget = Number(project.monthlyBudgetUsd);
    const currentUsedBudget = Number(project.usedBudgetUsd);
    const nextMonthlyBudget =
      typeof parsed.data.revisedMonthlyBudgetUsd === "number"
        ? parsed.data.revisedMonthlyBudgetUsd
        : currentMonthlyBudget + (parsed.data.additionalBudgetUsd ?? 0);
    if (!Number.isFinite(nextMonthlyBudget) || nextMonthlyBudget <= 0) {
      throw new GovernanceError("Budget override must resolve to a positive monthly budget.");
    }
    if (nextMonthlyBudget <= currentUsedBudget) {
      throw new GovernanceError("Budget override must exceed current used budget.");
    }
    await db
      .update(projects)
      .set({
        monthlyBudgetUsd: nextMonthlyBudget.toFixed(4),
        updatedAt: new Date()
      })
      .where(and(eq(projects.companyId, companyId), eq(projects.id, parsed.data.projectId!)));
    await appendAuditEvent(db, {
      companyId,
      actorType: "system",
      eventType: "project_budget.override_applied",
      entityType: "project",
      entityId: parsed.data.projectId!,
      payload: {
        previousMonthlyBudgetUsd: currentMonthlyBudget,
        monthlyBudgetUsd: nextMonthlyBudget,
        usedBudgetUsd: currentUsedBudget,
        reason: parsed.data.reason ?? null
      }
    });
    return {
      applied: true,
      entityType: "project" as const,
      entityId: parsed.data.projectId!,
      entity: {
        projectId: parsed.data.projectId!,
        previousMonthlyBudgetUsd: currentMonthlyBudget,
        monthlyBudgetUsd: nextMonthlyBudget,
        usedBudgetUsd: currentUsedBudget,
        reason: parsed.data.reason ?? null
      }
    };
  }

  if (action === "pause_agent" || action === "terminate_agent") {
    const parsed = pauseOrTerminateAgentPayloadSchema.safeParse(payload);
    if (!parsed.success) {
      throw new GovernanceError(`Approval payload for ${action} is invalid.`);
    }
    const nextStatus = action === "pause_agent" ? "paused" : "terminated";
    const [updated] = await db
      .update(agents)
      .set({
        status: nextStatus,
        updatedAt: new Date()
      })
      .where(and(eq(agents.companyId, companyId), eq(agents.id, parsed.data.agentId)))
      .returning({
        id: agents.id,
        status: agents.status
      });
    if (!updated) {
      throw new GovernanceError("Agent not found for lifecycle governance action.");
    }
    return {
      applied: true,
      entityType: "agent" as const,
      entityId: updated.id,
      entity: {
        id: updated.id,
        status: updated.status,
        reason: parsed.data.reason ?? null
      }
    };
  }

  if (action === "promote_memory_fact") {
    const parsed = promoteMemoryFactPayloadSchema.safeParse(payload);
    if (!parsed.success) {
      throw new GovernanceError("Approval payload for memory promotion is invalid.");
    }
    const targetFile = await appendDurableFact({
      companyId,
      agentId: parsed.data.agentId,
      fact: parsed.data.fact,
      sourceRunId: parsed.data.sourceRunId ?? null
    });
    return {
      applied: Boolean(targetFile),
      entityType: "memory" as const,
      entityId: parsed.data.agentId,
      entity: {
        agentId: parsed.data.agentId,
        sourceRunId: parsed.data.sourceRunId ?? null,
        fact: parsed.data.fact,
        targetFile
      }
    };
  }
  if (action === "grant_plugin_capabilities") {
    const parsed = grantPluginCapabilitiesPayloadSchema.safeParse(payload);
    if (!parsed.success) {
      throw new GovernanceError("Approval payload for plugin capability grant is invalid.");
    }
    if (parsed.data.manifestJson) {
      let rawManifest: unknown;
      try {
        rawManifest = JSON.parse(parsed.data.manifestJson);
      } catch {
        throw new GovernanceError("Plugin install manifest JSON is invalid.");
      }
      const manifestParsed = PluginManifestV2Schema.safeParse(rawManifest);
      if (!manifestParsed.success) {
        throw new GovernanceError("Plugin install manifest payload failed validation.");
      }
      await writePackagedPluginManifestToFilesystem(manifestParsed.data, {
        sourceType: parsed.data.sourceType ?? "registry",
        sourceRef: parsed.data.sourceRef,
        integrity: parsed.data.integrity,
        buildHash: parsed.data.buildHash
      });
      await registerPluginManifest(db, manifestParsed.data);
      await markPluginInstallsSuperseded(db, {
        companyId,
        pluginId: parsed.data.pluginId
      });
      await appendPluginInstall(db, {
        companyId,
        pluginId: parsed.data.pluginId,
        pluginVersion: manifestParsed.data.version,
        sourceType: parsed.data.sourceType ?? "registry",
        sourceRef: parsed.data.sourceRef ?? null,
        integrity: parsed.data.integrity ?? null,
        buildHash: parsed.data.buildHash ?? null,
        artifactPath: manifestParsed.data.install?.artifactPath ?? null,
        manifestJson: JSON.stringify(manifestParsed.data),
        status: "active"
      });
    }
    const configWithNamespaces = {
      ...parsed.data.config,
      _grantedCapabilityNamespaces: parsed.data.capabilityNamespaces
    };
    await updatePluginConfig(db, {
      companyId,
      pluginId: parsed.data.pluginId,
      enabled: parsed.data.enabled,
      priority: parsed.data.priority,
      grantedCapabilitiesJson: JSON.stringify(parsed.data.grantedCapabilities),
      configJson: JSON.stringify(configWithNamespaces)
    });
    return {
      applied: true,
      entityType: "template" as const,
      entityId: parsed.data.pluginId,
      entity: {
        pluginId: parsed.data.pluginId,
        enabled: parsed.data.enabled ?? null,
        priority: parsed.data.priority ?? null,
        grantedCapabilities: parsed.data.grantedCapabilities,
        capabilityNamespaces: parsed.data.capabilityNamespaces
      }
    };
  }
  if (action === "apply_template") {
    const parsed = applyTemplatePayloadSchema.safeParse(payload);
    if (!parsed.success) {
      throw new GovernanceError("Approval payload for template apply is invalid.");
    }
    const template = await getTemplate(db, companyId, parsed.data.templateId);
    if (!template) {
      throw new GovernanceError("Template not found for apply request.");
    }
    const version =
      (await getCurrentTemplateVersion(db, companyId, parsed.data.templateId)) ??
      null;
    if (!version) {
      throw new GovernanceError("Template version not found for apply request.");
    }
    const manifest = parsePayload(version.manifestJson);
    const parsedManifest = TemplateManifestSchema.safeParse(manifest);
    const normalizedManifest = parsedManifest.success
      ? parsedManifest.data
      : TemplateManifestSchema.parse(TemplateManifestDefault);
    const applied = await applyTemplateManifest(db, {
      companyId,
      templateId: template.id,
      templateVersion: version.version,
      templateVersionId: version.id,
      manifest: normalizedManifest,
      variables: parsed.data.variables
    });
    return {
      applied: applied.applied,
      entityType: "template" as const,
      entityId: template.id,
      entity: {
        id: template.id,
        installId: applied.installId ?? null,
        summary: applied.summary
      }
    };
  }

  throw new GovernanceError(`Unsupported approval action: ${action}`);
}

function providerRequiresNamedModel(providerType: string) {
  return providerType !== "http" && providerType !== "shell";
}

function parsePayload(payloadJson: string) {
  try {
    const parsed = JSON.parse(payloadJson) as unknown;
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

async function ensureAgentStartupProject(db: BopoDb, companyId: string) {
  const projects = await listProjects(db, companyId);
  const existing = projects.find((project) => project.name === AGENT_STARTUP_PROJECT_NAME);
  if (existing) {
    await ensureProjectPrimaryWorkspace(db, companyId, existing.id, AGENT_STARTUP_PROJECT_NAME);
    return existing.id;
  }
  const created = await createProject(db, {
    companyId,
    name: AGENT_STARTUP_PROJECT_NAME,
    description: "Operating baseline tasks for newly approved hires."
  });
  if (!created) {
    throw new Error("Failed to create startup project.");
  }
  await ensureProjectPrimaryWorkspace(db, companyId, created.id, AGENT_STARTUP_PROJECT_NAME);
  return created.id;
}

async function ensureProjectPrimaryWorkspace(db: BopoDb, companyId: string, projectId: string, projectName: string) {
  const existingWorkspaces = await listProjectWorkspaces(db, companyId, projectId);
  const existingPrimary = existingWorkspaces.find((workspace) => workspace.isPrimary);
  if (existingPrimary) {
    if (existingPrimary.cwd) {
      const normalized = normalizeCompanyWorkspacePath(companyId, existingPrimary.cwd);
      await mkdir(normalized, { recursive: true });
    }
    return existingPrimary;
  }
  const defaultWorkspaceCwd = resolveProjectWorkspacePath(companyId, projectId);
  await mkdir(defaultWorkspaceCwd, { recursive: true });
  const fallbackWorkspace = existingWorkspaces[0];
  if (fallbackWorkspace) {
    const normalizedCwd = fallbackWorkspace.cwd?.trim()
      ? normalizeCompanyWorkspacePath(companyId, fallbackWorkspace.cwd)
      : defaultWorkspaceCwd;
    if (normalizedCwd) {
      await mkdir(normalizedCwd, { recursive: true });
    }
    return updateProjectWorkspace(db, {
      companyId,
      projectId,
      id: fallbackWorkspace.id,
      cwd: normalizedCwd,
      isPrimary: true
    });
  }
  return createProjectWorkspace(db, {
    companyId,
    projectId,
    name: projectName,
    cwd: defaultWorkspaceCwd,
    isPrimary: true
  });
}

async function ensureAgentStartupIssue(
  db: BopoDb,
  companyId: string,
  projectId: string,
  agentId: string,
  roleTitle: string
) {
  const title = `Set up ${roleTitle} operating files`;
  const body = buildAgentStartupTaskBody(companyId, agentId);
  const existingIssues = await listIssues(db, companyId);
  const existing = existingIssues.find(
    (issue) =>
      issue.assigneeAgentId === agentId &&
      issue.title === title &&
      typeof issue.body === "string" &&
      issue.body.includes(AGENT_STARTUP_TASK_MARKER)
  );
  if (existing) {
    return existing.id;
  }
  const created = await createIssue(db, {
    companyId,
    projectId,
    title,
    body,
    status: "todo",
    priority: "high",
    assigneeAgentId: agentId,
    labels: ["onboarding", "agent-setup"],
    tags: ["agent-startup"]
  });
  return created.id;
}

function normalizeRoleKey(input: string | null | undefined) {
  const normalized = input?.trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  return AgentRoleKeySchema.safeParse(normalized).success ? normalized : null;
}

function normalizeTitle(input: string | null | undefined) {
  const normalized = input?.trim();
  return normalized ? normalized : null;
}

function normalizeCapabilities(input: string | null | undefined) {
  const normalized = input?.trim();
  return normalized ? normalized : null;
}

function resolveAgentRoleText(
  legacyRole: string | undefined,
  roleKeyInput: string | undefined,
  titleInput: string | null | undefined
) {
  const normalizedLegacy = legacyRole?.trim();
  if (normalizedLegacy) {
    return normalizedLegacy;
  }
  const normalizedTitle = normalizeTitle(titleInput);
  if (normalizedTitle) {
    return normalizedTitle;
  }
  const roleKey = normalizeRoleKey(roleKeyInput);
  if (roleKey) {
    return AGENT_ROLE_LABELS[roleKey as keyof typeof AGENT_ROLE_LABELS];
  }
  return AGENT_ROLE_LABELS.general;
}

function resolveAgentDisplayTitle(title: string | null | undefined, roleKeyInput: string | null | undefined, role: string) {
  const normalizedTitle = normalizeTitle(title);
  if (normalizedTitle) {
    return normalizedTitle;
  }
  const roleKey = normalizeRoleKey(roleKeyInput);
  if (roleKey) {
    return AGENT_ROLE_LABELS[roleKey as keyof typeof AGENT_ROLE_LABELS];
  }
  return role;
}

function buildAgentStartupTaskBody(companyId: string, agentId: string) {
  const companyScopedAgentRoot = `workspace/${companyId}/agents/${agentId}`;
  const agentOperatingFolder = `${companyScopedAgentRoot}/operating`;
  return [
    AGENT_STARTUP_TASK_MARKER,
    "",
    `Create your operating baseline before starting feature delivery work.`,
    "",
    `1. Create your operating folder at \`${agentOperatingFolder}/\`.`,
    "   During heartbeats, prefer the absolute path in `$BOPODEV_AGENT_OPERATING_DIR` (set by the runtime) so files land under your agent folder even when the shell cwd is a project workspace.",
    "2. Author these files with your own responsibilities and working style:",
    `   - \`${agentOperatingFolder}/AGENTS.md\``,
    `   - \`${agentOperatingFolder}/HEARTBEAT.md\``,
    `   - \`${agentOperatingFolder}/SOUL.md\``,
    `   - \`${agentOperatingFolder}/TOOLS.md\``,
    "3. Each heartbeat already includes your operating directory via `$BOPODEV_AGENT_OPERATING_DIR` and directs you to AGENTS.md and related files there when they exist.",
    "   You do not need to save file paths into `bootstrapPrompt` for operating docs—use `PUT /agents/:agentId` `bootstrapPrompt` only for optional extra standing instructions.",
    "4. Post an issue comment summarizing completed setup artifacts.",
    "",
    "Safety checks:",
    `- Keep operating files inside \`workspace/${companyId}/agents/${agentId}/\` only.`,
    "- Do not overwrite another agent's operating folder.",
    "- Keep content original to your role and scope."
  ].join("\n");
}

