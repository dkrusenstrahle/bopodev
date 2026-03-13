import { Router } from "express";
import { z } from "zod";
import { createCompany, deleteCompany, listCompanies, updateCompany } from "bopodev-db";
import type { AppContext } from "../context";
import { sendError, sendOk } from "../http";
import { ensureCompanyModelPricingDefaults } from "../services/model-pricing";
import { ensureCompanyBuiltinPluginDefaults } from "../services/plugin-runtime";
import { ensureCompanyBuiltinTemplateDefaults } from "../services/template-catalog";

const createCompanySchema = z.object({
  name: z.string().min(1),
  mission: z.string().optional()
});

const updateCompanySchema = z
  .object({
    name: z.string().min(1).optional(),
    mission: z.string().optional()
  })
  .refine((payload) => Object.keys(payload).length > 0, "At least one field must be provided.");

export function createCompaniesRouter(ctx: AppContext) {
  const router = Router();

  router.get("/", async (_req, res) => {
    const companies = await listCompanies(ctx.db);
    return sendOk(res, companies);
  });

  router.post("/", async (req, res) => {
    const parsed = createCompanySchema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(res, parsed.error.message, 422);
    }
    const company = await createCompany(ctx.db, parsed.data);
    await ensureCompanyBuiltinPluginDefaults(ctx.db, company.id);
    await ensureCompanyBuiltinTemplateDefaults(ctx.db, company.id);
    await ensureCompanyModelPricingDefaults(ctx.db, company.id);
    return sendOk(res, company);
  });

  router.put("/:companyId", async (req, res) => {
    const parsed = updateCompanySchema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(res, parsed.error.message, 422);
    }

    const company = await updateCompany(ctx.db, { id: req.params.companyId, ...parsed.data });
    if (!company) {
      return sendError(res, "Company not found.", 404);
    }
    return sendOk(res, company);
  });

  router.delete("/:companyId", async (req, res) => {
    const deleted = await deleteCompany(ctx.db, req.params.companyId);
    if (!deleted) {
      return sendError(res, "Company not found.", 404);
    }
    return sendOk(res, { deleted: true });
  });

  return router;
}
