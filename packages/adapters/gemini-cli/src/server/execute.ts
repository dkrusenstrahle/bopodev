import type { HeartbeatContext, AdapterExecutionResult } from "../../../../agent-sdk/src/types";
import { createPrompt, createSkippedResult, parseGeminiOutput, toProviderResult } from "../../../../agent-sdk/src/adapters";
import { containsRateLimitFailure, executePromptRuntime } from "../../../../agent-sdk/src/runtime-core";
import { resolve } from "node:path";
import { resolveGeminiRuntimeUsage } from "./parse";

export async function execute(context: HeartbeatContext): Promise<AdapterExecutionResult> {
  if (context.workItems.length === 0) {
    return createSkippedResult("Gemini CLI", "gemini_cli", context);
  }
  const prompt = createPrompt(context);
  const cwd = context.runtime?.cwd?.trim() || process.cwd();
  const command = context.runtime?.command?.trim() || "gemini";
  const model = context.runtime?.model?.trim() || "";
  const pricingIdentity = {
    pricingProviderType: "gemini_api" as const,
    pricingModelId: model || null
  };
  const resumeState = resolveGeminiResumeState(context.state, cwd, model || null);
  const runtimeTimeoutMs =
    context.runtime?.timeoutMs && context.runtime.timeoutMs > 0 ? context.runtime.timeoutMs : 15 * 60 * 1000;

  const buildArgs = (resumeSessionId: string | null) => {
    const base = ["--output-format", "stream-json", "--approval-mode", "yolo", "--sandbox=none"];
    if (resumeSessionId) {
      base.push("--resume", resumeSessionId);
    }
    if (model) {
      base.push("--model", model);
    }
    base.push(...(context.runtime?.args ?? []));
    base.push(prompt);
    return base;
  };

  const runtime = await executePromptRuntime(
    command,
    prompt,
    {
      ...context.runtime,
      timeoutMs: runtimeTimeoutMs,
      retryCount: 0,
      args: buildArgs(resumeState.resumeSessionId)
    },
    { provider: "gemini_cli" }
  );
  const resolvedRuntime = applyUsageResolution(runtime);
  const parsed = parseGeminiOutput(resolvedRuntime.stdout);

  if (
    !resolvedRuntime.ok &&
    resumeState.resumeSessionId &&
    !isRateLimitedRuntimeFailure(resolvedRuntime) &&
    isGeminiUnknownSessionError(resolvedRuntime.stdout, resolvedRuntime.stderr)
  ) {
    const retry = await executePromptRuntime(
      command,
      prompt,
      {
        ...context.runtime,
        timeoutMs: runtimeTimeoutMs,
        retryCount: 0,
        args: buildArgs(null)
      },
      { provider: "gemini_cli" }
    );
    const resolvedRetry = applyUsageResolution(retry);
    const retryParsed = parseGeminiOutput(resolvedRetry.stdout);
    return toProviderResult(
      context,
      "gemini_cli",
      prompt,
      resolvedRetry,
      {
        inputRate: 0.0000015,
        outputRate: 0.000008
      },
      {
        currentSessionId: retryParsed.sessionId ?? null,
        resumedSessionId: resumeState.resumeSessionId,
        resumeAttempted: true,
        clearedStaleSession: true,
        cwd
      },
      pricingIdentity
    );
  }

  return toProviderResult(
    context,
    "gemini_cli",
    prompt,
    resolvedRuntime,
    {
      inputRate: 0.0000015,
      outputRate: 0.000008
    },
    {
      currentSessionId: parsed.sessionId ?? null,
      resumedSessionId: resumeState.resumeSessionId,
      resumeAttempted: resumeState.resumeAttempted,
      resumeSkippedReason: resumeState.resumeSkippedReason,
      cwd
    },
    pricingIdentity
  );
}

function applyUsageResolution(runtime: Awaited<ReturnType<typeof executePromptRuntime>>) {
  const resolvedUsage = resolveGeminiRuntimeUsage({
    stdout: runtime.stdout,
    stderr: runtime.stderr,
    parsedUsage: runtime.parsedUsage,
    structuredOutputSource: runtime.structuredOutputSource
  });
  return {
    ...runtime,
    parsedUsage: resolvedUsage.parsedUsage ?? runtime.parsedUsage,
    structuredOutputSource: resolvedUsage.structuredOutputSource ?? runtime.structuredOutputSource
  };
}

function resolveGeminiResumeState(state: HeartbeatContext["state"], cwd: string, model: string | null) {
  const savedSessionId = state.sessionId?.trim() || null;
  const savedCwd = state.cwd?.trim() || null;
  const savedModel =
    (typeof (state as { runtime?: { model?: unknown } }).runtime?.model === "string"
      ? ((state as { runtime?: { model?: string } }).runtime?.model ?? "").trim()
      : "") || null;
  const normalizedModel = model?.trim() || null;
  if (!savedSessionId) {
    return { resumeSessionId: null, resumeAttempted: false, resumeSkippedReason: null as string | null };
  }
  if (savedCwd && resolve(savedCwd) !== resolve(cwd)) {
    return { resumeSessionId: null, resumeAttempted: false, resumeSkippedReason: "cwd_mismatch" as const };
  }
  if (savedModel && normalizedModel && savedModel !== normalizedModel) {
    return { resumeSessionId: null, resumeAttempted: false, resumeSkippedReason: "model_mismatch" as const };
  }
  return { resumeSessionId: savedSessionId, resumeAttempted: true, resumeSkippedReason: null as string | null };
}

function isGeminiUnknownSessionError(stdout: string, stderr: string): boolean {
  const haystack = `${stdout}\n${stderr}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n")
    .toLowerCase();
  return (
    /unknown\s+session|session\s+.*\s+not\s+found|resume\s+.*\s+not\s+found|checkpoint\s+.*\s+not\s+found|cannot\s+resume|failed\s+to\s+resume/i.test(
      haystack
    )
  );
}

function isRateLimitedRuntimeFailure(runtime: { stdout: string; stderr: string }) {
  return containsRateLimitFailure(`${runtime.stderr}\n${runtime.stdout}`);
}
