import type { PluginHook, PluginInvocationResult } from "bopodev-contracts";
import {
  PluginHookSchema,
  PluginInvocationResultSchema,
  PluginManifestSchema
} from "bopodev-contracts";
import type { BopoDb } from "bopodev-db";
import {
  appendAuditEvent,
  appendPluginRun,
  listCompanyPluginConfigs,
  upsertPlugin,
  updatePluginConfig
} from "bopodev-db";

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
  for (const definition of builtinPluginDefinitions) {
    const manifest = PluginManifestSchema.parse(definition);
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
  for (const companyId of companyIds) {
    await ensureCompanyBuiltinPluginDefaults(db, companyId);
  }
}

export async function ensureCompanyBuiltinPluginDefaults(db: BopoDb, companyId: string) {
  const existing = await listCompanyPluginConfigs(db, companyId);
  const existingIds = new Set(existing.map((row) => row.pluginId));
  const defaults = [
    { pluginId: "trace-exporter", enabled: true, priority: 40 },
    { pluginId: "memory-enricher", enabled: true, priority: 60 },
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
) {
  if (!pluginSystemEnabled()) {
    return { blocked: false, applied: 0, failures: [] as string[] };
  }
  const parsedHook = PluginHookSchema.parse(input.hook);
  const rows = await listCompanyPluginConfigs(db, input.context.companyId);
  const candidates = rows
    .filter((row) => row.enabled)
    .map((row) => {
      const hooks = safeParseStringArray(row.hooksJson);
      const caps = safeParseStringArray(row.capabilitiesJson);
      const grants = safeParseStringArray(row.grantedCapabilitiesJson);
      return {
        ...row,
        hooks,
        caps,
        grants
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
      const result = await executePlugin(plugin.pluginId, input.context);
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
  return { blocked, applied, failures };
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
