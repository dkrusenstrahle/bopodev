import type { PluginManifestV2 } from "bopodev-contracts";

export type BopoPluginContext = {
  companyId: string;
  pluginId: string;
  capabilities: string[];
};

export type PluginInvocationStatus = "ok" | "skipped" | "failed" | "blocked";
export type PluginInvocationResult = {
  status: PluginInvocationStatus;
  summary?: string;
  diagnostics?: Record<string, unknown>;
};

export type PluginSetupContext = BopoPluginContext & {
  actions: {
    register: (key: string, handler: (payload: Record<string, unknown>) => Promise<unknown> | unknown) => void;
  };
  data: {
    register: (key: string, handler: (payload: Record<string, unknown>) => Promise<unknown> | unknown) => void;
  };
  jobs: {
    register: (jobKey: string, handler: (payload: Record<string, unknown>) => Promise<PluginInvocationResult> | PluginInvocationResult) => void;
  };
  hooks: {
    register: (hook: string, handler: (payload: Record<string, unknown>) => Promise<PluginInvocationResult> | PluginInvocationResult) => void;
  };
  webhooks: {
    register: (endpointKey: string, handler: (payload: Record<string, unknown>) => Promise<unknown> | unknown) => void;
  };
};

export type BopoPluginDefinition = {
  manifest: PluginManifestV2;
  setup?: (ctx: PluginSetupContext) => Promise<void> | void;
  onHealth?: () => Promise<{ status: "ok" | "degraded" | "error"; message?: string }> | { status: "ok" | "degraded" | "error"; message?: string };
};

export function definePlugin(definition: BopoPluginDefinition) {
  return definition;
}

export async function runWorker(definition: BopoPluginDefinition, context: BopoPluginContext) {
  const registry = createWorkerRegistry();
  const setupContext: PluginSetupContext = {
    ...context,
    actions: {
      register: (key, handler) => registry.actions.set(key, handler)
    },
    data: {
      register: (key, handler) => registry.data.set(key, handler)
    },
    jobs: {
      register: (jobKey, handler) => registry.jobs.set(jobKey, handler)
    },
    hooks: {
      register: (hook, handler) => registry.hooks.set(hook, handler)
    },
    webhooks: {
      register: (endpointKey, handler) => registry.webhooks.set(endpointKey, handler)
    }
  };
  if (definition.setup) {
    await definition.setup(setupContext);
  }
  return {
    definition,
    registry
  };
}

export function createWorkerRegistry() {
  return {
    actions: new Map<string, (payload: Record<string, unknown>) => Promise<unknown> | unknown>(),
    data: new Map<string, (payload: Record<string, unknown>) => Promise<unknown> | unknown>(),
    jobs: new Map<
      string,
      (payload: Record<string, unknown>) => Promise<PluginInvocationResult> | PluginInvocationResult
    >(),
    hooks: new Map<
      string,
      (payload: Record<string, unknown>) => Promise<PluginInvocationResult> | PluginInvocationResult
    >(),
    webhooks: new Map<string, (payload: Record<string, unknown>) => Promise<unknown> | unknown>()
  };
}
