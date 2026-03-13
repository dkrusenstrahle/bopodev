import type { TemplateManifest, TemplatePreviewResponse } from "bopodev-contracts";

type PreviewInput = {
  templateId: string;
  templateVersion: string;
  manifest: TemplateManifest;
  variables: Record<string, unknown>;
};

export function buildTemplatePreview(input: PreviewInput): TemplatePreviewResponse {
  const renderedManifest = interpolateTemplateManifest(input.manifest, input.variables);
  const plannedActions = [
    ...renderedManifest.projects.map((project) => `Create project: ${project.name}`),
    ...renderedManifest.goals.map((goal) => `Create goal (${goal.level}): ${goal.title}`),
    ...renderedManifest.agents.map((agent) => `Create agent (${agent.role}): ${agent.name}`),
    ...renderedManifest.issues.map((issue) => `Create issue: ${issue.title}`),
    ...renderedManifest.plugins.map((plugin) => `Configure plugin: ${plugin.pluginId}`),
    ...renderedManifest.recurrence.map((job) => `Schedule recurring job (${job.cron}) for ${job.targetKey}`)
  ];

  return {
    templateId: input.templateId,
    templateVersion: input.templateVersion,
    plannedActions,
    summary: {
      projects: renderedManifest.projects.length,
      goals: renderedManifest.goals.length,
      agents: renderedManifest.agents.length,
      issues: renderedManifest.issues.length,
      plugins: renderedManifest.plugins.length,
      recurrence: renderedManifest.recurrence.length
    },
    warnings: collectTemplateWarnings(renderedManifest)
  };
}

export function interpolateTemplateManifest(manifest: TemplateManifest, variables: Record<string, unknown>): TemplateManifest {
  return walkAndInterpolate(manifest, variables) as TemplateManifest;
}

function walkAndInterpolate(value: unknown, variables: Record<string, unknown>): unknown {
  if (typeof value === "string") {
    return interpolateTemplateString(value, variables);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => walkAndInterpolate(entry, variables));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, walkAndInterpolate(entry, variables)])
    );
  }
  return value;
}

function interpolateTemplateString(value: string, variables: Record<string, unknown>) {
  return value.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_match, key: string) => {
    const resolved = variables[key];
    if (resolved === undefined || resolved === null) {
      return "";
    }
    return String(resolved);
  });
}

function collectTemplateWarnings(manifest: TemplateManifest) {
  const warnings: string[] = [];
  if (manifest.projects.length === 0) {
    warnings.push("Template has no projects.");
  }
  if (manifest.agents.length === 0) {
    warnings.push("Template has no agents.");
  }
  if (manifest.issues.length === 0) {
    warnings.push("Template has no issues.");
  }
  return warnings;
}
