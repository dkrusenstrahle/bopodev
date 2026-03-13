import type { AgentRuntimeConfig, AdapterEnvironmentResult } from "../../../../agent-sdk/src/types";
import { resolveRuntimeCommand, toEnvironmentStatus } from "../../../../agent-sdk/src/adapters";
import { checkRuntimeCommandHealth, executePromptRuntime } from "../../../../agent-sdk/src/runtime-core";
import path from "node:path";

const GEMINI_AUTH_REQUIRED_RE =
  /(?:auth(?:entication)?\s+required|not\s+authenticated|not\s+logged\s+in|gemini\s+auth|login\s+required|api[_\s-]?key.*required|invalid\s+api[_\s-]?key|permission denied)/i;

function commandLooksLikeGemini(command: string) {
  const base = path.basename(command).toLowerCase();
  return base === "gemini" || base === "gemini.cmd" || base === "gemini.exe";
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
  const command = resolveRuntimeCommand("gemini_cli", runtime);
  const cwd = runtime?.cwd?.trim() || process.cwd();
  const health = await checkRuntimeCommandHealth(command, { cwd, timeoutMs: 5_000, env: runtime?.env });
  if (!health.available) {
    checks.push({
      code: "command_unavailable",
      level: "error",
      message: `Command is not executable: ${command}`,
      detail: health.error
    });
    return { providerType: "gemini_cli", status: "fail", testedAt: new Date().toISOString(), checks };
  }
  checks.push({ code: "command_available", level: "info", message: `Command is executable: ${command}` });
  if (!commandLooksLikeGemini(command)) {
    checks.push({
      code: "probe_skipped_custom_command",
      level: "info",
      message: "Skipped hello probe because runtime command is not the gemini CLI.",
      detail: command
    });
    return { providerType: "gemini_cli", status: toEnvironmentStatus(checks), testedAt: new Date().toISOString(), checks };
  }
  const model = runtime?.model?.trim();
  const baseArgs = ["--output-format", "stream-json", "--approval-mode", "yolo", "--sandbox=none"];
  if (model) baseArgs.push("--model", model);
  baseArgs.push(...(runtime?.args ?? []));
  baseArgs.push("Respond with hello.");
  const probe = await executePromptRuntime(
    command,
    "Respond with hello.",
    {
      ...runtime,
      args: baseArgs,
      retryCount: 0,
      timeoutMs: runtime?.timeoutMs ? Math.min(runtime.timeoutMs, 45_000) : 45_000
    },
    { provider: "gemini_cli" }
  );
  if (probe.timedOut) {
    checks.push({ code: "probe_timeout", level: "warn", message: "Environment probe timed out." });
  } else if (probe.ok) {
    checks.push({ code: "probe_ok", level: "info", message: "Environment probe succeeded." });
  } else {
    const detail = summarizeProbeDetail(probe.stdout, probe.stderr);
    const authEvidence = `${probe.stderr}\n${probe.stdout}`;
    if (GEMINI_AUTH_REQUIRED_RE.test(authEvidence)) {
      checks.push({
        code: "gemini_auth_required",
        level: "warn",
        message: "Gemini authentication is not ready for this runtime.",
        detail,
        hint: "Run `gemini auth login` or provide GEMINI_API_KEY/GOOGLE_API_KEY."
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
  return { providerType: "gemini_cli", status: toEnvironmentStatus(checks), testedAt: new Date().toISOString(), checks };
}
