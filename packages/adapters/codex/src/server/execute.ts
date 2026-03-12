import type { HeartbeatContext, AdapterExecutionResult } from "../../../../agent-sdk/src/types";
import { createPrompt, createSkippedResult, toProviderResult } from "../../../../agent-sdk/src/adapters";
import { executeAgentRuntime } from "../../../../agent-sdk/src/runtime-core";
import { resolveCodexRuntimeUsage } from "./parse";

export async function execute(context: HeartbeatContext): Promise<AdapterExecutionResult> {
  if (context.workItems.length === 0) {
    return createSkippedResult("Codex", "codex", context);
  }
  const prompt = createPrompt(context);
  const runtime = await executeAgentRuntime("codex", prompt, context.runtime);
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
