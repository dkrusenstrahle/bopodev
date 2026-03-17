"use client";

import Link from "next/link";
import { useEffect, useMemo, useState, type ChangeEvent, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import type { IssueStatus } from "bopodev-contracts";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { AppShell } from "@/components/app-shell";
import { ConfirmActionModal } from "@/components/modals/confirm-action-modal";
import { CreateIssueModal } from "@/components/modals/create-issue-modal";
import { TextActionModal } from "@/components/modals/text-action-modal";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldLabel } from "@/components/ui/field";
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemTitle } from "@/components/ui/item";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { ApiError, apiDelete, apiGet, apiPost, apiPostFormData, apiPut } from "@/lib/api";
import { getStatusBadgeClassName } from "@/lib/status-presentation";
import styles from "./issue-detail-page-client.module.scss";
import { MetricCard, SectionHeading } from "./workspace/shared";

interface IssueRow {
  id: string;
  projectId: string;
  parentIssueId?: string | null;
  assigneeAgentId: string | null;
  title: string;
  body?: string | null;
  status: IssueStatus;
  priority: string;
  labels: string[];
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

interface AgentRow {
  id: string;
  name: string;
  role: string;
}

interface ProjectRow {
  id: string;
  name: string;
}

interface CostRow {
  issueId: string | null;
  tokenInput: number;
  tokenOutput: number;
  usdCost: number;
}

interface IssueCommentRow {
  id: string;
  issueId: string;
  authorType: "human" | "agent" | "system";
  authorId: string | null;
  body: string;
  createdAt: string;
}

interface IssueActivityRow {
  id: string;
  issueId: string | null;
  actorType: "human" | "agent" | "system";
  actorId: string | null;
  eventType: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

interface RunHeartbeatResponse {
  runId: string;
  requestId?: string;
  status?: "started" | "skipped_overlap" | "skipped";
  message?: string | null;
}

interface IssueAttachmentRow {
  id: string;
  issueId: string;
  fileName: string;
  mimeType?: string | null;
  fileSizeBytes: number;
  createdAt: string;
  downloadPath: string;
}

const issueStatusOptions = [
  { value: "todo", label: "Todo" },
  { value: "in_progress", label: "In progress" },
  { value: "blocked", label: "Blocked" },
  { value: "in_review", label: "In review" },
  { value: "done", label: "Done" },
  { value: "canceled", label: "Canceled" }
] as const;

function EmptyState({ children }: { children: React.ReactNode }) {
  return <div className={styles.issueEmptyStateContainer}>{children}</div>;
}

function PropertyRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className={styles.propertyRowContainer1}>
      <div className={styles.propertyRowContainer2}>{label}</div>
      <div className={styles.propertyRowValue}>{value}</div>
    </div>
  );
}

function formatDate(value: string | null | undefined) {
  return value ? new Date(value).toLocaleString() : "Not set";
}

function formatEventType(eventType: string) {
  return eventType.replace(/[._]/g, " ");
}

function extractSummaryFromJsonLikeText(input: string) {
  const normalized = input.trim();
  const fencedMatch = normalized.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fencedMatch?.[1]?.trim() ?? normalized.match(/\{[\s\S]*\}\s*$/)?.[0]?.trim();
  if (!candidate) {
    return null;
  }
  try {
    const parsed = JSON.parse(candidate) as Record<string, unknown>;
    const summary = parsed.summary;
    if (typeof summary === "string" && summary.trim()) {
      return summary.trim();
    }
  } catch {
    // Fall through to regex extraction for loosely formatted JSON.
  }
  const summaryMatch = candidate.match(/"summary"\s*:\s*"([\s\S]*?)"/);
  const summary = summaryMatch?.[1]
    ?.replace(/\\"/g, "\"")
    .replace(/\\n/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return summary && summary.length > 0 ? summary : null;
}

function normalizePayloadText(value: unknown) {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  const decoded = value
    .trim()
    .replace(/\\n/g, "\n")
    .replace(/\\"/g, "\"");
  const extractedSummary = extractSummaryFromJsonLikeText(decoded);
  if (extractedSummary) {
    return extractedSummary;
  }
  return decoded
    .replace(/```(?:json)?/gi, "")
    .replace(/```/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function summarizeActivityPayload(payload: Record<string, unknown>) {
  const outcome = payload.outcome;
  if (outcome && typeof outcome === "object") {
    const outcomeRecord = outcome as Record<string, unknown>;
    const blockers = outcomeRecord.blockers;
    if (Array.isArray(blockers) && blockers.length > 0) {
      const firstBlocker = blockers[0];
      if (firstBlocker && typeof firstBlocker === "object") {
        const blockerMessage = (firstBlocker as Record<string, unknown>).message;
        if (typeof blockerMessage === "string" && blockerMessage.trim()) {
          return blockerMessage;
        }
      }
    }
    const kind = outcomeRecord.kind;
    if (typeof kind === "string" && kind.trim()) {
      return `Run outcome: ${kind}`;
    }
  }
  const summary = normalizePayloadText(payload.summary);
  if (summary) {
    return summary;
  }
  const message = normalizePayloadText(payload.message);
  if (message) {
    return message;
  }
  return "Event recorded.";
}

function buildAttachmentUrl(downloadPath: string, companyId: string) {
  return `${process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4020"}${downloadPath}?companyId=${encodeURIComponent(companyId)}`;
}

function isImageAttachment(attachment: IssueAttachmentRow) {
  if (attachment.mimeType?.startsWith("image/")) {
    return true;
  }
  return /\.(png|jpe?g|webp|gif|bmp|svg)$/i.test(attachment.fileName);
}

export function IssueDetailPageClient({
  companyId,
  companies,
  issue,
  allIssues,
  agents,
  projects,
  costEntries
}: {
  companyId: string;
  companies: Array<{ id: string; name: string }>;
  issue: IssueRow;
  allIssues: IssueRow[];
  agents: AgentRow[];
  projects: ProjectRow[];
  costEntries: CostRow[];
}) {
  const router = useRouter();
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const [commentError, setCommentError] = useState<string | null>(null);
  const [activityError, setActivityError] = useState<string | null>(null);
  const [commentsLoading, setCommentsLoading] = useState(false);
  const [activityLoading, setActivityLoading] = useState(false);
  const [attachmentsLoading, setAttachmentsLoading] = useState(false);
  const [comments, setComments] = useState<IssueCommentRow[]>([]);
  const [activityItems, setActivityItems] = useState<IssueActivityRow[]>([]);
  const [attachments, setAttachments] = useState<IssueAttachmentRow[]>([]);
  const [draftComment, setDraftComment] = useState("");
  const [isHeartbeatStarting, setIsHeartbeatStarting] = useState(false);
  const [isUploadingAttachments, setIsUploadingAttachments] = useState(false);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);

  const selectedProject = useMemo(
    () => projects.find((project) => project.id === issue.projectId) ?? null,
    [issue.projectId, projects]
  );

  const selectedAssignee = useMemo(
    () => agents.find((agent) => agent.id === issue.assigneeAgentId) ?? null,
    [agents, issue.assigneeAgentId]
  );

  const issueCostSummary = useMemo(() => {
    return costEntries
      .filter((entry) => entry.issueId === issue.id)
      .reduce(
        (acc, entry) => {
          acc.input += entry.tokenInput;
          acc.output += entry.tokenOutput;
          acc.usd += entry.usdCost;
          return acc;
        },
        { input: 0, output: 0, usd: 0 }
      );
  }, [costEntries, issue.id]);

  const subIssues = useMemo(
    () =>
      allIssues
        .filter((entry) => entry.parentIssueId === issue.id)
        .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()),
    [allIssues, issue.id]
  );
  useEffect(() => {
    let cancelled = false;

    async function loadComments() {
      setCommentsLoading(true);
      setCommentError(null);
      try {
        const result = await apiGet<IssueCommentRow[]>(`/issues/${issue.id}/comments`, companyId);
        if (!cancelled) {
          setComments(result.data);
        }
      } catch (error) {
        if (!cancelled) {
          setCommentError(error instanceof ApiError ? error.message : "Failed to load comments.");
        }
      } finally {
        if (!cancelled) {
          setCommentsLoading(false);
        }
      }
    }

    void loadComments();

    return () => {
      cancelled = true;
    };
  }, [companyId, issue.id]);

  useEffect(() => {
    let cancelled = false;

    async function loadActivity() {
      setActivityLoading(true);
      setActivityError(null);
      try {
        const result = await apiGet<IssueActivityRow[]>(`/issues/${issue.id}/activity`, companyId);
        if (!cancelled) {
          setActivityItems(result.data);
        }
      } catch (error) {
        if (!cancelled) {
          setActivityError(error instanceof ApiError ? error.message : "Failed to load issue activity.");
        }
      } finally {
        if (!cancelled) {
          setActivityLoading(false);
        }
      }
    }

    void loadActivity();

    return () => {
      cancelled = true;
    };
  }, [companyId, issue.id]);

  useEffect(() => {
    let cancelled = false;
    async function loadAttachments() {
      setAttachmentsLoading(true);
      setAttachmentError(null);
      try {
        const result = await apiGet<IssueAttachmentRow[]>(`/issues/${issue.id}/attachments`, companyId);
        if (!cancelled) {
          setAttachments(result.data);
        }
      } catch (error) {
        if (!cancelled) {
          setAttachmentError(error instanceof ApiError ? error.message : "Failed to load attachments.");
        }
      } finally {
        if (!cancelled) {
          setAttachmentsLoading(false);
        }
      }
    }
    void loadAttachments();
    return () => {
      cancelled = true;
    };
  }, [companyId, issue.id]);

  async function refreshAttachments() {
    try {
      const result = await apiGet<IssueAttachmentRow[]>(`/issues/${issue.id}/attachments`, companyId);
      setAttachments(result.data);
      setAttachmentError(null);
    } catch (error) {
      setAttachmentError(error instanceof ApiError ? error.message : "Failed to load attachments.");
    }
  }

  async function refreshIssueView() {
    router.refresh();
    try {
      const result = await apiGet<IssueActivityRow[]>(`/issues/${issue.id}/activity`, companyId);
      setActivityItems(result.data);
      setActivityError(null);
    } catch (error) {
      setActivityError(error instanceof ApiError ? error.message : "Failed to load issue activity.");
    }
  }

  async function runIssueAction(action: () => Promise<void>, fallbackMessage: string) {
    setActionError(null);
    setActionNotice(null);
    try {
      await action();
      await refreshIssueView();
    } catch (error) {
      setActionError(error instanceof ApiError ? error.message : fallbackMessage);
    }
  }

  async function updateIssue(payload: {
    title?: string;
    body?: string | null;
    status?: IssueStatus;
    assigneeAgentId?: string | null;
    labels?: string[];
  }) {
    await runIssueAction(async () => {
      await apiPut(`/issues/${issue.id}`, companyId, payload);
    }, "Failed to update issue.");
  }

  async function removeIssue() {
    await runIssueAction(async () => {
      await apiDelete(`/issues/${issue.id}`, companyId);
      router.push(`/issues?companyId=${companyId}` as Parameters<typeof router.push>[0]);
    }, "Failed to delete issue.");
  }

  async function runAssigneeHeartbeat() {
    if (!issue.assigneeAgentId) {
      setActionError("Assign this issue to an agent before running a heartbeat.");
      return;
    }

    setActionError(null);
    setActionNotice(null);
    setIsHeartbeatStarting(true);
    try {
      const response = await apiPost<RunHeartbeatResponse>("/heartbeats/run-agent", companyId, {
        agentId: issue.assigneeAgentId
      });
      if (response.data.status === "skipped_overlap") {
        setActionNotice(
          `A heartbeat is already running for this assignee (run ${response.data.runId}). The new request was skipped.`
        );
      } else if (response.data.status === "skipped") {
        setActionNotice(response.data.message ?? "Heartbeat request was skipped.");
      } else {
        setActionNotice(`Heartbeat started (run ${response.data.runId}).`);
      }
      await refreshIssueView();
    } catch (error) {
      setActionError(error instanceof ApiError ? error.message : "Failed to run heartbeat for the selected assignee.");
    } finally {
      setIsHeartbeatStarting(false);
    }
  }

  async function submitComment(event: FormEvent) {
    event.preventDefault();
    if (!draftComment.trim()) {
      return;
    }

    setCommentError(null);
    try {
      await apiPost(`/issues/${issue.id}/comments`, companyId, { body: draftComment.trim(), authorType: "human" });
      const result = await apiGet<IssueCommentRow[]>(`/issues/${issue.id}/comments`, companyId);
      setComments(result.data);
      setDraftComment("");
      await refreshIssueView();
    } catch (error) {
      setCommentError(error instanceof ApiError ? error.message : "Failed to add comment.");
    }
  }

  async function updateComment(commentId: string, body: string) {
    setCommentError(null);
    try {
      await apiPut(`/issues/${issue.id}/comments/${commentId}`, companyId, { body });
      const result = await apiGet<IssueCommentRow[]>(`/issues/${issue.id}/comments`, companyId);
      setComments(result.data);
      await refreshIssueView();
    } catch (error) {
      setCommentError(error instanceof ApiError ? error.message : "Failed to update comment.");
      throw error;
    }
  }

  async function removeComment(commentId: string) {
    setCommentError(null);
    try {
      await apiDelete(`/issues/${issue.id}/comments/${commentId}`, companyId);
      const result = await apiGet<IssueCommentRow[]>(`/issues/${issue.id}/comments`, companyId);
      setComments(result.data);
      await refreshIssueView();
    } catch (error) {
      setCommentError(error instanceof ApiError ? error.message : "Failed to delete comment.");
      throw error;
    }
  }

  async function uploadAttachments(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    if (files.length === 0) {
      return;
    }
    setAttachmentError(null);
    setIsUploadingAttachments(true);
    try {
      const formData = new FormData();
      files.forEach((file) => formData.append("files", file));
      await apiPostFormData<IssueAttachmentRow[]>(`/issues/${issue.id}/attachments`, companyId, formData);
      await refreshAttachments();
      await refreshIssueView();
    } catch (error) {
      setAttachmentError(error instanceof ApiError ? error.message : "Failed to upload attachments.");
    } finally {
      setIsUploadingAttachments(false);
      event.target.value = "";
    }
  }

  async function removeAttachment(attachmentId: string) {
    setAttachmentError(null);
    try {
      await apiDelete(`/issues/${issue.id}/attachments/${attachmentId}`, companyId);
      await refreshAttachments();
      await refreshIssueView();
    } catch (error) {
      setAttachmentError(error instanceof ApiError ? error.message : "Failed to remove attachment.");
    }
  }

  const leftPane = (
    <div className={styles.issueDetailContainer1}>
      <div className={styles.issueDetailContainer2}>
        <div className={styles.issueDetailContainer4}>
          <div className={styles.issueDetailContainer5}>
            <SectionHeading
              title={issue.title}
              description="Issue details and controls."
            />
          </div>
          <div className={styles.issueHeaderActionsContainer}>
            <Button
              variant="default"
              size="sm"
              onClick={() => void runAssigneeHeartbeat()}
              disabled={!issue.assigneeAgentId || isHeartbeatStarting}
            >
              {isHeartbeatStarting ? "Running..." : "Run heartbeat"}
            </Button>
            <CreateIssueModal
              companyId={companyId}
              projects={projects}
              agents={agents}
              issue={issue}
              triggerLabel="Edit issue"
              triggerVariant="outline"
              triggerSize="sm"
            />
            <ConfirmActionModal
              triggerLabel="Delete issue"
              triggerVariant="outline"
              triggerSize="sm"
              title="Delete issue?"
              description={`Delete "${issue.title}".`}
              confirmLabel="Delete"
              onConfirm={() => removeIssue()}
            />
          </div>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Issue details</CardTitle>
          <CardDescription>Current metadata for this issue.</CardDescription>
        </CardHeader>
        <CardContent className={styles.issueSidebarCardContent}>
          {issue.body?.trim() ? (
            <div className="ui-markdown">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{issue.body}</ReactMarkdown>
            </div>
          ) : (
            <span className="ui-issue-muted-text">No description provided.</span>
          )}
        </CardContent>
      </Card>

      {actionError ? (
            <Alert variant="destructive">
              <AlertTitle>Action failed</AlertTitle>
              <AlertDescription>{actionError}</AlertDescription>
            </Alert>
          ) : null}
          {actionNotice ? (
            <Alert>
              <AlertTitle>Action result</AlertTitle>
              <AlertDescription>{actionNotice}</AlertDescription>
            </Alert>
          ) : null}
          {commentError ? <div className="ui-issue-error-text">{commentError}</div> : null}
          {activityError ? <div className="ui-issue-error-text">{activityError}</div> : null}
          {attachmentError ? <div className="ui-issue-error-text">{attachmentError}</div> : null}
          <Tabs defaultValue="comments">
            <TabsList className="ui-issue-tabs-list">
              <TabsTrigger value="comments">Comments ({comments.length})</TabsTrigger>
              <TabsTrigger value="attachments">Attachments ({attachments.length})</TabsTrigger>
              <TabsTrigger value="subissues">Sub-issues ({subIssues.length})</TabsTrigger>
              <TabsTrigger value="activity">Activity ({activityItems.length})</TabsTrigger>
            </TabsList>
            <TabsContent value="comments" className="ui-issue-tabs-content">
              {commentsLoading ? <div className="ui-issue-muted-text">Loading comments...</div> : null}
              {comments.map((comment) => (
                <div key={comment.id} className="ui-issue-comment-card">
                  <div className="ui-issue-comment-row">
                    <div className="ui-issue-comment-copy">
                      <div className="ui-issue-comment-author">
                        {comment.authorType === "agent"
                          ? agents.find((agent) => agent.id === comment.authorId)?.name ?? "Agent"
                          : comment.authorType}
                        <span className="ui-issue-comment-date">{formatDate(comment.createdAt)}</span>
                      </div>
                      <div className="ui-issue-comment-body ui-markdown ui-markdown-compact">
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>{comment.body}</ReactMarkdown>
                      </div>
                    </div>
                    <div className="ui-issue-action-row">
                      <TextActionModal
                        triggerLabel="Edit"
                        triggerVariant="outline"
                        title="Edit comment"
                        description="Update this comment."
                        submitLabel="Save"
                        initialValue={comment.body}
                        placeholder="Write a comment..."
                        onSubmit={(body) => updateComment(comment.id, body)}
                        multiline
                      />
                      <ConfirmActionModal
                        triggerLabel="Delete"
                        triggerVariant="outline"
                        title="Delete comment?"
                        description="This action cannot be undone."
                        confirmLabel="Delete"
                        onConfirm={() => removeComment(comment.id)}
                      />
                    </div>
                  </div>
                </div>
              ))}
              {!commentsLoading && comments.length === 0 ? <EmptyState>No comments yet for this issue.</EmptyState> : null}
              <form className={styles.issueDetailForm} onSubmit={submitComment}>
                <Textarea
                  value={draftComment}
                  onChange={(event) => setDraftComment(event.target.value)}
                  placeholder="Leave a comment..."
                  className={styles.issueDetailTextarea}
                />
                <div className="ui-issue-form-actions">
                  <Button type="submit" disabled={!draftComment.trim()}>
                    Comment
                  </Button>
                </div>
              </form>
            </TabsContent>
            <TabsContent value="attachments" className="ui-issue-tabs-content">
              {attachmentsLoading ? <div className="ui-issue-muted-text">Loading attachments...</div> : null}
              {!attachmentsLoading && attachments.length === 0 ? <EmptyState>No attachments yet.</EmptyState> : null}
              {attachments.length > 0 ? (
                <ItemGroup>
                  {attachments.map((attachment) => (
                    <Item key={attachment.id} variant="outline">
                      <div className={styles.issueAttachmentMedia}>
                        {isImageAttachment(attachment) ? (
                          <img
                            src={buildAttachmentUrl(attachment.downloadPath, companyId)}
                            alt={attachment.fileName}
                            className={styles.issueAttachmentPreviewImage}
                            loading="lazy"
                          />
                        ) : (
                          <div className={styles.issueAttachmentPlaceholder} aria-hidden>
                            {attachment.fileName.slice(0, 1).toUpperCase()}
                          </div>
                        )}
                      </div>
                      <ItemContent>
                        <ItemTitle>
                          <a
                            href={buildAttachmentUrl(attachment.downloadPath, companyId)}
                            target="_blank"
                            rel="noreferrer"
                            className={styles.issueDetailLink2}
                          >
                            {attachment.fileName}
                          </a>
                        </ItemTitle>
                        <ItemDescription>
                          {attachment.mimeType ?? "unknown type"} · {Math.max(1, Math.ceil(attachment.fileSizeBytes / 1024))} KB · uploaded{" "}
                          {formatDate(attachment.createdAt)}
                        </ItemDescription>
                      </ItemContent>
                      <ItemActions>
                        <Button type="button" variant="outline" size="sm" onClick={() => void removeAttachment(attachment.id)}>
                          Delete
                        </Button>
                      </ItemActions>
                    </Item>
                  ))}
                </ItemGroup>
              ) : null}
              <div className={styles.issueAttachmentActionsRow}>
                <Button asChild variant="outline">
                  <label htmlFor="issue-detail-attachments-upload">
                    {isUploadingAttachments ? "Uploading..." : "Add attachments"}
                  </label>
                </Button>
                <input
                  id="issue-detail-attachments-upload"
                  type="file"
                  multiple
                  onChange={(event) => void uploadAttachments(event)}
                  disabled={isUploadingAttachments}
                  className={styles.issueAttachmentInput}
                />
              </div>
            </TabsContent>
            <TabsContent value="subissues" className="ui-issue-tabs-content">
              {subIssues.length === 0 ? (
                <EmptyState>No sub-issues linked yet.</EmptyState>
              ) : (
                <ItemGroup>
                  {subIssues.map((entry) => (
                    <Item key={entry.id} variant="outline">
                      <ItemContent>
                        <ItemTitle>
                          <Link href={`/issues/${entry.id}?companyId=${companyId}`} className={styles.issueDetailLink2}>
                            {entry.title}
                          </Link>
                        </ItemTitle>
                        <ItemDescription>
                          updated {formatDate(entry.updatedAt)} · {entry.assigneeAgentId ? "assigned" : "unassigned"}
                        </ItemDescription>
                      </ItemContent>
                      <ItemActions>
                        <Badge variant="outline" className={getStatusBadgeClassName(entry.status)}>
                          {entry.status}
                        </Badge>
                      </ItemActions>
                    </Item>
                  ))}
                </ItemGroup>
              )}

              <div className={styles.issueSubIssueActionsRow}>
                <CreateIssueModal
                  companyId={companyId}
                  projects={projects}
                  agents={agents}
                  defaultProjectId={issue.projectId}
                  defaultParentIssueId={issue.id}
                  triggerLabel="Add sub-issue"
                  triggerVariant="outline"
                />
              </div>
            </TabsContent>
            <TabsContent value="activity" className="ui-issue-tabs-content">
              {activityLoading ? <div className="ui-issue-muted-text">Loading activity...</div> : null}
              {activityItems.length === 0 ? (
                <EmptyState>No activity yet.</EmptyState>
              ) : (
                <ItemGroup>
                  {activityItems.map((item) => (
                    <Item key={item.id} variant="outline">
                      <ItemContent>
                        <ItemTitle>
                          <span className={styles.issueActivityTitleRow}>
                            <Badge variant="outline">{item.actorType}</Badge> {formatEventType(item.eventType)}
                          </span>
                        </ItemTitle>
                        {summarizeActivityPayload(item.payload) !== "Event recorded." ? (
                          <ItemDescription>{summarizeActivityPayload(item.payload)}</ItemDescription>
                        ) : null}
                      </ItemContent>
                      <ItemActions>
                        <span className={styles.issueActivityTimestamp}>{formatDate(item.createdAt)}</span>
                      </ItemActions>
                    </Item>
                  ))}
                </ItemGroup>
              )}
            </TabsContent>
          </Tabs>
    </div>
  );

  const rightPane = (
    <div className={styles.issueSidebarContainer}>
      <Card>
        <CardContent className={styles.issueSidebarCardContent}>
          <Field>
            <FieldLabel>Status</FieldLabel>
            <Select value={issue.status} onValueChange={(value) => void updateIssue({ status: value as IssueStatus })}>
              <SelectTrigger className={styles.issueDetailSelectTrigger}>
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

          <Field className="mt-6">
            <FieldLabel>Assigned agent</FieldLabel>
            <Select
              value={issue.assigneeAgentId ?? "unassigned"}
              onValueChange={(value) => void updateIssue({ assigneeAgentId: value === "unassigned" ? null : value })}
            >
              <SelectTrigger className={styles.issueDetailSelectTrigger}>
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
        </CardContent>
      </Card>

      <Card>
        <CardContent className={styles.issueSidebarCardContent}>
          <PropertyRow label="Priority" value={issue.priority} />
          <PropertyRow label="Labels" value={issue.labels.length > 0 ? issue.labels.join(", ") : "No labels"} />
          <PropertyRow label="Assignee" value={selectedAssignee ? `${selectedAssignee.name}` : "Unassigned"} />
          <PropertyRow
            label="Project"
            value={
              selectedProject ? (
                <Link href={`/projects/${selectedProject.id}?companyId=${companyId}`} className={styles.issueDetailLink2}>
                  {selectedProject.name}
                </Link>
              ) : (
                "Unknown"
              )
            }
          />
          <PropertyRow label="Created" value={formatDate(issue.createdAt)} />
          <PropertyRow label="Updated" value={formatDate(issue.updatedAt)} />
          <PropertyRow label="Completed" value={issue.status === "done" ? formatDate(issue.updatedAt) : "Not completed"} />
        </CardContent>
      </Card>

      <div className={styles.issueSidebarStats}>
        <MetricCard label="Total cost" value={`$${issueCostSummary.usd.toFixed(2)}`} />
        <MetricCard label="Input" value={issueCostSummary.input.toLocaleString()} />
        <MetricCard label="Output" value={issueCostSummary.output.toLocaleString()} />
      </div>
    </div>
  );

  return (
    <AppShell
      leftPane={leftPane}
      rightPane={rightPane}
      activeNav="Issues"
      companies={companies}
      activeCompanyId={companyId}
    />
  );
}
