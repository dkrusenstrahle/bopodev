import type { AgentRuntimeConfig, AdapterEnvironmentResult } from "../../../../agent-sdk/src/types";

export async function testEnvironment(runtime?: AgentRuntimeConfig): Promise<AdapterEnvironmentResult> {
  return {
    providerType: "http",
    status: "pass",
    testedAt: new Date().toISOString(),
    checks: [{ code: "http_adapter_ready", level: "info", message: "HTTP adapter does not require local CLI checks." }]
  };
}
