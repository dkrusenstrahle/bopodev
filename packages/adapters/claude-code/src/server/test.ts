import type { AgentRuntimeConfig, AdapterEnvironmentResult } from "../../../../agent-sdk/src/types";
import { checkRuntimeCommandHealth, executeAgentRuntime } from "../../../../agent-sdk/src/runtime-core";
import { toEnvironmentStatus } from "../../../../agent-sdk/src/adapters";

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
      detail: `${probe.stderr}\n${probe.stdout}`.trim().slice(0, 500)
    });
  }
  return { providerType: "claude_code", status: toEnvironmentStatus(checks), testedAt: new Date().toISOString(), checks };
}
