import type { CanonicalPricingProvider, ModelPricingCatalogRow } from "./types";
import { OPENAI_MODEL_PRICING } from "./openai";
import { ANTHROPIC_MODEL_PRICING } from "./anthropic";
import { GEMINI_MODEL_PRICING } from "./gemini";
import { OPENCODE_MODEL_PRICING } from "./opencode";

const CATALOG_BY_PROVIDER: Record<CanonicalPricingProvider, ReadonlyMap<string, ModelPricingCatalogRow>> = {
  openai_api: buildProviderCatalog(OPENAI_MODEL_PRICING),
  anthropic_api: buildProviderCatalog(ANTHROPIC_MODEL_PRICING),
  gemini_api: buildProviderCatalog(GEMINI_MODEL_PRICING),
  opencode: buildProviderCatalog(OPENCODE_MODEL_PRICING)
};

export function getModelPricingCatalogRow(input: {
  providerType: CanonicalPricingProvider;
  modelId: string;
}) {
  return CATALOG_BY_PROVIDER[input.providerType].get(input.modelId.trim()) ?? null;
}

function buildProviderCatalog(rows: ModelPricingCatalogRow[]) {
  const normalizedRows = rows.map((row) => ({
    ...row,
    modelId: row.modelId.trim()
  }));
  return new Map(normalizedRows.map((row) => [row.modelId, row]));
}

export * from "./types";
