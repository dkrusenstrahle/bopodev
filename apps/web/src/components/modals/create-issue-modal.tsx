"use client";

import { useState, type ChangeEvent, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import type { IssueStatus } from "bopodev-contracts";
import { ApiError, apiPost, apiPostFormData, apiPut } from "@/lib/api";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import styles from "./create-issue-modal.module.scss";

interface ProjectOption {
  id: string;
  name: string;
}

interface AgentOption {
  id: string;
  name: string;
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

export function CreateIssueModal({
  companyId,
  projects,
  agents,
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
  issue?: {
    id: string;
    projectId: string;
    title: string;
    body?: string | null;
    status: IssueStatus;
    assigneeAgentId?: string | null;
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
  const [status, setStatus] = useState<IssueStatus>(issue?.status ?? "todo");
  const [assigneeAgentId, setAssigneeAgentId] = useState<string>(issue?.assigneeAgentId ?? "unassigned");
  const [labels, setLabels] = useState(issue?.labels?.join(", ") ?? "");
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isEditing = Boolean(issue);

  function hydrateFormFromProps() {
    setProjectId(issue?.projectId ?? defaultProjectId ?? projects[0]?.id ?? "");
    setTitle(issue?.title ?? "");
    setBody(issue?.body ?? "");
    setStatus(issue?.status ?? "todo");
    setAssigneeAgentId(issue?.assigneeAgentId ?? "unassigned");
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
        status,
        assigneeAgentId: assigneeAgentId === "unassigned" ? null : assigneeAgentId,
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
        setStatus("todo");
        setAssigneeAgentId("unassigned");
        setLabels("");
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

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (nextOpen) {
          hydrateFormFromProps();
        }
      }}
    >
      <DialogTrigger asChild>
        <Button variant={triggerVariant} size={triggerSize}>
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
                <FieldLabel>Project</FieldLabel>
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
              <Field>
                <FieldLabel htmlFor="issue-title">Issue title</FieldLabel>
                <Input id="issue-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Improve approval latency" required />
              </Field>
              <Field>
                <FieldLabel htmlFor="issue-description">Description</FieldLabel>
                <Textarea id="issue-description" value={body} onChange={(e) => setBody(e.target.value)} placeholder="Describe the work and expected outcome." />
              </Field>
              <Field>
                <FieldLabel>Status</FieldLabel>
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
                <FieldLabel>Assigned agent</FieldLabel>
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
              <Field>
                <FieldLabel htmlFor="issue-labels">Labels</FieldLabel>
                <Input
                  id="issue-labels"
                  value={labels}
                  onChange={(e) => setLabels(e.target.value)}
                  placeholder="bug, onboarding, backend"
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="issue-attachments">Attachments</FieldLabel>
                <Input id="issue-attachments" type="file" multiple onChange={onFilesSelected} />
              </Field>
            </FieldGroup>
          </div>
          {error ? <p className={styles.createIssueModalText}>{error}</p> : null}
          <DialogFooter showCloseButton>
            <Button type="submit" disabled={isSubmitting || projects.length === 0}>
              {isEditing ? "Save" : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
