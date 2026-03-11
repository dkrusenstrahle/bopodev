import { Router } from "express";
import { z } from "zod";
import {
  createApprovalRequest,
  listCompanyPluginConfigs,
  listCompanies,
  listPluginRuns,
  listPlugins,
  updatePluginConfig
} from "bopodev-db";
import type { AppContext } from "../context";
import { sendError, sendOk } from "../http";
import { requireCompanyScope } from "../middleware/company-scope";

const pluginConfigSchema = z.object({
  enabled: z.boolean().optional(),
  priority: z.number().int().min(0).max(1000).optional(),
  config: z.record(z.string(), z.unknown()).default({}),
  grantedCapabilities: z.array(z.string().min(1)).default([]),
  requestApproval: z.boolean().default(true)
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
    const parsed = pluginConfigSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(res, parsed.error.message, 422);
    }
    const pluginId = req.params.pluginId;
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

  router.post("/:pluginId/install", async (req, res) => {
    const pluginId = req.params.pluginId;
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
