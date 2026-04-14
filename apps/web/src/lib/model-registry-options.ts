type CanonicalPricingProvider = "openai_api" | "anthropic_api" | "opencode" | "gemini_api";

export type RuntimeProviderType =
  | "claude_code"
  | "codex"
  | "cursor"
  | "opencode"
  | "gemini_cli"
  | "hermes_local"
  | "openai_api"
  | "anthropic_api"
  | "openclaw_gateway"
  | "http"
  | "shell";

export type ModelRegistryRow = {
  providerType: string;
  modelId: string;
  displayName?: string | null;
};

export type ModelOption = {
  value: string;
  label: string;
};

/** Server-reported model entry from `POST /agents/adapter-models/:providerType`. */
export type ServerAdapterModelEntry = {
  id: string;
  label: string;
};

const MODEL_LABEL_OVERRIDES: Record<string, string> = {
  "opencode/big-pickle": "Big Pickle"
};

export function resolveCanonicalPricingProviderForRuntime(
  providerType: RuntimeProviderType
): CanonicalPricingProvider | null {
  if (providerType === "codex" || providerType === "cursor" || providerType === "openai_api") {
    return "openai_api";
  }
  if (providerType === "claude_code" || providerType === "anthropic_api") {
    return "anthropic_api";
  }
  if (providerType === "opencode") {
    return "opencode";
  }
  if (providerType === "gemini_cli") {
    return "gemini_api";
  }
  return null;
}

/** Default model id to prefill when provider requires a named model. */
export function getDefaultModelForProvider(providerType: RuntimeProviderType): string | null {
  switch (providerType) {
    case "claude_code":
      return "claude-sonnet-4-6";
    case "codex":
      return "gpt-5.3-codex";
    case "opencode":
      return "opencode/big-pickle";
    case "gemini_cli":
      return "gemini-2.5-pro";
    case "hermes_local":
      return "auto";
    default:
      return null;
  }
}

/** Allowed model ids per runtime provider (catalog order). Used to filter registry options. */
export const ALLOWED_MODEL_IDS_BY_PROVIDER: Partial<Record<RuntimeProviderType, string[]>> = {
  claude_code: [
    "claude-sonnet-4-6",
    "claude-sonnet-4-6-1m",
    "claude-opus-4-6",
    "claude-opus-4-6-1m",
    "claude-haiku-4-5"
  ],
  codex: [
    "gpt-5.3-codex",
    "gpt-5.4",
    "gpt-5.2-codex",
    "gpt-5.2",
    "gpt-5.1-codex-max",
    "gpt-5.1-codex-mini"
  ],
  opencode: ["opencode/big-pickle"],
  gemini_cli: [
    "gemini-2.5-pro",
    "gemini-2.5-flash",
    "gemini-2.5-flash-lite",
    "gemini-3.1-flash-lite",
    "gemini-3-flash",
    "gemini-3-pro",
    "gemini-3-pro-200k"
  ],
  hermes_local: ["auto"]
};

export function getAllowedModelIdsForProvider(providerType: RuntimeProviderType): string[] {
  return ALLOWED_MODEL_IDS_BY_PROVIDER[providerType] ?? [];
}

function normalizeModelIdForRuntimeProvider(providerType: RuntimeProviderType, modelId: string): string {
  const normalized = modelId.trim();
  if (providerType === "opencode" && normalized === "big-pickle") {
    return "opencode/big-pickle";
  }
  return normalized;
}

export function getRegistryModelValuesForRuntimeProvider(
  rows: ModelRegistryRow[],
  providerType: RuntimeProviderType
) {
  const canonical = resolveCanonicalPricingProviderForRuntime(providerType);
  if (!canonical) {
    return [];
  }
  const discovered = rows
    .filter((row) => row.providerType === canonical)
    .map((row) => normalizeModelIdForRuntimeProvider(providerType, row.modelId))
    .filter((value) => value.length > 0);
  if (discovered.length > 0) {
    return Array.from(new Set(discovered));
  }
  const allowed = getAllowedModelIdsForProvider(providerType);
  if (allowed.length > 0) {
    return [...allowed];
  }
  return [];
}

/**
 * When `serverModels` is set (including an empty array), IDs come only from the API — no client allowlist.
 * When `serverModels` is undefined, falls back to registry rows / `ALLOWED_MODEL_IDS_BY_PROVIDER`.
 */
export function getModelPickerAllowedIds(input: {
  rows: ModelRegistryRow[];
  providerType: RuntimeProviderType;
  serverModels: ServerAdapterModelEntry[] | undefined;
}): string[] {
  if (input.serverModels !== undefined) {
    const ids = input.serverModels
      .map((m) => normalizeModelIdForRuntimeProvider(input.providerType, m.id))
      .filter((id) => id.length > 0);
    return Array.from(new Set(ids)).sort((a, b) => a.localeCompare(b, "en", { numeric: true, sensitivity: "base" }));
  }
  return getRegistryModelValuesForRuntimeProvider(input.rows, input.providerType);
}

/**
 * Builds select options: uses `serverModels` when defined (even if empty); otherwise offline catalog via `buildRegistryModelOptions`.
 */
export function buildModelPickerOptions(input: {
  rows: ModelRegistryRow[];
  providerType: RuntimeProviderType;
  serverModels: ServerAdapterModelEntry[] | undefined;
  currentModel?: string | null;
  includeDefault?: boolean;
}): ModelOption[] {
  if (input.serverModels === undefined) {
    return buildRegistryModelOptions({
      rows: input.rows,
      providerType: input.providerType,
      currentModel: input.currentModel,
      includeDefault: input.includeDefault
    });
  }
  const includeDefault = input.includeDefault ?? false;
  const options: ModelOption[] = [];
  if (includeDefault) {
    options.push({ value: "", label: "Default" });
  }
  const labelById = new Map<string, string>();
  for (const m of input.serverModels) {
    const id = normalizeModelIdForRuntimeProvider(input.providerType, m.id);
    if (!id) {
      continue;
    }
    const label = m.label?.trim() || id;
    labelById.set(id, label);
  }
  const sortedIds = Array.from(labelById.keys()).sort((a, b) =>
    a.localeCompare(b, "en", { numeric: true, sensitivity: "base" })
  );
  for (const id of sortedIds) {
    options.push({
      value: id,
      label: MODEL_LABEL_OVERRIDES[id] ?? labelById.get(id) ?? id
    });
  }
  const currentModel = input.currentModel
    ? normalizeModelIdForRuntimeProvider(input.providerType, input.currentModel)
    : undefined;
  if (currentModel && !options.some((entry) => entry.value === currentModel)) {
    options.push({ value: currentModel, label: `${currentModel} (current)` });
  }
  return options;
}

export function buildRegistryModelOptions(input: {
  rows: ModelRegistryRow[];
  providerType: RuntimeProviderType;
  currentModel?: string | null;
  includeDefault?: boolean;
}) {
  const values = getRegistryModelValuesForRuntimeProvider(input.rows, input.providerType);
  const options: ModelOption[] = [];
  if (input.includeDefault) {
    options.push({ value: "", label: "Default" });
  }
  const labelByModelId = new Map<string, string>();
  const canonical = resolveCanonicalPricingProviderForRuntime(input.providerType);
  if (canonical) {
    for (const row of input.rows) {
      if (row.providerType !== canonical) {
        continue;
      }
      const modelId = normalizeModelIdForRuntimeProvider(input.providerType, row.modelId);
      if (!modelId) {
        continue;
      }
      labelByModelId.set(modelId, row.displayName?.trim() || modelId);
    }
  }
  for (const modelId of Array.from(new Set(values)).sort()) {
    options.push({
      value: modelId,
      label: labelByModelId.get(modelId) ?? MODEL_LABEL_OVERRIDES[modelId] ?? modelId
    });
  }
  const currentModel = input.currentModel
    ? normalizeModelIdForRuntimeProvider(input.providerType, input.currentModel)
    : undefined;
  if (currentModel && !options.some((entry) => entry.value === currentModel)) {
    options.push({ value: currentModel, label: `${currentModel} (current)` });
  }
  const allowedIds = getAllowedModelIdsForProvider(input.providerType);
  if (allowedIds.length > 0) {
    const allowedSet = new Set(allowedIds);
    const defaultId = getDefaultModelForProvider(input.providerType);
    const ordered: ModelOption[] = [];
    if (defaultId && allowedSet.has(defaultId)) {
      const def = options.find((o) => o.value === defaultId);
      if (def) ordered.push(def);
    }
    for (const id of allowedIds) {
      if (id !== defaultId) {
        const opt = options.find((o) => o.value === id);
        if (opt) ordered.push(opt);
      }
    }
    const currentOpt = currentModel ? options.find((o) => o.value === currentModel) : null;
    const filtered = currentOpt && !allowedSet.has(currentModel!) ? [...ordered, currentOpt] : ordered;
    const defaultOpt = input.includeDefault ? options.find((o) => o.value === "") : null;
    return defaultOpt ? [defaultOpt, ...filtered] : filtered;
  }
  return options;
}
