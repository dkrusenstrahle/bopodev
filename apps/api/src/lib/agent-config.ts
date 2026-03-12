import { AgentRuntimeConfigSchema, type AgentRuntimeConfig, type ThinkingEffort } from "bopodev-contracts";

export type LegacyRuntimeFields = {
  runtimeCommand?: string;
  runtimeArgs?: string[];
  runtimeCwd?: string;
  runtimeTimeoutMs?: number;
  runtimeModel?: string;
  runtimeThinkingEffort?: ThinkingEffort;
  bootstrapPrompt?: string;
  runtimeTimeoutSec?: number;
  interruptGraceSec?: number;
  runPolicy?: {
    sandboxMode?: "workspace_write" | "full_access";
    allowWebSearch?: boolean;
  };
  runtimeEnv?: Record<string, string>;
};

export type NormalizedRuntimeConfig = {
  runtimeCommand?: string;
  runtimeArgs: string[];
  runtimeCwd?: string;
  runtimeEnv: Record<string, string>;
  runtimeModel?: string;
  runtimeThinkingEffort: ThinkingEffort;
  bootstrapPrompt?: string;
  runtimeTimeoutSec: number;
  interruptGraceSec: number;
  runPolicy: {
    sandboxMode: "workspace_write" | "full_access";
    allowWebSearch: boolean;
  };
};

export function requiresRuntimeCwd(providerType: string) {
  return (
    providerType === "codex" ||
    providerType === "claude_code" ||
    providerType === "cursor" ||
    providerType === "opencode" ||
    providerType === "gemini_cli" ||
    providerType === "shell"
  );
}

export function resolveDefaultRuntimeModelForProvider(providerType: string | undefined) {
  const normalizedProviderType = providerType?.trim() ?? "";
  if (normalizedProviderType === "claude_code") {
    return "claude-sonnet-4-6";
  }
  if (normalizedProviderType === "codex") {
    return "gpt-5.3-codex";
  }
  if (normalizedProviderType === "opencode") {
    return "opencode/big-pickle";
  }
  if (normalizedProviderType === "gemini_cli") {
    return "gemini-2.5-pro";
  }
  return undefined;
}

export function resolveRuntimeModelForProvider(
  providerType: string | undefined,
  runtimeModel: string | undefined
) {
  const normalizedRuntimeModel = runtimeModel?.trim() || undefined;
  if (normalizedRuntimeModel) {
    return normalizedRuntimeModel;
  }
  return resolveDefaultRuntimeModelForProvider(providerType);
}

export function normalizeRuntimeConfig(input: {
  runtimeConfig?: Partial<AgentRuntimeConfig>;
  legacy?: LegacyRuntimeFields;
  defaultRuntimeCwd?: string;
}): NormalizedRuntimeConfig {
  const runtimeConfig = input.runtimeConfig ?? {};
  const legacy = input.legacy ?? {};
  const merged: Record<string, unknown> = { ...runtimeConfig };

  if (legacy.runtimeCommand !== undefined) {
    merged.runtimeCommand = legacy.runtimeCommand;
  }
  if (legacy.runtimeArgs !== undefined) {
    merged.runtimeArgs = legacy.runtimeArgs;
  }
  if (legacy.runtimeCwd !== undefined) {
    merged.runtimeCwd = legacy.runtimeCwd;
  }
  if (legacy.runtimeModel !== undefined) {
    merged.runtimeModel = legacy.runtimeModel;
  }
  if (legacy.runtimeThinkingEffort !== undefined) {
    merged.runtimeThinkingEffort = legacy.runtimeThinkingEffort;
  }
  if (legacy.bootstrapPrompt !== undefined) {
    merged.bootstrapPrompt = legacy.bootstrapPrompt;
  }
  if (legacy.interruptGraceSec !== undefined) {
    merged.interruptGraceSec = legacy.interruptGraceSec;
  }
  if (legacy.runtimeEnv !== undefined) {
    merged.runtimeEnv = legacy.runtimeEnv;
  }
  if (legacy.runPolicy !== undefined) {
    merged.runPolicy = legacy.runPolicy;
  }

  const parsed = AgentRuntimeConfigSchema.partial().parse({
    ...merged,
    runtimeTimeoutSec:
      runtimeConfig.runtimeTimeoutSec ??
      legacy.runtimeTimeoutSec ??
      toSeconds(legacy.runtimeTimeoutMs) ??
      undefined
  });
  return {
    runtimeCommand: parsed.runtimeCommand?.trim() || undefined,
    runtimeArgs: parsed.runtimeArgs ?? [],
    runtimeCwd: parsed.runtimeCwd?.trim() || input.defaultRuntimeCwd || undefined,
    runtimeEnv: parsed.runtimeEnv ?? {},
    runtimeModel: parsed.runtimeModel?.trim() || undefined,
    runtimeThinkingEffort: parsed.runtimeThinkingEffort ?? "auto",
    bootstrapPrompt: parsed.bootstrapPrompt?.trim() || undefined,
    runtimeTimeoutSec: Math.max(0, parsed.runtimeTimeoutSec ?? 0),
    interruptGraceSec: Math.max(0, parsed.interruptGraceSec ?? 15),
    runPolicy: {
      sandboxMode: parsed.runPolicy?.sandboxMode ?? "workspace_write",
      allowWebSearch: parsed.runPolicy?.allowWebSearch ?? false
    }
  };
}

export function parseRuntimeConfigFromAgentRow(agent: Record<string, unknown>): NormalizedRuntimeConfig {
  const fallback = parseRuntimeFromStateBlob(agent.stateBlob);
  const runtimeArgs = parseStringArray(agent.runtimeArgsJson) ?? fallback.args ?? [];
  const runtimeEnv = parseStringRecord(agent.runtimeEnvJson) ?? fallback.env ?? {};
  const runPolicy = parseRunPolicy(agent.runPolicyJson);
  const timeoutSecFromColumn = toNumber(agent.runtimeTimeoutSec);
  const timeoutSec =
    timeoutSecFromColumn && timeoutSecFromColumn > 0
      ? timeoutSecFromColumn
      : (toSeconds(fallback.timeoutMs) ?? 0);

  const providerType = toText(agent.providerType);
  const runtimeModel = resolveRuntimeModelForProvider(providerType, toText(agent.runtimeModel) ?? fallback.model);

  return {
    runtimeCommand: toText(agent.runtimeCommand) ?? fallback.command,
    runtimeArgs,
    runtimeCwd: toText(agent.runtimeCwd) ?? fallback.cwd,
    runtimeEnv,
    runtimeModel,
    runtimeThinkingEffort: parseThinkingEffort(agent.runtimeThinkingEffort),
    bootstrapPrompt: toText(agent.bootstrapPrompt),
    runtimeTimeoutSec: Math.max(0, timeoutSec),
    interruptGraceSec: Math.max(0, toNumber(agent.interruptGraceSec) ?? 15),
    runPolicy
  };
}

export function runtimeConfigToDb(runtime: NormalizedRuntimeConfig) {
  return {
    runtimeCommand: runtime.runtimeCommand ?? null,
    runtimeArgsJson: JSON.stringify(runtime.runtimeArgs),
    runtimeCwd: runtime.runtimeCwd ?? null,
    runtimeEnvJson: JSON.stringify(runtime.runtimeEnv),
    runtimeModel: runtime.runtimeModel ?? null,
    runtimeThinkingEffort: runtime.runtimeThinkingEffort,
    bootstrapPrompt: runtime.bootstrapPrompt ?? null,
    runtimeTimeoutSec: runtime.runtimeTimeoutSec,
    interruptGraceSec: runtime.interruptGraceSec,
    runPolicyJson: JSON.stringify(runtime.runPolicy)
  };
}

export function runtimeConfigToStateBlobPatch(runtime: NormalizedRuntimeConfig) {
  return {
    runtime: {
      command: runtime.runtimeCommand,
      args: runtime.runtimeArgs,
      cwd: runtime.runtimeCwd,
      env: runtime.runtimeEnv,
      timeoutMs: runtime.runtimeTimeoutSec > 0 ? runtime.runtimeTimeoutSec * 1000 : undefined
    },
    promptTemplate: runtime.bootstrapPrompt
  };
}

function parseRuntimeFromStateBlob(raw: unknown) {
  if (typeof raw !== "string" || !raw.trim()) {
    return {} as {
      command?: string;
      args?: string[];
      cwd?: string;
      env?: Record<string, string>;
      model?: string;
      timeoutMs?: number;
    };
  }
  try {
    const parsed = JSON.parse(raw) as {
      runtime?: {
        command?: unknown;
        args?: unknown;
        cwd?: unknown;
        env?: unknown;
        model?: unknown;
        timeoutMs?: unknown;
      };
    };
    const runtime = parsed.runtime ?? {};
    return {
      command: typeof runtime.command === "string" ? runtime.command : undefined,
      args: Array.isArray(runtime.args) ? runtime.args.map((entry) => String(entry)) : undefined,
      cwd: typeof runtime.cwd === "string" ? runtime.cwd : undefined,
      env: toRecord(runtime.env),
      model: typeof runtime.model === "string" && runtime.model.trim().length > 0 ? runtime.model.trim() : undefined,
      timeoutMs: toNumber(runtime.timeoutMs)
    };
  } catch {
    return {};
  }
}

function parseStringArray(raw: unknown) {
  if (typeof raw !== "string") {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.map((entry) => String(entry)) : null;
  } catch {
    return null;
  }
}

function parseStringRecord(raw: unknown) {
  if (typeof raw !== "string") {
    return null;
  }
  try {
    return toRecord(JSON.parse(raw));
  } catch {
    return null;
  }
}

function parseRunPolicy(raw: unknown) {
  const parsed = parseStringRecord(raw) as { sandboxMode?: unknown; allowWebSearch?: unknown } | null;
  return {
    sandboxMode: parsed?.sandboxMode === "full_access" ? "full_access" : "workspace_write",
    allowWebSearch: Boolean(parsed?.allowWebSearch)
  } as const;
}

function parseThinkingEffort(raw: unknown): ThinkingEffort {
  return raw === "low" || raw === "medium" || raw === "high" ? raw : "auto";
}

function toRecord(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => typeof item === "string")
  ) as Record<string, string>;
}

function toText(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function toNumber(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function toSeconds(milliseconds: unknown) {
  const parsedMs = toNumber(milliseconds);
  if (parsedMs === undefined) {
    return undefined;
  }
  return Math.max(0, Math.floor(parsedMs / 1000));
}
