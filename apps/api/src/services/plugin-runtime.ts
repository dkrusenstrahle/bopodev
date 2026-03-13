import type {
  PluginHook,
  PluginInvocationResult,
  PluginManifest,
  PluginPromptExecutionResult,
  PluginTraceEvent,
  PluginWebhookRequest
} from "bopodev-contracts";
import {
  PluginHookSchema,
  PluginInvocationResultSchema,
  PluginManifestSchema,
  PluginPromptExecutionResultSchema,
  PluginTraceEventSchema,
  PluginWebhookRequestSchema
} from "bopodev-contracts";
import type { BopoDb } from "bopodev-db";
import {
  appendAuditEvent,
  appendPluginRun,
  listCompanyPluginConfigs,
  upsertPlugin,
  updatePluginConfig
} from "bopodev-db";
import { loadFilesystemPluginManifests } from "./plugin-manifest-loader";
import { executePluginWebhooks } from "./plugin-webhook-executor";

type HookContext = {
  companyId: string;
  agentId: string;
  runId: string;
  requestId?: string;
  providerType?: string;
  runtime?: {
    command?: string;
    cwd?: string;
  };
  workItemCount?: number;
  summary?: string;
  status?: string;
  trace?: unknown;
  outcome?: unknown;
  error?: string;
};
export type PluginHookResult = {
  blocked: boolean;
  applied: number;
  failures: string[];
  promptAppend: string | null;
};

type BuiltinPluginExecutor = (context: HookContext) => Promise<PluginInvocationResult> | PluginInvocationResult;

const HIGH_RISK_CAPABILITIES = new Set(["network", "queue_publish", "issue_write", "write_memory"]);

const builtinPluginDefinitions = [
  {
    id: "trace-exporter",
    version: "0.1.0",
    displayName: "Trace Exporter",
    description: "Emit normalized heartbeat trace events for downstream observability sinks.",
    kind: "lifecycle",
    hooks: ["afterAdapterExecute", "onError", "afterPersist"],
    capabilities: ["emit_audit"],
    runtime: {
      type: "builtin",
      entrypoint: "builtin:trace-exporter",
      timeoutMs: 5000,
      retryCount: 0
    }
  },
  {
    id: "memory-enricher",
    version: "0.1.0",
    displayName: "Memory Enricher",
    description: "Derive and dedupe memory candidate facts from heartbeat outcomes.",
    kind: "lifecycle",
    hooks: ["afterAdapterExecute", "afterPersist"],
    capabilities: ["read_memory", "emit_audit"],
    runtime: {
      type: "builtin",
      entrypoint: "builtin:memory-enricher",
      timeoutMs: 5000,
      retryCount: 0
    }
  },
  {
    id: "queue-publisher",
    version: "0.1.0",
    displayName: "Queue Publisher",
    description: "Publish heartbeat completion/failure payloads to queue integrations.",
    kind: "integration",
    hooks: ["afterPersist", "onError"],
    capabilities: ["queue_publish", "network", "emit_audit"],
    runtime: {
      type: "builtin",
      entrypoint: "builtin:queue-publisher",
      timeoutMs: 5000,
      retryCount: 0
    }
  },
  {
    id: "heartbeat-tagger",
    version: "0.1.0",
    displayName: "Heartbeat Tagger",
    description: "Attach a simple diagnostic tag to heartbeat plugin runs.",
    kind: "lifecycle",
    hooks: ["afterAdapterExecute"],
    capabilities: ["emit_audit"],
    runtime: {
      type: "builtin",
      entrypoint: "builtin:heartbeat-tagger",
      timeoutMs: 3000,
      retryCount: 0
    }
  }
] as const;

const builtinExecutors: Record<string, BuiltinPluginExecutor> = {
  "trace-exporter": async (context) => ({
    status: "ok",
    summary: "trace-exporter emitted heartbeat trace metadata",
    blockers: [],
    diagnostics: {
      runId: context.runId,
      providerType: context.providerType ?? null,
      status: context.status ?? null
    }
  }),
  "memory-enricher": async (context) => ({
    status: "ok",
    summary: "memory-enricher evaluated summary for memory candidates",
    blockers: [],
    diagnostics: {
      runId: context.runId,
      summaryPresent: typeof context.summary === "string" && context.summary.trim().length > 0
    }
  }),
  "queue-publisher": async (context) => ({
    status: "ok",
    summary: "queue-publisher prepared outbound heartbeat event",
    blockers: [],
    diagnostics: {
      runId: context.runId,
      status: context.status ?? null,
      eventType: context.error ? "heartbeat.failed" : "heartbeat.completed"
    }
  }),
  "heartbeat-tagger": async (context) => ({
    status: "ok",
    summary: "heartbeat-tagger attached diagnostic tag",
    blockers: [],
    diagnostics: {
      tag: "hello-plugin",
      runId: context.runId,
      providerType: context.providerType ?? null
    }
  })
};

export function pluginSystemEnabled() {
  const disabled = process.env.BOPO_PLUGIN_SYSTEM_DISABLED;
  if (disabled === "1" || disabled === "true") {
    return false;
  }
  const legacyEnabled = process.env.BOPO_PLUGIN_SYSTEM_ENABLED;
  if (legacyEnabled === "0" || legacyEnabled === "false") {
    return false;
  }
  return true;
}

export async function ensureBuiltinPluginsRegistered(db: BopoDb, companyIds: string[] = []) {
  const manifests = builtinPluginDefinitions.map((definition) => PluginManifestSchema.parse(definition));
  const manifestIds = new Set(manifests.map((manifest) => manifest.id));
  const fileManifestResult = await loadFilesystemPluginManifests();
  for (const warning of fileManifestResult.warnings) {
    // eslint-disable-next-line no-console
    console.warn(`[plugins] ${warning}`);
  }
  for (const fileManifest of fileManifestResult.manifests) {
    if (manifestIds.has(fileManifest.id)) {
      // eslint-disable-next-line no-console
      console.warn(`[plugins] Skipping filesystem plugin '${fileManifest.id}' because id already exists.`);
      continue;
    }
    manifests.push(fileManifest);
    manifestIds.add(fileManifest.id);
  }

  for (const manifest of manifests) {
    await registerPluginManifest(db, manifest);
  }
  for (const companyId of companyIds) {
    await ensureCompanyBuiltinPluginDefaults(db, companyId);
  }
}

export async function registerPluginManifest(db: BopoDb, manifest: PluginManifest) {
  await upsertPlugin(db, {
    id: manifest.id,
    name: manifest.displayName,
    version: manifest.version,
    kind: manifest.kind,
    runtimeType: manifest.runtime.type,
    runtimeEntrypoint: manifest.runtime.entrypoint,
    hooksJson: JSON.stringify(manifest.hooks),
    capabilitiesJson: JSON.stringify(manifest.capabilities),
    manifestJson: JSON.stringify(manifest)
  });
}

export async function ensureCompanyBuiltinPluginDefaults(db: BopoDb, companyId: string) {
  const existing = await listCompanyPluginConfigs(db, companyId);
  const existingIds = new Set(existing.map((row) => row.pluginId));
  const defaults = [
    { pluginId: "trace-exporter", enabled: false, priority: 40 },
    { pluginId: "memory-enricher", enabled: false, priority: 60 },
    { pluginId: "queue-publisher", enabled: false, priority: 80 },
    { pluginId: "heartbeat-tagger", enabled: false, priority: 90 }
  ];
  for (const entry of defaults) {
    if (existingIds.has(entry.pluginId)) {
      continue;
    }
    await updatePluginConfig(db, {
      companyId,
      pluginId: entry.pluginId,
      enabled: entry.enabled,
      priority: entry.priority,
      configJson: "{}",
      grantedCapabilitiesJson: "[]"
    });
  }
}

export async function runPluginHook(
  db: BopoDb,
  input: {
    hook: PluginHook;
    context: HookContext;
    failClosed?: boolean;
  }
): Promise<PluginHookResult> {
  if (!pluginSystemEnabled()) {
    return { blocked: false, applied: 0, failures: [], promptAppend: null };
  }
  const parsedHook = PluginHookSchema.parse(input.hook);
  const rows = await listCompanyPluginConfigs(db, input.context.companyId);
  const candidates = rows
    .filter((row) => row.enabled)
    .map((row) => {
      const hooks = safeParseStringArray(row.hooksJson);
      const caps = safeParseStringArray(row.capabilitiesJson);
      const grants = safeParseStringArray(row.grantedCapabilitiesJson);
      const manifest = safeParseManifest(row.manifestJson);
      return {
        ...row,
        hooks,
        caps,
        grants,
        manifest
      };
    })
    .filter((row) => row.hooks.includes(parsedHook));

  const failures: string[] = [];
  const promptAppends: string[] = [];
  let applied = 0;
  for (const plugin of candidates) {
    const startedAt = Date.now();
    try {
      const missingHighRiskCapability = plugin.caps.find(
        (cap) => HIGH_RISK_CAPABILITIES.has(cap) && !plugin.grants.includes(cap)
      );
      if (missingHighRiskCapability) {
        const msg = `plugin '${plugin.pluginId}' requires granted capability '${missingHighRiskCapability}'`;
        failures.push(msg);
        await appendPluginRun(db, {
          companyId: input.context.companyId,
          runId: input.context.runId,
          pluginId: plugin.pluginId,
          hook: parsedHook,
          status: "blocked",
          durationMs: Date.now() - startedAt,
          error: msg
        });
        continue;
      }
      const promptResult = await executePromptPlugin(plugin.manifest, plugin.pluginId, input.context, {
        hook: parsedHook,
        pluginConfig: safeParseJsonRecord(plugin.configJson)
      });
      if (promptResult) {
        const processed = await processPromptPluginResult(db, {
          pluginId: plugin.pluginId,
          companyId: input.context.companyId,
          runId: input.context.runId,
          requestId: input.context.requestId,
          pluginCapabilities: plugin.caps,
          promptResult
        });
        if (processed.promptAppend) {
          promptAppends.push(processed.promptAppend);
        }
      }
      const result =
        promptResult && plugin.manifest?.runtime.type === "prompt"
          ? ({
              status: "ok",
              summary: "prompt plugin applied runtime patches",
              blockers: [],
              diagnostics: {
                source: "prompt-runtime"
              }
            } as PluginInvocationResult)
          : await executePlugin(plugin.pluginId, input.context);
      const validated = PluginInvocationResultSchema.parse(result);
      await appendPluginRun(db, {
        companyId: input.context.companyId,
        runId: input.context.runId,
        pluginId: plugin.pluginId,
        hook: parsedHook,
        status: validated.status,
        durationMs: Date.now() - startedAt,
        diagnosticsJson: JSON.stringify({
          ...(validated.diagnostics ?? {}),
          promptAppendApplied: promptResult?.promptAppend ?? null
        }),
        error: validated.status === "failed" || validated.status === "blocked" ? validated.summary : null
      });
      if (validated.status === "failed" || validated.status === "blocked") {
        failures.push(`plugin '${plugin.pluginId}' returned ${validated.status}: ${validated.summary}`);
      } else {
        applied += 1;
      }
    } catch (error) {
      const msg = String(error);
      failures.push(`plugin '${plugin.pluginId}' failed: ${msg}`);
      await appendPluginRun(db, {
        companyId: input.context.companyId,
        runId: input.context.runId,
        pluginId: plugin.pluginId,
        hook: parsedHook,
        status: "failed",
        durationMs: Date.now() - startedAt,
        error: msg
      });
    }
  }

  if (failures.length > 0) {
    await appendAuditEvent(db, {
      companyId: input.context.companyId,
      actorType: "system",
      eventType: "plugin.hook.failures",
      entityType: "heartbeat_run",
      entityId: input.context.runId,
      correlationId: input.context.requestId ?? input.context.runId,
      payload: {
        hook: parsedHook,
        failures
      }
    });
  }
  const blocked = Boolean(input.failClosed) && failures.length > 0;
  return {
    blocked,
    applied,
    failures,
    promptAppend: promptAppends.length > 0 ? promptAppends.join("\n\n") : null
  };
}

function safeParseStringArray(value: string | null | undefined) {
  if (!value) {
    return [] as string[];
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.map((entry) => String(entry)) : [];
  } catch {
    return [];
  }
}

function safeParseJsonRecord(value: string | null | undefined) {
  if (!value) {
    return {} as Record<string, unknown>;
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function safeParseManifest(value: string | null | undefined) {
  if (!value) {
    return null;
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    const manifestParsed = PluginManifestSchema.safeParse(parsed);
    return manifestParsed.success ? manifestParsed.data : null;
  } catch {
    return null;
  }
}

async function executePromptPlugin(
  manifest: PluginManifest | null,
  pluginId: string,
  context: HookContext,
  input: {
    hook: PluginHook;
    pluginConfig: Record<string, unknown>;
  }
) {
  if (!manifest || manifest.runtime.type !== "prompt") {
    return null;
  }
  const promptTemplate = manifest.runtime.promptTemplate ?? "";
  const webhookRequests = normalizeWebhookRequests(input.pluginConfig.webhookRequests);
  const traceEvents = normalizeTraceEvents(input.pluginConfig.traceEvents);
  const firstWebhookUrl = webhookRequests[0]?.url ?? "";
  const renderedTemplate = renderPromptTemplate(promptTemplate, {
    pluginId,
    companyId: context.companyId,
    agentId: context.agentId,
    runId: context.runId,
    hook: input.hook,
    summary: context.summary ?? "",
    providerType: context.providerType ?? "",
    pluginConfig: input.pluginConfig,
    webhookRequests,
    traceEvents,
    webhookUrl: firstWebhookUrl
  });
  return PluginPromptExecutionResultSchema.parse({
    promptAppend: renderedTemplate.trim().length > 0 ? renderedTemplate : undefined,
    webhookRequests,
    traceEvents,
    diagnostics: {
      source: "prompt-runtime",
      templateLength: promptTemplate.length
    }
  });
}

async function processPromptPluginResult(
  db: BopoDb,
  input: {
    pluginId: string;
    companyId: string;
    runId: string;
    requestId?: string;
    pluginCapabilities: string[];
    promptResult: PluginPromptExecutionResult;
  }
) {
  const canEmitAudit = input.pluginCapabilities.includes("emit_audit");
  const canUseWebhooks = input.pluginCapabilities.includes("network") || input.pluginCapabilities.includes("queue_publish");

  if (input.promptResult.traceEvents.length > 0) {
    if (!canEmitAudit) {
      throw new Error(`plugin '${input.pluginId}' emitted trace events without granted 'emit_audit' capability`);
    }
    for (const event of input.promptResult.traceEvents) {
      await appendAuditEvent(db, {
        companyId: input.companyId,
        actorType: "system",
        eventType: event.eventType,
        entityType: "heartbeat_run",
        entityId: input.runId,
        correlationId: input.requestId ?? input.runId,
        payload: {
          pluginId: input.pluginId,
          ...event.payload
        }
      });
    }
  }

  let webhookResults: Awaited<ReturnType<typeof executePluginWebhooks>> = [];
  if (input.promptResult.webhookRequests.length > 0) {
    if (!canUseWebhooks) {
      throw new Error(`plugin '${input.pluginId}' requested webhooks without granted 'network/queue_publish' capability`);
    }
    webhookResults = await executePluginWebhooks(input.promptResult.webhookRequests, {
      pluginId: input.pluginId,
      companyId: input.companyId,
      runId: input.runId
    });
    const failedWebhook = webhookResults.find((entry) => !entry.ok);
    if (failedWebhook) {
      throw new Error(`plugin '${input.pluginId}' webhook request failed: ${failedWebhook.url} (${failedWebhook.error ?? failedWebhook.statusCode ?? "unknown"})`);
    }
  }

  return {
    promptAppend: input.promptResult.promptAppend ?? null,
    webhookResults
  };
}

function normalizeWebhookRequests(value: unknown): PluginWebhookRequest[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const requests: PluginWebhookRequest[] = [];
  for (const entry of value) {
    const parsed = PluginWebhookRequestSchema.safeParse(entry);
    if (parsed.success) {
      requests.push(parsed.data);
    }
  }
  return requests;
}

function normalizeTraceEvents(value: unknown): PluginTraceEvent[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const events: PluginTraceEvent[] = [];
  for (const entry of value) {
    const parsed = PluginTraceEventSchema.safeParse(entry);
    if (parsed.success) {
      events.push(parsed.data);
    }
  }
  return events;
}

function renderPromptTemplate(
  template: string,
  input: {
    pluginId: string;
    companyId: string;
    agentId: string;
    runId: string;
    hook: string;
    summary: string;
    providerType: string;
    pluginConfig: Record<string, unknown>;
    webhookRequests: PluginWebhookRequest[];
    traceEvents: PluginTraceEvent[];
    webhookUrl: string;
  }
) {
  if (!template) {
    return "";
  }
  return template
    .replaceAll("{{pluginId}}", input.pluginId)
    .replaceAll("{{companyId}}", input.companyId)
    .replaceAll("{{agentId}}", input.agentId)
    .replaceAll("{{runId}}", input.runId)
    .replaceAll("{{hook}}", input.hook)
    .replaceAll("{{summary}}", input.summary)
    .replaceAll("{{providerType}}", input.providerType)
    .replaceAll("{{pluginConfig}}", JSON.stringify(input.pluginConfig))
    .replaceAll("{{webhookUrl}}", input.webhookUrl)
    .replaceAll("{{webhookRequests}}", JSON.stringify(input.webhookRequests))
    .replaceAll("{{traceEvents}}", JSON.stringify(input.traceEvents));
}

async function executePlugin(pluginId: string, context: HookContext): Promise<PluginInvocationResult> {
  const executor = builtinExecutors[pluginId];
  if (!executor) {
    return {
      status: "skipped",
      summary: `No executor is registered for plugin '${pluginId}'.`,
      blockers: [],
      diagnostics: { pluginId }
    };
  }
  return executor(context);
}
