import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../apps/api/src/app";
import type { BopoDb } from "../packages/db/src/client";
import { addIssueAttachment, bootstrapDatabase, createCompany, createIssue, createProject } from "../packages/db/src/index";

describe("issue attachment path guards", { timeout: 60_000 }, () => {
  let db: BopoDb;
  let app: ReturnType<typeof createApp>;
  let tempDir: string;
  let companyId: string;
  let client: { close?: () => Promise<void> };
  const originalInstanceRoot = process.env.BOPO_INSTANCE_ROOT;
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "bopodev-attachment-guards-"));
    process.env.BOPO_INSTANCE_ROOT = join(tempDir, "instances");
    process.env.NODE_ENV = "development";
    const boot = await bootstrapDatabase(join(tempDir, "test.db"));
    db = boot.db;
    client = boot.client as { close?: () => Promise<void> };
    app = createApp({ db });
    const company = await createCompany(db, { name: "Attachment Guard Co" });
    companyId = company.id;
  });

  afterEach(async () => {
    process.env.BOPO_INSTANCE_ROOT = originalInstanceRoot;
    process.env.NODE_ENV = originalNodeEnv;
    await client?.close?.();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("rejects download and delete for attachment rows with traversal relative paths", async () => {
    const project = await createProject(db, {
      companyId,
      name: "Attachment Guard Project"
    });
    const issue = await createIssue(db, {
      companyId,
      projectId: project.id,
      title: "Traversal guard"
    });
    const attachment = await addIssueAttachment(db, {
      companyId,
      issueId: issue.id,
      projectId: project.id,
      fileName: "bad.txt",
      mimeType: "text/plain",
      fileSizeBytes: 1,
      relativePath: "../outside/bad.txt",
      uploadedByActorType: "human"
    });

    const downloadResponse = await request(app)
      .get(`/issues/${issue.id}/attachments/${attachment.id}/download`)
      .set("x-company-id", companyId);
    expect(downloadResponse.status).toBe(422);
    expect(String(downloadResponse.body.error ?? "")).toContain("Invalid attachment path");

    const deleteResponse = await request(app)
      .delete(`/issues/${issue.id}/attachments/${attachment.id}`)
      .set("x-company-id", companyId);
    expect(deleteResponse.status).toBe(422);
    expect(String(deleteResponse.body.error ?? "")).toContain("Invalid attachment path");
  });
});
