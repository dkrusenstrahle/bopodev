import type { BopoDb } from "bopodev-db";
import { getModelPricing, upsertModelPricing } from "bopodev-db";

type SeedModelPricingRow = {
  providerType: "openai_api" | "anthropic_api" | "gemini_api";
  modelId: string;
  displayName: string;
  inputUsdPer1M: number;
  outputUsdPer1M: number;
};

const OPENAI_MODEL_BASE_PRICES: Array<{
  modelId: string;
  displayName: string;
  inputUsdPer1M: number;
  outputUsdPer1M: number;
}> = [
  { modelId: "gpt-5.2", displayName: "GPT-5.2", inputUsdPer1M: 1.75, outputUsdPer1M: 14 },
  { modelId: "gpt-5.1", displayName: "GPT-5.1", inputUsdPer1M: 1.25, outputUsdPer1M: 10 },
  { modelId: "gpt-5", displayName: "GPT-5", inputUsdPer1M: 1.25, outputUsdPer1M: 10 },
  { modelId: "gpt-5-mini", displayName: "GPT-5 Mini", inputUsdPer1M: 0.25, outputUsdPer1M: 2 },
  { modelId: "gpt-5-nano", displayName: "GPT-5 Nano", inputUsdPer1M: 0.05, outputUsdPer1M: 0.4 },
  { modelId: "gpt-5.3-chat-latest", displayName: "GPT-5.3 Chat Latest", inputUsdPer1M: 1.75, outputUsdPer1M: 14 },
  { modelId: "gpt-5.2-chat-latest", displayName: "GPT-5.2 Chat Latest", inputUsdPer1M: 1.75, outputUsdPer1M: 14 },
  { modelId: "gpt-5.1-chat-latest", displayName: "GPT-5.1 Chat Latest", inputUsdPer1M: 1.25, outputUsdPer1M: 10 },
  { modelId: "gpt-5-chat-latest", displayName: "GPT-5 Chat Latest", inputUsdPer1M: 1.25, outputUsdPer1M: 10 },
  { modelId: "gpt-5.4", displayName: "GPT-5.4", inputUsdPer1M: 1.75, outputUsdPer1M: 14 },
  { modelId: "gpt-5.3-codex", displayName: "GPT-5.3 Codex", inputUsdPer1M: 1.75, outputUsdPer1M: 14 },
  { modelId: "gpt-5.3-codex-spark", displayName: "GPT-5.3 Codex Spark", inputUsdPer1M: 1.75, outputUsdPer1M: 14 },
  { modelId: "gpt-5.2-codex", displayName: "GPT-5.2 Codex", inputUsdPer1M: 1.75, outputUsdPer1M: 14 },
  { modelId: "gpt-5.1-codex-max", displayName: "GPT-5.1 Codex Max", inputUsdPer1M: 1.25, outputUsdPer1M: 10 },
  { modelId: "gpt-5.1-codex-mini", displayName: "GPT-5.1 Codex Mini", inputUsdPer1M: 0.25, outputUsdPer1M: 2 },
  { modelId: "gpt-5.1-codex", displayName: "GPT-5.1 Codex", inputUsdPer1M: 1.25, outputUsdPer1M: 10 },
  { modelId: "gpt-5-codex", displayName: "GPT-5 Codex", inputUsdPer1M: 1.25, outputUsdPer1M: 10 },
  { modelId: "gpt-5.2-pro", displayName: "GPT-5.2 Pro", inputUsdPer1M: 21, outputUsdPer1M: 168 },
  { modelId: "gpt-5-pro", displayName: "GPT-5 Pro", inputUsdPer1M: 15, outputUsdPer1M: 120 },
  { modelId: "gpt-4.1", displayName: "GPT-4.1", inputUsdPer1M: 2, outputUsdPer1M: 8 },
  { modelId: "gpt-4.1-mini", displayName: "GPT-4.1 Mini", inputUsdPer1M: 0.4, outputUsdPer1M: 1.6 },
  { modelId: "gpt-4.1-nano", displayName: "GPT-4.1 Nano", inputUsdPer1M: 0.1, outputUsdPer1M: 0.4 },
  { modelId: "gpt-4o", displayName: "GPT-4o", inputUsdPer1M: 2.5, outputUsdPer1M: 10 },
  { modelId: "gpt-4o-2024-05-13", displayName: "GPT-4o 2024-05-13", inputUsdPer1M: 5, outputUsdPer1M: 15 },
  { modelId: "gpt-4o-mini", displayName: "GPT-4o Mini", inputUsdPer1M: 0.15, outputUsdPer1M: 0.6 },
  { modelId: "gpt-realtime", displayName: "GPT Realtime", inputUsdPer1M: 4, outputUsdPer1M: 16 },
  { modelId: "gpt-realtime-1.5", displayName: "GPT Realtime 1.5", inputUsdPer1M: 4, outputUsdPer1M: 16 },
  { modelId: "gpt-realtime-mini", displayName: "GPT Realtime Mini", inputUsdPer1M: 0.6, outputUsdPer1M: 2.4 },
  { modelId: "gpt-4o-realtime-preview", displayName: "GPT-4o Realtime Preview", inputUsdPer1M: 5, outputUsdPer1M: 20 },
  { modelId: "gpt-4o-mini-realtime-preview", displayName: "GPT-4o Mini Realtime Preview", inputUsdPer1M: 0.6, outputUsdPer1M: 2.4 },
  { modelId: "gpt-audio", displayName: "GPT Audio", inputUsdPer1M: 2.5, outputUsdPer1M: 10 },
  { modelId: "gpt-audio-1.5", displayName: "GPT Audio 1.5", inputUsdPer1M: 2.5, outputUsdPer1M: 10 },
  { modelId: "gpt-audio-mini", displayName: "GPT Audio Mini", inputUsdPer1M: 0.6, outputUsdPer1M: 2.4 },
  { modelId: "gpt-4o-audio-preview", displayName: "GPT-4o Audio Preview", inputUsdPer1M: 2.5, outputUsdPer1M: 10 },
  { modelId: "gpt-4o-mini-audio-preview", displayName: "GPT-4o Mini Audio Preview", inputUsdPer1M: 0.15, outputUsdPer1M: 0.6 },
  { modelId: "o1", displayName: "o1", inputUsdPer1M: 15, outputUsdPer1M: 60 },
  { modelId: "o1-pro", displayName: "o1-pro", inputUsdPer1M: 150, outputUsdPer1M: 600 },
  { modelId: "o3-pro", displayName: "o3-pro", inputUsdPer1M: 20, outputUsdPer1M: 80 },
  { modelId: "o3", displayName: "o3", inputUsdPer1M: 2, outputUsdPer1M: 8 },
  { modelId: "o3-deep-research", displayName: "o3 Deep Research", inputUsdPer1M: 10, outputUsdPer1M: 40 },
  { modelId: "o4-mini", displayName: "o4-mini", inputUsdPer1M: 1.1, outputUsdPer1M: 4.4 },
  { modelId: "o4-mini-deep-research", displayName: "o4-mini Deep Research", inputUsdPer1M: 2, outputUsdPer1M: 8 },
  { modelId: "o3-mini", displayName: "o3-mini", inputUsdPer1M: 1.1, outputUsdPer1M: 4.4 }
];

const CLAUDE_MODEL_BASE_PRICES: Array<{
  modelId: string;
  displayName: string;
  inputUsdPer1M: number;
  outputUsdPer1M: number;
}> = [
  // Runtime ids currently used in provider model selectors.
  { modelId: "claude-opus-4-6", displayName: "Claude Opus 4.6", inputUsdPer1M: 5, outputUsdPer1M: 25 },
  { modelId: "claude-sonnet-4-6", displayName: "Claude Sonnet 4.6", inputUsdPer1M: 3, outputUsdPer1M: 15 },
  { modelId: "claude-sonnet-4-6-1m", displayName: "Claude Sonnet 4.6 (1M context)", inputUsdPer1M: 6, outputUsdPer1M: 22.5 },
  { modelId: "claude-opus-4-6-1m", displayName: "Claude Opus 4.6 (1M context)", inputUsdPer1M: 10, outputUsdPer1M: 37.5 },
  { modelId: "claude-haiku-4-5", displayName: "Claude Haiku 4.5", inputUsdPer1M: 1, outputUsdPer1M: 5 },
  // Legacy / alternate ids
  { modelId: "claude-sonnet-4-5-20250929", displayName: "Claude Sonnet 4.5", inputUsdPer1M: 3, outputUsdPer1M: 15 },
  { modelId: "claude-haiku-4-5-20251001", displayName: "Claude Haiku 4.5", inputUsdPer1M: 1, outputUsdPer1M: 5 },
  { modelId: "claude-opus-4.6", displayName: "Claude Opus 4.6", inputUsdPer1M: 5, outputUsdPer1M: 25 },
  { modelId: "claude-opus-4.5", displayName: "Claude Opus 4.5", inputUsdPer1M: 5, outputUsdPer1M: 25 },
  { modelId: "claude-opus-4.1", displayName: "Claude Opus 4.1", inputUsdPer1M: 15, outputUsdPer1M: 75 },
  { modelId: "claude-opus-4", displayName: "Claude Opus 4", inputUsdPer1M: 15, outputUsdPer1M: 75 },
  { modelId: "claude-sonnet-4.6", displayName: "Claude Sonnet 4.6", inputUsdPer1M: 3, outputUsdPer1M: 15 },
  { modelId: "claude-sonnet-4.5", displayName: "Claude Sonnet 4.5", inputUsdPer1M: 3, outputUsdPer1M: 15 },
  { modelId: "claude-sonnet-4", displayName: "Claude Sonnet 4", inputUsdPer1M: 3, outputUsdPer1M: 15 },
  { modelId: "claude-sonnet-3.7", displayName: "Claude Sonnet 3.7", inputUsdPer1M: 3, outputUsdPer1M: 15 },
  { modelId: "claude-haiku-4.5", displayName: "Claude Haiku 4.5", inputUsdPer1M: 1, outputUsdPer1M: 5 },
  { modelId: "claude-haiku-3.5", displayName: "Claude Haiku 3.5", inputUsdPer1M: 0.8, outputUsdPer1M: 4 },
  { modelId: "claude-opus-3", displayName: "Claude Opus 3", inputUsdPer1M: 15, outputUsdPer1M: 75 },
  { modelId: "claude-haiku-3", displayName: "Claude Haiku 3", inputUsdPer1M: 0.25, outputUsdPer1M: 1.25 }
];

const GEMINI_MODEL_BASE_PRICES: Array<{
  modelId: string;
  displayName: string;
  inputUsdPer1M: number;
  outputUsdPer1M: number;
}> = [
  { modelId: "gemini-3.1-flash-lite", displayName: "Gemini 3.1 Flash Lite", inputUsdPer1M: 0.25, outputUsdPer1M: 1.5 },
  { modelId: "gemini-3-flash", displayName: "Gemini 3 Flash", inputUsdPer1M: 0.5, outputUsdPer1M: 3 },
  { modelId: "gemini-3-pro", displayName: "Gemini 3 Pro", inputUsdPer1M: 2, outputUsdPer1M: 12 },
  { modelId: "gemini-3-pro-200k", displayName: "Gemini 3 Pro (>200k context)", inputUsdPer1M: 4, outputUsdPer1M: 18 },
  { modelId: "gemini-2.5-flash-lite", displayName: "Gemini 2.5 Flash Lite", inputUsdPer1M: 0.1, outputUsdPer1M: 0.4 },
  { modelId: "gemini-2.5-flash", displayName: "Gemini 2.5 Flash", inputUsdPer1M: 0.3, outputUsdPer1M: 2.5 },
  { modelId: "gemini-2.5-pro", displayName: "Gemini 2.5 Pro", inputUsdPer1M: 1.25, outputUsdPer1M: 10 }
];

const DEFAULT_MODEL_PRICING_ROWS: SeedModelPricingRow[] = [
  ...OPENAI_MODEL_BASE_PRICES.map((row) => ({ ...row, providerType: "openai_api" as const })),
  ...CLAUDE_MODEL_BASE_PRICES.map((row) => ({ ...row, providerType: "anthropic_api" as const })),
  ...GEMINI_MODEL_BASE_PRICES.map((row) => ({ ...row, providerType: "gemini_api" as const }))
];

export async function ensureCompanyModelPricingDefaults(db: BopoDb, companyId: string) {
  for (const row of DEFAULT_MODEL_PRICING_ROWS) {
    await upsertModelPricing(db, {
      companyId,
      providerType: row.providerType,
      modelId: row.modelId,
      displayName: row.displayName,
      inputUsdPer1M: row.inputUsdPer1M.toFixed(6),
      outputUsdPer1M: row.outputUsdPer1M.toFixed(6),
      currency: "USD",
      updatedBy: "system:onboarding-defaults"
    });
  }
}

export async function calculateModelPricedUsdCost(input: {
  db: BopoDb;
  companyId: string;
  providerType: string;
  pricingProviderType?: string | null;
  modelId: string | null;
  tokenInput: number;
  tokenOutput: number;
}) {
  const normalizedProviderType = (input.pricingProviderType ?? input.providerType).trim();
  const normalizedModelId = input.modelId?.trim() ?? "";
  const canonicalPricingProviderType = resolveCanonicalPricingProvider(normalizedProviderType);
  if (!normalizedModelId || !canonicalPricingProviderType) {
    return {
      usdCost: 0,
      pricingSource: "missing" as const,
      pricingProviderType: canonicalPricingProviderType,
      pricingModelId: normalizedModelId || null
    };
  }
  const pricing = await getModelPricing(input.db, {
    companyId: input.companyId,
    providerType: canonicalPricingProviderType,
    modelId: normalizedModelId
  });
  if (!pricing) {
    return {
      usdCost: 0,
      pricingSource: "missing" as const,
      pricingProviderType: canonicalPricingProviderType,
      pricingModelId: normalizedModelId
    };
  }
  const inputUsdPer1M = Number(pricing.inputUsdPer1M ?? 0);
  const outputUsdPer1M = Number(pricing.outputUsdPer1M ?? 0);
  if (!Number.isFinite(inputUsdPer1M) || !Number.isFinite(outputUsdPer1M)) {
    return {
      usdCost: 0,
      pricingSource: "missing" as const,
      pricingProviderType: canonicalPricingProviderType,
      pricingModelId: normalizedModelId
    };
  }
  const normalizedTokenInput = Math.max(0, input.tokenInput);
  const normalizedTokenOutput = Math.max(0, input.tokenOutput);
  if (normalizedTokenInput === 0 && normalizedTokenOutput === 0) {
    return {
      usdCost: 0,
      pricingSource: "missing" as const,
      pricingProviderType: canonicalPricingProviderType,
      pricingModelId: normalizedModelId
    };
  }
  const computedUsd =
    (normalizedTokenInput / 1_000_000) * inputUsdPer1M +
    (normalizedTokenOutput / 1_000_000) * outputUsdPer1M;
  return {
    usdCost: Number.isFinite(computedUsd) ? computedUsd : 0,
    pricingSource: Number.isFinite(computedUsd) ? ("exact" as const) : ("missing" as const),
    pricingProviderType: canonicalPricingProviderType,
    pricingModelId: normalizedModelId
  };
}

export function resolveCanonicalPricingProvider(providerType: string | null | undefined) {
  const normalizedProvider = providerType?.trim() ?? "";
  if (!normalizedProvider) {
    return null;
  }
  if (
    normalizedProvider === "openai_api" ||
    normalizedProvider === "anthropic_api" ||
    normalizedProvider === "opencode" ||
    normalizedProvider === "gemini_api"
  ) {
    return normalizedProvider;
  }
  if (normalizedProvider === "codex" || normalizedProvider === "cursor") {
    return "openai_api";
  }
  if (normalizedProvider === "claude_code") {
    return "anthropic_api";
  }
  if (normalizedProvider === "gemini_cli") {
    return "gemini_api";
  }
  return null;
}


