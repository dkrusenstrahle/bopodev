import type { PluginRow } from "@/components/workspace/types";

export type PluginSlotName = "issueDetailTab" | "workspacePage" | "sidebarPanel" | "settingsPanel";

export type ResolvedPluginSlot = {
  pluginId: string;
  pluginName: string;
  slot: PluginSlotName;
  routePath?: string;
  displayName: string;
  featureFlag?: string;
};

const supportedSlotNames = new Set<PluginSlotName>(["issueDetailTab", "workspacePage", "sidebarPanel", "settingsPanel"]);

function asString(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

function normalizeSlotValue(value: unknown): PluginSlotName | null {
  if (typeof value !== "string") {
    return null;
  }
  if (!supportedSlotNames.has(value as PluginSlotName)) {
    return null;
  }
  return value as PluginSlotName;
}

export function resolvePluginSlots(plugins: PluginRow[], targetSlot: PluginSlotName): ResolvedPluginSlot[] {
  const out: ResolvedPluginSlot[] = [];
  for (const plugin of plugins) {
    if (!plugin.companyConfig?.enabled || plugin.apiVersion !== "2") {
      continue;
    }
    for (const entry of plugin.uiSlots ?? []) {
      const slot = normalizeSlotValue((entry as Record<string, unknown>).slot);
      if (!slot || slot !== targetSlot) {
        continue;
      }
      out.push({
        pluginId: plugin.id,
        pluginName: plugin.name,
        slot,
        routePath: asString((entry as Record<string, unknown>).routePath),
        displayName: asString((entry as Record<string, unknown>).displayName) ?? plugin.name,
        featureFlag: asString((entry as Record<string, unknown>).featureFlag)
      });
    }
  }
  return out;
}
