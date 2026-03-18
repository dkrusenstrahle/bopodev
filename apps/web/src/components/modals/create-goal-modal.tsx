"use client";

import { useState, type FormEvent } from "react";
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
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import styles from "./create-goal-modal.module.scss";

export function CreateGoalModal({
  companyId,
  goal,
  triggerLabel = "New Goal",
  triggerVariant = "default",
  triggerSize
}: {
  companyId: string;
  goal?: {
    id: string;
    level: "company" | "project" | "agent";
    title: string;
    description?: string | null;
    status: string;
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
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isEditing = Boolean(goal);

  function hydrateFormFromProps() {
    setLevel(goal?.level ?? "company");
    setTitle(goal?.title ?? "");
    setDescription(goal?.description ?? "");
    setStatus(goal?.status ?? "draft");
    setActivateNow(false);
    setError(null);
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setIsSubmitting(true);
    setError(null);
    try {
      if (isEditing && goal) {
        await apiPut(`/goals/${goal.id}`, companyId, {
          level,
          title,
          description: description || null,
          status
        });
      } else {
        await apiPost("/goals", companyId, {
          level,
          title,
          description: description || undefined,
          activateNow
        });
        setLevel("company");
        setTitle("");
        setDescription("");
        setActivateNow(false);
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
          <DialogTitle>{isEditing ? "Edit goal" : "Create goal"}</DialogTitle>
          <DialogDescription>Create a goal with status, start timing, and workspace hints.</DialogDescription>
        </DialogHeader>
        <form className={styles.createGoalModalForm} onSubmit={onSubmit}>
          <div className="ui-dialog-content-scrollable">
            <FieldGroup>
              <Field>
                <FieldLabel>Goal scope</FieldLabel>
                <Select value={level} onValueChange={(value) => setLevel(value as "company" | "project" | "agent")}>
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
                <FieldLabel htmlFor="goal-title">Goal title</FieldLabel>
                <Input id="goal-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Increase delivery throughput" required />
              </Field>
              <Field>
                <FieldLabel htmlFor="goal-description">Details</FieldLabel>
                <Textarea id="goal-description" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Goal details" />
              </Field>
              {isEditing ? (
                <Field>
                  <FieldLabel>Status</FieldLabel>
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
                    <FieldLabel htmlFor="goal-activate-now">Request activation approval</FieldLabel>
                  </FieldContent>
                </Field>
              )}
            </FieldGroup>
          </div>
          {error ? <p className={styles.createGoalModalText}>{error}</p> : null}
          <DialogFooter showCloseButton={!isEditing}>
            {isEditing ? (
              <Button type="button" variant="destructive" onClick={() => void onDeleteGoal()} disabled={isSubmitting || isDeleting}>
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
