import { notFound } from "next/navigation";
import { AgentDetailPageClient } from "@/components/agent-detail-page-client";
import { loadWorkspaceData } from "@/lib/workspace-data";

export default async function AgentPage({
  params,
  searchParams
}: {
  params: Promise<{ agentId: string }>;
  searchParams: Promise<{ companyId?: string }>;
}) {
  const { agentId } = await params;
  const { companyId } = await searchParams;
  const workspaceData = await loadWorkspaceData(companyId, {
    include: {
      issues: true,
      agents: true,
      heartbeatRuns: true,
      auditEvents: true,
      costEntries: true,
      projects: true,
      goals: false,
      approvals: false,
      governanceInbox: false,
      attentionItems: false
    }
  });
  const agent = workspaceData.agents.find((entry) => entry.id === agentId);

  if (!workspaceData.companyId || !agent) {
    notFound();
  }

  return (
    <AgentDetailPageClient
      companyId={workspaceData.companyId}
      companies={workspaceData.companies}
      agent={agent}
      agents={workspaceData.agents}
      issues={workspaceData.issues}
      heartbeatRuns={workspaceData.heartbeatRuns}
      costEntries={workspaceData.costEntries}
      auditEvents={workspaceData.auditEvents}
      projects={workspaceData.projects}
    />
  );
}
