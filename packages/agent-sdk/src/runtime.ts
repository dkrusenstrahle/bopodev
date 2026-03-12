import { spawn } from "node:child_process";
import { access, cp, lstat, mkdir, mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentRuntimeConfig } from "./types";

type LocalProvider = "claude_code" | "codex" | "cursor" | "opencode" | "gemini_cli";
type ClaudeContractDiagnostics = {
  commandOverride: boolean;
  commandLooksClaude: boolean;
  commandWasProviderAlias: boolean;
  hasPromptFlag: boolean;
  hasOutputFormatJson: boolean;
  outputFormat: string | null;
  hasMaxTurnsFlag: boolean;
  hasVerboseFlag: boolean;
  hasDangerouslySkipPermissions: boolean;
  hasJsonSchema: boolean;
  missingRequiredArgs: string[];
};

type ParsedUsageRecord = {
  tokenInput?: number;
  tokenOutput?: number;
  usdCost?: number;
  summary?: string;
};

type CursorParsedStream = {
  usage: ParsedUsageRecord;
  sessionId?: string;
  errorMessage?: string;
  resultSubtype?: string;
};

type TranscriptSignalLevel = "high" | "medium" | "low" | "noise";
type TranscriptSource = "stdout" | "stderr" | "trace_fallback";

export interface RuntimeExecutionOutput {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  elapsedMs: number;
  attemptCount: number;
  failureType?: "timeout" | "spawn_error" | "nonzero_exit";
  attempts: RuntimeAttemptTrace[];
  parsedUsage?: {
    tokenInput?: number;
    tokenOutput?: number;
    usdCost?: number;
    summary?: string;
  };
  structuredOutputSource?: "stdout" | "stderr";
  structuredOutputDiagnostics?: {
    stdoutJsonObjectCount: number;
    stderrJsonObjectCount: number;
    stderrStructuredUsageDetected: boolean;
    stdoutBytes: number;
    stderrBytes: number;
    hasAnyOutput: boolean;
    lastStdoutLine?: string;
    lastStderrLine?: string;
    likelyCause:
      | "no_output_from_runtime"
      | "json_missing"
      | "json_on_stderr_only"
      | "schema_or_shape_mismatch";
    claudeStopReason?: string;
    claudeResultSubtype?: string;
    claudeSessionId?: string;
    claudeContract?: ClaudeContractDiagnostics;
  };
  commandUsed?: string;
  argsUsed?: string[];
  transcript?: RuntimeTranscriptEvent[];
}

export interface RuntimeTranscriptEvent {
  kind: "system" | "assistant" | "thinking" | "tool_call" | "tool_result" | "result" | "stderr";
  label?: string;
  text?: string;
  payload?: string;
  signalLevel?: TranscriptSignalLevel;
  groupKey?: string;
  source?: TranscriptSource;
}

export interface RuntimeAttemptTrace {
  attempt: number;
  code: number | null;
  timedOut: boolean;
  elapsedMs: number;
  signal: NodeJS.Signals | null;
  spawnErrorCode?: string;
  forcedKill: boolean;
}

export interface RuntimeCommandHealth {
  command: string;
  available: boolean;
  exitCode: number | null;
  elapsedMs: number;
  error?: string;
}

function pickDefaultCommand(provider: "claude_code" | "codex") {
  if (provider === "claude_code") {
    return "claude";
  }
  return "codex";
}

function providerDefaultArgs(provider: "claude_code" | "codex", config?: AgentRuntimeConfig) {
  if (provider === "claude_code") {
    return [
      "--print",
      "-",
      "--output-format",
      "stream-json",
      "--verbose",
      "--max-turns",
      "8",
      "--dangerously-skip-permissions"
    ];
  }
  // Keep Codex non-interactive, sandboxed, and writable in-workspace by default.
  // Codex CLI rejects combining --full-auto with sandbox bypass flags.
  if (shouldBypassCodexSandbox(config)) {
    return ["exec", "--skip-git-repo-check"];
  }
  // Include skip-git-repo-check to allow execution from deterministic fallback workspaces
  // that may not be trusted git directories.
  return ["exec", "--full-auto", "--skip-git-repo-check"];
}

function providerConfigArgs(provider: "claude_code" | "codex", config?: AgentRuntimeConfig) {
  const args: string[] = [];
  if (provider === "codex") {
    if (config?.model?.trim()) {
      args.push("--model", config.model.trim());
    }
    if (config?.thinkingEffort && config.thinkingEffort !== "auto") {
      args.push("--reasoning-effort", config.thinkingEffort);
    }
    if (config?.runPolicy?.allowWebSearch) {
      args.push("--search");
    }
    if (shouldBypassCodexSandbox(config)) {
      args.push("--dangerously-bypass-approvals-and-sandbox");
    }
  }
  if (provider === "claude_code") {
    if (config?.model?.trim()) {
      args.push("--model", config.model.trim());
    }
    if (config?.thinkingEffort && config.thinkingEffort !== "auto") {
      args.push("--effort", config.thinkingEffort);
    }
    if (config?.runPolicy?.sandboxMode === "full_access") {
      args.push("--dangerously-skip-permissions");
    }
  }
  return args;
}

function resolveControlPlaneEnvValue(env: NodeJS.ProcessEnv | Record<string, string> | undefined, suffix: string) {
  if (!env) {
    return "";
  }
  return String(env[`BOPODEV_${suffix}`] ?? "").trim();
}

function shouldBypassCodexSandbox(config?: AgentRuntimeConfig) {
  if (config?.runPolicy?.sandboxMode === "full_access") {
    return true;
  }
  const env = config?.env;
  if (!env) {
    return false;
  }
  const hasControlPlaneContext =
    resolveControlPlaneEnvValue(env, "API_BASE_URL").length > 0 &&
    resolveControlPlaneEnvValue(env, "REQUEST_HEADERS_JSON").length > 0;
  if (!hasControlPlaneContext) {
    return false;
  }
  const enforceSandbox = resolveControlPlaneEnvValue(env, "ENFORCE_SANDBOX").toLowerCase();
  if (enforceSandbox === "1" || enforceSandbox === "true") {
    return false;
  }
  return true;
}

export async function executeAgentRuntime(
  provider: "claude_code" | "codex",
  prompt: string,
  config?: AgentRuntimeConfig
): Promise<RuntimeExecutionOutput> {
  const command = resolveProviderCommand(provider, config?.command);
  const commandOverride = Boolean(config?.command && config.command.trim().length > 0);
  const effectiveRetryCount = config?.retryCount ?? (provider === "codex" ? 1 : 0);
  const candidateArgs = [
    ...(commandOverride ? [] : providerDefaultArgs(provider, config)),
    ...(commandOverride ? [] : providerConfigArgs(provider, config)),
    ...(config?.args ?? [])
  ];
  const mergedArgs =
    provider === "claude_code"
      ? ensureClaudeStructuredOutputArgs(command, candidateArgs)
      : candidateArgs;
  let runtime = await executePromptRuntime(
    command,
    prompt,
    {
      ...config,
      args: mergedArgs,
      retryCount: effectiveRetryCount,
      timeoutMs: config?.timeoutMs ?? defaultProviderTimeoutMs(provider)
    },
    {
      provider,
      claudeContract:
        provider === "claude_code" ? inspectClaudeOutputContract(command, mergedArgs, commandOverride) : undefined
    }
  );
  if (provider !== "claude_code") {
    return runtime;
  }

  const maxContinuationAttempts = 2;
  let continuationArgs = [...mergedArgs];
  for (let continuation = 0; continuation < maxContinuationAttempts; continuation += 1) {
    if (!runtime.ok) {
      break;
    }
    if (!isClaudeMaxTurnsRuntime(runtime)) {
      break;
    }
    const sessionId = runtime.structuredOutputDiagnostics?.claudeSessionId?.trim();
    if (!sessionId) {
      break;
    }
    continuationArgs = withClaudeResumeArg(continuationArgs, sessionId);
    runtime = await executePromptRuntime(
      command,
      "Continue from current session and finish all remaining assigned issue steps.",
      {
        ...config,
        args: continuationArgs,
        retryCount: 0,
        timeoutMs: config?.timeoutMs ?? defaultProviderTimeoutMs(provider)
      },
      {
        provider,
        claudeContract: inspectClaudeOutputContract(command, continuationArgs, true)
      }
    );
  }

  return runtime;
}

function defaultProviderTimeoutMs(provider: "claude_code" | "codex") {
  if (provider === "claude_code") {
    return 15 * 60 * 1000;
  }
  return 15 * 60 * 1000;
}

export async function executePromptRuntime(
  command: string,
  prompt: string,
  config?: AgentRuntimeConfig,
  options?: {
    provider?: LocalProvider;
    claudeContract?: ClaudeContractDiagnostics;
  }
): Promise<RuntimeExecutionOutput> {
  const baseArgs = [...(config?.args ?? [])];
  const timeoutMs = config?.timeoutMs ?? 15 * 60 * 1000;
  const abortSignal = config?.abortSignal;
  const interruptGraceMs = Math.max(0, config?.interruptGraceSec ?? 2) * 1000;
  const maxAttempts = Math.max(1, Math.min(3, 1 + (config?.retryCount ?? 0)));
  const retryBackoffMs = Math.max(100, config?.retryBackoffMs ?? 400);
  const mergedEnv = {
    ...process.env,
    ...(config?.env ?? {})
  };
  const normalizedEnv = normalizeProviderAuthEnv(options?.provider, mergedEnv);
  const providerIsolation = await withProviderRuntimeIsolation(options?.provider, normalizedEnv);
  const env = providerIsolation.env;
  const provider = options?.provider;
  const injection = await prepareSkillInjection(provider, env);
  const baseWithInjection = [...baseArgs, ...injection.additionalArgs];
  const readsPromptFromStdin =
    (provider === "claude_code" && hasCliFlagValue(baseWithInjection, "--print", "-")) ||
    (provider === "cursor" && (baseWithInjection.includes("-p") || hasCliFlag(baseWithInjection, "--print"))) ||
    provider === "opencode";
  const promptIsInArgs = provider === "gemini_cli" && baseWithInjection.length > 0;
  const args = readsPromptFromStdin ? baseWithInjection : promptIsInArgs ? baseWithInjection : [...baseWithInjection, prompt];
  const attempts: RuntimeAttemptTrace[] = [];
  let streamedEventCount = 0;
  const emitTranscriptEvent = (event: RuntimeTranscriptEvent) => {
    if (!config?.onTranscriptEvent || streamedEventCount >= 2000) {
      return;
    }
    streamedEventCount += 1;
    config.onTranscriptEvent(event);
  };
  let stdout = "";
  let stderr = injection.warning ? `${injection.warning}\n` : "";
  let lastResult:
    | {
        code: number | null;
        timedOut: boolean;
        elapsedMs: number;
        signal: NodeJS.Signals | null;
        spawnErrorCode?: string;
        forcedKill: boolean;
      }
    | undefined;
  try {
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const attemptResult = await executeSinglePromptAttempt(
        command,
        args,
        readsPromptFromStdin ? prompt : undefined,
        config?.cwd || process.cwd(),
        env,
        timeoutMs,
        interruptGraceMs,
        abortSignal,
        {
          provider,
          onStdoutChunk: (chunk) => emitStreamingTranscriptEvents(provider, "stdout", chunk, emitTranscriptEvent),
          onStderrChunk: (chunk) => emitStreamingTranscriptEvents(provider, "stderr", chunk, emitTranscriptEvent)
        }
      );
      const normalizedStderr = provider === "codex" ? stripCodexRolloutNoise(attemptResult.stderr) : attemptResult.stderr;
      stdout += attemptResult.stdout;
      stderr = [stderr, normalizedStderr].filter(Boolean).join("\n").trim();
      attempts.push({
        attempt,
        code: attemptResult.code,
        timedOut: attemptResult.timedOut,
        elapsedMs: attemptResult.elapsedMs,
        signal: attemptResult.signal,
        spawnErrorCode: attemptResult.spawnErrorCode,
        forcedKill: attemptResult.forcedKill
      });
      lastResult = {
        code: attemptResult.code,
        timedOut: attemptResult.timedOut,
        elapsedMs: attemptResult.elapsedMs,
        signal: attemptResult.signal,
        spawnErrorCode: attemptResult.spawnErrorCode,
        forcedKill: attemptResult.forcedKill
      };

      if (attemptResult.ok) {
        const claudeStream = provider === "claude_code" ? parseClaudeStreamOutput(stdout) : undefined;
        const cursorStream = provider === "cursor" ? parseCursorStreamOutput(stdout) : undefined;
        const geminiStream = provider === "gemini_cli" ? parseGeminiStreamOutput(stdout, stderr) : undefined;
        const stdoutUsage = cursorStream?.usage ?? claudeStream?.usage ?? geminiStream?.usage ?? parseStructuredUsage(stdout);
        const stderrUsage = parseStructuredUsage(stderr);
        return {
          ok: true,
          code: attemptResult.code,
          stdout,
          stderr,
          timedOut: false,
          elapsedMs: attempts.reduce((sum, item) => sum + item.elapsedMs, 0),
          attemptCount: attempts.length,
          attempts,
          parsedUsage: stdoutUsage ?? stderrUsage,
          structuredOutputSource: stdoutUsage ? "stdout" : stderrUsage ? "stderr" : undefined,
          structuredOutputDiagnostics: {
            stdoutJsonObjectCount: extractJsonObjectBlocks(stdout).length,
            stderrJsonObjectCount: extractJsonObjectBlocks(stderr).length,
            stderrStructuredUsageDetected: Boolean(stderrUsage),
            stdoutBytes: Buffer.byteLength(stdout, "utf8"),
            stderrBytes: Buffer.byteLength(stderr, "utf8"),
            hasAnyOutput: stdout.trim().length > 0 || stderr.trim().length > 0,
            lastStdoutLine: tailLine(stdout),
            lastStderrLine: tailLine(stderr),
            likelyCause: classifyStructuredOutputLikelyCause(stdout, stderr, stdoutUsage, stderrUsage),
            ...(claudeStream?.stopReason ? { claudeStopReason: claudeStream.stopReason } : {}),
            ...(claudeStream?.resultSubtype ? { claudeResultSubtype: claudeStream.resultSubtype } : {}),
            ...(claudeStream?.sessionId ? { claudeSessionId: claudeStream.sessionId } : {}),
            ...(cursorStream?.sessionId ? { cursorSessionId: cursorStream.sessionId } : {}),
            ...(cursorStream?.errorMessage ? { cursorErrorMessage: cursorStream.errorMessage } : {}),
            ...(geminiStream?.sessionId ? { geminiSessionId: geminiStream.sessionId } : {}),
            ...(options?.claudeContract ? { claudeContract: options.claudeContract } : {})
          },
          commandUsed: command,
          argsUsed: args,
          transcript: parseRuntimeTranscript(provider, stdout, stderr)
        };
      }

      const retryableSpawnError = Boolean(
        attemptResult.spawnErrorCode && TRANSIENT_SPAWN_ERROR_CODES.has(attemptResult.spawnErrorCode)
      );
      const retryableCodexNonZero =
        provider === "codex" &&
        !attemptResult.timedOut &&
        !attemptResult.spawnErrorCode &&
        attemptResult.code !== 0 &&
        !containsCodexAuthFailure(`${attemptResult.stdout}\n${normalizedStderr}`);
      const retryable = retryableSpawnError || retryableCodexNonZero;
      if (!retryable || attempt >= maxAttempts) {
        break;
      }
      await sleep(retryBackoffMs * attempt);
    }

    const claudeStream = provider === "claude_code" ? parseClaudeStreamOutput(stdout) : undefined;
    const cursorStream = provider === "cursor" ? parseCursorStreamOutput(stdout) : undefined;
    const geminiStream = provider === "gemini_cli" ? parseGeminiStreamOutput(stdout, stderr) : undefined;
    const stdoutUsage = cursorStream?.usage ?? claudeStream?.usage ?? geminiStream?.usage ?? parseStructuredUsage(stdout);
    const stderrUsage = parseStructuredUsage(stderr);
    return {
      ok: false,
      code: lastResult?.code ?? null,
      stdout,
      stderr,
      timedOut: lastResult?.timedOut ?? false,
      elapsedMs: attempts.reduce((sum, item) => sum + item.elapsedMs, 0),
      attemptCount: attempts.length,
      attempts,
      failureType: classifyFailure(lastResult?.timedOut ?? false, lastResult?.spawnErrorCode, lastResult?.code ?? null),
      parsedUsage: stdoutUsage ?? stderrUsage,
      structuredOutputSource: stdoutUsage ? "stdout" : stderrUsage ? "stderr" : undefined,
      structuredOutputDiagnostics: {
        stdoutJsonObjectCount: extractJsonObjectBlocks(stdout).length,
        stderrJsonObjectCount: extractJsonObjectBlocks(stderr).length,
        stderrStructuredUsageDetected: Boolean(stderrUsage),
        stdoutBytes: Buffer.byteLength(stdout, "utf8"),
        stderrBytes: Buffer.byteLength(stderr, "utf8"),
        hasAnyOutput: stdout.trim().length > 0 || stderr.trim().length > 0,
        lastStdoutLine: tailLine(stdout),
        lastStderrLine: tailLine(stderr),
        likelyCause: classifyStructuredOutputLikelyCause(stdout, stderr, stdoutUsage, stderrUsage),
        ...(claudeStream?.stopReason ? { claudeStopReason: claudeStream.stopReason } : {}),
        ...(claudeStream?.resultSubtype ? { claudeResultSubtype: claudeStream.resultSubtype } : {}),
        ...(claudeStream?.sessionId ? { claudeSessionId: claudeStream.sessionId } : {}),
        ...(cursorStream?.sessionId ? { cursorSessionId: cursorStream.sessionId } : {}),
        ...(cursorStream?.errorMessage ? { cursorErrorMessage: cursorStream.errorMessage } : {}),
        ...(geminiStream?.sessionId ? { geminiSessionId: geminiStream.sessionId } : {}),
        ...(options?.claudeContract ? { claudeContract: options.claudeContract } : {})
      },
      commandUsed: command,
      argsUsed: args,
      transcript: parseRuntimeTranscript(provider, stdout, stderr)
    };
  } finally {
    await providerIsolation.cleanup();
    await injection.cleanup();
  }
}

function ensureClaudeStructuredOutputArgs(command: string, args: string[]) {
  const contract = inspectClaudeOutputContract(command, args, true);
  if (!contract.commandLooksClaude) {
    return args;
  }
  const next = [...args];
  if (!contract.hasPromptFlag) {
    next.push("--print", "-");
  }
  if (!contract.hasOutputFormatJson) {
    next.push("--output-format", "stream-json");
  }
  if (contract.outputFormat === "json" && !contract.hasJsonSchema) {
    next.push("--json-schema", CLAUDE_HEARTBEAT_OUTPUT_SCHEMA);
  }
  if (!contract.hasMaxTurnsFlag) {
    next.push("--max-turns", "8");
  }
  if (!contract.hasVerboseFlag) {
    next.push("--verbose");
  }
  if (!contract.hasDangerouslySkipPermissions) {
    next.push("--dangerously-skip-permissions");
  }
  return next;
}

function inspectClaudeOutputContract(command: string, args: string[], commandOverride: boolean) {
  const commandToken = command.trim().split(/[\\/]/).pop() ?? "";
  const commandLooksClaude = /\bclaude(?:\.exe)?$/i.test(commandToken);
  const commandWasProviderAlias = /^claude_code$/i.test(commandToken);
  const hasPromptFlag = args.includes("-p") || hasCliFlagValue(args, "--print", "-");
  const outputFormat = resolveCliFlagValue(args, "--output-format");
  const hasOutputFormatJson = outputFormat === "json" || outputFormat === "stream-json";
  const hasMaxTurnsFlag = hasCliFlag(args, "--max-turns");
  const hasVerboseFlag = hasCliFlag(args, "--verbose");
  const hasDangerouslySkipPermissions = hasCliFlag(args, "--dangerously-skip-permissions");
  const hasJsonSchema = hasCliFlag(args, "--json-schema");
  const missingRequiredArgs: string[] = [];
  if (!hasPromptFlag) {
    missingRequiredArgs.push("--print -");
  }
  if (!hasOutputFormatJson) {
    missingRequiredArgs.push("--output-format stream-json");
  }
  if (outputFormat === "json" && !hasJsonSchema) {
    missingRequiredArgs.push("--json-schema <heartbeat-schema>");
  }
  if (!hasMaxTurnsFlag) {
    missingRequiredArgs.push("--max-turns 8");
  }
  if (!hasVerboseFlag) {
    missingRequiredArgs.push("--verbose");
  }
  if (!hasDangerouslySkipPermissions) {
    missingRequiredArgs.push("--dangerously-skip-permissions");
  }
  return {
    commandOverride,
    commandLooksClaude,
    commandWasProviderAlias,
    hasPromptFlag,
    hasOutputFormatJson,
    outputFormat,
    hasMaxTurnsFlag,
    hasVerboseFlag,
    hasDangerouslySkipPermissions,
    hasJsonSchema,
    missingRequiredArgs
  };
}

function resolveProviderCommand(provider: "claude_code" | "codex", configuredCommand: string | undefined) {
  const trimmed = configuredCommand?.trim();
  if (!trimmed) {
    return pickDefaultCommand(provider);
  }
  // Normalize accidental provider id aliases used as command strings.
  if (provider === "claude_code" && trimmed === "claude_code") {
    return "claude";
  }
  return trimmed;
}

function withClaudeResumeArg(args: string[], sessionId: string) {
  const next: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const current = args[index] ?? "";
    if (current === "--resume") {
      index += 1;
      continue;
    }
    if (current.startsWith("--resume=")) {
      continue;
    }
    next.push(current);
  }
  next.push("--resume", sessionId);
  return next;
}

function isClaudeMaxTurnsRuntime(runtime: RuntimeExecutionOutput) {
  return (
    runtime.structuredOutputDiagnostics?.claudeStopReason === "max_turns" ||
    runtime.structuredOutputDiagnostics?.claudeResultSubtype === "error_max_turns"
  );
}

function hasCliFlag(args: string[], flag: string) {
  return args.some((arg, index) => arg === flag || (arg.startsWith(`${flag}=`) && index >= 0));
}

function resolveCliFlagValue(args: string[], flag: string) {
  for (let index = 0; index < args.length; index += 1) {
    const current = (args[index] ?? "").trim();
    if (!current) {
      continue;
    }
    if (current === flag) {
      const next = (args[index + 1] ?? "").trim();
      return next || null;
    }
    if (current.startsWith(`${flag}=`)) {
      return current.slice(flag.length + 1).trim() || null;
    }
  }
  return null;
}

function hasCliFlagValue(args: string[], flag: string, expectedValue: string) {
  const expected = expectedValue.toLowerCase();
  for (let index = 0; index < args.length; index += 1) {
    const current = (args[index] ?? "").trim();
    if (!current) {
      continue;
    }
    if (current === flag) {
      const next = (args[index + 1] ?? "").trim().toLowerCase();
      if (next === expected) {
        return true;
      }
      continue;
    }
    if (current.startsWith(`${flag}=`)) {
      const inlineValue = current.slice(flag.length + 1).trim().toLowerCase();
      if (inlineValue === expected) {
        return true;
      }
    }
  }
  return false;
}

const SKILLS_DIR_NAME = "skills";
const CLAUDE_SKILLS_DIR = ".claude/skills";
const SKILL_MD = "SKILL.md";
const DEFAULT_CODEX_HOME_ROOT = ".bopodev/runtime/codex-home";
const DEFAULT_CODEX_HOME_FALLBACK = ".codex";
const CODEX_VOLATILE_STATE_ENTRIES = ["rollouts", "state.db", "data/rollouts", "data/state.db"];
const CODEX_ROLLOUT_NOISE_RE =
  /^\d{4}-\d{2}-\d{2}T[^\s]+\s+ERROR\s+codex_core::rollout::list:\s+state db missing rollout path for thread\s+[a-z0-9-]+$/i;
const CLAUDE_HEARTBEAT_OUTPUT_SCHEMA = JSON.stringify({
  type: "object",
  additionalProperties: false,
  required: ["summary"],
  properties: {
    summary: { type: "string", minLength: 1 },
    tokenInput: { type: "number" },
    tokenOutput: { type: "number" },
    usdCost: { type: "number" }
  }
});
type SkillInjectionContext = {
  additionalArgs: string[];
  warning?: string;
  cleanup: () => Promise<void>;
};

async function prepareSkillInjection(
  provider: LocalProvider | undefined,
  env: NodeJS.ProcessEnv
): Promise<SkillInjectionContext> {
  if (!provider) {
    return noSkillInjection();
  }

  const skillsSource = await resolveSkillsSourceDir();
  if (!skillsSource) {
    return {
      ...noSkillInjection(),
      warning: "[bopodev] skills injection skipped: no skills directory found."
    };
  }

  if (provider === "codex") {
    try {
      await ensureCodexSkillsInjected(skillsSource, env);
      return noSkillInjection();
    } catch (error) {
      return {
        ...noSkillInjection(),
        warning: `[bopodev] skills injection failed for codex: ${String(error)}`
      };
    }
  }

  if (provider === "cursor") {
    try {
      await ensureSkillsInjectedAtHome(skillsSource, join(homedir(), ".cursor", "skills"));
      return noSkillInjection();
    } catch (error) {
      return {
        ...noSkillInjection(),
        warning: `[bopodev] skills injection failed for cursor: ${String(error)}`
      };
    }
  }

  if (provider === "opencode") {
    try {
      await ensureSkillsInjectedAtHome(skillsSource, join(homedir(), ".claude", "skills"));
      return noSkillInjection();
    } catch (error) {
      return {
        ...noSkillInjection(),
        warning: `[bopodev] skills injection failed for opencode: ${String(error)}`
      };
    }
  }

  if (provider === "gemini_cli") {
    // Gemini CLI does not support Claude-style --add-dir skill mounting.
    return noSkillInjection();
  }

  try {
    const tempSkillsRoot = await buildClaudeSkillsAddDir(skillsSource);
    return {
      additionalArgs: ["--add-dir", tempSkillsRoot],
      cleanup: async () => {
        await rm(tempSkillsRoot, { recursive: true, force: true });
      }
    };
  } catch (error) {
    return {
      ...noSkillInjection(),
      warning: `[bopodev] skills injection failed for claude_code: ${String(error)}`
    };
  }
}

function noSkillInjection(): SkillInjectionContext {
  return {
    additionalArgs: [],
    cleanup: async () => {}
  };
}

const TRANSIENT_SPAWN_ERROR_CODES = new Set(["EAGAIN", "EMFILE", "ENFILE", "ETXTBSY", "EBUSY"]);
async function executeSinglePromptAttempt(
  command: string,
  args: string[],
  stdinPrompt: string | undefined,
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  interruptGraceMs: number,
  abortSignal?: AbortSignal,
  callbacks?: {
    provider?: LocalProvider;
    onStdoutChunk?: (chunk: string) => void;
    onStderrChunk?: (chunk: string) => void;
  }
) {
  const startedAt = Date.now();
  return new Promise<{
    ok: boolean;
    code: number | null;
    stdout: string;
    stderr: string;
    timedOut: boolean;
    elapsedMs: number;
    signal: NodeJS.Signals | null;
    spawnErrorCode?: string;
    forcedKill: boolean;
  }>((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env,
      shell: false
    });

    let stdout = "";
    let stderr = "";
    let resolved = false;
    let timedOut = false;
    let forcedKill = false;
    let abortedBySignal = false;
    let timeoutKillTimer: NodeJS.Timeout | undefined;
    let abortListener: (() => void) | undefined;
    const scheduleTermination = () => {
      child.kill("SIGTERM");
      timeoutKillTimer = setTimeout(() => {
        if (!resolved) {
          forcedKill = true;
          child.kill("SIGKILL");
        }
      }, interruptGraceMs);
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      scheduleTermination();
    }, timeoutMs);
    if (abortSignal) {
      abortListener = () => {
        abortedBySignal = true;
        timedOut = true;
        scheduleTermination();
      };
      if (abortSignal.aborted) {
        abortListener();
      } else {
        abortSignal.addEventListener("abort", abortListener, { once: true });
      }
    }

    child.stdout.on("data", (chunk) => {
      const text = String(chunk);
      stdout += text;
      callbacks?.onStdoutChunk?.(text);
    });
    child.stderr.on("data", (chunk) => {
      const text = String(chunk);
      stderr += text;
      callbacks?.onStderrChunk?.(text);
    });
    if (stdinPrompt !== undefined) {
      child.stdin.write(stdinPrompt);
      child.stdin.end();
    }

    child.on("close", (code, signal) => {
      if (resolved) {
        return;
      }
      resolved = true;
      clearTimeout(timeout);
      if (timeoutKillTimer) {
        clearTimeout(timeoutKillTimer);
      }
      if (abortSignal && abortListener) {
        abortSignal.removeEventListener("abort", abortListener);
      }
      resolve({
        ok: code === 0 && !timedOut,
        code,
        stdout,
        stderr: abortedBySignal ? [stderr, "Execution aborted by watchdog signal."].filter(Boolean).join("\n") : stderr,
        timedOut,
        elapsedMs: Date.now() - startedAt,
        signal,
        forcedKill
      });
    });

    child.on("error", (error) => {
      if (resolved) {
        return;
      }
      resolved = true;
      clearTimeout(timeout);
      if (timeoutKillTimer) {
        clearTimeout(timeoutKillTimer);
      }
      if (abortSignal && abortListener) {
        abortSignal.removeEventListener("abort", abortListener);
      }
      const errorWithCode = error as NodeJS.ErrnoException;
      resolve({
        ok: false,
        code: null,
        stdout,
        stderr: `${stderr}\n${String(error)}`.trim(),
        timedOut,
        elapsedMs: Date.now() - startedAt,
        signal: null,
        spawnErrorCode: errorWithCode.code,
        forcedKill
      });
    });
  });
}

function emitStreamingTranscriptEvents(
  provider: LocalProvider | undefined,
  stream: "stdout" | "stderr",
  chunk: string,
  emit: (event: RuntimeTranscriptEvent) => void
) {
  const lines = chunk
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (const line of lines) {
    const events = toStreamingStdoutEvents(provider, stream, line);
    if (events.length > 0) {
      for (const event of events) {
        emit(event);
      }
      continue;
    }
    if (stream === "stderr") {
      const derivedToolEvents = parseShellStyleStderrEvents(line).map((event) =>
        enrichStreamedEvent(event, provider, stream, line)
      );
      if (derivedToolEvents.length > 0) {
        for (const event of derivedToolEvents) {
          emit(event);
        }
        continue;
      }
      const stderrEvent = enrichStreamedEvent(
        {
          kind: "stderr",
          text: clipText(line, 300)
        },
        provider,
        stream,
        line
      );
      if (stderrEvent.signalLevel === "high") {
        emit(stderrEvent);
      }
    }
  }
}

function parseShellStyleStderrEvents(line: string): RuntimeTranscriptEvent[] {
  if (line === "exec") {
    return [
      {
        kind: "tool_call",
        label: "command_run",
        text: "exec"
      }
    ];
  }
  if (line === "codex" || line === "claude") {
    return [
      {
        kind: "system",
        text: line
      }
    ];
  }
  if (/^\*\*.+\*\*$/.test(line)) {
    return [
      {
        kind: "thinking",
        text: line.replace(/^\*\*|\*\*$/g, "")
      }
    ];
  }
  if (/^(using|i('|’)m|i |next i|planning |verifying |switching |restoring )/i.test(line)) {
    return [
      {
        kind: "assistant",
        text: line
      }
    ];
  }
  const inlineCommandResultMatch = /^(\/\S.+?)\s+in\s+.+?\s+(succeeded|failed|exited\s+\d+)\s+in\s+\d+ms:$/i.exec(line);
  if (inlineCommandResultMatch) {
    const command = inlineCommandResultMatch[1]!.trim();
    return [
      {
        kind: "tool_call",
        label: "command_execution",
        text: command,
        payload: stringifyJsonPretty({ command })
      },
      {
        kind: "tool_result",
        label: command,
        text: line
      }
    ];
  }
  if (line.startsWith("/bin/") || line.startsWith("/usr/bin/") || line.startsWith("/usr/local/bin/")) {
    return [
      {
        kind: "tool_call",
        label: "command_execution",
        text: line,
        payload: stringifyJsonPretty({ command: line })
      }
    ];
  }
  if (/^(succeeded|failed)\s+in\s+\d+ms:?$/i.test(line) || /^exited\s+\d+\s+in\s+\d+ms:?$/i.test(line)) {
    return [
      {
        kind: "tool_result",
        label: "command_execution",
        text: line
      }
    ];
  }
  if (/^in\s+\/.+/.test(line) || /^total\s+\d+$/i.test(line) || /^(drwx|[-lcbps]r[-wx]{8,9})/.test(line)) {
    return [
      {
        kind: "tool_result",
        label: "command_execution",
        text: line
      }
    ];
  }
  return [];
}

function toStreamingStdoutEvents(
  provider: LocalProvider | undefined,
  stream: "stdout" | "stderr",
  line: string
): RuntimeTranscriptEvent[] {
  if (isTranscriptNoiseLine(line)) {
    return [];
  }
  if (provider === "codex") {
    const parsedCodexEvents = parseCodexTranscriptLine(line).map((event) =>
      enrichStreamedEvent(event, provider, stream, line),
    );
    if (parsedCodexEvents.length > 0) {
      return parsedCodexEvents;
    }
  }
  if (provider === "claude_code") {
    const parsedClaudeEvents = parseClaudeStreamingTranscriptLine(line).map((event) =>
      enrichStreamedEvent(event, provider, stream, line),
    );
    if (parsedClaudeEvents.length > 0) {
      return parsedClaudeEvents;
    }
  }
  if (provider === "opencode") {
    const parsedOpenCodeEvents = parseOpenCodeStreamingTranscriptLine(line).map((event) =>
      enrichStreamedEvent(event, provider, stream, line),
    );
    if (parsedOpenCodeEvents.length > 0) {
      return parsedOpenCodeEvents;
    }
  }
  if (provider === "gemini_cli") {
    const parsedGeminiEvents = parseGeminiStreamingTranscriptLine(line).map((event) =>
      enrichStreamedEvent(event, provider, stream, line),
    );
    if (parsedGeminiEvents.length > 0) {
      return parsedGeminiEvents;
    }
  }
  const parsedJsonEvent = parseGenericTranscriptJsonLine(line);
  if (parsedJsonEvent) {
    return [enrichStreamedEvent(parsedJsonEvent, provider, stream, line)];
  }
  const parsedTaggedEvent = parseTaggedTranscriptLine(line);
  if (parsedTaggedEvent) {
    return [enrichStreamedEvent(parsedTaggedEvent, provider, stream, line)];
  }
  if (stream === "stderr") {
    return [];
  }
  if (provider === "claude_code" || provider === "cursor" || provider === "opencode" || provider === "gemini_cli") {
    const assistantEvent = enrichStreamedEvent(
      {
        kind: "assistant",
        text: clipText(line, 300)
      },
      provider,
      stream,
      line
    );
    if (assistantEvent.signalLevel === "noise") {
      return [];
    }
    return [assistantEvent];
  }
  return [];
}

function parseClaudeStreamingTranscriptLine(line: string): RuntimeTranscriptEvent[] {
  if (!line.startsWith("{") || !line.endsWith("}")) {
    return [];
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return [];
  }
  const type = typeof parsed.type === "string" ? parsed.type.trim().toLowerCase() : "";
  if (!type) {
    return [];
  }
  if (type === "result") {
    const resultText = firstNonEmptyString(parsed.result, parsed.summary);
    if (!resultText) {
      return [];
    }
    return [
      {
        kind: "result",
        label: firstNonEmptyString(parsed.subtype, parsed.stop_reason) ?? undefined,
        text: clipText(resultText, 1200),
        payload: clipText(line, 2000)
      }
    ];
  }
  if (type !== "assistant" && type !== "user") {
    return [];
  }
  const message = parsed.message;
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return [];
  }
  const content = (message as Record<string, unknown>).content;
  if (!Array.isArray(content)) {
    return [];
  }
  const events: RuntimeTranscriptEvent[] = [];
  for (const entry of content) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }
    const block = entry as Record<string, unknown>;
    const blockType = typeof block.type === "string" ? block.type.trim().toLowerCase() : "";
    if (blockType === "thinking" || blockType === "redacted_thinking") {
      const thinkingText = firstNonEmptyString(block.thinking, block.text);
      if (thinkingText) {
        events.push({
          kind: "thinking",
          text: clipText(thinkingText, 500)
        });
      }
      continue;
    }
    if (blockType === "text") {
      const text = firstNonEmptyString(block.text);
      if (text) {
        events.push({
          kind: "assistant",
          text: clipText(text, 1200)
        });
      }
      continue;
    }
    if (blockType === "tool_use") {
      const toolName = firstNonEmptyString(block.name, block.tool_name) ?? "tool";
      events.push({
        kind: "tool_call",
        label: toolName,
        text: toolName,
        payload: clipText(safeJson(block.input ?? block.arguments ?? {}) ?? "", 2000)
      });
      continue;
    }
    if (blockType === "tool_result") {
      const contentValue = block.content ?? block.output ?? block.result;
      events.push({
        kind: "tool_result",
        label: firstNonEmptyString(block.tool_use_id, block.name) ?? "tool_result",
        text: clipText(typeof contentValue === "string" ? contentValue : safeJson(contentValue) ?? "tool result", 2000)
      });
    }
  }
  return events;
}

function enrichStreamedEvent(
  event: RuntimeTranscriptEvent,
  provider: LocalProvider | undefined,
  source: "stdout" | "stderr",
  rawLine: string
): RuntimeTranscriptEvent {
  const signalLevel = classifyTranscriptSignal(event, rawLine);
  const groupKey = resolveTranscriptGroupKey(event);
  return {
    ...event,
    signalLevel,
    groupKey,
    source
  };
}

function resolveTranscriptGroupKey(event: RuntimeTranscriptEvent) {
  if (event.kind === "tool_call" || event.kind === "tool_result") {
    return `tool:${(event.label ?? "unknown").toLowerCase()}`;
  }
  if (event.kind === "result") {
    return "result";
  }
  if (event.kind === "assistant") {
    return "assistant";
  }
  if (event.kind === "stderr") {
    return "stderr";
  }
  return "system";
}

function classifyTranscriptSignal(event: RuntimeTranscriptEvent, rawLine: string): TranscriptSignalLevel {
  if (event.kind === "tool_call" || event.kind === "tool_result" || event.kind === "result") {
    return "high";
  }
  if (event.kind === "assistant") {
    return event.text && event.text.length > 24 ? "medium" : "low";
  }
  if (event.kind === "stderr") {
    if (isTranscriptNoiseLine(rawLine)) {
      return "noise";
    }
    return looksLikeErrorSignal(rawLine) ? "high" : "low";
  }
  return "noise";
}

function looksLikeErrorSignal(line: string) {
  const normalized = line.trim().toLowerCase();
  return (
    normalized.includes("fatal:") ||
    normalized.includes("error:") ||
    normalized.includes("failed") ||
    normalized.includes("exception") ||
    normalized.includes("not a git repository") ||
    normalized.includes("permission denied")
  );
}

function isTranscriptNoiseLine(line: string) {
  const normalized = line.trim().toLowerCase();
  if (!normalized) {
    return true;
  }
  return (
    normalized.includes("openai codex v") ||
    normalized.includes("workdir:") ||
    normalized.includes("approval:") ||
    normalized.includes("sandbox:") ||
    normalized.includes("provider:") ||
    normalized.includes("model: gpt-") ||
    normalized.includes("loaded agent instructions file") ||
    normalized.includes("skipping saved session restore") ||
    normalized.includes("injected codex skill") ||
    normalized.includes("command not found in path")
  );
}

function classifyFailure(timedOut: boolean, spawnErrorCode: string | undefined, code: number | null) {
  if (timedOut) {
    return "timeout" as const;
  }
  if (spawnErrorCode) {
    return "spawn_error" as const;
  }
  if (code !== 0) {
    return "nonzero_exit" as const;
  }
  return undefined;
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function containsCodexAuthFailure(text: string) {
  const normalized = text.toLowerCase();
  if (!normalized.includes("401 unauthorized")) {
    return false;
  }
  return normalized.includes("missing bearer") || normalized.includes("authentication");
}

export async function checkRuntimeCommandHealth(
  command: string,
  options?: { cwd?: string; timeoutMs?: number }
): Promise<RuntimeCommandHealth> {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    const child = spawn(command, ["--version"], {
      cwd: options?.cwd ?? process.cwd(),
      env: process.env,
      shell: false
    });

    let resolved = false;
    const timeout = setTimeout(() => {
      if (resolved) {
        return;
      }
      resolved = true;
      child.kill("SIGTERM");
      resolve({
        command,
        available: false,
        exitCode: null,
        elapsedMs: Date.now() - startedAt,
        error: "Command health check timed out."
      });
    }, options?.timeoutMs ?? 5_000);

    child.on("close", (code) => {
      if (resolved) {
        return;
      }
      resolved = true;
      clearTimeout(timeout);
      resolve({
        command,
        available: true,
        exitCode: code,
        elapsedMs: Date.now() - startedAt
      });
    });

    child.on("error", (error) => {
      if (resolved) {
        return;
      }
      resolved = true;
      clearTimeout(timeout);
      resolve({
        command,
        available: false,
        exitCode: null,
        elapsedMs: Date.now() - startedAt,
        error: String(error)
      });
    });
  });
}

async function resolveSkillsSourceDir() {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [resolve(moduleDir, "../../../skills"), resolve(process.cwd(), "skills")];
  for (const candidate of candidates) {
    if (await isDirectory(candidate)) {
      return candidate;
    }
  }
  return null;
}

async function ensureCodexSkillsInjected(skillsSourceDir: string, env: NodeJS.ProcessEnv) {
  const codexHome = resolveCodexHome(env);
  const targetRoot = join(codexHome, SKILLS_DIR_NAME);
  await mkdir(targetRoot, { recursive: true });

  const entries = await readdir(skillsSourceDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const source = join(skillsSourceDir, entry.name);
    if (!(await hasSkillManifest(source))) {
      continue;
    }
    const target = join(targetRoot, entry.name);
    const existing = await lstat(target).catch(() => null);
    if (existing) {
      continue;
    }
    await symlink(source, target);
  }
}

function resolveCodexHome(env: NodeJS.ProcessEnv) {
  const configured = env.CODEX_HOME?.trim();
  if (configured) {
    return configured;
  }
  return join(homedir(), DEFAULT_CODEX_HOME_FALLBACK);
}

function normalizeProviderAuthEnv(
  provider: LocalProvider | undefined,
  env: NodeJS.ProcessEnv
) {
  if (provider !== "codex") {
    return env;
  }
  const apiKey = env.OPENAI_API_KEY;
  if (typeof apiKey === "string" && apiKey.trim().length === 0) {
    const nextEnv = { ...env };
    delete nextEnv.OPENAI_API_KEY;
    return nextEnv;
  }
  return env;
}

type ProviderIsolationContext = {
  env: NodeJS.ProcessEnv;
  cleanup: () => Promise<void>;
};

async function withProviderRuntimeIsolation(
  provider: LocalProvider | undefined,
  env: NodeJS.ProcessEnv
): Promise<ProviderIsolationContext> {
  if (provider !== "codex") {
    return {
      env,
      cleanup: async () => {}
    };
  }
  const forceManagedCodexHome = resolveControlPlaneEnvValue(env, "FORCE_MANAGED_CODEX_HOME") === "true";
  if (env.CODEX_HOME?.trim() && !forceManagedCodexHome) {
    await sanitizeCodexHomeVolatileState(env.CODEX_HOME.trim());
    return {
      env,
      cleanup: async () => {}
    };
  }
  const hasApiKey = typeof env.OPENAI_API_KEY === "string" && env.OPENAI_API_KEY.trim().length > 0;
  if (hasApiKey) {
    const runScopedCodexHome = await mkdtemp(join(tmpdir(), "bopodev-codex-home-run-"));
    await sanitizeCodexHomeVolatileState(runScopedCodexHome);
    return {
      env: {
        ...env,
        CODEX_HOME: runScopedCodexHome
      },
      cleanup: async () => {
        await rm(runScopedCodexHome, { recursive: true, force: true });
      }
    };
  }
  if (!forceManagedCodexHome) {
    return {
      env: {
        ...env,
        CODEX_HOME: resolveCodexHome(env)
      },
      cleanup: async () => {}
    };
  }
  const targetCodexHome = resolveManagedCodexHome(env);
  await prepareManagedCodexHome(targetCodexHome, env);
  return {
    env: {
      ...env,
      CODEX_HOME: targetCodexHome
    },
    cleanup: async () => {}
  };
}

async function ensureSkillsInjectedAtHome(skillsSourceDir: string, targetRoot: string) {
  await mkdir(targetRoot, { recursive: true });
  const entries = await readdir(skillsSourceDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const source = join(skillsSourceDir, entry.name);
    if (!(await hasSkillManifest(source))) continue;
    const target = join(targetRoot, entry.name);
    const existing = await lstat(target).catch(() => null);
    if (existing) continue;
    await symlink(source, target);
  }
}

function resolveManagedCodexHome(env: NodeJS.ProcessEnv) {
  const managedRoot = resolveManagedCodexHomeRoot(env);
  const companyId = sanitizePathSegment(resolveControlPlaneEnvValue(env, "COMPANY_ID"));
  const agentId = sanitizePathSegment(resolveControlPlaneEnvValue(env, "AGENT_ID"));
  if (companyId && agentId) {
    return join(managedRoot, companyId, agentId);
  }
  return join(managedRoot, "shared");
}

function resolveManagedCodexHomeRoot(env: NodeJS.ProcessEnv) {
  const configuredRoot = env.BOPO_CODEX_HOME_ROOT?.trim();
  if (configuredRoot) {
    return configuredRoot;
  }
  return join(tmpdir(), "bopodev-codex-home");
}

async function prepareManagedCodexHome(targetCodexHome: string, env: NodeJS.ProcessEnv) {
  await mkdir(targetCodexHome, { recursive: true });
  await seedCodexHomeIfEmpty(targetCodexHome, env);
  await sanitizeCodexHomeVolatileState(targetCodexHome);
}

async function seedCodexHomeIfEmpty(targetCodexHome: string, env: NodeJS.ProcessEnv) {
  if (env.BOPO_CODEX_ALLOW_HOME_SEED !== "true") {
    return;
  }
  const currentEntries = await readdir(targetCodexHome).catch(() => []);
  if (currentEntries.length > 0) {
    return;
  }
  const sourceCodexHome = join(homedir(), DEFAULT_CODEX_HOME_FALLBACK);
  const sourceEntries = await readdir(sourceCodexHome, { withFileTypes: true }).catch(() => []);
  for (const entry of sourceEntries) {
    if (CODEX_VOLATILE_STATE_ENTRIES.includes(entry.name)) {
      continue;
    }
    const source = join(sourceCodexHome, entry.name);
    const target = join(targetCodexHome, entry.name);
    await cp(source, target, {
      recursive: true,
      force: false,
      errorOnExist: false
    }).catch(() => undefined);
  }
}

async function sanitizeCodexHomeVolatileState(codexHome: string) {
  for (const entry of CODEX_VOLATILE_STATE_ENTRIES) {
    await rm(join(codexHome, entry), { recursive: true, force: true });
  }
}

function stripCodexRolloutNoise(text: string) {
  return text
    .split(/\r?\n/)
    .filter((line) => {
      const trimmed = line.trim();
      return !trimmed || !CODEX_ROLLOUT_NOISE_RE.test(trimmed);
    })
    .join("\n");
}

function sanitizePathSegment(value: string | undefined) {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.replace(/[^a-zA-Z0-9._-]/g, "_");
}

async function buildClaudeSkillsAddDir(skillsSourceDir: string) {
  const tempRoot = await mkdtemp(join(tmpdir(), "bopodev-skills-"));
  const skillsTargetDir = join(tempRoot, CLAUDE_SKILLS_DIR);
  await mkdir(skillsTargetDir, { recursive: true });

  const entries = await readdir(skillsSourceDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const source = join(skillsSourceDir, entry.name);
    if (!(await hasSkillManifest(source))) {
      continue;
    }
    await symlink(source, join(skillsTargetDir, entry.name));
  }

  return tempRoot;
}

async function hasSkillManifest(skillDir: string) {
  return fileExists(join(skillDir, SKILL_MD));
}

async function isDirectory(path: string) {
  const stats = await lstat(path).catch(() => null);
  return stats?.isDirectory() ?? false;
}

async function fileExists(path: string) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export function parseStructuredUsage(stdout: string) {
  const whole = stdout.trim();
  if (whole.startsWith("{") && whole.endsWith("}")) {
    const parsedWhole = tryParseUsage(whole);
    if (parsedWhole) {
      return parsedWhole;
    }
  }

  const jsonBlocks = extractJsonObjectBlocks(stdout);
  for (let index = jsonBlocks.length - 1; index >= 0; index -= 1) {
    const parsedBlock = tryParseUsage(jsonBlocks[index] ?? "");
    if (parsedBlock) {
      return parsedBlock;
    }
  }

  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const candidate = lines[index];
    if (candidate?.startsWith("{") && candidate.endsWith("}")) {
      const parsed = tryParseUsage(candidate);
      if (parsed) {
        return parsed;
      }
    }

    const fragments = candidate?.match(/\{[^{}]+\}/g) ?? [];
    for (let fragmentIndex = fragments.length - 1; fragmentIndex >= 0; fragmentIndex -= 1) {
      const parsed = tryParseUsage(fragments[fragmentIndex] ?? "");
      if (parsed) {
        return parsed;
      }
    }
  }

  return undefined;
}

export function parseClaudeStreamOutput(stdout: string) {
  let summary = "";
  let tokenInput: number | undefined;
  let tokenOutput: number | undefined;
  let usdCost: number | undefined;
  let stopReason: string | undefined;
  let resultSubtype: string | undefined;
  let sessionId: string | undefined;
  const assistantTexts: string[] = [];

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const type = typeof parsed.type === "string" ? parsed.type : "";
    if (!sessionId && typeof parsed.session_id === "string" && parsed.session_id.trim()) {
      sessionId = parsed.session_id.trim();
    }
    if (type === "assistant") {
      const message = parsed.message;
      if (message && typeof message === "object" && !Array.isArray(message)) {
        const content = (message as Record<string, unknown>).content;
        if (Array.isArray(content)) {
          for (const entry of content) {
            if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
            const block = entry as Record<string, unknown>;
            if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
              assistantTexts.push(block.text.trim());
            }
          }
        }
      }
      continue;
    }
    if (type !== "result") continue;
    if (typeof parsed.result === "string" && parsed.result.trim()) {
      summary = parsed.result.trim();
    }
    const usage = parsed.usage;
    if (usage && typeof usage === "object" && !Array.isArray(usage)) {
      const usageObj = usage as Record<string, unknown>;
      const inputTokens = toNumber(usageObj.input_tokens);
      const cacheReadTokens = toNumber(usageObj.cache_read_input_tokens);
      const outputTokens = toNumber(usageObj.output_tokens);
      tokenInput =
        inputTokens !== undefined || cacheReadTokens !== undefined
          ? (inputTokens ?? 0) + (cacheReadTokens ?? 0)
          : undefined;
      tokenOutput = outputTokens;
    }
    usdCost = toNumber(parsed.total_cost_usd);
    if (typeof parsed.stop_reason === "string" && parsed.stop_reason.trim()) {
      stopReason = parsed.stop_reason.trim().toLowerCase();
    }
    if (typeof parsed.subtype === "string" && parsed.subtype.trim()) {
      resultSubtype = parsed.subtype.trim().toLowerCase();
    }
  }

  const resolvedSummary = summary || assistantTexts.join("\n\n").trim();
  if (!resolvedSummary && tokenInput === undefined && tokenOutput === undefined && usdCost === undefined) {
    return undefined;
  }
  return {
    usage: {
      summary: resolvedSummary || undefined,
      tokenInput,
      tokenOutput,
      usdCost
    },
    stopReason,
    resultSubtype,
    sessionId
  };
}

export function parseCursorStreamOutput(stdout: string): CursorParsedStream | undefined {
  let sessionId: string | undefined;
  let errorMessage: string | undefined;
  let resultSubtype: string | undefined;
  let tokenInput = 0;
  let tokenOutput = 0;
  let usdCost = 0;
  let sawUsage = false;
  const assistantTexts: string[] = [];

  for (const rawLine of stdout.split(/\r?\n/)) {
    const normalized = normalizeCursorStreamLine(rawLine).line;
    if (!normalized) {
      continue;
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(normalized) as Record<string, unknown>;
    } catch {
      continue;
    }
    const foundSessionId = readCursorSessionId(parsed);
    if (foundSessionId) {
      sessionId = foundSessionId;
    }
    const type = typeof parsed.type === "string" ? parsed.type.trim().toLowerCase() : "";
    if (type === "assistant") {
      assistantTexts.push(...collectCursorAssistantText(parsed.message));
      continue;
    }
    if (type === "result") {
      const usage = parsed.usage;
      if (usage && typeof usage === "object" && !Array.isArray(usage)) {
        const usageRecord = usage as Record<string, unknown>;
        tokenInput += toNumber(usageRecord.input_tokens) ?? toNumber(usageRecord.inputTokens) ?? 0;
        tokenInput +=
          toNumber(usageRecord.cached_input_tokens) ??
          toNumber(usageRecord.cachedInputTokens) ??
          toNumber(usageRecord.cache_read_input_tokens) ??
          0;
        tokenOutput += toNumber(usageRecord.output_tokens) ?? toNumber(usageRecord.outputTokens) ?? 0;
        sawUsage = true;
      }
      usdCost += toNumber(parsed.total_cost_usd) ?? toNumber(parsed.cost_usd) ?? toNumber(parsed.cost) ?? 0;
      if (typeof parsed.subtype === "string" && parsed.subtype.trim()) {
        resultSubtype = parsed.subtype.trim().toLowerCase();
      }
      const resultText = firstNonEmptyString(parsed.result);
      if (resultText && assistantTexts.length === 0) {
        assistantTexts.push(resultText);
      }
      const isError = parsed.is_error === true || resultSubtype === "error";
      if (isError) {
        const message = asCursorErrorText(parsed.error ?? parsed.message ?? parsed.result);
        if (message) {
          errorMessage = message;
        }
      }
      continue;
    }
    if (type === "error") {
      const message = asCursorErrorText(parsed.message ?? parsed.error ?? parsed.detail);
      if (message) {
        errorMessage = message;
      }
      continue;
    }
    if (type === "system") {
      const subtype = typeof parsed.subtype === "string" ? parsed.subtype.trim().toLowerCase() : "";
      if (subtype === "error") {
        const message = asCursorErrorText(parsed.message ?? parsed.error ?? parsed.detail);
        if (message) {
          errorMessage = message;
        }
      }
      continue;
    }
    if (type === "text") {
      const part = parsed.part;
      if (part && typeof part === "object" && !Array.isArray(part)) {
        const text = firstNonEmptyString((part as Record<string, unknown>).text);
        if (text) {
          assistantTexts.push(text);
        }
      }
      continue;
    }
    if (type === "step_finish") {
      const part = parsed.part;
      if (!part || typeof part !== "object" || Array.isArray(part)) {
        continue;
      }
      const tokens = (part as Record<string, unknown>).tokens;
      if (tokens && typeof tokens === "object" && !Array.isArray(tokens)) {
        const tokenRecord = tokens as Record<string, unknown>;
        tokenInput += toNumber(tokenRecord.input) ?? 0;
        tokenOutput += toNumber(tokenRecord.output) ?? 0;
        const cache = tokenRecord.cache;
        if (cache && typeof cache === "object" && !Array.isArray(cache)) {
          tokenInput += toNumber((cache as Record<string, unknown>).read) ?? 0;
        }
        sawUsage = true;
      }
      usdCost += toNumber((part as Record<string, unknown>).cost) ?? 0;
    }
  }

  const summary = assistantTexts.join("\n\n").trim() || errorMessage;
  if (!summary && !sawUsage && usdCost <= 0) {
    return undefined;
  }
  return {
    usage: {
      summary: summary || undefined,
      tokenInput: sawUsage ? tokenInput : undefined,
      tokenOutput: sawUsage ? tokenOutput : undefined,
      usdCost: usdCost > 0 ? usdCost : undefined
    },
    sessionId,
    errorMessage,
    resultSubtype
  };
}

export function parseGeminiStreamOutput(
  stdout: string,
  stderr?: string
): { usage: ParsedUsageRecord; sessionId?: string } | undefined {
  let sessionId: string | undefined;
  let tokenInput = 0;
  let tokenOutput = 0;
  let usdCost = 0;
  let summary = "";
  let sawUsage = false;

  function readSessionId(ev: Record<string, unknown>) {
    const id =
      (typeof ev.session_id === "string" && ev.session_id.trim()) ||
      (typeof ev.sessionId === "string" && ev.sessionId.trim()) ||
      (typeof ev.sessionID === "string" && ev.sessionID.trim()) ||
      (typeof ev.checkpoint_id === "string" && ev.checkpoint_id.trim()) ||
      (typeof ev.thread_id === "string" && ev.thread_id.trim());
    if (id) sessionId = id;
  }

  function accumulateUsage(usageRaw: unknown) {
    if (!usageRaw || typeof usageRaw !== "object" || Array.isArray(usageRaw)) return;
    const u = usageRaw as Record<string, unknown>;
    const meta = (u.usageMetadata && typeof u.usageMetadata === "object" && !Array.isArray(u.usageMetadata)
      ? u.usageMetadata
      : u) as Record<string, unknown>;
    tokenInput +=
      toNumber(meta.input_tokens) ??
      toNumber(meta.inputTokens) ??
      toNumber(meta.promptTokenCount) ??
      toNumber(meta.prompt_tokens) ??
      toNumber(meta.promptTokens) ??
      0;
    tokenInput +=
      toNumber(meta.cached_input_tokens) ??
      toNumber(meta.cachedInputTokens) ??
      toNumber(meta.cachedContentTokenCount) ??
      toNumber(meta.cache_read_input_tokens) ??
      0;
    tokenOutput +=
      toNumber(meta.output_tokens) ??
      toNumber(meta.outputTokens) ??
      toNumber(meta.candidatesTokenCount) ??
      toNumber(meta.completion_tokens) ??
      toNumber(meta.completionTokens) ??
      0;
    if (
      tokenOutput === 0 &&
      (toNumber(meta.totalTokenCount) ?? 0) > 0 &&
      (toNumber(meta.promptTokenCount) ?? 0) > 0
    ) {
      tokenOutput += Math.max(0, (toNumber(meta.totalTokenCount) ?? 0) - (toNumber(meta.promptTokenCount) ?? 0));
    }
    usdCost += toNumber(u.total_cost_usd) ?? toNumber(u.cost_usd) ?? toNumber(u.cost) ?? 0;
    sawUsage = true;
  }

  function accumulateNestedUsage(raw: unknown) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
    const record = raw as Record<string, unknown>;
    if (record.usage) {
      accumulateUsage(record.usage);
    }
    if (record.stats) {
      accumulateUsage(record.stats);
    }
    if (record.usageMetadata) {
      accumulateUsage(record.usageMetadata);
    }
    if (record.response && typeof record.response === "object" && !Array.isArray(record.response)) {
      accumulateNestedUsage(record.response);
    }
    if (record.result && typeof record.result === "object" && !Array.isArray(record.result)) {
      accumulateNestedUsage(record.result);
    }
    if (record.message && typeof record.message === "object" && !Array.isArray(record.message)) {
      accumulateNestedUsage(record.message);
    }
    if (record.data && typeof record.data === "object" && !Array.isArray(record.data)) {
      accumulateNestedUsage(record.data);
    }
    if (record.payload && typeof record.payload === "object" && !Array.isArray(record.payload)) {
      accumulateNestedUsage(record.payload);
    }
  }

  const rawBlocks = [
    ...extractJsonObjectBlocks(stdout),
    ...extractJsonObjectBlocks(stderr ?? "")
  ];
  for (const line of rawBlocks) {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    readSessionId(parsed);
    const type = (typeof parsed.type === "string" ? parsed.type : "").trim().toLowerCase();
    accumulateNestedUsage(parsed);
    if (type === "result") {
      usdCost += toNumber(parsed.total_cost_usd) ?? toNumber(parsed.cost_usd) ?? toNumber(parsed.cost) ?? 0;
      const resultText =
        (typeof parsed.result === "string" && parsed.result.trim()) ||
        (typeof parsed.text === "string" && parsed.text.trim()) ||
        (typeof parsed.response === "string" && parsed.response.trim());
      if (resultText) summary = resultText;
    }
  }

  if (!sawUsage && usdCost <= 0 && !summary && !sessionId) return undefined;
  return {
    usage: {
      summary: summary || undefined,
      tokenInput: sawUsage ? tokenInput : undefined,
      tokenOutput: sawUsage ? tokenOutput : undefined,
      usdCost: usdCost > 0 ? usdCost : undefined
    },
    sessionId
  };
}

function parseClaudeTranscript(stdout: string, stderr: string): RuntimeTranscriptEvent[] | undefined {
  const events: RuntimeTranscriptEvent[] = [];
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith("{") || !line.endsWith("}")) {
      continue;
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const type = typeof parsed.type === "string" ? parsed.type : "";
    if (type === "system") {
      const model = typeof parsed.model === "string" ? parsed.model : "";
      const subtype = typeof parsed.subtype === "string" ? parsed.subtype : undefined;
      events.push({
        kind: "system",
        label: subtype,
        text: model ? `model:${model}` : "session init"
      });
      continue;
    }
    if (type === "assistant" || type === "user") {
      const message = parsed.message;
      const content =
        message && typeof message === "object" && !Array.isArray(message)
          ? ((message as Record<string, unknown>).content as unknown[])
          : undefined;
      if (!Array.isArray(content)) {
        continue;
      }
      for (const entry of content) {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
          continue;
        }
        const block = entry as Record<string, unknown>;
        const blockType = typeof block.type === "string" ? block.type : "";
        if (blockType === "thinking" && typeof block.thinking === "string") {
          events.push({ kind: "thinking", text: clipText(block.thinking, 300) });
          continue;
        }
        if (blockType === "text" && typeof block.text === "string") {
          events.push({ kind: "assistant", text: clipText(block.text, 300) });
          continue;
        }
        if (blockType === "tool_use") {
          const label = typeof block.name === "string" ? block.name : "tool";
          const payload = block.input ? safeJson(block.input) : undefined;
          events.push({
            kind: "tool_call",
            label,
            payload: payload ? clipText(payload, 520) : undefined
          });
          continue;
        }
        if (blockType === "tool_result") {
          const payload = typeof block.content === "string" ? block.content : safeJson(block.content);
          events.push({
            kind: "tool_result",
            text: payload ? clipText(payload, 320) : "tool result"
          });
        }
      }
      continue;
    }
    if (type === "result") {
      const stopReason = typeof parsed.stop_reason === "string" ? parsed.stop_reason : undefined;
      const result = typeof parsed.result === "string" ? parsed.result : "result event";
      events.push({
        kind: "result",
        label: stopReason,
        text: clipText(result, 320)
      });
    }
  }
  const stderrEvents = parseStderrTranscript(stderr);
  if (stderrEvents) {
    events.push(...stderrEvents.slice(0, 10));
  }
  if (events.length === 0) {
    return undefined;
  }
  return events.slice(0, 120);
}

export function parseRuntimeTranscript(
  provider: LocalProvider | undefined,
  stdout: string,
  stderr: string
): RuntimeTranscriptEvent[] | undefined {
  const claudeEvents = provider === "claude_code" ? parseClaudeTranscript(stdout, stderr) : undefined;
  const codexEvents = provider === "codex" ? parseCodexTranscript(stdout, stderr) : undefined;
  const cursorEvents = provider === "cursor" ? parseCursorTranscript(stdout, stderr) : undefined;
  const openCodeEvents = provider === "opencode" ? parseOpenCodeTranscript(stdout, stderr) : undefined;
  const geminiEvents = provider === "gemini_cli" ? parseGeminiTranscript(stdout, stderr) : undefined;
  const genericEvents = parseGenericTranscript(stdout, stderr);
  const providerEvents = claudeEvents ?? codexEvents ?? cursorEvents ?? openCodeEvents ?? geminiEvents;
  return providerEvents ?? genericEvents;
}

function parseOpenCodeTranscript(stdout: string, stderr: string): RuntimeTranscriptEvent[] | undefined {
  const events: RuntimeTranscriptEvent[] = [];
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    events.push(...parseOpenCodeStreamingTranscriptLine(line));
  }
  const stderrEvents = parseStderrTranscript(stderr);
  if (stderrEvents) {
    events.push(...stderrEvents.slice(0, 10));
  }
  if (events.length === 0) {
    return undefined;
  }
  return events.slice(0, 140);
}

function parseGeminiStreamingTranscriptLine(line: string): RuntimeTranscriptEvent[] {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return [];
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return [];
  }
  const type = (typeof parsed.type === "string" ? parsed.type : "").trim().toLowerCase();
  if (type === "system") {
    const sid =
      (typeof parsed.session_id === "string" && parsed.session_id.trim()) ||
      (typeof parsed.sessionId === "string" && parsed.sessionId.trim()) ||
      "";
    return [{ kind: "system", text: sid ? `session: ${sid}` : "session init" }];
  }
  if (type === "assistant") {
    const message = parsed.message;
    if (message && typeof message === "object" && !Array.isArray(message)) {
      const content = (message as Record<string, unknown>).content;
      if (Array.isArray(content)) {
        const texts: string[] = [];
        for (const entry of content) {
          if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
          const block = entry as Record<string, unknown>;
          const text = typeof block.text === "string" ? block.text.trim() : "";
          if (text) texts.push(text);
        }
        if (texts.length > 0) return [{ kind: "assistant", text: clipText(texts.join("\n"), 1200) }];
      }
    }
    return [];
  }
  if (type === "result") {
    const resultText =
      (typeof parsed.result === "string" && parsed.result.trim()) ||
      (typeof parsed.text === "string" && parsed.text.trim()) ||
      "";
    const usage = parsed.usage as Record<string, unknown> | undefined;
    const stats = parsed.stats as Record<string, unknown> | undefined;
    const inT =
      (usage && typeof usage === "object" ? toNumber(usage.input_tokens ?? usage.inputTokens) : undefined) ??
      (stats && typeof stats === "object" ? toNumber(stats.input_tokens ?? stats.inputTokens ?? stats.input) : undefined) ??
      0;
    const outT =
      (usage && typeof usage === "object" ? toNumber(usage.output_tokens ?? usage.outputTokens) : undefined) ??
      (stats && typeof stats === "object" ? toNumber(stats.output_tokens ?? stats.outputTokens ?? stats.output) : undefined) ??
      0;
    const cost = toNumber(parsed.total_cost_usd ?? parsed.cost_usd ?? parsed.cost) ?? 0;
    const usageSuffix = inT > 0 || outT > 0 || cost > 0
      ? `tokens in=${inT} out=${outT} cost=$${cost.toFixed(6)}`
      : "";
    return [
      {
        kind: "result",
        text: clipText(
          [resultText, usageSuffix].filter(Boolean).join("\n"),
          1200
        )
      }
    ];
  }
  if (type === "error") {
    const msg =
      (typeof parsed.error === "string" && parsed.error.trim()) ||
      (typeof parsed.message === "string" && parsed.message.trim()) ||
      "";
    return msg ? [{ kind: "stderr", text: clipText(msg, 800) }] : [];
  }
  return [];
}

function parseGeminiTranscript(stdout: string, stderr: string): RuntimeTranscriptEvent[] | undefined {
  const events: RuntimeTranscriptEvent[] = [];
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith("{") || !line.endsWith("}")) continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const type = (typeof parsed.type === "string" ? parsed.type : "").trim().toLowerCase();
    if (type === "system") {
      const sid =
        (typeof parsed.session_id === "string" && parsed.session_id.trim()) ||
        (typeof parsed.sessionId === "string" && parsed.sessionId.trim()) ||
        "";
      events.push({ kind: "system", text: sid ? `session: ${sid}` : "session init" });
      continue;
    }
    if (type === "assistant") {
      const message = parsed.message;
      if (message && typeof message === "object" && !Array.isArray(message)) {
        const content = (message as Record<string, unknown>).content;
        if (Array.isArray(content)) {
          for (const entry of content) {
            if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
            const block = entry as Record<string, unknown>;
            const text = typeof block.text === "string" ? block.text.trim() : "";
            if (text) events.push({ kind: "assistant", text: clipText(text, 1200) });
          }
        }
      }
      const resultText = typeof (message as Record<string, unknown>)?.text === "string" ? ((message as Record<string, unknown>).text as string).trim() : "";
      if (resultText && events.filter((e) => e.kind === "assistant").length === 0) {
        events.push({ kind: "assistant", text: clipText(resultText, 1200) });
      }
      continue;
    }
    if (type === "result") {
      const resultText =
        (typeof parsed.result === "string" && parsed.result.trim()) ||
        (typeof parsed.text === "string" && parsed.text.trim()) ||
        "";
      const usage = parsed.usage as Record<string, unknown> | undefined;
      const stats = parsed.stats as Record<string, unknown> | undefined;
      const inT =
        (usage && typeof usage === "object" ? toNumber(usage.input_tokens ?? usage.inputTokens) : undefined) ??
        (stats && typeof stats === "object" ? toNumber(stats.input_tokens ?? stats.inputTokens ?? stats.input) : undefined) ??
        0;
      const outT =
        (usage && typeof usage === "object" ? toNumber(usage.output_tokens ?? usage.outputTokens) : undefined) ??
        (stats && typeof stats === "object" ? toNumber(stats.output_tokens ?? stats.outputTokens ?? stats.output) : undefined) ??
        0;
      const cost = toNumber(parsed.total_cost_usd ?? parsed.cost_usd ?? parsed.cost) ?? 0;
      const usageSuffix = inT > 0 || outT > 0 || cost > 0
        ? `tokens in=${inT} out=${outT} cost=$${cost.toFixed(6)}`
        : "";
      events.push({
        kind: "result",
        text: clipText(
          [resultText, usageSuffix].filter(Boolean).join("\n"),
          1200
        )
      });
      continue;
    }
    if (type === "error") {
      const msg =
        (typeof parsed.error === "string" && parsed.error.trim()) ||
        (typeof parsed.message === "string" && parsed.message.trim()) ||
        "";
      if (msg) events.push({ kind: "stderr", text: clipText(msg, 800) });
    }
  }
  const stderrEvents = parseStderrTranscript(stderr);
  if (stderrEvents) events.push(...stderrEvents.slice(0, 10));
  if (events.length === 0) return undefined;
  return events.slice(0, 140);
}

function parseOpenCodeStreamingTranscriptLine(line: string): RuntimeTranscriptEvent[] {
  const parsed = parseJsonRecord(line);
  if (!parsed) {
    return [];
  }
  const type = codexAsString(parsed.type).trim().toLowerCase();
  if (!type) {
    return [];
  }
  if (type === "text") {
    const part = codexAsRecord(parsed.part);
    const text = codexAsString(part?.text).trim();
    return text ? [{ kind: "assistant", text: clipText(text, 1200) }] : [];
  }
  if (type === "reasoning") {
    const part = codexAsRecord(parsed.part);
    const text = codexAsString(part?.text).trim();
    return text ? [{ kind: "thinking", text: clipText(text, 500) }] : [];
  }
  if (type === "tool_use") {
    const part = codexAsRecord(parsed.part);
    if (!part) {
      return [{ kind: "tool_call", label: "tool", text: "tool event" }];
    }
    const toolName = codexAsString(part.tool, "tool");
    const state = codexAsRecord(part.state);
    const inputPayload = safeJson(state?.input ?? part.input ?? {});
    const events: RuntimeTranscriptEvent[] = [
      {
        kind: "tool_call",
        label: toolName,
        text: toolName,
        ...(inputPayload ? { payload: clipText(inputPayload, 2000) } : {})
      }
    ];
    const status = codexAsString(state?.status).trim().toLowerCase();
    if (status === "completed" || status === "error") {
      const metadata = codexAsRecord(state?.metadata);
      const metadataLines: string[] = [];
      if (metadata) {
        for (const [key, value] of Object.entries(metadata)) {
          if (value !== undefined && value !== null) {
            metadataLines.push(`${key}: ${String(value)}`);
          }
        }
      }
      const outputText =
        firstNonEmptyString(state?.output, state?.error, part.title) ?? `${toolName} ${status}`;
      const content = [
        `status: ${status}`,
        ...metadataLines,
        "",
        outputText
      ]
        .join("\n")
        .trim();
      events.push({
        kind: "tool_result",
        label: codexAsString(part.callID, codexAsString(part.id, toolName)),
        text: clipText(content, 2000)
      });
    }
    return events;
  }
  if (type === "step_start") {
    const sessionId = codexAsString(parsed.sessionID).trim();
    return [
      {
        kind: "system",
        text: sessionId ? `step started (${sessionId})` : "step started"
      }
    ];
  }
  if (type === "step_finish") {
    const part = codexAsRecord(parsed.part);
    const reason = codexAsString(part?.reason, "step");
    const tokens = codexAsRecord(part?.tokens);
    const cache = codexAsRecord(tokens?.cache);
    const inputTokens = codexAsNumber(tokens?.input, 0);
    const outputTokens = codexAsNumber(tokens?.output, 0) + codexAsNumber(tokens?.reasoning, 0);
    const cachedTokens = codexAsNumber(cache?.read, 0);
    const cost = codexAsNumber(part?.cost, 0);
    return [
      {
        kind: "result",
        label: reason,
        text: clipText(
          `${reason}\ntokens in=${inputTokens} out=${outputTokens} cached=${cachedTokens} cost=$${cost.toFixed(6)}`,
          1200
        )
      }
    ];
  }
  if (type === "error") {
    const message = codexErrorText(parsed.error ?? parsed.message ?? parsed);
    return message ? [{ kind: "stderr", text: clipText(message, 800) }] : [];
  }
  return [];
}

function parseCodexTranscript(stdout: string, stderr: string): RuntimeTranscriptEvent[] | undefined {
  const events: RuntimeTranscriptEvent[] = [];
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    events.push(...parseCodexTranscriptLine(line));
  }
  const stderrEvents = parseStderrTranscript(stderr);
  if (stderrEvents) {
    events.push(...stderrEvents.slice(0, 10));
  }
  if (events.length === 0) {
    return undefined;
  }
  return events.slice(0, 140);
}

function parseCodexTranscriptLine(line: string): RuntimeTranscriptEvent[] {
  const parsed = parseJsonRecord(line);
  if (!parsed) {
    return [];
  }

  const type = codexAsString(parsed.type);
  if (type === "thread.started") {
    return [];
  }
  if (type === "item.started" || type === "item.completed") {
    const item = codexAsRecord(parsed.item);
    if (!item) {
      return [];
    }
    return parseCodexTranscriptItem(item, type === "item.started" ? "started" : "completed");
  }
  if (type === "turn.completed" || type === "turn.failed") {
    const usage = codexAsRecord(parsed.usage);
    const inputTokens = codexAsNumber(usage?.input_tokens);
    const outputTokens = codexAsNumber(usage?.output_tokens);
    const cachedTokens = codexAsNumber(usage?.cached_input_tokens, codexAsNumber(usage?.cache_read_input_tokens));
    const message =
      type === "turn.failed" ? codexErrorText(parsed.error ?? parsed.message ?? parsed) : codexAsString(parsed.result);
    const errors =
      type === "turn.failed"
        ? [message].filter(Boolean)
        : Array.isArray(parsed.errors)
          ? parsed.errors.map((entry) => codexErrorText(entry)).filter(Boolean)
          : [];
    const summaryLines = [
      message,
      `tokens in=${inputTokens} out=${outputTokens} cached=${cachedTokens}`,
      `subtype=${codexAsString(parsed.subtype, type)} is_error=${type === "turn.failed" || parsed.is_error === true ? "true" : "false"}`,
      ...(errors.length > 0 ? [`errors=${errors.join(" | ")}`] : []),
    ].filter(Boolean);
    return [{
      kind: "result",
      label: codexAsString(parsed.subtype, type),
      text: clipText(summaryLines.join("\n"), 1200),
    }];
  }
  if (type === "error") {
    const message = codexErrorText(parsed.message ?? parsed.error ?? parsed);
    return message ? [{ kind: "stderr", text: clipText(message, 400) }] : [];
  }
  return [];
}

function parseCodexTranscriptItem(
  item: Record<string, unknown>,
  phase: "started" | "completed",
): RuntimeTranscriptEvent[] {
  const itemType = codexAsString(item.type);
  if (itemType === "agent_message" && phase === "completed") {
    const text = codexAsString(item.text);
    return text ? [{ kind: "assistant", text: clipText(text, 600) }] : [];
  }
  if (itemType === "reasoning") {
    const text = codexAsString(item.text);
    return text ? [{ kind: "thinking", text: clipText(text, 300) }] : [];
  }
  if (itemType === "command_execution") {
    return parseCodexCommandExecutionItem(item, phase);
  }
  if (itemType === "tool_use") {
    return [{
      kind: "tool_call",
      label: codexAsString(item.name, "unknown"),
      payload: clipText(stringifyJsonPretty(item.input ?? {}), 1600),
    }];
  }
  if (itemType === "tool_result" && phase === "completed") {
    const content =
      codexAsString(item.content) ||
      codexAsString(item.output) ||
      codexAsString(item.result) ||
      stringifyJsonPretty(item.content ?? item.output ?? item.result);
    const toolUseId = codexAsString(item.tool_use_id, codexAsString(item.id, "tool_result"));
    return [{
      kind: "tool_result",
      label: toolUseId,
      text: clipText(content, 1800),
    }];
  }
  return [];
}

function parseCodexCommandExecutionItem(
  item: Record<string, unknown>,
  phase: "started" | "completed",
): RuntimeTranscriptEvent[] {
  const id = codexAsString(item.id);
  const command = codexAsString(item.command);
  if (phase === "started") {
    return [{
      kind: "tool_call",
      label: "command_execution",
      payload: clipText(
        stringifyJsonPretty({
          id,
          command,
        }),
        1000,
      ),
    }];
  }
  const status = codexAsString(item.status);
  const exitCode = typeof item.exit_code === "number" && Number.isFinite(item.exit_code) ? item.exit_code : null;
  const output = codexAsString(item.aggregated_output).replace(/\s+$/, "");
  const lines = [
    command ? `command: ${command}` : "",
    status ? `status: ${status}` : "",
    exitCode !== null ? `exit_code: ${exitCode}` : "",
    output ? `\n${output}` : "",
  ].filter(Boolean);
  return [{
    kind: "tool_result",
    label: id || command || "command_execution",
    text: clipText(lines.join("\n"), 1800),
  }];
}

function parseJsonRecord(line: string) {
  if (!line.startsWith("{") || !line.endsWith("}")) {
    return null;
  }
  try {
    const parsed = JSON.parse(line) as unknown;
    return codexAsRecord(parsed);
  } catch {
    return null;
  }
}

function codexAsRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function codexAsString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function codexAsNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function codexErrorText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  const record = codexAsRecord(value);
  if (!record) {
    return "";
  }
  return (
    codexAsString(record.message) ||
    codexAsString(record.error) ||
    codexAsString(record.code) ||
    stringifyJsonPretty(record)
  );
}

function stringifyJsonPretty(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value === null || value === undefined) {
    return "";
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function parseCursorTranscript(stdout: string, stderr: string): RuntimeTranscriptEvent[] | undefined {
  const events: RuntimeTranscriptEvent[] = [];
  for (const rawLine of stdout.split(/\r?\n/)) {
    const normalized = normalizeCursorStreamLine(rawLine).line;
    if (!normalized.startsWith("{") || !normalized.endsWith("}")) {
      continue;
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(normalized) as Record<string, unknown>;
    } catch {
      continue;
    }
    const type = typeof parsed.type === "string" ? parsed.type.trim().toLowerCase() : "";
    if (type === "system") {
      const model = firstNonEmptyString(parsed.model);
      const sessionId = readCursorSessionId(parsed);
      const bits = [model ? `model:${model}` : "", sessionId ? `session:${sessionId}` : ""].filter(Boolean);
      events.push({
        kind: "system",
        label: firstNonEmptyString(parsed.subtype),
        text: bits.join(" ") || "session init"
      });
      continue;
    }
    if (type === "assistant" || type === "user") {
      const kind = type === "user" ? "system" : "assistant";
      const content =
        parsed.message && typeof parsed.message === "object" && !Array.isArray(parsed.message)
          ? (((parsed.message as Record<string, unknown>).content as unknown[]) ?? [])
          : [];
      for (const entry of content) {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
          continue;
        }
        const block = entry as Record<string, unknown>;
        const blockType = typeof block.type === "string" ? block.type.trim().toLowerCase() : "";
        if ((blockType === "thinking" || blockType === "reasoning") && typeof block.text === "string") {
          events.push({ kind: "thinking", text: clipText(block.text, 300) });
          continue;
        }
        if (blockType === "text" || blockType === "output_text") {
          const text = firstNonEmptyString(block.text);
          if (text) {
            events.push({ kind, text: clipText(text, 300) });
          }
          continue;
        }
        if (blockType === "tool_call" || blockType === "tool_use") {
          const label = firstNonEmptyString(block.name) ?? firstNonEmptyString(block.tool_name) ?? "tool";
          const payload = safeJson(block.input ?? block.args ?? block.tool_call);
          events.push({
            kind: "tool_call",
            label,
            ...(payload ? { payload: clipText(payload, 520) } : {})
          });
          continue;
        }
        if (blockType === "tool_result") {
          const payload = safeJson(block.output ?? block.content ?? block.result);
          events.push({
            kind: "tool_result",
            label: firstNonEmptyString(block.tool_use_id) ?? undefined,
            text: clipText(payload ?? "tool result", 320)
          });
        }
      }
      continue;
    }
    if (type === "thinking") {
      const thinkingText = firstNonEmptyString(parsed.text, parsed.message);
      if (thinkingText) {
        events.push({ kind: "thinking", text: clipText(thinkingText, 300) });
      }
      continue;
    }
    if (type === "tool_call") {
      const subtype = firstNonEmptyString(parsed.subtype);
      const toolCall = parsed.tool_call;
      if (toolCall && typeof toolCall === "object" && !Array.isArray(toolCall)) {
        const [toolName, toolValue] = Object.entries(toolCall as Record<string, unknown>)[0] ?? [];
        if (subtype === "completed") {
          events.push({
            kind: "tool_result",
            label: firstNonEmptyString(parsed.call_id) ?? toolName ?? undefined,
            text: clipText(safeJson(toolValue) ?? "tool result", 320)
          });
        } else {
          const payload =
            toolValue && typeof toolValue === "object" && !Array.isArray(toolValue)
              ? safeJson((toolValue as Record<string, unknown>).args ?? toolValue)
              : safeJson(toolValue);
          events.push({
            kind: "tool_call",
            label: toolName ?? firstNonEmptyString(parsed.call_id) ?? "tool",
            ...(payload ? { payload: clipText(payload, 520) } : {})
          });
        }
      }
      continue;
    }
    if (type === "result" || type === "error") {
      const label = firstNonEmptyString(parsed.subtype);
      const text =
        firstNonEmptyString(parsed.result, parsed.message, parsed.error, parsed.detail) ?? `${type} event`;
      events.push({
        kind: type === "error" ? "stderr" : "result",
        ...(label ? { label } : {}),
        text: clipText(text, 320)
      });
    }
  }
  const stderrEvents = parseStderrTranscript(stderr);
  if (stderrEvents) {
    events.push(...stderrEvents.slice(0, 10));
  }
  if (events.length === 0) {
    return undefined;
  }
  return events.slice(0, 120);
}

function parseGenericTranscript(stdout: string, stderr: string): RuntimeTranscriptEvent[] | undefined {
  const events: RuntimeTranscriptEvent[] = [];
  let lastToolEventIndex = -1;
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    const fromJson = parseGenericTranscriptJsonLine(line);
    if (fromJson) {
      events.push(fromJson);
      lastToolEventIndex =
        fromJson.kind === "tool_call" || fromJson.kind === "tool_result" ? events.length - 1 : lastToolEventIndex;
      continue;
    }
    const fromTagged = parseTaggedTranscriptLine(line);
    if (fromTagged) {
      events.push(fromTagged);
      lastToolEventIndex =
        fromTagged.kind === "tool_call" || fromTagged.kind === "tool_result" ? events.length - 1 : lastToolEventIndex;
      continue;
    }
    if (lastToolEventIndex >= 0 && looksLikeToolPayloadLine(line)) {
      const current = events[lastToolEventIndex];
      if (!current) {
        continue;
      }
      const nextPayload = [current.payload, line].filter(Boolean).join("\n");
      events[lastToolEventIndex] = {
        ...current,
        payload: clipText(nextPayload, 520)
      };
    }
  }
  const stderrEvents = parseStderrTranscript(stderr);
  if (stderrEvents) {
    events.push(...stderrEvents.slice(0, 10));
  }
  if (events.length === 0) {
    return undefined;
  }
  return events.slice(0, 120);
}

function parseGenericTranscriptJsonLine(line: string): RuntimeTranscriptEvent | undefined {
  if (!line.startsWith("{") || !line.endsWith("}")) {
    return undefined;
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const kind = normalizeTranscriptKind(parsed.type ?? parsed.kind ?? parsed.event);
  if (!kind) {
    return undefined;
  }
  const label = pickString(
    parsed.subtype,
    parsed.name,
    parsed.tool,
    parsed.tool_name,
    parsed.status,
    parsed.command
  );
  const text = resolveTranscriptTextFromRecord(parsed, kind) ?? `${kind} event`;
  const payload = safeJson(
    parsed.input ??
      parsed.arguments ??
      parsed.params ??
      parsed.output ??
      parsed.data ??
      parsed.tool_call ??
      parsed.call
  );
  return {
    kind,
    ...(label ? { label: clipText(label, 100) } : {}),
    text: clipText(text, 300),
    ...(payload ? { payload: clipText(payload, 520) } : {})
  };
}

function parseTaggedTranscriptLine(line: string): RuntimeTranscriptEvent | undefined {
  const timestampPrefix = /^\d{2}:\d{2}:\d{2}\s+/;
  const withoutTimestamp = timestampPrefix.test(line) ? line.replace(timestampPrefix, "") : line;
  const match = /^(system|assistant|thinking|tool_call|tool_result|result|stderr)\s*(.*)$/i.exec(
    withoutTimestamp
  );
  if (!match) {
    return undefined;
  }
  const kind = normalizeTranscriptKind(match[1]);
  if (!kind) {
    return undefined;
  }
  const rest = match[2]?.trim();
  return {
    kind,
    text: clipText(rest || `${kind} event`, 300),
    ...(rest && (kind === "tool_call" || kind === "tool_result") ? { label: clipText(rest, 120) } : {})
  };
}

function normalizeTranscriptKind(value: unknown): RuntimeTranscriptEvent["kind"] | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (
    normalized === "system" ||
    normalized === "assistant" ||
    normalized === "thinking" ||
    normalized === "tool_call" ||
    normalized === "tool_result" ||
    normalized === "result" ||
    normalized === "stderr"
  ) {
    return normalized;
  }
  if (normalized === "error" || normalized === "fatal") {
    return "stderr";
  }
  if (
    normalized === "message" ||
    normalized === "text" ||
    normalized === "output_text" ||
    normalized === "assistant_text" ||
    normalized === "assistant_message"
  ) {
    return "assistant";
  }
  if (normalized === "tool_use" || normalized === "tool" || normalized === "call") {
    return "tool_call";
  }
  if (normalized === "tool_output" || normalized === "tool_response") {
    return "tool_result";
  }
  return undefined;
}

function pickString(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

function resolveTranscriptTextFromRecord(
  record: Record<string, unknown>,
  kind: RuntimeTranscriptEvent["kind"]
) {
  const messageText = extractTranscriptText(record.message);
  const contentText = extractTranscriptText(record.content);
  const detailText = pickString(record.text, record.result, record.summary, record.detail, record.command);
  if (kind === "tool_call" && !messageText && !contentText && !detailText) {
    return pickString(record.tool, record.tool_name, record.name, record.command);
  }
  return firstNonEmptyString(messageText, contentText, detailText);
}

function extractTranscriptText(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  if (Array.isArray(value)) {
    const parts = value
      .map((entry) => extractTranscriptText(entry))
      .filter((entry): entry is string => Boolean(entry && entry.trim().length > 0));
    if (parts.length > 0) {
      return parts.join("\n");
    }
    return undefined;
  }
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.text === "string" && record.text.trim().length > 0) {
    return record.text.trim();
  }
  if (typeof record.content === "string" && record.content.trim().length > 0) {
    return record.content.trim();
  }
  if (Array.isArray(record.content)) {
    const parts = record.content
      .map((entry) => extractTranscriptText(entry))
      .filter((entry): entry is string => Boolean(entry && entry.trim().length > 0));
    if (parts.length > 0) {
      return parts.join("\n");
    }
  }
  if (typeof record.result === "string" && record.result.trim().length > 0) {
    return record.result.trim();
  }
  if (typeof record.message === "string" && record.message.trim().length > 0) {
    return record.message.trim();
  }
  return undefined;
}

function looksLikeToolPayloadLine(line: string) {
  return (
    line.startsWith("{") ||
    line.startsWith("}") ||
    line.startsWith("\"") ||
    /^[a-zA-Z_][a-zA-Z0-9_]*\s*:/.test(line)
  );
}

function parseStderrTranscript(stderr: string): RuntimeTranscriptEvent[] | undefined {
  const lines = stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 120);
  if (lines.length === 0) {
    return undefined;
  }
  const events: RuntimeTranscriptEvent[] = [];
  for (const line of lines) {
    const parsedSummary = parseSummaryResultJsonLine(line);
    if (parsedSummary) {
      events.push(parsedSummary);
      continue;
    }
    const derived = parseShellStyleStderrEvents(line);
    if (derived.length > 0) {
      events.push(...derived);
      continue;
    }
    if (!looksLikeErrorSignal(line)) {
      continue;
    }
    events.push({
      kind: "stderr",
      text: clipText(line, 300)
    });
  }
  if (events.length === 0) {
    return undefined;
  }
  return events.slice(0, 60);
}

function parseSummaryResultJsonLine(line: string): RuntimeTranscriptEvent | undefined {
  if (!line.startsWith("{") || !line.endsWith("}")) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    const summary = typeof parsed.summary === "string" ? parsed.summary.trim() : "";
    if (!summary) {
      return undefined;
    }
    return {
      kind: "result",
      label: "summary",
      text: clipText(summary, 600),
      payload: clipText(line, 1200)
    };
  } catch {
    return undefined;
  }
}

function safeJson(value: unknown) {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function normalizeCursorStreamLine(rawLine: string) {
  const trimmed = rawLine.trim();
  if (trimmed.startsWith("stdout{") || trimmed.startsWith("stderr{")) {
    return { line: trimmed.slice(6), stream: trimmed.slice(0, 6) as "stdout" | "stderr" };
  }
  return { line: trimmed, stream: undefined };
}

function readCursorSessionId(event: Record<string, unknown>) {
  return firstNonEmptyString(event.session_id, event.sessionId, event.sessionID);
}

function collectCursorAssistantText(message: unknown) {
  if (typeof message === "string") {
    return message.trim() ? [message.trim()] : [];
  }
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return [];
  }
  const record = message as Record<string, unknown>;
  const lines: string[] = [];
  const directText = firstNonEmptyString(record.text);
  if (directText) {
    lines.push(directText);
  }
  const content = Array.isArray(record.content) ? record.content : [];
  for (const entry of content) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }
    const block = entry as Record<string, unknown>;
    const type = typeof block.type === "string" ? block.type.trim().toLowerCase() : "";
    if (type !== "output_text" && type !== "text") {
      continue;
    }
    const text = firstNonEmptyString(block.text);
    if (text) {
      lines.push(text);
    }
  }
  return lines;
}

function asCursorErrorText(value: unknown) {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return "";
  }
  const record = value as Record<string, unknown>;
  const direct = firstNonEmptyString(record.message, record.error, record.code, record.detail);
  if (direct) {
    return direct;
  }
  return safeJson(record) ?? "";
}

function firstNonEmptyString(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function clipText(text: string, max = 220) {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) {
    return normalized;
  }
  return `${normalized.slice(0, max)}...`;
}

function extractJsonObjectBlocks(text: string) {
  const blocks: string[] = [];
  let depth = 0;
  let startIndex = -1;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }
    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === "{") {
      if (depth === 0) {
        startIndex = index;
      }
      depth += 1;
      continue;
    }
    if (char === "}") {
      if (depth === 0) {
        continue;
      }
      depth -= 1;
      if (depth === 0 && startIndex >= 0) {
        blocks.push(text.slice(startIndex, index + 1));
        startIndex = -1;
      }
    }
  }
  return blocks;
}

function tryParseUsage(candidate: string) {
  try {
    const parsed = JSON.parse(candidate) as Record<string, unknown>;
    const direct = toUsageRecord(parsed);
    if (direct) {
      return direct;
    }
    const nested = findNestedUsage(parsed);
    if (nested) {
      return nested;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function toUsageRecord(parsed: Record<string, unknown>) {
    const tokenInput = toNumber(parsed.tokenInput);
    const tokenOutput = toNumber(parsed.tokenOutput);
    const usdCost = toNumber(parsed.usdCost);
    const summary = typeof parsed.summary === "string" ? parsed.summary : undefined;
    if (isPromptTemplateUsage(summary, tokenInput, tokenOutput, usdCost)) {
      return undefined;
    }
    if (
      tokenInput === undefined &&
      tokenOutput === undefined &&
      usdCost === undefined &&
      !summary
    ) {
      return undefined;
    }
    return { tokenInput, tokenOutput, usdCost, summary };
}

function findNestedUsage(parsed: Record<string, unknown>) {
  const queue: unknown[] = Object.values(parsed);
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) {
      continue;
    }
    if (typeof current === "string") {
      const trimmed = current.trim();
      if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
        try {
          const parsedString = JSON.parse(trimmed) as Record<string, unknown>;
          const usage = toUsageRecord(parsedString);
          if (usage) {
            return usage;
          }
          queue.push(...Object.values(parsedString));
        } catch {
          // ignore malformed nested JSON
        }
      }
      continue;
    }
    if (Array.isArray(current)) {
      queue.push(...current);
      continue;
    }
    if (typeof current === "object") {
      const objectValue = current as Record<string, unknown>;
      const usage = toUsageRecord(objectValue);
      if (usage) {
        return usage;
      }
      queue.push(...Object.values(objectValue));
    }
  }
  return undefined;
}

function isPromptTemplateUsage(
  summary: string | undefined,
  tokenInput: number | undefined,
  tokenOutput: number | undefined,
  usdCost: number | undefined
) {
  if (
    summary?.trim().toLowerCase() === "brief outcome and any blocker" &&
    tokenInput === undefined &&
    tokenOutput === undefined &&
    usdCost === undefined
  ) {
    return true;
  }
  return (
    summary === "..." &&
    tokenInput === 123 &&
    tokenOutput === 456 &&
    usdCost === 0.123456
  );
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

function tailLine(value: string) {
  const lines = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.length > 0 ? lines[lines.length - 1] : undefined;
}

function classifyStructuredOutputLikelyCause(
  stdout: string,
  stderr: string,
  stdoutUsage: { summary?: string } | undefined,
  stderrUsage: { summary?: string } | undefined
) {
  const hasStdout = stdout.trim().length > 0;
  const hasStderr = stderr.trim().length > 0;
  if (!hasStdout && !hasStderr) {
    return "no_output_from_runtime" as const;
  }
  if (!stdoutUsage && stderrUsage) {
    return "json_on_stderr_only" as const;
  }
  const jsonLike = /[\{\}\[\]\"]/m.test(stdout) || /[\{\}\[\]\"]/m.test(stderr);
  if (jsonLike) {
    return "schema_or_shape_mismatch" as const;
  }
  return "json_missing" as const;
}
