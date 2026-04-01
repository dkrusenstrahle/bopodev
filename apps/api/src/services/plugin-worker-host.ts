import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { PluginManifest } from "bopodev-contracts";
import { PluginManifestV2Schema } from "bopodev-contracts";
import { z } from "zod";
import {
  PluginRpcLineBuffer,
  createPluginRpcRequest,
  encodePluginRpcMessage,
  type PluginRpcResponse
} from "./plugin-rpc";

type WorkerEntry = {
  process: ChildProcessWithoutNullStreams;
  parser: PluginRpcLineBuffer;
  pending: Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timeout: NodeJS.Timeout }>;
};

type PluginWorkerHostOptions = {
  maxPayloadBytes: number;
  requestTimeoutMs: number;
  disabled: boolean;
};
type PluginManifestV2 = z.infer<typeof PluginManifestV2Schema>;

function parseBoolEnv(value: string | undefined): boolean {
  return value === "1" || value === "true";
}

export class PluginWorkerHost {
  private readonly workers = new Map<string, WorkerEntry>();
  private readonly options: PluginWorkerHostOptions;

  constructor() {
    this.options = {
      maxPayloadBytes: Number(process.env.BOPO_PLUGIN_RPC_MAX_PAYLOAD_BYTES ?? 256_000),
      requestTimeoutMs: Number(process.env.BOPO_PLUGIN_WORKER_REQUEST_TIMEOUT_MS ?? 8_000),
      disabled: parseBoolEnv(process.env.BOPO_PLUGIN_WORKERS_DISABLED)
    };
  }

  isEnabled() {
    return !this.options.disabled;
  }

  async shutdown() {
    for (const [pluginId, entry] of this.workers.entries()) {
      for (const pending of entry.pending.values()) {
        clearTimeout(pending.timeout);
        pending.reject(new Error(`plugin worker '${pluginId}' was shut down`));
      }
      entry.pending.clear();
      entry.process.kill("SIGTERM");
    }
    this.workers.clear();
  }

  async invoke(
    manifest: PluginManifest,
    input: {
      method: "plugin.health" | "plugin.action" | "plugin.data" | "plugin.hook" | "plugin.job" | "plugin.webhook";
      params: Record<string, unknown>;
    }
  ) {
    if (!this.isEnabled()) {
      throw new Error("plugin workers disabled by BOPO_PLUGIN_WORKERS_DISABLED");
    }
    const v2 = PluginManifestV2Schema.safeParse(manifest);
    if (!v2.success) {
      throw new Error(`plugin '${manifest.id}' does not declare apiVersion '2'`);
    }
    const entry = await this.ensureWorker(v2.data);
    const requestId = randomUUID();
    const request = createPluginRpcRequest(input.method, input.params, requestId);
    const encoded = encodePluginRpcMessage(request);
    if (Buffer.byteLength(encoded, "utf8") > this.options.maxPayloadBytes) {
      throw new Error(`plugin rpc payload exceeds ${this.options.maxPayloadBytes} bytes`);
    }
    return await new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        entry.pending.delete(requestId);
        reject(new Error(`plugin rpc request timed out for '${manifest.id}' method '${input.method}'`));
      }, this.options.requestTimeoutMs);
      entry.pending.set(requestId, { resolve, reject, timeout });
      entry.process.stdin.write(encoded);
    });
  }

  private async ensureWorker(manifest: PluginManifestV2) {
    const existing = this.workers.get(manifest.id);
    if (existing && !existing.process.killed) {
      return existing;
    }
    const command = process.env.BOPO_PLUGIN_WORKER_COMMAND ?? "node";
    const child = spawn(command, [manifest.entrypoints.worker], {
      stdio: "pipe",
      env: process.env
    });
    const parser = new PluginRpcLineBuffer();
    const pending = new Map<
      string,
      { resolve: (value: unknown) => void; reject: (error: Error) => void; timeout: NodeJS.Timeout }
    >();
    parser.on("message", (message: PluginRpcResponse) => {
      const waiter = pending.get(message.id);
      if (!waiter) {
        return;
      }
      clearTimeout(waiter.timeout);
      pending.delete(message.id);
      if ("error" in message) {
        waiter.reject(new Error(`${message.error.message} (${message.error.code})`));
        return;
      }
      waiter.resolve(message.result);
    });
    child.stdout.on("data", (chunk) => {
      parser.push(String(chunk));
    });
    child.stderr.on("data", (chunk) => {
      // eslint-disable-next-line no-console
      console.warn(`[plugins] worker '${manifest.id}' stderr: ${String(chunk).trim()}`);
    });
    child.on("exit", () => {
      this.workers.delete(manifest.id);
      for (const wait of pending.values()) {
        clearTimeout(wait.timeout);
        wait.reject(new Error(`plugin worker '${manifest.id}' exited`));
      }
      pending.clear();
    });
    const entry: WorkerEntry = { process: child, parser, pending };
    this.workers.set(manifest.id, entry);
    return entry;
  }
}

export const pluginWorkerHost = new PluginWorkerHost();
