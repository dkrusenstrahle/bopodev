"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { ApiError, apiDelete, apiPost, apiPut } from "@/lib/api";
import { readAgentRuntimeDefaults, writeAgentRuntimeDefaults } from "@/lib/agent-defaults";
import { cn } from "@/lib/utils";
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
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import styles from "./create-project-modal.module.scss";

export type ProjectStatus = "planned" | "active" | "paused" | "blocked" | "completed" | "archived";
type WorkspaceMode = "local" | "github" | "both";

const projectStatusOptions: Array<{ value: ProjectStatus; label: string }> = [
  { value: "planned", label: "Planned" },
  { value: "active", label: "Active" },
  { value: "paused", label: "Paused" },
  { value: "blocked", label: "Blocked" },
  { value: "completed", label: "Completed" },
  { value: "archived", label: "Archived" }
];

function inferWorkspaceMode(localPath: string | null | undefined, githubRepo: string | null | undefined): WorkspaceMode {
  const hasLocalPath = Boolean(localPath?.trim());
  const hasGithubRepo = Boolean(githubRepo?.trim());
  if (hasLocalPath && hasGithubRepo) {
    return "both";
  }
  if (hasGithubRepo) {
    return "github";
  }
  return "local";
}

export function CreateProjectModal({
  companyId,
  goals,
  project,
  triggerLabel = "New Project",
  triggerVariant = "default",
  triggerSize
}: {
  companyId: string;
  goals: Array<{ id: string; title: string; projectId: string | null }>;
  project?: {
    id: string;
    name: string;
    description: string | null;
    status: ProjectStatus;
    plannedStartAt: string | null;
    workspaces: Array<{
      id: string;
      name: string;
      cwd: string | null;
      repoUrl: string | null;
      repoRef: string | null;
      isPrimary: boolean;
    }>;
    primaryWorkspace: {
      id: string;
      name: string;
      cwd: string | null;
      repoUrl: string | null;
      repoRef: string | null;
      isPrimary: boolean;
    } | null;
    gitDiagnostics?: {
      workspaceStatus?: "hybrid" | "repo_only" | "local_only" | "unconfigured";
      cloneState?: "ready" | "missing" | "n/a";
      authMode?: "host" | "env_token";
      tokenEnvVar?: string | null;
      effectiveCwd?: string | null;
    };
  };
  triggerLabel?: string;
  triggerVariant?: "default" | "outline" | "secondary" | "ghost" | "destructive";
  triggerSize?: "default" | "sm" | "lg" | "icon";
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(project?.name ?? "");
  const [description, setDescription] = useState(project?.description ?? "");
  const [status, setStatus] = useState<ProjectStatus>(project?.status ?? "planned");
  const [plannedStartAt, setPlannedStartAt] = useState(project?.plannedStartAt ? project.plannedStartAt.slice(0, 10) : "");
  const [workspaceName, setWorkspaceName] = useState(project?.primaryWorkspace?.name ?? "");
  const [workspaceCwd, setWorkspaceCwd] = useState(project?.primaryWorkspace?.cwd ?? "");
  const [workspaceRepoUrl, setWorkspaceRepoUrl] = useState(project?.primaryWorkspace?.repoUrl ?? "");
  const [workspaceRepoRef, setWorkspaceRepoRef] = useState(project?.primaryWorkspace?.repoRef ?? "");
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>(
    inferWorkspaceMode(project?.primaryWorkspace?.cwd, project?.primaryWorkspace?.repoUrl)
  );
  const [goalIds, setGoalIds] = useState<string[]>(
    project ? goals.filter((goal) => goal.projectId === project.id).map((goal) => goal.id) : []
  );
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isEditing = Boolean(project);

  function hydrateFormFromProps() {
    setName(project?.name ?? "");
    setDescription(project?.description ?? "");
    setStatus(project?.status ?? "planned");
    setPlannedStartAt(project?.plannedStartAt ? project.plannedStartAt.slice(0, 10) : "");
    setWorkspaceName(project?.primaryWorkspace?.name ?? "");
    setWorkspaceCwd(project?.primaryWorkspace?.cwd ?? "");
    setWorkspaceRepoUrl(project?.primaryWorkspace?.repoUrl ?? "");
    setWorkspaceRepoRef(project?.primaryWorkspace?.repoRef ?? "");
    setWorkspaceMode(inferWorkspaceMode(project?.primaryWorkspace?.cwd, project?.primaryWorkspace?.repoUrl));
    setGoalIds(project ? goals.filter((goal) => goal.projectId === project.id).map((goal) => goal.id) : []);
    setError(null);
  }

  function toggleGoal(goalId: string, isChecked: boolean) {
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

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setIsSubmitting(true);
    setError(null);
    try {
      const trimmedWorkspaceCwd = (workspaceMode === "github" ? "" : workspaceCwd).trim();
      const trimmedWorkspaceRepoUrl = (workspaceMode === "local" ? "" : workspaceRepoUrl).trim();
      const trimmedWorkspaceRepoRef = workspaceRepoRef.trim();
      const trimmedWorkspaceName = workspaceName.trim();
      const hasWorkspace = trimmedWorkspaceCwd.length > 0 || trimmedWorkspaceRepoUrl.length > 0;
      const normalizedWorkspace = hasWorkspace
        ? {
            name: trimmedWorkspaceName || undefined,
            cwd: trimmedWorkspaceCwd || undefined,
            repoUrl: trimmedWorkspaceRepoUrl || undefined,
            repoRef: trimmedWorkspaceRepoRef || undefined,
            isPrimary: true
          }
        : undefined;
      const payload = {
        name,
        description: description || undefined,
        status,
        plannedStartAt: plannedStartAt || undefined,
        workspace: normalizedWorkspace,
        goalIds
      };
      if (isEditing && project) {
        await apiPut(`/projects/${project.id}`, companyId, {
          description: description || null,
          goalIds,
          name,
          plannedStartAt: plannedStartAt || null,
          status
        });
        if (hasWorkspace) {
          const workspacePayload = normalizedWorkspace as {
            name?: string;
            cwd?: string;
            repoUrl?: string;
            repoRef?: string;
            isPrimary: boolean;
          };
          if (project.primaryWorkspace) {
            await apiPut(`/projects/${project.id}/workspaces/${project.primaryWorkspace.id}`, companyId, {
              name: workspacePayload.name,
              cwd: workspacePayload.cwd ?? null,
              repoUrl: workspacePayload.repoUrl ?? null,
              repoRef: workspacePayload.repoRef ?? null,
              isPrimary: true
            });
          } else {
            await apiPost(`/projects/${project.id}/workspaces`, companyId, workspacePayload);
          }
        } else if (project.primaryWorkspace) {
          await apiDelete(`/projects/${project.id}/workspaces/${project.primaryWorkspace.id}`, companyId);
        }
      } else {
        await apiPost("/projects", companyId, payload);
      }
      if (trimmedWorkspaceCwd.length > 0) {
        const defaults = readAgentRuntimeDefaults();
        writeAgentRuntimeDefaults({
          ...defaults,
          runtimeCwd: trimmedWorkspaceCwd
        });
      }
      if (!isEditing) {
        setName("");
        setDescription("");
        setStatus("planned");
        setPlannedStartAt("");
        setWorkspaceName("");
        setWorkspaceCwd("");
        setWorkspaceRepoUrl("");
        setWorkspaceRepoRef("");
        setWorkspaceMode("local");
        setGoalIds([]);
      }
      setOpen(false);
      router.refresh();
    } catch (submitError) {
      if (submitError instanceof ApiError) {
        setError(submitError.message);
      } else {
        setError(isEditing ? "Failed to update project." : "Failed to create project.");
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
          <DialogTitle>{isEditing ? "Edit project" : "Create project"}</DialogTitle>
          <DialogDescription>
            {isEditing ? "Update project metadata and linked goals." : "Create a project with status, start timing, and workspace hints."}
          </DialogDescription>
        </DialogHeader>
        <form className={styles.createProjectModalForm} onSubmit={onSubmit} autoComplete="off">
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="project-name">Project name</FieldLabel>
              <Input id="project-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Growth website" required autoComplete="off" />
            </Field>
            <Field>
              <FieldLabel htmlFor="project-description">Description</FieldLabel>
              <Textarea
                id="project-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="What is this project trying to achieve?"
                autoComplete="off"
              />
            </Field>
          </FieldGroup>

          <FieldGroup className={styles.createProjectModalSection}>
            <div>
              <p className={styles.createProjectModalSectionTitle}>Where will work be done on this project?</p>
              <p className={styles.createProjectModalSectionDescription}>Configure a project workspace (local folder and/or GitHub repo).</p>
            </div>
            <div className={styles.createProjectModalWorkspaceModes}>
              <button
                type="button"
                className={cn("ui-project-workspace-mode", workspaceMode === "local" && "ui-project-workspace-mode-active")}
                onClick={() => setWorkspaceMode("local")}
              >
                <span className="ui-project-workspace-mode-title">A local folder</span>
                <span className="ui-project-workspace-mode-description">Use a full path.</span>
              </button>
              <button
                type="button"
                className={cn("ui-project-workspace-mode", workspaceMode === "github" && "ui-project-workspace-mode-active")}
                onClick={() => setWorkspaceMode("github")}
              >
                <span className="ui-project-workspace-mode-title">A GitHub repo</span>
                <span className="ui-project-workspace-mode-description">Paste a GitHub URL.</span>
              </button>
              <button
                type="button"
                className={cn("ui-project-workspace-mode", workspaceMode === "both" && "ui-project-workspace-mode-active")}
                onClick={() => setWorkspaceMode("both")}
              >
                <span className="ui-project-workspace-mode-title">Both</span>
                <span className="ui-project-workspace-mode-description">Configure local + repo.</span>
              </button>
            </div>
            <Field>
              <FieldLabel htmlFor="project-workspace-name">Workspace name</FieldLabel>
              <Input
                id="project-workspace-name"
                value={workspaceName}
                onChange={(e) => setWorkspaceName(e.target.value)}
                placeholder="Main workspace"
                autoComplete="off"
              />
            </Field>
            {workspaceMode !== "github" ? (
              <Field>
                <FieldLabel htmlFor="project-workspace-local-path">Local folder</FieldLabel>
                <Input
                  id="project-workspace-local-path"
                  value={workspaceCwd}
                  onChange={(e) => setWorkspaceCwd(e.target.value)}
                  placeholder="/Users/name/path/to/workspace"
                  autoComplete="off"
                />
              </Field>
            ) : null}
            {workspaceMode !== "local" ? (
              <Field>
                <FieldLabel htmlFor="project-workspace-github-repo">GitHub repository</FieldLabel>
                <Input
                  id="project-workspace-github-repo"
                  type="url"
                  value={workspaceRepoUrl}
                  onChange={(e) => setWorkspaceRepoUrl(e.target.value)}
                  placeholder="https://github.com/org/repo"
                  autoComplete="off"
                />
              </Field>
            ) : null}
            {workspaceMode !== "local" ? (
              <Field>
                <FieldLabel htmlFor="project-workspace-github-ref">Repository ref</FieldLabel>
                <Input
                  id="project-workspace-github-ref"
                  value={workspaceRepoRef}
                  onChange={(e) => setWorkspaceRepoRef(e.target.value)}
                  placeholder="main"
                  autoComplete="off"
                />
              </Field>
            ) : null}
            {project?.gitDiagnostics ? (
              <></>
            ) : null}
          </FieldGroup>

          <FieldGroup className={styles.createProjectModalMetaRow}>
            <Field>
              <FieldLabel>Status</FieldLabel>
              <Select value={status} onValueChange={(value) => setStatus(value as ProjectStatus)}>
                <SelectTrigger className={styles.createProjectModalFullWidth}>
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
            <Field>
              <FieldLabel htmlFor="project-planned-start-at">Planned start date</FieldLabel>
              <Input id="project-planned-start-at" type="date" value={plannedStartAt} onChange={(e) => setPlannedStartAt(e.target.value)} autoComplete="off" />
            </Field>
          </FieldGroup>

          <FieldGroup>
            <Field>
              <FieldLabel>Linked goals</FieldLabel>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button type="button" variant="outline" className={styles.createProjectModalGoalsTrigger}>
                    {goals.length === 0 ? "No goals available" : goalIds.length === 0 ? "Select goals" : `${goalIds.length} selected`}
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className={styles.createProjectModalGoalsDropdown}>
                  <DropdownMenuLabel>Attach goals</DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  {goals.length === 0 ? (
                    <p className="px-2 py-1.5 text-sm text-muted-foreground">No goals available.</p>
                  ) : (
                    goals.map((goal) => (
                      <DropdownMenuCheckboxItem
                        key={goal.id}
                        checked={goalIds.includes(goal.id)}
                        onSelect={(event) => event.preventDefault()}
                        onCheckedChange={(next) => toggleGoal(goal.id, Boolean(next))}
                      >
                        {goal.title}
                      </DropdownMenuCheckboxItem>
                    ))
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            </Field>
          </FieldGroup>
          {error ? <p className={styles.createProjectModalText}>{error}</p> : null}
          <DialogFooter showCloseButton>
            <Button type="submit" disabled={isSubmitting}>
              {isEditing ? "Save" : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
