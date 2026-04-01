"use client";

import Link from "next/link";
import type { ColumnDef } from "@tanstack/react-table";
import { useEffect, useMemo, useState, type ChangeEvent, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import type { IssuePriority, IssueStatus } from "bopodev-contracts";
import { AGENT_ROLE_LABELS, AGENT_ROLE_KEYS, type AgentRoleKey } from "bopodev-contracts";
import { ChevronDownIcon, FileTextIcon } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { CollapsibleMarkdown, COLLAPSIBLE_MARKDOWN_BODY_MAX_HEIGHT_PX } from "@/components/markdown-view";
import { AgentAvatar } from "@/components/agent-avatar";
import {
  IssueDocumentDialog,
  type IssueDocumentEditTarget
} from "@/components/modals/add-issue-document-dialog";
import { CreateIssueModal } from "@/components/modals/create-issue-modal";
import { LazyMarkdownMdxEditor } from "@/components/modals/lazy-markdown-mdx-editor";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldLabel } from "@/components/ui/field";
import { DataTable } from "@/components/ui/data-table";
import { DataTableColumnHeader } from "@/components/ui/data-table-column-header";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ApiError, apiDelete, apiGet, apiPost, apiPostFormData, apiPut } from "@/lib/api";
import { formatIssueActivityActorLabel, formatIssueActivityTitle } from "@/lib/event-display";
import { PluginSlotRenderer } from "@/components/plugins/plugin-slot-renderer";
import type { PluginRow } from "@/components/workspace/types";
import { resolvePluginSlots } from "@/lib/plugins/slot-registry";
import { formatSmartDateTime } from "@/lib/smart-date";
import { agentAvatarSeed } from "@/lib/agent-avatar";
import { getStatusBadgeClassName } from "@/lib/status-presentation";
import { cn } from "@/lib/utils";
import { MetricCard, SectionHeading, formatDateTime } from "./workspace/shared";

interface IssueRow {
  id: string;
  projectId: string;
  parentIssueId?: string | null;
  /** Set when this issue was opened by a routine run. */
  routineId?: string | null;
  goalIds?: string[];
  assigneeAgentId: string | null;
  title: string;
  body?: string | null;
  status: IssueStatus;
  priority: string;
  labels: string[];
  tags: string[];
  externalLink?: string | null;
  createdAt: string;
  updatedAt: string;
}

interface AgentRow {
  id: string;
  name: string;
  role: string;
  roleKey?: AgentRoleKey | null;
  title?: string | null;
  avatarSeed?: string | null;
  lucideIconName?: string | null;
  managerAgentId?: string | null;
  status?: string;
}

interface ProjectRow {
  id: string;
  name: string;
}

interface GoalPickerRow {
  id: string;
  title: string;
  projectId: string | null;
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
  runId?: string | null;
  recipients: Array<{
    recipientType: "agent" | "board" | "member";
    recipientId: string | null;
    deliveryStatus: "pending" | "dispatched" | "failed" | "skipped";
    dispatchedRunId: string | null;
    dispatchedAt: string | null;
    acknowledgedAt: string | null;
  }>;
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
  runId: string | null;
  jobId?: string | null;
  requestId?: string;
  status?: "queued" | "started" | "skipped";
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

interface IssueRoutineRow {
  id: string;
  title: string;
  projectId: string;
  parentIssueId: string | null;
  assigneeAgentId: string;
  status: string;
  updatedAt: string;
}

const issueStatusOptions = [
  { value: "todo", label: "Todo" },
  { value: "in_progress", label: "In progress" },
  { value: "blocked", label: "Blocked" },
  { value: "in_review", label: "In review" },
  { value: "done", label: "Done" },
  { value: "canceled", label: "Canceled" }
] as const;
const issuePriorityOptions = [
  { value: "none", label: "None" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "urgent", label: "Urgent" }
] as const;
const boardRecipientKey = "board:all";
const boardRecipientLabel = "Board";
const issueCommentMaxHeightPx = 220;

function normalizeIssuePriority(value: string | null | undefined): IssuePriority {
  if (value === "low" || value === "medium" || value === "high" || value === "urgent") {
    return value;
  }
  return "none";
}

function makeRecipientKey(recipientType: "agent" | "board" | "member", recipientId: string | null) {
  return `${recipientType}:${recipientId ?? "all"}`;
}

function toRecipientPayload(selectedRecipientKey: string | null) {
  if (!selectedRecipientKey) {
    return [] as Array<{ recipientType: "agent" | "board" | "member"; recipientId: string | null }>;
  }
  const [recipientTypeRaw, ...idParts] = selectedRecipientKey.split(":");
  const recipientType = recipientTypeRaw === "agent" || recipientTypeRaw === "board" || recipientTypeRaw === "member"
    ? recipientTypeRaw
    : null;
  if (!recipientType) {
    return [] as Array<{ recipientType: "agent" | "board" | "member"; recipientId: string | null }>;
  }
  const recipientId = idParts.join(":");
  return [{
    recipientType,
    recipientId: recipientType === "board" || recipientId === "all" ? null : recipientId
  }];
}

function EmptyState({ children }: { children: React.ReactNode }) {
  return <div className={cn("ui-feature-empty-state", "mb-8")}>{children}</div>;
}

function PropertyRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="ui-property-field">
      <div className="ui-property-label">{label}</div>
      <div className="ui-property-value">{value}</div>
    </div>
  );
}

function formatDate(value: string | null | undefined) {
  return value ? new Date(value).toLocaleString() : "Not set";
}

function formatCommentAuthorLabel(
  comment: Pick<IssueCommentRow, "authorType" | "authorId">,
  agents: AgentRow[]
) {
  if (comment.authorType === "agent") {
    return agents.find((agent) => agent.id === comment.authorId)?.name ?? "Agent";
  }
  if (comment.authorType === "human") {
    return "Board";
  }
  return "System";
}

function formatCommentAuthorBadgeLabel(
  comment: Pick<IssueCommentRow, "authorType">
) {
  if (comment.authorType === "human") {
    return "B";
  }
  if (comment.authorType === "system") {
    return "S";
  }
  return "A";
}

function normalizeRoleKey(value: string | null | undefined): AgentRoleKey | null {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  return AGENT_ROLE_KEYS.includes(normalized as AgentRoleKey) ? (normalized as AgentRoleKey) : null;
}

function getAgentDisplayRole(agent: Pick<AgentRow, "role" | "roleKey" | "title">) {
  const title = typeof agent.title === "string" ? agent.title.trim() : "";
  if (title) {
    return title;
  }
  const roleKey = normalizeRoleKey(agent.roleKey);
  if (roleKey) {
    return AGENT_ROLE_LABELS[roleKey];
  }
  return agent.role;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function formatInlineApiErrorText(input: string) {
  const match = input.match(/^(?<prefix>[\s\S]*?)\bapi\s+er+r?or:?\s*(?<status>\d{3})\s*(?<payload>\{[\s\S]*\})\s*$/i);
  if (!match?.groups) {
    return null;
  }
  const prefix = (match.groups.prefix ?? "").trim();
  const status = (match.groups.status ?? "").trim();
  const payload = (match.groups.payload ?? "").trim();
  if (!status || !payload) {
    return null;
  }
  try {
    const parsed = JSON.parse(payload) as {
      message?: unknown;
      error?: { message?: unknown } | unknown;
    };
    const parsedError =
      parsed.error && typeof parsed.error === "object" && !Array.isArray(parsed.error)
        ? (parsed.error as { message?: unknown })
        : null;
    const message =
      typeof parsedError?.message === "string" && parsedError.message.trim()
        ? parsedError.message.trim()
        : typeof parsed.message === "string" && parsed.message.trim()
          ? parsed.message.trim()
          : null;
    const formatted = message ? `API error ${status}: ${message}` : `API error ${status}`;
    return prefix ? `${prefix} ${formatted}` : formatted;
  } catch {
    const fallback = `API error ${status}`;
    return prefix ? `${prefix} ${fallback}` : fallback;
  }
}

function normalizeAgentCommentBodyForDisplay(body: string) {
  const trimmed = body.trim();
  if (!trimmed) {
    return body;
  }
  const inlineApiError = formatInlineApiErrorText(trimmed);
  if (inlineApiError) {
    return inlineApiError;
  }
  const extractedSummary = extractSummaryFromJsonLikeText(trimmed);
  const isPureJsonLike =
    /^\s*\{[\s\S]*\}\s*$/m.test(trimmed) || /^\s*```(?:json)?[\s\S]*```\s*$/im.test(trimmed);
  if (isPureJsonLike && extractedSummary) {
    return extractedSummary;
  }
  const trailingJsonSummary = trimmed.match(/^(?<main>[\s\S]*?)\n+\{[\s\S]*"summary"\s*:\s*"[\s\S]*?"[\s\S]*\}\s*$/);
  if (trailingJsonSummary?.groups?.main) {
    return trailingJsonSummary.groups.main.trim();
  }
  return body;
}

function collapseRunComments(comments: IssueCommentRow[]) {
  const chosenCommentIdsByRunKey = new Map<string, string>();
  const commentsById = new Map(comments.map((comment) => [comment.id, comment]));
  for (const comment of comments) {
    if (!comment.runId) {
      continue;
    }
    const runKey = `${comment.runId}:${comment.authorType}:${comment.authorId ?? "unknown"}`;
    const existingId = chosenCommentIdsByRunKey.get(runKey);
    if (!existingId) {
      chosenCommentIdsByRunKey.set(runKey, comment.id);
      continue;
    }
    const existingComment = commentsById.get(existingId);
    if (existingComment && existingComment.createdAt < comment.createdAt) {
      chosenCommentIdsByRunKey.set(runKey, comment.id);
    }
  }
  return comments.filter((comment) => {
    if (!comment.runId) {
      return true;
    }
    const runKey = `${comment.runId}:${comment.authorType}:${comment.authorId ?? "unknown"}`;
    return chosenCommentIdsByRunKey.get(runKey) === comment.id;
  });
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

function isMarkdownDocument(attachment: IssueAttachmentRow) {
  if (attachment.mimeType === "text/markdown") {
    return true;
  }
  return /\.md$/i.test(attachment.fileName);
}

function attachmentDescriptionLine(attachment: IssueAttachmentRow, uploadedLabel: string) {
  const kb = Math.max(1, Math.ceil(attachment.fileSizeBytes / 1024));
  if (isMarkdownDocument(attachment)) {
    return `Markdown document · ${kb} KB · uploaded ${uploadedLabel}`;
  }
  return `${attachment.mimeType ?? "unknown type"} · ${kb} KB · uploaded ${uploadedLabel}`;
}

export function IssueDetailPageClient({
  companyId,
  companies,
  issue,
  allIssues,
  agents,
  projects,
  goals,
  costEntries
}: {
  companyId: string;
  companies: Array<{ id: string; name: string }>;
  issue: IssueRow;
  allIssues: IssueRow[];
  agents: AgentRow[];
  projects: ProjectRow[];
  goals: GoalPickerRow[];
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
  const [loopsLoading, setLoopsLoading] = useState(false);
  const [loopsError, setLoopsError] = useState<string | null>(null);
  const [pluginError, setPluginError] = useState<string | null>(null);
  const [loops, setLoops] = useState<IssueRoutineRow[]>([]);
  const [plugins, setPlugins] = useState<PluginRow[]>([]);
  const [comments, setComments] = useState<IssueCommentRow[]>([]);
  const [activityItems, setActivityItems] = useState<IssueActivityRow[]>([]);
  const [attachments, setAttachments] = useState<IssueAttachmentRow[]>([]);
  const [draftComment, setDraftComment] = useState("");
  const [commentEditorMdxKey, setCommentEditorMdxKey] = useState(0);
  /** Host for MDXEditor popups so they are not appended to `body` with duplicate min-height classes. */
  const [commentMdxOverlayHost, setCommentMdxOverlayHost] = useState<HTMLDivElement | null>(null);
  const [selectedRecipientKey, setSelectedRecipientKey] = useState<string | null>(null);
  const [isSubmittingComment, setIsSubmittingComment] = useState(false);
  const [isHeartbeatStarting, setIsHeartbeatStarting] = useState(false);
  const [isUploadingAttachments, setIsUploadingAttachments] = useState(false);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [issueDocumentDialogOpen, setIssueDocumentDialogOpen] = useState(false);
  const [issueDocumentEditTarget, setIssueDocumentEditTarget] = useState<IssueDocumentEditTarget | null>(null);
  const visibleComments = useMemo(() => collapseRunComments(comments), [comments]);

  const selectedProject = useMemo(
    () => projects.find((project) => project.id === issue.projectId) ?? null,
    [issue.projectId, projects]
  );

  const selectedAssignee = useMemo(
    () => agents.find((agent) => agent.id === issue.assigneeAgentId) ?? null,
    [agents, issue.assigneeAgentId]
  );
  const recipientOptions = useMemo(
    () =>
      agents
        .filter((agent) => agent.status !== "terminated")
        .map((agent) => ({
          key: makeRecipientKey("agent", agent.id),
          label: agent.name.trim() || getAgentDisplayRole(agent)
        })),
    [agents]
  );
  const selectedRecipientLabel = useMemo(() => {
    if (!selectedRecipientKey) {
      return "Assign";
    }
    if (selectedRecipientKey === boardRecipientKey) {
      return boardRecipientLabel;
    }
    return recipientOptions.find((entry) => entry.key === selectedRecipientKey)?.label ?? "Select recipient";
  }, [recipientOptions, selectedRecipientKey]);

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

  const issueLoops = useMemo(() => {
    const linked = loops.filter(
      (loop) => loop.parentIssueId === issue.id || (issue.routineId != null && issue.routineId === loop.id)
    );
    const byId = new Map(linked.map((loop) => [loop.id, loop]));
    return [...byId.values()].sort(
      (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    );
  }, [loops, issue.id, issue.routineId]);
  const issueDetailPluginSlots = useMemo(() => resolvePluginSlots(plugins, "issueDetailTab"), [plugins]);
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
    async function loadPlugins() {
      setPluginError(null);
      try {
        const result = await apiGet<PluginRow[]>("/plugins", companyId);
        if (!cancelled) {
          setPlugins(result.data);
        }
      } catch (error) {
        if (!cancelled) {
          setPluginError(error instanceof ApiError ? error.message : "Failed to load plugins.");
        }
      }
    }
    void loadPlugins();
    return () => {
      cancelled = true;
    };
  }, [companyId]);

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

  useEffect(() => {
    let cancelled = false;

    async function loadLoops() {
      setLoopsLoading(true);
      setLoopsError(null);
      try {
        const result = await apiGet<{ data: IssueRoutineRow[] }>("/routines", companyId);
        if (!cancelled) {
          setLoops(result.data.data ?? []);
        }
      } catch (error) {
        if (!cancelled) {
          setLoopsError(error instanceof ApiError ? error.message : "Failed to load routines.");
          setLoops([]);
        }
      } finally {
        if (!cancelled) {
          setLoopsLoading(false);
        }
      }
    }

    void loadLoops();

    return () => {
      cancelled = true;
    };
  }, [companyId]);

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
      const [activityResult, commentsResult] = await Promise.all([
        apiGet<IssueActivityRow[]>(`/issues/${issue.id}/activity`, companyId),
        apiGet<IssueCommentRow[]>(`/issues/${issue.id}/comments`, companyId)
      ]);
      setActivityItems(activityResult.data);
      setComments(commentsResult.data);
      setActivityError(null);
      setCommentError(null);
    } catch (error) {
      setActivityError(error instanceof ApiError ? error.message : "Failed to load issue activity.");
    }
  }

  async function pollCommentDispatch(commentId: string) {
    for (let attempt = 0; attempt < 15; attempt += 1) {
      await sleep(1000);
      try {
        const result = await apiGet<IssueCommentRow[]>(`/issues/${issue.id}/comments`, companyId);
        setComments(result.data);
        const targetComment = result.data.find((comment) => comment.id === commentId);
        const hasPendingRecipient = (targetComment?.recipients ?? []).some(
          (recipient) => recipient.deliveryStatus === "pending"
        );
        if (!hasPendingRecipient) {
          break;
        }
      } catch {
        break;
      }
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

  function formatRecipientDisplay(
    recipient: IssueCommentRow["recipients"][number]
  ) {
    if (recipient.recipientType === "board") {
      return boardRecipientLabel;
    }
    if (recipient.recipientType === "agent") {
      const agentName = agents.find((agent) => agent.id === recipient.recipientId)?.name;
      return agentName ?? `Agent ${recipient.recipientId ?? "unknown"}`;
    }
    return recipient.recipientId ? `Member ${recipient.recipientId}` : "Member";
  }

  async function updateIssue(payload: {
    title?: string;
    body?: string | null;
    status?: IssueStatus;
    priority?: IssuePriority;
    assigneeAgentId?: string | null;
    labels?: string[];
  }) {
    await runIssueAction(async () => {
      await apiPut(`/issues/${issue.id}`, companyId, payload);
    }, "Failed to update issue.");
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
      if (response.data.status === "queued") {
        setActionNotice(`Heartbeat queued (job ${response.data.jobId ?? "unknown"}).`);
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
    if (!draftComment.trim() || isSubmittingComment) {
      return;
    }

    setCommentError(null);
    setIsSubmittingComment(true);
    try {
      const response = await apiPost<IssueCommentRow>(`/issues/${issue.id}/comments`, companyId, {
        body: draftComment.trim(),
        authorType: "human",
        recipients: toRecipientPayload(selectedRecipientKey)
      });
      setComments((current) => [...current.filter((comment) => comment.id !== response.data.id), response.data]);
      setDraftComment("");
      setCommentEditorMdxKey((k) => k + 1);
      setSelectedRecipientKey(null);
      void refreshIssueView();
      if ((response.data.recipients ?? []).some((recipient) => recipient.deliveryStatus === "pending")) {
        void pollCommentDispatch(response.data.id);
      }
    } catch (error) {
      setCommentError(error instanceof ApiError ? error.message : "Failed to add comment.");
    } finally {
      setIsSubmittingComment(false);
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

  const issueAttachmentColumns: ColumnDef<IssueAttachmentRow>[] = [
    {
      id: "preview",
      header: "",
      enableSorting: false,
      cell: ({ row }) => {
        const attachment = row.original;
        return (
          <div className="ui-issue-attachment-media">
            {isImageAttachment(attachment) ? (
              <img
                src={buildAttachmentUrl(attachment.downloadPath, companyId)}
                alt={attachment.fileName}
                className="ui-issue-attachment-preview"
                loading="lazy"
              />
            ) : isMarkdownDocument(attachment) ? (
              <div className="ui-issue-attachment-svg-wrap" aria-hidden>
                <FileTextIcon className="ui-issue-attachment-svg" />
              </div>
            ) : (
              <div className="ui-issue-attachment-placeholder" aria-hidden>
                {attachment.fileName.slice(0, 1).toUpperCase()}
              </div>
            )}
          </div>
        );
      }
    },
    {
      accessorKey: "fileName",
      header: ({ column }) => <DataTableColumnHeader column={column} title="File" />,
      cell: ({ row }) => {
        const attachment = row.original;
        return isMarkdownDocument(attachment) ? (
          <button
            type="button"
            className="ui-issue-attachment-title"
            onClick={() => {
              setIssueDocumentEditTarget({
                id: attachment.id,
                fileName: attachment.fileName,
                downloadPath: attachment.downloadPath
              });
              setIssueDocumentDialogOpen(true);
            }}
          >
            {attachment.fileName}
          </button>
        ) : (
          <a
            href={buildAttachmentUrl(attachment.downloadPath, companyId)}
            target="_blank"
            rel="noreferrer"
            className="ui-link-sidebar-nested"
          >
            {attachment.fileName}
          </a>
        );
      }
    },
    {
      id: "details",
      header: ({ column }) => <DataTableColumnHeader column={column} title="Details" />,
      enableSorting: false,
      cell: ({ row }) => (
        <span className="ui-run-table-cell-muted text-sm">
          {attachmentDescriptionLine(row.original, formatSmartDateTime(row.original.createdAt))}
        </span>
      )
    },
    {
      id: "actions",
      header: () => <div className="ui-table-head-right">Actions</div>,
      enableSorting: false,
      cell: ({ row }) => (
        <Button type="button" variant="outline" size="sm" onClick={() => void removeAttachment(row.original.id)}>
          Delete
        </Button>
      )
    }
  ];

  const issueSubIssueColumns: ColumnDef<IssueRow>[] = [
    {
      accessorKey: "title",
      header: ({ column }) => <DataTableColumnHeader column={column} title="Title" />,
      cell: ({ row }) => (
        <Link href={`/issues/${row.original.id}?companyId=${companyId}`} className="ui-link-sidebar-nested">
          {row.original.title}
        </Link>
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
    },
    {
      accessorKey: "updatedAt",
      header: ({ column }) => <DataTableColumnHeader column={column} title="Updated" />,
      cell: ({ row }) => (
        <time className="ui-run-table-datetime" dateTime={row.original.updatedAt} title={formatDateTime(row.original.updatedAt)}>
          {formatSmartDateTime(row.original.updatedAt)}
        </time>
      )
    },
    {
      id: "assignee",
      header: ({ column }) => <DataTableColumnHeader column={column} title="Assignee" />,
      enableSorting: false,
      cell: ({ row }) => {
        const agent = agents.find((a) => a.id === row.original.assigneeAgentId);
        const label =
          agent != null
            ? agent.name.trim() || getAgentDisplayRole(agent)
            : row.original.assigneeAgentId ?? "Unassigned";
        return <span className="ui-run-table-cell-muted">{label}</span>;
      }
    }
  ];

  const issueLoopColumns: ColumnDef<IssueRoutineRow>[] = [
    {
      accessorKey: "title",
      header: ({ column }) => <DataTableColumnHeader column={column} title="Routine" />,
      cell: ({ row }) => (
        <Link
          href={{ pathname: `/routines/${row.original.id}`, query: { companyId } }}
          className="ui-link-sidebar-nested"
        >
          {row.original.title}
        </Link>
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
    },
    {
      id: "assignee",
      header: ({ column }) => <DataTableColumnHeader column={column} title="Assignee" />,
      enableSorting: false,
      cell: ({ row }) => {
        const assignee = agents.find((a) => a.id === row.original.assigneeAgentId);
        const assigneeLabel =
          assignee != null
            ? assignee.name.trim() || getAgentDisplayRole(assignee)
            : row.original.assigneeAgentId;
        return <span className="ui-run-table-cell-muted">{assigneeLabel}</span>;
      }
    },
    {
      accessorKey: "updatedAt",
      header: ({ column }) => <DataTableColumnHeader column={column} title="Updated" />,
      cell: ({ row }) => (
        <time className="ui-run-table-datetime" dateTime={row.original.updatedAt} title={formatDateTime(row.original.updatedAt)}>
          {formatSmartDateTime(row.original.updatedAt)}
        </time>
      )
    }
  ];

  const issueActivityColumns: ColumnDef<IssueActivityRow>[] = [
    {
      accessorKey: "createdAt",
      header: ({ column }) => <DataTableColumnHeader column={column} title="Time" />,
      cell: ({ row }) => (
        <time
          className="ui-run-table-datetime"
          dateTime={row.original.createdAt}
          title={formatDateTime(row.original.createdAt)}
        >
          {formatSmartDateTime(row.original.createdAt, { includeSeconds: true })}
        </time>
      )
    },
    {
      accessorKey: "actorType",
      header: ({ column }) => <DataTableColumnHeader column={column} title="Actor" />,
      cell: ({ row }) => (
        <Badge variant="outline">{formatIssueActivityActorLabel(row.original.actorType)}</Badge>
      )
    },
    {
      id: "summary",
      accessorKey: "eventType",
      header: ({ column }) => <DataTableColumnHeader column={column} title="Summary" />,
      enableSorting: false,
      cell: ({ row }) => (
        <span className="ui-issue-activity-message min-w-0" title={row.original.eventType}>
          {formatIssueActivityTitle(row.original, agents)}
        </span>
      )
    },
    {
      id: "details",
      header: ({ column }) => <DataTableColumnHeader column={column} title="Details" />,
      enableSorting: false,
      cell: ({ row }) => {
        const line = summarizeActivityPayload(row.original.payload);
        if (line === "Event recorded.") {
          return <span className="ui-run-table-cell-muted">—</span>;
        }
        return <span className="ui-run-table-cell-muted text-sm">{line}</span>;
      }
    }
  ];

  const leftPane = (
    <div className="ui-page-stack">
      <div className="ui-page-section-gap-sm">
        <div className="ui-page-header-row">
          <div className="ui-page-header-intro">
            <SectionHeading
              title={issue.title}
              description="Issue details and controls."
            />
          </div>
          <div className="ui-page-header-actions">
            <CreateIssueModal
              companyId={companyId}
              projects={projects}
              agents={agents}
              goals={goals}
              issue={issue}
              triggerLabel="Edit issue"
              triggerVariant="outline"
              triggerSize="sm"
            />
            <Button
              variant="default"
              size="sm"
              onClick={() => void runAssigneeHeartbeat()}
              disabled={!issue.assigneeAgentId || isHeartbeatStarting}
            >
              {isHeartbeatStarting ? "Running..." : "Run heartbeat"}
            </Button>
          </div>
        </div>
      </div>

      {issue.externalLink?.trim() ? (
        <Card>
          <CardContent className="ui-detail-sidebar-section">
            <div className="ui-property-label">External link</div>
            <a
              href={issue.externalLink.trim()}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm break-all underline underline-offset-2"
            >
              {issue.externalLink.trim()}
            </a>
          </CardContent>
        </Card>
      ) : null}

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
          {loopsError ? <div className="ui-issue-error-text">{loopsError}</div> : null}
          {pluginError ? <div className="ui-issue-error-text">{pluginError}</div> : null}

          <Tabs defaultValue="comments" className="ui-tabs-gap-none">
            <TabsList className="ui-issue-tabs-list">
              <TabsTrigger value="description">Description</TabsTrigger>
              <TabsTrigger value="comments">Comments ({visibleComments.length})</TabsTrigger>
              <TabsTrigger value="attachments">Attachments ({attachments.length})</TabsTrigger>
              <TabsTrigger value="subissues">Sub-issues ({subIssues.length})</TabsTrigger>
              <TabsTrigger value="routines">Routines ({issueLoops.length})</TabsTrigger>
              <TabsTrigger value="activity">Activity ({activityItems.length})</TabsTrigger>
              {issueDetailPluginSlots.length > 0 ? <TabsTrigger value="plugins">Plugins ({issueDetailPluginSlots.length})</TabsTrigger> : null}
            </TabsList>
            <TabsContent value="description" className="ui-issue-tabs-content">
              <Card>
                <CardContent className="ui-detail-sidebar-section">
                  {issue.body?.trim() ? (
                    <CollapsibleMarkdown
                      content={issue.body}
                      className="ui-markdown"
                      maxHeightPx={COLLAPSIBLE_MARKDOWN_BODY_MAX_HEIGHT_PX}
                    />
                  ) : (
                    <span className="ui-issue-muted-text">No description provided.</span>
                  )}
                </CardContent>
              </Card>
            </TabsContent>
            <TabsContent value="comments" className="ui-issue-tabs-content">
            <form onSubmit={submitComment}>
              <Card>
                <CardContent>
                  <div
                    className={cn(
                      "relative min-w-0",
                      isSubmittingComment && "pointer-events-none opacity-60"
                    )}
                  >
                    <div
                      ref={setCommentMdxOverlayHost}
                      className="mdxeditor-popup-mount pointer-events-none absolute left-0 right-0 top-0 z-1 h-0 overflow-visible"
                      aria-hidden
                    />
                    {commentMdxOverlayHost ? (
                      <LazyMarkdownMdxEditor
                        editorKey={`issue-comment-${issue.id}-${commentEditorMdxKey}`}
                        markdown={draftComment}
                        onChange={setDraftComment}
                        placeholder="Leave a comment…"
                        issueComment
                        className="ui-issue-comment-mdx-editor"
                        overlayContainer={commentMdxOverlayHost}
                      />
                    ) : null}
                  </div>
                </CardContent>
                <CardFooter className="ui-loop-card-footer-actions gap-6">
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button type="button" variant="outline" disabled={isSubmittingComment}>
                        {selectedRecipientLabel} <ChevronDownIcon className="ui-issue-comment-chevron" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start">
                      <DropdownMenuCheckboxItem
                        checked={selectedRecipientKey === null}
                        onCheckedChange={() => setSelectedRecipientKey(null)}
                      >
                        None
                      </DropdownMenuCheckboxItem>
                      <DropdownMenuCheckboxItem
                        checked={selectedRecipientKey === boardRecipientKey}
                        onCheckedChange={() => setSelectedRecipientKey(boardRecipientKey)}
                      >
                        {boardRecipientLabel}
                      </DropdownMenuCheckboxItem>
                      {recipientOptions.map((recipient) => (
                        <DropdownMenuCheckboxItem
                          key={recipient.key}
                          checked={selectedRecipientKey === recipient.key}
                          onCheckedChange={() => setSelectedRecipientKey(recipient.key)}
                        >
                          {recipient.label}
                        </DropdownMenuCheckboxItem>
                      ))}
                    </DropdownMenuContent>
                    </DropdownMenu>
                    <Button type="submit" disabled={!draftComment.trim() || isSubmittingComment}>
                      {isSubmittingComment ? "Saving..." : "Comment"}
                    </Button>
                  </CardFooter>
                </Card>
              </form>
              {commentsLoading ? <div className="ui-issue-muted-text">Loading comments...</div> : null}
              <SectionHeading
                title="Comments"
                description="Comments on this issue."
              />
              {visibleComments.map((comment) => (
                <div key={comment.id} className="ui-issue-comment-card">
                  <div className="ui-issue-comment-row">
                    <div className="ui-issue-comment-copy">
                      <div className="ui-issue-comment-header-row">
                        <div className="ui-issue-comment-author-row">
                          {comment.authorType === "agent" ? (
                            <AgentAvatar
                              seed={agentAvatarSeed(
                                comment.authorId ?? "agent",
                                formatCommentAuthorLabel(comment, agents),
                                agents.find((agent) => agent.id === comment.authorId)?.avatarSeed
                              )}
                              name={formatCommentAuthorLabel(comment, agents)}
                              size={32}
                              className="ui-issue-comment-avatar"
                              lucideIconName={agents.find((a) => a.id === comment.authorId)?.lucideIconName}
                            />
                          ) : (
                            <div className="ui-issue-comment-avatar-fallback" aria-hidden>
                              {formatCommentAuthorBadgeLabel(comment)}
                            </div>
                          )}
                          <div className="ui-issue-comment-author">{formatCommentAuthorLabel(comment, agents)}</div>
                        </div>
                        <span className="ui-issue-comment-time">{formatSmartDateTime(comment.createdAt)}</span>
                      </div>
                      <CollapsibleMarkdown
                        content={comment.authorType === "agent" ? normalizeAgentCommentBodyForDisplay(comment.body) : comment.body}
                        className="ui-issue-comment-body ui-markdown ui-markdown-compact"
                        maxHeightPx={issueCommentMaxHeightPx}
                      />
                      {(comment.recipients ?? []).length > 0 ? (
                        <div className="ui-issue-comment-meta-row">
                          {(comment.recipients ?? []).map((recipient) => (
                            <Badge key={`${comment.id}-${recipient.recipientType}-${recipient.recipientId ?? "all"}`} variant="outline">
                              {formatRecipientDisplay(recipient)}
                            </Badge>
                          ))}
                          {(comment.recipients ?? [])
                            .filter((recipient) => Boolean(recipient.dispatchedRunId))
                            .map((recipient) => (
                              <Link
                                key={`${comment.id}-${recipient.recipientType}-${recipient.recipientId ?? "all"}-run`}
                                href={{ pathname: `/runs/${recipient.dispatchedRunId}`, query: { companyId } }}
                                className="ui-link-sidebar-nested"
                              >
                                <Badge variant="outline">Run {recipient.dispatchedRunId}</Badge>
                              </Link>
                            ))}
                        </div>
                      ) : null}
                      {comment.runId ? (
                        <div className="ui-issue-comment-meta-row">
                          <Link href={{ pathname: `/runs/${comment.runId}`, query: { companyId } }} className="ui-link-sidebar-nested">
                            <Badge variant="outline">Run {comment.runId}</Badge>
                          </Link>
                        </div>
                      ) : null}
                    </div>
                  </div>
                </div>
              ))}
              {!commentsLoading && visibleComments.length === 0 ? <EmptyState>No comments yet for this issue.</EmptyState> : null}
            </TabsContent>
            <TabsContent value="attachments" className="ui-issue-tabs-content">
              {attachmentsLoading ? <div className="ui-issue-muted-text">Loading attachments...</div> : null}
              {!attachmentsLoading && attachments.length === 0 ? <EmptyState>No attachments yet.</EmptyState> : null}
              {attachments.length > 0 ? (
                <DataTable
                  columns={issueAttachmentColumns}
                  data={attachments}
                  emptyMessage="No attachments yet."
                  showViewOptions={false}
                />
              ) : null}
              <div className="ui-issue-attachment-actions">
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
                  className="ui-issue-attachment-input"
                />
                <Button
                  type="button"
                  variant="outline"
                  disabled={isUploadingAttachments}
                  onClick={() => {
                    setIssueDocumentEditTarget(null);
                    setIssueDocumentDialogOpen(true);
                  }}
                >
                  Add document
                </Button>
                <IssueDocumentDialog
                  companyId={companyId}
                  issueId={issue.id}
                  open={issueDocumentDialogOpen}
                  onOpenChange={(next) => {
                    setIssueDocumentDialogOpen(next);
                    if (!next) {
                      setIssueDocumentEditTarget(null);
                    }
                  }}
                  editTarget={issueDocumentEditTarget}
                  onUploaded={async () => {
                    await refreshAttachments();
                    await refreshIssueView();
                  }}
                />
              </div>
            </TabsContent>
            <TabsContent value="subissues" className="ui-issue-tabs-content">
              {subIssues.length === 0 ? (
                <EmptyState>No sub-issues linked yet.</EmptyState>
              ) : (
                <>
                  <SectionHeading
                    title="Sub-issues"
                    description="Sub-issues linked to this issue."
                  />
                  <DataTable
                    columns={issueSubIssueColumns}
                    data={subIssues}
                    emptyMessage="No sub-issues linked yet."
                    showViewOptions={false}
                  />
                </>
              )}

              <div className="ui-issue-subissue-actions">
                <CreateIssueModal
                  companyId={companyId}
                  projects={projects}
                  agents={agents}
                  goals={goals}
                  defaultProjectId={issue.projectId}
                  defaultParentIssueId={issue.id}
                  triggerLabel="Add sub-issue"
                  triggerSize="sm"
                  triggerVariant="outline"
                />
              </div>
            </TabsContent>
            <TabsContent value="routines" className="ui-issue-tabs-content">
              {loopsLoading ? <div className="ui-issue-muted-text">Loading routines...</div> : null}
              {!loopsLoading && issueLoops.length === 0 ? (
                <EmptyState>
                  No linked routines yet. Routines appear here when this issue is the routine&apos;s parent issue, or when
                  this issue was opened by a routine run.
                </EmptyState>
              ) : null}
              {issueLoops.length > 0 ? (
                <>
                  <SectionHeading
                  title="Routines"
                  description="Linked routines for this issue."
                />
                  <DataTable
                    columns={issueLoopColumns}
                    data={issueLoops}
                    emptyMessage="No linked routines yet."
                    showViewOptions={false}
                  />
                </>
              ) : null}
              <div className="ui-issue-subissue-actions">
                <Button asChild variant="outline">
                  <Link href={{ pathname: "/routines", query: { companyId } }}>Open Routines</Link>
                </Button>
              </div>
            </TabsContent>
            <TabsContent value="activity" className="ui-issue-tabs-content">
              {activityLoading ? <div className="ui-issue-muted-text">Loading activity...</div> : null}
              {!activityLoading && activityItems.length === 0 ? <EmptyState>No activity yet.</EmptyState> : null}
              {activityItems.length > 0 ? (
                <>
                  <SectionHeading
                    title="Activity"
                    description="Activity log for this issue."
                  />
                  <DataTable
                    columns={issueActivityColumns}
                    data={activityItems}
                    emptyMessage="No activity yet."
                    showViewOptions={false}
                  />
                </>
              ) : null}
            </TabsContent>
            <TabsContent value="plugins" className="ui-issue-tabs-content">
              <PluginSlotRenderer companyId={companyId} slot="issueDetailTab" plugins={plugins} issueId={issue.id} />
            </TabsContent>
          </Tabs>
    </div>
  );

  const rightPane = (
    <div className="ui-detail-sidebar">
      <Card>
        <CardContent className="ui-detail-sidebar-section">
          <Field>
            <FieldLabel>Status</FieldLabel>
            <Select value={issue.status} onValueChange={(value) => void updateIssue({ status: value as IssueStatus })}>
              <SelectTrigger className="ui-select-trigger-full">
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
            <FieldLabel>Priority</FieldLabel>
            <Select
              value={normalizeIssuePriority(issue.priority)}
              onValueChange={(value) => void updateIssue({ priority: value as IssuePriority })}
            >
              <SelectTrigger className="ui-select-trigger-full">
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

          <Field>
            <FieldLabel>Assigned agent</FieldLabel>
            <Select
              value={issue.assigneeAgentId ?? "unassigned"}
              onValueChange={(value) => void updateIssue({ assigneeAgentId: value === "unassigned" ? null : value })}
            >
              <SelectTrigger className="ui-select-trigger-full">
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
        <CardContent className="ui-detail-sidebar-section">
          <PropertyRow label="Labels" value={issue.labels.length > 0 ? issue.labels.join(", ") : "No labels"} />
          <PropertyRow label="Assignee" value={selectedAssignee ? `${selectedAssignee.name}` : "Unassigned"} />
          <PropertyRow
            label="Project"
            value={
              selectedProject ? (
                <Link href={`/projects/${selectedProject.id}?companyId=${companyId}`} className="ui-link-sidebar-nested">
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

      <div className="ui-detail-sidebar-metrics">
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
