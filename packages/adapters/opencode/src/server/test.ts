import type { AgentRuntimeConfig, AdapterEnvironmentResult } from "../../../../agent-sdk/src/types";
import { resolveRuntimeCommand, toEnvironmentStatus } from "../../../../agent-sdk/src/adapters";
import { checkRuntimeCommandHealth, executePromptRuntime } from "../../../../agent-sdk/src/runtime-core";

export async function testEnvironment(runtime?: AgentRuntimeConfig): Promise<AdapterEnvironmentResult> {
  const checks: AdapterEnvironmentResult["checks"] = [];
  const command = resolveRuntimeCommand("opencode", runtime);
  const cwd = runtime?.cwd?.trim() || process.cwd();
  const health = await checkRuntimeCommandHealth(command, { cwd, timeoutMs: 5_000 });
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
  if (!runtime?.model?.trim()) {
    checks.push({ code: "model_missing", level: "error", message: "OpenCode requires a model in provider/model format." });
    return { providerType: "opencode", status: toEnvironmentStatus(checks), testedAt: new Date().toISOString(), checks };
  }
  const probe = await executePromptRuntime(
    command,
    "Respond with hello.",
    {
      ...runtime,
      args: ["run", "--format", "json", "--model", runtime.model.trim(), ...(runtime?.args ?? [])],
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
    checks.push({
      code: "probe_failed",
      level: "warn",
      message: "Environment probe failed.",
      detail: `${probe.stderr}\n${probe.stdout}`.trim().slice(0, 500)
    });
  }
  return { providerType: "opencode", status: toEnvironmentStatus(checks), testedAt: new Date().toISOString(), checks };
}
