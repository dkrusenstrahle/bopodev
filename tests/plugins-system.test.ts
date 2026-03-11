import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../apps/api/src/app";
import { runHeartbeatForAgent } from "../apps/api/src/services/heartbeat-service";
import { ensureBuiltinPluginsRegistered } from "../apps/api/src/services/plugin-runtime";
import type { BopoDb } from "../packages/db/src/client";
import { bootstrapDatabase, createAgent, createCompany, createIssue, createProject } from "../packages/db/src/index";

describe("plugin system", { timeout: 30_000, hookTimeout: 30_000 }, () => {
  let db: BopoDb;
  let app: ReturnType<typeof createApp>;
  let tempDir: string;
  let companyId: string;
  let client: { close?: () => Promise<void> };
  let originalEnabledFlag: string | undefined;
  let originalDisabledFlag: string | undefined;
  let originalManifestsDir: string | undefined;

  beforeEach(async () => {
    originalEnabledFlag = process.env.BOPO_PLUGIN_SYSTEM_ENABLED;
    originalDisabledFlag = process.env.BOPO_PLUGIN_SYSTEM_DISABLED;
    originalManifestsDir = process.env.BOPO_PLUGIN_MANIFESTS_DIR;
    delete process.env.BOPO_PLUGIN_SYSTEM_ENABLED;
    delete process.env.BOPO_PLUGIN_SYSTEM_DISABLED;
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
    if (originalEnabledFlag === undefined) {
      delete process.env.BOPO_PLUGIN_SYSTEM_ENABLED;
    } else {
      process.env.BOPO_PLUGIN_SYSTEM_ENABLED = originalEnabledFlag;
    }
    if (originalDisabledFlag === undefined) {
      delete process.env.BOPO_PLUGIN_SYSTEM_DISABLED;
    } else {
      process.env.BOPO_PLUGIN_SYSTEM_DISABLED = originalDisabledFlag;
    }
    if (originalManifestsDir === undefined) {
      delete process.env.BOPO_PLUGIN_MANIFESTS_DIR;
    } else {
      process.env.BOPO_PLUGIN_MANIFESTS_DIR = originalManifestsDir;
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

  it("loads filesystem plugin manifests and supports install + enable flow", async () => {
    const manifestsRoot = join(tempDir, "plugins");
    const pluginDir = join(manifestsRoot, "file-demo-plugin");
    await mkdir(pluginDir, { recursive: true });
    await writeFile(
      join(pluginDir, "plugin.json"),
      JSON.stringify(
        {
          id: "file-demo-plugin",
          version: "0.1.0",
          displayName: "File Demo Plugin",
          description: "Loaded from filesystem manifest.",
          kind: "lifecycle",
          hooks: ["afterPersist"],
          capabilities: ["emit_audit"],
          runtime: {
            type: "builtin",
            entrypoint: "builtin:file-demo-plugin",
            timeoutMs: 5000,
            retryCount: 0
          }
        },
        null,
        2
      )
    );
    process.env.BOPO_PLUGIN_MANIFESTS_DIR = manifestsRoot;
    await ensureBuiltinPluginsRegistered(db, [companyId]);

    const listResponse = await request(app).get("/plugins").set("x-company-id", companyId);
    expect(listResponse.status).toBe(200);
    const pluginRow = listResponse.body.data.find((row: { id: string }) => row.id === "file-demo-plugin");
    expect(pluginRow).toBeTruthy();
    expect(pluginRow.description).toBe("Loaded from filesystem manifest.");

    const installResponse = await request(app)
      .post("/plugins/file-demo-plugin/install")
      .set("x-company-id", companyId)
      .send({});
    expect(installResponse.status).toBe(200);

    const enableResponse = await request(app)
      .put("/plugins/file-demo-plugin")
      .set("x-company-id", companyId)
      .send({
        enabled: true,
        priority: 110,
        grantedCapabilities: ["emit_audit"],
        config: {},
        requestApproval: false
      });
    expect(enableResponse.status).toBe(200);
    expect(enableResponse.body.data.ok).toBe(true);
  });

  it("ignores invalid filesystem manifests without failing registration", async () => {
    const manifestsRoot = join(tempDir, "plugins");
    const pluginDir = join(manifestsRoot, "broken-plugin");
    await mkdir(pluginDir, { recursive: true });
    await writeFile(join(pluginDir, "plugin.json"), JSON.stringify({ id: "broken-plugin" }, null, 2));
    process.env.BOPO_PLUGIN_MANIFESTS_DIR = manifestsRoot;

    await expect(ensureBuiltinPluginsRegistered(db, [companyId])).resolves.toBeUndefined();

    const listResponse = await request(app).get("/plugins").set("x-company-id", companyId);
    expect(listResponse.status).toBe(200);
    expect(listResponse.body.data.some((row: { id: string }) => row.id === "broken-plugin")).toBe(false);
    expect(listResponse.body.data.some((row: { id: string }) => row.id === "trace-exporter")).toBe(true);
  });

  it("creates plugin from manifest JSON and installs it", async () => {
    const manifestsRoot = join(tempDir, "plugins");
    process.env.BOPO_PLUGIN_MANIFESTS_DIR = manifestsRoot;
    const response = await request(app)
      .post("/plugins/install-from-json")
      .set("x-company-id", companyId)
      .send({
        manifestJson: JSON.stringify({
          id: "json-created-plugin",
          version: "0.1.0",
          displayName: "JSON Created Plugin",
          description: "Created from textarea payload.",
          kind: "lifecycle",
          hooks: ["afterPersist"],
          capabilities: ["emit_audit"],
          runtime: {
            type: "builtin",
            entrypoint: "builtin:json-created-plugin",
            timeoutMs: 5000,
            retryCount: 0
          }
        }),
        install: true
      });
    expect(response.status).toBe(200);
    expect(response.body.data.pluginId).toBe("json-created-plugin");
    expect(response.body.data.installed).toBe(true);

    const listResponse = await request(app).get("/plugins").set("x-company-id", companyId);
    expect(listResponse.status).toBe(200);
    const createdPlugin = listResponse.body.data.find((row: { id: string }) => row.id === "json-created-plugin");
    expect(createdPlugin).toBeTruthy();
    expect(createdPlugin.companyConfig).toBeTruthy();
    expect(createdPlugin.companyConfig.enabled).toBe(false);
  });

  it("applies prompt plugin patch on beforeAdapterExecute", async () => {
    const response = await request(app)
      .post("/plugins/install-from-json")
      .set("x-company-id", companyId)
      .send({
        manifestJson: JSON.stringify({
          id: "prompt-context-plugin",
          version: "0.1.0",
          displayName: "Prompt Context Plugin",
          description: "Appends prompt context before adapter execution.",
          kind: "lifecycle",
          hooks: ["beforeAdapterExecute"],
          capabilities: ["emit_audit"],
          runtime: {
            type: "prompt",
            entrypoint: "prompt:inline",
            timeoutMs: 5000,
            retryCount: 0,
            promptTemplate: "Injected context for run {{runId}}"
          }
        }),
        install: true
      });
    expect(response.status).toBe(200);

    await request(app)
      .put("/plugins/prompt-context-plugin")
      .set("x-company-id", companyId)
      .send({
        enabled: true,
        grantedCapabilities: [],
        config: {},
        requestApproval: false
      });

    const project = await createProject(db, {
      companyId,
      name: "Prompt plugin project",
      workspaceLocalPath: tempDir
    });
    const agent = await createAgent(db, {
      companyId,
      role: "Worker",
      name: "Prompt plugin agent",
      providerType: "shell",
      heartbeatCron: "* * * * *",
      monthlyBudgetUsd: "20.0000",
      runtimeCommand: "echo",
      runtimeArgsJson: '["{\\"summary\\":\\"prompt-plugin\\",\\"tokenInput\\":1,\\"tokenOutput\\":1,\\"usdCost\\":0.001}"]',
      runtimeCwd: tempDir
    });
    await createIssue(db, {
      companyId,
      projectId: project.id,
      title: "Execute prompt plugin",
      assigneeAgentId: agent.id
    });
    const runId = await runHeartbeatForAgent(db, companyId, agent.id, { trigger: "manual" });
    const pluginRunsResponse = await request(app)
      .get(`/plugins/runs?pluginId=prompt-context-plugin&runId=${encodeURIComponent(runId!)}`)
      .set("x-company-id", companyId);
    expect(pluginRunsResponse.status).toBe(200);
    expect(pluginRunsResponse.body.data.some((row: { status: string }) => row.status === "ok")).toBe(true);
    expect(
      pluginRunsResponse.body.data.some((row: { diagnostics: Record<string, unknown> }) =>
        String((row.diagnostics ?? {}).promptAppendApplied ?? "").includes("Injected context")
      )
    ).toBe(true);
  });

  it("fails prompt plugin when webhook is requested without network capability", async () => {
    await request(app)
      .post("/plugins/install-from-json")
      .set("x-company-id", companyId)
      .send({
        manifestJson: JSON.stringify({
          id: "prompt-webhook-no-network",
          version: "0.1.0",
          displayName: "Prompt Webhook No Network",
          description: "Webhook without capability should fail.",
          kind: "lifecycle",
          hooks: ["beforeAdapterExecute"],
          capabilities: ["emit_audit"],
          runtime: {
            type: "prompt",
            entrypoint: "prompt:inline",
            timeoutMs: 5000,
            retryCount: 0,
            promptTemplate: "noop"
          }
        }),
        install: true
      });
    await request(app)
      .put("/plugins/prompt-webhook-no-network")
      .set("x-company-id", companyId)
      .send({
        enabled: true,
        grantedCapabilities: [],
        config: {
          webhookRequests: [{ url: "http://localhost:1/test", method: "POST", timeoutMs: 100 }]
        },
        requestApproval: false
      });

    const project = await createProject(db, {
      companyId,
      name: "Webhook capability project",
      workspaceLocalPath: tempDir
    });
    const agent = await createAgent(db, {
      companyId,
      role: "Worker",
      name: "Webhook capability agent",
      providerType: "shell",
      heartbeatCron: "* * * * *",
      monthlyBudgetUsd: "20.0000",
      runtimeCommand: "echo",
      runtimeArgsJson: '["{\\"summary\\":\\"webhook-capability\\",\\"tokenInput\\":1,\\"tokenOutput\\":1,\\"usdCost\\":0.001}"]',
      runtimeCwd: tempDir
    });
    await createIssue(db, {
      companyId,
      projectId: project.id,
      title: "Execute webhook capability plugin",
      assigneeAgentId: agent.id
    });
    await runHeartbeatForAgent(db, companyId, agent.id, { trigger: "manual" });
    const pluginRunsResponse = await request(app)
      .get("/plugins/runs?pluginId=prompt-webhook-no-network")
      .set("x-company-id", companyId);
    expect(pluginRunsResponse.status).toBe(200);
    expect(pluginRunsResponse.body.data.some((row: { status: string }) => row.status === "failed")).toBe(true);
  });

  it("fails prompt plugin on webhook timeout/error when network capability is granted", async () => {
    await request(app)
      .post("/plugins/install-from-json")
      .set("x-company-id", companyId)
      .send({
        manifestJson: JSON.stringify({
          id: "prompt-webhook-timeout",
          version: "0.1.0",
          displayName: "Prompt Webhook Timeout",
          description: "Webhook timeout should fail plugin run.",
          kind: "lifecycle",
          hooks: ["beforeAdapterExecute"],
          capabilities: ["network"],
          runtime: {
            type: "prompt",
            entrypoint: "prompt:inline",
            timeoutMs: 5000,
            retryCount: 0,
            promptTemplate: "noop"
          }
        }),
        install: true
      });
    const server = createServer((_req, _res) => {
      // Intentionally never responding to force timeout.
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    await request(app)
      .put("/plugins/prompt-webhook-timeout")
      .set("x-company-id", companyId)
      .send({
        enabled: true,
        grantedCapabilities: ["network"],
        config: {
          webhookRequests: [{ url: `http://127.0.0.1:${port}/timeout`, method: "POST", timeoutMs: 50 }]
        },
        requestApproval: false
      });
    const project = await createProject(db, {
      companyId,
      name: "Webhook timeout project",
      workspaceLocalPath: tempDir
    });
    const agent = await createAgent(db, {
      companyId,
      role: "Worker",
      name: "Webhook timeout agent",
      providerType: "shell",
      heartbeatCron: "* * * * *",
      monthlyBudgetUsd: "20.0000",
      runtimeCommand: "echo",
      runtimeArgsJson: '["{\\"summary\\":\\"webhook-timeout\\",\\"tokenInput\\":1,\\"tokenOutput\\":1,\\"usdCost\\":0.001}"]',
      runtimeCwd: tempDir
    });
    await createIssue(db, {
      companyId,
      projectId: project.id,
      title: "Execute webhook timeout plugin",
      assigneeAgentId: agent.id
    });
    await runHeartbeatForAgent(db, companyId, agent.id, { trigger: "manual" });
    const pluginRunsResponse = await request(app)
      .get("/plugins/runs?pluginId=prompt-webhook-timeout")
      .set("x-company-id", companyId);
    expect(pluginRunsResponse.status).toBe(200);
    expect(pluginRunsResponse.body.data.some((row: { status: string }) => row.status === "failed")).toBe(true);
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });
});
