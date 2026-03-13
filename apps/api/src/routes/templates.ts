import { Router } from "express";
import {
  TemplateApplyRequestSchema,
  TemplateCreateRequestSchema,
  TemplateManifestDefault,
  TemplateImportRequestSchema,
  TemplateManifestSchema,
  TemplatePreviewRequestSchema,
  TemplateUpdateRequestSchema
} from "bopodev-contracts";
import {
  appendAuditEvent,
  createApprovalRequest,
  createTemplate,
  createTemplateVersion,
  deleteTemplate,
  getCurrentTemplateVersion,
  getTemplate,
  getTemplateBySlug,
  getTemplateVersionByVersion,
  listTemplates,
  updateTemplate
} from "bopodev-db";
import type { AppContext } from "../context";
import { sendError, sendOk } from "../http";
import { requireCompanyScope } from "../middleware/company-scope";
import { requirePermission } from "../middleware/request-actor";
import { applyTemplateManifest } from "../services/template-apply-service";
import { buildTemplatePreview } from "../services/template-preview-service";

export function createTemplatesRouter(ctx: AppContext) {
  const router = Router();
  router.use(requireCompanyScope);

  router.get("/", async (req, res) => {
    const rows = await listTemplates(ctx.db, req.companyId!);
    const hydrated = await Promise.all(rows.map((row) => hydrateTemplate(ctx, req.companyId!, row.id)));
    return sendOk(res, hydrated.filter((row): row is NonNullable<typeof row> => Boolean(row)));
  });

  router.post("/", async (req, res) => {
    requirePermission("templates:write")(req, res, () => {});
    if (res.headersSent) {
      return;
    }
    const parsed = TemplateCreateRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(res, parsed.error.message, 422);
    }
    const existing = await getTemplateBySlug(ctx.db, req.companyId!, parsed.data.slug);
    if (existing) {
      return sendError(res, `Template slug '${parsed.data.slug}' already exists.`, 409);
    }
    const created = await createTemplate(ctx.db, {
      companyId: req.companyId!,
      slug: parsed.data.slug,
      name: parsed.data.name,
      description: parsed.data.description,
      currentVersion: parsed.data.currentVersion,
      status: parsed.data.status,
      visibility: parsed.data.visibility,
      variablesJson: JSON.stringify(parsed.data.variables)
    });
    if (!created) {
      return sendError(res, "Template creation failed.", 500);
    }
    await createTemplateVersion(ctx.db, {
      companyId: req.companyId!,
      templateId: created.id,
      version: parsed.data.currentVersion,
      manifestJson: JSON.stringify(parsed.data.manifest)
    });
    const hydrated = await hydrateTemplate(ctx, req.companyId!, created.id);
    await appendAuditEvent(ctx.db, {
      companyId: req.companyId!,
      actorType: "human",
      eventType: "template.created",
      entityType: "template",
      entityId: created.id,
      payload: hydrated ?? created
    });
    return sendOk(res, hydrated ?? created);
  });

  router.put("/:templateId", async (req, res) => {
    requirePermission("templates:write")(req, res, () => {});
    if (res.headersSent) {
      return;
    }
    const parsed = TemplateUpdateRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(res, parsed.error.message, 422);
    }
    const existing = await getTemplate(ctx.db, req.companyId!, req.params.templateId);
    if (!existing) {
      return sendError(res, "Template not found.", 404);
    }
    const nextVersion = parsed.data.currentVersion ?? existing.currentVersion;
    const updated = await updateTemplate(ctx.db, {
      companyId: req.companyId!,
      id: req.params.templateId,
      slug: parsed.data.slug,
      name: parsed.data.name,
      description: parsed.data.description,
      currentVersion: parsed.data.currentVersion,
      status: parsed.data.status,
      visibility: parsed.data.visibility,
      variablesJson: parsed.data.variables ? JSON.stringify(parsed.data.variables) : undefined
    });
    if (!updated) {
      return sendError(res, "Template not found.", 404);
    }
    if (parsed.data.manifest) {
      const existingVersion = await getTemplateVersionByVersion(ctx.db, {
        companyId: req.companyId!,
        templateId: req.params.templateId,
        version: nextVersion
      });
      if (!existingVersion) {
        await createTemplateVersion(ctx.db, {
          companyId: req.companyId!,
          templateId: req.params.templateId,
          version: nextVersion,
          manifestJson: JSON.stringify(parsed.data.manifest)
        });
      }
    }
    const hydrated = await hydrateTemplate(ctx, req.companyId!, req.params.templateId);
    await appendAuditEvent(ctx.db, {
      companyId: req.companyId!,
      actorType: "human",
      eventType: "template.updated",
      entityType: "template",
      entityId: req.params.templateId,
      payload: hydrated ?? updated
    });
    return sendOk(res, hydrated ?? updated);
  });

  router.delete("/:templateId", async (req, res) => {
    requirePermission("templates:write")(req, res, () => {});
    if (res.headersSent) {
      return;
    }
    const deleted = await deleteTemplate(ctx.db, req.companyId!, req.params.templateId);
    if (!deleted) {
      return sendError(res, "Template not found.", 404);
    }
    await appendAuditEvent(ctx.db, {
      companyId: req.companyId!,
      actorType: "human",
      eventType: "template.deleted",
      entityType: "template",
      entityId: req.params.templateId,
      payload: { id: req.params.templateId }
    });
    return sendOk(res, { deleted: true });
  });

  router.post("/:templateId/preview", async (req, res) => {
    const parsed = TemplatePreviewRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(res, parsed.error.message, 422);
    }
    const hydrated = await hydrateTemplate(ctx, req.companyId!, req.params.templateId);
    if (!hydrated) {
      return sendError(res, "Template not found.", 404);
    }
    const preview = buildTemplatePreview({
      templateId: hydrated.id,
      templateVersion: hydrated.currentVersion,
      manifest: hydrated.manifest,
      variables: parsed.data.variables
    });
    await appendAuditEvent(ctx.db, {
      companyId: req.companyId!,
      actorType: "human",
      eventType: "template.previewed",
      entityType: "template",
      entityId: hydrated.id,
      payload: {
        mode: parsed.data.mode,
        targetCompanyName: parsed.data.targetCompanyName ?? null,
        summary: preview.summary
      }
    });
    return sendOk(res, preview);
  });

  router.post("/:templateId/apply", async (req, res) => {
    requirePermission("templates:write")(req, res, () => {});
    if (res.headersSent) {
      return;
    }
    const parsed = TemplateApplyRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(res, parsed.error.message, 422);
    }
    const hydrated = await hydrateTemplate(ctx, req.companyId!, req.params.templateId);
    if (!hydrated) {
      return sendError(res, "Template not found.", 404);
    }
    if (parsed.data.requestApproval) {
      const approvalId = await createApprovalRequest(ctx.db, {
        companyId: req.companyId!,
        requestedByAgentId: req.actor?.type === "agent" ? req.actor.id : null,
        action: "apply_template",
        payload: {
          templateId: hydrated.id,
          templateVersion: hydrated.currentVersion,
          variables: parsed.data.variables,
          mode: parsed.data.mode,
          targetCompanyName: parsed.data.targetCompanyName ?? null
        }
      });
      await appendAuditEvent(ctx.db, {
        companyId: req.companyId!,
        actorType: "human",
        eventType: "template.apply_queued",
        entityType: "template",
        entityId: hydrated.id,
        payload: { approvalId }
      });
      return sendOk(res, {
        applied: false,
        queuedForApproval: true,
        approvalId,
        summary: {
          projects: 0,
          goals: 0,
          agents: 0,
          issues: 0,
          plugins: 0,
          recurrence: 0
        },
        warnings: []
      });
    }
    const currentVersion = await getCurrentTemplateVersion(ctx.db, req.companyId!, hydrated.id);
    const applied = await applyTemplateManifest(ctx.db, {
      companyId: req.companyId!,
      templateId: hydrated.id,
      templateVersion: hydrated.currentVersion,
      templateVersionId: currentVersion?.id ?? null,
      manifest: hydrated.manifest,
      variables: parsed.data.variables
    });
    await appendAuditEvent(ctx.db, {
      companyId: req.companyId!,
      actorType: "human",
      eventType: "template.applied",
      entityType: "template",
      entityId: hydrated.id,
      payload: {
        mode: parsed.data.mode,
        targetCompanyName: parsed.data.targetCompanyName ?? null,
        summary: applied.summary
      }
    });
    return sendOk(res, applied);
  });

  router.post("/import", async (req, res) => {
    requirePermission("templates:write")(req, res, () => {});
    if (res.headersSent) {
      return;
    }
    const parsed = TemplateImportRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(res, parsed.error.message, 422);
    }
    const payload = parsed.data.template.template;
    const existing = await getTemplateBySlug(ctx.db, req.companyId!, payload.slug);
    if (existing && !parsed.data.overwrite) {
      return sendError(res, `Template slug '${payload.slug}' already exists. Use overwrite=true to replace.`, 409);
    }
    let targetId = existing?.id ?? null;
    if (!existing) {
      const created = await createTemplate(ctx.db, {
        companyId: req.companyId!,
        slug: payload.slug,
        name: payload.name,
        description: payload.description,
        currentVersion: payload.currentVersion,
        status: payload.status,
        visibility: payload.visibility,
        variablesJson: JSON.stringify(payload.variables)
      });
      targetId = created?.id ?? null;
    } else {
      await updateTemplate(ctx.db, {
        companyId: req.companyId!,
        id: existing.id,
        name: payload.name,
        description: payload.description,
        currentVersion: payload.currentVersion,
        status: payload.status,
        visibility: payload.visibility,
        variablesJson: JSON.stringify(payload.variables)
      });
      targetId = existing.id;
    }
    if (!targetId) {
      return sendError(res, "Template import failed.", 500);
    }
    const existingVersion = await getTemplateVersionByVersion(ctx.db, {
      companyId: req.companyId!,
      templateId: targetId,
      version: payload.currentVersion
    });
    if (!existingVersion) {
      await createTemplateVersion(ctx.db, {
        companyId: req.companyId!,
        templateId: targetId,
        version: payload.currentVersion,
        manifestJson: JSON.stringify(payload.manifest)
      });
    }
    await appendAuditEvent(ctx.db, {
      companyId: req.companyId!,
      actorType: "human",
      eventType: "template.imported",
      entityType: "template",
      entityId: targetId,
      payload: {
        slug: payload.slug,
        version: payload.currentVersion
      }
    });
    const hydrated = await hydrateTemplate(ctx, req.companyId!, targetId);
    return sendOk(res, hydrated);
  });

  router.get("/:templateId/export", async (req, res) => {
    const hydrated = await hydrateTemplate(ctx, req.companyId!, req.params.templateId);
    if (!hydrated) {
      return sendError(res, "Template not found.", 404);
    }
    await appendAuditEvent(ctx.db, {
      companyId: req.companyId!,
      actorType: "human",
      eventType: "template.exported",
      entityType: "template",
      entityId: hydrated.id,
      payload: {
        version: hydrated.currentVersion
      }
    });
    return sendOk(res, {
      schemaVersion: "bopo.template.v1",
      template: {
        slug: hydrated.slug,
        name: hydrated.name,
        description: hydrated.description ?? undefined,
        currentVersion: hydrated.currentVersion,
        status: hydrated.status,
        visibility: hydrated.visibility,
        variables: hydrated.variables,
        manifest: sanitizeManifestForExport(hydrated.manifest)
      }
    });
  });

  return router;
}

async function hydrateTemplate(ctx: AppContext, companyId: string, templateId: string) {
  const template = await getTemplate(ctx.db, companyId, templateId);
  if (!template) {
    return null;
  }
  const version =
    (await getTemplateVersionByVersion(ctx.db, {
      companyId,
      templateId,
      version: template.currentVersion
    })) ?? (await getCurrentTemplateVersion(ctx.db, companyId, templateId));
  const variables = safeParseJsonArray(template.variablesJson);
  const manifestRaw = safeParseJsonObject(version?.manifestJson ?? "{}");
  const parsedManifest = TemplateManifestSchema.safeParse(manifestRaw);
  const manifest = parsedManifest.success ? parsedManifest.data : TemplateManifestSchema.parse(TemplateManifestDefault);
  return {
    ...template,
    variables,
    manifest
  };
}

function safeParseJsonArray(value: string | null | undefined) {
  if (!value) {
    return [];
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed : [];
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

function sanitizeManifestForExport(manifest: Record<string, unknown>) {
  const root = structuredClone(manifest) as Record<string, unknown>;
  if (!Array.isArray(root.agents)) {
    return root;
  }
  root.agents = root.agents.map((agent) => {
    if (!agent || typeof agent !== "object") {
      return agent;
    }
    const agentRecord = { ...(agent as Record<string, unknown>) };
    const runtimeConfig = agentRecord.runtimeConfig;
    if (runtimeConfig && typeof runtimeConfig === "object" && runtimeConfig !== null) {
      const runtime = { ...(runtimeConfig as Record<string, unknown>) };
      if (runtime.runtimeEnv && typeof runtime.runtimeEnv === "object" && runtime.runtimeEnv !== null) {
        const env = runtime.runtimeEnv as Record<string, unknown>;
        runtime.runtimeEnv = Object.fromEntries(
          Object.entries(env).map(([key, value]) =>
            /token|secret|password|key/i.test(key) ? [key, "<redacted>"] : [key, value]
          )
        );
      }
      agentRecord.runtimeConfig = runtime;
    }
    return agentRecord;
  });
  return root;
}
