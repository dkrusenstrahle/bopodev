import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../apps/api/src/app";
import { ensureCompanyBuiltinTemplateDefaults } from "../apps/api/src/services/template-catalog";
import type { BopoDb } from "../packages/db/src/client";
import { bootstrapDatabase, createCompany, listApprovalRequests, listIssues, listProjects } from "../packages/db/src/index";

describe("templates routes", { timeout: 30_000 }, () => {
  let db: BopoDb;
  let app: ReturnType<typeof createApp>;
  let tempDir: string;
  let companyId: string;
  let client: { close?: () => Promise<void> };

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "bopodev-templates-test-"));
    const boot = await bootstrapDatabase(join(tempDir, "test.db"));
    db = boot.db;
    client = boot.client as { close?: () => Promise<void> };
    app = createApp({ db });
    const company = await createCompany(db, { name: "Templates Co", mission: "Template route tests." });
    companyId = company.id;
  }, 30_000);

  afterEach(async () => {
    await client.close?.();
    await rm(tempDir, { recursive: true, force: true });
  }, 30_000);

  it("supports template CRUD, preview/apply, import/export", async () => {
    const manifest = {
      company: { mission: "Grow {{brandName}} with AI agents." },
      projects: [{ key: "marketing", name: "Marketing Engine", description: "Content and growth tasks" }],
      issues: [{ title: "Draft weekly content plan", projectKey: "marketing", labels: ["marketing"] }]
    };
    const createResponse = await request(app).post("/templates").set("x-company-id", companyId).send({
      slug: "marketing-content-engine",
      name: "Marketing Content Engine",
      currentVersion: "1.0.0",
      variables: [{ key: "brandName", type: "string", required: true }],
      manifest
    });
    expect(createResponse.status).toBe(200);
    const templateId = createResponse.body.data.id as string;
    expect(templateId).toBeTruthy();

    const listResponse = await request(app).get("/templates").set("x-company-id", companyId);
    expect(listResponse.status).toBe(200);
    expect(listResponse.body.data.some((entry: { id: string }) => entry.id === templateId)).toBe(true);

    const previewResponse = await request(app)
      .post(`/templates/${templateId}/preview`)
      .set("x-company-id", companyId)
      .send({ variables: { brandName: "Acme" } });
    expect(previewResponse.status).toBe(200);
    expect(previewResponse.body.data.summary.projects).toBe(1);
    expect(previewResponse.body.data.summary.issues).toBe(1);

    const applyResponse = await request(app)
      .post(`/templates/${templateId}/apply`)
      .set("x-company-id", companyId)
      .send({ requestApproval: false, variables: { brandName: "Acme" } });
    expect(applyResponse.status).toBe(200);
    expect(applyResponse.body.data.applied).toBe(true);
    expect(typeof applyResponse.body.data.installId).toBe("string");

    const projects = await listProjects(db, companyId);
    const issues = await listIssues(db, companyId);
    expect(projects.some((project) => project.name === "Marketing Engine")).toBe(true);
    expect(issues.some((issue) => issue.title === "Draft weekly content plan")).toBe(true);

    const queueResponse = await request(app)
      .post(`/templates/${templateId}/apply`)
      .set("x-company-id", companyId)
      .send({ requestApproval: true });
    expect(queueResponse.status).toBe(200);
    expect(queueResponse.body.data.queuedForApproval).toBe(true);
    expect(typeof queueResponse.body.data.approvalId).toBe("string");
    const approvals = await listApprovalRequests(db, companyId);
    expect(approvals.some((approval) => approval.action === "apply_template")).toBe(true);

    const exportResponse = await request(app).get(`/templates/${templateId}/export`).set("x-company-id", companyId);
    expect(exportResponse.status).toBe(200);
    expect(exportResponse.body.data.schemaVersion).toBe("bopo.template.v1");

    const importResponse = await request(app).post("/templates/import").set("x-company-id", companyId).send({
      template: exportResponse.body.data,
      overwrite: true
    });
    expect(importResponse.status).toBe(200);
    expect(importResponse.body.data.slug).toBe("marketing-content-engine");

    const updateResponse = await request(app)
      .put(`/templates/${templateId}`)
      .set("x-company-id", companyId)
      .send({ status: "published", description: "Published template." });
    expect(updateResponse.status).toBe(200);
    expect(updateResponse.body.data.status).toBe("published");

    const deleteResponse = await request(app).delete(`/templates/${templateId}`).set("x-company-id", companyId);
    expect(deleteResponse.status).toBe(200);
    expect(deleteResponse.body.data.deleted).toBe(true);
  });

  it("seeds default built-in templates for a company", async () => {
    await ensureCompanyBuiltinTemplateDefaults(db, companyId);
    const listTemplatesResponse = await request(app).get("/templates").set("x-company-id", companyId);
    expect(listTemplatesResponse.status).toBe(200);
    const slugs = new Set(
      (listTemplatesResponse.body.data as Array<{ slug: string }>).map((template) => template.slug)
    );
    expect(slugs.has("founder-startup-basic")).toBe(true);
    expect(slugs.has("marketing-content-engine")).toBe(true);
  });
});
