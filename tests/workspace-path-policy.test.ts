import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../apps/api/src/app";
import { runHeartbeatForAgent } from "../apps/api/src/services/heartbeat-service";
import type { BopoDb } from "../packages/db/src/client";
import { bootstrapDatabase, createAgent, createCompany, createIssue, createProject, listIssueComments } from "../packages/db/src/index";

describe("workspace path policy", { timeout: 60_000 }, () => {
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
    await client?.close?.();
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

  it("rejects workspace cwd updates outside managed root", async () => {
    const createWorkspaceResponse = await request(app)
      .post(`/projects/${projectId}/workspaces`)
      .set("x-company-id", companyId)
      .send({
        name: "Safe workspace",
        cwd: join(tempDir, "instances", "workspaces", companyId, "projects", projectId, "safe"),
        isPrimary: true
      });
    expect(createWorkspaceResponse.status).toBe(200);
    const workspaceId = createWorkspaceResponse.body.data.id as string;

    const updateResponse = await request(app)
      .put(`/projects/${projectId}/workspaces/${workspaceId}`)
      .set("x-company-id", companyId)
      .send({
        cwd: join(tmpdir(), "outside-update-workspace")
      });

    expect(updateResponse.status).toBe(422);
    expect(String(updateResponse.body.error ?? "")).toContain("must be inside");
  });

  it("rejects runtimeCwd updates outside managed root", async () => {
    const createAgentResponse = await request(app).post("/agents").set("x-company-id", companyId).send({
      role: "Engineer",
      name: "Safe runtime",
      providerType: "shell",
      heartbeatCron: "*/5 * * * *",
      monthlyBudgetUsd: 10,
      canHireAgents: false,
      requestApproval: false,
      runtimeCommand: "echo",
      runtimeCwd: join(tempDir, "instances", "workspaces", companyId, "agents", "safe"),
      runtimeArgs: ['{"summary":"noop","tokenInput":0,"tokenOutput":0,"usdCost":0}']
    });
    expect(createAgentResponse.status).toBe(200);
    const agentId = createAgentResponse.body.data.id as string;

    const updateResponse = await request(app).put(`/agents/${agentId}`).set("x-company-id", companyId).send({
      runtimeCwd: join(tmpdir(), "outside-update-runtime")
    });
    expect(updateResponse.status).toBe(422);
    expect(String(updateResponse.body.error ?? "")).toContain("must be inside");
  });

  it("records artifact labels with full project issue workspace-relative paths", async () => {
    const workspaceCwd = join(tempDir, "instances", "workspaces", companyId, "projects", projectId, "primary");
    const workspaceResponse = await request(app).post(`/projects/${projectId}/workspaces`).set("x-company-id", companyId).send({
      name: "Primary workspace for issue runtime",
      cwd: workspaceCwd,
      isPrimary: true
    });
    expect(workspaceResponse.status).toBe(200);

    const agent = await createAgent(db, {
      companyId,
      role: "Engineer",
      name: "Issue Path Worker",
      providerType: "shell",
      heartbeatCron: "*/5 * * * *",
      monthlyBudgetUsd: "10.0000",
      initialState: {
        runtime: {
          command: "echo",
          args: [
            '{"employee_comment":"done","results":["ok"],"errors":[],"artifacts":[{"kind":"directory","path":"output"}],"tokenInput":0,"tokenOutput":0,"usdCost":0}'
          ]
        }
      }
    });
    const issue = await createIssue(db, {
      companyId,
      projectId,
      title: "Check runtime issue cwd placement",
      assigneeAgentId: agent.id
    });

    const runId = await runHeartbeatForAgent(db, companyId, agent.id, { trigger: "manual" });
    expect(runId).toBeTruthy();

    const comments = await listIssueComments(db, companyId, issue.id);
    const summaryComment = comments.find((comment) => comment.runId === runId && comment.authorType === "agent");
    expect(summaryComment?.body ?? "").toContain(`projects/${projectId}/`);
    expect(summaryComment?.body ?? "").toContain(`/issues/${issue.id}/output`);
  });
});
