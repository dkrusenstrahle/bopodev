import type { HeartbeatContext, AdapterExecutionResult } from "../../../../agent-sdk/src/types";
import { createPrompt, createSkippedResult, isClaudeRunIncomplete, toProviderResult } from "../../../../agent-sdk/src/adapters";
import { executeAgentRuntime } from "../../../../agent-sdk/src/runtime-core";
import { resolveClaudeRuntimeUsage } from "./parse";

export async function execute(context: HeartbeatContext): Promise<AdapterExecutionResult> {
  if (context.workItems.length === 0) {
    return createSkippedResult("Claude Code", "claude_code", context);
  }
  const prompt = createPrompt(context);
  const runtime = await executeAgentRuntime("claude_code", prompt, context.runtime);
  const resolvedRuntime = applyUsageResolution(runtime);
  if (resolvedRuntime.ok && isClaudeRunIncomplete(resolvedRuntime)) {
    const detail = "Claude run reached max-turns before completing execution for this issue.";
    return {
      status: "failed",
      summary: resolvedRuntime.parsedUsage?.summary ?? detail,
      tokenInput: resolvedRuntime.parsedUsage?.tokenInput ?? 0,
      tokenOutput: resolvedRuntime.parsedUsage?.tokenOutput ?? 0,
      usdCost: resolvedRuntime.parsedUsage?.usdCost ?? 0,
      pricingProviderType: "anthropic_api",
      pricingModelId: context.runtime?.model?.trim() || null,
      trace: {
        command: resolvedRuntime.commandUsed ?? context.runtime?.command ?? "claude",
        args: resolvedRuntime.argsUsed,
        cwd: context.runtime?.cwd,
        exitCode: resolvedRuntime.code,
        elapsedMs: resolvedRuntime.elapsedMs,
        timedOut: resolvedRuntime.timedOut,
        failureType: "max_turns_reached",
        timeoutSource: resolvedRuntime.timedOut ? "runtime" : null,
        usageSource: "structured",
        attemptCount: resolvedRuntime.attemptCount,
        attempts: resolvedRuntime.attempts,
        structuredOutputSource: resolvedRuntime.structuredOutputSource,
        structuredOutputDiagnostics: resolvedRuntime.structuredOutputDiagnostics,
        transcript: resolvedRuntime.transcript
      },
      nextState: context.state
    };
  }
  return toProviderResult(context, "claude_code", prompt, resolvedRuntime, {
    inputRate: 0.000002,
    outputRate: 0.00001
  }, undefined, {
    pricingProviderType: "anthropic_api",
    pricingModelId: context.runtime?.model?.trim() || null
  });
}

function applyUsageResolution(runtime: Awaited<ReturnType<typeof executeAgentRuntime>>) {
  const resolvedUsage = resolveClaudeRuntimeUsage({
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
