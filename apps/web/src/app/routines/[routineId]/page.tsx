import { notFound } from "next/navigation";
import { RoutineDetailPageClient } from "@/components/routine-detail-page-client";
import { loadWorkspaceData } from "@/lib/workspace-data";

export default async function RoutineDetailPage({
  params,
  searchParams
}: {
  params: Promise<{ routineId: string }>;
  searchParams: Promise<{ companyId?: string }>;
}) {
  const { routineId } = await params;
  const { companyId } = await searchParams;
  const workspaceData = await loadWorkspaceData(companyId, {
    include: {
      issues: true,
      agents: true,
      heartbeatRuns: false,
      approvals: false,
      costEntries: false,
      projects: true,
      goals: false,
      governanceInbox: false,
      attentionItems: false,
      auditEvents: false
    }
  });

  if (!workspaceData.companyId) {
    notFound();
  }

  return (
    <RoutineDetailPageClient
      routineId={routineId}
      companyId={workspaceData.companyId}
      activeCompany={workspaceData.activeCompany}
      companies={workspaceData.companies}
      issues={workspaceData.issues}
      agents={workspaceData.agents}
      heartbeatRuns={workspaceData.heartbeatRuns}
      goals={workspaceData.goals}
      approvals={workspaceData.approvals}
      attentionItems={workspaceData.attentionItems}
      auditEvents={workspaceData.auditEvents}
      costEntries={workspaceData.costEntries}
      projects={workspaceData.projects}
    />
  );
}
