import { apiGet } from "@/lib/api";
import { PluginsPageClient } from "./plugins-page-client";

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

const defaultCompanyId = process.env.NEXT_PUBLIC_DEFAULT_COMPANY_ID ?? "demo-company";

export default async function PluginSettingsPage({
  searchParams
}: {
  searchParams: Promise<{ companyId?: string }>;
}) {
  const params = await searchParams;
  const companyId = params.companyId ?? defaultCompanyId;
  const result = (await apiGet("/plugins", companyId)) as { ok: boolean; data: PluginRow[] };
  return <PluginsPageClient companyId={companyId} initialPlugins={result.data} />;
}
