import type { PluginWebhookRequest } from "bopodev-contracts";

export type PluginWebhookExecutionResult = {
  url: string;
  method: string;
  ok: boolean;
  statusCode: number | null;
  elapsedMs: number;
  error?: string;
};

export async function executePluginWebhooks(
  requests: PluginWebhookRequest[],
  input: {
    pluginId: string;
    companyId: string;
    runId: string;
  }
) {
  const results: PluginWebhookExecutionResult[] = [];
  const allowlist = resolveWebhookAllowlist();
  for (const request of requests) {
    if (!isWebhookAllowed(request.url, allowlist)) {
      results.push({
        url: request.url,
        method: request.method,
        ok: false,
        statusCode: null,
        elapsedMs: 0,
        error: "Webhook URL not allowed by BOPO_PLUGIN_WEBHOOK_ALLOWLIST."
      });
      continue;
    }
    const startedAt = Date.now();
    try {
      const timeoutController = new AbortController();
      const timeoutId = setTimeout(() => timeoutController.abort(), request.timeoutMs);
      const response = await fetch(request.url, {
        method: request.method,
        headers: {
          "content-type": "application/json",
          "x-bopo-plugin-id": input.pluginId,
          "x-bopo-company-id": input.companyId,
          "x-bopo-run-id": input.runId,
          ...request.headers
        },
        body: request.body ? JSON.stringify(request.body) : undefined,
        signal: timeoutController.signal
      });
      clearTimeout(timeoutId);
      results.push({
        url: request.url,
        method: request.method,
        ok: response.ok,
        statusCode: response.status,
        elapsedMs: Date.now() - startedAt
      });
    } catch (error) {
      results.push({
        url: request.url,
        method: request.method,
        ok: false,
        statusCode: null,
        elapsedMs: Date.now() - startedAt,
        error: String(error)
      });
    }
  }
  return results;
}

function resolveWebhookAllowlist() {
  const raw = process.env.BOPO_PLUGIN_WEBHOOK_ALLOWLIST;
  if (!raw || raw.trim().length === 0) {
    return [] as string[];
  }
  return raw
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
}

function isWebhookAllowed(url: string, allowlist: string[]) {
  if (allowlist.length === 0) {
    return true;
  }
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    return allowlist.includes(host);
  } catch {
    return false;
  }
}
