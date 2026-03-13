import type { HeartbeatContext, AdapterExecutionResult } from "../../../../agent-sdk/src/types";
import { createPrompt, createSkippedResult, isUnknownSessionError, toProviderResult } from "../../../../agent-sdk/src/adapters";
import { containsRateLimitFailure, executeAgentRuntime } from "../../../../agent-sdk/src/runtime-core";
import { resolveCodexRuntimeUsage } from "./parse";

export async function execute(context: HeartbeatContext): Promise<AdapterExecutionResult> {
  if (context.workItems.length === 0) {
    return createSkippedResult("Codex", "codex", context);
  }
  const prompt = createPrompt(context);
  const hasResumeArgs = hasCodexResumeArgs(context.runtime?.args ?? []);
  let runtime = await executeAgentRuntime(
    "codex",
    prompt,
    hasResumeArgs ? { ...context.runtime, retryCount: 0 } : context.runtime
  );
  if (
    hasResumeArgs &&
    !runtime.ok &&
    !isRateLimitedRuntimeFailure(runtime) &&
    isUnknownSessionError(runtime.stderr, runtime.stdout)
  ) {
    runtime = await executeAgentRuntime("codex", prompt, {
      ...context.runtime,
      retryCount: 0,
      args: stripCodexResumeArgs(context.runtime?.args ?? [])
    });
  }
  const resolvedRuntime = applyUsageResolution(runtime);
  return toProviderResult(
    context,
    "codex",
    prompt,
    resolvedRuntime,
    {
      inputRate: 0.0000015,
      outputRate: 0.000008
    },
    undefined,
    {
      pricingProviderType: "openai_api",
      pricingModelId: context.runtime?.model?.trim() || null
    }
  );
}

function applyUsageResolution(runtime: Awaited<ReturnType<typeof executeAgentRuntime>>) {
  const resolvedUsage = resolveCodexRuntimeUsage({
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

function hasCodexResumeArgs(args: string[]) {
  for (let index = 0; index < args.length; index += 1) {
    const current = (args[index] ?? "").trim().toLowerCase();
    if (current === "--resume" || current.startsWith("--resume=") || current === "resume") {
      return true;
    }
  }
  return false;
}

function stripCodexResumeArgs(args: string[]) {
  const next: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const current = (args[index] ?? "").trim();
    const lowered = current.toLowerCase();
    if (lowered === "--resume") {
      index += 1;
      continue;
    }
    if (lowered.startsWith("--resume=")) {
      continue;
    }
    if (lowered === "resume") {
      index += 1;
      continue;
    }
    next.push(args[index] ?? "");
  }
  return next;
}
