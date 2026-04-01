import { Router } from "express";
import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { PluginManifestV2Schema } from "bopodev-contracts";
import {
  appendPluginInstall,
  createApprovalRequest,
  deletePluginById,
  getPluginInstallById,
  listCompanyPluginConfigs,
  listCompanies,
  listPluginInstalls,
  listPluginRuns,
  listPlugins,
  markPluginInstallStatus,
  markPluginInstallsSuperseded,
  updatePluginConfig
} from "bopodev-db";
import type { AppContext } from "../context";
import { sendError, sendOk } from "../http";
import { requireCompanyScope } from "../middleware/company-scope";
import { enforcePermission, requireBoardRole } from "../middleware/request-actor";
import {
  deletePluginManifestFromFilesystem,
  writePackagedPluginManifestToFilesystem
} from "../services/plugin-manifest-loader";
import {
  invokePluginWorkerEndpoint,
  invokePluginWorkerHealth,
  invokePluginWorkerWebhook,
  resolvePluginUiEntrypoint,
  registerPluginManifest
} from "../services/plugin-runtime";
import { namespacedCapabilitiesRequireApproval } from "../services/plugin-capability-policy";
import { installPluginArtifactFromNpm } from "../services/plugin-artifact-installer";

const pluginConfigSchema = z.object({
  enabled: z.boolean().optional(),
  priority: z.number().int().min(0).max(1000).optional(),
  config: z.record(z.string(), z.unknown()).default({}),
  grantedCapabilities: z.array(z.string().min(1)).default([]),
  requestApproval: z.boolean().default(true)
});
const pluginRegistryInstallSchema = z.object({
  packageName: z.string().min(1),
  version: z.string().min(1).optional(),
  install: z.boolean().default(true),
  requestApproval: z.boolean().default(true)
});
const pluginRollbackSchema = z.object({
  installId: z.string().min(1)
});
const pluginUpgradeSchema = z.object({
  packageName: z.string().min(1),
  version: z.string().min(1).optional()
});

export function createPluginsRouter(ctx: AppContext) {
  const router = Router();
  router.use(requireCompanyScope);

  router.get("/", async (req, res) => {
    const [catalog, configs] = await Promise.all([listPlugins(ctx.db), listCompanyPluginConfigs(ctx.db, req.companyId!)]);
    const configByPluginId = new Map(configs.map((row) => [row.pluginId, row]));
    return sendOk(
      res,
      catalog.map((plugin) => {
        const config = configByPluginId.get(plugin.id);
        const manifest = safeParseJsonObject(plugin.manifestJson) as Record<string, unknown>;
        return {
          id: plugin.id,
          name: plugin.name,
          description: typeof manifest.description === "string" ? manifest.description : null,
          promptTemplate:
            typeof manifest.runtime === "object" &&
            manifest.runtime !== null &&
            typeof (manifest.runtime as Record<string, unknown>).promptTemplate === "string"
              ? ((manifest.runtime as Record<string, unknown>).promptTemplate as string)
              : null,
          version: plugin.version,
          kind: plugin.kind,
          runtimeType: plugin.runtimeType,
          runtimeEntrypoint: plugin.runtimeEntrypoint,
          apiVersion: typeof manifest.apiVersion === "string" ? manifest.apiVersion : "2",
          entrypoints:
            typeof manifest.entrypoints === "object" && manifest.entrypoints !== null
              ? manifest.entrypoints
              : null,
          uiSlots:
            typeof manifest.ui === "object" &&
            manifest.ui !== null &&
            Array.isArray((manifest.ui as Record<string, unknown>).slots)
              ? (manifest.ui as { slots: unknown[] }).slots
              : [],
          install:
            typeof manifest.install === "object" && manifest.install !== null
              ? (manifest.install as Record<string, unknown>)
              : null,
          hooks: safeParseStringArray(plugin.hooksJson),
          capabilities: safeParseStringArray(plugin.capabilitiesJson),
          companyConfig: config
            ? {
                enabled: config.enabled,
                priority: config.priority,
                config: safeParseJsonObject(config.configJson),
                grantedCapabilities: safeParseStringArray(config.grantedCapabilitiesJson)
              }
            : null
        };
      })
    );
  });

  router.put("/:pluginId", async (req, res) => {
    if (!enforcePermission(req, res, "plugins:write")) return;
    const parsed = pluginConfigSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(res, parsed.error.message, 422);
    }
    const pluginId = readPluginIdParam(req.params.pluginId);
    if (!pluginId) {
      return sendError(res, "Missing plugin id.", 422);
    }
    const [catalog, companies] = await Promise.all([listPlugins(ctx.db), listCompanies(ctx.db)]);
    const pluginExists = catalog.some((plugin) => plugin.id === pluginId);
    if (!pluginExists) {
      return sendError(res, `Plugin '${pluginId}' was not found.`, 404);
    }
    const companyExists = companies.some((company) => company.id === req.companyId);
    if (!companyExists) {
      return sendError(res, `Company '${req.companyId}' does not exist.`, 404);
    }
    await updatePluginConfig(ctx.db, {
      companyId: req.companyId!,
      pluginId,
      enabled: parsed.data.enabled,
      priority: parsed.data.priority,
      configJson: JSON.stringify(parsed.data.config),
      grantedCapabilitiesJson: JSON.stringify(parsed.data.grantedCapabilities)
    });
    return sendOk(res, { ok: true });
  });

  router.post("/install", async (req, res) => {
    if (!enforcePermission(req, res, "plugins:write")) return;
    const parsed = pluginRegistryInstallSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(res, parsed.error.message, 422);
    }
    const [companies] = await Promise.all([listCompanies(ctx.db)]);
    const companyExists = companies.some((company) => company.id === req.companyId);
    if (!companyExists) {
      return sendError(res, `Company '${req.companyId}' does not exist.`, 404);
    }
    try {
      const installed = await installPluginArtifactFromNpm({
        packageName: parsed.data.packageName,
        version: parsed.data.version
      });
      const requestedNamespaces = installed.manifest.capabilityNamespaces ?? [];
      if (requestedNamespaces.length > 0 && namespacedCapabilitiesRequireApproval(requestedNamespaces) && parsed.data.requestApproval) {
        const approvalId = await createApprovalRequest(ctx.db, {
          companyId: req.companyId!,
          requestedByAgentId: req.actor?.type === "agent" ? req.actor.id : null,
          action: "grant_plugin_capabilities",
          payload: {
            pluginId: installed.manifest.id,
            capabilityNamespaces: requestedNamespaces,
            sourceType: "registry",
            sourceRef: installed.packageRef,
            integrity: installed.integrity ?? null,
            buildHash: installed.buildHash,
            manifestJson: JSON.stringify(installed.manifest),
            install: parsed.data.install
          }
        });
        return sendOk(res, { ok: true, pluginId: installed.manifest.id, approvalId, status: "pending" });
      }
      const manifestPath = await writePackagedPluginManifestToFilesystem(installed.manifest, {
        sourceType: "registry",
        sourceRef: installed.packageRef,
        integrity: installed.integrity,
        buildHash: installed.buildHash
      });
      await registerPluginManifest(ctx.db, installed.manifest);
      await markPluginInstallsSuperseded(ctx.db, {
        companyId: req.companyId!,
        pluginId: installed.manifest.id
      });
      const installId = await appendPluginInstall(ctx.db, {
        companyId: req.companyId!,
        pluginId: installed.manifest.id,
        pluginVersion: installed.manifest.version,
        sourceType: "registry",
        sourceRef: installed.packageRef,
        integrity: installed.integrity ?? null,
        buildHash: installed.buildHash,
        artifactPath: installed.manifest.install?.artifactPath ?? null,
        manifestJson: JSON.stringify(installed.manifest),
        status: "active"
      });
      if (parsed.data.install) {
        await updatePluginConfig(ctx.db, {
          companyId: req.companyId!,
          pluginId: installed.manifest.id,
          enabled: false,
          priority: 100,
          configJson: "{}",
          grantedCapabilitiesJson: "[]"
        });
      }
      return sendOk(res, {
        ok: true,
        pluginId: installed.manifest.id,
        installId,
        installed: parsed.data.install,
        manifestPath,
        sourceType: "registry",
        sourceRef: installed.packageRef
      });
    } catch (error) {
      return sendError(res, `Failed to install package plugin: ${String(error)}`, 422);
    }
  });

  router.delete("/:pluginId", requireBoardRole, async (req, res) => {
    const pluginId = readPluginIdParam(req.params.pluginId);
    if (!pluginId) {
      return sendError(res, "Missing plugin id.", 422);
    }
    const [catalog, companies] = await Promise.all([listPlugins(ctx.db), listCompanies(ctx.db)]);
    const plugin = catalog.find((item) => item.id === pluginId);
    if (!plugin) {
      return sendError(res, `Plugin '${pluginId}' was not found.`, 404);
    }
    const companyExists = companies.some((company) => company.id === req.companyId);
    if (!companyExists) {
      return sendError(res, `Company '${req.companyId}' does not exist.`, 404);
    }
    await deletePluginManifestFromFilesystem(pluginId);
    await deletePluginById(ctx.db, pluginId);
    return sendOk(res, { ok: true, pluginId, deleted: true });
  });

  router.get("/runs", async (req, res) => {
    const pluginId = typeof req.query.pluginId === "string" ? req.query.pluginId : undefined;
    const runId = typeof req.query.runId === "string" ? req.query.runId : undefined;
    const limit = typeof req.query.limit === "string" ? Number(req.query.limit) : undefined;
    const rows = await listPluginRuns(ctx.db, {
      companyId: req.companyId!,
      pluginId,
      runId,
      limit
    });
    return sendOk(
      res,
      rows.map((row) => ({
        ...row,
        diagnostics: safeParseJsonObject(row.diagnosticsJson)
      }))
    );
  });

  router.get("/:pluginId/installs", async (req, res) => {
    const pluginId = readPluginIdParam(req.params.pluginId);
    if (!pluginId) {
      return sendError(res, "Missing plugin id.", 422);
    }
    let rows: Awaited<ReturnType<typeof listPluginInstalls>>;
    try {
      rows = await listPluginInstalls(ctx.db, {
        companyId: req.companyId!,
        pluginId,
        limit: typeof req.query.limit === "string" ? Number(req.query.limit) : undefined
      });
    } catch (error) {
      if (isMissingPluginInstallsTableError(error)) {
        return sendError(res, "Plugin version history is unavailable. Run database migrations.", 422);
      }
      throw error;
    }
    return sendOk(
      res,
      rows.map((row) => ({
        ...row,
        manifest: safeParseJsonObject(row.manifestJson)
      }))
    );
  });

  router.post("/:pluginId/rollback", async (req, res) => {
    if (!enforcePermission(req, res, "plugins:write")) return;
    const pluginId = readPluginIdParam(req.params.pluginId);
    if (!pluginId) {
      return sendError(res, "Missing plugin id.", 422);
    }
    const parsed = pluginRollbackSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(res, parsed.error.message, 422);
    }
    let target: Awaited<ReturnType<typeof getPluginInstallById>>;
    try {
      target = await getPluginInstallById(ctx.db, {
        companyId: req.companyId!,
        pluginId,
        installId: parsed.data.installId
      });
    } catch (error) {
      if (isMissingPluginInstallsTableError(error)) {
        return sendError(res, "Plugin rollback is unavailable. Run database migrations.", 422);
      }
      throw error;
    }
    if (!target) {
      return sendError(res, `Plugin install '${parsed.data.installId}' was not found.`, 404);
    }
    const manifestParsed = PluginManifestV2Schema.safeParse(safeParseJsonObject(target.manifestJson));
    if (!manifestParsed.success) {
      return sendError(res, "Stored plugin install manifest is invalid.", 422);
    }
    await registerPluginManifest(ctx.db, manifestParsed.data);
    try {
      await markPluginInstallsSuperseded(ctx.db, { companyId: req.companyId!, pluginId });
      await markPluginInstallStatus(ctx.db, {
        companyId: req.companyId!,
        pluginId,
        installId: parsed.data.installId,
        status: "active"
      });
    } catch (error) {
      if (isMissingPluginInstallsTableError(error)) {
        return sendError(res, "Plugin rollback is unavailable. Run database migrations.", 422);
      }
      throw error;
    }
    return sendOk(res, {
      ok: true,
      pluginId,
      rollbackToInstallId: parsed.data.installId
    });
  });

  router.post("/:pluginId/upgrade", async (req, res) => {
    if (!enforcePermission(req, res, "plugins:write")) return;
    const pluginId = readPluginIdParam(req.params.pluginId);
    if (!pluginId) {
      return sendError(res, "Missing plugin id.", 422);
    }
    const parsed = pluginUpgradeSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(res, parsed.error.message, 422);
    }
    try {
      const installed = await installPluginArtifactFromNpm({
        packageName: parsed.data.packageName,
        version: parsed.data.version
      });
      if (installed.manifest.id !== pluginId) {
        return sendError(
          res,
          `Installed package manifest id '${installed.manifest.id}' does not match route plugin id '${pluginId}'.`,
          422
        );
      }
      await writePackagedPluginManifestToFilesystem(installed.manifest, {
        sourceType: "registry",
        sourceRef: installed.packageRef,
        integrity: installed.integrity,
        buildHash: installed.buildHash
      });
      await registerPluginManifest(ctx.db, installed.manifest);
      await markPluginInstallsSuperseded(ctx.db, {
        companyId: req.companyId!,
        pluginId
      });
      const installId = await appendPluginInstall(ctx.db, {
        companyId: req.companyId!,
        pluginId,
        pluginVersion: installed.manifest.version,
        sourceType: "registry",
        sourceRef: installed.packageRef,
        integrity: installed.integrity ?? null,
        buildHash: installed.buildHash,
        artifactPath: installed.manifest.install?.artifactPath ?? null,
        manifestJson: JSON.stringify(installed.manifest),
        status: "active"
      });
      return sendOk(res, {
        ok: true,
        pluginId,
        installId,
        upgradedToVersion: installed.manifest.version
      });
    } catch (error) {
      return sendError(res, `Failed to upgrade plugin: ${String(error)}`, 422);
    }
  });

  router.post("/:pluginId/actions/:actionKey", async (req, res) => {
    if (!enforcePermission(req, res, "plugins:write")) return;
    const pluginId = readPluginIdParam(req.params.pluginId);
    const actionKey = readPluginIdParam(req.params.actionKey);
    if (!pluginId || !actionKey) {
      return sendError(res, "Missing plugin id or action key.", 422);
    }
    try {
      const payload = typeof req.body === "object" && req.body !== null ? (req.body as Record<string, unknown>) : {};
      const result = await invokePluginWorkerEndpoint(ctx.db, {
        companyId: req.companyId!,
        pluginId,
        endpointType: "action",
        endpointKey: actionKey,
        payload
      });
      return sendOk(res, { ok: true, data: result });
    } catch (error) {
      return sendError(res, String(error), 422);
    }
  });

  router.get("/:pluginId/health", async (req, res) => {
    const pluginId = readPluginIdParam(req.params.pluginId);
    if (!pluginId) {
      return sendError(res, "Missing plugin id.", 422);
    }
    try {
      const data = await invokePluginWorkerHealth(ctx.db, {
        companyId: req.companyId!,
        pluginId
      });
      return sendOk(res, { ok: true, data });
    } catch (error) {
      return sendError(res, String(error), 422);
    }
  });

  router.post("/:pluginId/data/:dataKey", async (req, res) => {
    const pluginId = readPluginIdParam(req.params.pluginId);
    const dataKey = readPluginIdParam(req.params.dataKey);
    if (!pluginId || !dataKey) {
      return sendError(res, "Missing plugin id or data key.", 422);
    }
    try {
      const payload = typeof req.body === "object" && req.body !== null ? (req.body as Record<string, unknown>) : {};
      const result = await invokePluginWorkerEndpoint(ctx.db, {
        companyId: req.companyId!,
        pluginId,
        endpointType: "data",
        endpointKey: dataKey,
        payload
      });
      return sendOk(res, { ok: true, data: result });
    } catch (error) {
      return sendError(res, String(error), 422);
    }
  });

  router.post("/:pluginId/webhooks/:endpointKey", async (req, res) => {
    const pluginId = readPluginIdParam(req.params.pluginId);
    const endpointKey = readPluginIdParam(req.params.endpointKey);
    if (!pluginId || !endpointKey) {
      return sendError(res, "Missing plugin id or endpoint key.", 422);
    }
    try {
      const payload = typeof req.body === "object" && req.body !== null ? (req.body as Record<string, unknown>) : {};
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(req.headers)) {
        if (typeof value === "string") {
          headers[key] = value;
        }
      }
      const data = await invokePluginWorkerWebhook(ctx.db, {
        companyId: req.companyId!,
        pluginId,
        endpointKey,
        payload,
        headers
      });
      return sendOk(res, { ok: true, data });
    } catch (error) {
      return sendError(res, String(error), 422);
    }
  });

  router.get("/:pluginId/ui", async (req, res) => {
    const pluginId = readPluginIdParam(req.params.pluginId);
    if (!pluginId) {
      return sendError(res, "Missing plugin id.", 422);
    }
    try {
      const uiEntrypoint = await resolvePluginUiEntrypoint(ctx.db, {
        companyId: req.companyId!,
        pluginId
      });
      if (!uiEntrypoint) {
        return sendError(res, `Plugin '${pluginId}' does not declare a UI entrypoint.`, 404);
      }
      const indexPath = uiEntrypoint.endsWith(".html") ? uiEntrypoint : resolve(uiEntrypoint, "index.html");
      await access(indexPath);
      return res.sendFile(indexPath);
    } catch (error) {
      return sendError(res, String(error), 422);
    }
  });

  return router;
}

function readPluginIdParam(value: string | string[] | undefined) {
  return typeof value === "string" ? value : null;
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

function safeParseJsonObject(value: string | null | undefined) {
  if (!value) {
    return {};
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

function isMissingPluginInstallsTableError(error: unknown) {
  const visited = new Set<unknown>();
  const queue: unknown[] = [error];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined || current === null || visited.has(current)) {
      continue;
    }
    visited.add(current);
    const message = String(current);
    if (message.includes('relation "plugin_installs" does not exist')) {
      return true;
    }
    if (typeof current === "object") {
      const record = current as Record<string, unknown>;
      if ("cause" in record) {
        queue.push(record.cause);
      }
      if ("message" in record) {
        queue.push(record.message);
      }
    }
  }
  return false;
}
