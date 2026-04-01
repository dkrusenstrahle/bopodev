import { definePlugin, runWorker } from "bopodev-plugin-sdk";
import type { PluginManifestV2 } from "bopodev-contracts";

export const manifest: PluginManifestV2 = {
  apiVersion: "2",
  id: "sample-sdk-plugin",
  version: "0.1.0",
  displayName: "Sample SDK Plugin",
  description: "Reference plugin used to validate SDK runtime contracts.",
  kind: "integration",
  hooks: ["afterPersist"],
  capabilities: ["emit_audit"],
  capabilityNamespaces: ["audit.emit", "events.subscribe", "actions.execute", "data.read"],
  runtime: {
    type: "stdio",
    entrypoint: "dist/worker.js",
    timeoutMs: 5000,
    retryCount: 0
  },
  entrypoints: {
    worker: "dist/worker.js",
    ui: "dist/ui"
  },
  jobs: [
    {
      jobKey: "sample-heartbeat",
      displayName: "Sample Heartbeat Job",
      schedule: "* * * * *"
    }
  ],
  webhooks: [
    {
      endpointKey: "sample-webhook",
      displayName: "Sample Webhook"
    }
  ],
  ui: {
    slots: [
      {
        slot: "issueDetailTab",
        displayName: "Sample Plugin"
      }
    ]
  }
};

const plugin = definePlugin({
  manifest,
  async setup(ctx) {
    ctx.actions.register("getIssueTree", async (payload) => ({
      ok: true,
      payload
    }));
    ctx.data.register("health", async () => ({
      status: "ok",
      checkedAt: new Date().toISOString()
    }));
    ctx.hooks.register("afterPersist", async () => ({
      status: "ok",
      summary: "sample hook executed"
    }));
    ctx.jobs.register("sample-heartbeat", async () => ({
      status: "ok",
      summary: "sample job executed"
    }));
    ctx.webhooks.register("sample-webhook", async (payload) => ({
      received: true,
      payload
    }));
  }
});

void runWorker(plugin, {
  companyId: "sample-company",
  pluginId: manifest.id,
  capabilities: manifest.capabilities
});
