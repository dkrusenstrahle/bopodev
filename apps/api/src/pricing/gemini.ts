import type { ModelPricingCatalogRow } from "./types";

export const GEMINI_MODEL_PRICING: ModelPricingCatalogRow[] = [
  { modelId: "gemini-3.1-flash-lite", displayName: "Gemini 3.1 Flash Lite", inputUsdPer1M: 0.25, outputUsdPer1M: 1.5 },
  { modelId: "gemini-3-flash", displayName: "Gemini 3 Flash", inputUsdPer1M: 0.5, outputUsdPer1M: 3 },
  { modelId: "gemini-3-pro", displayName: "Gemini 3 Pro", inputUsdPer1M: 2, outputUsdPer1M: 12 },
  { modelId: "gemini-3-pro-200k", displayName: "Gemini 3 Pro (>200k context)", inputUsdPer1M: 4, outputUsdPer1M: 18 },
  { modelId: "gemini-2.5-flash-lite", displayName: "Gemini 2.5 Flash Lite", inputUsdPer1M: 0.1, outputUsdPer1M: 0.4 },
  { modelId: "gemini-2.5-flash", displayName: "Gemini 2.5 Flash", inputUsdPer1M: 0.3, outputUsdPer1M: 2.5 },
  { modelId: "gemini-2.5-pro", displayName: "Gemini 2.5 Pro", inputUsdPer1M: 1.25, outputUsdPer1M: 10 }
];
