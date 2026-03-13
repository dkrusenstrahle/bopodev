import type { AgentRuntimeConfig, AdapterEnvironmentResult } from "../../../../agent-sdk/src/types";
import {
  discoverOpenCodeModelsCached,
  ensureOpenCodeModelConfiguredAndAvailable,
  resolveRuntimeCommand,
  toEnvironmentStatus
} from "../../../../agent-sdk/src/adapters";
import { checkRuntimeCommandHealth, executePromptRuntime } from "../../../../agent-sdk/src/runtime-core";
import path from "node:path";

const OPENCODE_AUTH_REQUIRED_RE =
  /(?:auth(?:entication)?\s+required|api\s*key|invalid\s*api\s*key|not\s+logged\s+in|opencode\s+auth\s+login|free\s+usage\s+exceeded)/i;

function commandLooksLikeOpenCode(command: string) {
  const base = path.basename(command).toLowerCase();
  return base === "opencode" || base === "opencode.cmd" || base === "opencode.exe";
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
  const command = resolveRuntimeCommand("opencode", runtime);
  const cwd = runtime?.cwd?.trim() || process.cwd();
  const health = await checkRuntimeCommandHealth(command, { cwd, timeoutMs: 5_000, env: runtime?.env });
  if (!health.available) {
    checks.push({
      code: "command_unavailable",
      level: "error",
      message: `Command is not executable: ${command}`,
      detail: health.error
    });
    return { providerType: "opencode", status: "fail", testedAt: new Date().toISOString(), checks };
  }
  checks.push({ code: "command_available", level: "info", message: `Command is executable: ${command}` });
  const configuredModel = runtime?.model?.trim() || "";
  try {
    const models = await discoverOpenCodeModelsCached({
      command,
      cwd,
      env: runtime?.env
    });
    if (models.length > 0) {
      checks.push({
        code: "models_discovered",
        level: "info",
        message: `Discovered ${models.length} OpenCode model(s).`
      });
    } else {
      checks.push({
        code: "models_empty",
        level: "warn",
        message: "OpenCode returned no models.",
        hint: "Run `opencode models` and verify provider authentication."
      });
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    checks.push({
      code: "model_discovery_failed",
      level: "warn",
      message: "OpenCode model discovery failed.",
      detail
    });
  }
  if (!configuredModel) {
    checks.push({ code: "model_missing", level: "error", message: "OpenCode requires a model in provider/model format." });
    return { providerType: "opencode", status: toEnvironmentStatus(checks), testedAt: new Date().toISOString(), checks };
  }
  try {
    await ensureOpenCodeModelConfiguredAndAvailable({
      model: configuredModel,
      command,
      cwd,
      env: runtime?.env
    });
    checks.push({ code: "model_valid", level: "info", message: `Configured model is available: ${configuredModel}` });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    checks.push({
      code: "model_invalid",
      level: "error",
      message: "Configured OpenCode model is unavailable.",
      detail
    });
    return { providerType: "opencode", status: toEnvironmentStatus(checks), testedAt: new Date().toISOString(), checks };
  }
  if (!commandLooksLikeOpenCode(command)) {
    checks.push({
      code: "probe_skipped_custom_command",
      level: "info",
      message: "Skipped hello probe because runtime command is not the opencode CLI.",
      detail: command
    });
    return { providerType: "opencode", status: toEnvironmentStatus(checks), testedAt: new Date().toISOString(), checks };
  }
  const probe = await executePromptRuntime(
    command,
    "Respond with hello.",
    {
      ...runtime,
      args: ["run", "--format", "json", "--model", configuredModel, ...(runtime?.args ?? [])],
      retryCount: 0,
      timeoutMs: runtime?.timeoutMs ? Math.min(runtime.timeoutMs, 45_000) : 45_000
    },
    { provider: "opencode" }
  );
  if (probe.timedOut) {
    checks.push({ code: "probe_timeout", level: "warn", message: "Environment probe timed out." });
  } else if (probe.ok) {
    checks.push({ code: "probe_ok", level: "info", message: "Environment probe succeeded." });
  } else {
    const detail = summarizeProbeDetail(probe.stdout, probe.stderr);
    const authEvidence = `${probe.stderr}\n${probe.stdout}`;
    if (OPENCODE_AUTH_REQUIRED_RE.test(authEvidence)) {
      checks.push({
        code: "opencode_auth_required",
        level: "warn",
        message: "OpenCode authentication is not ready for this runtime.",
        detail,
        hint: "Run `opencode auth login` or configure provider credentials."
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
  return { providerType: "opencode", status: toEnvironmentStatus(checks), testedAt: new Date().toISOString(), checks };
}
