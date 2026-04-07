import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../apps/api/src/app";
import type { BopoDb } from "../packages/db/src/client";
import { bootstrapDatabase, createCompany, createIssue, createProject } from "../packages/db/src/index";

describe("response contract normalization", { timeout: 30_000 }, () => {
  let db: BopoDb;
  let app: ReturnType<typeof createApp>;
  let tempDir: string;
  let companyId: string;
  let client: { close?: () => Promise<void> };

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "bopodev-response-contracts-"));
    const boot = await bootstrapDatabase(join(tempDir, "test.db"));
    db = boot.db;
    client = boot.client as { close?: () => Promise<void> };
    app = createApp({ db });

    const company = await createCompany(db, { name: "Contract Co" });
    companyId = company.id;
    const project = await createProject(db, {
      companyId,
      name: "Project One"
    });
    await createIssue(db, {
      companyId,
      projectId: project!.id,
      title: "Normalize response dates"
    });
  });

  afterEach(async () => {
    await client?.close?.();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("returns contract-safe company payloads", async () => {
    const response = await request(app).get("/companies");

    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(Array.isArray(response.body.data)).toBe(true);
    expect(response.body.data[0]).toEqual(
      expect.objectContaining({
        id: companyId,
        createdAt: expect.any(String)
      })
    );
  });

  it("returns contract-safe issue payloads", async () => {
    const response = await request(app).get("/issues").set("x-company-id", companyId);

    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(Array.isArray(response.body.data)).toBe(true);
    expect(response.body.data[0]).toEqual(
      expect.objectContaining({
        companyId,
        goalIds: [],
        knowledgePaths: [],
        createdAt: expect.any(String),
        updatedAt: expect.any(String)
      })
    );
  });
});
