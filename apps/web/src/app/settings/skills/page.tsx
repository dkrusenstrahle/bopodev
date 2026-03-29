import { SettingsSkillsPageClient } from "@/components/settings-skills-page-client";
import { loadWorkspaceData } from "@/lib/workspace-data";

export default async function SettingsSkillsPage({
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

  return (
    <SettingsSkillsPageClient companyId={workspaceData.companyId} companies={workspaceData.companies} />
  );
}
