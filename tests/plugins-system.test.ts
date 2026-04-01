import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../apps/api/src/app";
import { runHeartbeatForAgent } from "../apps/api/src/services/heartbeat-service";
import { ensureBuiltinPluginsRegistered } from "../apps/api/src/services/plugin-runtime";
import type { BopoDb } from "../packages/db/src/client";
import { bootstrapDatabase, createAgent, createCompany, createIssue, createProject } from "../packages/db/src/index";

async function pollPluginRuns(
  fetchResponse: () => Promise<{ status: number; body: { data?: unknown } }>,
  predicate: (rows: Array<Record<string, unknown>>) => boolean,
  options?: { timeoutMs?: number; intervalMs?: number }
) {
  const timeoutMs = options?.timeoutMs ?? 30_000;
  const intervalMs = options?.intervalMs ?? 50;
  const deadline = Date.now() + timeoutMs;
  let last: Awaited<ReturnType<typeof fetchResponse>> | undefined;
  while (Date.now() < deadline) {
    last = await fetchResponse();
    const rows = last.body?.data;
    if (last.status === 200 && Array.isArray(rows) && predicate(rows as Array<Record<string, unknown>>)) {
      return last;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return last ?? (await fetchResponse());
}

describe("plugin system", { timeout: 120_000 }, () => {
  let db: BopoDb;
  let app: ReturnType<typeof createApp>;
  let tempDir: string;
  let workspaceDir: string;
  let manifestsRoot: string;
  let runtimeDemoDir: string;
  let companyId: string;
  let client: { close?: () => Promise<void> };
  let originalInstanceRoot: string | undefined;
  let originalEnabledFlag: string | undefined;
  let originalDisabledFlag: string | undefined;
  let originalManifestsDir: string | undefined;
  let originalWebhookAllowlist: string | undefined;

  beforeEach(async () => {
    originalInstanceRoot = process.env.BOPO_INSTANCE_ROOT;
    originalEnabledFlag = process.env.BOPO_PLUGIN_SYSTEM_ENABLED;
    originalDisabledFlag = process.env.BOPO_PLUGIN_SYSTEM_DISABLED;
    originalManifestsDir = process.env.BOPO_PLUGIN_MANIFESTS_DIR;
    originalWebhookAllowlist = process.env.BOPO_PLUGIN_WEBHOOK_ALLOWLIST;
    delete process.env.BOPO_PLUGIN_SYSTEM_ENABLED;
    delete process.env.BOPO_PLUGIN_SYSTEM_DISABLED;
    delete process.env.BOPO_PLUGIN_WEBHOOK_ALLOWLIST;
    tempDir = await mkdtemp(join(tmpdir(), "bopodev-plugin-test-"));
    manifestsRoot = join(tempDir, "plugins");
    runtimeDemoDir = join(manifestsRoot, "runtime-demo");
    process.env.BOPO_INSTANCE_ROOT = tempDir;
    process.env.BOPO_PLUGIN_MANIFESTS_DIR = manifestsRoot;
    await writeRuntimeDemoFixture(runtimeDemoDir);
    const boot = await bootstrapDatabase(join(tempDir, "test.db"));
    db = boot.db;
    client = boot.client as { close?: () => Promise<void> };
    app = createApp({ db });
    const company = await createCompany(db, { name: "Plugins Co", mission: "Test plugins." });
    companyId = company.id;
    workspaceDir = join(tempDir, "workspaces", companyId);
    await mkdir(workspaceDir, { recursive: true });
    await ensureBuiltinPluginsRegistered(db, [companyId]);
  }, 30_000);

  afterEach(async () => {
    if (originalInstanceRoot === undefined) {
      delete process.env.BOPO_INSTANCE_ROOT;
    } else {
      process.env.BOPO_INSTANCE_ROOT = originalInstanceRoot;
    }
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
    if (originalWebhookAllowlist === undefined) {
      delete process.env.BOPO_PLUGIN_WEBHOOK_ALLOWLIST;
    } else {
      process.env.BOPO_PLUGIN_WEBHOOK_ALLOWLIST = originalWebhookAllowlist;
    }
    await client?.close?.();
    await rm(tempDir, { recursive: true, force: true });
  }, 30_000);

  it("discovers filesystem manifests and includes company config rows", async () => {
    const listResponse = await request(app).get("/plugins").set("x-company-id", companyId);
    expect(listResponse.status).toBe(200);
    expect(Array.isArray(listResponse.body.data)).toBe(true);
    const runtimeDemo = listResponse.body.data.find((row: { id: string }) => row.id === "runtime-demo");
    expect(runtimeDemo).toBeTruthy();
    expect(runtimeDemo.apiVersion).toBe("2");
    expect(runtimeDemo.companyConfig).toBeTruthy();
    expect(runtimeDemo.companyConfig.enabled).toBe(false);
  });

  it("supports health, action, and data endpoints for an enabled worker plugin", async () => {
    const enableResponse = await request(app).put("/plugins/runtime-demo").set("x-company-id", companyId).send({
      enabled: true,
      priority: 100,
      config: {},
      grantedCapabilities: [],
      requestApproval: false
    });
    expect(enableResponse.status).toBe(200);

    const healthResponse = await request(app).get("/plugins/runtime-demo/health").set("x-company-id", companyId);
    expect(healthResponse.status).toBe(200);
    expect(healthResponse.body.data.ok).toBe(true);
    expect(healthResponse.body.data.data.status).toBe("ok");

    const actionResponse = await request(app)
      .post("/plugins/runtime-demo/actions/ping")
      .set("x-company-id", companyId)
      .send({ hello: "world" });
    expect(actionResponse.status).toBe(200);
    expect(actionResponse.body.data.ok).toBe(true);
    expect(actionResponse.body.data.data.ok).toBe(true);
    expect(actionResponse.body.data.data.actionKey).toBe("ping");

    const dataResponse = await request(app)
      .post("/plugins/runtime-demo/data/state")
      .set("x-company-id", companyId)
      .send({ include: "all" });
    expect(dataResponse.status).toBe(200);
    expect(dataResponse.body.data.ok).toBe(true);
    expect(dataResponse.body.data.data.ok).toBe(true);
    expect(dataResponse.body.data.data.dataKey).toBe("state");
  });

  it("records hook plugin runs during heartbeat execution", async () => {
    const enableResponse = await request(app).put("/plugins/runtime-demo").set("x-company-id", companyId).send({
      enabled: true,
      priority: 100,
      config: {},
      grantedCapabilities: [],
      requestApproval: false
    });
    expect(enableResponse.status).toBe(200);

    const project = await createProject(db, {
      companyId,
      name: "Plugin execution project",
      workspaceLocalPath: workspaceDir
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
      runtimeCwd: workspaceDir
    });
    await createIssue(db, {
      companyId,
      projectId: project.id,
      title: "Execute plugin hooks",
      assigneeAgentId: agent.id
    });
    const runId = await runHeartbeatForAgent(db, companyId, agent.id, { trigger: "manual" });
    expect(runId).toBeTruthy();

    const pluginRunsResponse = await pollPluginRuns(
      () =>
        request(app)
          .get(`/observability/plugins/runs?runId=${encodeURIComponent(runId!)}`)
          .set("x-company-id", companyId),
      (rows) => rows.some((row) => row.pluginId === "runtime-demo" && row.hook === "afterPersist")
    );
    expect(pluginRunsResponse.status).toBe(200);
    expect(Array.isArray(pluginRunsResponse.body.data)).toBe(true);
    expect(pluginRunsResponse.body.data.length).toBeGreaterThan(0);
    expect(
      pluginRunsResponse.body.data.some(
        (row: { pluginId: string; hook: string; status: string }) =>
          row.pluginId === "runtime-demo" && row.hook === "afterPersist" && row.status === "ok"
      )
    ).toBe(true);
  });

  it("ignores invalid filesystem manifests without failing registration", async () => {
    const pluginDir = join(manifestsRoot, "broken-plugin");
    await mkdir(pluginDir, { recursive: true });
    await writeFile(join(pluginDir, "plugin.json"), JSON.stringify({ id: "broken-plugin" }, null, 2));

    await expect(ensureBuiltinPluginsRegistered(db, [companyId])).resolves.toBeUndefined();

    const listResponse = await request(app).get("/plugins").set("x-company-id", companyId);
    expect(listResponse.status).toBe(200);
    expect(listResponse.body.data.some((row: { id: string }) => row.id === "broken-plugin")).toBe(false);
    expect(listResponse.body.data.some((row: { id: string }) => row.id === "runtime-demo")).toBe(true);
  });

  it("supports delete for custom discovered plugins", async () => {
    const deleteResponse = await request(app).delete("/plugins/runtime-demo").set("x-company-id", companyId);
    expect(deleteResponse.status).toBe(200);
    expect(deleteResponse.body.data.deleted).toBe(true);

    const listResponse = await request(app).get("/plugins").set("x-company-id", companyId);
    expect(listResponse.status).toBe(200);
    expect(listResponse.body.data.some((row: { id: string }) => row.id === "runtime-demo")).toBe(false);
  });

  it("validates update/install/rollback payloads and ids", async () => {
    const invalidUpdateResponse = await request(app).put("/plugins/runtime-demo").set("x-company-id", companyId).send({
      priority: -1
    });
    expect(invalidUpdateResponse.status).toBe(422);

    const unknownPluginResponse = await request(app)
      .put("/plugins/does-not-exist")
      .set("x-company-id", companyId)
      .send({
        enabled: true,
        requestApproval: false
      });
    expect(unknownPluginResponse.status).toBe(404);

    const invalidInstallResponse = await request(app).post("/plugins/install").set("x-company-id", companyId).send({
      packageName: ""
    });
    expect(invalidInstallResponse.status).toBe(422);

    const rollbackMissingInstallId = await request(app)
      .post("/plugins/runtime-demo/rollback")
      .set("x-company-id", companyId)
      .send({});
    expect(rollbackMissingInstallId.status).toBe(422);

    const rollbackUnknownInstall = await request(app)
      .post("/plugins/runtime-demo/rollback")
      .set("x-company-id", companyId)
      .send({ installId: "not-real-install-id" });
    expect([404, 422]).toContain(rollbackUnknownInstall.status);
    if (rollbackUnknownInstall.status === 422) {
      expect(String(rollbackUnknownInstall.body.error ?? "")).toContain("rollback is unavailable");
    }
  });

  it("does not execute plugins when plugin system is globally disabled", async () => {
    process.env.BOPO_PLUGIN_SYSTEM_DISABLED = "true";
    const enableResponse = await request(app).put("/plugins/runtime-demo").set("x-company-id", companyId).send({
      enabled: true,
      priority: 100,
      config: {},
      grantedCapabilities: [],
      requestApproval: false
    });
    expect(enableResponse.status).toBe(200);

    const project = await createProject(db, {
      companyId,
      name: "Plugin disabled project",
      workspaceLocalPath: workspaceDir
    });
    const agent = await createAgent(db, {
      companyId,
      role: "Worker",
      name: "Plugin disabled agent",
      providerType: "shell",
      heartbeatCron: "* * * * *",
      monthlyBudgetUsd: "20.0000",
      runtimeCommand: "echo",
      runtimeArgsJson: '["{\\"summary\\":\\"plugin-disabled\\",\\"tokenInput\\":1,\\"tokenOutput\\":1,\\"usdCost\\":0.001}"]',
      runtimeCwd: workspaceDir
    });
    await createIssue(db, {
      companyId,
      projectId: project.id,
      title: "Execute with plugins disabled",
      assigneeAgentId: agent.id
    });
    const runId = await runHeartbeatForAgent(db, companyId, agent.id, { trigger: "manual" });
    const pluginRunsResponse = await request(app)
      .get(`/observability/plugins/runs?runId=${encodeURIComponent(runId!)}`)
      .set("x-company-id", companyId);
    expect(pluginRunsResponse.status).toBe(200);
    expect(Array.isArray(pluginRunsResponse.body.data)).toBe(true);
    expect(pluginRunsResponse.body.data.length).toBe(0);
  });

  it("lists plugin install history for discovered plugins", async () => {
    const installsResponse = await request(app).get("/plugins/runtime-demo/installs").set("x-company-id", companyId);
    expect([200, 422]).toContain(installsResponse.status);
    if (installsResponse.status === 200) {
      expect(Array.isArray(installsResponse.body.data)).toBe(true);
      expect(installsResponse.body.data.length).toBe(0);
    } else {
      expect(String(installsResponse.body.error ?? "")).toContain("version history is unavailable");
    }
  });
});

async function writeRuntimeDemoFixture(pluginDir: string) {
  await mkdir(join(pluginDir, "dist"), { recursive: true });
  await mkdir(join(pluginDir, "ui"), { recursive: true });
  await writeFile(
    join(pluginDir, "plugin.json"),
    JSON.stringify(
      {
        apiVersion: "2",
        id: "runtime-demo",
        version: "0.1.0",
        displayName: "Runtime Demo",
        description: "Worker-based demo plugin fixture for integration tests.",
        kind: "integration",
        hooks: ["beforeAdapterExecute", "afterPersist"],
        capabilities: ["emit_audit"],
        capabilityNamespaces: ["audit.emit", "events.subscribe", "actions.execute", "data.read"],
        runtime: {
          type: "stdio",
          entrypoint: "dist/worker.js",
          timeoutMs: 5_000,
          retryCount: 0
        },
        entrypoints: {
          worker: "dist/worker.js",
          ui: "ui"
        },
        jobs: [
          {
            jobKey: "demo-minute",
            displayName: "Demo Minute Job",
            schedule: "* * * * *"
          }
        ],
        webhooks: [
          {
            endpointKey: "incoming-demo",
            displayName: "Incoming Demo Webhook"
          }
        ],
        ui: {
          slots: [
            {
              slot: "issueDetailTab",
              displayName: "Runtime Demo"
            }
          ]
        }
      },
      null,
      2
    )
  );
  await writeFile(
    join(pluginDir, "dist/worker.js"),
    `#!/usr/bin/env node
function send(id, result) {
  process.stdout.write(\`\${JSON.stringify({ jsonrpc: "2.0", id, result })}\\n\`);
}

function sendError(id, code, message) {
  process.stdout.write(\`\${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\\n\`);
}

function toInvocation(summary) {
  return {
    status: "ok",
    summary,
    blockers: [],
    diagnostics: {
      source: "runtime-demo-test-worker"
    }
  };
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index = buffer.indexOf("\\n");
  while (index >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line.length > 0) {
      handle(line);
    }
    index = buffer.indexOf("\\n");
  }
});

function handle(line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  const id = typeof message.id === "string" ? message.id : "unknown";
  const method = typeof message.method === "string" ? message.method : "";
  const params = message.params && typeof message.params === "object" ? message.params : {};
  if (method === "plugin.health") {
    send(id, { status: "ok", message: "runtime-demo healthy" });
    return;
  }
  if (method === "plugin.hook") {
    send(id, toInvocation(\`hook processed: \${String(params.hook ?? "unknown")}\`));
    return;
  }
  if (method === "plugin.action") {
    send(id, { ok: true, actionKey: String(params.key ?? "unknown"), payload: params.payload ?? {} });
    return;
  }
  if (method === "plugin.data") {
    send(id, { ok: true, dataKey: String(params.key ?? "unknown"), payload: params.payload ?? {} });
    return;
  }
  if (method === "plugin.job") {
    send(id, toInvocation(\`job processed: \${String(params.jobKey ?? "unknown")}\`));
    return;
  }
  if (method === "plugin.webhook") {
    send(id, { ok: true, endpointKey: String(params.endpointKey ?? "unknown"), payload: params.payload ?? {} });
    return;
  }
  sendError(id, -32601, \`Unsupported method: \${method}\`);
}
`
  );
  await writeFile(join(pluginDir, "ui/index.html"), "<!doctype html><html><body><h1>Runtime Demo Test</h1></body></html>");
}
