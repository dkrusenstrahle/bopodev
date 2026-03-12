import type { HeartbeatContext, AdapterExecutionResult } from "../../../../agent-sdk/src/types";
import {
  createPrompt,
  createSkippedResult,
  ensureOpenCodeModelConfiguredAndAvailable,
  isUnknownSessionError,
  parseOpenCodeOutput,
  toProviderResult
} from "../../../../agent-sdk/src/adapters";
import { containsRateLimitFailure, executePromptRuntime } from "../../../../agent-sdk/src/runtime-core";
import { ExecutionOutcomeSchema, type ExecutionOutcome } from "../../../../contracts/src/index";

export async function execute(context: HeartbeatContext): Promise<AdapterExecutionResult> {
  if (context.workItems.length === 0) {
    return createSkippedResult("OpenCode", "opencode", context);
  }
  const prompt = createPrompt(context);
  const model = context.runtime?.model?.trim();
  const pricingIdentity = resolveOpenCodePricingIdentity(model);
  const runtimeTimeoutMs =
    context.runtime?.timeoutMs && context.runtime.timeoutMs > 0 ? context.runtime.timeoutMs : 5 * 60 * 1000;
  if (!model) {
    return {
      status: "failed",
      summary: "opencode runtime requires runtimeModel in provider/model format.",
      tokenInput: 0,
      tokenOutput: 0,
      usdCost: 0,
      pricingProviderType: pricingIdentity.pricingProviderType,
      pricingModelId: pricingIdentity.pricingModelId,
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
      pricingProviderType: pricingIdentity.pricingProviderType,
      pricingModelId: pricingIdentity.pricingModelId,
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
  if (!runtime.ok && resumeSessionId && !isRateLimitedRuntimeFailure(runtime) && isUnknownSessionError(runtime.stderr, runtime.stdout)) {
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
    return toProviderResult(
      context,
      "opencode",
      prompt,
      retry,
      {
        inputRate: 0.0000015,
        outputRate: 0.000008
      },
      undefined,
      pricingIdentity
    );
  }
  return toProviderResult(
    context,
    "opencode",
    prompt,
    runtime,
    {
      inputRate: 0.0000015,
      outputRate: 0.000008
    },
    {
      currentSessionId: parsed.sessionId ?? null
    },
    pricingIdentity
  );
}

function isRateLimitedRuntimeFailure(runtime: { stdout: string; stderr: string }) {
  return containsRateLimitFailure(`${runtime.stderr}\n${runtime.stdout}`);
}

function resolveOpenCodePricingIdentity(model: string | null | undefined) {
  const normalizedModel = model?.trim() || null;
  if (!normalizedModel) {
    return {
      pricingProviderType: "opencode" as const,
      pricingModelId: null
    };
  }
  const slashIndex = normalizedModel.indexOf("/");
  if (slashIndex <= 0 || slashIndex >= normalizedModel.length - 1) {
    return {
      pricingProviderType: "opencode" as const,
      pricingModelId: normalizedModel
    };
  }
  const upstreamProvider = normalizedModel.slice(0, slashIndex).toLowerCase();
  const upstreamModelId = normalizedModel.slice(slashIndex + 1).trim();
  if (upstreamProvider === "openai" || upstreamProvider === "openai_api") {
    return {
      pricingProviderType: "openai_api" as const,
      pricingModelId: upstreamModelId || normalizedModel
    };
  }
  if (upstreamProvider === "anthropic" || upstreamProvider === "anthropic_api") {
    return {
      pricingProviderType: "anthropic_api" as const,
      pricingModelId: upstreamModelId || normalizedModel
    };
  }
  return {
    pricingProviderType: "opencode" as const,
    pricingModelId: normalizedModel
  };
}

function issueIdsTouched(context: HeartbeatContext) {
  return context.workItems.map((item) => item.issueId);
}

function toOutcome(outcome: ExecutionOutcome): ExecutionOutcome {
  return ExecutionOutcomeSchema.parse(outcome);
}
