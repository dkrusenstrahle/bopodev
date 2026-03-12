import type { AgentRuntimeConfig } from "./types";

export type DirectApiProvider = "openai_api" | "anthropic_api";

export type DirectApiExecutionOutput = {
  ok: boolean;
  provider: DirectApiProvider;
  model: string;
  endpoint: string;
  elapsedMs: number;
  statusCode: number;
  summary?: string;
  tokenInput?: number;
  tokenOutput?: number;
  usdCost?: number;
  failureType?: "auth" | "rate_limit" | "timeout" | "network" | "bad_response" | "http_error";
  error?: string;
  responsePreview?: string;
  attemptCount: number;
  attempts: Array<{
    attempt: number;
    statusCode: number;
    elapsedMs: number;
    failureType?: "auth" | "rate_limit" | "timeout" | "network" | "bad_response" | "http_error";
    error?: string;
  }>;
};

type ProbeResult = {
  ok: boolean;
  statusCode: number;
  elapsedMs: number;
  message: string;
};

const OPENAI_BASE_URL = "https://api.openai.com";
const ANTHROPIC_BASE_URL = "https://api.anthropic.com";
const OPENAI_DEFAULT_MODEL = "gpt-5";
const ANTHROPIC_DEFAULT_MODEL = "claude-sonnet-4-5-20250929";

export function resolveDirectApiCredentials(provider: DirectApiProvider, runtime?: AgentRuntimeConfig) {
  if (provider === "openai_api") {
    const key =
      runtime?.env?.OPENAI_API_KEY?.trim() ||
      runtime?.env?.BOPO_OPENAI_API_KEY?.trim() ||
      process.env.OPENAI_API_KEY?.trim() ||
      process.env.BOPO_OPENAI_API_KEY?.trim() ||
      "";
    const baseUrl =
      runtime?.env?.BOPO_OPENAI_BASE_URL?.trim() || process.env.BOPO_OPENAI_BASE_URL?.trim() || OPENAI_BASE_URL;
    return { key, baseUrl };
  }
  const key =
    runtime?.env?.ANTHROPIC_API_KEY?.trim() ||
    runtime?.env?.BOPO_ANTHROPIC_API_KEY?.trim() ||
    process.env.ANTHROPIC_API_KEY?.trim() ||
    process.env.BOPO_ANTHROPIC_API_KEY?.trim() ||
    "";
  const baseUrl =
    runtime?.env?.BOPO_ANTHROPIC_BASE_URL?.trim() || process.env.BOPO_ANTHROPIC_BASE_URL?.trim() || ANTHROPIC_BASE_URL;
  return { key, baseUrl };
}

export async function executeDirectApiRuntime(
  provider: DirectApiProvider,
  prompt: string,
  runtime?: AgentRuntimeConfig
): Promise<DirectApiExecutionOutput> {
  const startedAt = Date.now();
  const { key, baseUrl } = resolveDirectApiCredentials(provider, runtime);
  const timeoutMs = runtime?.timeoutMs && runtime.timeoutMs > 0 ? runtime.timeoutMs : 120_000;
  const retryCount = Math.max(0, Math.min(2, runtime?.retryCount ?? 1));
  const retryBackoffMs = Math.max(100, runtime?.retryBackoffMs ?? 400);
  const model = runtime?.model?.trim() || (provider === "openai_api" ? OPENAI_DEFAULT_MODEL : ANTHROPIC_DEFAULT_MODEL);
  const attempts: DirectApiExecutionOutput["attempts"] = [];

  if (!key) {
    return {
      ok: false,
      provider,
      model,
      endpoint: baseUrl,
      elapsedMs: Date.now() - startedAt,
      statusCode: 0,
      failureType: "auth",
      error: `Missing API key for ${provider}.`,
      attemptCount: 0,
      attempts
    };
  }

  const endpoint = provider === "openai_api" ? `${stripTrailingSlash(baseUrl)}/v1/responses` : `${stripTrailingSlash(baseUrl)}/v1/messages`;
  const payload =
    provider === "openai_api"
      ? {
          model,
          input: prompt
        }
      : {
          model,
          max_tokens: 4096,
          messages: [{ role: "user", content: prompt }]
        };
  const headers: Record<string, string> =
    provider === "openai_api"
      ? {
          "content-type": "application/json",
          authorization: `Bearer ${key}`
        }
      : {
          "content-type": "application/json",
          "x-api-key": key,
          "anthropic-version": "2023-06-01"
        };

  const maxAttempts = 1 + retryCount;
  let lastFailure: Omit<DirectApiExecutionOutput, "ok" | "provider" | "model" | "endpoint" | "attemptCount" | "attempts"> | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const attemptStartedAt = Date.now();
    try {
      const response = await fetchWithTimeout(
        endpoint,
        {
          method: "POST",
          headers,
          body: JSON.stringify(payload)
        },
        timeoutMs
      );
      const elapsedMs = Date.now() - startedAt;
      const attemptElapsedMs = Date.now() - attemptStartedAt;
      const text = await response.text();
      const preview = toPreview(text);
      const parsed = tryParseJson(text);
      if (!response.ok) {
        const failureType = classifyHttpFailure(response.status);
        const error = extractErrorMessage(provider, parsed, text) || `HTTP ${response.status}`;
        attempts.push({
          attempt,
          statusCode: response.status,
          elapsedMs: attemptElapsedMs,
          failureType,
          error
        });
        lastFailure = {
          elapsedMs,
          statusCode: response.status,
          failureType,
          error,
          responsePreview: preview
        };
        if (!isRetryableFailure(failureType, response.status) || attempt >= maxAttempts) {
          break;
        }
        await sleep(retryBackoffMs * attempt);
        continue;
      }
      if (!parsed || typeof parsed !== "object") {
        const failureType = "bad_response" as const;
        const error = "Provider returned non-JSON response.";
        attempts.push({
          attempt,
          statusCode: response.status,
          elapsedMs: attemptElapsedMs,
          failureType,
          error
        });
        lastFailure = {
          elapsedMs,
          statusCode: response.status,
          failureType,
          error,
          responsePreview: preview
        };
        break;
      }
      const summary = provider === "openai_api" ? extractOpenAiSummary(parsed) : extractAnthropicSummary(parsed);
      const usage = provider === "openai_api" ? extractOpenAiUsage(parsed) : extractAnthropicUsage(parsed);
      attempts.push({
        attempt,
        statusCode: response.status,
        elapsedMs: attemptElapsedMs
      });
      return {
        ok: true,
        provider,
        model,
        endpoint,
        elapsedMs,
        statusCode: response.status,
        summary,
        tokenInput: usage.tokenInput,
        tokenOutput: usage.tokenOutput,
        usdCost: usage.usdCost ?? 0,
        responsePreview: preview,
        attemptCount: attempts.length,
        attempts
      };
    } catch (error) {
      const elapsedMs = Date.now() - startedAt;
      const attemptElapsedMs = Date.now() - attemptStartedAt;
      const failureType = isAbortTimeoutError(error) ? "timeout" : "network";
      const message =
        failureType === "timeout" ? `Request timed out after ${timeoutMs}ms.` : `Network failure: ${String(error)}`;
      attempts.push({
        attempt,
        statusCode: 0,
        elapsedMs: attemptElapsedMs,
        failureType,
        error: message
      });
      lastFailure = {
        elapsedMs,
        statusCode: 0,
        failureType,
        error: message
      };
      if (!isRetryableFailure(failureType, 0) || attempt >= maxAttempts) {
        break;
      }
      await sleep(retryBackoffMs * attempt);
    }
  }
  return {
    ok: false,
    provider,
    model,
    endpoint,
    elapsedMs: lastFailure?.elapsedMs ?? Date.now() - startedAt,
    statusCode: lastFailure?.statusCode ?? 0,
    failureType: lastFailure?.failureType ?? "network",
    error: lastFailure?.error ?? "Direct API request failed.",
    responsePreview: lastFailure?.responsePreview,
    attemptCount: attempts.length,
    attempts
  };
}

export async function probeDirectApiEnvironment(
  provider: DirectApiProvider,
  runtime?: AgentRuntimeConfig
): Promise<ProbeResult> {
  const startedAt = Date.now();
  const { key, baseUrl } = resolveDirectApiCredentials(provider, runtime);
  if (!key) {
    return {
      ok: false,
      statusCode: 0,
      elapsedMs: Date.now() - startedAt,
      message: "API key missing."
    };
  }
  const endpoint = provider === "openai_api" ? `${stripTrailingSlash(baseUrl)}/v1/models` : `${stripTrailingSlash(baseUrl)}/v1/models`;
  const headers: Record<string, string> =
    provider === "openai_api"
      ? { authorization: `Bearer ${key}` }
      : { "x-api-key": key, "anthropic-version": "2023-06-01" };
  try {
    const response = await fetchWithTimeout(endpoint, { method: "GET", headers }, 5_000);
    const elapsedMs = Date.now() - startedAt;
    return {
      ok: response.ok,
      statusCode: response.status,
      elapsedMs,
      message: response.ok ? "API probe succeeded." : `API probe returned HTTP ${response.status}.`
    };
  } catch (error) {
    const elapsedMs = Date.now() - startedAt;
    if (isAbortTimeoutError(error)) {
      return {
        ok: false,
        statusCode: 0,
        elapsedMs,
        message: "API probe timed out."
      };
    }
    return {
      ok: false,
      statusCode: 0,
      elapsedMs,
      message: `API probe failed: ${String(error)}`
    };
  }
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function extractOpenAiSummary(parsed: Record<string, unknown>) {
  const outputText = parsed.output_text;
  if (typeof outputText === "string" && outputText.trim()) return outputText.trim();
  const output = parsed.output;
  if (Array.isArray(output)) {
    for (const item of output) {
      if (!item || typeof item !== "object") continue;
      const content = (item as Record<string, unknown>).content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (!block || typeof block !== "object") continue;
        const blockText = (block as Record<string, unknown>).text;
        if (typeof blockText === "string" && blockText.trim()) return blockText.trim();
      }
    }
  }
  return "OpenAI API request completed.";
}

function extractAnthropicSummary(parsed: Record<string, unknown>) {
  const content = parsed.content;
  if (!Array.isArray(content)) return "Anthropic API request completed.";
  const texts: string[] = [];
  for (const entry of content) {
    if (!entry || typeof entry !== "object") continue;
    const block = entry as Record<string, unknown>;
    if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
      texts.push(block.text.trim());
    }
  }
  return texts.join("\n\n").trim() || "Anthropic API request completed.";
}

function extractOpenAiUsage(parsed: Record<string, unknown>) {
  const usage = parsed.usage;
  if (!usage || typeof usage !== "object") return { tokenInput: 0, tokenOutput: 0, usdCost: 0 };
  const record = usage as Record<string, unknown>;
  const tokenInput = toNumber(record.input_tokens) ?? toNumber(record.prompt_tokens) ?? 0;
  const tokenOutput = toNumber(record.output_tokens) ?? toNumber(record.completion_tokens) ?? 0;
  const usdCost = toNumber(record.cost_usd) ?? toNumber(record.total_cost_usd) ?? 0;
  return { tokenInput, tokenOutput, usdCost };
}

function extractAnthropicUsage(parsed: Record<string, unknown>) {
  const usage = parsed.usage;
  if (!usage || typeof usage !== "object") return { tokenInput: 0, tokenOutput: 0, usdCost: 0 };
  const record = usage as Record<string, unknown>;
  const tokenInput = (toNumber(record.input_tokens) ?? 0) + (toNumber(record.cache_read_input_tokens) ?? 0);
  const tokenOutput = toNumber(record.output_tokens) ?? 0;
  const usdCost = toNumber(record.cost_usd) ?? toNumber(record.total_cost_usd) ?? 0;
  return { tokenInput, tokenOutput, usdCost };
}

function extractErrorMessage(provider: DirectApiProvider, parsed: Record<string, unknown> | null, fallback: string) {
  const fallbackMessage = toPreview(fallback, 320);
  if (!parsed) return fallbackMessage;
  const error = parsed.error;
  if (typeof error === "string" && error.trim()) return error.trim();
  if (error && typeof error === "object") {
    const errorRecord = error as Record<string, unknown>;
    const candidates = [
      errorRecord.message,
      errorRecord.error?.toString(),
      (errorRecord.details as string | undefined) ?? undefined
    ];
    for (const candidate of candidates) {
      if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
    }
  }
  if (provider === "openai_api" && typeof parsed.message === "string" && parsed.message.trim()) {
    return parsed.message.trim();
  }
  return fallbackMessage;
}

function classifyHttpFailure(statusCode: number): "auth" | "rate_limit" | "http_error" {
  if (statusCode === 401 || statusCode === 403) return "auth";
  if (statusCode === 429) return "rate_limit";
  return "http_error";
}

function isRetryableFailure(
  failureType: NonNullable<DirectApiExecutionOutput["failureType"]>,
  statusCode: number
) {
  if (failureType === "timeout" || failureType === "network" || failureType === "rate_limit") {
    return true;
  }
  if (failureType === "http_error" && statusCode >= 500) {
    return true;
  }
  return false;
}

function stripTrailingSlash(value: string) {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function tryParseJson(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // ignore
  }
  return null;
}

function isAbortTimeoutError(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const maybeError = error as { name?: string };
  return maybeError.name === "AbortError";
}

function toPreview(value: string, max = 1600) {
  const normalized = value.trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max)}\n...[truncated]`;
}

function toNumber(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}
