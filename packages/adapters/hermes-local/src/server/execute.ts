import type { HeartbeatContext, AdapterExecutionResult } from "../../../../agent-sdk/src/types";
import { createPrompt, createSkippedResult, toProviderResult } from "../../../../agent-sdk/src/adapters";
import { executePromptRuntime } from "../../../../agent-sdk/src/runtime-core";
import { resolveHermesRuntimeUsage, resolveHermesSessionId } from "./parse";

export async function execute(context: HeartbeatContext): Promise<AdapterExecutionResult> {
  if (context.workItems.length === 0) {
    return createSkippedResult("Hermes", "hermes_local", context);
  }
  const prompt = createPrompt(context);
  const command = context.runtime?.command?.trim() || "hermes";
  const runtime = await executePromptRuntime(command, prompt, {
    ...context.runtime,
    args: [...(context.runtime?.args ?? [])]
  });
  const resolvedRuntime = applyUsageResolution(runtime);
  const currentSessionId = resolveHermesSessionId(resolvedRuntime.stdout, resolvedRuntime.stderr);
  return toProviderResult(
    context,
    "hermes_local",
    prompt,
    resolvedRuntime,
    {
      inputRate: 0.0000015,
      outputRate: 0.000008
    },
    {
      currentSessionId
    },
    {
      pricingProviderType: null,
      pricingModelId: context.runtime?.model?.trim() || null
    }
  );
}

function applyUsageResolution(runtime: Awaited<ReturnType<typeof executePromptRuntime>>) {
  const resolvedUsage = resolveHermesRuntimeUsage({
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
