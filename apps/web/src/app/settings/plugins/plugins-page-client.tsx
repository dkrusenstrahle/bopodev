"use client";

import { apiGet, apiPost, apiPut } from "@/lib/api";
import { useMemo, useState, useTransition } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from "@/components/ui/table";
import { SectionHeading, formatDateTime } from "@/components/workspace/shared";

type PluginRow = {
  id: string;
  name: string;
  version: string;
  kind: string;
  runtimeType: string;
  runtimeEntrypoint: string;
  hooks: string[];
  capabilities: string[];
  companyConfig: {
    enabled: boolean;
    priority: number;
    config: Record<string, unknown>;
    grantedCapabilities: string[];
  } | null;
};

type PluginRunRow = {
  id: string;
  runId: string | null;
  pluginId: string;
  hook: string;
  status: string;
  createdAt: string;
  diagnostics?: Record<string, unknown>;
};

export function PluginsPageClient(props: { companyId: string; initialPlugins: PluginRow[] }) {
  const { companyId } = props;
  const [plugins, setPlugins] = useState<PluginRow[]>(props.initialPlugins);
  const [selectedPluginId, setSelectedPluginId] = useState<string | null>(null);
  const [previewRuns, setPreviewRuns] = useState<PluginRunRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const selectedPlugin = useMemo(
    () => (selectedPluginId ? plugins.find((plugin) => plugin.id === selectedPluginId) ?? null : null),
    [selectedPluginId, plugins]
  );

  const fetchPlugins = async () => {
    const response = (await apiGet("/plugins", companyId)) as { ok: true; data: PluginRow[] };
    setPlugins(response.data);
  };

  const refreshPlugins = () =>
    startTransition(async () => {
      try {
        await fetchPlugins();
        setError(null);
      } catch (nextError) {
        setError(String(nextError));
      }
    });

  const installPlugin = (pluginId: string) =>
    startTransition(async () => {
      try {
        await apiPost(`/plugins/${encodeURIComponent(pluginId)}/install`, companyId, {});
        await fetchPlugins();
        setError(null);
      } catch (nextError) {
        setError(String(nextError));
      }
    });

  const setPluginEnabled = (plugin: PluginRow, enabled: boolean) =>
    startTransition(async () => {
      try {
        await apiPut(`/plugins/${encodeURIComponent(plugin.id)}`, companyId, {
          enabled,
          priority: plugin.companyConfig?.priority ?? 100,
          grantedCapabilities: plugin.companyConfig?.grantedCapabilities ?? [],
          config: plugin.companyConfig?.config ?? {},
          requestApproval: false
        });
        await fetchPlugins();
        setError(null);
      } catch (nextError) {
        setError(String(nextError));
      }
    });

  const previewPluginRuns = (pluginId: string) =>
    startTransition(async () => {
      try {
        const response = (await apiGet(
          `/plugins/runs?pluginId=${encodeURIComponent(pluginId)}&limit=25`,
          companyId
        )) as { ok: true; data: PluginRunRow[] };
        setSelectedPluginId(pluginId);
        setPreviewRuns(response.data);
        setError(null);
      } catch (nextError) {
        setError(String(nextError));
      }
    });

  return (
    <div className="ui-stack-lg">
      <SectionHeading
        title="Plugins"
        description="Install plugins to this company, activate/deactivate them, and preview recent plugin execution runs."
      />
      {error ? (
        <Card>
          <CardContent className="ui-pt-4">
            <div className="ui-text-destructive">{error}</div>
          </CardContent>
        </Card>
      ) : null}
      <Card>
        <CardHeader>
          <CardTitle>Plugin Catalog</CardTitle>
          <CardDescription>Manage install and activation status per plugin.</CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Plugin</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Capabilities</TableHead>
                <TableHead>Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {plugins.map((plugin) => {
                const installed = Boolean(plugin.companyConfig);
                const active = Boolean(plugin.companyConfig?.enabled);
                return (
                  <TableRow key={plugin.id}>
                    <TableCell>
                      <div className="ui-stack-xs">
                        <div className="ui-font-medium">{plugin.name}</div>
                        <div className="ui-text-xs ui-text-muted">
                          {plugin.id} · {plugin.version} · {plugin.kind}
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>
                      {installed ? (
                        active ? (
                          <Badge>Active</Badge>
                        ) : (
                          <Badge variant="secondary">Installed</Badge>
                        )
                      ) : (
                        <Badge variant="outline">Not installed</Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="ui-flex ui-gap-xs ui-flex-wrap">
                        {plugin.capabilities.length > 0 ? (
                          plugin.capabilities.map((capability) => (
                            <Badge key={`${plugin.id}-${capability}`} variant="outline">
                              {capability}
                            </Badge>
                          ))
                        ) : (
                          <span className="ui-text-sm ui-text-muted">-</span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="ui-flex ui-gap-sm ui-flex-wrap">
                        {!installed ? (
                          <Button variant="outline" size="sm" disabled={isPending} onClick={() => installPlugin(plugin.id)}>
                            Install
                          </Button>
                        ) : active ? (
                          <Button variant="outline" size="sm" disabled={isPending} onClick={() => setPluginEnabled(plugin, false)}>
                            Deactivate
                          </Button>
                        ) : (
                          <Button variant="outline" size="sm" disabled={isPending} onClick={() => setPluginEnabled(plugin, true)}>
                            Activate
                          </Button>
                        )}
                        <Button variant="outline" size="sm" disabled={isPending} onClick={() => previewPluginRuns(plugin.id)}>
                          Preview
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {selectedPlugin ? (
        <Card>
          <CardHeader>
            <CardTitle>Preview: {selectedPlugin.name}</CardTitle>
            <CardDescription>Recent plugin runs and diagnostics payloads.</CardDescription>
          </CardHeader>
          <CardContent className="ui-stack-md">
          {previewRuns.length === 0 ? (
            <div className="ui-text-sm ui-text-muted">No plugin runs found yet for this plugin.</div>
          ) : (
            <div className="ui-stack-sm">
              {previewRuns.map((row) => (
                <Card key={row.id}>
                  <CardContent className="ui-pt-4 ui-stack-xs">
                    <div className="ui-text-xs ui-text-muted">
                      {formatDateTime(row.createdAt)} · run {row.runId ?? "n/a"}
                    </div>
                    <div className="ui-flex ui-gap-sm ui-items-center">
                      <span className="ui-font-medium">{row.hook}</span>
                      <Badge variant={row.status === "ok" ? "default" : row.status === "blocked" ? "destructive" : "secondary"}>
                        {row.status}
                      </Badge>
                    </div>
                    <pre className="ui-text-xs">{JSON.stringify(row.diagnostics ?? {}, null, 2)}</pre>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
