import { mkdir } from "node:fs/promises";
import type { BopoDb } from "bopodev-db";
import {
  executeAgentRuntime,
  executePromptRuntime,
  ensureOpenCodeModelConfiguredAndAvailable,
  hasTrustFlag,
  resolveCursorLaunchConfig,
  type AgentRuntimeConfig,
  type RuntimeExecutionOutput
} from "bopodev-agent-sdk";
import {
  normalizeRuntimeConfig,
  resolveDefaultRuntimeModelForProvider,
  requiresRuntimeCwd
} from "../lib/agent-config";
import { resolveDefaultRuntimeCwdForCompany } from "../lib/workspace-policy";
import { buildCompanyAssistantContextSnapshot } from "./company-assistant-context-snapshot";
import type { AskCliBrainId } from "./company-assistant-brain";

const MAX_EXTRACTED_CLI_CHARS = 60_000;

function codexStdoutLooksLikeNdjsonStream(stdout: string): boolean {
  const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) {
    return false;
  }
  let jsonLines = 0;
  for (const line of lines) {
    if (!line.startsWith("{")) {
      return false;
    }
    try {
      JSON.parse(line);
      jsonLines++;
    } catch {
      return false;
    }
  }
  return jsonLines > 0;
}

/**
 * Codex `--json` / stream-json stdout is newline-delimited JSON events.
 * Prefer the last completed assistant-facing item; never treat `turn.completed` metadata as the reply if it looks like JSON.
 */
function extractCodexStreamAssistantText(stdout: string): string | null {
  let lastMessage: string | null = null;
  let lastTurnResult: string | null = null;
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith("{")) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object") {
      continue;
    }
    const rec = parsed as Record<string, unknown>;
    const type = typeof rec.type === "string" ? rec.type : "";
    if (type === "item.completed") {
      const item = rec.item;
      if (!item || typeof item !== "object") {
        continue;
      }
      const ir = item as Record<string, unknown>;
      const itemType = typeof ir.type === "string" ? ir.type.toLowerCase() : "";
      if (
        itemType === "tool_use" ||
        itemType === "tool_result" ||
        itemType === "command_execution" ||
        itemType === "reasoning"
      ) {
        continue;
      }
      if (itemType === "agent_message" || itemType === "agentmessage" || itemType === "message") {
        const text = extractCodexAgentMessageItemText(ir);
        if (text) {
          lastMessage = text;
        }
      }
      continue;
    }
    if (type === "turn.completed") {
      const result = typeof rec.result === "string" ? rec.result.trim() : "";
      if (result && !result.startsWith("{") && !result.startsWith("[")) {
        lastTurnResult = result;
      }
    }
  }
  const chosen = lastMessage ?? lastTurnResult;
  if (!chosen) {
    return null;
  }
  return chosen.length > MAX_EXTRACTED_CLI_CHARS ? `${chosen.slice(0, MAX_EXTRACTED_CLI_CHARS)}\n…(truncated)` : chosen;
}

function extractCodexAgentMessageItemText(item: Record<string, unknown>): string {
  if (typeof item.text === "string" && item.text.trim()) {
    return item.text.trim();
  }
  if (typeof item.message === "string" && item.message.trim()) {
    return item.message.trim();
  }
  const content = item.content;
  if (Array.isArray(content)) {
    const parts = content.map((c) => {
      if (typeof c === "string") {
        return c;
      }
      if (c && typeof c === "object" && !Array.isArray(c)) {
        const o = c as Record<string, unknown>;
        if (typeof o.text === "string") {
          return o.text;
        }
      }
      return "";
    });
    const joined = parts.join("").trim();
    if (joined) {
      return joined;
    }
  }
  return "";
}

function extractAssistantBodyFromRuntime(out: RuntimeExecutionOutput, providerType: AskCliBrainId): string {
  const comment = out.finalRunOutput?.employee_comment?.trim();
  if (comment) {
    return comment;
  }
  // Codex NDJSON: prefer last agent_message over parsedUsage (often token / turn metadata, not the reply).
  if (providerType === "codex") {
    const fromStream = extractCodexStreamAssistantText(out.stdout ?? "");
    if (fromStream) {
      return fromStream;
    }
    if (codexStdoutLooksLikeNdjsonStream(out.stdout ?? "")) {
      return [
        "I ran Codex but only got internal stream events back—no final message to show you.",
        "",
        "Try asking again in one short sentence, pick another brain (e.g. Claude Code or Cursor), or run `codex login` / update the CLI if you expect Codex to reply here."
      ].join("\n");
    }
  }
  const summary = out.parsedUsage?.summary?.trim();
  if (summary) {
    return summary;
  }
  const stdout = out.stdout?.trim();
  if (stdout) {
    return stdout.length > MAX_EXTRACTED_CLI_CHARS
      ? `${stdout.slice(0, MAX_EXTRACTED_CLI_CHARS)}\n…(truncated)`
      : stdout;
  }
  if (!out.ok) {
    const err = out.stderr?.trim() || out.failureType || "runtime error";
    return `Assistant runtime failed (${out.failureType ?? "error"}, exit ${out.code ?? "?"}): ${err.slice(0, 4000)}`;
  }
  return "No output from assistant runtime.";
}

function buildOwnerCliInstructions(ceoDisplayName: string) {
  return [
    `You are **${ceoDisplayName}**, the company's CEO in Bopo. The owner/operator is chatting with you in Chat—reply like a real person: short paragraphs, plain language, warm and direct. Use contractions when they sound natural.`,
    "Use ONLY the JSON snapshot below for factual claims (issues, goals, agents, memory, approvals, runs, **costAndUsage**). For spend/tokens: **`monthToDateUtc`** is the full UTC calendar month to date (exact DB sum); **`allTime`** is lifetime totals; **`recentSample`** is just the newest rows for examples—never treat its `totalsInListedRows` as monthly figures. If something is not in the snapshot, say you do not have it—do not invent data.",
    "Do **not** paste raw JSON, NDJSON lines, token counts, thread ids, or CLI event logs. Summarize what matters in sentences. Use a short bullet list only when comparing several items.",
    "When the runtime expects structured JSON, put your natural-language answer for the operator in employee_comment (or the tool’s primary summary field)."
  ].join("\n");
}

function assistantCliTimeoutMs(runtimeTimeoutSec: number): number {
  if (runtimeTimeoutSec > 0) {
    return Math.min(30 * 60 * 1000, runtimeTimeoutSec * 1000);
  }
  const env = Number(process.env.BOPO_ASSISTANT_CLI_TIMEOUT_MS);
  if (Number.isFinite(env) && env > 0) {
    return Math.min(30 * 60 * 1000, Math.max(120_000, env));
  }
  return 15 * 60 * 1000;
}

async function resolveOwnerAssistantNormalizedRuntime(db: BopoDb, companyId: string) {
  const defaultCwd = await resolveDefaultRuntimeCwdForCompany(db, companyId);
  await mkdir(defaultCwd, { recursive: true });
  return normalizeRuntimeConfig({ legacy: {}, defaultRuntimeCwd: defaultCwd });
}

function ownerAssistantBaseEnv(companyId: string): Record<string, string> {
  return {
    BOPODEV_COMPANY_ID: companyId,
    BOPODEV_ACTOR_TYPE: "human",
    BOPODEV_ACTOR_ID: "owner_assistant",
    BOPODEV_ACTOR_COMPANIES: companyId
  };
}

async function buildOwnerCliPrompt(
  db: BopoDb,
  companyId: string,
  userMessage: string,
  ceoDisplayName: string
) {
  const snapshot = await buildCompanyAssistantContextSnapshot(db, companyId, userMessage);
  return [
    buildOwnerCliInstructions(ceoDisplayName),
    "",
    "## Operator question",
    userMessage,
    "",
    "## Company snapshot (JSON)",
    snapshot
  ].join("\n");
}

export async function runCompanyAssistantBrainCliTurn(input: {
  db: BopoDb;
  companyId: string;
  providerType: AskCliBrainId;
  userMessage: string;
  ceoDisplayName: string;
}): Promise<{ assistantBody: string; provider: string; elapsedMs: number }> {
  const { providerType } = input;
  const n = await resolveOwnerAssistantNormalizedRuntime(input.db, input.companyId);
  const cwd = n.runtimeCwd?.trim();
  if (requiresRuntimeCwd(providerType) && !cwd) {
    throw new Error("Could not resolve a runtime working directory for this company.");
  }
  const timeoutMs = assistantCliTimeoutMs(n.runtimeTimeoutSec);
  const baseEnv = { ...ownerAssistantBaseEnv(input.companyId), ...n.runtimeEnv };
  const model = n.runtimeModel?.trim() || resolveDefaultRuntimeModelForProvider(providerType) || "";

  const prompt = await buildOwnerCliPrompt(
    input.db,
    input.companyId,
    input.userMessage,
    input.ceoDisplayName
  );
  const started = Date.now();

  if (providerType === "codex" || providerType === "claude_code") {
    const config: AgentRuntimeConfig = {
      command: n.runtimeCommand,
      args: n.runtimeArgs,
      cwd,
      timeoutMs,
      interruptGraceSec: n.interruptGraceSec,
      retryCount: providerType === "codex" ? 1 : 0,
      env: baseEnv,
      model: model || undefined,
      thinkingEffort: n.runtimeThinkingEffort,
      bootstrapPrompt: n.bootstrapPrompt,
      runPolicy: n.runPolicy
    };
    const runtime = await executeAgentRuntime(providerType, prompt, config);
    return {
      assistantBody: extractAssistantBodyFromRuntime(runtime, providerType),
      provider: providerType,
      elapsedMs: Date.now() - started
    };
  }

  if (providerType === "gemini_cli") {
    const command = n.runtimeCommand?.trim() || "gemini";
    const args = ["--output-format", "stream-json", "--approval-mode", "yolo", "--sandbox=none"];
    if (model) {
      args.push("--model", model);
    }
    args.push(...(n.runtimeArgs ?? []));
    args.push(prompt);
    const runtime = await executePromptRuntime(
      command,
      prompt,
      {
        cwd: cwd!,
        args,
        timeoutMs,
        retryCount: 0,
        env: baseEnv,
        model: model || undefined,
        interruptGraceSec: n.interruptGraceSec
      },
      { provider: "gemini_cli" }
    );
    return {
      assistantBody: extractAssistantBodyFromRuntime(runtime, providerType),
      provider: providerType,
      elapsedMs: Date.now() - started
    };
  }

  if (providerType === "opencode") {
    const resolvedModel = model || resolveDefaultRuntimeModelForProvider("opencode");
    if (!resolvedModel) {
      throw new Error("OpenCode requires a model id (provider/model format).");
    }
    await ensureOpenCodeModelConfiguredAndAvailable({
      model: resolvedModel,
      command: n.runtimeCommand,
      cwd,
      env: baseEnv
    });
    const cmd = n.runtimeCommand?.trim() || "opencode";
    const args = ["run", "--format", "json", "--model", resolvedModel, ...(n.runtimeArgs ?? [])];
    const runtime = await executePromptRuntime(
      cmd,
      prompt,
      {
        cwd: cwd!,
        args,
        timeoutMs,
        retryCount: 0,
        env: baseEnv,
        model: resolvedModel,
        interruptGraceSec: n.interruptGraceSec
      },
      { provider: "opencode" }
    );
    return {
      assistantBody: extractAssistantBodyFromRuntime(runtime, providerType),
      provider: providerType,
      elapsedMs: Date.now() - started
    };
  }

  if (providerType === "cursor") {
    const cursorLaunch = await resolveCursorLaunchConfig({
      command: n.runtimeCommand,
      args: n.runtimeArgs,
      cwd,
      env: baseEnv
    });
    const c = cwd!;
    const buildArgs = () => {
      const baseArgs = [...cursorLaunch.prefixArgs, "-p", "--output-format", "stream-json", "--workspace", c];
      if (model) {
        baseArgs.push("--model", model);
      }
      if (!hasTrustFlag(n.runtimeArgs ?? [])) {
        baseArgs.push("--yolo");
      }
      return [...baseArgs, ...(n.runtimeArgs ?? [])];
    };
    const runtime = await executePromptRuntime(
      cursorLaunch.command,
      prompt,
      {
        cwd: c,
        args: buildArgs(),
        timeoutMs,
        retryCount: 0,
        env: baseEnv,
        model: model || undefined,
        interruptGraceSec: n.interruptGraceSec
      },
      { provider: "cursor" }
    );
    return {
      assistantBody: extractAssistantBodyFromRuntime(runtime, providerType),
      provider: providerType,
      elapsedMs: Date.now() - started
    };
  }

  throw new Error(`CLI assistant not implemented for ${providerType}.`);
}
