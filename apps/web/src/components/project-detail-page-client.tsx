"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { ColumnDef } from "@tanstack/react-table";
import { AppShell } from "@/components/app-shell";
import { CreateIssueModal } from "@/components/modals/create-issue-modal";
import { CreateProjectModal } from "@/components/modals/create-project-modal";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { DataTable } from "@/components/ui/data-table";
import { DataTableColumnHeader } from "@/components/ui/data-table-column-header";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ApiError, apiPut } from "@/lib/api";
import { getStatusBadgeClassName } from "@/lib/status-presentation";
import styles from "./project-detail-page-client.module.scss";
import { MetricCard, SectionHeading } from "./workspace/shared";

interface ProjectRow {
  id: string;
  name: string;
  description: string | null;
  status: "planned" | "active" | "paused" | "blocked" | "completed" | "archived";
  plannedStartAt: string | null;
  executionWorkspacePolicy?: Record<string, unknown> | null;
  workspaces: Array<{
    id: string;
    companyId: string;
    projectId: string;
    name: string;
    cwd: string | null;
    repoUrl: string | null;
    repoRef: string | null;
    isPrimary: boolean;
    createdAt: string;
    updatedAt: string;
  }>;
  primaryWorkspace: {
    id: string;
    companyId: string;
    projectId: string;
    name: string;
    cwd: string | null;
    repoUrl: string | null;
    repoRef: string | null;
    isPrimary: boolean;
    createdAt: string;
    updatedAt: string;
  } | null;
}

interface IssueRow {
  id: string;
  projectId: string;
  assigneeAgentId: string | null;
  title: string;
  status: "todo" | "in_progress" | "blocked" | "in_review" | "done" | "canceled";
  priority: string;
  updatedAt: string;
}

interface AgentRow {
  id: string;
  name: string;
}

interface CostRow {
  tokenInput: number;
  tokenOutput: number;
  usdCost: number;
}

const projectStatusOptions = [
  { value: "planned", label: "Planned" },
  { value: "active", label: "Active" },
  { value: "paused", label: "Paused" },
  { value: "blocked", label: "Blocked" },
  { value: "completed", label: "Completed" },
  { value: "archived", label: "Archived" }
] as const;

function PropertyRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className={styles.projectPropertyRow}>
      <div className={styles.projectPropertyLabel}>{label}</div>
      <div className={styles.projectPropertyValue}>{value}</div>
    </div>
  );
}

function formatDateTime(value: string) {
  return new Date(value).toLocaleString();
}

function formatDate(value: string | null) {
  if (!value) {
    return "Not set";
  }
  return new Date(value).toLocaleDateString();
}

function shortId(value: string) {
  return value.length > 12 ? `${value.slice(0, 8)}...` : value;
}

export function ProjectDetailPageClient({
  companyId,
  companies,
  project,
  goals,
  linkedGoals,
  issues,
  agents,
  costEntries
}: {
  companyId: string;
  companies: Array<{ id: string; name: string }>;
  project: ProjectRow;
  goals: Array<{ id: string; title: string; projectId: string | null }>;
  linkedGoals: Array<{ id: string; title: string }>;
  issues: IssueRow[];
  agents: AgentRow[];
  costEntries: CostRow[];
}) {
  const router = useRouter();
  const [actionError, setActionError] = useState<string | null>(null);
  const [issuesQuery, setIssuesQuery] = useState("");
  const [issuesStatusFilter, setIssuesStatusFilter] = useState<string>("all");
  const [issuesAssigneeFilter, setIssuesAssigneeFilter] = useState<string>("all");
  const agentNameById = useMemo(() => new Map(agents.map((agent) => [agent.id, agent.name])), [agents]);
  const issueStatusOptions = useMemo(
    () => Array.from(new Set(issues.map((issue) => issue.status))).sort((a, b) => a.localeCompare(b)),
    [issues]
  );
  const issueAssigneeOptions = useMemo(
    () =>
      agents
        .filter((agent) => issues.some((issue) => issue.assigneeAgentId === agent.id))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [agents, issues]
  );
  const assigneeIds = useMemo(
    () => new Set(issues.map((issue) => issue.assigneeAgentId).filter((id): id is string => Boolean(id))),
    [issues]
  );
  const filteredIssues = useMemo(() => {
    const normalizedQuery = issuesQuery.trim().toLowerCase();
    return issues.filter((issue) => {
      if (issuesStatusFilter !== "all" && issue.status !== issuesStatusFilter) {
        return false;
      }
      if (issuesAssigneeFilter === "unassigned" && issue.assigneeAgentId) {
        return false;
      }
      if (issuesAssigneeFilter !== "all" && issuesAssigneeFilter !== "unassigned" && issue.assigneeAgentId !== issuesAssigneeFilter) {
        return false;
      }
      if (!normalizedQuery) {
        return true;
      }
      const assigneeName = issue.assigneeAgentId ? (agentNameById.get(issue.assigneeAgentId) ?? "") : "";
      return (
        issue.title.toLowerCase().includes(normalizedQuery) ||
        issue.status.toLowerCase().includes(normalizedQuery) ||
        issue.priority.toLowerCase().includes(normalizedQuery) ||
        assigneeName.toLowerCase().includes(normalizedQuery)
      );
    });
  }, [agentNameById, issues, issuesAssigneeFilter, issuesQuery, issuesStatusFilter]);
  const costSummary = useMemo(
    () =>
      costEntries.reduce(
        (acc, entry) => {
          acc.input += entry.tokenInput;
          acc.output += entry.tokenOutput;
          acc.usd += entry.usdCost;
          return acc;
        },
        { input: 0, output: 0, usd: 0 }
      ),
    [costEntries]
  );

  const issueColumns = useMemo<ColumnDef<IssueRow>[]>(
    () => [
      {
        accessorKey: "title",
        header: ({ column }) => <DataTableColumnHeader column={column} title="Issue" />,
        cell: ({ row }) => (
          <Link href={`/issues/${row.original.id}?companyId=${companyId}`} className={styles.projectDetailLink1}>
            {row.original.title}
          </Link>
        )
      },
      {
        accessorKey: "status",
        header: ({ column }) => <DataTableColumnHeader column={column} title="Status" />,
        cell: ({ row }) => (
          <Badge variant="outline" className={getStatusBadgeClassName(row.original.status)}>
            {row.original.status}
          </Badge>
        )
      },
      {
        accessorKey: "priority",
        header: ({ column }) => <DataTableColumnHeader column={column} title="Priority" />,
        cell: ({ row }) => <Badge variant="outline">{row.original.priority}</Badge>
      },
      {
        id: "assignee",
        header: "Assignee",
        cell: ({ row }) => (
          <div className={styles.projectDetailContainer1}>
            {row.original.assigneeAgentId ? agentNameById.get(row.original.assigneeAgentId) ?? shortId(row.original.assigneeAgentId) : "Unassigned"}
          </div>
        )
      },
      {
        accessorKey: "updatedAt",
        header: ({ column }) => <DataTableColumnHeader column={column} title="Updated" />,
        cell: ({ row }) => <div className={styles.projectDetailContainer1}>{formatDateTime(row.original.updatedAt)}</div>
      }
    ],
    [agentNameById, companyId]
  );
  const projectDescription = project.description?.trim() ? project.description : "No project description yet.";
  const workspaceSummary =
    project.workspaces.length > 0
      ? project.workspaces
          .map((workspace) => {
            const location = workspace.cwd ?? workspace.repoUrl ?? "No location configured";
            return workspace.isPrimary ? `${workspace.name} (primary): ${location}` : `${workspace.name}: ${location}`;
          })
          .join(", ")
      : "No workspaces configured";

  async function updateProjectStatus(status: ProjectRow["status"]) {
    setActionError(null);
    try {
      await apiPut(`/projects/${project.id}`, companyId, { status });
      router.refresh();
    } catch (error) {
      setActionError(error instanceof ApiError ? error.message : "Failed to update project status.");
    }
  }

  const leftPane = (
    <div className={styles.projectDetailContainer2}>
      <SectionHeading
        title={project.name}
        description={"Project details and timeline."}
        actions={
          <div className={styles.projectHeaderActions}>
          <CreateProjectModal
            companyId={companyId}
            goals={goals}
            project={project}
            triggerLabel="Edit project"
            triggerVariant="default"
            triggerSize="sm"
          />
            <CreateIssueModal
              companyId={companyId}
              projects={[{ id: project.id, name: project.name }]}
              agents={agents}
              defaultProjectId={project.id}
              triggerLabel="Create issue"
              triggerVariant="outline"
              triggerSize="sm"
            />
          </div>
        }
      />
      {actionError ? (
        <Alert variant="destructive">
          <AlertTitle>Project update failed</AlertTitle>
          <AlertDescription>{actionError}</AlertDescription>
        </Alert>
      ) : null}
      <div className="ui-stats">
          <MetricCard label="Status" value={project.status} />
          <MetricCard label="Total issues" value={issues.length} />
          <MetricCard label="Open issues" value={issues.filter((issue) => issue.status !== "done" && issue.status !== "canceled").length} />
          <MetricCard label="Total cost" value={'$' + costSummary.usd.toFixed(2)} />
      </div>

      <SectionHeading
        title="Issues"
        description={"View and manage project issues."}
      />

      <DataTable
            columns={issueColumns}
            data={filteredIssues}
            emptyMessage="No issues match current filters."
            toolbarActions={
              <div className={styles.issueFiltersContainer}>
                <Input
                  value={issuesQuery}
                  onChange={(event) => setIssuesQuery(event.target.value)}
                  placeholder="Search title, status, priority, or assignee..."
                  className={styles.issueFiltersInput}
                />
                <Select value={issuesStatusFilter} onValueChange={setIssuesStatusFilter}>
                  <SelectTrigger className={styles.issueFiltersSelect}>
                    <SelectValue placeholder="Status" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All statuses</SelectItem>
                    {issueStatusOptions.map((status) => (
                      <SelectItem key={status} value={status}>
                        {status}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select value={issuesAssigneeFilter} onValueChange={setIssuesAssigneeFilter}>
                  <SelectTrigger className={styles.issueFiltersSelect}>
                    <SelectValue placeholder="Assignee" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All assignees</SelectItem>
                    <SelectItem value="unassigned">Unassigned</SelectItem>
                    {issueAssigneeOptions.map((agent) => (
                      <SelectItem key={agent.id} value={agent.id}>
                        {agent.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            }
          />
    </div>
  );

  const rightPane = (
    <div className={styles.projectDetailContainer6}>
      <Card>
        <CardContent className={styles.projectDetailCardContent2}>
          <Field>
            <FieldLabel>Status</FieldLabel>
            <Select value={project.status} onValueChange={(value) => void updateProjectStatus(value as ProjectRow["status"])}>
              <SelectTrigger className={styles.projectDetailSelectTrigger}>
                <SelectValue placeholder="Select project status" />
              </SelectTrigger>
              <SelectContent>
                {projectStatusOptions.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </CardContent>
      </Card>
      <Card>
        <CardContent className={styles.projectDetailCardContent2}>
          <PropertyRow label="Description" value={projectDescription} />
          <PropertyRow label="Goals" value={linkedGoals.length ? linkedGoals.map((goal) => goal.title).join(", ") : "No linked goals"} />
          <PropertyRow label="Planned start" value={formatDate(project.plannedStartAt)} />
          <PropertyRow label="Workspace" value={project.primaryWorkspace?.name ?? "Not set"} />
          <PropertyRow label="Workspace path" value={project.primaryWorkspace?.cwd ?? project.primaryWorkspace?.repoUrl ?? "Not set"} />
        </CardContent>
      </Card>
    </div>
  );

  return <AppShell leftPane={leftPane} rightPane={rightPane} activeNav="Projects" companies={companies} activeCompanyId={companyId} />;
}
