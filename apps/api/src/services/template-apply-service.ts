import { AGENT_ROLE_LABELS, AgentRoleKeySchema, type TemplateApplyResponse, type TemplateManifest } from "bopodev-contracts";
import type { BopoDb } from "bopodev-db";
import {
  createAgent,
  createGoal,
  createIssue,
  createProject,
  createTemplateInstall,
  updatePluginConfig
} from "bopodev-db";
import { interpolateTemplateManifest, buildTemplatePreview } from "./template-preview-service";
import { addWorkLoopTrigger, createWorkLoop } from "./work-loop-service";

export class TemplateApplyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TemplateApplyError";
  }
}

export async function applyTemplateManifest(
  db: BopoDb,
  input: {
    companyId: string;
    templateId: string;
    templateVersion: string;
    manifest: TemplateManifest;
    variables: Record<string, unknown>;
    templateVersionId?: string | null;
  }
): Promise<TemplateApplyResponse> {
  const renderedManifest = interpolateTemplateManifest(input.manifest, input.variables);
  const preview = buildTemplatePreview({
    templateId: input.templateId,
    templateVersion: input.templateVersion,
    manifest: input.manifest,
    variables: input.variables
  });

  const projectIdByKey = new Map<string, string>();
  for (const project of renderedManifest.projects) {
    const createdProject = await createProject(db, {
      companyId: input.companyId,
      name: project.name,
      description: project.description,
      status: project.status
    });
    if (!createdProject) {
      throw new TemplateApplyError(`Failed to create project '${project.name}'.`);
    }
    projectIdByKey.set(project.key, createdProject.id);
  }

  const agentIdByKey = new Map<string, string>();
  for (const agent of renderedManifest.agents) {
    const managerId = agent.managerAgentKey ? agentIdByKey.get(agent.managerAgentKey) ?? null : null;
    const runtimeArgsJson = JSON.stringify(agent.runtimeConfig?.runtimeArgs ?? []);
    const runtimeEnvJson = JSON.stringify(agent.runtimeConfig?.runtimeEnv ?? {});
    const runPolicyJson = JSON.stringify(agent.runtimeConfig?.runPolicy ?? {});
    const createdAgent = await createAgent(db, {
      companyId: input.companyId,
      managerAgentId: managerId,
      role: resolveAgentRoleText(agent.role, agent.roleKey, agent.title),
      roleKey: normalizeRoleKey(agent.roleKey),
      title: normalizeTitle(agent.title),
      capabilities: normalizeCapabilities(agent.capabilities),
      name: agent.name,
      providerType: agent.providerType,
      heartbeatCron: agent.heartbeatCron,
      monthlyBudgetUsd: agent.monthlyBudgetUsd.toFixed(4),
      canHireAgents: agent.canHireAgents,
      canAssignAgents: agent.canAssignAgents,
      canCreateIssues: agent.canCreateIssues,
      runtimeCommand: agent.runtimeConfig?.runtimeCommand,
      runtimeArgsJson,
      runtimeCwd: agent.runtimeConfig?.runtimeCwd,
      runtimeEnvJson,
      runtimeModel: agent.runtimeConfig?.runtimeModel,
      runtimeThinkingEffort: agent.runtimeConfig?.runtimeThinkingEffort,
      bootstrapPrompt: agent.runtimeConfig?.bootstrapPrompt,
      runtimeTimeoutSec: agent.runtimeConfig?.runtimeTimeoutSec,
      interruptGraceSec: agent.runtimeConfig?.interruptGraceSec,
      runPolicyJson
    });
    agentIdByKey.set(agent.key, createdAgent.id);
  }

  for (const goal of renderedManifest.goals) {
    const resolvedProjectId = goal.projectKey ? projectIdByKey.get(goal.projectKey) ?? null : null;
    await createGoal(db, {
      companyId: input.companyId,
      projectId: resolvedProjectId,
      level: goal.level,
      title: goal.title,
      description: goal.description
    });
  }

  for (const issue of renderedManifest.issues) {
    const resolvedProjectId = projectIdByKey.get(issue.projectKey);
    if (!resolvedProjectId) {
      throw new TemplateApplyError(`Issue '${issue.title}' references unknown project key '${issue.projectKey}'.`);
    }
    const assigneeAgentId = issue.assigneeAgentKey ? agentIdByKey.get(issue.assigneeAgentKey) ?? null : null;
    await createIssue(db, {
      companyId: input.companyId,
      projectId: resolvedProjectId,
      title: issue.title,
      body: issue.body,
      status: issue.status,
      priority: issue.priority,
      assigneeAgentId,
      labels: issue.labels,
      tags: issue.tags
    });
  }

  for (const plugin of renderedManifest.plugins) {
    await updatePluginConfig(db, {
      companyId: input.companyId,
      pluginId: plugin.pluginId,
      enabled: plugin.enabled ?? false,
      priority: plugin.priority ?? 100,
      grantedCapabilitiesJson: JSON.stringify(plugin.grantedCapabilities),
      configJson: JSON.stringify(plugin.config)
    });
  }

  const firstProjectId =
    renderedManifest.projects.length > 0
      ? projectIdByKey.get(renderedManifest.projects[0]!.key) ?? null
      : Array.from(projectIdByKey.values())[0] ?? null;
  for (const job of renderedManifest.recurrence) {
    if (job.targetType !== "agent") {
      continue;
    }
    const assigneeAgentId = agentIdByKey.get(job.targetKey) ?? null;
    if (!assigneeAgentId || !firstProjectId) {
      continue;
    }
    const title =
      job.instruction?.trim() && job.instruction.trim().length > 0
        ? job.instruction.trim()
        : `Recurring work: ${job.targetKey}`;
    const loop = await createWorkLoop(db, {
      companyId: input.companyId,
      projectId: firstProjectId,
      title,
      description: job.instruction?.trim() || null,
      assigneeAgentId
    });
    if (loop) {
      await addWorkLoopTrigger(db, {
        companyId: input.companyId,
        routineId: loop.id,
        cronExpression: job.cron
      });
    }
  }

  const install = await createTemplateInstall(db, {
    companyId: input.companyId,
    templateId: input.templateId,
    templateVersionId: input.templateVersionId ?? null,
    status: "applied",
    summaryJson: JSON.stringify(preview.summary),
    variablesJson: JSON.stringify(input.variables)
  });

  return {
    applied: true,
    installId: install?.id,
    summary: preview.summary,
    warnings: preview.warnings
  };
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
