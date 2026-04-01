import type {
  PluginHook,
  PluginCapabilityNamespace,
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
  PluginManifestV2Schema,
  PLUGIN_CAPABILITY_RISK,
  PluginPromptExecutionResultSchema,
  PluginTraceEventSchema,
  PluginWebhookRequestSchema
} from "bopodev-contracts";
import type { BopoDb } from "bopodev-db";
import {
  appendAuditEvent,
  deletePluginById,
  appendPluginRun,
  listCompanyPluginConfigs,
  listPlugins,
  upsertPlugin,
  updatePluginConfig
} from "bopodev-db";
import { loadFilesystemPluginManifests } from "./plugin-manifest-loader";
import { executePluginWebhooks } from "./plugin-webhook-executor";
import { pluginWorkerHost } from "./plugin-worker-host";

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

const HIGH_RISK_CAPABILITIES = new Set(["network", "queue_publish", "issue_write", "write_memory"]);

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

export async function ensureBuiltinPluginsRegistered(db: BopoDb, _companyIds: string[] = []) {
  const existing = await listPlugins(db);
  for (const plugin of existing) {
    if (plugin.runtimeEntrypoint.startsWith("builtin:")) {
      await deletePluginById(db, plugin.id);
    }
  }
  const manifests: PluginManifest[] = [];
  const manifestIds = new Set<string>();
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
  for (const companyId of _companyIds) {
    const existingConfigs = await listCompanyPluginConfigs(db, companyId);
    const installedIds = new Set(existingConfigs.map((row) => row.pluginId));
    for (const manifest of manifests) {
      if (installedIds.has(manifest.id)) {
        continue;
      }
      await updatePluginConfig(db, {
        companyId,
        pluginId: manifest.id,
        enabled: false,
        priority: 100,
        configJson: "{}",
        grantedCapabilitiesJson: "[]"
      });
    }
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
      const namespaceViolation = resolveMissingCapabilityNamespace(
        plugin.manifest,
        safeParseJsonRecord(plugin.configJson),
        ["events.subscribe"]
      );
      if (namespaceViolation) {
        const msg = `plugin '${plugin.pluginId}' requires granted capability namespace '${namespaceViolation}'`;
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
      if (plugin.manifest?.runtime.type === "prompt") {
        throw new Error(`plugin '${plugin.pluginId}' uses removed prompt runtime; install a worker package plugin`);
      }
      const result = await executePluginWithRuntime(plugin.pluginId, plugin.manifest, parsedHook, input.context);
      const validated = PluginInvocationResultSchema.parse(result);
      await appendPluginRun(db, {
        companyId: input.context.companyId,
        runId: input.context.runId,
        pluginId: plugin.pluginId,
        hook: parsedHook,
        status: validated.status,
        durationMs: Date.now() - startedAt,
        diagnosticsJson: JSON.stringify(validated.diagnostics ?? {}),
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
    promptAppend: null
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

export function isLegacyPluginManifest(manifest: PluginManifest | null) {
  return !manifest || !("apiVersion" in manifest) || manifest.apiVersion !== "2";
}

export async function invokePluginWorkerEndpoint(
  db: BopoDb,
  input: {
    companyId: string;
    pluginId: string;
    endpointType: "action" | "data";
    endpointKey: string;
    payload?: Record<string, unknown>;
  }
) {
  const rows = await listCompanyPluginConfigs(db, input.companyId);
  const row = rows.find((entry) => entry.pluginId === input.pluginId);
  if (!row || !row.enabled) {
    throw new Error(`plugin '${input.pluginId}' is not installed or enabled for this company`);
  }
  const manifest = safeParseManifest(row.manifestJson);
  if (!manifest) {
    throw new Error(`plugin '${input.pluginId}' manifest is invalid`);
  }
  const parsedV2 = PluginManifestV2Schema.safeParse(manifest);
  if (!parsedV2.success) {
    throw new Error(`plugin '${input.pluginId}' does not support worker endpoints`);
  }
  const requiredNamespace = input.endpointType === "action" ? "actions.execute" : "data.read";
  const namespaceViolation = resolveMissingCapabilityNamespace(parsedV2.data, safeParseJsonRecord(row.configJson), [
    requiredNamespace
  ]);
  if (namespaceViolation) {
    throw new Error(`plugin '${input.pluginId}' requires granted capability namespace '${namespaceViolation}'`);
  }
  const result = await pluginWorkerHost.invoke(parsedV2.data, {
    method: input.endpointType === "action" ? "plugin.action" : "plugin.data",
    params: {
      key: input.endpointKey,
      companyId: input.companyId,
      payload: input.payload ?? {}
    }
  });
  return result;
}

export async function invokePluginWorkerHealth(
  db: BopoDb,
  input: {
    companyId: string;
    pluginId: string;
  }
) {
  const rows = await listCompanyPluginConfigs(db, input.companyId);
  const row = rows.find((entry) => entry.pluginId === input.pluginId);
  if (!row || !row.enabled) {
    throw new Error(`plugin '${input.pluginId}' is not installed or enabled for this company`);
  }
  const manifest = safeParseManifest(row.manifestJson);
  if (!manifest) {
    throw new Error(`plugin '${input.pluginId}' manifest is invalid`);
  }
  return await pluginWorkerHost.invoke(manifest, {
    method: "plugin.health",
    params: {
      companyId: input.companyId
    }
  });
}

export async function invokePluginWorkerWebhook(
  db: BopoDb,
  input: {
    companyId: string;
    pluginId: string;
    endpointKey: string;
    payload?: Record<string, unknown>;
    headers?: Record<string, string>;
  }
) {
  const rows = await listCompanyPluginConfigs(db, input.companyId);
  const row = rows.find((entry) => entry.pluginId === input.pluginId);
  if (!row || !row.enabled) {
    throw new Error(`plugin '${input.pluginId}' is not installed or enabled for this company`);
  }
  const manifest = safeParseManifest(row.manifestJson);
  if (!manifest) {
    throw new Error(`plugin '${input.pluginId}' manifest is invalid`);
  }
  const config = safeParseJsonRecord(row.configJson);
  const webhook = manifest.webhooks.find((entry) => entry.endpointKey === input.endpointKey);
  if (!webhook) {
    throw new Error(`plugin '${input.pluginId}' does not declare webhook '${input.endpointKey}'`);
  }
  const secretHeader = webhook.secretHeader?.toLowerCase();
  if (secretHeader) {
    const secretsMap =
      typeof config._webhookSecrets === "object" && config._webhookSecrets !== null
        ? (config._webhookSecrets as Record<string, unknown>)
        : {};
    const expected = secretsMap[input.endpointKey];
    const actual = input.headers?.[secretHeader];
    if (typeof expected === "string" && expected.length > 0 && actual !== expected) {
      throw new Error(`webhook signature check failed for endpoint '${input.endpointKey}'`);
    }
  }
  const namespaceViolation = resolveMissingCapabilityNamespace(manifest, config, ["webhooks.handle"]);
  if (namespaceViolation) {
    throw new Error(`plugin '${input.pluginId}' requires granted capability namespace '${namespaceViolation}'`);
  }
  return await pluginWorkerHost.invoke(manifest, {
    method: "plugin.webhook",
    params: {
      companyId: input.companyId,
      endpointKey: input.endpointKey,
      payload: input.payload ?? {},
      headers: input.headers ?? {}
    }
  });
}

export async function resolvePluginUiEntrypoint(
  db: BopoDb,
  input: {
    companyId: string;
    pluginId: string;
  }
) {
  const rows = await listCompanyPluginConfigs(db, input.companyId);
  const row = rows.find((entry) => entry.pluginId === input.pluginId);
  if (!row || !row.enabled) {
    throw new Error(`plugin '${input.pluginId}' is not installed or enabled for this company`);
  }
  const manifest = safeParseManifest(row.manifestJson);
  if (!manifest) {
    throw new Error(`plugin '${input.pluginId}' manifest is invalid`);
  }
  return manifest.entrypoints.ui ?? null;
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

async function executePluginWithRuntime(
  pluginId: string,
  manifest: PluginManifest | null,
  hook: PluginHook,
  context: HookContext
): Promise<PluginInvocationResult> {
  if (!manifest) {
    throw new Error(`plugin '${pluginId}' manifest is missing`);
  }
  if (manifest.runtime.type === "builtin") {
    throw new Error(`plugin '${pluginId}' uses removed builtin runtime; install a package plugin`);
  }
  const workerResult = await pluginWorkerHost.invoke(manifest, {
    method: "plugin.hook",
    params: {
      hook,
      context
    }
  });
  return PluginInvocationResultSchema.parse(workerResult);
}

function resolveMissingCapabilityNamespace(
  manifest: PluginManifest | null,
  config: Record<string, unknown>,
  requiredNamespaces: PluginCapabilityNamespace[]
) {
  if (!manifest || !("capabilityNamespaces" in manifest)) {
    return null;
  }
  if (requiredNamespaces.length === 0) {
    return null;
  }
  const requested = manifest.capabilityNamespaces ?? [];
  if (requested.length === 0) {
    return null;
  }
  const grantedRaw = config._grantedCapabilityNamespaces;
  const granted = Array.isArray(grantedRaw) ? grantedRaw.map((value) => String(value)) : [];
  for (const namespace of requiredNamespaces) {
    if (!requested.includes(namespace)) {
      continue;
    }
    const risk = PLUGIN_CAPABILITY_RISK[namespace];
    if ((risk === "elevated" || risk === "restricted") && !granted.includes(namespace)) {
      return namespace;
    }
  }
  return null;
}
