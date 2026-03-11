import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../apps/api/src/app";
import { runHeartbeatForAgent } from "../apps/api/src/services/heartbeat-service";
import { ensureBuiltinPluginsRegistered } from "../apps/api/src/services/plugin-runtime";
import type { BopoDb } from "../packages/db/src/client";
import { bootstrapDatabase, createAgent, createCompany, createIssue, createProject } from "../packages/db/src/index";

describe("plugin system", { timeout: 30_000 }, () => {
  let db: BopoDb;
  let app: ReturnType<typeof createApp>;
  let tempDir: string;
  let companyId: string;
  let client: { close?: () => Promise<void> };
  let originalFlag: string | undefined;

  beforeEach(async () => {
    originalFlag = process.env.BOPO_PLUGIN_SYSTEM_ENABLED;
    process.env.BOPO_PLUGIN_SYSTEM_ENABLED = "true";
    tempDir = await mkdtemp(join(tmpdir(), "bopodev-plugin-test-"));
    const boot = await bootstrapDatabase(join(tempDir, "test.db"));
    db = boot.db;
    client = boot.client as { close?: () => Promise<void> };
    app = createApp({ db });
    const company = await createCompany(db, { name: "Plugins Co", mission: "Test plugins." });
    companyId = company.id;
    await ensureBuiltinPluginsRegistered(db, [companyId]);
  });

  afterEach(async () => {
    if (originalFlag === undefined) {
      delete process.env.BOPO_PLUGIN_SYSTEM_ENABLED;
    } else {
      process.env.BOPO_PLUGIN_SYSTEM_ENABLED = originalFlag;
    }
    await client.close?.();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("lists plugins and creates approval for risky capability grants", async () => {
    const listResponse = await request(app).get("/plugins").set("x-company-id", companyId);
    expect(listResponse.status).toBe(200);
    expect(Array.isArray(listResponse.body.data)).toBe(true);
    expect(listResponse.body.data.some((row: { id: string }) => row.id === "trace-exporter")).toBe(true);
    expect(listResponse.body.data.some((row: { id: string }) => row.id === "heartbeat-tagger")).toBe(true);

    const installResponse = await request(app)
      .post("/plugins/heartbeat-tagger/install")
      .set("x-company-id", companyId)
      .send({});
    expect(installResponse.status).toBe(200);
    expect(installResponse.body.data.installed).toBe(true);
    expect(installResponse.body.data.enabled).toBe(false);

    const configureResponse = await request(app)
      .put("/plugins/queue-publisher")
      .set("x-company-id", companyId)
      .send({
        enabled: true,
        grantedCapabilities: ["network", "queue_publish"],
        requestApproval: true
      });
    expect(configureResponse.status).toBe(200);
    expect(typeof configureResponse.body.data.approvalId).toBe("string");
    expect(configureResponse.body.data.status).toBe("pending");
  });

  it("records plugin runs during heartbeat execution", async () => {
    const project = await createProject(db, {
      companyId,
      name: "Plugin execution project",
      workspaceLocalPath: tempDir
    });
    const agent = await createAgent(db, {
      companyId,
      role: "Worker",
      name: "Plugin runner",
      providerType: "shell",
      heartbeatCron: "* * * * *",
      monthlyBudgetUsd: "20.0000",
      runtimeCommand: "echo",
      runtimeArgsJson: '["{\\"summary\\":\\"plugin-run\\",\\"tokenInput\\":2,\\"tokenOutput\\":1,\\"usdCost\\":0.001}"]',
      runtimeCwd: tempDir
    });
    await createIssue(db, {
      companyId,
      projectId: project.id,
      title: "Execute plugin hooks",
      assigneeAgentId: agent.id
    });

    const runId = await runHeartbeatForAgent(db, companyId, agent.id, { trigger: "manual" });
    expect(runId).toBeTruthy();

    const pluginRunsResponse = await request(app)
      .get(`/observability/plugins/runs?runId=${encodeURIComponent(runId!)}`)
      .set("x-company-id", companyId);
    expect(pluginRunsResponse.status).toBe(200);
    expect(Array.isArray(pluginRunsResponse.body.data)).toBe(true);
    expect(pluginRunsResponse.body.data.length).toBeGreaterThan(0);
    expect(
      pluginRunsResponse.body.data.some(
        (row: { pluginId: string; hook: string }) => row.pluginId === "trace-exporter" && row.hook === "afterAdapterExecute"
      )
    ).toBe(true);
  });
});
