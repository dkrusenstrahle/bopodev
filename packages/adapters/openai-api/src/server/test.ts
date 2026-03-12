import type { AgentRuntimeConfig, AdapterEnvironmentResult } from "../../../../agent-sdk/src/types";
import { toEnvironmentStatus } from "../../../../agent-sdk/src/adapters";
import { probeDirectApiEnvironment, resolveDirectApiCredentials } from "../../../../agent-sdk/src/runtime-http";

export async function testEnvironment(runtime?: AgentRuntimeConfig): Promise<AdapterEnvironmentResult> {
  const checks: AdapterEnvironmentResult["checks"] = [];
  const credentials = resolveDirectApiCredentials("openai_api", runtime);
  if (!credentials.key) {
    checks.push({
      code: "api_key_missing",
      level: "error",
      message: "openai_api API key is missing.",
      hint: "Set OPENAI_API_KEY or BOPO_OPENAI_API_KEY in runtime env or host environment."
    });
    return { providerType: "openai_api", status: "fail", testedAt: new Date().toISOString(), checks };
  }
  checks.push({ code: "api_key_present", level: "info", message: "API key is present." });
  checks.push({ code: "base_url", level: "info", message: `Using base URL: ${credentials.baseUrl}` });
  const probe = await probeDirectApiEnvironment("openai_api", runtime);
  if (probe.ok) {
    checks.push({ code: "api_probe_ok", level: "info", message: "openai_api API probe succeeded." });
  } else {
    checks.push({
      code: "api_probe_failed",
      level: probe.statusCode === 401 || probe.statusCode === 403 ? "error" : "warn",
      message: "openai_api API probe failed.",
      detail: probe.message,
      hint: probe.statusCode === 401 || probe.statusCode === 403 ? "Verify API key and organization/project access." : undefined
    });
  }
  return {
    providerType: "openai_api",
    status: toEnvironmentStatus(checks),
    testedAt: new Date().toISOString(),
    checks
  };
}
