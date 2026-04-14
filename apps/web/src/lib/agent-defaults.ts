import { heartbeatCronToIntervalSec } from "@/lib/agent-runtime-options";

export interface AgentRuntimeDefaults {
  providerType:
    | "claude_code"
    | "codex"
    | "opencode"
    | "gemini_cli"
    | "hermes_local"
    | "openai_api"
    | "anthropic_api"
    | "openclaw_gateway"
    | "http"
    | "shell";
  heartbeatIntervalSec: string;
  monthlyBudgetUsd: string;
  runtimeCommand: string;
  runtimeArgs: string;
  runtimeCwd: string;
  runtimeModel: string;
  runtimeThinkingEffort: "auto" | "low" | "medium" | "high";
  bootstrapPrompt: string;
  runtimeEnv: string;
  runtimeTimeoutSec: string;
  interruptGraceSec: string;
  sandboxMode: "workspace_write" | "full_access";
  allowWebSearch: boolean;
}

export const agentDefaultsStorageKey = "bopodev_agent_defaults";

export const defaultAgentRuntimeDefaults: AgentRuntimeDefaults = {
  providerType: "claude_code",
  heartbeatIntervalSec: "300",
  monthlyBudgetUsd: "30",
  runtimeCommand: "",
  runtimeArgs: "",
  runtimeCwd: process.env.NEXT_PUBLIC_DEFAULT_RUNTIME_CWD ?? "",
  runtimeModel: "",
  runtimeThinkingEffort: "auto",
  bootstrapPrompt: "",
  runtimeEnv: "",
  runtimeTimeoutSec: "0",
  interruptGraceSec: "15",
  sandboxMode: "workspace_write",
  allowWebSearch: false
};

export function readAgentRuntimeDefaults(): AgentRuntimeDefaults {
  if (typeof window === "undefined") {
    return defaultAgentRuntimeDefaults;
  }

  const raw = window.localStorage.getItem(agentDefaultsStorageKey);
  if (!raw) {
    return defaultAgentRuntimeDefaults;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<AgentRuntimeDefaults> & { heartbeatCron?: unknown };
    const parsedHeartbeatIntervalSec = (() => {
      if (typeof parsed.heartbeatIntervalSec === "string" && parsed.heartbeatIntervalSec.trim()) {
        const parsedSeconds = Number(parsed.heartbeatIntervalSec.trim());
        if (Number.isFinite(parsedSeconds) && parsedSeconds >= 60) {
          return String(Math.floor(parsedSeconds));
        }
      }
      if (typeof parsed.heartbeatCron === "string" && parsed.heartbeatCron.trim()) {
        return String(heartbeatCronToIntervalSec(parsed.heartbeatCron, 300));
      }
      return defaultAgentRuntimeDefaults.heartbeatIntervalSec;
    })();
    return {
      providerType: isProviderType(parsed.providerType) ? parsed.providerType : defaultAgentRuntimeDefaults.providerType,
      heartbeatIntervalSec: parsedHeartbeatIntervalSec,
      monthlyBudgetUsd:
        typeof parsed.monthlyBudgetUsd === "string" && parsed.monthlyBudgetUsd.trim()
          ? parsed.monthlyBudgetUsd
          : defaultAgentRuntimeDefaults.monthlyBudgetUsd,
      runtimeCommand: typeof parsed.runtimeCommand === "string" ? parsed.runtimeCommand : defaultAgentRuntimeDefaults.runtimeCommand,
      runtimeArgs: typeof parsed.runtimeArgs === "string" ? parsed.runtimeArgs : defaultAgentRuntimeDefaults.runtimeArgs,
      runtimeCwd: typeof parsed.runtimeCwd === "string" ? parsed.runtimeCwd : defaultAgentRuntimeDefaults.runtimeCwd,
      runtimeModel: typeof parsed.runtimeModel === "string" ? parsed.runtimeModel : defaultAgentRuntimeDefaults.runtimeModel,
      runtimeThinkingEffort:
        parsed.runtimeThinkingEffort === "low" ||
        parsed.runtimeThinkingEffort === "medium" ||
        parsed.runtimeThinkingEffort === "high" ||
        parsed.runtimeThinkingEffort === "auto"
          ? parsed.runtimeThinkingEffort
          : defaultAgentRuntimeDefaults.runtimeThinkingEffort,
      bootstrapPrompt:
        typeof parsed.bootstrapPrompt === "string" ? parsed.bootstrapPrompt : defaultAgentRuntimeDefaults.bootstrapPrompt,
      runtimeEnv: typeof parsed.runtimeEnv === "string" ? parsed.runtimeEnv : defaultAgentRuntimeDefaults.runtimeEnv,
      runtimeTimeoutSec:
        typeof parsed.runtimeTimeoutSec === "string"
          ? parsed.runtimeTimeoutSec
          : defaultAgentRuntimeDefaults.runtimeTimeoutSec,
      interruptGraceSec:
        typeof parsed.interruptGraceSec === "string"
          ? parsed.interruptGraceSec
          : defaultAgentRuntimeDefaults.interruptGraceSec,
      sandboxMode:
        parsed.sandboxMode === "full_access" || parsed.sandboxMode === "workspace_write"
          ? parsed.sandboxMode
          : defaultAgentRuntimeDefaults.sandboxMode,
      allowWebSearch:
        typeof parsed.allowWebSearch === "boolean" ? parsed.allowWebSearch : defaultAgentRuntimeDefaults.allowWebSearch
    };
  } catch {
    return defaultAgentRuntimeDefaults;
  }
}

export function writeAgentRuntimeDefaults(defaults: AgentRuntimeDefaults) {
  if (typeof window === "undefined") {
    return;
  }
  window.localStorage.setItem(agentDefaultsStorageKey, JSON.stringify(defaults));
}

function isProviderType(value: unknown): value is AgentRuntimeDefaults["providerType"] {
  return (
    value === "claude_code" ||
    value === "codex" ||
    value === "opencode" ||
    value === "gemini_cli" ||
    value === "hermes_local" ||
    value === "openai_api" ||
    value === "anthropic_api" ||
    value === "openclaw_gateway" ||
    value === "http" ||
    value === "shell"
  );
}
