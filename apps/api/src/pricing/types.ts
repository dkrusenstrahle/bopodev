export type CanonicalPricingProvider = "openai_api" | "anthropic_api" | "gemini_api" | "opencode";

export interface ModelPricingCatalogRow {
  modelId: string;
  displayName: string;
  inputUsdPer1M: number;
  outputUsdPer1M: number;
}
