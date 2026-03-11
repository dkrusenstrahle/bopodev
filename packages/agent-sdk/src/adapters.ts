import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentResult,
  AdapterExecutionResult,
  AdapterMetadata,
  AdapterModelOption,
  AgentAdapter,
  AgentProviderType,
  AgentRuntimeConfig,
  HeartbeatContext
} from "./types";
import { ExecutionOutcomeSchema, type ExecutionOutcome } from "bopodev-contracts";
import { checkRuntimeCommandHealth, executeAgentRuntime, executePromptRuntime } from "./runtime";
import {
  executeDirectApiRuntime,
  probeDirectApiEnvironment,
  resolveDirectApiCredentials,
  type DirectApiProvider
} from "./runtime-http";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

function summarizeWork(context: HeartbeatContext) {
  if (context.workItems.length === 0) {
    return "No assigned work found.";
  }
  return `Processed ${context.workItems.length} assigned issue(s).`;
}

function issueIdsTouched(context: HeartbeatContext) {
  return context.workItems.map((item) => item.issueId);
}

function toOutcome(outcome: ExecutionOutcome): ExecutionOutcome {
  return ExecutionOutcomeSchema.parse(outcome);
}

export class ClaudeCodeAdapter implements AgentAdapter {
  providerType = "claude_code" as const;

  async execute(context: HeartbeatContext): Promise<AdapterExecutionResult> {
    if (context.workItems.length === 0) {
      return createSkippedResult("Claude Code", "claude_code", context);
    }
    return runProviderWork(context, "claude_code", {
      inputRate: 0.000002,
      outputRate: 0.00001
    });
  }
}

export class CodexAdapter implements AgentAdapter {
  providerType = "codex" as const;

  async execute(context: HeartbeatContext): Promise<AdapterExecutionResult> {
    if (context.workItems.length === 0) {
      return createSkippedResult("Codex", "codex", context);
    }
    return runProviderWork(context, "codex", {
      inputRate: 0.0000015,
      outputRate: 0.000008
    });
  }
}

export class CursorAdapter implements AgentAdapter {
  providerType = "cursor" as const;

  async execute(context: HeartbeatContext): Promise<AdapterExecutionResult> {
    if (context.workItems.length === 0) {
      return createSkippedResult("Cursor", "cursor", context);
    }
    return runCursorWork(context);
  }
}

export class OpenCodeAdapter implements AgentAdapter {
  providerType = "opencode" as const;

  async execute(context: HeartbeatContext): Promise<AdapterExecutionResult> {
    if (context.workItems.length === 0) {
      return createSkippedResult("OpenCode", "opencode", context);
    }
    return runOpenCodeWork(context);
  }
}

export class OpenAIApiAdapter implements AgentAdapter {
  providerType = "openai_api" as const;

  async execute(context: HeartbeatContext): Promise<AdapterExecutionResult> {
    if (context.workItems.length === 0) {
      return createSkippedResult("OpenAI API", "openai_api", context);
    }
    return runDirectApiWork(context, "openai_api");
  }
}

export class AnthropicApiAdapter implements AgentAdapter {
  providerType = "anthropic_api" as const;

  async execute(context: HeartbeatContext): Promise<AdapterExecutionResult> {
    if (context.workItems.length === 0) {
      return createSkippedResult("Anthropic API", "anthropic_api", context);
    }
    return runDirectApiWork(context, "anthropic_api");
  }
}

export class GenericHeartbeatAdapter implements AgentAdapter {
  constructor(public providerType: "http" | "shell") {}

  async execute(context: HeartbeatContext): Promise<AdapterExecutionResult> {
    if (context.workItems.length === 0) {
      return createSkippedResult(this.providerType, this.providerType, context);
    }
    if (!context.runtime?.command) {
      return {
        status: "failed",
        summary: `${this.providerType} adapter is missing a runtime command.`,
        tokenInput: 0,
        tokenOutput: 0,
        usdCost: 0,
        outcome: toOutcome({
          kind: "failed",
          issueIdsTouched: issueIdsTouched(context),
          actions: [{ type: "runtime.launch", status: "error", detail: "Missing runtime command." }],
          blockers: [{ code: "runtime_command_missing", message: "Runtime command is required.", retryable: false }],
          artifacts: [],
          nextSuggestedState: "blocked"
        }),
        nextState: context.state
      };
    }

    const prompt = createPrompt(context);
    const runtime = await executePromptRuntime(context.runtime.command, prompt, context.runtime);
    if (runtime.ok) {
      if (!runtime.parsedUsage) {
        const detail = buildMissingStructuredOutputDetail(this.providerType, runtime);
        return {
          status: "failed",
          summary: `${this.providerType} runtime failed: ${detail}`,
          tokenInput: 0,
          tokenOutput: 0,
          usdCost: 0,
          outcome: toOutcome({
            kind: "failed",
            issueIdsTouched: issueIdsTouched(context),
            actions: [{ type: "runtime.execute", status: "error", detail }],
            blockers: [{ code: "missing_structured_output", message: detail, retryable: true }],
            artifacts: [],
            nextSuggestedState: "blocked"
          }),
          trace: {
            command: runtime.commandUsed ?? context.runtime.command,
            args: runtime.argsUsed,
            cwd: context.runtime?.cwd,
            exitCode: runtime.code,
            elapsedMs: runtime.elapsedMs,
            timedOut: runtime.timedOut,
            failureType: "missing_structured_output",
            timeoutSource: runtime.timedOut ? "runtime" : null,
            attemptCount: runtime.attemptCount,
            attempts: runtime.attempts,
            structuredOutputSource: runtime.structuredOutputSource,
            structuredOutputDiagnostics: runtime.structuredOutputDiagnostics,
            stdoutPreview: toPreview(runtime.stdout),
            stderrPreview: toPreview(runtime.stderr),
            transcript: runtime.transcript
          },
          nextState: context.state
        };
      }
      return {
        status: "ok",
        summary: runtime.parsedUsage?.summary ?? `${this.providerType} runtime finished in ${runtime.elapsedMs}ms.`,
        tokenInput: runtime.parsedUsage?.tokenInput ?? 0,
        tokenOutput: runtime.parsedUsage?.tokenOutput ?? 0,
        usdCost: runtime.parsedUsage?.usdCost ?? 0,
        outcome: toOutcome({
          kind: "completed",
          issueIdsTouched: issueIdsTouched(context),
          actions: [{ type: "runtime.execute", status: "ok", detail: `${this.providerType} runtime completed.` }],
          blockers: [],
          artifacts: [],
          nextSuggestedState: "in_review"
        }),
        trace: {
          command: runtime.commandUsed ?? context.runtime.command,
          args: runtime.argsUsed,
            cwd: context.runtime?.cwd,
          exitCode: runtime.code,
          elapsedMs: runtime.elapsedMs,
          timedOut: runtime.timedOut,
          failureType: runtime.failureType,
            timeoutSource: runtime.timedOut ? "runtime" : null,
          usageSource: "structured",
          attemptCount: runtime.attemptCount,
          attempts: runtime.attempts,
            structuredOutputSource: runtime.structuredOutputSource,
            structuredOutputDiagnostics: runtime.structuredOutputDiagnostics,
          stdoutPreview: toPreview(runtime.stdout),
          stderrPreview: toPreview(runtime.stderr),
          transcript: runtime.transcript
        },
        nextState: withProviderMetadata(context, this.providerType, runtime.elapsedMs, runtime.code)
      };
    }

    const failedUsage = resolveFailedUsage(runtime, prompt, {
      inputRate: 0.000001,
      outputRate: 0.000004
    });
    const failureDetail = resolveRuntimeFailureDetail(runtime);
    return {
      status: "failed",
      summary: runtime.parsedUsage?.summary ?? `${this.providerType} runtime failed: ${failureDetail}`,
      tokenInput: failedUsage.tokenInput,
      tokenOutput: failedUsage.tokenOutput,
      usdCost: failedUsage.usdCost,
      outcome: toOutcome({
        kind: "failed",
        issueIdsTouched: issueIdsTouched(context),
        actions: [{ type: "runtime.execute", status: "error", detail: failureDetail }],
        blockers: [{ code: runtime.failureType ?? "runtime_failed", message: failureDetail, retryable: true }],
        artifacts: [],
        nextSuggestedState: "blocked"
      }),
      trace: {
        command: runtime.commandUsed ?? context.runtime.command,
        args: runtime.argsUsed,
        cwd: context.runtime?.cwd,
        exitCode: runtime.code,
        elapsedMs: runtime.elapsedMs,
        timedOut: runtime.timedOut,
        failureType: runtime.failureType,
        timeoutSource: runtime.timedOut ? "runtime" : null,
        attemptCount: runtime.attemptCount,
        attempts: runtime.attempts,
        usageSource: failedUsage.source,
        structuredOutputSource: runtime.structuredOutputSource,
        structuredOutputDiagnostics: runtime.structuredOutputDiagnostics,
        stdoutPreview: toPreview(runtime.stdout),
        stderrPreview: toPreview(runtime.stderr),
        transcript: runtime.transcript
      },
      nextState: context.state
    };
  }
}

type ProviderSessionUpdate = {
  currentSessionId?: string | null;
  resumedSessionId?: string | null;
  resumeAttempted?: boolean;
  resumeSkippedReason?: string | null;
  clearedStaleSession?: boolean;
  cwd?: string | null;
};

const staticMetadata: AdapterMetadata[] = [
  {
    providerType: "claude_code",
    label: "Claude Code",
    supportsModelSelection: true,
    supportsEnvironmentTest: true,
    supportsWebSearch: false,
    supportsThinkingEffort: true,
    requiresRuntimeCwd: true
  },
  {
    providerType: "codex",
    label: "Codex",
    supportsModelSelection: true,
    supportsEnvironmentTest: true,
    supportsWebSearch: true,
    supportsThinkingEffort: true,
    requiresRuntimeCwd: true
  },
  {
    providerType: "cursor",
    label: "Cursor",
    supportsModelSelection: true,
    supportsEnvironmentTest: true,
    supportsWebSearch: false,
    supportsThinkingEffort: false,
    requiresRuntimeCwd: true
  },
  {
    providerType: "opencode",
    label: "OpenCode",
    supportsModelSelection: true,
    supportsEnvironmentTest: true,
    supportsWebSearch: false,
    supportsThinkingEffort: false,
    requiresRuntimeCwd: true
  },
  {
    providerType: "openai_api",
    label: "OpenAI API",
    supportsModelSelection: true,
    supportsEnvironmentTest: true,
    supportsWebSearch: false,
    supportsThinkingEffort: false,
    requiresRuntimeCwd: false
  },
  {
    providerType: "anthropic_api",
    label: "Anthropic API",
    supportsModelSelection: true,
    supportsEnvironmentTest: true,
    supportsWebSearch: false,
    supportsThinkingEffort: false,
    requiresRuntimeCwd: false
  },
  {
    providerType: "http",
    label: "HTTP",
    supportsModelSelection: false,
    supportsEnvironmentTest: false,
    supportsWebSearch: false,
    supportsThinkingEffort: false,
    requiresRuntimeCwd: false
  },
  {
    providerType: "shell",
    label: "Shell",
    supportsModelSelection: false,
    supportsEnvironmentTest: true,
    supportsWebSearch: false,
    supportsThinkingEffort: false,
    requiresRuntimeCwd: true
  }
];

const modelCatalog: Record<Exclude<AgentProviderType, "http" | "shell">, AdapterModelOption[]> = {
  codex: [
    { id: "gpt-5.3-codex", label: "GPT-5.3 Codex" },
    { id: "gpt-5.3-codex-spark", label: "GPT-5.3 Codex Spark" },
    { id: "gpt-5", label: "GPT-5" },
    { id: "o3", label: "o3" },
    { id: "o4-mini", label: "o4-mini" },
    { id: "gpt-5-mini", label: "GPT-5 Mini" },
    { id: "gpt-5-nano", label: "GPT-5 Nano" },
    { id: "o3-mini", label: "o3-mini" },
    { id: "codex-mini-latest", label: "Codex Mini" }
  ],
  claude_code: [
    { id: "claude-opus-4-6", label: "Claude Opus 4.6" },
    { id: "claude-sonnet-4-5-20250929", label: "Claude Sonnet 4.5" },
    { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" }
  ],
  cursor: [
    { id: "auto", label: "Auto" },
    { id: "gpt-5.3-codex", label: "gpt-5.3-codex" },
    { id: "gpt-5.3-codex-fast", label: "gpt-5.3-codex-fast" },
    { id: "sonnet-4.5", label: "sonnet-4.5" },
    { id: "opus-4.6", label: "opus-4.6" }
  ],
  opencode: [],
  openai_api: [
    { id: "gpt-5", label: "GPT-5" },
    { id: "gpt-5-mini", label: "GPT-5 Mini" },
    { id: "gpt-5-nano", label: "GPT-5 Nano" },
    { id: "o3", label: "o3" },
    { id: "o4-mini", label: "o4-mini" }
  ],
  anthropic_api: [
    { id: "claude-opus-4-6", label: "Claude Opus 4.6" },
    { id: "claude-sonnet-4-5-20250929", label: "Claude Sonnet 4.5" },
    { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" }
  ]
};

export function listAdapterMetadata(): AdapterMetadata[] {
  return staticMetadata;
}

export async function listAdapterModels(
  providerType: AgentProviderType,
  runtime?: AgentRuntimeConfig
): Promise<AdapterModelOption[]> {
  if (providerType === "http" || providerType === "shell") {
    return [];
  }
  if (providerType === "cursor") {
    const discovered = await discoverCursorModels(runtime);
    return dedupeModels([...discovered, ...modelCatalog.cursor]);
  }
  if (providerType === "opencode") {
    const discovered = await discoverOpenCodeModelsCached(runtime);
    return dedupeModels(discovered);
  }
  return modelCatalog[providerType];
}

export async function testAdapterEnvironment(
  providerType: AgentProviderType,
  runtime?: AgentRuntimeConfig
): Promise<AdapterEnvironmentResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  if (providerType === "openai_api" || providerType === "anthropic_api") {
    return testDirectApiEnvironment(providerType, runtime);
  }
  const command =
    providerType === "cursor"
      ? (await resolveCursorLaunchConfig(runtime)).command
      : resolveRuntimeCommand(providerType, runtime);
  const cwd = runtime?.cwd?.trim() || process.cwd();
  const health = await checkRuntimeCommandHealth(command, { cwd, timeoutMs: 5_000 });

  if (!health.available) {
    checks.push({
      code: "command_unavailable",
      level: "error",
      message: `Command is not executable: ${command}`,
      detail: health.error
    });
    return {
      providerType,
      status: "fail",
      testedAt: new Date().toISOString(),
      checks
    };
  }

  checks.push({
    code: "command_available",
    level: "info",
    message: `Command is executable: ${command}`
  });

  if (providerType === "http") {
    return { providerType, status: "pass", testedAt: new Date().toISOString(), checks };
  }

  if (providerType === "opencode" && !runtime?.model?.trim()) {
    checks.push({
      code: "model_missing",
      level: "error",
      message: "OpenCode requires a model in provider/model format."
    });
  }

  const probe = await runRuntimeProbe(providerType, runtime);
  if (probe.timedOut) {
    checks.push({
      code: "probe_timeout",
      level: "warn",
      message: "Environment probe timed out."
    });
  } else if (probe.ok) {
    checks.push({
      code: "probe_ok",
      level: "info",
      message: "Environment probe succeeded."
    });
  } else {
    const detail = `${probe.stderr}\n${probe.stdout}`.trim().slice(0, 500);
    const normalizedDetail = detail.toLowerCase();
    if (
      providerType === "codex" &&
      normalizedDetail.includes("401 unauthorized") &&
      (normalizedDetail.includes("missing bearer") || normalizedDetail.includes("authentication"))
    ) {
      checks.push({
        code: "codex_auth_required",
        level: "warn",
        message: "Codex authentication is not ready for this runtime.",
        detail,
        hint: "Run `codex login` locally or provide OPENAI_API_KEY."
      });
      return {
        providerType,
        status: toEnvironmentStatus(checks),
        testedAt: new Date().toISOString(),
        checks
      };
    }
    checks.push({
      code: "probe_failed",
      level: providerType === "codex" || providerType === "cursor" || providerType === "opencode" ? "warn" : "error",
      message: "Environment probe failed.",
      detail
    });
  }

  return {
    providerType,
    status: toEnvironmentStatus(checks),
    testedAt: new Date().toISOString(),
    checks
  };
}

function createSkippedResult(providerLabel: string, providerKey: string, context: HeartbeatContext): AdapterExecutionResult {
  return {
    status: "skipped",
    summary: `${providerLabel} adapter: ${summarizeWork(context)}`,
    tokenInput: 0,
    tokenOutput: 0,
    usdCost: 0,
    outcome: toOutcome({
      kind: "skipped",
      issueIdsTouched: issueIdsTouched(context),
      actions: [{ type: "heartbeat.skip", status: "warn", detail: summarizeWork(context) }],
      blockers: [],
      artifacts: [],
      nextSuggestedState: "todo"
    }),
    nextState: withProviderMetadata(context, providerKey)
  };
}

async function runDirectApiWork(
  context: HeartbeatContext,
  provider: "openai_api" | "anthropic_api"
): Promise<AdapterExecutionResult> {
  const prompt = createPrompt(context);
  const runtime = await executeDirectApiRuntime(provider, prompt, context.runtime);
  if (runtime.ok) {
    return {
      status: "ok",
      summary: runtime.summary ?? `${provider} runtime finished in ${runtime.elapsedMs}ms.`,
      tokenInput: runtime.tokenInput ?? 0,
      tokenOutput: runtime.tokenOutput ?? 0,
      usdCost: runtime.usdCost ?? 0,
      outcome: toOutcome({
        kind: "completed",
        issueIdsTouched: issueIdsTouched(context),
        actions: [{ type: "runtime.execute", status: "ok", detail: `${provider} runtime completed.` }],
        blockers: [],
        artifacts: [],
        nextSuggestedState: "in_review"
      }),
      trace: {
        command: runtime.endpoint,
        cwd: context.runtime?.cwd,
        exitCode: runtime.statusCode,
        elapsedMs: runtime.elapsedMs,
        failureType: runtime.failureType,
        usageSource: "structured",
        attemptCount: runtime.attemptCount,
        attempts: runtime.attempts.map((attempt) => ({
          attempt: attempt.attempt,
          code: attempt.statusCode || null,
          timedOut: attempt.failureType === "timeout",
          elapsedMs: attempt.elapsedMs,
          signal: null,
          forcedKill: false
        })),
        stdoutPreview: runtime.responsePreview
      },
      nextState: withProviderMetadata(context, provider, runtime.elapsedMs, runtime.statusCode)
    };
  }
  const failureDetail = runtime.error ?? "direct API request failed";
  return {
    status: "failed",
    summary: `${provider} runtime failed: ${failureDetail}`,
    tokenInput: 0,
    tokenOutput: 0,
    usdCost: 0,
    outcome: toOutcome({
      kind: "failed",
      issueIdsTouched: issueIdsTouched(context),
      actions: [{ type: "runtime.execute", status: "error", detail: failureDetail }],
        blockers: [{
          code: runtime.failureType ?? "runtime_failed",
          message: failureDetail,
          retryable: runtime.failureType !== "auth" && runtime.failureType !== "bad_response"
        }],
      artifacts: [],
      nextSuggestedState: "blocked"
    }),
    trace: {
      command: runtime.endpoint,
      cwd: context.runtime?.cwd,
      exitCode: runtime.statusCode || null,
      elapsedMs: runtime.elapsedMs,
      failureType: runtime.failureType,
      usageSource: "none",
      attemptCount: runtime.attemptCount,
      attempts: runtime.attempts.map((attempt) => ({
        attempt: attempt.attempt,
        code: attempt.statusCode || null,
        timedOut: attempt.failureType === "timeout",
        elapsedMs: attempt.elapsedMs,
        signal: null,
        forcedKill: false
      })),
      stderrPreview: runtime.error,
      stdoutPreview: runtime.responsePreview
    },
    nextState: context.state
  };
}

async function testDirectApiEnvironment(
  providerType: DirectApiProvider,
  runtime?: AgentRuntimeConfig
): Promise<AdapterEnvironmentResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const credentials = resolveDirectApiCredentials(providerType, runtime);
  if (!credentials.key) {
    checks.push({
      code: "api_key_missing",
      level: "error",
      message: `${providerType} API key is missing.`,
      hint:
        providerType === "openai_api"
          ? "Set OPENAI_API_KEY or BOPO_OPENAI_API_KEY in runtime env or host environment."
          : "Set ANTHROPIC_API_KEY or BOPO_ANTHROPIC_API_KEY in runtime env or host environment."
    });
    return {
      providerType,
      status: "fail",
      testedAt: new Date().toISOString(),
      checks
    };
  }
  checks.push({
    code: "api_key_present",
    level: "info",
    message: "API key is present."
  });
  checks.push({
    code: "base_url",
    level: "info",
    message: `Using base URL: ${credentials.baseUrl}`
  });
  const probe = await probeDirectApiEnvironment(providerType, runtime);
  if (probe.ok) {
    checks.push({
      code: "api_probe_ok",
      level: "info",
      message: `${providerType} API probe succeeded.`
    });
  } else {
    checks.push({
      code: "api_probe_failed",
      level: probe.statusCode === 401 || probe.statusCode === 403 ? "error" : "warn",
      message: `${providerType} API probe failed.`,
      detail: probe.message,
      hint: probe.statusCode === 401 || probe.statusCode === 403 ? "Verify API key and organization/project access." : undefined
    });
  }
  return {
    providerType,
    status: toEnvironmentStatus(checks),
    testedAt: new Date().toISOString(),
    checks
  };
}

async function runProviderWork(
  context: HeartbeatContext,
  provider: "claude_code" | "codex",
  pricing: { inputRate: number; outputRate: number }
): Promise<AdapterExecutionResult> {
  const prompt = createPrompt(context);
  const runtime = await executeAgentRuntime(provider, prompt, context.runtime);
  if (runtime.ok) {
    if (!runtime.parsedUsage) {
      const detail = buildMissingStructuredOutputDetail(provider, runtime);
      return {
        status: "failed",
        summary: `${provider} runtime failed: ${detail}`,
        tokenInput: 0,
        tokenOutput: 0,
        usdCost: 0,
        outcome: toOutcome({
          kind: "failed",
          issueIdsTouched: issueIdsTouched(context),
          actions: [{ type: "runtime.execute", status: "error", detail }],
          blockers: [{ code: "missing_structured_output", message: detail, retryable: true }],
          artifacts: [],
          nextSuggestedState: "blocked"
        }),
        trace: {
          command: runtime.commandUsed ?? context.runtime?.command ?? provider,
          args: runtime.argsUsed,
          cwd: context.runtime?.cwd,
          exitCode: runtime.code,
          elapsedMs: runtime.elapsedMs,
          timedOut: runtime.timedOut,
          failureType: "missing_structured_output",
          timeoutSource: runtime.timedOut ? "runtime" : null,
          attemptCount: runtime.attemptCount,
          attempts: runtime.attempts,
          structuredOutputSource: runtime.structuredOutputSource,
          structuredOutputDiagnostics: runtime.structuredOutputDiagnostics,
          stdoutPreview: toPreview(runtime.stdout),
          stderrPreview: toPreview(runtime.stderr),
          transcript: runtime.transcript
        },
        nextState: context.state
      };
    }
    if (provider === "claude_code" && isClaudeRunIncomplete(runtime)) {
      const detail = "Claude run reached max-turns before completing execution for this issue.";
      return {
        status: "failed",
        summary: runtime.parsedUsage?.summary ?? `${provider} runtime failed: ${detail}`,
        tokenInput: runtime.parsedUsage?.tokenInput ?? 0,
        tokenOutput: runtime.parsedUsage?.tokenOutput ?? 0,
        usdCost: runtime.parsedUsage?.usdCost ?? 0,
        outcome: toOutcome({
          kind: "failed",
          issueIdsTouched: issueIdsTouched(context),
          actions: [{ type: "runtime.execute", status: "error", detail }],
          blockers: [{ code: "max_turns_reached", message: detail, retryable: true }],
          artifacts: [],
          nextSuggestedState: "blocked"
        }),
        trace: {
          command: runtime.commandUsed ?? context.runtime?.command ?? provider,
          args: runtime.argsUsed,
          cwd: context.runtime?.cwd,
          exitCode: runtime.code,
          elapsedMs: runtime.elapsedMs,
          timedOut: runtime.timedOut,
          failureType: "max_turns_reached",
          timeoutSource: runtime.timedOut ? "runtime" : null,
          usageSource: "structured",
          attemptCount: runtime.attemptCount,
          attempts: runtime.attempts,
          structuredOutputSource: runtime.structuredOutputSource,
          structuredOutputDiagnostics: runtime.structuredOutputDiagnostics,
          stdoutPreview: toPreview(runtime.stdout),
          stderrPreview: toPreview(runtime.stderr),
          transcript: runtime.transcript
        },
        nextState: context.state
      };
    }
    const fallbackOutputTokens = Math.max(Math.round(runtime.stdout.length / 4), 80);
    const fallbackInputTokens = Math.max(Math.round(prompt.length / 4), 120);
    const tokenInput = runtime.parsedUsage?.tokenInput ?? fallbackInputTokens;
    const tokenOutput = runtime.parsedUsage?.tokenOutput ?? fallbackOutputTokens;
    const usdCost =
      runtime.parsedUsage?.usdCost ??
      Number((tokenInput * pricing.inputRate + tokenOutput * pricing.outputRate).toFixed(6));
    const summary = runtime.parsedUsage?.summary ?? `${provider} runtime finished in ${runtime.elapsedMs}ms.`;

    return {
      status: "ok",
      summary,
      tokenInput,
      tokenOutput,
      usdCost,
      outcome: toOutcome({
        kind: "completed",
        issueIdsTouched: issueIdsTouched(context),
        actions: [{ type: "runtime.execute", status: "ok", detail: `${provider} runtime completed.` }],
        blockers: [],
        artifacts: [],
        nextSuggestedState: "in_review"
      }),
      trace: {
        command: runtime.commandUsed ?? context.runtime?.command ?? provider,
        args: runtime.argsUsed,
        cwd: context.runtime?.cwd,
        exitCode: runtime.code,
        elapsedMs: runtime.elapsedMs,
        timedOut: runtime.timedOut,
        failureType: runtime.failureType,
        timeoutSource: runtime.timedOut ? "runtime" : null,
        usageSource: "structured",
        attemptCount: runtime.attemptCount,
        attempts: runtime.attempts,
        structuredOutputSource: runtime.structuredOutputSource,
        structuredOutputDiagnostics: runtime.structuredOutputDiagnostics,
        stdoutPreview: toPreview(runtime.stdout),
        stderrPreview: toPreview(runtime.stderr),
        transcript: runtime.transcript
      },
      nextState: withProviderMetadata(context, provider, runtime.elapsedMs, runtime.code)
    };
  }
  const failedUsage = resolveFailedUsage(runtime, prompt, pricing);
  const failureDetail = resolveRuntimeFailureDetail(runtime);
  return {
    status: "failed",
    summary: runtime.parsedUsage?.summary ?? `${provider} runtime failed: ${failureDetail}`,
    tokenInput: failedUsage.tokenInput,
    tokenOutput: failedUsage.tokenOutput,
    usdCost: failedUsage.usdCost,
    outcome: toOutcome({
      kind: "failed",
      issueIdsTouched: issueIdsTouched(context),
      actions: [{ type: "runtime.execute", status: "error", detail: failureDetail }],
      blockers: [{ code: runtime.failureType ?? "runtime_failed", message: failureDetail, retryable: true }],
      artifacts: [],
      nextSuggestedState: "blocked"
    }),
    trace: {
      command: runtime.commandUsed ?? context.runtime?.command ?? provider,
      args: runtime.argsUsed,
      cwd: context.runtime?.cwd,
      exitCode: runtime.code,
      elapsedMs: runtime.elapsedMs,
      timedOut: runtime.timedOut,
      failureType: runtime.failureType,
      timeoutSource: runtime.timedOut ? "runtime" : null,
      attemptCount: runtime.attemptCount,
      attempts: runtime.attempts,
      usageSource: failedUsage.source,
      structuredOutputSource: runtime.structuredOutputSource,
      structuredOutputDiagnostics: runtime.structuredOutputDiagnostics,
      stdoutPreview: toPreview(runtime.stdout),
      stderrPreview: toPreview(runtime.stderr),
      transcript: runtime.transcript
    },
    nextState: context.state
  };
}

async function runCursorWork(context: HeartbeatContext): Promise<AdapterExecutionResult> {
  const prompt = createPrompt(context);
  const cursorLaunch = await resolveCursorLaunchConfig(context.runtime);
  const cwd = context.runtime?.cwd?.trim() || process.cwd();
  const resumeState = resolveCursorResumeState(context.state, cwd);
  const runtimeTimeoutMs =
    context.runtime?.timeoutMs && context.runtime.timeoutMs > 0 ? context.runtime.timeoutMs : 15 * 60 * 1000;
  const buildArgs = (resumeSessionId: string | null) => {
    const baseArgs = [...cursorLaunch.prefixArgs, "-p", "--output-format", "stream-json", "--workspace", cwd];
    if (resumeSessionId) {
      baseArgs.push("--resume", resumeSessionId);
    }
    if (context.runtime?.model?.trim()) {
      baseArgs.push("--model", context.runtime.model.trim());
    }
    if (!hasTrustFlag(context.runtime?.args ?? [])) {
      baseArgs.push("--yolo");
    }
    return [...baseArgs, ...(context.runtime?.args ?? [])];
  };
  const runtime = await executePromptRuntime(
    cursorLaunch.command,
    prompt,
    {
      ...context.runtime,
      timeoutMs: runtimeTimeoutMs,
      retryCount: 0,
      args: buildArgs(resumeState.resumeSessionId)
    },
    { provider: "cursor" }
  );
  const initialSessionId = readRuntimeSessionId(
    runtime,
    resumeState.resumeAttempted ? context.state.cursorSession?.sessionId ?? context.state.sessionId ?? null : null
  );
  if (!runtime.ok && resumeState.resumeSessionId && isUnknownSessionError(runtime.stderr, runtime.stdout)) {
    const retry = await executePromptRuntime(
      cursorLaunch.command,
      prompt,
      {
        ...context.runtime,
        timeoutMs: runtimeTimeoutMs,
        retryCount: 0,
        args: buildArgs(null)
      },
      { provider: "cursor" }
    );
    return toProviderResult(context, "cursor", prompt, retry, {
      inputRate: 0.0000015,
      outputRate: 0.000008
    }, {
      currentSessionId: readRuntimeSessionId(retry, null),
      resumedSessionId: resumeState.resumeSessionId,
      resumeAttempted: true,
      clearedStaleSession: !readRuntimeSessionId(retry, null),
      cwd
    });
  }
  return toProviderResult(context, "cursor", prompt, runtime, {
    inputRate: 0.0000015,
    outputRate: 0.000008
  }, {
    currentSessionId: initialSessionId,
    resumedSessionId: resumeState.resumeSessionId,
    resumeAttempted: resumeState.resumeAttempted,
    resumeSkippedReason: resumeState.resumeSkippedReason,
    clearedStaleSession: resumeState.resumeSkippedReason === "cwd_mismatch" && !initialSessionId,
    cwd
  });
}

async function runOpenCodeWork(context: HeartbeatContext): Promise<AdapterExecutionResult> {
  const prompt = createPrompt(context);
  const model = context.runtime?.model?.trim();
  const runtimeTimeoutMs =
    context.runtime?.timeoutMs && context.runtime.timeoutMs > 0 ? context.runtime.timeoutMs : 5 * 60 * 1000;
  if (!model) {
    return {
      status: "failed",
      summary: "opencode runtime requires runtimeModel in provider/model format.",
      tokenInput: 0,
      tokenOutput: 0,
      usdCost: 0,
      outcome: toOutcome({
        kind: "blocked",
        issueIdsTouched: issueIdsTouched(context),
        actions: [{ type: "runtime.validate", status: "error", detail: "Missing runtimeModel." }],
        blockers: [{ code: "model_missing", message: "runtimeModel in provider/model format is required.", retryable: false }],
        artifacts: [],
        nextSuggestedState: "blocked"
      }),
      nextState: context.state
    };
  }
  try {
    await ensureOpenCodeModelConfiguredAndAvailable({
      model,
      command: context.runtime?.command,
      cwd: context.runtime?.cwd,
      env: context.runtime?.env
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "OpenCode model validation failed.";
    return {
      status: "failed",
      summary: message,
      tokenInput: 0,
      tokenOutput: 0,
      usdCost: 0,
      outcome: toOutcome({
        kind: "blocked",
        issueIdsTouched: issueIdsTouched(context),
        actions: [{ type: "runtime.validate", status: "error", detail: message }],
        blockers: [{ code: "model_unavailable", message, retryable: false }],
        artifacts: [],
        nextSuggestedState: "blocked"
      }),
      nextState: context.state
    };
  }
  const resumeSessionId = context.state.sessionId?.trim();
  const baseArgs = ["run", "--format", "json", "--model", model];
  if (resumeSessionId) {
    baseArgs.push("--session", resumeSessionId);
  }
  const runtime = await executePromptRuntime(
    context.runtime?.command ?? "opencode",
    prompt,
    {
      ...context.runtime,
      timeoutMs: runtimeTimeoutMs,
      args: [...baseArgs, ...(context.runtime?.args ?? [])]
    },
    { provider: "opencode" }
  );
  const parsed = parseOpenCodeOutput(runtime.stdout);
  if (!runtime.ok && resumeSessionId && isUnknownSessionError(runtime.stderr, runtime.stdout)) {
    const retry = await executePromptRuntime(
      context.runtime?.command ?? "opencode",
      prompt,
      {
        ...context.runtime,
        timeoutMs: runtimeTimeoutMs,
        args: ["run", "--format", "json", "--model", model, ...(context.runtime?.args ?? [])]
      },
      { provider: "opencode" }
    );
    return toProviderResult(context, "opencode", prompt, retry, {
      inputRate: 0.0000015,
      outputRate: 0.000008
    });
  }
  return toProviderResult(context, "opencode", prompt, runtime, {
    inputRate: 0.0000015,
    outputRate: 0.000008
  }, {
    currentSessionId: parsed.sessionId ?? null
  });
}

function resolveFailedUsage(
  runtime: {
    parsedUsage?: {
      tokenInput?: number;
      tokenOutput?: number;
      usdCost?: number;
      summary?: string;
    };
    failureType?: "timeout" | "spawn_error" | "nonzero_exit";
    stdout: string;
    stderr: string;
  },
  prompt: string,
  pricing: { inputRate: number; outputRate: number }
) {
  if (runtime.parsedUsage) {
    return {
      tokenInput: runtime.parsedUsage.tokenInput ?? 0,
      tokenOutput: runtime.parsedUsage.tokenOutput ?? 0,
      usdCost: runtime.parsedUsage.usdCost ?? 0,
      source: "structured" as const
    };
  }
  if (runtime.failureType === "spawn_error") {
    return {
      tokenInput: 0,
      tokenOutput: 0,
      usdCost: 0,
      source: "none" as const
    };
  }
  const estimatedInput = Math.max(1, Math.floor(prompt.length / 4));
  const estimatedOutput = Math.max(1, Math.floor((runtime.stdout.length + runtime.stderr.length) / 8));
  const estimatedCost = Number((estimatedInput * pricing.inputRate + estimatedOutput * pricing.outputRate).toFixed(6));
  return {
    tokenInput: estimatedInput,
    tokenOutput: estimatedOutput,
    usdCost: estimatedCost,
    source: "estimated" as const
  };
}

function toProviderResult(
  context: HeartbeatContext,
  provider: AgentProviderType,
  prompt: string,
  runtime: {
    ok: boolean;
    code: number | null;
    stdout: string;
    stderr: string;
    timedOut: boolean;
    elapsedMs: number;
    attemptCount: number;
    failureType?: "timeout" | "spawn_error" | "nonzero_exit";
    attempts: Array<{
      attempt: number;
      code: number | null;
      timedOut: boolean;
      elapsedMs: number;
      signal: NodeJS.Signals | null;
      spawnErrorCode?: string;
      forcedKill: boolean;
    }>;
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
      claudeContract?: {
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
    };
    commandUsed?: string;
    argsUsed?: string[];
    transcript?: Array<{
      kind: "system" | "assistant" | "thinking" | "tool_call" | "tool_result" | "result" | "stderr";
      label?: string;
      text?: string;
      payload?: string;
    }>;
  },
  pricing: { inputRate: number; outputRate: number },
  sessionUpdate?: ProviderSessionUpdate
): AdapterExecutionResult {
  if (runtime.ok) {
    if (!runtime.parsedUsage) {
      const detail = buildMissingStructuredOutputDetail(provider, runtime);
      return {
        status: "failed",
        summary: `${provider} runtime failed: ${detail}`,
        tokenInput: 0,
        tokenOutput: 0,
        usdCost: 0,
        outcome: toOutcome({
          kind: "failed",
          issueIdsTouched: issueIdsTouched(context),
          actions: [{ type: "runtime.execute", status: "error", detail }],
          blockers: [{ code: "missing_structured_output", message: detail, retryable: true }],
          artifacts: [],
          nextSuggestedState: "blocked"
        }),
        trace: {
          command: runtime.commandUsed ?? context.runtime?.command ?? provider,
          args: runtime.argsUsed,
          cwd: context.runtime?.cwd,
          exitCode: runtime.code,
          elapsedMs: runtime.elapsedMs,
          timedOut: runtime.timedOut,
          failureType: "missing_structured_output",
          timeoutSource: runtime.timedOut ? "runtime" : null,
          attemptCount: runtime.attemptCount,
          attempts: runtime.attempts,
          session: sessionUpdate,
          structuredOutputSource: runtime.structuredOutputSource,
          structuredOutputDiagnostics: runtime.structuredOutputDiagnostics,
          stdoutPreview: toPreview(runtime.stdout),
          stderrPreview: toPreview(runtime.stderr),
          transcript: runtime.transcript
        },
        nextState: applyProviderSessionState(context, provider, sessionUpdate)
      };
    }
    const fallbackOutputTokens = Math.max(Math.round(runtime.stdout.length / 4), 80);
    const fallbackInputTokens = Math.max(Math.round(prompt.length / 4), 120);
    const tokenInput = runtime.parsedUsage?.tokenInput ?? fallbackInputTokens;
    const tokenOutput = runtime.parsedUsage?.tokenOutput ?? fallbackOutputTokens;
    const usdCost =
      runtime.parsedUsage?.usdCost ??
      Number((tokenInput * pricing.inputRate + tokenOutput * pricing.outputRate).toFixed(6));
    const summary = runtime.parsedUsage?.summary ?? `${provider} runtime finished in ${runtime.elapsedMs}ms.`;
    return {
      status: "ok",
      summary,
      tokenInput,
      tokenOutput,
      usdCost,
      outcome: toOutcome({
        kind: "completed",
        issueIdsTouched: issueIdsTouched(context),
        actions: [{ type: "runtime.execute", status: "ok", detail: `${provider} runtime completed.` }],
        blockers: [],
        artifacts: [],
        nextSuggestedState: "in_review"
      }),
      trace: {
        command: runtime.commandUsed ?? context.runtime?.command ?? provider,
        args: runtime.argsUsed,
        cwd: context.runtime?.cwd,
        exitCode: runtime.code,
        elapsedMs: runtime.elapsedMs,
        timedOut: runtime.timedOut,
        failureType: runtime.failureType,
        timeoutSource: runtime.timedOut ? "runtime" : null,
        usageSource: "structured",
        attemptCount: runtime.attemptCount,
        attempts: runtime.attempts,
        session: sessionUpdate,
        structuredOutputSource: runtime.structuredOutputSource,
        structuredOutputDiagnostics: runtime.structuredOutputDiagnostics,
        stdoutPreview: toPreview(runtime.stdout),
        stderrPreview: toPreview(runtime.stderr),
        transcript: runtime.transcript
      },
      nextState: applyProviderSessionState(context, provider, sessionUpdate, runtime.elapsedMs, runtime.code)
    };
  }
  const failedUsage = resolveFailedUsage(runtime, prompt, pricing);
  const failureDetail = resolveRuntimeFailureDetail(runtime);
  return {
    status: "failed",
    summary: runtime.parsedUsage?.summary ?? `${provider} runtime failed: ${failureDetail}`,
    tokenInput: failedUsage.tokenInput,
    tokenOutput: failedUsage.tokenOutput,
    usdCost: failedUsage.usdCost,
    outcome: toOutcome({
      kind: "failed",
      issueIdsTouched: issueIdsTouched(context),
      actions: [{ type: "runtime.execute", status: "error", detail: failureDetail }],
      blockers: [{ code: runtime.failureType ?? "runtime_failed", message: failureDetail, retryable: true }],
      artifacts: [],
      nextSuggestedState: "blocked"
    }),
    trace: {
      command: runtime.commandUsed ?? context.runtime?.command ?? provider,
      args: runtime.argsUsed,
      cwd: context.runtime?.cwd,
      exitCode: runtime.code,
      elapsedMs: runtime.elapsedMs,
      timedOut: runtime.timedOut,
      failureType: runtime.failureType,
      timeoutSource: runtime.timedOut ? "runtime" : null,
      attemptCount: runtime.attemptCount,
      attempts: runtime.attempts,
      usageSource: failedUsage.source,
      session: sessionUpdate,
      structuredOutputSource: runtime.structuredOutputSource,
      structuredOutputDiagnostics: runtime.structuredOutputDiagnostics,
      stdoutPreview: toPreview(runtime.stdout),
      stderrPreview: toPreview(runtime.stderr),
      transcript: runtime.transcript
    },
    nextState: applyProviderSessionState(context, provider, sessionUpdate)
  };
}

function resolveRuntimeFailureDetail(runtime: {
  stderr: string;
  stdout: string;
  code: number | null;
  failureType?: "timeout" | "spawn_error" | "nonzero_exit";
  attempts: Array<{ spawnErrorCode?: string }>;
}) {
  const stderr = runtime.stderr.trim();
  if (stderr.length > 0) {
    return stderr;
  }
  const lastAttempt = runtime.attempts[runtime.attempts.length - 1];
  if (runtime.failureType === "spawn_error") {
    if (lastAttempt?.spawnErrorCode) {
      return `failed to launch runtime command (${lastAttempt.spawnErrorCode}). Verify the CLI is installed and on PATH.`;
    }
    return "failed to launch runtime command. Verify the CLI is installed and on PATH.";
  }
  if (runtime.failureType === "timeout") {
    return "timed out before completion. Increase runtimeTimeoutSec for this agent/runtime.";
  }
  if (runtime.code !== null) {
    return `process exited with code ${runtime.code} without stderr output.`;
  }
  const stdout = runtime.stdout.trim();
  if (stdout.length > 0) {
    return `no stderr output; stdout preview: ${toPreview(stdout, 320)}`;
  }
  return "runtime exited without diagnostic output.";
}

function parseOpenCodeOutput(stdout: string) {
  let sessionId: string | null = null;
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) continue;
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      const maybeSession =
        (typeof parsed.sessionID === "string" && parsed.sessionID) ||
        (typeof parsed.sessionId === "string" && parsed.sessionId) ||
        null;
      if (maybeSession) {
        sessionId = maybeSession;
      }
    } catch {
      // ignore parser noise
    }
  }
  return { sessionId };
}

function resolveCursorResumeState(state: HeartbeatContext["state"], cwd: string) {
  const savedSessionId = state.cursorSession?.sessionId?.trim() || state.sessionId?.trim() || null;
  const savedCwd = state.cursorSession?.cwd?.trim() || state.cwd?.trim() || null;
  if (!savedSessionId) {
    return {
      resumeSessionId: null,
      resumeAttempted: false,
      resumeSkippedReason: null
    };
  }
  if (savedCwd && resolve(savedCwd) !== resolve(cwd)) {
    return {
      resumeSessionId: null,
      resumeAttempted: false,
      resumeSkippedReason: "cwd_mismatch"
    };
  }
  return {
    resumeSessionId: savedSessionId,
    resumeAttempted: true,
    resumeSkippedReason: null
  };
}

function readRuntimeSessionId(
  runtime: {
    structuredOutputDiagnostics?: {
      claudeSessionId?: string;
      cursorSessionId?: string;
    };
  },
  fallback: string | null
) {
  return runtime.structuredOutputDiagnostics?.cursorSessionId?.trim() || runtime.structuredOutputDiagnostics?.claudeSessionId?.trim() || fallback;
}

function isUnknownSessionError(stderr: string, stdout: string) {
  const haystack = `${stderr}\n${stdout}`.toLowerCase();
  return (
    haystack.includes("unknown session") ||
    haystack.includes("session not found") ||
    haystack.includes("could not resume")
  );
}

function hasTrustFlag(args: string[]) {
  return args.includes("--trust") || args.includes("--yolo") || args.includes("-f");
}

function resolveRuntimeCommand(providerType: AgentProviderType, runtime?: AgentRuntimeConfig) {
  if (runtime?.command?.trim()) return runtime.command.trim();
  if (providerType === "claude_code") return "claude";
  if (providerType === "codex") return "codex";
  if (providerType === "cursor") return "cursor";
  if (providerType === "opencode") return "opencode";
  return providerType;
}

async function runRuntimeProbe(providerType: AgentProviderType, runtime?: AgentRuntimeConfig) {
  const prompt = "Respond with hello.";
  if (providerType === "claude_code" || providerType === "codex") {
    return executeAgentRuntime(providerType, prompt, {
      ...runtime,
      retryCount: 0,
      timeoutMs: runtime?.timeoutMs ? Math.min(runtime.timeoutMs, 45_000) : 45_000
    });
  }
  if (providerType === "cursor") {
    const cursorLaunch = await resolveCursorLaunchConfig(runtime);
    const cwd = runtime?.cwd?.trim() || process.cwd();
    return executePromptRuntime(
      cursorLaunch.command,
      prompt,
      {
        ...runtime,
        args: [...cursorLaunch.prefixArgs, "-p", "--output-format", "stream-json", "--workspace", cwd, ...(runtime?.args ?? [])],
        retryCount: 0,
        timeoutMs: runtime?.timeoutMs ? Math.min(runtime.timeoutMs, 45_000) : 45_000
      },
      { provider: "cursor" }
    );
  }
  if (providerType === "opencode") {
    const model = runtime?.model?.trim();
    return executePromptRuntime(
      resolveRuntimeCommand(providerType, runtime),
      prompt,
      {
        ...runtime,
        args: model
          ? ["run", "--format", "json", "--model", model, ...(runtime?.args ?? [])]
          : ["run", "--format", "json", ...(runtime?.args ?? [])],
        retryCount: 0,
        timeoutMs: runtime?.timeoutMs ? Math.min(runtime.timeoutMs, 45_000) : 45_000
      },
      { provider: "opencode" }
    );
  }
  return executePromptRuntime(resolveRuntimeCommand(providerType, runtime), prompt, {
    ...runtime,
    retryCount: 0,
    timeoutMs: runtime?.timeoutMs ? Math.min(runtime.timeoutMs, 45_000) : 45_000
  });
}

async function discoverCursorModels(runtime?: AgentRuntimeConfig): Promise<AdapterModelOption[]> {
  const cursorLaunch = await resolveCursorLaunchConfig(runtime);
  const probe = await executePromptRuntime(
    cursorLaunch.command,
    "models",
    {
      ...runtime,
      args: [...cursorLaunch.prefixArgs, "models"],
      timeoutMs: 8_000,
      retryCount: 0
    },
    { provider: "cursor" }
  );
  if (!probe.ok && probe.stdout.trim().length === 0 && probe.stderr.trim().length === 0) {
    return [];
  }
  return parseModelLines(`${probe.stdout}\n${probe.stderr}`);
}

async function discoverOpenCodeModels(runtime?: AgentRuntimeConfig): Promise<AdapterModelOption[]> {
  const probe = await executePromptRuntime(
    resolveRuntimeCommand("opencode", runtime),
    "",
    {
      ...runtime,
      args: ["models"],
      timeoutMs: 120_000,
      retryCount: 0
    },
    { provider: "opencode" }
  );
  if (!probe.ok && !probe.stdout.trim() && !probe.stderr.trim()) {
    return [];
  }
  return parseModelLines(`${probe.stdout}\n${probe.stderr}`).filter((entry) => entry.id.includes("/"));
}

const OPENCODE_MODEL_DISCOVERY_TTL_MS = 60_000;
const openCodeModelDiscoveryCache = new Map<string, { expiresAt: number; models: AdapterModelOption[] }>();

function normalizeRuntimeEnv(env: unknown): Record<string, string> {
  if (!env || typeof env !== "object" || Array.isArray(env)) {
    return {};
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env as Record<string, unknown>)) {
    if (typeof value === "string") {
      out[key] = value;
    }
  }
  return out;
}

function openCodeModelCacheKey(runtime?: AgentRuntimeConfig) {
  const command = resolveRuntimeCommand("opencode", runtime);
  const cwd = runtime?.cwd?.trim() || process.cwd();
  const env = normalizeRuntimeEnv(runtime?.env);
  const envSignature = Object.entries(env)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  return `${command}\n${cwd}\n${envSignature}`;
}

async function discoverOpenCodeModelsCached(runtime?: AgentRuntimeConfig): Promise<AdapterModelOption[]> {
  const key = openCodeModelCacheKey(runtime);
  const now = Date.now();
  for (const [cacheKey, cacheValue] of openCodeModelDiscoveryCache.entries()) {
    if (cacheValue.expiresAt <= now) {
      openCodeModelDiscoveryCache.delete(cacheKey);
    }
  }
  const cached = openCodeModelDiscoveryCache.get(key);
  if (cached && cached.expiresAt > now) {
    return cached.models;
  }
  const models = await discoverOpenCodeModels(runtime);
  openCodeModelDiscoveryCache.set(key, {
    expiresAt: now + OPENCODE_MODEL_DISCOVERY_TTL_MS,
    models
  });
  return models;
}

async function ensureOpenCodeModelConfiguredAndAvailable(input: {
  model?: string;
  command?: string;
  cwd?: string;
  env?: Record<string, string>;
}) {
  const normalizedModel = input.model?.trim();
  if (!normalizedModel) {
    throw new Error("OpenCode requires runtimeModel in provider/model format.");
  }
  const models = await discoverOpenCodeModelsCached({
    command: input.command,
    cwd: input.cwd,
    env: input.env
  });
  if (models.length === 0) {
    throw new Error("OpenCode returned no models. Run `opencode models` and verify provider auth.");
  }
  if (!models.some((entry) => entry.id === normalizedModel)) {
    const sample = models.slice(0, 12).map((entry) => entry.id).join(", ");
    throw new Error(
      `Configured OpenCode model is unavailable: ${normalizedModel}. Available models: ${sample}${models.length > 12 ? ", ..." : ""}`
    );
  }
}

function parseModelLines(text: string): AdapterModelOption[] {
  const out: AdapterModelOption[] = [];
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (const line of lines) {
    if (line.startsWith("{") || line.startsWith("[")) {
      try {
        const parsed = JSON.parse(line) as unknown;
        if (Array.isArray(parsed)) {
          for (const entry of parsed) {
            if (typeof entry === "string") {
              out.push({ id: entry, label: entry });
            } else if (entry && typeof entry === "object") {
              const id = (entry as Record<string, unknown>).id;
              if (typeof id === "string" && id.trim()) out.push({ id, label: id });
            }
          }
        }
      } catch {
        // ignore
      }
      continue;
    }
    const first = line.replace(/^[-*]\s+/, "").split(/\s+/)[0];
    if (first && /^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(first)) {
      out.push({ id: first, label: first });
    }
  }
  return dedupeModels(out);
}

function dedupeModels(models: AdapterModelOption[]) {
  const seen = new Set<string>();
  const deduped: AdapterModelOption[] = [];
  for (const model of models) {
    const id = model.id.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    deduped.push({ id, label: model.label.trim() || id });
  }
  return deduped;
}

async function resolveCursorLaunchConfig(runtime?: AgentRuntimeConfig): Promise<{ command: string; prefixArgs: string[] }> {
  const configuredCommand = runtime?.command?.trim();
  if (configuredCommand) {
    const commandToken = configuredCommand.split(/[\\/]/).pop()?.toLowerCase() ?? configuredCommand.toLowerCase();
    const configuredArgs = runtime?.args ?? [];
    const hasAgentSubcommand = configuredArgs[0]?.toLowerCase() === "agent";
    if (commandToken === "cursor" || commandToken === "cursor.exe") {
      return { command: configuredCommand, prefixArgs: hasAgentSubcommand ? [] : ["agent"] };
    }
    if (commandToken !== "agent" && commandToken !== "agent.exe") {
      return { command: configuredCommand, prefixArgs: [] };
    }
    const configuredHealth = await checkRuntimeCommandHealth(configuredCommand, {
      cwd: runtime?.cwd?.trim() || process.cwd(),
      timeoutMs: 1_500
    });
    if (configuredHealth.available) {
      return { command: configuredCommand, prefixArgs: [] };
    }
  }
  const candidates: Array<{ command: string; prefixArgs: string[] }> = [
    { command: "agent", prefixArgs: [] },
    { command: "cursor", prefixArgs: ["agent"] },
    { command: join("/Applications", "Cursor.app", "Contents", "Resources", "app", "bin", "cursor"), prefixArgs: ["agent"] },
    {
      command: join(homedir(), "Applications", "Cursor.app", "Contents", "Resources", "app", "bin", "cursor"),
      prefixArgs: ["agent"]
    }
  ];
  for (const candidate of candidates) {
    const health = await checkRuntimeCommandHealth(candidate.command, {
      cwd: runtime?.cwd?.trim() || process.cwd(),
      timeoutMs: 1_500
    });
    if (health.available) {
      return candidate;
    }
  }
  return { command: "agent", prefixArgs: [] };
}

function toEnvironmentStatus(checks: AdapterEnvironmentCheck[]): "pass" | "warn" | "fail" {
  if (checks.some((check) => check.level === "error")) return "fail";
  if (checks.some((check) => check.level === "warn")) return "warn";
  return "pass";
}

function createPrompt(context: HeartbeatContext) {
  const bootstrapPrompt = context.runtime?.bootstrapPrompt?.trim();
  const companyGoals = context.goalContext?.companyGoals.length
    ? context.goalContext.companyGoals.map((goal) => `- ${goal}`).join("\n")
    : "- No active company goals";
  const projectGoals = context.goalContext?.projectGoals.length
    ? context.goalContext.projectGoals.map((goal) => `- ${goal}`).join("\n")
    : "- No active project goals";
  const agentGoals = context.goalContext?.agentGoals.length
    ? context.goalContext.agentGoals.map((goal) => `- ${goal}`).join("\n")
    : "- No active agent goals";
  const workItems = context.workItems.length
    ? context.workItems
        .map((item) =>
          [
            `- [${item.issueId}] ${item.title}`,
            `  Project: ${item.projectName ?? item.projectId}`,
            item.status ? `  Status: ${item.status}` : null,
            item.priority ? `  Priority: ${item.priority}` : null,
            item.body ? `  Body: ${item.body}` : null,
            item.labels?.length ? `  Labels: ${item.labels.join(", ")}` : null,
            item.tags?.length ? `  Tags: ${item.tags.join(", ")}` : null,
            item.attachments?.length
              ? [
                  "  Attachments:",
                  ...item.attachments.map((attachment) =>
                    `    - ${attachment.fileName} | path: ${attachment.absolutePath} | relative: ${attachment.relativePath}`
                  )
                ].join("\n")
              : null
          ]
            .filter(Boolean)
            .join("\n")
        )
        .join("\n")
    : "- No assigned work";
  const memoryContext = context.memoryContext;
  const memoryTacitNotes = memoryContext?.tacitNotes?.trim()
    ? memoryContext.tacitNotes.trim()
    : "No tacit notes were recorded yet.";
  const memoryDurableFacts =
    memoryContext?.durableFacts && memoryContext.durableFacts.length > 0
      ? memoryContext.durableFacts.map((fact) => `- ${fact}`).join("\n")
      : "- No durable facts available.";
  const memoryDailyNotes =
    memoryContext?.dailyNotes && memoryContext.dailyNotes.length > 0
      ? memoryContext.dailyNotes.map((note) => `- ${note}`).join("\n")
      : "- No recent daily notes.";

  const executionDirectives = [
    "Execution directives:",
    "- You are running inside a BopoDev heartbeat for local repository work.",
    "- Use BopoDev-specific injected skills only (bopodev-control-plane, bopodev-create-agent, para-memory-files) when relevant.",
    "- Ignore unrelated third-party control-plane skills even if they exist in the runtime environment.",
    "- Prefer completing assigned issue work in this repository over non-essential coordination tasks.",
    "- Keep command usage minimal and task-focused; avoid broad repository scans unless strictly required for the assigned issue.",
    "- Shell commands run under zsh on macOS; avoid Bash-only features such as `local -n`, `declare -n`, `mapfile`, and `readarray`.",
    "- Prefer POSIX/zsh-compatible shell snippets, direct `curl` headers, and `jq`.",
    "- Prefer heredoc/stdin payloads (for example `curl --data-binary @- <<'JSON' ... JSON`) so cleanup is not blocked by runtime policy.",
    "- If payload files are required, write under `agents/<agent-id>/tmp/` (or OS temp via `mktemp`) and do not treat cleanup command failures as task blockers.",
    "- If control-plane API connectivity fails, report the exact failing command/error once and stop retry loops for the same endpoint.",
    "- If any command fails, avoid further exploratory commands and still return the required final JSON summary.",
    "- Do not stop after planning. You must execute concrete steps for assigned issues in this run (file edits, API calls, or other verifiable actions).",
    "- If you cannot complete concrete execution, set summary to include the blocker explicitly instead of claiming success.",
    "- Treat file memory as source of truth for long-term context: append raw observations to daily notes first, then promote stable patterns to durable facts.",
    "- Avoid writing duplicate durable facts when existing memory already contains the same lesson.",
    "- Your final output must be only the JSON object below, with no prose before or after it.",
    "- Do not invent token or cost values; the runtime records usage separately."
  ].join("\n");

  return `${bootstrapPrompt ? `${bootstrapPrompt}\n\n` : ""}You are ${context.agent.name} (${context.agent.role}), agent ${context.agentId}.
Heartbeat run ${context.heartbeatRunId}.

Company:
- Name: ${context.company.name}
- Mission: ${context.company.mission ?? "No mission set"}

Goal context:
Company goals:
${companyGoals}
Project goals:
${projectGoals}
Agent goals:
${agentGoals}

Assigned issues:
${workItems}

Memory context:
- Memory root: ${memoryContext?.memoryRoot ?? "Unavailable"}
- Tacit notes:
${memoryTacitNotes}
- Durable facts:
${memoryDurableFacts}
- Recent daily notes:
${memoryDailyNotes}

${executionDirectives}

At the end of your response, output exactly one JSON object on a single line and nothing else:
{"summary":"brief outcome and any blocker"}
`;
}

function withProviderMetadata(
  context: HeartbeatContext,
  provider: string,
  lastRuntimeMs?: number,
  lastExitCode?: number | null
) {
  return {
    ...context.state,
    metadata: {
      ...(context.state.metadata ?? {}),
      lastProvider: provider,
      lastHeartbeatRunId: context.heartbeatRunId,
      ...(lastRuntimeMs === undefined ? {} : { lastRuntimeMs }),
      ...(lastExitCode === undefined ? {} : { lastExitCode })
    }
  };
}

function applyProviderSessionState(
  context: HeartbeatContext,
  provider: AgentProviderType,
  sessionUpdate?: ProviderSessionUpdate,
  lastRuntimeMs?: number,
  lastExitCode?: number | null
) {
  const nextState = withProviderMetadata(context, provider, lastRuntimeMs, lastExitCode) as HeartbeatContext["state"] &
    Record<string, unknown>;
  if (provider === "cursor") {
    delete nextState.sessionId;
    delete nextState.cwd;
    delete nextState.cursorSession;
    const nextSessionId = sessionUpdate?.currentSessionId?.trim();
    const nextCwd = sessionUpdate?.cwd?.trim() || context.runtime?.cwd?.trim() || undefined;
    if (nextSessionId) {
      nextState.sessionId = nextSessionId;
      nextState.cwd = nextCwd;
      nextState.cursorSession = {
        sessionId: nextSessionId,
        ...(nextCwd ? { cwd: nextCwd } : {})
      };
    }
    return nextState;
  }
  if (provider === "opencode") {
    if (sessionUpdate?.currentSessionId?.trim()) {
      nextState.sessionId = sessionUpdate.currentSessionId.trim();
    }
    return nextState;
  }
  return nextState;
}

function toPreview(value: string, max = 1600) {
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, max)}\n...[truncated]`;
}

function buildMissingStructuredOutputDetail(
  provider: string,
  runtime: {
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
      claudeContract?: {
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
    };
  }
) {
  const hints: string[] = [];
  const claudeContract = runtime.structuredOutputDiagnostics?.claudeContract;
  if (provider === "claude_code" && claudeContract) {
    if (claudeContract.commandWasProviderAlias) {
      hints.push("runtimeCommand used provider alias 'claude_code' and was normalized to 'claude'");
    }
    if (claudeContract.commandOverride && !claudeContract.commandLooksClaude) {
      hints.push("runtimeCommand override does not look like Claude CLI");
    }
    if (claudeContract.missingRequiredArgs.length > 0) {
      hints.push(`missing Claude structured-output args: ${claudeContract.missingRequiredArgs.join(", ")}`);
    }
  }
  if (runtime.structuredOutputSource === "stderr") {
    hints.push("structured JSON was detected on stderr");
  }
  const stdoutJsonObjectCount = runtime.structuredOutputDiagnostics?.stdoutJsonObjectCount ?? 0;
  const stderrJsonObjectCount = runtime.structuredOutputDiagnostics?.stderrJsonObjectCount ?? 0;
  const stdoutBytes = runtime.structuredOutputDiagnostics?.stdoutBytes ?? 0;
  const stderrBytes = runtime.structuredOutputDiagnostics?.stderrBytes ?? 0;
  const likelyCause = runtime.structuredOutputDiagnostics?.likelyCause ?? "json_missing";
  const hasAnyOutput = runtime.structuredOutputDiagnostics?.hasAnyOutput ?? false;
  const lastStdoutLine = runtime.structuredOutputDiagnostics?.lastStdoutLine;
  const lastStderrLine = runtime.structuredOutputDiagnostics?.lastStderrLine;
  const base =
    provider === "claude_code"
      ? "runtime completed without structured heartbeat output. Expected Claude stream-json events with a final result payload."
      : provider === "cursor"
        ? "runtime completed without structured heartbeat output. Expected Cursor stream-json events with assistant/result payloads."
      : "runtime completed without structured heartbeat JSON output. Ensure final output includes a single-line JSON object with summary/tokenInput/tokenOutput/usdCost.";
  const diagnostics = [
    `likelyCause=${likelyCause}`,
    `hasAnyOutput=${hasAnyOutput}`,
    `stdoutBytes=${stdoutBytes}`,
    `stderrBytes=${stderrBytes}`,
    `stdoutJsonObjects=${stdoutJsonObjectCount}`,
    `stderrJsonObjects=${stderrJsonObjectCount}`
  ];
  if (lastStdoutLine) {
    diagnostics.push(`lastStdoutLine=${JSON.stringify(lastStdoutLine).slice(0, 180)}`);
  }
  if (lastStderrLine) {
    diagnostics.push(`lastStderrLine=${JSON.stringify(lastStderrLine).slice(0, 180)}`);
  }
  return hints.length > 0 ? `${base} Diagnostics: ${[...hints, ...diagnostics].join("; ")}.` : `${base} Diagnostics: ${diagnostics.join("; ")}.`;
}

function isClaudeRunIncomplete(runtime: {
  structuredOutputDiagnostics?: {
    claudeStopReason?: string;
    claudeResultSubtype?: string;
  };
}) {
  const stopReason = runtime.structuredOutputDiagnostics?.claudeStopReason;
  const subtype = runtime.structuredOutputDiagnostics?.claudeResultSubtype;
  return stopReason === "max_turns" || subtype === "error_max_turns";
}
