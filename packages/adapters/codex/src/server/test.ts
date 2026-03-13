import type { AgentRuntimeConfig, AdapterEnvironmentResult } from "../../../../agent-sdk/src/types";
import { checkRuntimeCommandHealth, executeAgentRuntime } from "../../../../agent-sdk/src/runtime-core";
import { toEnvironmentStatus } from "../../../../agent-sdk/src/adapters";
import path from "node:path";

const CODEX_AUTH_REQUIRED_RE =
  /(?:not\s+logged\s+in|login\s+required|authentication\s+required|unauthorized|invalid(?:\s+or\s+missing)?\s+api(?:[_\s-]?key)?|openai[_\s-]?api[_\s-]?key|api[_\s-]?key.*required|please\s+run\s+`?codex\s+login`?)/i;

function commandLooksLikeCodex(command: string) {
  const base = path.basename(command).toLowerCase();
  return base === "codex" || base === "codex.cmd" || base === "codex.exe";
}

function summarizeProbeDetail(stdout: string, stderr: string) {
  const raw =
    stderr
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ||
    stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ||
    "";
  return raw.replace(/\s+/g, " ").trim().slice(0, 500);
}

export async function testEnvironment(runtime?: AgentRuntimeConfig): Promise<AdapterEnvironmentResult> {
  const checks: AdapterEnvironmentResult["checks"] = [];
  const command = runtime?.command?.trim() || "codex";
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
      providerType: "codex",
      status: "fail",
      testedAt: new Date().toISOString(),
      checks
    };
  }
  checks.push({ code: "command_available", level: "info", message: `Command is executable: ${command}` });
  if (!commandLooksLikeCodex(command)) {
    checks.push({
      code: "probe_skipped_custom_command",
      level: "info",
      message: "Skipped hello probe because runtime command is not the codex CLI.",
      detail: command
    });
    return {
      providerType: "codex",
      status: toEnvironmentStatus(checks),
      testedAt: new Date().toISOString(),
      checks
    };
  }
  const probe = await executeAgentRuntime("codex", "Respond with hello.", {
    ...runtime,
    retryCount: 0,
    timeoutMs: runtime?.timeoutMs ? Math.min(runtime.timeoutMs, 45_000) : 45_000
  });
  if (probe.timedOut) {
    checks.push({ code: "probe_timeout", level: "warn", message: "Environment probe timed out." });
  } else if (probe.ok) {
    checks.push({ code: "probe_ok", level: "info", message: "Environment probe succeeded." });
  } else {
    const detail = summarizeProbeDetail(probe.stdout, probe.stderr);
    const authEvidence = `${probe.stderr}\n${probe.stdout}`;
    if (CODEX_AUTH_REQUIRED_RE.test(authEvidence)) {
      checks.push({
        code: "codex_auth_required",
        level: "warn",
        message: "Codex authentication is not ready for this runtime.",
        detail,
        hint: "Run `codex login` locally or provide OPENAI_API_KEY."
      });
    } else {
      checks.push({
        code: "probe_failed",
        level: "warn",
        message: "Environment probe failed.",
        detail
      });
    }
  }
  return {
    providerType: "codex",
    status: toEnvironmentStatus(checks),
    testedAt: new Date().toISOString(),
    checks
  };
}
