import { getAdapterMetadata } from "bopodev-agent-sdk";

/** CLI/local runtimes only (no direct API keys in Chat). */
export const ASK_ASSISTANT_BRAIN_IDS = [
  "claude_code",
  "codex",
  "cursor",
  "opencode",
  "gemini_cli"
] as const;

export type AskAssistantBrainId = (typeof ASK_ASSISTANT_BRAIN_IDS)[number];

export type AskCliBrainId = AskAssistantBrainId;

const ASK_BRAIN_SET = new Set<string>(ASK_ASSISTANT_BRAIN_IDS);

/** Default when the client omits `brain` (env `BOPO_CHAT_DEFAULT_BRAIN` if set and valid, else codex). */
export const DEFAULT_ASK_ASSISTANT_BRAIN: AskAssistantBrainId = "codex";

const CLI_BRAINS = ASK_BRAIN_SET;

export function listAskAssistantBrains() {
  return getAdapterMetadata()
    .filter((m) => ASK_BRAIN_SET.has(m.providerType))
    .map((m) => ({
      providerType: m.providerType,
      label: m.label,
      requiresRuntimeCwd: m.requiresRuntimeCwd
    }));
}

export function parseAskBrain(raw?: string | null): string {
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  if (!trimmed) {
    const env = process.env.BOPO_CHAT_DEFAULT_BRAIN?.trim();
    if (env && ASK_BRAIN_SET.has(env)) {
      return env;
    }
    return DEFAULT_ASK_ASSISTANT_BRAIN;
  }
  if (!ASK_BRAIN_SET.has(trimmed)) {
    throw new Error(`Unsupported assistant brain "${trimmed}".`);
  }
  return trimmed;
}

export function isAskCliBrain(brain: string): boolean {
  return CLI_BRAINS.has(brain);
}
