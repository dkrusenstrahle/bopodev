import path from "node:path";
import type { AgentRuntimeConfig, AdapterEnvironmentResult } from "../../../../agent-sdk/src/types";
import { checkRuntimeCommandHealth, executePromptRuntime } from "../../../../agent-sdk/src/runtime-core";
import { toEnvironmentStatus } from "../../../../agent-sdk/src/adapters";

function commandLooksLikeHermes(command: string) {
  const base = path.basename(command).toLowerCase();
  return base === "hermes" || base === "hermes.cmd" || base === "hermes.exe";
}

function summarizeProbeDetail(stdout: string, stderr: string) {
  const lines = [...stderr.split(/\r?\n/), ...stdout.split(/\r?\n/)].map((line) => line.trim()).filter(Boolean);
  const firstLine = lines.find((line) => line.length > 0);
  return firstLine ? firstLine.replace(/\s+/g, " ").trim().slice(0, 500) : "";
}

export async function testEnvironment(runtime?: AgentRuntimeConfig): Promise<AdapterEnvironmentResult> {
  const checks: AdapterEnvironmentResult["checks"] = [];
  const command = runtime?.command?.trim() || "hermes";
  const cwd = runtime?.cwd?.trim() || process.cwd();
  const health = await checkRuntimeCommandHealth(command, { cwd, timeoutMs: 5_000, env: runtime?.env });
  if (!health.available) {
    checks.push({
      code: "command_unavailable",
      level: "error",
      message: `Command is not executable: ${command}`,
      detail: health.error
    });
    return {
      providerType: "hermes_local",
      status: "fail",
      testedAt: new Date().toISOString(),
      checks
    };
  }
  checks.push({ code: "command_available", level: "info", message: `Command is executable: ${command}` });
  if (!commandLooksLikeHermes(command)) {
    checks.push({
      code: "probe_skipped_custom_command",
      level: "info",
      message: "Skipped hello probe because runtime command is not the Hermes CLI.",
      detail: command
    });
    return {
      providerType: "hermes_local",
      status: toEnvironmentStatus(checks),
      testedAt: new Date().toISOString(),
      checks
    };
  }
  const probe = await executePromptRuntime(command, "Respond with hello.", {
    ...runtime,
    retryCount: 0,
    args: [...(runtime?.args ?? [])],
    timeoutMs: runtime?.timeoutMs ? Math.min(runtime.timeoutMs, 45_000) : 45_000
  });
  if (probe.timedOut) {
    checks.push({ code: "probe_timeout", level: "warn", message: "Environment probe timed out." });
  } else if (probe.ok) {
    checks.push({ code: "probe_ok", level: "info", message: "Environment probe succeeded." });
  } else {
    checks.push({
      code: "probe_failed",
      level: "warn",
      message: "Environment probe failed.",
      detail: summarizeProbeDetail(probe.stdout, probe.stderr)
    });
  }
  return {
    providerType: "hermes_local",
    status: toEnvironmentStatus(checks),
    testedAt: new Date().toISOString(),
    checks
  };
}
