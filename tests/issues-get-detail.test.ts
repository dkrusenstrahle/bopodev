import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../apps/api/src/app";
import type { BopoDb } from "../packages/db/src/client";
import {
  addIssueAttachment,
  bootstrapDatabase,
  createCompany,
  createIssue,
  createProject
} from "../packages/db/src/index";

describe("GET /issues/:issueId", { timeout: 30_000 }, () => {
  let db: BopoDb;
  let app: ReturnType<typeof createApp>;
  let tempDir: string;
  let companyId: string;
  let client: { close?: () => Promise<void> };
  const originalInstanceRoot = process.env.BOPO_INSTANCE_ROOT;
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "bopodev-issue-detail-"));
    process.env.BOPO_INSTANCE_ROOT = join(tempDir, "instances");
    process.env.NODE_ENV = "development";
    const boot = await bootstrapDatabase(join(tempDir, "test.db"));
    db = boot.db;
    client = boot.client as { close?: () => Promise<void> };
    app = createApp({ db });
    const company = await createCompany(db, { name: "Detail Co" });
    companyId = company.id;
  });

  afterEach(async () => {
    process.env.BOPO_INSTANCE_ROOT = originalInstanceRoot;
    process.env.NODE_ENV = originalNodeEnv;
    await client?.close?.();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("returns 404 for missing issue", async () => {
    const res = await request(app).get("/issues/does-not-exist").set("x-company-id", companyId);
    expect(res.status).toBe(404);
  });

  it("returns issue with empty attachments array", async () => {
    const project = await createProject(db, { companyId, name: "P1" });
    const issue = await createIssue(db, {
      companyId,
      projectId: project.id,
      title: "No attachments",
      body: "Full description here"
    });
    const res = await request(app).get(`/issues/${issue.id}`).set("x-company-id", companyId);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data).toMatchObject({
      id: issue.id,
      title: "No attachments",
      body: expect.stringContaining("Full description"),
      labels: [],
      tags: [],
      attachments: []
    });
  });

  it("includes attachment metadata and downloadPath", async () => {
    const project = await createProject(db, { companyId, name: "P2" });
    const issue = await createIssue(db, {
      companyId,
      projectId: project.id,
      title: "With attachment"
    });
    const att = await addIssueAttachment(db, {
      companyId,
      issueId: issue.id,
      projectId: project.id,
      fileName: "note.md",
      mimeType: "text/markdown",
      fileSizeBytes: 4,
      relativePath: join(".bopo", "issues", issue.id, "attachments", "x-note.md"),
      uploadedByActorType: "human"
    });
    const res = await request(app).get(`/issues/${issue.id}`).set("x-company-id", companyId);
    expect(res.status).toBe(200);
    expect(res.body.data.attachments).toHaveLength(1);
    expect(res.body.data.attachments[0]).toMatchObject({
      id: att.id,
      fileName: "note.md",
      downloadPath: `/issues/${issue.id}/attachments/${att.id}/download`
    });
  });
});
