import { access, copyFile, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { confirm, isCancel, log, select, spinner, text } from "@clack/prompts";
import dotenv from "dotenv";
import { runDoctorChecks, type DoctorCheck } from "../lib/checks";
import { resolveWorkspaceRootOrManaged, runCommandCapture, runCommandStreaming } from "../lib/process";
import { printBanner, printCheck, printDivider, printLine, printSection, printSummaryCard } from "../lib/ui";

export interface OnboardOptions {
  cwd: string;
  yes: boolean;
  start: boolean;
  forceInstall: boolean;
  template?: string;
}

export interface OnboardFlowResult {
  workspaceRoot: string;
  envCreated: boolean;
  dbInitialized: boolean;
  checks: DoctorCheck[];
}

interface OnboardSeedResult {
  companyId: string;
  companyName: string;
  companyCreated: boolean;
  ceoCreated: boolean;
  ceoProviderType: AgentProvider;
  ceoRuntimeModel: string | null;
  ceoMigrated: boolean;
  templateApplied?: boolean;
  templateId?: string | null;
}

type AgentProvider = "codex" | "claude_code" | "gemini_cli" | "opencode" | "openai_api" | "anthropic_api" | "shell";

interface OnboardDeps {
  installDependencies: (workspaceRoot: string) => Promise<void>;
  runDoctor: (workspaceRoot: string) => Promise<DoctorCheck[]>;
  initializeDatabase: (workspaceRoot: string, dbPath?: string) => Promise<void>;
  seedOnboardingDatabase: (
    workspaceRoot: string,
    input: { dbPath?: string; companyName: string; companyId?: string; agentProvider: AgentProvider; templateId?: string }
  ) => Promise<OnboardSeedResult>;
  startServices: (workspaceRoot: string) => Promise<number | null>;
  promptForCompanyName: () => Promise<string>;
  promptForAgentProvider: (input?: {
    availableProviders?: AgentProvider[];
    preferredProvider?: AgentProvider | null;
  }) => Promise<AgentProvider>;
  promptForAgentModel: (input: { provider: AgentProvider; preferredModel?: string | null }) => Promise<string | undefined>;
  promptForTemplateUsage?: (input: { currentTemplateId?: string | null }) => Promise<boolean>;
  promptForTemplateSelection?: (input: { currentTemplateId?: string | null }) => Promise<string | undefined>;
}

interface EnsureEnvResult {
  created: boolean;
  source: "example" | "default" | null;
}

const DEFAULT_COMPANY_NAME_ENV = "BOPO_DEFAULT_COMPANY_NAME";
const DEFAULT_COMPANY_ID_ENV = "BOPO_DEFAULT_COMPANY_ID";
const DEFAULT_PUBLIC_COMPANY_ID_ENV = "NEXT_PUBLIC_DEFAULT_COMPANY_ID";
const DEFAULT_AGENT_PROVIDER_ENV = "BOPO_DEFAULT_AGENT_PROVIDER";
const DEFAULT_AGENT_MODEL_ENV = "BOPO_DEFAULT_AGENT_MODEL";
const DEFAULT_TEMPLATE_ENV = "BOPO_DEFAULT_TEMPLATE_ID";
const DEFAULT_DEPLOYMENT_MODE_ENV = "BOPO_DEPLOYMENT_MODE";
const DEFAULT_ENV_TEMPLATE = "NEXT_PUBLIC_API_URL=http://localhost:4020\n";
const CLI_ONBOARD_VISIBLE_PROVIDERS: Array<{ value: AgentProvider; label: string }> = [
  { value: "codex", label: "Codex" },
  { value: "claude_code", label: "Claude Code" },
  { value: "gemini_cli", label: "Gemini" },
  { value: "opencode", label: "OpenCode" }
];
const CLI_ONBOARD_TEMPLATES = [
  { value: "founder-startup-basic", label: "Founder Startup Basic" },
  { value: "marketing-content-engine", label: "Marketing Content Engine" },
  { value: "__custom__", label: "Custom template id/slug" }
] as const;

const defaultDeps: OnboardDeps = {
  installDependencies: async (workspaceRoot) => {
    const result = await runCommandCapture("pnpm", ["install"], { cwd: workspaceRoot });
    if (!result.ok) {
      const details = [result.stderr, result.stdout].filter((value) => value.trim().length > 0).join("\n").trim();
      throw new Error(details.length > 0 ? details : `pnpm install failed with exit code ${String(result.code)}`);
    }
  },
  runDoctor: (workspaceRoot) => runDoctorChecks({ workspaceRoot }),
  initializeDatabase: async (workspaceRoot, dbPath) => {
    const result = await runCommandCapture("pnpm", ["--filter", "bopodev-api", "db:init"], {
      cwd: workspaceRoot,
      env: {
        ...process.env,
        ...(dbPath ? { BOPO_DB_PATH: dbPath } : {})
      }
    });
    if (!result.ok) {
      const details = [result.stderr, result.stdout].filter((value) => value.trim().length > 0).join("\n").trim();
      throw new Error(details.length > 0 ? details : `db:init failed with exit code ${String(result.code)}`);
    }
  },
  seedOnboardingDatabase: async (workspaceRoot, input) => {
    const result = await runCommandCapture("pnpm", ["--filter", "bopodev-api", "onboard:seed"], {
      cwd: workspaceRoot,
      env: {
        ...process.env,
        [DEFAULT_COMPANY_NAME_ENV]: input.companyName,
        [DEFAULT_AGENT_PROVIDER_ENV]: input.agentProvider,
        ...(process.env[DEFAULT_AGENT_MODEL_ENV] ? { [DEFAULT_AGENT_MODEL_ENV]: process.env[DEFAULT_AGENT_MODEL_ENV] } : {}),
        ...(input.templateId ? { [DEFAULT_TEMPLATE_ENV]: input.templateId } : {}),
        ...(input.companyId ? { [DEFAULT_COMPANY_ID_ENV]: input.companyId } : {}),
        ...(input.dbPath ? { BOPO_DB_PATH: input.dbPath } : {})
      }
    });
    if (!result.ok) {
      const details = [result.stderr, result.stdout].filter((value) => value.trim().length > 0).join("\n").trim();
      throw new Error(details.length > 0 ? details : `onboard:seed failed with exit code ${String(result.code)}`);
    }
    return parseSeedResult(result.stdout);
  },
  startServices: (workspaceRoot) => runCommandStreaming("pnpm", ["start:quiet"], { cwd: workspaceRoot }),
  promptForCompanyName: async () => {
    const answer = await text({
      message: "Default company name",
      placeholder: "Acme AI",
      validate: (value) => (value.trim().length > 0 ? undefined : "Company name is required.")
    });
    if (isCancel(answer)) {
      throw new Error("Onboarding cancelled.");
    }
    return answer.trim();
  },
  promptForAgentProvider: async (input) => {
    const availableProviders = input?.availableProviders && input.availableProviders.length > 0
      ? input.availableProviders
      : CLI_ONBOARD_VISIBLE_PROVIDERS.map((entry) => entry.value);
    const options = CLI_ONBOARD_VISIBLE_PROVIDERS.filter((entry) => availableProviders.includes(entry.value));
    const fallback = options[0]?.value ?? "codex";
    const preferred = input?.preferredProvider && availableProviders.includes(input.preferredProvider)
      ? input.preferredProvider
      : fallback;
    const answer = await select({
      message: "Primary agent framework",
      initialValue: preferred,
      options
    });
    if (isCancel(answer)) {
      throw new Error("Onboarding cancelled.");
    }
    const provider = parseAgentProvider(answer);
    if (!provider) {
      throw new Error("Invalid primary agent framework selected.");
    }
    return provider;
  },
  promptForAgentModel: async ({ provider, preferredModel }) => {
    const options = buildModelOptions(provider, preferredModel ?? undefined);
    const defaultOption = options[0];
    const answer = await select({
      message: "Default model",
      initialValue: defaultOption?.value ?? "",
      options
    });
    if (isCancel(answer)) {
      throw new Error("Onboarding cancelled.");
    }
    const selected = typeof answer === "string" ? answer.trim() : "";
    if (selected === "__auto__") {
      return undefined;
    }
    return selected.length > 0 ? selected : undefined;
  },
  promptForTemplateUsage: async ({ currentTemplateId }) => {
    const answer = await confirm({
      message: "Do you want to use a template?",
      initialValue: Boolean(currentTemplateId)
    });
    if (isCancel(answer)) {
      throw new Error("Onboarding cancelled.");
    }
    return Boolean(answer);
  },
  promptForTemplateSelection: async ({ currentTemplateId }) => {
    const matchingDefault = CLI_ONBOARD_TEMPLATES.find((entry) => entry.value === currentTemplateId)?.value;
    const answer = await select({
      message: "Select template",
      initialValue: matchingDefault ?? "founder-startup-basic",
      options: CLI_ONBOARD_TEMPLATES.map((entry) => ({ value: entry.value, label: entry.label }))
    });
    if (isCancel(answer)) {
      throw new Error("Onboarding cancelled.");
    }
    const selected = typeof answer === "string" ? answer.trim() : "";
    if (selected === "__custom__") {
      const custom = await text({
        message: "Template id or slug",
        placeholder: "founder-startup-basic",
        validate: (value) => (value.trim().length > 0 ? undefined : "Template id/slug is required.")
      });
      if (isCancel(custom)) {
        throw new Error("Onboarding cancelled.");
      }
      return custom.trim();
    }
    return selected.length > 0 ? selected : undefined;
  }
};

export async function runOnboardFlow(options: OnboardOptions, deps: OnboardDeps = defaultDeps): Promise<OnboardFlowResult> {
  const workspaceRoot = await resolveWorkspaceRootOrManaged(options.cwd, { bootstrapIfMissing: true });
  if (!workspaceRoot) {
    throw new Error("Could not find or bootstrap a Bopodev workspace root.");
  }

  printBanner();
  printSection("bopodev onboard");
  printLine(`Workspace: ${workspaceRoot}`);
  printDivider();

  if (!options.yes) {
    const answer = await confirm({
      message: "Run onboarding now?",
      initialValue: true
    });
    if (isCancel(answer) || !answer) {
      throw new Error("Onboarding cancelled.");
    }
  } else {
    log.step("`--yes` enabled: using defaults for optional onboarding steps.");
  }

  const shouldInstall = options.forceInstall || !(await hasExistingInstall(workspaceRoot));
  if (shouldInstall) {
    const installSpin = spinner();
    installSpin.start("Preparing dependencies");
    await deps.installDependencies(workspaceRoot);
    installSpin.stop("Dependencies ready");
  } else {
    printCheck("ok", "Dependencies", "Already installed");
  }

  const envPath = join(workspaceRoot, ".env");
  const preEnvValues = (await fileExists(envPath)) ? await readEnvValues(envPath) : {};

  const doctorSpin = spinner();
  doctorSpin.start("Running doctor checks");
  const checks = await deps.runDoctor(workspaceRoot);
  doctorSpin.stop("Doctor checks complete");
  const runtimeAvailability = deriveAvailableAgentProviders(checks);
  const passed = checks.filter((check) => check.ok).length;
  const warnings = checks.length - passed;
  printCheck("ok", "Doctor", "checks complete");
  printCheck("ok", "Doctor summary", `${passed} passed, ${warnings} warning${warnings === 1 ? "" : "s"}`);
  if (warnings === 0) {
    printCheck("ok", "Doctor status", "All checks passed");
  }
  for (const check of checks) {
    printCheck(check.ok ? "ok" : "warn", check.label, check.details);
  }

  let companyName = preEnvValues[DEFAULT_COMPANY_NAME_ENV]?.trim() ?? "";
  if (companyName.length > 0) {
    printCheck("ok", "Default company", companyName);
  } else {
    companyName = await deps.promptForCompanyName();
    printCheck("ok", "Default company", companyName);
  }
  const selectableProviders = runtimeAvailability.length > 0 ? runtimeAvailability : CLI_ONBOARD_VISIBLE_PROVIDERS.map((entry) => entry.value);
  const configuredProvider = parseAgentProvider(preEnvValues[DEFAULT_AGENT_PROVIDER_ENV]);
  let agentProvider: AgentProvider = configuredProvider ?? selectableProviders[0] ?? "codex";
  const canReuseProvider = Boolean(configuredProvider && selectableProviders.includes(configuredProvider));
  if (canReuseProvider) {
    printCheck("ok", "Primary agent framework", formatAgentProvider(agentProvider));
  } else {
    agentProvider = await deps.promptForAgentProvider({
      availableProviders: selectableProviders,
      preferredProvider: configuredProvider
    });
    printCheck("ok", "Primary agent framework", formatAgentProvider(agentProvider));
  }
  const preferredModel = normalizeOptionalEnvValue(preEnvValues[DEFAULT_AGENT_MODEL_ENV]) ?? getDefaultModelForProvider(agentProvider);
  const selectedAgentModel = options.yes
    ? preferredModel ?? undefined
    : await deps.promptForAgentModel({
        provider: agentProvider,
        preferredModel
      });
  printCheck("ok", "Default model", selectedAgentModel ?? "Provider default");
  const explicitTemplateId = normalizeOptionalEnvValue(options.template);
  const envTemplateId = normalizeOptionalEnvValue(preEnvValues[DEFAULT_TEMPLATE_ENV]);
  let requestedTemplateId = explicitTemplateId ?? envTemplateId;
  if (!options.yes && !explicitTemplateId) {
    const promptForTemplateUsage = deps.promptForTemplateUsage ?? defaultDeps.promptForTemplateUsage;
    const promptForTemplateSelection = deps.promptForTemplateSelection ?? defaultDeps.promptForTemplateSelection;
    if (!promptForTemplateUsage || !promptForTemplateSelection) {
      throw new Error("Template onboarding prompts are not configured.");
    }
    const wantsTemplate = await promptForTemplateUsage({
      currentTemplateId: envTemplateId ?? null
    });
    if (wantsTemplate) {
      requestedTemplateId = (await promptForTemplateSelection({
        currentTemplateId: requestedTemplateId ?? null
      })) ?? undefined;
    } else {
      requestedTemplateId = undefined;
    }
  }
  if (requestedTemplateId) {
    printCheck("ok", "Template", requestedTemplateId);
  } else {
    printCheck("ok", "Template", "Skipped");
  }
  printCheck("ok", "Seed mode", requestedTemplateId ? "Template-only (strict)" : "Default bootstrap");

  const envSpin = spinner();
  envSpin.start("Ensuring local environment");
  const envResult = await ensureEnvFile(workspaceRoot);
  await sanitizeBlankDbPathEnvEntry(envPath);
  await updateEnvFile(envPath, {
    [DEFAULT_DEPLOYMENT_MODE_ENV]: "local",
    [DEFAULT_COMPANY_NAME_ENV]: companyName,
    [DEFAULT_AGENT_PROVIDER_ENV]: agentProvider ?? "codex",
    ...(requestedTemplateId ? { [DEFAULT_TEMPLATE_ENV]: requestedTemplateId } : {}),
    ...(selectedAgentModel ? { [DEFAULT_AGENT_MODEL_ENV]: selectedAgentModel } : {})
  });
  if (!requestedTemplateId) {
    await removeEnvKeys(envPath, [DEFAULT_TEMPLATE_ENV]);
  }
  dotenv.config({ path: envPath, quiet: true });
  const envValues = await readEnvValues(envPath);
  const configuredDbPath = normalizeOptionalEnvValue(envValues.BOPO_DB_PATH);
  if (configuredDbPath) {
    process.env.BOPO_DB_PATH = configuredDbPath;
  } else {
    delete process.env.BOPO_DB_PATH;
  }
  process.env[DEFAULT_DEPLOYMENT_MODE_ENV] = "local";
  process.env[DEFAULT_COMPANY_NAME_ENV] = companyName;
  process.env[DEFAULT_AGENT_PROVIDER_ENV] = agentProvider ?? "codex";
  if (requestedTemplateId) {
    process.env[DEFAULT_TEMPLATE_ENV] = requestedTemplateId;
  } else {
    delete process.env[DEFAULT_TEMPLATE_ENV];
  }
  if (selectedAgentModel) {
    process.env[DEFAULT_AGENT_MODEL_ENV] = selectedAgentModel;
  } else {
    delete process.env[DEFAULT_AGENT_MODEL_ENV];
  }
  envSpin.stop(
    envResult.created
      ? envResult.source === "example"
        ? "Environment configured from .env.example"
        : "Environment configured from defaults"
      : "Environment updated"
  );

  const dbSpin = spinner();
  dbSpin.start("Initializing and migrating database");
  await deps.initializeDatabase(workspaceRoot, configuredDbPath);
  dbSpin.stop("Database ready");

  const seedSpin = spinner();
  seedSpin.start("Seeding default company and CEO");
  const seedResult = await deps.seedOnboardingDatabase(workspaceRoot, {
    dbPath: configuredDbPath,
    companyName,
    companyId: envValues[DEFAULT_COMPANY_ID_ENV]?.trim() || undefined,
    agentProvider,
    templateId: requestedTemplateId
  });
  seedSpin.stop("Seed complete");
  await updateEnvFile(envPath, {
    [DEFAULT_COMPANY_NAME_ENV]: seedResult.companyName,
    [DEFAULT_COMPANY_ID_ENV]: seedResult.companyId,
    [DEFAULT_PUBLIC_COMPANY_ID_ENV]: seedResult.companyId,
    [DEFAULT_AGENT_PROVIDER_ENV]: seedResult.ceoProviderType
  });
  process.env[DEFAULT_COMPANY_NAME_ENV] = seedResult.companyName;
  process.env[DEFAULT_COMPANY_ID_ENV] = seedResult.companyId;
  process.env[DEFAULT_PUBLIC_COMPANY_ID_ENV] = seedResult.companyId;
  process.env[DEFAULT_AGENT_PROVIDER_ENV] = seedResult.ceoProviderType;
  if (seedResult.ceoRuntimeModel) {
    process.env[DEFAULT_AGENT_MODEL_ENV] = seedResult.ceoRuntimeModel;
  } else if (selectedAgentModel) {
    process.env[DEFAULT_AGENT_MODEL_ENV] = selectedAgentModel;
  } else {
    delete process.env[DEFAULT_AGENT_MODEL_ENV];
  }
  if (seedResult.templateId) {
    process.env[DEFAULT_TEMPLATE_ENV] = seedResult.templateId;
  } else if (!requestedTemplateId) {
    delete process.env[DEFAULT_TEMPLATE_ENV];
  }
  printCheck("ok", "Configured company", `${seedResult.companyName}${seedResult.companyCreated ? " (created)" : ""}`);
  printCheck(
    "ok",
    "CEO agent",
    `${seedResult.ceoCreated ? "Created CEO" : seedResult.ceoMigrated ? "Migrated existing CEO" : "CEO already present"} (${formatAgentProvider(seedResult.ceoProviderType)})`
  );
  if (requestedTemplateId) {
    printCheck(
      seedResult.templateApplied ? "ok" : "warn",
      "Template apply",
      seedResult.templateApplied
        ? `Applied ${seedResult.templateId ?? requestedTemplateId}`
        : `Template not applied (${requestedTemplateId})`
    );
  }

  const dbPathSummary = resolveDbPathSummary(configuredDbPath);
  printSummaryCard([
    `Mode    ${padSummaryValue("local")}`,
    `Deploy  ${padSummaryValue("local_mac")}`,
    `Doctor  ${padSummaryValue(`${passed} passed, ${warnings} warning${warnings === 1 ? "" : "s"}`)}`,
    `Company ${padSummaryValue(`${seedResult.companyName} (${seedResult.companyId})`)}`,
    `Agent   ${padSummaryValue(formatAgentProvider(seedResult.ceoProviderType))}`,
    `Model   ${padSummaryValue(seedResult.ceoRuntimeModel ?? selectedAgentModel ?? "provider default")}`,
    `API     ${padSummaryValue("http://127.0.0.1:4020")}`,
    `UI      ${padSummaryValue("http://127.0.0.1:4010")}`,
    `DB      ${padSummaryValue(dbPathSummary)}`
  ]);

  if (options.start) {
    printLine("Starting services in quiet mode and opening admin...");
    printDivider();
    await deps.startServices(workspaceRoot);
  } else {
    printSection("Next commands");
    printLine("- Run: pnpm start:quiet (opens browser by default)");
    printLine("- Full logs: pnpm start");
    printLine("- Disable browser auto-open: BOPO_OPEN_BROWSER=0 pnpm start:quiet");
    printLine("- Diagnose: bopodev doctor");
  }

  return {
    workspaceRoot,
    envCreated: envResult.created,
    dbInitialized: true,
    checks
  };
}

async function ensureEnvFile(workspaceRoot: string): Promise<EnsureEnvResult> {
  const envPath = join(workspaceRoot, ".env");
  const envExamplePath = join(workspaceRoot, ".env.example");

  const envExists = await fileExists(envPath);
  if (envExists) {
    return { created: false, source: null };
  }

  const envExampleExists = await fileExists(envExamplePath);
  if (envExampleExists) {
    await copyFile(envExamplePath, envPath);
    return { created: true, source: "example" };
  }

  await writeFile(envPath, DEFAULT_ENV_TEMPLATE, "utf8");
  log.warn("Missing .env.example in workspace root. Created .env with built-in defaults.");
  return { created: true, source: "default" };
}

async function readEnvValues(envPath: string) {
  const envContent = await readFile(envPath, "utf8");
  return dotenv.parse(envContent);
}

async function updateEnvFile(envPath: string, updates: Record<string, string>) {
  const existingContent = await readFile(envPath, "utf8");
  const lines = existingContent.split(/\r?\n/);
  const nextLines = [...lines];

  for (const [key, value] of Object.entries(updates)) {
    const serialized = `${key}=${serializeEnvValue(value)}`;
    const existingIndex = nextLines.findIndex((line) => line.startsWith(`${key}=`));
    if (existingIndex >= 0) {
      nextLines[existingIndex] = serialized;
    } else {
      const insertionIndex = nextLines.length > 0 && nextLines[nextLines.length - 1] === "" ? nextLines.length - 1 : nextLines.length;
      nextLines.splice(insertionIndex, 0, serialized);
    }
  }

  const nextContent = nextLines.join("\n");
  await writeFile(envPath, nextContent.endsWith("\n") ? nextContent : `${nextContent}\n`, "utf8");
}

async function sanitizeBlankDbPathEnvEntry(envPath: string) {
  const existingContent = await readFile(envPath, "utf8");
  const lines = existingContent.split(/\r?\n/);
  let changed = false;
  const nextLines = lines.map((line) => {
    if (!line.startsWith("BOPO_DB_PATH=")) {
      return line;
    }
    const value = line.slice("BOPO_DB_PATH=".length).trim();
    if (value.length > 0) {
      return line;
    }
    changed = true;
    return "# BOPO_DB_PATH=  # optional override; leave unset to use default instance path";
  });
  if (!changed) {
    return;
  }
  const nextContent = nextLines.join("\n");
  await writeFile(envPath, nextContent.endsWith("\n") ? nextContent : `${nextContent}\n`, "utf8");
}

async function removeEnvKeys(envPath: string, keys: string[]) {
  if (keys.length === 0) {
    return;
  }
  const existingContent = await readFile(envPath, "utf8");
  const nextLines = existingContent
    .split(/\r?\n/)
    .filter((line) => !keys.some((key) => line.startsWith(`${key}=`)));
  const nextContent = nextLines.join("\n");
  await writeFile(envPath, nextContent.endsWith("\n") ? nextContent : `${nextContent}\n`, "utf8");
}

function serializeEnvValue(value: string) {
  return /[\s#"'`]/.test(value) ? JSON.stringify(value) : value;
}

function normalizeOptionalEnvValue(value: string | undefined) {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : undefined;
}

function deriveAvailableAgentProviders(checks: DoctorCheck[]): AgentProvider[] {
  const providers: AgentProvider[] = [];
  for (const check of checks) {
    if (!check.ok) {
      continue;
    }
    if (check.label === "Codex runtime") {
      providers.push("codex");
    }
    if (check.label === "Claude Code runtime") {
      providers.push("claude_code");
    }
    if (check.label === "Gemini runtime") {
      providers.push("gemini_cli");
    }
    if (check.label === "OpenCode runtime") {
      providers.push("opencode");
    }
  }
  return Array.from(new Set(providers));
}

function resolveDbPathSummary(configuredDbPath: string | undefined) {
  if (configuredDbPath) {
    return resolve(expandHomePrefix(configuredDbPath));
  }
  const home = process.env.BOPO_HOME?.trim() ? expandHomePrefix(process.env.BOPO_HOME.trim()) : join(homedir(), ".bopodev");
  const instanceId = process.env.BOPO_INSTANCE_ID?.trim() || "default";
  return resolve(home, "instances", instanceId, "db", "bopodev.db");
}

function expandHomePrefix(value: string) {
  if (value === "~") {
    return homedir();
  }
  if (value.startsWith("~/")) {
    return resolve(homedir(), value.slice(2));
  }
  return value;
}

function padSummaryValue(value: string) {
  return `| ${value}`;
}

function getDefaultModelForProvider(provider: AgentProvider): string | null {
  if (provider === "codex" || provider === "openai_api") {
    return process.env.BOPO_OPENAI_MODEL?.trim() || "gpt-5";
  }
  if (provider === "claude_code" || provider === "anthropic_api") {
    return process.env.BOPO_ANTHROPIC_MODEL?.trim() || "claude-sonnet-4-6";
  }
  if (provider === "opencode") {
    return process.env.BOPO_OPENCODE_MODEL?.trim() || "opencode/default";
  }
  if (provider === "gemini_cli") {
    return process.env.BOPO_GEMINI_MODEL?.trim() || "gemini-2.5-pro";
  }
  if (provider === "shell") {
    return "n/a";
  }
  return null;
}

function buildModelOptions(provider: AgentProvider, preferredModel?: string) {
  const providerDefault = { value: "", label: "Provider default" };
  const defaultModel = getDefaultModelForProvider(provider);
  const modelIds = new Set<string>();
  const presets = getModelPresetsForProvider(provider);
  for (const model of presets) {
    modelIds.add(model);
  }
  if (preferredModel && preferredModel.trim().length > 0) {
    modelIds.add(preferredModel.trim());
  }
  if (defaultModel) {
    modelIds.add(defaultModel);
  }
  return [
    providerDefault,
    ...Array.from(modelIds).map((model) => ({ value: model, label: model }))
  ];
}

function getModelPresetsForProvider(provider: AgentProvider): string[] {
  if (provider === "codex" || provider === "openai_api") {
    return ["gpt-5", "gpt-5-mini", "gpt-4.1"];
  }
  if (provider === "claude_code" || provider === "anthropic_api") {
    return ["claude-sonnet-4-6", "claude-haiku-4-5", "claude-opus-4-1"];
  }
  if (provider === "gemini_cli") {
    return ["gemini-2.5-pro", "gemini-2.5-flash"];
  }
  if (provider === "opencode") {
    return ["opencode/default"];
  }
  return [];
}

function parseSeedResult(stdout: string): OnboardSeedResult {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const lastLine = lines[lines.length - 1];
  if (!lastLine) {
    throw new Error("onboard:seed did not return a result.");
  }
  const parsed = JSON.parse(lastLine) as Partial<OnboardSeedResult>;
  if (
    typeof parsed.companyId !== "string" ||
    typeof parsed.companyName !== "string" ||
    typeof parsed.companyCreated !== "boolean" ||
    typeof parsed.ceoCreated !== "boolean" ||
    !(parsed.ceoRuntimeModel === null || typeof parsed.ceoRuntimeModel === "string" || typeof parsed.ceoRuntimeModel === "undefined") ||
    typeof parsed.ceoMigrated !== "boolean" ||
    !parseAgentProvider(parsed.ceoProviderType)
  ) {
    throw new Error("onboard:seed returned an invalid result.");
  }
  return {
    companyId: parsed.companyId,
    companyName: parsed.companyName,
    companyCreated: parsed.companyCreated,
    ceoCreated: parsed.ceoCreated,
    ceoProviderType: parseAgentProvider(parsed.ceoProviderType) ?? "shell",
    ceoRuntimeModel: typeof parsed.ceoRuntimeModel === "string" ? parsed.ceoRuntimeModel : null,
    ceoMigrated: parsed.ceoMigrated,
    templateApplied: typeof parsed.templateApplied === "boolean" ? parsed.templateApplied : undefined,
    templateId: typeof parsed.templateId === "string" ? parsed.templateId : null
  };
}

function parseAgentProvider(value: unknown): AgentProvider | null {
  if (
    value === "codex" ||
    value === "claude_code" ||
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

function formatAgentProvider(provider: AgentProvider) {
  if (provider === "codex") {
    return "Codex";
  }
  if (provider === "claude_code") {
    return "Claude Code";
  }
  if (provider === "gemini_cli") {
    return "Gemini";
  }
  if (provider === "opencode") {
    return "OpenCode";
  }
  if (provider === "openai_api") {
    return "OpenAI API (direct)";
  }
  if (provider === "anthropic_api") {
    return "Anthropic API (direct)";
  }
  return "Shell Runtime";
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function hasExistingInstall(workspaceRoot: string): Promise<boolean> {
  const pnpmModulesFile = join(workspaceRoot, "node_modules", ".modules.yaml");
  const packageLockfile = join(workspaceRoot, "pnpm-lock.yaml");
  return (await fileExists(pnpmModulesFile)) && (await fileExists(packageLockfile));
}
