"use client";

import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { ApiError, apiDelete, apiPost, apiPut } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger
} from "@/components/ui/dialog";
import { LazyMarkdownMdxEditor } from "@/components/modals/lazy-markdown-mdx-editor";
import { Field, FieldContent, FieldGroup } from "@/components/ui/field";
import { FieldLabelWithHelp } from "@/components/ui/field-label-with-help";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select";
import styles from "./create-goal-modal.module.scss";

export type GoalModalGoalRef = {
  id: string;
  title: string;
  level: string;
  projectId: string | null;
  parentGoalId?: string | null;
};

function collectDescendantGoalIds(selfId: string, goalList: GoalModalGoalRef[]): Set<string> {
  const byParent = new Map<string, string[]>();
  for (const g of goalList) {
    const p = g.parentGoalId?.trim();
    if (!p) {
      continue;
    }
    const list = byParent.get(p) ?? [];
    list.push(g.id);
    byParent.set(p, list);
  }
  const out = new Set<string>();
  const stack = [...(byParent.get(selfId) ?? [])];
  while (stack.length) {
    const id = stack.pop()!;
    if (out.has(id)) {
      continue;
    }
    out.add(id);
    for (const c of byParent.get(id) ?? []) {
      stack.push(c);
    }
  }
  return out;
}

/** Parents are always optional company-level goals (project/agent goals roll up to company outcomes). */
function parentOptionsForCompanyGoals(allGoals: GoalModalGoalRef[], excludeIds: Set<string>): GoalModalGoalRef[] {
  return allGoals.filter((g) => !excludeIds.has(g.id) && g.level === "company");
}

export function CreateGoalModal({
  companyId,
  agents = [],
  allGoals = [],
  defaultProjectId = null,
  goal,
  /** When set, used as the dialog trigger instead of the default button (e.g. title link in a table). */
  trigger,
  triggerLabel = "New Goal",
  triggerVariant = "default",
  triggerSize
}: {
  companyId: string;
  agents?: Array<{ id: string; name: string }>;
  allGoals?: GoalModalGoalRef[];
  defaultProjectId?: string | null;
  trigger?: ReactNode;
  goal?: {
    id: string;
    level: "company" | "project" | "agent";
    title: string;
    description?: string | null;
    status: string;
    ownerAgentId?: string | null;
    projectId?: string | null;
    parentGoalId?: string | null;
  };
  triggerLabel?: string;
  triggerVariant?: "default" | "outline" | "secondary" | "ghost" | "destructive";
  triggerSize?: "default" | "sm" | "lg" | "icon";
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [level, setLevel] = useState<"company" | "project" | "agent">(goal?.level ?? "company");
  const [title, setTitle] = useState(goal?.title ?? "");
  const [description, setDescription] = useState(goal?.description ?? "");
  const [status, setStatus] = useState(goal?.status ?? "draft");
  const [activateNow, setActivateNow] = useState(false);
  const [ownerAgentId, setOwnerAgentId] = useState<string>(goal?.ownerAgentId ?? "__all__");
  const [parentGoalId, setParentGoalId] = useState<string>("__none__");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detailsMdxKey, setDetailsMdxKey] = useState(0);
  const isEditing = Boolean(goal);

  const excludedParentIds = useMemo(() => {
    if (!goal?.id) {
      return new Set<string>();
    }
    const desc = collectDescendantGoalIds(goal.id, allGoals);
    desc.add(goal.id);
    return desc;
  }, [allGoals, goal?.id]);

  const parentCandidates = useMemo(
    () => parentOptionsForCompanyGoals(allGoals, excludedParentIds),
    [allGoals, excludedParentIds]
  );

  /** Project goals never use a project dropdown: scope comes from the project page or the goal you are editing. */
  const resolvedProjectGoalProjectId = (): string | null => {
    const fromPage = defaultProjectId?.trim() || null;
    if (fromPage) {
      return fromPage;
    }
    if (goal?.level === "project" && goal.projectId?.trim()) {
      return goal.projectId.trim();
    }
    return null;
  };

  useEffect(() => {
    if (parentGoalId === "__none__") {
      return;
    }
    if (!parentCandidates.some((p) => p.id === parentGoalId)) {
      setParentGoalId("__none__");
    }
  }, [parentCandidates, parentGoalId]);

  function hydrateFormFromProps() {
    setLevel(goal?.level ?? "company");
    setTitle(goal?.title ?? "");
    setDescription(goal?.description ?? "");
    setStatus(goal?.status ?? "draft");
    setActivateNow(false);
    setOwnerAgentId(goal?.ownerAgentId ?? "__all__");
    setParentGoalId(goal?.parentGoalId?.trim() ? goal.parentGoalId.trim() : "__none__");
    setError(null);
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setIsSubmitting(true);
    setError(null);
    try {
      const projectScopeId = resolvedProjectGoalProjectId();
      if (level === "project" && !projectScopeId) {
        setError(
          "Project goals belong to a specific project. Open that project and use New goal there, or edit this goal from the Goals table."
        );
        setIsSubmitting(false);
        return;
      }

      const parentId = parentGoalId === "__none__" ? null : parentGoalId;

      const nextProjectId =
        level === "company" ? null : level === "project" ? projectScopeId! : null;

      if (isEditing && goal) {
        await apiPut(`/goals/${goal.id}`, companyId, {
          level,
          title,
          description: description || null,
          status,
          projectId: nextProjectId,
          parentGoalId: parentId,
          ownerAgentId: level === "agent" ? (ownerAgentId === "__all__" ? null : ownerAgentId) : null
        });
      } else {
        await apiPost("/goals", companyId, {
          level,
          title,
          description: description || undefined,
          activateNow,
          ...(level === "project" ? { projectId: projectScopeId! } : {}),
          ...(parentId ? { parentGoalId: parentId } : {}),
          ...(level === "agent" && ownerAgentId !== "__all__" ? { ownerAgentId } : {})
        });
        setLevel("company");
        setTitle("");
        setDescription("");
        setActivateNow(false);
        setOwnerAgentId("__all__");
        setParentGoalId("__none__");
      }
      setOpen(false);
      router.refresh();
    } catch (submitError) {
      if (submitError instanceof ApiError) {
        setError(submitError.message);
      } else {
        setError(isEditing ? "Failed to update goal." : "Failed to create goal.");
      }
    } finally {
      setIsSubmitting(false);
    }
  }

  async function onDeleteGoal() {
    if (!goal) {
      return;
    }
    setError(null);
    setIsDeleting(true);
    try {
      await apiDelete(`/goals/${goal.id}`, companyId);
      setOpen(false);
      router.refresh();
    } catch (deleteError) {
      if (deleteError instanceof ApiError) {
        setError(deleteError.message);
      } else {
        setError("Failed to delete goal.");
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
          setDetailsMdxKey((k) => k + 1);
        }
      }}
    >
      <DialogTrigger asChild>
        {trigger ?? (
          <Button variant={triggerVariant} size={triggerSize}>
            {triggerLabel}
          </Button>
        )}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{isEditing ? "Edit goal" : "Create goal"}</DialogTitle>
          <DialogDescription>Create a goal with status, start timing, and workspace hints.</DialogDescription>
        </DialogHeader>
        <form className={styles.createGoalModalForm} onSubmit={onSubmit}>
          <div className="ui-dialog-content-scrollable">
            <FieldGroup>
              <Field>
                <FieldLabelWithHelp helpText="Company: everyone’s heartbeats. Project: for the project you’re viewing (no separate project field). Create new project goals from a project’s page. Agent: cadence charter for one or all agents.">
                  Goal scope
                </FieldLabelWithHelp>
                <Select
                  value={level}
                  onValueChange={(value) => {
                    const v = value as "company" | "project" | "agent";
                    setLevel(v);
                    if (v !== "agent") {
                      setOwnerAgentId("__all__");
                    }
                  }}>
                  <SelectTrigger className={styles.createGoalModalSelectTrigger}>
                    <SelectValue placeholder="Select a scope" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="company">Company goal</SelectItem>
                    <SelectItem value="project">Project goal</SelectItem>
                    <SelectItem value="agent">Agent goal</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
              <Field>
                <FieldLabelWithHelp helpText="Optional. Link this goal under a company-level outcome. Agent goals apply to agents as a whole (or one agent via Agent scope), not to a single project.">
                  Parent goal
                </FieldLabelWithHelp>
                <Select
                  value={parentGoalId}
                  onValueChange={setParentGoalId}>
                  <SelectTrigger className={styles.createGoalModalSelectTrigger}>
                    <SelectValue placeholder="No parent" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">No parent</SelectItem>
                    {parentCandidates.map((g) => (
                      <SelectItem key={g.id} value={g.id}>
                        [{g.level}] {g.title}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              {level === "agent" && agents.length > 0 ? (
                <Field>
                  <FieldLabelWithHelp helpText="Restrict this goal to one agent’s heartbeats, or leave as all agents for a shared agent-level objective.">
                    Agent scope
                  </FieldLabelWithHelp>
                  <Select value={ownerAgentId} onValueChange={setOwnerAgentId}>
                    <SelectTrigger className={styles.createGoalModalSelectTrigger}>
                      <SelectValue placeholder="All agents" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__all__">All agents</SelectItem>
                      {agents.map((agent) => (
                        <SelectItem key={agent.id} value={agent.id}>
                          {agent.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
              ) : null}
              <Field>
                <FieldLabelWithHelp
                  htmlFor="goal-title"
                  helpText="Short headline for the goal. Use something measurable or outcome-oriented so teams can align on success.">
                  Goal title
                </FieldLabelWithHelp>
                <Input id="goal-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Increase delivery throughput" required />
              </Field>
              <Field>
                <FieldLabelWithHelp helpText="Context, metrics, time horizon, and links. The markdown editor shows formatted text as you type (headings, lists, links, GFM).">
                  Details
                </FieldLabelWithHelp>
                <LazyMarkdownMdxEditor
                  editorKey={`goal-details-${goal?.id ?? "new"}-${detailsMdxKey}`}
                  markdown={description}
                  onChange={setDescription}
                  placeholder="Goal details"
                />
              </Field>
              {isEditing ? (
                <Field>
                  <FieldLabelWithHelp helpText="Lifecycle of the goal: draft while refining, active when in pursuit, completed when done, archived to retain history without noise.">
                    Status
                  </FieldLabelWithHelp>
                  <Select value={status} onValueChange={setStatus}>
                    <SelectTrigger className={styles.createGoalModalSelectTrigger}>
                      <SelectValue placeholder="Select a status" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="draft">Draft</SelectItem>
                      <SelectItem value="active">Active</SelectItem>
                      <SelectItem value="completed">Completed</SelectItem>
                      <SelectItem value="archived">Archived</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
              ) : (
                <Field orientation="horizontal">
                  <Checkbox
                    id="goal-activate-now"
                    checked={activateNow}
                    onCheckedChange={(checked) => setActivateNow(Boolean(checked))}
                  />
                  <FieldContent>
                    <FieldLabelWithHelp
                      htmlFor="goal-activate-now"
                      helpText="When checked, creating the goal starts a governance request to move it from draft to active instead of leaving it in draft.">
                      Request activation approval
                    </FieldLabelWithHelp>
                  </FieldContent>
                </Field>
              )}
            </FieldGroup>
          </div>
          {error ? <p className={styles.createGoalModalText}>{error}</p> : null}
          <DialogFooter showCloseButton={!isEditing}>
            {isEditing ? (
              <Button type="button" variant="ghost" onClick={() => void onDeleteGoal()} disabled={isSubmitting || isDeleting}>
                {isDeleting ? "Deleting..." : "Delete"}
              </Button>
            ) : null}
            <Button type="submit" disabled={isSubmitting || isDeleting}>
              {isEditing ? "Save" : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
