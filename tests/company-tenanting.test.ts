import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../apps/api/src/app";
import { ensureBuiltinPluginsRegistered } from "../apps/api/src/services/plugin-runtime";
import type { BopoDb } from "../packages/db/src/client";
import { bootstrapDatabase, createCompany } from "../packages/db/src/index";

describe("company tenant boundaries", { timeout: 30_000 }, () => {
  let db: BopoDb;
  let app: ReturnType<typeof createApp>;
  let tempDir: string;
  let companyAId: string;
  let companyBId: string;
  let client: { close?: () => Promise<void> };

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "bopodev-company-tenanting-"));
    const boot = await bootstrapDatabase(join(tempDir, "test.db"));
    db = boot.db;
    client = boot.client as { close?: () => Promise<void> };
    app = createApp({ db });

    const companyA = await createCompany(db, { name: "Tenant Alpha", mission: "Alpha company." });
    const companyB = await createCompany(db, { name: "Tenant Beta", mission: "Beta company." });
    companyAId = companyA.id;
    companyBId = companyB.id;
    await ensureBuiltinPluginsRegistered(db, [companyAId, companyBId]);
  });

  afterEach(async () => {
    await client.close?.();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("shows members only their accessible companies", async () => {
    const response = await request(app)
      .get("/companies")
      .set("x-actor-type", "member")
      .set("x-actor-id", "member-a")
      .set("x-actor-companies", companyAId);

    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(response.body.data).toHaveLength(1);
    expect(response.body.data[0].id).toBe(companyAId);
  });

  it("blocks cross-company company mutations for members", async () => {
    const response = await request(app)
      .put(`/companies/${companyBId}`)
      .set("x-actor-type", "member")
      .set("x-actor-id", "member-a")
      .set("x-actor-companies", companyAId)
      .set("x-actor-permissions", "companies:write")
      .send({ name: "Tenant Beta Updated" });

    expect(response.status).toBe(403);
    expect(String(response.body.error ?? "")).toContain("does not have access");
  });

  it("restricts company creation to board actors", async () => {
    const response = await request(app)
      .post("/companies")
      .set("x-actor-type", "member")
      .set("x-actor-id", "member-a")
      .set("x-actor-companies", companyAId)
      .send({ name: "Member Created Company" });

    expect(response.status).toBe(403);
    expect(String(response.body.error ?? "")).toContain("Board role required");
  });

  it("requires companies:write permission for member company mutations", async () => {
    const response = await request(app)
      .put(`/companies/${companyAId}`)
      .set("x-actor-type", "member")
      .set("x-actor-id", "member-a")
      .set("x-actor-companies", companyAId)
      .send({ mission: "Updated mission" });

    expect(response.status).toBe(403);
    expect(String(response.body.error ?? "")).toContain("Missing permission: companies:write");
  });

  it("allows same-company member updates with companies:write", async () => {
    const response = await request(app)
      .put(`/companies/${companyAId}`)
      .set("x-actor-type", "member")
      .set("x-actor-id", "member-a")
      .set("x-actor-companies", companyAId)
      .set("x-actor-permissions", "companies:write")
      .send({ mission: "Updated mission" });

    expect(response.status).toBe(200);
    expect(response.body.data.id).toBe(companyAId);
    expect(response.body.data.mission).toBe("Updated mission");
  });

  it("restricts global plugin deletion to board actors", async () => {
    const createResponse = await request(app)
      .post("/plugins/install-from-json")
      .set("x-company-id", companyAId)
      .send({
        manifestJson: JSON.stringify({
          id: "tenanting-delete-guard",
          version: "0.1.0",
          displayName: "Tenanting Delete Guard",
          description: "Used for tenanting deletion authz tests.",
          kind: "lifecycle",
          hooks: ["afterPersist"],
          capabilities: ["emit_audit"],
          runtime: {
            type: "prompt",
            entrypoint: "prompt:inline",
            timeoutMs: 5000,
            retryCount: 0,
            promptTemplate: "no-op"
          }
        }),
        install: false
      });
    expect(createResponse.status).toBe(200);

    const forbiddenDelete = await request(app)
      .delete("/plugins/tenanting-delete-guard")
      .set("x-company-id", companyAId)
      .set("x-actor-type", "member")
      .set("x-actor-id", "member-a")
      .set("x-actor-companies", companyAId);
    expect(forbiddenDelete.status).toBe(403);
    expect(String(forbiddenDelete.body.error ?? "")).toContain("Board role required");

    const boardDelete = await request(app).delete("/plugins/tenanting-delete-guard").set("x-company-id", companyAId);
    expect(boardDelete.status).toBe(200);
    expect(boardDelete.body.data.deleted).toBe(true);
  });
});
