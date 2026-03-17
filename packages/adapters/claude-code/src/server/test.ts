import type { AgentRuntimeConfig, AdapterEnvironmentResult } from "../../../../agent-sdk/src/types";
import { checkRuntimeCommandHealth, executeAgentRuntime } from "../../../../agent-sdk/src/runtime-core";
import { toEnvironmentStatus } from "../../../../agent-sdk/src/adapters";

function summarizeProbeDetail(stdout: string, stderr: string) {
  const lines = [...stderr.split(/\r?\n/), ...stdout.split(/\r?\n/)].map((line) => line.trim()).filter(Boolean);
  for (const line of lines) {
    const parsed = parseProbeEvent(line);
    if (!parsed) {
      return line.replace(/\s+/g, " ").trim().slice(0, 500);
    }
    if (
      parsed.type === "system" ||
      parsed.type === "system:init" ||
      parsed.type === "thread.started" ||
      parsed.type === "turn.started" ||
      parsed.type === "item.started" ||
      parsed.type === "item.completed"
    ) {
      continue;
    }
    if (parsed.type === "turn.failed") {
      const errorText = asString(parsed.error) || asString(parsed.message) || asString(parsed.result) || line;
      return errorText.replace(/\s+/g, " ").trim().slice(0, 500);
    }
    const message = asString(parsed.message) || asString(parsed.result);
    if (message) {
      return message.replace(/\s+/g, " ").trim().slice(0, 500);
    }
  }
  return "";
}

function parseProbeEvent(line: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(line) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function asString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

export async function testEnvironment(runtime?: AgentRuntimeConfig): Promise<AdapterEnvironmentResult> {
  const checks: AdapterEnvironmentResult["checks"] = [];
  const command = runtime?.command?.trim() || "claude";
  const cwd = runtime?.cwd?.trim() || process.cwd();
  const health = await checkRuntimeCommandHealth(command, { cwd, timeoutMs: 5_000 });
  if (!health.available) {
    checks.push({
      code: "command_unavailable",
      level: "error",
      message: `Command is not executable: ${command}`,
      detail: health.error
    });
    return { providerType: "claude_code", status: "fail", testedAt: new Date().toISOString(), checks };
  }
  checks.push({ code: "command_available", level: "info", message: `Command is executable: ${command}` });
  const probe = await executeAgentRuntime("claude_code", "Respond with hello.", {
    ...runtime,
    retryCount: 0,
    timeoutMs: runtime?.timeoutMs ? Math.min(runtime.timeoutMs, 45_000) : 45_000
  });
  if (probe.timedOut) {
    checks.push({ code: "probe_timeout", level: "warn", message: "Environment probe timed out." });
  } else if (probe.ok) {
    checks.push({ code: "probe_ok", level: "info", message: "Environment probe succeeded." });
  } else {
    checks.push({
      code: "probe_failed",
      level: "error",
      message: "Environment probe failed.",
      detail: summarizeProbeDetail(probe.stdout, probe.stderr)
    });
  }
  return { providerType: "claude_code", status: toEnvironmentStatus(checks), testedAt: new Date().toISOString(), checks };
}
