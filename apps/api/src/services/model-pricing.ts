import type { BopoDb } from "bopodev-db";
import type { CanonicalPricingProvider } from "../pricing";
import { getModelPricingCatalogRow } from "../pricing";

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
  const pricing = getModelPricingCatalogRow({
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

export function resolveCanonicalPricingProvider(providerType: string | null | undefined): CanonicalPricingProvider | null {
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


