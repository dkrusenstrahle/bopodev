"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { ApiError, apiDelete, apiFetchAttachmentText, apiPostFormData } from "@/lib/api";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";

const IssueDocumentMdxEditor = dynamic(
  () => import("./issue-document-mdx-editor").then((mod) => mod.IssueDocumentMdxEditor),
  {
    ssr: false,
    loading: () => <div className="ui-issue-muted-text">Loading editor…</div>
  }
);

export type IssueDocumentEditTarget = {
  id: string;
  fileName: string;
  downloadPath: string;
};

function sanitizeIssueDocumentFileName(title: string): string {
  const trimmed = title.trim();
  const base = trimmed
    .replace(/\\/g, "/")
    .split("/")
    .pop()
    ?.replace(/[^a-zA-Z0-9._-]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^\.+/, "");
  const stem = base && base.length > 0 ? base : "document";
  return stem.toLowerCase().endsWith(".md") ? stem : `${stem}.md`;
}

function titleFromAttachmentFileName(fileName: string): string {
  return fileName.replace(/\.md$/i, "") || fileName;
}

export function IssueDocumentDialog({
  companyId,
  issueId,
  open,
  onOpenChange,
  editTarget,
  onUploaded
}: {
  companyId: string;
  issueId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editTarget: IssueDocumentEditTarget | null;
  onUploaded: () => void | Promise<void>;
}) {
  const [editorSession, setEditorSession] = useState(0);
  const [title, setTitle] = useState("");
  const [markdown, setMarkdown] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isLoadingDocument, setIsLoadingDocument] = useState(false);

  const bumpEditor = useCallback(() => {
    setEditorSession((n) => n + 1);
  }, []);

  useEffect(() => {
    if (!open) {
      return;
    }
    let cancelled = false;
    async function hydrate() {
      setError(null);
      if (!editTarget) {
        setTitle("");
        setMarkdown("");
        bumpEditor();
        return;
      }
      setIsLoadingDocument(true);
      try {
        const text = await apiFetchAttachmentText(editTarget.downloadPath, companyId);
        if (!cancelled) {
          setMarkdown(text);
          setTitle(titleFromAttachmentFileName(editTarget.fileName));
          bumpEditor();
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof ApiError ? err.message : "Failed to load document.");
          setMarkdown("");
          setTitle(titleFromAttachmentFileName(editTarget.fileName));
          bumpEditor();
        }
      } finally {
        if (!cancelled) {
          setIsLoadingDocument(false);
        }
      }
    }
    void hydrate();
    return () => {
      cancelled = true;
    };
  }, [open, editTarget?.id, editTarget?.downloadPath, companyId, bumpEditor]);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    const trimmedTitle = title.trim();
    const trimmedBody = markdown.trim();
    if (!trimmedTitle) {
      setError("Enter a title.");
      return;
    }
    if (!trimmedBody) {
      setError("Enter some content for the document.");
      return;
    }

    setIsSubmitting(true);
    setError(null);
    try {
      const fileName = sanitizeIssueDocumentFileName(trimmedTitle);
      const file = new File([markdown], fileName, { type: "text/markdown" });
      const formData = new FormData();
      formData.append("files", file);
      await apiPostFormData(`/issues/${issueId}/attachments`, companyId, formData);
      if (editTarget) {
        await apiDelete(`/issues/${issueId}/attachments/${editTarget.id}`, companyId);
      }
      onOpenChange(false);
      await onUploaded();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : editTarget ? "Failed to save document." : "Failed to add document.");
    } finally {
      setIsSubmitting(false);
    }
  }

  const isEdit = Boolean(editTarget);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="2xl" className="gap-0">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit document" : "Add document"}</DialogTitle>
          <DialogDescription>
            {isEdit ? "Update the markdown document attached to this issue." : "Create a markdown document attached to this issue."}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={(e) => void onSubmit(e)} className="flex flex-col gap-4 min-h-0 flex-1">
          <div className="ui-dialog-content-scrollable">
            <Field>
              <FieldLabel htmlFor="issue-document-title">Title</FieldLabel>
              <Input
                id="issue-document-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Document title"
                disabled={isSubmitting || isLoadingDocument}
                autoComplete="off"
              />
            </Field>
            <Field>
              <FieldLabel>Content</FieldLabel>
              {isLoadingDocument ? (
                <div className="ui-issue-muted-text ui-py-8">Loading document…</div>
              ) : (
                <IssueDocumentMdxEditor
                  editorKey={`${issueId}-${editorSession}-${editTarget?.id ?? "new"}`}
                  markdown={markdown}
                  onChange={setMarkdown}
                />
              )}
            </Field>
            {error ? <p className="ui-form-error-text">{error}</p> : null}
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
              Cancel
            </Button>
            <Button type="submit" disabled={isSubmitting || isLoadingDocument}>
              {isSubmitting ? "Saving…" : isEdit ? "Save" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
