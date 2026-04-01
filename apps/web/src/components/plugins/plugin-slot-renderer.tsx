"use client";

import { useMemo } from "react";
import type { PluginRow } from "@/components/workspace/types";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { apiGet } from "@/lib/api";
import { resolvePluginSlots, type PluginSlotName } from "@/lib/plugins/slot-registry";

export function PluginSlotRenderer(props: {
  companyId: string;
  slot: PluginSlotName;
  plugins: PluginRow[];
  issueId?: string;
}) {
  const slots = useMemo(() => resolvePluginSlots(props.plugins, props.slot), [props.plugins, props.slot]);
  if (slots.length === 0) {
    return null;
  }
  return (
    <div className="space-y-3">
      {slots.map((slot) => (
        <div key={`${slot.pluginId}:${slot.slot}`} className="rounded-md border p-3">
          <div className="mb-2 text-sm font-medium">{slot.displayName}</div>
          <PluginSlotActionCard companyId={props.companyId} pluginId={slot.pluginId} issueId={props.issueId} />
        </div>
      ))}
    </div>
  );
}

function PluginSlotActionCard(props: { companyId: string; pluginId: string; issueId?: string }) {
  const runHealth = async () => {
    await apiGet(`/plugins/${encodeURIComponent(props.pluginId)}/health`, props.companyId);
  };
  const iframeSrc = `/plugins/${encodeURIComponent(props.pluginId)}/ui?companyId=${encodeURIComponent(props.companyId)}`;
  return (
    <Alert>
      <AlertTitle>Plugin slot mounted</AlertTitle>
      <AlertDescription className="space-y-2">
        <p>Rendering plugin UI from installed artifact bundle.</p>
        <iframe
          title={`plugin-${props.pluginId}-slot`}
          src={iframeSrc}
          className="h-[420px] w-full rounded border bg-background"
        />
        <Button variant="outline" size="sm" onClick={() => void runHealth()}>
          Ping plugin health
        </Button>
      </AlertDescription>
    </Alert>
  );
}
