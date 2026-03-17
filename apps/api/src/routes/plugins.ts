import { Router } from "express";
import { z } from "zod";
import { PluginManifestSchema } from "bopodev-contracts";
import {
  createApprovalRequest,
  deletePluginById,
  deletePluginConfig,
  listCompanyPluginConfigs,
  listCompanies,
  listPluginRuns,
  listPlugins,
  updatePluginConfig
} from "bopodev-db";
import type { AppContext } from "../context";
import { sendError, sendOk } from "../http";
import { requireCompanyScope } from "../middleware/company-scope";
import { requireBoardRole, requirePermission } from "../middleware/request-actor";
import { deletePluginManifestFromFilesystem, writePluginManifestToFilesystem } from "../services/plugin-manifest-loader";
import { registerPluginManifest } from "../services/plugin-runtime";

const pluginConfigSchema = z.object({
  enabled: z.boolean().optional(),
  priority: z.number().int().min(0).max(1000).optional(),
  config: z.record(z.string(), z.unknown()).default({}),
  grantedCapabilities: z.array(z.string().min(1)).default([]),
  requestApproval: z.boolean().default(true)
});
const pluginManifestCreateSchema = z.object({
  manifestJson: z.string().min(2),
  install: z.boolean().default(true)
});

const HIGH_RISK_CAPABILITIES = new Set(["network", "queue_publish", "issue_write", "write_memory"]);

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
    requirePermission("plugins:write")(req, res, () => {});
    if (res.headersSent) {
      return;
    }
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
      return sendError(res, `Plugin '${pluginId}' was not found. Restart API to refresh built-in plugins.`, 404);
    }
    const companyExists = companies.some((company) => company.id === req.companyId);
    if (!companyExists) {
      return sendError(res, `Company '${req.companyId}' does not exist.`, 404);
    }
    const riskyCaps = parsed.data.grantedCapabilities.filter((cap) => HIGH_RISK_CAPABILITIES.has(cap));
    if (riskyCaps.length > 0 && parsed.data.requestApproval) {
      const approvalId = await createApprovalRequest(ctx.db, {
        companyId: req.companyId!,
        requestedByAgentId: req.actor?.type === "agent" ? req.actor.id : null,
        action: "grant_plugin_capabilities",
        payload: {
          pluginId,
          enabled: parsed.data.enabled,
          priority: parsed.data.priority,
          grantedCapabilities: parsed.data.grantedCapabilities,
          config: parsed.data.config
        }
      });
      return sendOk(res, { approvalId, status: "pending" });
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

  router.post("/install-from-json", async (req, res) => {
    requirePermission("plugins:write")(req, res, () => {});
    if (res.headersSent) {
      return;
    }
    const parsed = pluginManifestCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(res, parsed.error.message, 422);
    }
    let rawManifest: unknown;
    try {
      rawManifest = JSON.parse(parsed.data.manifestJson);
    } catch {
      return sendError(res, "manifestJson must be valid JSON.", 422);
    }
    const manifestParsed = PluginManifestSchema.safeParse(rawManifest);
    if (!manifestParsed.success) {
      return sendError(res, manifestParsed.error.message, 422);
    }
    const manifest = manifestParsed.data;
    const [companies] = await Promise.all([listCompanies(ctx.db)]);
    const companyExists = companies.some((company) => company.id === req.companyId);
    if (!companyExists) {
      return sendError(res, `Company '${req.companyId}' does not exist.`, 404);
    }

    const manifestPath = await writePluginManifestToFilesystem(manifest);
    await registerPluginManifest(ctx.db, manifest);
    if (parsed.data.install) {
      await updatePluginConfig(ctx.db, {
        companyId: req.companyId!,
        pluginId: manifest.id,
        enabled: false,
        priority: 100,
        configJson: "{}",
        grantedCapabilitiesJson: "[]"
      });
    }
    return sendOk(res, { ok: true, pluginId: manifest.id, manifestPath, installed: parsed.data.install });
  });

  router.post("/:pluginId/install", async (req, res) => {
    requirePermission("plugins:write")(req, res, () => {});
    if (res.headersSent) {
      return;
    }
    const pluginId = readPluginIdParam(req.params.pluginId);
    if (!pluginId) {
      return sendError(res, "Missing plugin id.", 422);
    }
    const [catalog, companies] = await Promise.all([listPlugins(ctx.db), listCompanies(ctx.db)]);
    const plugin = catalog.find((item) => item.id === pluginId);
    if (!plugin) {
      return sendError(res, `Plugin '${pluginId}' was not found. Restart API to refresh built-in plugins.`, 404);
    }
    const companyExists = companies.some((company) => company.id === req.companyId);
    if (!companyExists) {
      return sendError(res, `Company '${req.companyId}' does not exist.`, 404);
    }
    await updatePluginConfig(ctx.db, {
      companyId: req.companyId!,
      pluginId,
      enabled: false,
      priority: 100,
      configJson: "{}",
      grantedCapabilitiesJson: "[]"
    });
    return sendOk(res, { ok: true, pluginId, installed: true, enabled: false });
  });

  router.delete("/:pluginId/install", async (req, res) => {
    requirePermission("plugins:write")(req, res, () => {});
    if (res.headersSent) {
      return;
    }
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
    await deletePluginConfig(ctx.db, {
      companyId: req.companyId!,
      pluginId
    });
    return sendOk(res, { ok: true, pluginId, installed: false });
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
    if (plugin.runtimeEntrypoint.startsWith("builtin:")) {
      return sendError(res, `Plugin '${pluginId}' is built-in and cannot be deleted.`, 400);
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
