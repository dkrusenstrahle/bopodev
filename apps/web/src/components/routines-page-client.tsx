"use client";

import Link from "next/link";
import type { Route } from "next";
import type { ColumnDef } from "@tanstack/react-table";
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { AgentAvatar } from "@/components/agent-avatar";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger
} from "@/components/ui/dialog";
import { DataTable } from "@/components/ui/data-table";
import { DataTableColumnHeader } from "@/components/ui/data-table-column-header";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { FieldLabelWithHelp } from "@/components/ui/field-label-with-help";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { LazyMarkdownMdxEditor } from "@/components/modals/lazy-markdown-mdx-editor";
import { ApiError, apiGet, apiPost } from "@/lib/api";
import { agentAvatarSeed } from "@/lib/agent-avatar";
import { getStatusBadgeClassName } from "@/lib/status-presentation";
import { formatSmartDateTime } from "@/lib/smart-date";
import type { WorkspacePageProps } from "@/components/workspace/workspace-page-props";
import { SectionHeading } from "@/components/workspace/shared";

type RoutineRow = {
  id: string;
  title: string;
  projectId: string;
  assigneeAgentId: string;
  status: string;
  concurrencyPolicy: string;
  catchUpPolicy: string;
  lastTriggeredAt: string | null;
  updatedAt: string;
};

function formatConcurrencyLabel(policy: string) {
  switch (policy) {
    case "coalesce_if_active":
      return "Coalesce if active";
    case "skip_if_active":
      return "Skip if active";
    case "always_enqueue":
      return "Always enqueue";
    default:
      return policy.replaceAll("_", " ");
  }
}

function formatCatchUpLabel(policy: string) {
  switch (policy) {
    case "skip_missed":
      return "Skip missed";
    case "enqueue_missed_with_cap":
      return "Enqueue missed (capped)";
    default:
      return policy.replaceAll("_", " ");
  }
}

export function RoutinesPageClient(props: WorkspacePageProps) {
  const { companyId, companies, projects, agents } = props;
  const router = useRouter();
  const [loops, setLoops] = useState<RoutineRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [projectId, setProjectId] = useState(projects[0]?.id ?? "");
  const [assigneeId, setAssigneeId] = useState(agents[0]?.id ?? "");
  const [concurrencyPolicy, setConcurrencyPolicy] = useState("coalesce_if_active");
  const [catchUpPolicy, setCatchUpPolicy] = useState("skip_missed");
  const [submitting, setSubmitting] = useState(false);
  const [createInstructionsMdxKey, setCreateInstructionsMdxKey] = useState(0);

  const [loopsQuery, setLoopsQuery] = useState("");
  const [loopsStatusFilter, setLoopsStatusFilter] = useState<"all" | "active" | "paused" | "archived">("all");
  const [loopsProjectFilter, setLoopsProjectFilter] = useState<"all" | string>("all");

  const load = useCallback(async () => {
    if (!companyId) {
      setLoops([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await apiGet<{ data: RoutineRow[] }>("/routines", companyId);
      setLoops(res.data.data ?? []);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Failed to load routines.");
      setLoops([]);
    } finally {
      setLoading(false);
    }
  }, [companyId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    if (!companyId || !projectId || !assigneeId || !title.trim()) {
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await apiPost("/routines", companyId, {
        projectId,
        title: title.trim(),
        description: description.trim() || null,
        assigneeAgentId: assigneeId,
        concurrencyPolicy,
        catchUpPolicy
      });
      setCreateOpen(false);
      setTitle("");
      setDescription("");
      await load();
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to create routine.");
    } finally {
      setSubmitting(false);
    }
  }

  const projectById = useMemo(() => new Map(projects.map((p) => [p.id, p.name])), [projects]);
  const agentById = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents]);

  const filteredLoops = useMemo(() => {
    const normalizedQuery = loopsQuery.trim().toLowerCase();
    return loops.filter((loop) => {
      if (loopsStatusFilter !== "all" && loop.status !== loopsStatusFilter) {
        return false;
      }
      if (loopsProjectFilter !== "all" && loop.projectId !== loopsProjectFilter) {
        return false;
      }
      if (!normalizedQuery) {
        return true;
      }
      const projectName = projectById.get(loop.projectId) ?? "";
      const agentName = agentById.get(loop.assigneeAgentId)?.name ?? "";
      return (
        loop.title.toLowerCase().includes(normalizedQuery) ||
        projectName.toLowerCase().includes(normalizedQuery) ||
        agentName.toLowerCase().includes(normalizedQuery) ||
        loop.status.toLowerCase().includes(normalizedQuery) ||
        loop.concurrencyPolicy.toLowerCase().includes(normalizedQuery) ||
        loop.catchUpPolicy.toLowerCase().includes(normalizedQuery)
      );
    });
  }, [agentById, loops, loopsProjectFilter, loopsQuery, loopsStatusFilter, projectById]);

  const loopColumns = useMemo<ColumnDef<RoutineRow>[]>(
    () => [
      {
        accessorKey: "title",
        header: ({ column }) => <DataTableColumnHeader column={column} title="Routine" />,
        cell: ({ row }) =>
          companyId ? (
            <Link
              href={`/routines/${row.original.id}${companyId ? `?companyId=${encodeURIComponent(companyId)}` : ""}` as Route}
              className="ui-link-primary-sm"
            >
              {row.original.title}
            </Link>
          ) : (
            <span className="ui-font-medium">{row.original.title}</span>
          )
      },
      {
        id: "project",
        accessorFn: (row) => projectById.get(row.projectId) ?? row.projectId,
        header: ({ column }) => <DataTableColumnHeader column={column} title="Project" />,
        cell: ({ row }) => (
          <span className="ui-text-muted">{projectById.get(row.original.projectId) ?? row.original.projectId}</span>
        )
      },
      {
        id: "assignee",
        header: ({ column }) => <DataTableColumnHeader column={column} title="Agent" />,
        cell: ({ row }) => {
          const agent = agentById.get(row.original.assigneeAgentId);
          const name = agent?.name ?? row.original.assigneeAgentId;
          return (
            <div className="ui-routine-table-assignee-row">
              <AgentAvatar
                seed={agentAvatarSeed(row.original.assigneeAgentId, name, agent?.avatarSeed ?? undefined)}
                name={name}
                lucideIconName={agent?.lucideIconName}
                className="ui-avatar-thumb-routine"
                size={48}
              />
              <span className="ui-truncate">{name}</span>
            </div>
          );
        }
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
        id: "lastRun",
        header: ({ column }) => <DataTableColumnHeader column={column} title="Last run" />,
        accessorFn: (row) => row.lastTriggeredAt ?? "",
        cell: ({ row }) => (
          <span className="ui-text-muted ui-tabular-nums">
            {row.original.lastTriggeredAt ? formatSmartDateTime(row.original.lastTriggeredAt) : "—"}
          </span>
        )
      }
    ],
    [agentById, companyId, projectById]
  );

  const emptyMessage = loading
    ? "Loading routines…"
    : loops.length === 0
      ? "No routines yet. Create a routine, add schedule triggers, and assign an agent."
      : "No routines match current filters.";

  return (
    <AppShell
      leftPane={
        <>
          <SectionHeading
            title="Routines"
            description="Recurring work that opens issues and wakes assignees on a schedule."
            actions={
              <Dialog
                open={createOpen}
                onOpenChange={(next) => {
                  setCreateOpen(next);
                  if (next) {
                    setCreateInstructionsMdxKey((k) => k + 1);
                  }
                }}
              >
                <DialogTrigger asChild>
                  <Button size="sm" disabled={!companyId || projects.length === 0 || agents.length === 0}>
                    New routine
                  </Button>
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>Create routine</DialogTitle>
                    <DialogDescription>Create a new routine to open issues and wake assignees on a schedule.</DialogDescription>
                  </DialogHeader>
                  <form onSubmit={onCreate}>
                    <div className="ui-dialog-content-scrollable">
                    <FieldGroup>
                      <Field>
                        <FieldLabel>Title</FieldLabel>
                        <Input value={title} onChange={(ev) => setTitle(ev.target.value)} required />
                      </Field>
                      <Field>
                        <FieldLabelWithHelp helpText="Becomes the new issue body when the routine runs. The markdown editor shows formatted text as you type; the routine and issue pages render the same Markdown (headings, lists, links, GFM tables).">
                          Instructions
                        </FieldLabelWithHelp>
                        <LazyMarkdownMdxEditor
                          editorKey={`routine-create-instructions-${createInstructionsMdxKey}`}
                          markdown={description}
                          onChange={setDescription}
                          placeholder="Instructions for each run…"
                        />
                      </Field>
                      <Field>
                        <FieldLabel>Project</FieldLabel>
                        <Select value={projectId} onValueChange={setProjectId}>
                          <SelectTrigger>
                            <SelectValue placeholder="Project" />
                          </SelectTrigger>
                          <SelectContent>
                            {projects.map((p) => (
                              <SelectItem key={p.id} value={p.id}>
                                {p.name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </Field>
                      <Field>
                        <FieldLabel>Agent</FieldLabel>
                        <Select value={assigneeId} onValueChange={setAssigneeId}>
                          <SelectTrigger>
                            <SelectValue placeholder="Agent" />
                          </SelectTrigger>
                          <SelectContent>
                            {agents.map((a) => (
                              <SelectItem key={a.id} value={a.id}>
                                {a.name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </Field>
                      </FieldGroup>
                      <FieldGroup>
                        <Field>
                          <FieldLabel>If another run is already open</FieldLabel>
                          <Select value={concurrencyPolicy} onValueChange={setConcurrencyPolicy}>
                            <SelectTrigger>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="coalesce_if_active">Reuse the existing open item</SelectItem>
                              <SelectItem value="skip_if_active">Skip this run</SelectItem>
                              <SelectItem value="always_enqueue">Create a new item anyway</SelectItem>
                            </SelectContent>
                          </Select>
                        </Field>
                        <Field>
                          <FieldLabel>If some scheduled runs were missed</FieldLabel>
                          <Select value={catchUpPolicy} onValueChange={setCatchUpPolicy}>
                            <SelectTrigger>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="skip_missed">Ignore missed runs</SelectItem>
                              <SelectItem value="enqueue_missed_with_cap">Catch up missed runs (limited)</SelectItem>
                            </SelectContent>
                          </Select>
                        </Field>
                      </FieldGroup>
                    </div>
                    <DialogFooter>
                      <Button type="submit" disabled={submitting}>
                        {submitting ? "Creating…" : "Create"}
                      </Button>
                    </DialogFooter>
                  </form>
                </DialogContent>
              </Dialog>
            }
          />
          {error ? (
            <p className="ui-form-error-text" role="alert">
              {error}
            </p>
          ) : null}
          <DataTable
            columns={loopColumns}
            data={loading ? [] : filteredLoops}
            emptyMessage={emptyMessage}
            showHorizontalScrollbarOnHover
            toolbarActions={
              <div className="ui-toolbar-filters">
                <Input
                  value={loopsQuery}
                  onChange={(event) => setLoopsQuery(event.target.value)}
                  placeholder="Search title, project, assignee, or policies…"
                  className="ui-toolbar-filter-input"
                  disabled={loading}
                />
                <Select
                  value={loopsStatusFilter}
                  onValueChange={(value) =>
                    setLoopsStatusFilter(value as "all" | "active" | "paused" | "archived")
                  }
                  disabled={loading}
                >
                  <SelectTrigger className="ui-toolbar-filter-select">
                    <SelectValue placeholder="Status" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All statuses</SelectItem>
                    <SelectItem value="active">Active</SelectItem>
                    <SelectItem value="paused">Paused</SelectItem>
                    <SelectItem value="archived">Archived</SelectItem>
                  </SelectContent>
                </Select>
                <Select value={loopsProjectFilter} onValueChange={setLoopsProjectFilter} disabled={loading}>
                  <SelectTrigger className="ui-toolbar-filter-select">
                    <SelectValue placeholder="Project" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All projects</SelectItem>
                    {projects.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            }
          />
        </>
      }
      activeNav="Routines"
      companies={companies}
      activeCompanyId={companyId}
    />
  );
}
