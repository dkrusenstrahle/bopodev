import { and, eq } from "drizzle-orm";
import { mkdir } from "node:fs/promises";
import { z } from "zod";
import { AgentCreateRequestSchema, TemplateManifestDefault, TemplateManifestSchema } from "bopodev-contracts";
import type { BopoDb } from "bopodev-db";
import {
  approvalRequests,
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
  updateProjectWorkspace,
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
  resolveAgentFallbackWorkspacePath,
  resolveProjectWorkspacePath
} from "../lib/instance-paths";
import { assertRuntimeCwdForCompany, hasText, resolveDefaultRuntimeCwdForCompany } from "../lib/workspace-policy";
import { appendDurableFact } from "./memory-file-service";
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

const activateGoalPayloadSchema = z.object({
  projectId: z.string().optional(),
  parentGoalId: z.string().optional(),
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
  config: z.record(z.string(), z.unknown()).default({})
});
const applyTemplatePayloadSchema = z.object({
  templateId: z.string().min(1),
  templateVersion: z.string().min(1),
  variables: z.record(z.string(), z.unknown()).default({})
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
          entityType?: "agent" | "goal" | "memory" | "template";
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
    const defaultRuntimeCwd = await resolveDefaultRuntimeCwdForCompany(db, companyId);
    const runtimeConfig = normalizeRuntimeConfig({
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
        agent.role === parsed.data.role &&
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
      role: parsed.data.role,
      name: parsed.data.name,
      providerType: parsed.data.providerType,
      heartbeatCron: parsed.data.heartbeatCron,
      monthlyBudgetUsd: parsed.data.monthlyBudgetUsd.toFixed(4),
      canHireAgents: parsed.data.canHireAgents,
      ...runtimeConfigToDb(runtimeConfig),
      initialState: runtimeConfigToStateBlobPatch(runtimeConfig)
    });
    const startupProjectId = await ensureAgentStartupProject(db, companyId);
    await ensureAgentStartupIssue(db, companyId, startupProjectId, agent.id, agent.role);

    return {
      applied: true,
      entityType: "agent" as const,
      entityId: agent.id,
      entity: agent as Record<string, unknown>
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

  if (action === "pause_agent" || action === "terminate_agent" || action === "override_budget") {
    return { applied: false };
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
    await updatePluginConfig(db, {
      companyId,
      pluginId: parsed.data.pluginId,
      enabled: parsed.data.enabled,
      priority: parsed.data.priority,
      grantedCapabilitiesJson: JSON.stringify(parsed.data.grantedCapabilities),
      configJson: JSON.stringify(parsed.data.config)
    });
    return {
      applied: true,
      entityType: "template" as const,
      entityId: parsed.data.pluginId,
      entity: {
        pluginId: parsed.data.pluginId,
        enabled: parsed.data.enabled ?? null,
        priority: parsed.data.priority ?? null,
        grantedCapabilities: parsed.data.grantedCapabilities
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
  role: string
) {
  const title = `Set up ${role} operating files`;
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

function buildAgentStartupTaskBody(companyId: string, agentId: string) {
  const agentWorkspaceRoot = resolveAgentFallbackWorkspacePath(companyId, agentId);
  const agentOperatingFolder = `${agentWorkspaceRoot}/operating`;
  return [
    AGENT_STARTUP_TASK_MARKER,
    "",
    `Create your operating baseline before starting feature delivery work.`,
    "",
    `1. Create your operating folder at \`${agentOperatingFolder}/\` (system path, outside project workspaces).`,
    "2. Author these files with your own responsibilities and working style:",
    `   - \`${agentOperatingFolder}/AGENTS.md\``,
    `   - \`${agentOperatingFolder}/HEARTBEAT.md\``,
    `   - \`${agentOperatingFolder}/SOUL.md\``,
    `   - \`${agentOperatingFolder}/TOOLS.md\``,
    `3. Update your own agent runtime config via \`PUT /agents/:agentId\` and set \`runtimeConfig.bootstrapPrompt\` to reference \`${agentOperatingFolder}/AGENTS.md\` as your primary guide.`,
    "4. Post an issue comment summarizing completed setup artifacts.",
    "",
    "Safety checks:",
    "- Do not write operating/system files under any project workspace folder.",
    "- Do not overwrite another agent's operating folder.",
    "- Keep content original to your role and scope."
  ].join("\n");
}

