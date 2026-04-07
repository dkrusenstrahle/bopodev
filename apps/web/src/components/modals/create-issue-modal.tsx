"use client";

import { useEffect, useMemo, useState, type ChangeEvent, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import type { IssuePriority, IssueStatus } from "bopodev-contracts";
import { ApiError, apiDelete, apiGet, apiPost, apiPostFormData, apiPut } from "@/lib/api";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldGroup } from "@/components/ui/field";
import { FieldLabelWithHelp } from "@/components/ui/field-label-with-help";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select";
import { LazyMarkdownMdxEditor } from "@/components/modals/lazy-markdown-mdx-editor";
import styles from "./create-issue-modal.module.scss";

interface ProjectOption {
  id: string;
  name: string;
}

interface AgentOption {
  id: string;
  name: string;
}

interface GoalOption {
  id: string;
  title: string;
  projectId: string | null;
}

interface IssueAttachmentRow {
  id: string;
}

interface IssueResponse {
  id: string;
}

const issueStatusOptions: Array<{ value: IssueStatus; label: string }> = [
  { value: "todo", label: "Todo" },
  { value: "in_progress", label: "In progress" },
  { value: "blocked", label: "Blocked" },
  { value: "in_review", label: "In review" },
  { value: "done", label: "Done" },
  { value: "canceled", label: "Canceled" }
];
const issuePriorityOptions: Array<{ value: IssuePriority; label: string }> = [
  { value: "none", label: "None" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "urgent", label: "Urgent" }
];
function normalizeIssuePriority(value: string | null | undefined): IssuePriority {
  if (value === "low" || value === "medium" || value === "high" || value === "urgent") {
    return value;
  }
  return "none";
}

export function CreateIssueModal({
  companyId,
  projects,
  agents,
  goals = [],
  issue,
  defaultParentIssueId,
  defaultProjectId,
  triggerLabel = "New Issue",
  triggerVariant = "default",
  triggerSize = "sm"
}: {
  companyId: string;
  projects: ProjectOption[];
  agents: AgentOption[];
  goals?: GoalOption[];
  issue?: {
    id: string;
    projectId: string;
    title: string;
    body?: string | null;
    externalLink?: string | null;
    status: IssueStatus;
    priority?: string | null;
    assigneeAgentId?: string | null;
    goalIds?: string[];
    knowledgePaths?: string[];
    labels?: string[];
  };
  defaultParentIssueId?: string | null;
  defaultProjectId?: string;
  triggerLabel?: string;
  triggerVariant?: "default" | "outline" | "secondary" | "ghost" | "destructive";
  triggerSize?: "default" | "sm" | "lg" | "icon";
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [projectId, setProjectId] = useState(issue?.projectId ?? defaultProjectId ?? projects[0]?.id ?? "");
  const [title, setTitle] = useState(issue?.title ?? "");
  const [body, setBody] = useState(issue?.body ?? "");
  const [externalLink, setExternalLink] = useState(issue?.externalLink ?? "");
  const [status, setStatus] = useState<IssueStatus>(issue?.status ?? "todo");
  const [priority, setPriority] = useState<IssuePriority>(normalizeIssuePriority(issue?.priority));
  const [assigneeAgentId, setAssigneeAgentId] = useState<string>(issue?.assigneeAgentId ?? "unassigned");
  const [goalIds, setGoalIds] = useState<string[]>(issue?.goalIds ?? []);
  const [knowledgePaths, setKnowledgePaths] = useState<string[]>(issue?.knowledgePaths ?? []);
  const [knowledgeFileOptions, setKnowledgeFileOptions] = useState<string[]>([]);
  const [labels, setLabels] = useState(issue?.labels?.join(", ") ?? "");
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [bodyMdxKey, setBodyMdxKey] = useState(0);
  const isEditing = Boolean(issue);

  const applicableGoals = useMemo(() => {
    if (!goals.length || !projectId) {
      return [];
    }
    return goals.filter((g) => !g.projectId || g.projectId === projectId);
  }, [goals, projectId]);

  useEffect(() => {
    setGoalIds((prev) => prev.filter((id) => applicableGoals.some((g) => g.id === id)));
  }, [applicableGoals]);

  function toggleIssueGoal(goalId: string, isChecked: boolean) {
    setGoalIds((current) => {
      if (isChecked) {
        if (current.includes(goalId)) {
          return current;
        }
        return [...current, goalId];
      }
      return current.filter((id) => id !== goalId);
    });
  }

  function toggleKnowledgePath(path: string, isChecked: boolean) {
    setKnowledgePaths((current) => {
      if (isChecked) {
        if (current.includes(path)) {
          return current;
        }
        return [...current, path];
      }
      return current.filter((p) => p !== path);
    });
  }

  function hydrateFormFromProps() {
    setProjectId(issue?.projectId ?? defaultProjectId ?? projects[0]?.id ?? "");
    setTitle(issue?.title ?? "");
    setBody(issue?.body ?? "");
    setExternalLink(issue?.externalLink ?? "");
    setStatus(issue?.status ?? "todo");
    setPriority(normalizeIssuePriority(issue?.priority));
    setAssigneeAgentId(issue?.assigneeAgentId ?? "unassigned");
    setGoalIds(issue?.goalIds ?? []);
    setKnowledgePaths(issue?.knowledgePaths ?? []);
    setLabels(issue?.labels?.join(", ") ?? "");
    setSelectedFiles([]);
    setError(null);
  }

  function onFilesSelected(event: ChangeEvent<HTMLInputElement>) {
    setSelectedFiles(Array.from(event.target.files ?? []));
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!projectId) {
      setError("Create a project first, then select it for the new issue.");
      return;
    }

    setIsSubmitting(true);
    setError(null);

    try {
      const payload = {
        projectId,
        parentIssueId: isEditing ? undefined : defaultParentIssueId ?? undefined,
        title,
        body,
        externalLink: externalLink.trim() || null,
        status,
        priority,
        assigneeAgentId: assigneeAgentId === "unassigned" ? null : assigneeAgentId,
        goalIds,
        knowledgePaths,
        labels: labels
          .split(",")
          .map((label) => label.trim())
          .filter(Boolean)
      };

      let issueId = issue?.id;
      if (isEditing && issue) {
        await apiPut(`/issues/${issue.id}`, companyId, payload);
      } else {
        const created = await apiPost<IssueResponse>("/issues", companyId, payload);
        issueId = created.data.id;
      }

      if (issueId && selectedFiles.length > 0) {
        const formData = new FormData();
        selectedFiles.forEach((file) => formData.append("files", file));
        await apiPostFormData<IssueAttachmentRow[]>(`/issues/${issueId}/attachments`, companyId, formData);
      }

      if (!isEditing) {
        setTitle("");
        setBody("");
        setExternalLink("");
        setStatus("todo");
        setPriority("none");
        setAssigneeAgentId("unassigned");
        setLabels("");
        setGoalIds([]);
        setKnowledgePaths([]);
      }
      setSelectedFiles([]);
      setOpen(false);
      router.refresh();
    } catch (submitError) {
      if (submitError instanceof ApiError) {
        setError(submitError.message);
      } else {
        setError(isEditing ? "Failed to update issue." : "Failed to create issue.");
      }
    } finally {
      setIsSubmitting(false);
    }
  }

  async function onDeleteIssue() {
    if (!issue) {
      return;
    }
    setError(null);
    setIsDeleting(true);
    try {
      await apiDelete(`/issues/${issue.id}`, companyId);
      setOpen(false);
      router.push(`/issues?companyId=${companyId}` as Parameters<typeof router.push>[0]);
    } catch (deleteError) {
      if (deleteError instanceof ApiError) {
        setError(deleteError.message);
      } else {
        setError("Failed to delete issue.");
      }
    } finally {
      setIsDeleting(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (nextOpen) {
          hydrateFormFromProps();
          setBodyMdxKey((k) => k + 1);
          void (async () => {
            try {
              const res = await apiGet<{ items: Array<{ relativePath: string }> }>(
                "/observability/company-knowledge",
                companyId
              );
              setKnowledgeFileOptions(res.data.items.map((i) => i.relativePath).sort());
            } catch {
              setKnowledgeFileOptions([]);
            }
          })();
        }
      }}
    >
      <DialogTrigger asChild>
        <Button variant={triggerVariant} size="sm">
          {triggerLabel}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{isEditing ? "Edit issue" : "Create issue"}</DialogTitle>
          <DialogDescription>Use one full issue dialog for both create and edit workflows.</DialogDescription>
        </DialogHeader>
        <form className={styles.createIssueModalForm} onSubmit={onSubmit}>
          <div className="ui-dialog-content-scrollable">
            <FieldGroup>
              <Field>
                <FieldLabelWithHelp
                  htmlFor="issue-title"
                  helpText="A short, scannable summary. Shown in lists and links; keep it specific enough to recognize later.">
                  Title
                </FieldLabelWithHelp>
                <Input id="issue-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Improve approval latency" required />
              </Field>
              <Field>
                <FieldLabelWithHelp helpText="Context, acceptance criteria, and links agents need. The markdown editor shows formatted text as you type; the issue page renders the same Markdown (including GFM: tables, task lists, strikethrough).">
                  Description
                </FieldLabelWithHelp>
                <LazyMarkdownMdxEditor
                  editorKey={`issue-body-${issue?.id ?? "new"}-${bodyMdxKey}`}
                  markdown={body}
                  onChange={setBody}
                  placeholder="Describe the work and expected outcome."
                />
              </Field>
              <Field>
                <FieldLabelWithHelp helpText="Issues live under a project for grouping, permissions, and reporting. Pick where this work belongs.">
                  Project
                </FieldLabelWithHelp>
                <Select value={projectId} onValueChange={setProjectId} disabled={projects.length === 0}>
                  <SelectTrigger className={styles.createIssueModalSelectTrigger}>
                    <SelectValue placeholder={projects.length === 0 ? "No projects available" : "Select a project"} />
                  </SelectTrigger>
                  <SelectContent>
                    {projects.map((project) => (
                      <SelectItem key={project.id} value={project.id}>
                        {project.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {projects.length === 0 ? <FieldDescription>Create a project first so new issues have a home.</FieldDescription> : null}
              </Field>
              <div className={styles.createIssueModalStatusPriorityRow}>
                <Field>
                  <FieldLabelWithHelp helpText="Workflow column for this issue (e.g. todo → in progress → done). Updates how it appears in boards and filters.">
                    Status
                  </FieldLabelWithHelp>
                  <Select value={status} onValueChange={(value) => setStatus(value as IssueStatus)}>
                    <SelectTrigger className={styles.createIssueModalSelectTrigger}>
                      <SelectValue placeholder="Select a status" />
                    </SelectTrigger>
                    <SelectContent>
                      {issueStatusOptions.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                <Field>
                  <FieldLabelWithHelp helpText="Relative urgency for triage. None is fine for routine work; raise it when timelines or risk demand attention.">
                    Priority
                  </FieldLabelWithHelp>
                  <Select value={priority} onValueChange={(value) => setPriority(value as IssuePriority)}>
                    <SelectTrigger className={styles.createIssueModalSelectTrigger}>
                      <SelectValue placeholder="Select a priority" />
                    </SelectTrigger>
                    <SelectContent>
                      {issuePriorityOptions.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
              </div>
              <Field>
                <FieldLabelWithHelp helpText="Optional owner for execution. Unassigned issues stay in the pool until someone or an agent picks them up.">
                  Assigned agent
                </FieldLabelWithHelp>
                <Select value={assigneeAgentId} onValueChange={setAssigneeAgentId}>
                  <SelectTrigger className={styles.createIssueModalSelectTrigger}>
                    <SelectValue placeholder="Select an agent" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="unassigned">Unassigned</SelectItem>
                    {agents.map((agent) => (
                      <SelectItem key={agent.id} value={agent.id}>
                        {agent.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              {goals.length > 0 ? (
                <Field>
                  <FieldLabelWithHelp helpText="Link one or more company or project goals. Agents see each chain in heartbeats so work traces to outcomes.">
                    Goals
                  </FieldLabelWithHelp>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        type="button"
                        variant="outline"
                        className={styles.createIssueModalGoalsTrigger}
                        disabled={!projectId}>
                        {!projectId
                          ? "Select a project first"
                          : applicableGoals.length === 0
                            ? "No goals for this project"
                            : goalIds.length === 0
                              ? "Select goals"
                              : `${goalIds.length} selected`}
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start" className="ui-dropdown-menu-content--trigger-width">
                      <DropdownMenuLabel>Attach goals</DropdownMenuLabel>
                      <DropdownMenuSeparator />
                      {applicableGoals.length === 0 ? (
                        <p className="ui-dropdown-menu-empty-hint">No applicable goals.</p>
                      ) : (
                        applicableGoals.map((g) => (
                          <DropdownMenuCheckboxItem
                            key={g.id}
                            checked={goalIds.includes(g.id)}
                            onSelect={(event) => event.preventDefault()}
                            onCheckedChange={(next) => toggleIssueGoal(g.id, Boolean(next))}>
                            {g.title}
                          </DropdownMenuCheckboxItem>
                        ))
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </Field>
              ) : null}
              <Field>
                <FieldLabelWithHelp helpText="Link company knowledge files. Paths must exist under Company → Knowledge. Agents can load them via the observability API.">
                  Knowledge
                </FieldLabelWithHelp>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button type="button" variant="outline" className={styles.createIssueModalGoalsTrigger}>
                      {knowledgeFileOptions.length === 0
                        ? "No knowledge files"
                        : knowledgePaths.length === 0
                          ? "Select knowledge"
                          : `${knowledgePaths.length} selected`}
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="ui-dropdown-menu-content--trigger-width-max-h-72">
                    <DropdownMenuLabel>Knowledge files</DropdownMenuLabel>
                    <DropdownMenuSeparator />
                    {knowledgeFileOptions.length === 0 ? (
                      <p className="ui-dropdown-menu-empty-hint">Create files under Company → Knowledge.</p>
                    ) : (
                      knowledgeFileOptions.map((p) => (
                        <DropdownMenuCheckboxItem
                          key={p}
                          checked={knowledgePaths.includes(p)}
                          onSelect={(event) => event.preventDefault()}
                          onCheckedChange={(next) => toggleKnowledgePath(p, Boolean(next))}
                        >
                          {p}
                        </DropdownMenuCheckboxItem>
                      ))
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              </Field>
              <Field>
                <FieldLabelWithHelp
                  htmlFor="issue-labels"
                  helpText="Comma-separated tags for filtering and reports (e.g. bug, backend). Extra spaces around commas are trimmed.">
                  Labels
                </FieldLabelWithHelp>
                <Input
                  id="issue-labels"
                  value={labels}
                  onChange={(e) => setLabels(e.target.value)}
                  placeholder="bug, onboarding, backend"
                />
              </Field>
              <Field>
                <FieldLabelWithHelp
                  htmlFor="issue-external-link"
                  helpText="Optional URL for a pull request, ticket, or doc. Stored as metadata so people can jump straight to the source.">
                  PR / external link
                </FieldLabelWithHelp>
                <Input
                  id="issue-external-link"
                  value={externalLink}
                  onChange={(e) => setExternalLink(e.target.value)}
                  placeholder="https://github.com/org/repo/pull/123"
                />
              </Field>
              <Field>
                <FieldLabelWithHelp
                  htmlFor="issue-attachments"
                  helpText="Upload files after save on create, or add more when editing. Multiple files are supported in one batch.">
                  Attachments
                </FieldLabelWithHelp>
                <Input id="issue-attachments" type="file" multiple onChange={onFilesSelected} />
              </Field>
            </FieldGroup>
          </div>
          {error ? <p className={styles.createIssueModalText}>{error}</p> : null}
          <DialogFooter showCloseButton={!isEditing}>
            {isEditing ? (
              <Button type="button" variant="ghost" onClick={() => void onDeleteIssue()} disabled={isSubmitting || isDeleting}>
                {isDeleting ? "Deleting..." : "Delete"}
              </Button>
            ) : null}
            <Button type="submit" disabled={isSubmitting || isDeleting || projects.length === 0}>
              {isEditing ? "Save" : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
