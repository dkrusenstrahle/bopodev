import { SettingsKnowledgePageClient } from "@/components/settings-knowledge-page-client";
import { loadWorkspaceData } from "@/lib/workspace-data";

export default async function SettingsKnowledgePage({
  searchParams
}: {
  searchParams: Promise<{ companyId?: string; path?: string }>;
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

  return (
    <SettingsKnowledgePageClient companyId={workspaceData.companyId} companies={workspaceData.companies} />
  );
}
