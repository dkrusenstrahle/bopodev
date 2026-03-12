import type { HeartbeatContext, AdapterExecutionResult } from "../../../../agent-sdk/src/types";
import { createPrompt, createSkippedResult, withProviderMetadata } from "../../../../agent-sdk/src/adapters";
import { containsRateLimitFailure } from "../../../../agent-sdk/src/runtime-core";
import { executeDirectApiRuntime } from "../../../../agent-sdk/src/runtime-http";
import { ExecutionOutcomeSchema, type ExecutionOutcome } from "../../../../contracts/src/index";

export async function execute(context: HeartbeatContext): Promise<AdapterExecutionResult> {
  if (context.workItems.length === 0) {
    return createSkippedResult("Anthropic API", "anthropic_api", context);
  }
  const prompt = createPrompt(context);
  const runtime = await executeDirectApiRuntime("anthropic_api", prompt, context.runtime);
  if (runtime.ok) {
    return {
      status: "ok",
      summary: runtime.summary ?? `anthropic_api runtime finished in ${runtime.elapsedMs}ms.`,
      tokenInput: runtime.tokenInput ?? 0,
      tokenOutput: runtime.tokenOutput ?? 0,
      usdCost: runtime.usdCost ?? 0,
      pricingProviderType: runtime.provider,
      pricingModelId: runtime.model,
      outcome: toOutcome({
        kind: "completed",
        issueIdsTouched: issueIdsTouched(context),
        actions: [{ type: "runtime.execute", status: "ok", detail: "anthropic_api runtime completed." }],
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
      nextState: withProviderMetadata(context, "anthropic_api", runtime.elapsedMs, runtime.statusCode)
    };
  }
  const failureDetail = runtime.error ?? "direct API request failed";
  const rateLimitedFailure =
    runtime.failureType === "rate_limit" || containsRateLimitFailure(`${failureDetail}\n${runtime.responsePreview ?? ""}`);
  return {
    status: "failed",
    summary: `anthropic_api runtime failed: ${failureDetail}`,
    tokenInput: 0,
    tokenOutput: 0,
    usdCost: 0,
    pricingProviderType: "anthropic_api",
    pricingModelId: context.runtime?.model?.trim() || null,
    outcome: toOutcome({
      kind: "failed",
      issueIdsTouched: issueIdsTouched(context),
      actions: [{ type: "runtime.execute", status: "error", detail: failureDetail }],
      blockers: [
        {
          code: runtime.failureType ?? "runtime_failed",
          message: failureDetail,
          retryable: runtime.failureType !== "auth" && runtime.failureType !== "bad_response" && !rateLimitedFailure
        }
      ],
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

function issueIdsTouched(context: HeartbeatContext) {
  return context.workItems.map((item) => item.issueId);
}

function toOutcome(outcome: ExecutionOutcome): ExecutionOutcome {
  return ExecutionOutcomeSchema.parse(outcome);
}
