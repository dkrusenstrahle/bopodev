type ProviderType =
  | "claude_code"
  | "codex"
  | "cursor"
  | "opencode"
  | "gemini_cli"
  | "hermes_local"
  | "openai_api"
  | "anthropic_api"
  | "openclaw_gateway"
  | "http"
  | "shell";

type ModelOption = {
  value: string;
  label: string;
};

const DEFAULT_MODEL_VALUE = "";
const defaultModelOption: ModelOption = { value: DEFAULT_MODEL_VALUE, label: "Default" };

const providerModelCatalog: Record<ProviderType, ModelOption[]> = {
  codex: [
    { value: "gpt-5.3-codex", label: "GPT-5.3 Codex" },
    { value: "gpt-5.4", label: "GPT-5.4" },
    { value: "gpt-5.2-codex", label: "GPT-5.2 Codex" },
    { value: "gpt-5.2", label: "GPT-5.2" },
    { value: "gpt-5.1-codex-max", label: "GPT-5.1 Codex Max" },
    { value: "gpt-5.1-codex-mini", label: "GPT-5.1 Codex Mini" }
  ],
  claude_code: [
    { value: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
    { value: "claude-sonnet-4-6-1m", label: "Claude Sonnet 4.6 (1M context)" },
    { value: "claude-opus-4-6", label: "Claude Opus 4.6" },
    { value: "claude-opus-4-6-1m", label: "Claude Opus 4.6 (1M context)" },
    { value: "claude-haiku-4-5", label: "Claude Haiku 4.5" }
  ],
  cursor: [
    { value: "auto", label: "Auto" },
    { value: "gpt-5.3-codex", label: "gpt-5.3-codex" },
    { value: "gpt-5.3-codex-fast", label: "gpt-5.3-codex-fast" },
    { value: "sonnet-4.5", label: "sonnet-4.5" },
    { value: "opus-4.6", label: "opus-4.6" }
  ],
  openai_api: [
    { value: "gpt-5", label: "GPT-5" },
    { value: "gpt-5-mini", label: "GPT-5 Mini" },
    { value: "gpt-5-nano", label: "GPT-5 Nano" },
    { value: "o3", label: "o3" },
    { value: "o4-mini", label: "o4-mini" }
  ],
  anthropic_api: [
    { value: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
    { value: "claude-opus-4-6", label: "Claude Opus 4.6" },
    { value: "claude-haiku-4-5", label: "Claude Haiku 4.5" }
  ],
  opencode: [{ value: "opencode/big-pickle", label: "Big Pickle" }],
  gemini_cli: [
    { value: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
    { value: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
    { value: "gemini-2.5-flash-lite", label: "Gemini 2.5 Flash Lite" },
    { value: "gemini-3.1-flash-lite", label: "Gemini 3.1 Flash Lite" },
    { value: "gemini-3-flash", label: "Gemini 3 Flash" },
    { value: "gemini-3-pro", label: "Gemini 3 Pro" },
    { value: "gemini-3-pro-200k", label: "Gemini 3 Pro (>200k context)" }
  ],
  hermes_local: [{ value: "auto", label: "Auto" }],
  openclaw_gateway: [],
  http: [],
  shell: []
};

export function getSupportedModelOptionsForProvider(providerType: ProviderType) {
  return [defaultModelOption, ...providerModelCatalog[providerType]];
}

export function getModelOptionsForProvider(providerType: ProviderType, currentModel?: string | null) {
  const baseOptions = getSupportedModelOptionsForProvider(providerType);
  const normalizedCurrentModel = currentModel?.trim();
  if (!normalizedCurrentModel) {
    return baseOptions;
  }
  if (baseOptions.some((option) => option.value === normalizedCurrentModel)) {
    return baseOptions;
  }
  return [...baseOptions, { value: normalizedCurrentModel, label: `${normalizedCurrentModel} (current)` }];
}

export function heartbeatCronToIntervalSec(cronExpression: string | undefined, fallbackSeconds = 300) {
  if (!cronExpression) {
    return fallbackSeconds;
  }
  const normalized = cronExpression.trim();
  if (normalized === "* * * * *") {
    return 60;
  }
  const stepMatch = normalized.match(/^\*\/(\d+)\s+\*\s+\*\s+\*\s+\*$/);
  if (stepMatch) {
    const minutes = Number(stepMatch[1]);
    if (Number.isInteger(minutes) && minutes > 0) {
      return minutes * 60;
    }
  }
  const fixedMinuteMatch = normalized.match(/^\d+\s+\*\s+\*\s+\*\s+\*$/);
  if (fixedMinuteMatch) {
    return 3600;
  }
  return fallbackSeconds;
}

export function heartbeatIntervalSecToCron(value: number) {
  const safeSeconds = Number.isFinite(value) ? Math.max(60, Math.floor(value)) : 60;
  const intervalMinutes = Math.max(1, Math.ceil(safeSeconds / 60));
  return intervalMinutes === 1 ? "* * * * *" : `*/${intervalMinutes} * * * *`;
}
