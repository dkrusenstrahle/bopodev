"use client";

import { useState, type FormEvent } from "react";
import { ApiError } from "@/lib/api";
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
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import styles from "./text-action-modal.module.scss";

export function TextActionModal({
  triggerLabel,
  title,
  description,
  submitLabel,
  initialValue = "",
  placeholder,
  onSubmit,
  triggerVariant = "ghost",
  multiline = false
}: {
  triggerLabel: string;
  title: string;
  description: string;
  submitLabel: string;
  initialValue?: string;
  placeholder: string;
  onSubmit: (value: string) => Promise<void>;
  triggerVariant?: "ghost" | "primary" | "outline";
  multiline?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(initialValue);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const trimmed = value.trim();
    if (!trimmed) {
      setError("Value is required.");
      return;
    }

    setIsSubmitting(true);
    setError(null);
    try {
      await onSubmit(trimmed);
      setOpen(false);
    } catch (submitError) {
      if (submitError instanceof ApiError) {
        setError(submitError.message);
      } else {
        setError("Failed to save changes.");
      }
    } finally {
      setIsSubmitting(false);
    }
  }

  const triggerButtonVariant =
    triggerVariant === "primary" ? "default" : triggerVariant === "outline" ? "outline" : "ghost";

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (nextOpen) {
          setValue(initialValue);
          setError(null);
        }
      }}
    >
      <DialogTrigger asChild>
        <Button variant={triggerButtonVariant}>{triggerLabel}</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <form className={styles.textActionModalForm} onSubmit={handleSubmit}>
          <div className="ui-dialog-content-scrollable">
            <Field>
              <FieldLabel htmlFor="text-action-value" className={styles.textActionModalFieldLabel}>
                Value
              </FieldLabel>
              {multiline ? (
                <Textarea id="text-action-value" value={value} onChange={(event) => setValue(event.target.value)} placeholder={placeholder} />
              ) : (
                <Input id="text-action-value" value={value} onChange={(event) => setValue(event.target.value)} placeholder={placeholder} required />
              )}
            </Field>
          </div>
          {error ? <p className={styles.textActionModalText}>{error}</p> : null}
          <DialogFooter showCloseButton>
            <Button type="submit" disabled={isSubmitting}>
              {submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
