import { notFound } from "next/navigation";
import { ProjectDetailPageClient } from "@/components/project-detail-page-client";
import { loadWorkspaceData } from "@/lib/workspace-data";

export default async function ProjectPage({
  params,
  searchParams
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<{ companyId?: string }>;
}) {
  const { projectId } = await params;
  const { companyId } = await searchParams;
  const workspaceData = await loadWorkspaceData(companyId, {
    include: {
      projects: true,
      goals: true,
      issues: true,
      agents: true,
      costEntries: true,
      heartbeatRuns: false,
      approvals: false,
      governanceInbox: false,
      attentionItems: false,
      auditEvents: false
    }
  });
  const project = workspaceData.projects.find((entry) => entry.id === projectId);

  if (!workspaceData.companyId || !project) {
    notFound();
  }

  return (
    <ProjectDetailPageClient
      companyId={workspaceData.companyId}
      companies={workspaceData.companies}
      project={project}
      goals={workspaceData.goals.map((goal) => ({
        id: goal.id,
        title: goal.title,
        level: goal.level,
        projectId: goal.projectId,
        parentGoalId: goal.parentGoalId
      }))}
      linkedGoals={workspaceData.goals.filter((goal) => goal.projectId === project.id)}
      issues={workspaceData.issues.filter((issue) => issue.projectId === project.id)}
      agents={workspaceData.agents}
      costEntries={workspaceData.costEntries.filter((entry) => entry.projectId === project.id)}
    />
  );
}
