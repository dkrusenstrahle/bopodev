import type { AgentRuntimeConfig, AdapterEnvironmentResult } from "../../../../agent-sdk/src/types";
import { resolveCursorLaunchConfig, toEnvironmentStatus } from "../../../../agent-sdk/src/adapters";
import { checkRuntimeCommandHealth, executePromptRuntime } from "../../../../agent-sdk/src/runtime-core";

export async function testEnvironment(runtime?: AgentRuntimeConfig): Promise<AdapterEnvironmentResult> {
  const checks: AdapterEnvironmentResult["checks"] = [];
  const launch = await resolveCursorLaunchConfig(runtime);
  const cwd = runtime?.cwd?.trim() || process.cwd();
  const health = await checkRuntimeCommandHealth(launch.command, { cwd, timeoutMs: 5_000 });
  if (!health.available) {
    checks.push({
      code: "command_unavailable",
      level: "error",
      message: `Command is not executable: ${launch.command}`,
      detail: health.error
    });
    return { providerType: "cursor", status: "fail", testedAt: new Date().toISOString(), checks };
  }
  checks.push({ code: "command_available", level: "info", message: `Command is executable: ${launch.command}` });
  const probe = await executePromptRuntime(
    launch.command,
    "Respond with hello.",
    {
      ...runtime,
      args: [...launch.prefixArgs, "-p", "--output-format", "stream-json", "--workspace", cwd, ...(runtime?.args ?? [])],
      retryCount: 0,
      timeoutMs: runtime?.timeoutMs ? Math.min(runtime.timeoutMs, 45_000) : 45_000
    },
    { provider: "cursor" }
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
  return { providerType: "cursor", status: toEnvironmentStatus(checks), testedAt: new Date().toISOString(), checks };
}
