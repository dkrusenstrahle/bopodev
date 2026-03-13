import { TemplatesPageClient } from "@/components/workspace/templates-page-client";
import { loadWorkspaceData } from "@/lib/workspace-data";

export default async function TemplatesPage({
  searchParams
}: {
  searchParams: Promise<{ companyId?: string }>;
}) {
  const { companyId } = await searchParams;
  const workspaceData = await loadWorkspaceData(companyId, {
    include: {
      issues: false,
      heartbeatRuns: false,
      goals: false,
      approvals: false,
      governanceInbox: false,
      auditEvents: false,
      costEntries: false,
      projects: false
    }
  });

  return (
    <TemplatesPageClient
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
      templates={workspaceData.templates}
    />
  );
}
