"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { ColumnDef } from "@tanstack/react-table";
import type { IssueStatus } from "bopodev-contracts";
import { ConfirmActionModal } from "@/components/modals/confirm-action-modal";
import { CreateIssueModal } from "@/components/modals/create-issue-modal";
import { ApiError, apiDelete, apiPut } from "@/lib/api";
import { getStatusBadgeClassName } from "@/lib/status-presentation";
import { resolveWindowStart, selectedProjectNameFor } from "@/lib/workspace-logic";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { DataTable } from "@/components/ui/data-table";
import { DataTableColumnHeader } from "@/components/ui/data-table-column-header";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import styles from "./issue-workspace.module.scss";
import { MetricCard, SectionHeading } from "./workspace/shared";

interface IssueRow {
  id: string;
  projectId: string;
  parentIssueId: string | null;
  assigneeAgentId: string | null;
  title: string;
  body?: string | null;
  status: IssueStatus;
  priority: string;
  labels?: string[];
  tags?: string[];
  updatedAt: string | Date;
}

interface AgentRow {
  id: string;
  name: string;
}

interface ProjectRow {
  id: string;
  name: string;
}

const issueStatusOptions = [
  { value: "todo", label: "Todo" },
  { value: "in_progress", label: "In progress" },
  { value: "blocked", label: "Blocked" },
  { value: "in_review", label: "In review" },
  { value: "done", label: "Done" },
  { value: "canceled", label: "Canceled" }
] as const;

const priorityOptions = ["all", "none", "low", "medium", "high", "urgent"] as const;

function EmptyState({ children }: { children: React.ReactNode }) {
  return <div className={styles.issueWorkspaceEmptyStateContainer}>{children}</div>;
}

function formatDateTime(value: string | Date) {
  return new Date(value).toLocaleString();
}

function IssueStatusSelect({
  value,
  onValueChange,
  includeAllOption = false
}: {
  value: IssueStatus | "all";
  onValueChange: (value: string) => void;
  includeAllOption?: boolean;
}) {
  return (
    <Select value={value} onValueChange={onValueChange}>
      <SelectTrigger className={styles.issueStatusSelectTrigger}>
        <SelectValue placeholder="Select a status" />
      </SelectTrigger>
      <SelectContent>
        {includeAllOption ? <SelectItem value="all">All statuses</SelectItem> : null}
        {issueStatusOptions.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function IssueWorkspace({
  issues,
  agents,
  projects,
  companyId,
  headerActions
}: {
  issues: IssueRow[];
  agents: AgentRow[];
  projects: ProjectRow[];
  companyId: string;
  headerActions?: React.ReactNode;
}) {
  const router = useRouter();
  const [statusFilter, setStatusFilter] = useState<"all" | IssueStatus>("all");
  const [priorityFilter, setPriorityFilter] = useState<(typeof priorityOptions)[number]>("all");
  const [assigneeFilter, setAssigneeFilter] = useState<string>("all");
  const [projectFilter, setProjectFilter] = useState<string>("all");
  const [hierarchyFilter, setHierarchyFilter] = useState<"top_level" | "all">("top_level");
  const [windowFilter, setWindowFilter] = useState<"today" | "7d" | "30d" | "90d" | "all">("30d");
  const [query, setQuery] = useState("");
  const [viewMode, setViewMode] = useState<"list" | "board">("list");
  const [savedView, setSavedView] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    const raw = window.localStorage.getItem("bopodev_saved_issue_view");
    if (!raw) {
      return;
    }

    try {
      const parsed = JSON.parse(raw) as {
        statusFilter: "all" | IssueStatus;
        priorityFilter?: (typeof priorityOptions)[number];
        viewMode?: "list" | "board";
      };
      setStatusFilter(parsed.statusFilter);
      setPriorityFilter(parsed.priorityFilter ?? "all");
      setSavedView("My Saved View");
    } catch {
      window.localStorage.removeItem("bopodev_saved_issue_view");
    }
  }, []);

  const filteredIssues = useMemo(
    () =>
      issues.filter((issue) => {
        const normalizedQuery = query.trim().toLowerCase();
        const windowStart = resolveWindowStart(windowFilter);
        const matchStatus = statusFilter === "all" || issue.status === statusFilter;
        const matchPriority = priorityFilter === "all" || issue.priority.toLowerCase() === priorityFilter;
        const matchAssignee =
          assigneeFilter === "all" ||
          (assigneeFilter === "unassigned" ? issue.assigneeAgentId === null : issue.assigneeAgentId === assigneeFilter);
        const matchProject = projectFilter === "all" || issue.projectId === projectFilter;
        const matchHierarchy = hierarchyFilter === "all" || issue.parentIssueId === null;
        const matchWindow = !windowStart || new Date(issue.updatedAt) >= windowStart;
        const agentName = issue.assigneeAgentId
          ? agents.find((agent) => agent.id === issue.assigneeAgentId)?.name ?? ""
          : "unassigned";
        const matchQuery =
          normalizedQuery.length === 0 ||
          issue.id.toLowerCase().includes(normalizedQuery) ||
          issue.title.toLowerCase().includes(normalizedQuery) ||
          (issue.body ?? "").toLowerCase().includes(normalizedQuery) ||
          issue.priority.toLowerCase().includes(normalizedQuery) ||
          issue.status.toLowerCase().includes(normalizedQuery) ||
          selectedProjectNameFor(issue.projectId, projects).toLowerCase().includes(normalizedQuery) ||
          agentName.toLowerCase().includes(normalizedQuery);
        return matchStatus && matchPriority && matchAssignee && matchProject && matchHierarchy && matchWindow && matchQuery;
      }),
    [agents, assigneeFilter, hierarchyFilter, issues, priorityFilter, projectFilter, projects, query, statusFilter, windowFilter]
  );

  const grouped = useMemo(
    () => ({
      todo: filteredIssues.filter((issue) => issue.status === "todo"),
      in_progress: filteredIssues.filter((issue) => issue.status === "in_progress"),
      in_review: filteredIssues.filter((issue) => issue.status === "in_review"),
      done: filteredIssues.filter((issue) => issue.status === "done")
    }),
    [filteredIssues]
  );
  const issueSummary = useMemo(() => {
    const total = filteredIssues.length;
    const open = filteredIssues.filter((issue) => issue.status !== "done" && issue.status !== "canceled").length;
    const done = filteredIssues.filter((issue) => issue.status === "done").length;
    const unassigned = filteredIssues.filter((issue) => !issue.assigneeAgentId).length;
    return { total, open, done, unassigned };
  }, [filteredIssues]);

  async function runIssueAction(action: () => Promise<void>, fallbackMessage: string) {
    setActionError(null);
    try {
      await action();
      router.refresh();
    } catch (error) {
      setActionError(error instanceof ApiError ? error.message : fallbackMessage);
    }
  }

  async function updateStatus(issueId: string, status: IssueStatus) {
    await runIssueAction(async () => {
      await apiPut(`/issues/${issueId}`, companyId, { status });
    }, "Failed to update issue status.");
  }

  async function removeIssue(issue: IssueRow) {
    await runIssueAction(async () => {
      await apiDelete(`/issues/${issue.id}`, companyId);
    }, "Failed to delete issue.");
  }

  function openIssue(issueId: string) {
    router.push(`/issues/${issueId}?companyId=${companyId}` as Parameters<typeof router.push>[0]);
  }

  function saveView() {
    window.localStorage.setItem(
      "bopodev_saved_issue_view",
      JSON.stringify({
        statusFilter,
        priorityFilter
      })
    );
    setSavedView("My Saved View");
  }

  const issueColumns = useMemo<ColumnDef<IssueRow>[]>(
    () => [
      {
        id: "task",
        header: "Task",
        cell: ({ row }) => <div className={styles.savedViewContainer1}>{row.original.id.slice(0, 8).toUpperCase()}</div>
      },
      {
        accessorKey: "title",
        header: ({ column }) => <DataTableColumnHeader column={column} title="Issue" />,
        cell: ({ row }) => (
          <div className={styles.savedViewContainer2}>
            <div className={styles.savedViewContainer3}>{row.original.title}</div>
            <div className={styles.savedViewContainer4}>
              {selectedProjectNameFor(row.original.projectId, projects)} · {row.original.body ? "Has description" : "No description"}
            </div>
          </div>
        )
      },
      {
        accessorKey: "priority",
        header: ({ column }) => <DataTableColumnHeader column={column} title="Priority" />,
        cell: ({ row }) => <Badge variant="outline">{row.original.priority}</Badge>
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
        id: "assignee",
        header: "Assignee",
        cell: ({ row }) => (
          <div className={styles.savedViewContainer5}>
            {row.original.assigneeAgentId ? agents.find((agent) => agent.id === row.original.assigneeAgentId)?.name ?? "Unknown" : "Unassigned"}
          </div>
        )
      },
      {
        accessorKey: "updatedAt",
        header: ({ column }) => <DataTableColumnHeader column={column} title="Updated" />,
        cell: ({ row }) => <div className={styles.savedViewContainer5}>{formatDateTime(row.original.updatedAt)}</div>
      },
      {
        id: "actions",
        header: () => <div className={styles.tableHeaderAlignRight}>Actions</div>,
        enableSorting: false,
        cell: ({ row }) => {
          const issue = row.original;
          return (
            <div className={styles.savedViewContainer6} onClick={(event) => event.stopPropagation()}>
              <CreateIssueModal
                companyId={companyId}
                projects={projects}
                agents={agents}
                issue={issue}
                triggerLabel="Edit"
                triggerVariant="outline"
                triggerSize="sm"
              />
              <ConfirmActionModal
                triggerLabel="Delete"
                title="Delete issue?"
                description={`Delete "${issue.title}".`}
                confirmLabel="Delete"
                onConfirm={() => removeIssue(issue)}
              />
            </div>
          );
        }
      }
    ],
    [agents, companyId, projects]
  );

  function renderIssueCard(issue: IssueRow) {
    return (
      <Card key={issue.id} className={styles.issueCard1}>
        <CardContent className={styles.issueCardContent1}>
          <div className={styles.issueCardContainer1}>
            <div className={styles.issueCardContainer2} onClick={() => openIssue(issue.id)}>
              <div className={styles.issueCardContainer3}>{issue.title}</div>
              <div className={styles.issueCardContainer4}>
                {issue.priority} · {selectedProjectNameFor(issue.projectId, projects)} · {formatDateTime(issue.updatedAt)}
              </div>
            </div>
            <div className={styles.issueCardContainer5}>
              <CreateIssueModal
                companyId={companyId}
                projects={projects}
                agents={agents}
                issue={issue}
                triggerLabel="Edit"
                triggerVariant="outline"
                triggerSize="sm"
              />
              <ConfirmActionModal
                triggerLabel="Delete"
                title="Delete issue?"
                description={`Delete "${issue.title}".`}
                confirmLabel="Delete"
                onConfirm={() => removeIssue(issue)}
              />
            </div>
          </div>
          <div className={styles.issueCardContainer5}>
            <IssueStatusSelect value={issue.status} onValueChange={(value) => void updateStatus(issue.id, value as IssueStatus)} />
            {issue.labels?.slice(0, 2).map((label) => (
              <Badge key={label} variant="secondary">
                {label}
              </Badge>
            ))}
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className={styles.issueCardContainer6}>
      <div className={styles.issueCardContainer6}>
        <div className={styles.issueCardContainer7}>
          <div className={styles.issueCardContainer8}>
            <SectionHeading
              title="Issues"
              description="The active things your AI workforce is working on."
            />
          </div>
          <div className={styles.issueCardContainer9}>
            <div className={styles.issueCardContainer10}>
              {headerActions}
            </div>
          </div>
        </div>
        <div className={styles.issueCardContainer11}>
          {actionError ? <div className={styles.issueCardContainer12}>{actionError}</div> : null}
          <div className="ui-stats">
            <MetricCard label="Total issues" value={issueSummary.total} />
            <MetricCard label="Open issues" value={issueSummary.open} />
            <MetricCard label="Done issues" value={issueSummary.done} />
            <MetricCard label="Unassigned issues" value={issueSummary.unassigned} />
          </div>
          {viewMode === "list" ? (
            <DataTable
              columns={issueColumns}
              data={filteredIssues}
              emptyMessage="No issues match the current view."
              onRowClick={(issue) => openIssue(issue.id)}
              toolbarActions={
                <div className={styles.issueFiltersCardContent}>
                  <Input
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="Search issue title, id, status, assignee, or project..."
                    className={styles.issueFiltersInput}
                  />
                  <IssueStatusSelect
                    value={statusFilter}
                    onValueChange={(value) => setStatusFilter(value as "all" | IssueStatus)}
                    includeAllOption
                  />
                  <Select value={priorityFilter} onValueChange={(value) => setPriorityFilter(value as (typeof priorityOptions)[number])}>
                    <SelectTrigger className={styles.issueCardSelectTrigger}>
                      <SelectValue placeholder="Priority" />
                    </SelectTrigger>
                    <SelectContent>
                      {priorityOptions.map((option) => (
                        <SelectItem key={option} value={option}>
                          {option === "all" ? "All priorities" : `${option.slice(0, 1).toUpperCase()}${option.slice(1)}`}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Select value={assigneeFilter} onValueChange={setAssigneeFilter}>
                    <SelectTrigger className={styles.issueCardSelectTrigger}>
                      <SelectValue placeholder="Assignee" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All assignees</SelectItem>
                      {agents.map((agent) => (
                        <SelectItem key={agent.id} value={agent.id}>
                          {agent.name}
                        </SelectItem>
                      ))}
                      <SelectItem value="unassigned">Unassigned</SelectItem>
                    </SelectContent>
                  </Select>
                  <Select value={projectFilter} onValueChange={setProjectFilter}>
                    <SelectTrigger className={styles.issueCardSelectTrigger}>
                      <SelectValue placeholder="Project" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All projects</SelectItem>
                      {projects.map((project) => (
                        <SelectItem key={project.id} value={project.id}>
                          {project.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Select
                    value={windowFilter}
                    onValueChange={(value) => setWindowFilter(value as "today" | "7d" | "30d" | "90d" | "all")}
                  >
                    <SelectTrigger className={styles.issueCardSelectTrigger}>
                      <SelectValue placeholder="Window" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="today">Today</SelectItem>
                      <SelectItem value="7d">Last 7 days</SelectItem>
                      <SelectItem value="30d">Last 30 days</SelectItem>
                      <SelectItem value="90d">Last 90 days</SelectItem>
                      <SelectItem value="all">All time</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              }
              showViewOptions
            />
          ) : (
            <div className={styles.issueCardContainer13}>
              <div className={styles.issueCardContainer15}>
                {Object.entries(grouped).map(([column, items]) => (
                  <Card key={column} className={styles.issueCard2}>
                    <CardHeader className={styles.issueCardHeader}>
                      <CardTitle className={styles.issueCardTitle2}>{column.replace("_", " ")}</CardTitle>
                      <CardDescription>{items.length} issues</CardDescription>
                    </CardHeader>
                    <CardContent className={styles.issueCardContent2}>
                      {items.length > 0 ? items.map((issue) => renderIssueCard(issue)) : <EmptyState>No issues in this column.</EmptyState>}
                    </CardContent>
                  </Card>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

