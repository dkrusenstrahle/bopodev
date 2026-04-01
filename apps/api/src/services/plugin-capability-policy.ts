import { PLUGIN_CAPABILITY_RISK, type PluginCapabilityNamespace } from "bopodev-contracts";

const LEGACY_HIGH_RISK = new Set(["network", "queue_publish", "issue_write", "write_memory"]);

export type PluginTrustLevel = "dev_local" | "verified" | "restricted";

function resolveTrustLevel(): PluginTrustLevel {
  const raw = process.env.BOPO_PLUGIN_TRUST_LEVEL;
  if (raw === "dev_local" || raw === "verified" || raw === "restricted") {
    return raw;
  }
  return "verified";
}

export function legacyCapabilitiesRequireApproval(capabilities: string[]) {
  return capabilities.some((cap) => LEGACY_HIGH_RISK.has(cap));
}

export function namespacedCapabilitiesRequireApproval(capabilities: PluginCapabilityNamespace[]) {
  const trustLevel = resolveTrustLevel();
  return capabilities.some((cap) => {
    const risk = PLUGIN_CAPABILITY_RISK[cap];
    if (risk === "restricted") {
      return true;
    }
    if (risk === "elevated") {
      return trustLevel !== "dev_local";
    }
    return false;
  });
}
