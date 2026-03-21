import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../apps/api/src/app";
import { runHeartbeatForAgent } from "../apps/api/src/services/heartbeat-service";
import type { BopoDb } from "../packages/db/src/client";
import {
  bootstrapDatabase,
  createAgent,
  createCompany,
  createIssue,
  createProject,
  createProjectWorkspace,
  listHeartbeatRuns
} from "../packages/db/src/index";

describe("heartbeat workspace resolution", { timeout: 90_000 }, () => {
  let db: BopoDb;
  let app: ReturnType<typeof createApp>;
  let tempDir: string;
  let companyId: string;
  let client: { close?: () => Promise<void> };
  const previousIsolationFlag = process.env.BOPO_ENABLE_GIT_WORKTREE_ISOLATION;
  const previousInstanceRoot = process.env.BOPO_INSTANCE_ROOT;
  const previousNodeEnv = process.env.NODE_ENV;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "bopodev-heartbeat-workspace-"));
    process.env.BOPO_INSTANCE_ROOT = join(tempDir, "instances");
    process.env.NODE_ENV = "development";
    process.env.BOPO_ENABLE_GIT_WORKTREE_ISOLATION = "false";
    const boot = await bootstrapDatabase(join(tempDir, "test.db"));
    db = boot.db;
    client = boot.client as { close?: () => Promise<void> };
    app = createApp({ db });
    const company = await createCompany(db, { name: "Workspace Warning Co" });
    companyId = company.id;
  });

  afterEach(async () => {
    process.env.BOPO_ENABLE_GIT_WORKTREE_ISOLATION = previousIsolationFlag;
    process.env.BOPO_INSTANCE_ROOT = previousInstanceRoot;
    process.env.NODE_ENV = previousNodeEnv;
    await client?.close?.();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("emits warning when isolated git worktree policy is configured but disabled", async () => {
    const project = await createProject(db, {
      companyId,
      name: "Isolated Warning Project",
      executionWorkspacePolicy: {
        mode: "isolated",
        strategy: {
          type: "git_worktree",
          branchPrefix: "bopo"
        }
      }
    });
    expect(project).toBeTruthy();
    const projectId = project!.id;
    const projectWorkspace = join(tempDir, "instances", "workspaces", companyId, "projects", projectId, "primary");
    await createProjectWorkspace(db, {
      companyId,
      projectId,
      name: "Primary workspace",
      cwd: projectWorkspace,
      isPrimary: true
    });
    const agentRuntimeCwd = join(tempDir, "instances", "workspaces", companyId, "agents", "runtime");
    const agent = await createAgent(db, {
      companyId,
      role: "Engineer",
      name: "Workspace Warning Agent",
      providerType: "shell",
      heartbeatCron: "*/5 * * * *",
      monthlyBudgetUsd: "10.0000",
      runtimeCwd: agentRuntimeCwd,
      initialState: {
        runtime: {
          command: "echo",
          args: ['{"summary":"workspace-warning","tokenInput":1,"tokenOutput":1,"usdCost":0.000001}']
        }
      }
    });
    await createIssue(db, {
      companyId,
      projectId,
      title: "Trigger isolated warning",
      assigneeAgentId: agent.id
    });

    const runId = await runHeartbeatForAgent(db, companyId, agent.id);
    expect(runId).toBeTruthy();
    const runs = await listHeartbeatRuns(db, companyId);
    const latest = runs.find((run) => run.id === runId);
    expect(latest?.status).toBe("completed");

    const logsResponse = await request(app).get("/observability/logs").set("x-company-id", companyId);
    expect(logsResponse.status).toBe(200);
    const warningEvent = (logsResponse.body.data as Array<{ eventType: string; payload?: Record<string, unknown> }>).find(
      (event) => event.eventType === "heartbeat.workspace_resolution_warning"
    );
    expect(warningEvent).toBeDefined();
    const warnings = (warningEvent?.payload?.warnings ?? []) as string[];
    expect(warnings.some((entry) => entry.includes("BOPO_ENABLE_GIT_WORKTREE_ISOLATION is disabled"))).toBe(true);
  });
});
