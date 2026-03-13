import { pathToFileURL } from "node:url";
import { mkdir } from "node:fs/promises";
import { getAdapterModels } from "bopodev-agent-sdk";
import {
  bootstrapDatabase,
  createProjectWorkspace,
  createAgent,
  createCompany,
  createIssue,
  createProject,
  listAgents,
  listCompanies,
  listIssues,
  listProjectWorkspaces,
  listProjects,
  updateProjectWorkspace,
  updateIssue,
  updateAgent,
  updateCompany
} from "bopodev-db";
import { normalizeRuntimeConfig, runtimeConfigToDb, runtimeConfigToStateBlobPatch } from "../lib/agent-config";
import {
  normalizeAbsolutePath,
  normalizeCompanyWorkspacePath,
  resolveAgentFallbackWorkspacePath,
  resolveProjectWorkspacePath
} from "../lib/instance-paths";
import { resolveDefaultRuntimeCwdForCompany } from "../lib/workspace-policy";
import { ensureCompanyModelPricingDefaults } from "../services/model-pricing";

export interface OnboardSeedSummary {
  companyId: string;
  companyName: string;
  companyCreated: boolean;
  ceoCreated: boolean;
  ceoProviderType: AgentProvider;
  ceoRuntimeModel: string | null;
  ceoMigrated: boolean;
}

const DEFAULT_COMPANY_NAME_ENV = "BOPO_DEFAULT_COMPANY_NAME";
const DEFAULT_COMPANY_ID_ENV = "BOPO_DEFAULT_COMPANY_ID";
const DEFAULT_AGENT_PROVIDER_ENV = "BOPO_DEFAULT_AGENT_PROVIDER";
const DEFAULT_AGENT_MODEL_ENV = "BOPO_DEFAULT_AGENT_MODEL";
type AgentProvider = "codex" | "claude_code" | "cursor" | "gemini_cli" | "opencode" | "openai_api" | "anthropic_api" | "shell";
const CEO_BOOTSTRAP_SUMMARY = "ceo bootstrap heartbeat";
const STARTUP_PROJECT_NAME = "Leadership Setup";
const CEO_STARTUP_TASK_TITLE = "Set up CEO operating files and hire founding engineer";
const CEO_STARTUP_TASK_MARKER = "[bopodev:onboarding:ceo-startup:v1]";

export async function ensureOnboardingSeed(input: {
  dbPath?: string;
  companyName: string;
  companyId?: string;
  agentProvider?: AgentProvider;
  agentModel?: string;
}): Promise<OnboardSeedSummary> {
  const companyName = input.companyName.trim();
  if (companyName.length === 0) {
    throw new Error("BOPO_DEFAULT_COMPANY_NAME is required for onboarding seed.");
  }
  const agentProvider = parseAgentProvider(input.agentProvider) ?? "shell";
  const requestedAgentModel = input.agentModel?.trim() || undefined;

  const { db, client } = await bootstrapDatabase(input.dbPath);

  try {
    const companies = await listCompanies(db);
    let companyRow =
      (input.companyId ? companies.find((entry) => entry.id === input.companyId) : undefined) ??
      companies.find((entry) => entry.name === companyName);
    let companyCreated = false;

    if (!companyRow) {
      const createdCompany = await createCompany(db, { name: companyName });
      companyRow = {
        id: createdCompany.id,
        name: createdCompany.name,
        mission: createdCompany.mission ?? null,
        createdAt: new Date()
      };
      companyCreated = true;
    } else if (companyRow.name !== companyName) {
      companyRow = (await updateCompany(db, { id: companyRow.id, name: companyName })) ?? companyRow;
    }

    const companyId = companyRow.id;
    const resolvedCompanyName = companyRow.name;
    const defaultRuntimeCwd = await resolveDefaultRuntimeCwdForCompany(db, companyId);
    await mkdir(normalizeCompanyWorkspacePath(companyId, defaultRuntimeCwd), { recursive: true });
    const seedRuntimeEnv = resolveSeedRuntimeEnv(agentProvider);
    const defaultRuntimeConfig = normalizeRuntimeConfig({
      defaultRuntimeCwd,
      runtimeConfig: {
        runtimeEnv: seedRuntimeEnv,
        runtimeModel: await resolveSeedRuntimeModel(agentProvider, {
          requestedModel: requestedAgentModel,
          defaultRuntimeCwd,
          runtimeEnv: seedRuntimeEnv
        })
      }
    });
    const agents = await listAgents(db, companyId);
    const existingCeo = agents.find((agent) => agent.role === "CEO" || agent.name === "CEO");
    let ceoCreated = false;
    let ceoMigrated = false;
    let ceoProviderType: AgentProvider = parseAgentProvider(existingCeo?.providerType) ?? agentProvider;
    let ceoRuntimeModel = existingCeo?.runtimeModel ?? null;

    let ceoId = existingCeo?.id ?? null;

    if (!existingCeo) {
      const ceo = await createAgent(db, {
        companyId,
        role: "CEO",
        name: "CEO",
        providerType: agentProvider,
        heartbeatCron: "*/5 * * * *",
        monthlyBudgetUsd: "100.0000",
        canHireAgents: true,
        ...runtimeConfigToDb(defaultRuntimeConfig),
        initialState: runtimeConfigToStateBlobPatch(defaultRuntimeConfig)
      });
      ceoId = ceo.id;
      ceoCreated = true;
      ceoProviderType = agentProvider;
      ceoRuntimeModel = ceo.runtimeModel ?? defaultRuntimeConfig.runtimeModel ?? null;
    } else if (isBootstrapCeoRuntime(existingCeo.providerType, existingCeo.stateBlob)) {
      const nextState = {
        ...stripRuntimeFromState(existingCeo.stateBlob),
        ...runtimeConfigToStateBlobPatch(defaultRuntimeConfig)
      };
      await updateAgent(db, {
        companyId,
        id: existingCeo.id,
        providerType: agentProvider,
        ...runtimeConfigToDb(defaultRuntimeConfig),
        stateBlob: nextState
      });
      ceoMigrated = true;
      ceoProviderType = agentProvider;
      ceoId = existingCeo.id;
      ceoRuntimeModel = defaultRuntimeConfig.runtimeModel ?? null;
    } else {
      ceoId = existingCeo.id;
      ceoRuntimeModel = existingCeo.runtimeModel ?? null;
    }

    if (ceoId) {
      const startupProjectId = await ensureStartupProject(db, companyId);
      await ensureCeoStartupTask(db, {
        companyId,
        projectId: startupProjectId,
        ceoId
      });
    }
    await ensureCompanyModelPricingDefaults(db, companyId);

    return {
      companyId,
      companyName: resolvedCompanyName,
      companyCreated,
      ceoCreated,
      ceoProviderType,
      ceoRuntimeModel,
      ceoMigrated
    };
  } finally {
    const maybeClose = (client as { close?: () => Promise<void> }).close;
    if (maybeClose) {
      await maybeClose.call(client);
    }
  }
}

async function ensureStartupProject(db: Awaited<ReturnType<typeof bootstrapDatabase>>["db"], companyId: string) {
  const projects = await listProjects(db, companyId);
  const existing = projects.find((project) => project.name === STARTUP_PROJECT_NAME);
  if (existing) {
    await ensureProjectPrimaryWorkspace(db, companyId, existing.id, STARTUP_PROJECT_NAME);
    return existing.id;
  }
  const created = await createProject(db, {
    companyId,
    name: STARTUP_PROJECT_NAME,
    description: "Initial leadership onboarding and operating setup."
  });
  if (!created) {
    throw new Error("Failed to create startup project.");
  }
  await ensureProjectPrimaryWorkspace(db, companyId, created.id, STARTUP_PROJECT_NAME);
  return created.id;
}

async function ensureProjectPrimaryWorkspace(
  db: Awaited<ReturnType<typeof bootstrapDatabase>>["db"],
  companyId: string,
  projectId: string,
  projectName: string
) {
  const existingWorkspaces = await listProjectWorkspaces(db, companyId, projectId);
  const existingPrimary = existingWorkspaces.find((workspace) => workspace.isPrimary);
  if (existingPrimary) {
    if (existingPrimary.cwd) {
      await mkdir(normalizeCompanyWorkspacePath(companyId, existingPrimary.cwd), { recursive: true });
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

async function ensureCeoStartupTask(
  db: Awaited<ReturnType<typeof bootstrapDatabase>>["db"],
  input: { companyId: string; projectId: string; ceoId: string }
) {
  const issues = await listIssues(db, input.companyId);
  const existing = issues.find(
    (issue) =>
      issue.assigneeAgentId === input.ceoId &&
      issue.title === CEO_STARTUP_TASK_TITLE &&
      typeof issue.body === "string" &&
      issue.body.includes(CEO_STARTUP_TASK_MARKER)
  );
  const ceoWorkspaceRoot = resolveAgentFallbackWorkspacePath(input.companyId, input.ceoId);
  const ceoOperatingFolder = `${ceoWorkspaceRoot}/operating`;
  const ceoTmpFolder = `${ceoWorkspaceRoot}/tmp`;
  const body = [
    CEO_STARTUP_TASK_MARKER,
    "",
    "Stand up your leadership operating baseline before taking on additional delivery work.",
    "",
    `1. Create your operating folder at \`${ceoOperatingFolder}/\` (system path, outside project workspaces).`,
    "2. Author these files with your own voice and responsibilities:",
    `   - \`${ceoOperatingFolder}/AGENTS.md\``,
    `   - \`${ceoOperatingFolder}/HEARTBEAT.md\``,
    `   - \`${ceoOperatingFolder}/SOUL.md\``,
    `   - \`${ceoOperatingFolder}/TOOLS.md\``,
    "3. Save your operating-file reference on your own agent record via `PUT /agents/:agentId`.",
    `   - Supported simple body: \`{ "bootstrapPrompt": "Primary operating reference: ${ceoOperatingFolder}/AGENTS.md ..." }\``,
    "   - If using `runtimeConfig`, only `runtimeConfig.bootstrapPrompt` is supported there.",
    "   - Prefer heredoc/stdin payloads (for example `curl --data-binary @- <<'JSON' ... JSON`) to avoid temp-file cleanup failures under runtime policy.",
    `   - If you must use payload files, store them in \`${ceoTmpFolder}/\` (or OS temp via \`mktemp\`) and avoid chaining cleanup commands into critical task flow.`,
    "4. To inspect your own agent record, use `GET /agents` and filter by your agent id. Do not call `GET /agents/:agentId`.",
    "   - `GET /agents` uses envelope shape `{ \"ok\": true, \"data\": [...] }`; treat any other shape as failure.",
    "   - Deterministic filter: `jq -er --arg id \"$BOPODEV_AGENT_ID\" '.data | if type==\"array\" then . else error(\"invalid_agents_payload\") end | map(select((.id? // \"\") == $id))[0] | {id,name,role,bootstrapPrompt}'`",
    "5. Heartbeat-assigned issues are already claimed for the current run. Do not call a checkout endpoint; update status with `PUT /issues/:issueId` only.",
    "6. After your operating files are active, submit a hire request for a Founding Engineer via `POST /agents` using supported fields:",
    "   - `name`, `role`, `providerType`, `heartbeatCron`, `monthlyBudgetUsd`",
    "   - optional `managerAgentId`, `bootstrapPrompt`, `runtimeConfig`, `canHireAgents`",
    "   - `requestApproval: true` and `sourceIssueId`",
    "7. Do not use unsupported hire fields such as `adapterType`, `adapterConfig`, or `reportsTo`.",
    "",
    "Safety checks before requesting hire:",
    "- Do not write operating/system files under any project workspace folder.",
    "- Do not request duplicates if a Founding Engineer already exists.",
    "- Do not request duplicates if a pending approval for the same role is already open.",
    "- For control-plane calls, prefer direct header env vars (`BOPODEV_COMPANY_ID`, `BOPODEV_ACTOR_TYPE`, `BOPODEV_ACTOR_ID`, `BOPODEV_ACTOR_COMPANIES`, `BOPODEV_ACTOR_PERMISSIONS`) instead of parsing `BOPODEV_REQUEST_HEADERS_JSON`.",
    "- Do not assume `python` is installed in the runtime shell; prefer direct headers, `node`, or `jq` when scripting.",
    "- Shell commands run under `zsh`; avoid Bash-only features such as `local -n`, `declare -n`, `mapfile`, and `readarray`."
  ].join("\n");
  if (existing) {
    if (existing.body !== body) {
      await updateIssue(db, {
        companyId: input.companyId,
        id: existing.id,
        body
      });
    }
    return existing.id;
  }

  const startupIssue = await createIssue(db, {
    companyId: input.companyId,
    projectId: input.projectId,
    title: CEO_STARTUP_TASK_TITLE,
    body,
    status: "todo",
    priority: "high",
    assigneeAgentId: input.ceoId,
    labels: ["onboarding", "leadership", "agent-setup"],
    tags: ["ceo-startup"]
  });
  return startupIssue.id;
}

async function main() {
  const companyName = process.env[DEFAULT_COMPANY_NAME_ENV]?.trim() ?? "";
  const companyId = process.env[DEFAULT_COMPANY_ID_ENV]?.trim() || undefined;
  const agentProvider = parseAgentProvider(process.env[DEFAULT_AGENT_PROVIDER_ENV]) ?? undefined;
  const agentModel = process.env[DEFAULT_AGENT_MODEL_ENV]?.trim() || undefined;
  const dbPath = normalizeOptionalDbPath(process.env.BOPO_DB_PATH);
  const result = await ensureOnboardingSeed({
    dbPath,
    companyName,
    companyId,
    agentProvider,
    agentModel
  });
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(result));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}

function normalizeOptionalDbPath(value: string | undefined) {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalizeAbsolutePath(normalized, { requireAbsoluteInput: true }) : undefined;
}

function parseAgentProvider(value: unknown): AgentProvider | null {
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

function resolveSeedRuntimeEnv(agentProvider: AgentProvider): Record<string, string> {
  if (agentProvider === "codex" || agentProvider === "openai_api") {
    const key = (process.env.BOPO_OPENAI_API_KEY ?? process.env.OPENAI_API_KEY)?.trim();
    if (!key) {
      return {};
    }
    return {
      OPENAI_API_KEY: key
    };
  }
  if (agentProvider === "claude_code" || agentProvider === "anthropic_api") {
    const key = (process.env.BOPO_ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_API_KEY)?.trim();
    if (!key) {
      return {};
    }
    return {
      ANTHROPIC_API_KEY: key
    };
  }
  return {};
}

async function resolveSeedRuntimeModel(
  agentProvider: AgentProvider,
  input: { requestedModel?: string; defaultRuntimeCwd: string; runtimeEnv: Record<string, string> }
): Promise<string | undefined> {
  if (input.requestedModel) {
    return input.requestedModel;
  }
  if (agentProvider !== "opencode") {
    return undefined;
  }
  const configured =
    process.env.BOPO_OPENCODE_MODEL?.trim() ||
    process.env.OPENCODE_MODEL?.trim();
  try {
    const discovered = await getAdapterModels("opencode", {
      command: process.env.BOPO_OPENCODE_COMMAND?.trim() || "opencode",
      cwd: input.defaultRuntimeCwd,
      env: input.runtimeEnv
    });
    if (configured && discovered.some((entry) => entry.id === configured)) {
      return configured;
    }
    if (discovered.length > 0) {
      return discovered[0]!.id;
    }
  } catch {
    if (configured) {
      return configured;
    }
  }
  return configured;
}

function isBootstrapCeoRuntime(providerType: string, stateBlob: string | null) {
  if (providerType !== "shell") {
    return false;
  }
  const runtime = parseRuntimeFromState(stateBlob);
  if (!runtime || runtime.command !== "echo") {
    return false;
  }
  const args = Array.isArray(runtime.args) ? runtime.args.map((entry) => String(entry).toLowerCase()) : [];
  return args.some((entry) => entry.includes(CEO_BOOTSTRAP_SUMMARY));
}

function parseRuntimeFromState(stateBlob: string | null): { command?: string; args?: string[] } | null {
  if (!stateBlob) {
    return null;
  }
  try {
    const parsed = JSON.parse(stateBlob) as { runtime?: { command?: unknown; args?: unknown } };
    const runtime = parsed.runtime;
    if (!runtime || typeof runtime !== "object") {
      return null;
    }
    return {
      command: typeof runtime.command === "string" ? runtime.command : undefined,
      args: Array.isArray(runtime.args) ? runtime.args.map((entry) => String(entry)) : undefined
    };
  } catch {
    return null;
  }
}

function stripRuntimeFromState(stateBlob: string | null) {
  if (!stateBlob) {
    return {};
  }
  try {
    const parsed = JSON.parse(stateBlob) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const { runtime: _runtime, ...rest } = parsed;
    return rest;
  } catch {
    return {};
  }
}
