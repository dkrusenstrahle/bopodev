"use client";

import { useEffect, useMemo, useState, type ComponentProps } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { ColumnDef } from "@tanstack/react-table";
import { DndContext, DragOverlay, PointerSensor, closestCenter, useDroppable, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import type { IssueStatus } from "bopodev-contracts";
import { Kanban, Table } from "lucide-react";
import { ApiError, apiPut } from "@/lib/api";
import { getPriorityBadgeClassName, getStatusBadgeClassName } from "@/lib/status-presentation";
import { selectedProjectNameFor } from "@/lib/workspace-logic";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { DataTable } from "@/components/ui/data-table";
import { DataTableColumnHeader } from "@/components/ui/data-table-column-header";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import styles from "./issue-workspace.module.scss";
import { SectionHeading } from "./workspace/shared";

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
const boardColumns = issueStatusOptions as readonly { value: IssueStatus; label: string }[];

const boardSortableTransition = { duration: 70, easing: "ease-out" } as const;
const boardDragDropAnimation = { duration: 90, easing: "ease-out" } as const;

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
  const [query, setQuery] = useState("");
  const [viewMode, setViewMode] = useState<"list" | "board">("list");
  const [actionError, setActionError] = useState<string | null>(null);
  const [boardIssues, setBoardIssues] = useState<IssueRow[]>(issues);
  const [draggingIssueId, setDraggingIssueId] = useState<string | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  const filteredIssues = useMemo(
    () =>
      issues.filter((issue) => {
        const normalizedQuery = query.trim().toLowerCase();
        const matchStatus = statusFilter === "all" || issue.status === statusFilter;
        const matchPriority = priorityFilter === "all" || issue.priority.toLowerCase() === priorityFilter;
        const matchAssignee =
          assigneeFilter === "all" ||
          (assigneeFilter === "unassigned" ? issue.assigneeAgentId === null : issue.assigneeAgentId === assigneeFilter);
        const matchProject = projectFilter === "all" || issue.projectId === projectFilter;
        const matchHierarchy = hierarchyFilter === "all" || issue.parentIssueId === null;
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
        return matchStatus && matchPriority && matchAssignee && matchProject && matchHierarchy && matchQuery;
      }),
    [agents, assigneeFilter, hierarchyFilter, issues, priorityFilter, projectFilter, projects, query, statusFilter]
  );

  const grouped = useMemo(
    () => {
      const initial = boardColumns.reduce(
        (acc, column) => {
          acc[column.value] = [];
          return acc;
        },
        {} as Record<IssueStatus, IssueRow[]>
      );
      for (const issue of boardIssues) {
        if (initial[issue.status]) {
          initial[issue.status].push(issue);
        }
      }
      return initial;
    },
    [boardIssues]
  );
  useEffect(() => {
    setBoardIssues(filteredIssues);
  }, [filteredIssues]);

  async function runIssueAction(action: () => Promise<void>, fallbackMessage: string) {
    setActionError(null);
    try {
      await action();
      router.refresh();
      return true;
    } catch (error) {
      setActionError(error instanceof ApiError ? error.message : fallbackMessage);
      return false;
    }
  }

  async function updateStatus(issueId: string, status: IssueStatus) {
    return runIssueAction(async () => {
      await apiPut(`/issues/${issueId}`, companyId, { status });
    }, "Failed to update issue status.");
  }

  function openIssue(issueId: string) {
    router.push(`/issues/${issueId}?companyId=${companyId}` as Parameters<typeof router.push>[0]);
  }

  function BoardIssueCardFace({
    issue,
    className,
    ...cardProps
  }: { issue: IssueRow; className?: string } & Omit<ComponentProps<typeof Card>, "children">) {
    return (
      <Card className={cn(styles.issueCard1, className)} {...cardProps}>
        <CardContent className={styles.issueCardContent1}>
          <div className={styles.issueCardContainer1}>
            <button type="button" className={styles.issueCardContainer2} onClick={() => openIssue(issue.id)}>
              <div className={styles.issueCardContainer3}>{issue.title}</div>
              <div className={styles.issueCardContainer4}>
                {issue.priority} · {selectedProjectNameFor(issue.projectId, projects)}
              </div>
            </button>
          </div>
        </CardContent>
      </Card>
    );
  }

  const issueColumns = useMemo<ColumnDef<IssueRow>[]>(
    () => [
      {
        accessorKey: "title",
        header: ({ column }) => <DataTableColumnHeader column={column} title="Issue" />,
        cell: ({ row }) => (
          <Link
            href={`/issues/${row.original.id}?companyId=${encodeURIComponent(companyId)}`}
            className="ui-link-medium"
            onClick={(event) => event.stopPropagation()}
          >
            {row.original.title}
          </Link>
        )
      },
      {
        id: "task",
        header: "Task",
        cell: ({ row }) => <div className={styles.savedViewContainer1}>{row.original.id.slice(0, 8).toUpperCase()}</div>
      },
      {
        id: "assignee",
        header: "Agent",
        cell: ({ row }) => (
          <div className={styles.savedViewContainer5}>
            {row.original.assigneeAgentId ? agents.find((agent) => agent.id === row.original.assigneeAgentId)?.name ?? "Unknown" : "Unassigned"}
          </div>
        )
      },
      {
        accessorKey: "priority",
        header: ({ column }) => <DataTableColumnHeader column={column} title="Priority" />,
        cell: ({ row }) => (
          <Badge variant="outline" className={getPriorityBadgeClassName(row.original.priority)}>
            {row.original.priority}
          </Badge>
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
      }
    ],
    [agents, companyId]
  );

  function SortableIssueCard({ issue }: { issue: IssueRow }) {
    const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
      id: issue.id,
      transition: boardSortableTransition
    });
    const cardStyle = transform
      ? {
          transform: `translate3d(${transform.x}px, ${transform.y}px, 0)`,
          transition
        }
      : { transition };

    return (
      <div ref={setNodeRef} style={cardStyle}>
        <BoardIssueCardFace
          issue={issue}
          className={isDragging ? styles.issueBoardCardPlaceholder : undefined}
          {...attributes}
          {...listeners}
        />
      </div>
    );
  }

  function getDropStatus(overId: string) {
    if (overId.startsWith("column:")) {
      return overId.replace("column:", "") as IssueStatus;
    }
    return boardIssues.find((issue) => issue.id === overId)?.status ?? null;
  }

  function BoardColumn({ status, label, items }: { status: IssueStatus; label: string; items: IssueRow[] }) {
    const { setNodeRef, isOver } = useDroppable({
      id: `column:${status}`
    });

    return (
      <Card className={cn(styles.issueBoardColumn, isOver ? styles.issueBoardColumnActive : undefined)} ref={setNodeRef}>
        <CardHeader className={styles.issueBoardColumnHeader}>
          <div className={styles.issueBoardColumnHeaderRow}>
            <CardTitle className={styles.issueCardTitle2}>{label}</CardTitle>
            <Badge variant="outline" className={getStatusBadgeClassName(status)}>
              {items.length}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className={styles.issueBoardColumnContent}>
          <SortableContext items={items.map((issue) => issue.id)} strategy={verticalListSortingStrategy}>
            <div className={styles.issueBoardColumnList}>
              {items.length > 0 ? items.map((issue) => <SortableIssueCard key={issue.id} issue={issue} />) : ''}
            </div>
          </SortableContext>
        </CardContent>
      </Card>
    );
  }

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    setDraggingIssueId(null);
    if (!over) {
      return;
    }

    const issueId = String(active.id);
    const destinationStatus = getDropStatus(String(over.id));
    if (!destinationStatus) {
      return;
    }

    const draggedIssue = boardIssues.find((issue) => issue.id === issueId);
    if (!draggedIssue || draggedIssue.status === destinationStatus) {
      return;
    }

    const previousState = boardIssues;
    setBoardIssues((current) =>
      current.map((issue) =>
        issue.id === issueId ? { ...issue, status: destinationStatus, updatedAt: new Date().toISOString() } : issue
      )
    );

    void updateStatus(issueId, destinationStatus).then((success) => {
      if (!success) {
        setBoardIssues(previousState);
      }
    });
  }

  const issueFilterControls = (
    <div className='ui-toolbar-filters'>
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
    </div>
  );

  const issueViewToggle = (
    <ButtonGroup className={styles.issueViewToggleGroup}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="outline"
            size="icon"
            className={cn(styles.issueViewToggleButton, viewMode === "list" ? styles.issueViewToggleButtonActive : undefined)}
            onClick={() => setViewMode("list")}
            aria-label="List view"
          >
            <Table className="size-4" aria-hidden />
          </Button>
        </TooltipTrigger>
        <TooltipContent>List</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="outline"
            size="icon"
            className={cn(styles.issueViewToggleButton, viewMode === "board" ? styles.issueViewToggleButtonActive : undefined)}
            onClick={() => setViewMode("board")}
            aria-label="Board view"
          >
            <Kanban className="size-4" aria-hidden />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Board</TooltipContent>
      </Tooltip>
    </ButtonGroup>
  );

  const boardToolbarControls = (
    <div className={styles.issueFiltersToolbar}>
      {issueFilterControls}
      <div className={styles.issueFiltersToggleRight}>{issueViewToggle}</div>
    </div>
  );

  const boardDragOverlayIssue = draggingIssueId ? boardIssues.find((i) => i.id === draggingIssueId) : undefined;

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
          {viewMode === "list" ? (
            <DataTable
              columns={issueColumns}
              data={filteredIssues}
              emptyMessage="No issues match the current view."
              onRowClick={(issue) => openIssue(issue.id)}
              toolbarActions={issueFilterControls}
              toolbarTrailing={issueViewToggle}
              showViewOptions
            />
          ) : (
            <div className={styles.issueCardContainer13}>
              {boardToolbarControls}
              <div className={styles.issueBoardColumnsScroll}>
                <DndContext
                  sensors={sensors}
                  collisionDetection={closestCenter}
                  onDragStart={(event) => setDraggingIssueId(String(event.active.id))}
                  onDragCancel={() => setDraggingIssueId(null)}
                  onDragEnd={handleDragEnd}
                >
                  <div className={styles.issueBoardTrack}>
                    <div className={styles.issueCardContainer15}>
                      {boardColumns.map((column) => (
                        <BoardColumn key={column.value} status={column.value} label={column.label} items={grouped[column.value] ?? []} />
                      ))}
                    </div>
                  </div>
                  <DragOverlay dropAnimation={boardDragDropAnimation}>
                    {boardDragOverlayIssue ? (
                      <BoardIssueCardFace issue={boardDragOverlayIssue} className={styles.issueBoardDragGhost} />
                    ) : null}
                  </DragOverlay>
                </DndContext>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

