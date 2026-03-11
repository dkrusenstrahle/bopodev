import { apiGet } from "@/lib/api";
import { loadWorkspaceData } from "@/lib/workspace-data";
import { PluginsWorkspacePageClient } from "@/components/workspace/plugins-page-client";
import type { PluginRow } from "@/components/workspace/types";

export default async function PluginsPage({
  searchParams
}: {
  searchParams: Promise<{ companyId?: string }>;
}) {
  const { companyId } = await searchParams;
  const workspaceData = await loadWorkspaceData(companyId, {
    include: {
      issues: false,
      agents: false,
      heartbeatRuns: false,
      goals: false,
      approvals: false,
      governanceInbox: false,
      auditEvents: false,
      costEntries: false,
      projects: false
    }
  });
  const scopedCompanyId = workspaceData.companyId;
  const plugins =
    scopedCompanyId !== null
      ? ((await apiGet("/plugins", scopedCompanyId)) as { ok: true; data: PluginRow[] }).data
      : [];

  return (
    <PluginsWorkspacePageClient
      companyId={workspaceData.companyId}
      activeCompany={workspaceData.activeCompany}
      companies={workspaceData.companies}
      issues={workspaceData.issues}
      agents={workspaceData.agents}
      heartbeatRuns={workspaceData.heartbeatRuns}
      goals={workspaceData.goals}
      approvals={workspaceData.approvals}
      governanceInbox={workspaceData.governanceInbox}
      auditEvents={workspaceData.auditEvents}
      costEntries={workspaceData.costEntries}
      projects={workspaceData.projects}
      plugins={plugins}
    />
  );
}
