import type { ModelPricingCatalogRow } from "./types";

export const ANTHROPIC_MODEL_PRICING: ModelPricingCatalogRow[] = [
  { modelId: "claude-opus-4-6", displayName: "Claude Opus 4.6", inputUsdPer1M: 5, outputUsdPer1M: 25 },
  { modelId: "claude-sonnet-4-6", displayName: "Claude Sonnet 4.6", inputUsdPer1M: 3, outputUsdPer1M: 15 },
  { modelId: "claude-sonnet-4-6-1m", displayName: "Claude Sonnet 4.6 (1M context)", inputUsdPer1M: 6, outputUsdPer1M: 22.5 },
  { modelId: "claude-opus-4-6-1m", displayName: "Claude Opus 4.6 (1M context)", inputUsdPer1M: 10, outputUsdPer1M: 37.5 },
  { modelId: "claude-haiku-4-5", displayName: "Claude Haiku 4.5", inputUsdPer1M: 1, outputUsdPer1M: 5 },
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
