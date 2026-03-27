import { AssistantPageClient } from "@/components/workspace/assistant-page-client";
import { loadWorkspaceData } from "@/lib/workspace-data";

export default async function ChatPage({ searchParams }: { searchParams: Promise<{ companyId?: string }> }) {
  const { companyId } = await searchParams;
  const workspaceData = await loadWorkspaceData(companyId, {
    include: {
      issues: false,
      agents: false,
      heartbeatRuns: false,
      approvals: false,
      costEntries: false,
      goals: false,
      governanceInbox: false,
      attentionItems: false,
      auditEvents: false,
      projects: false,
      templates: false
    }
  });

  return (
    <AssistantPageClient companyId={workspaceData.companyId} companies={workspaceData.companies} />
  );
}
