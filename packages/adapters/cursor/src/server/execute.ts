import type { HeartbeatContext, AdapterExecutionResult } from "../../../../agent-sdk/src/types";
import {
  createPrompt,
  createSkippedResult,
  hasTrustFlag,
  readRuntimeSessionId,
  resolveCursorLaunchConfig,
  resolveCursorResumeState,
  toProviderResult
} from "../../../../agent-sdk/src/adapters";
import { containsRateLimitFailure, executePromptRuntime } from "../../../../agent-sdk/src/runtime-core";
import { resolveCursorRuntimeUsage } from "./parse";

export async function execute(context: HeartbeatContext): Promise<AdapterExecutionResult> {
  if (context.workItems.length === 0) {
    return createSkippedResult("Cursor", "cursor", context);
  }
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
  const resolvedRuntime = applyUsageResolution(runtime);
  const initialSessionId = readRuntimeSessionId(
    resolvedRuntime,
    resumeState.resumeAttempted ? context.state.cursorSession?.sessionId ?? context.state.sessionId ?? null : null
  );
  if (
    !resolvedRuntime.ok &&
    resumeState.resumeSessionId &&
    !isRateLimitedRuntimeFailure(resolvedRuntime) &&
    isUnknownSessionError(resolvedRuntime.stderr, resolvedRuntime.stdout)
  ) {
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
    const retryResolved = applyUsageResolution(retry);
    return toProviderResult(
      context,
      "cursor",
      prompt,
      retryResolved,
      {
        inputRate: 0.0000015,
        outputRate: 0.000008
      },
      {
        currentSessionId: readRuntimeSessionId(retryResolved, null),
        resumedSessionId: resumeState.resumeSessionId,
        resumeAttempted: true,
        clearedStaleSession: !readRuntimeSessionId(retryResolved, null),
        cwd
      },
      {
        pricingProviderType: "openai_api",
        pricingModelId: context.runtime?.model?.trim() || null
      }
    );
  }
  return toProviderResult(
    context,
    "cursor",
    prompt,
    resolvedRuntime,
    {
      inputRate: 0.0000015,
      outputRate: 0.000008
    },
    {
      currentSessionId: initialSessionId,
      resumedSessionId: resumeState.resumeSessionId,
      resumeAttempted: resumeState.resumeAttempted,
      resumeSkippedReason: resumeState.resumeSkippedReason,
      clearedStaleSession: resumeState.resumeSkippedReason === "cwd_mismatch" && !initialSessionId,
      cwd
    },
    {
      pricingProviderType: "openai_api",
      pricingModelId: context.runtime?.model?.trim() || null
    }
  );
}

function applyUsageResolution(runtime: Awaited<ReturnType<typeof executePromptRuntime>>) {
  const resolvedUsage = resolveCursorRuntimeUsage({
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

function isRateLimitedRuntimeFailure(runtime: { stdout: string; stderr: string }) {
  return containsRateLimitFailure(`${runtime.stderr}\n${runtime.stdout}`);
}

function isUnknownSessionError(stderr: string, stdout: string) {
  const haystack = `${stderr}\n${stdout}`.toLowerCase();
  return haystack.includes("unknown session") || haystack.includes("session not found") || haystack.includes("could not resume");
}
