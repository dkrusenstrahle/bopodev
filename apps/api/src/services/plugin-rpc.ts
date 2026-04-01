import { EventEmitter } from "node:events";

export type PluginRpcRequest = {
  jsonrpc: "2.0";
  id: string;
  method: string;
  params?: unknown;
};

export type PluginRpcSuccess = {
  jsonrpc: "2.0";
  id: string;
  result: unknown;
};

export type PluginRpcFailure = {
  jsonrpc: "2.0";
  id: string;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
};

export type PluginRpcResponse = PluginRpcSuccess | PluginRpcFailure;

export function createPluginRpcRequest(method: string, params: unknown, id: string): PluginRpcRequest {
  return {
    jsonrpc: "2.0",
    id,
    method,
    params
  };
}

export function encodePluginRpcMessage(value: PluginRpcRequest | PluginRpcResponse): string {
  return `${JSON.stringify(value)}\n`;
}

export function decodePluginRpcMessage(line: string): PluginRpcResponse | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line) as unknown;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") {
    return null;
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.jsonrpc !== "2.0" || typeof obj.id !== "string") {
    return null;
  }
  if ("result" in obj) {
    return {
      jsonrpc: "2.0",
      id: obj.id,
      result: obj.result
    };
  }
  if ("error" in obj && obj.error && typeof obj.error === "object") {
    const err = obj.error as Record<string, unknown>;
    if (typeof err.code === "number" && typeof err.message === "string") {
      return {
        jsonrpc: "2.0",
        id: obj.id,
        error: {
          code: err.code,
          message: err.message,
          data: err.data
        }
      };
    }
  }
  return null;
}

export class PluginRpcLineBuffer extends EventEmitter<{
  message: [PluginRpcResponse];
}> {
  private buffer = "";

  push(chunk: string) {
    this.buffer += chunk;
    while (true) {
      const idx = this.buffer.indexOf("\n");
      if (idx === -1) {
        break;
      }
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) {
        continue;
      }
      const parsed = decodePluginRpcMessage(line);
      if (parsed) {
        this.emit("message", parsed);
      }
    }
  }
}
