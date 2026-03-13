import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../apps/api/src/app";
import type { BopoDb } from "../packages/db/src/client";
import { bootstrapDatabase, createCompany, createProject } from "../packages/db/src/index";

describe("workspace path policy", () => {
  let db: BopoDb;
  let app: ReturnType<typeof createApp>;
  let tempDir: string;
  let companyId: string;
  let client: { close?: () => Promise<void> };
  let projectId: string;
  const originalInstanceRoot = process.env.BOPO_INSTANCE_ROOT;
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "bopodev-workspace-policy-"));
    process.env.BOPO_INSTANCE_ROOT = join(tempDir, "instances");
    process.env.NODE_ENV = "development";
    const boot = await bootstrapDatabase(join(tempDir, "test.db"));
    db = boot.db;
    client = boot.client as { close?: () => Promise<void> };
    app = createApp({ db });
    const company = await createCompany(db, { name: "Acme AI", mission: "Ship safer runtime paths." });
    companyId = company.id;
    const project = await createProject(db, { companyId, name: "Workspace policy project" });
    projectId = project.id;
  });

  afterEach(async () => {
    process.env.BOPO_INSTANCE_ROOT = originalInstanceRoot;
    process.env.NODE_ENV = originalNodeEnv;
    await client.close?.();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("rejects project workspace cwd outside managed company root", async () => {
    const response = await request(app).post(`/projects/${projectId}/workspaces`).set("x-company-id", companyId).send({
      name: "Unsafe workspace",
      cwd: join(tmpdir(), "outside-project-workspace"),
      isPrimary: true
    });

    expect(response.status).toBe(422);
    expect(String(response.body.error ?? "")).toContain("must be inside");
  });

  it("rejects relative runtimeCwd during agent creation", async () => {
    const response = await request(app).post("/agents").set("x-company-id", companyId).send({
      role: "Engineer",
      name: "Relative runtime",
      providerType: "shell",
      heartbeatCron: "*/5 * * * *",
      monthlyBudgetUsd: 10,
      canHireAgents: false,
      requestApproval: false,
      runtimeCommand: "echo",
      runtimeCwd: "relative/runtime",
      runtimeArgs: ['{"summary":"noop","tokenInput":0,"tokenOutput":0,"usdCost":0}']
    });

    expect(response.status).toBe(422);
    expect(String(response.body.error ?? "")).toContain("Expected absolute path input");
  });

  it("rejects runtime preflight when runtimeCwd is outside managed root", async () => {
    const response = await request(app).post("/agents/runtime-preflight").set("x-company-id", companyId).send({
      providerType: "codex",
      runtimeConfig: {
        runtimeCommand: process.execPath,
        runtimeArgs: ["-e", "console.log('ok')"],
        runtimeCwd: join(tmpdir(), "outside-runtime-preflight")
      }
    });

    expect(response.status).toBe(422);
    expect(String(response.body.error ?? "")).toContain("must be inside");
  });
});
