"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { ColumnDef } from "@tanstack/react-table";
import type { ExecutionOutcome } from "bopodev-contracts";
import { AppShell } from "@/components/app-shell";
import { AgentAvatar } from "@/components/agent-avatar";
import { DataTable } from "@/components/ui/data-table";
import { DataTableColumnHeader } from "@/components/ui/data-table-column-header";
import { CreateAgentModal } from "@/components/modals/create-agent-modal";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Field, FieldLabel } from "@/components/ui/field";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ApiError, apiGet, apiPost, apiPut } from "@/lib/api";
import { agentAvatarSeed } from "@/lib/agent-avatar";
import { parseRuntimeFromAgentColumns } from "@/lib/agent-detail-logic";
import { getModelOptionsForProvider, heartbeatCronToIntervalSec } from "@/lib/agent-runtime-options";
import { getDefaultModelForProvider, type RuntimeProviderType } from "@/lib/model-registry-options";
import { showThinkingEffortControlForProvider } from "@/lib/provider-runtime-ui";
import { formatSmartDateTime } from "@/lib/smart-date";
import { getStatusBadgeClassName } from "@/lib/status-presentation";
import { isSkippedRun } from "@/lib/workspace-logic";
import { MoreHorizontal } from "lucide-react";
import styles from "./agent-detail-page-client.module.scss";
import { MetricCard, SectionHeading } from "./workspace/shared";

interface AgentRow {
  id: string;
  name: string;
  avatarSeed?: string | null;
  role: string;
  managerAgentId: string | null;
  status: string;
  providerType: string;
  heartbeatCron?: string;
  monthlyBudgetUsd?: number;
  usedBudgetUsd?: number;
  canHireAgents?: boolean;
  runtimeCommand?: string | null;
  runtimeArgsJson?: string | null;
  runtimeCwd?: string | null;
  runtimeEnvJson?: string | null;
  runtimeModel?: string | null;
  runtimeThinkingEffort?: "auto" | "low" | "medium" | "high" | null;
  bootstrapPrompt?: string | null;
  runtimeTimeoutSec?: number | null;
  interruptGraceSec?: number | null;
  runPolicyJson?: string | null;
  stateBlob?: string;
}

interface IssueRow {
  id: string;
  assigneeAgentId: string | null;
  title: string;
  priority: string;
  status: "todo" | "in_progress" | "blocked" | "in_review" | "done" | "canceled";
  updatedAt: string;
}

interface HeartbeatRunRow {
  id: string;
  agentId: string;
  status: string;
  runType: "work" | "no_assigned_work" | "budget_skip" | "overlap_skip" | "other_skip" | "failed" | "running";
  message: string | null;
  outcome?: ExecutionOutcome | null;
  startedAt: string;
  finishedAt?: string | null;
}

interface CostRow {
  agentId?: string | null;
  tokenInput: number;
  tokenOutput: number;
  usdCost: number;
}

interface RunDetailsPayload {
  result?: string;
  errorType?: string;
  status?: string;
  message?: string | null;
  errorMessage?: string | null;
  outcome?: ExecutionOutcome | null;
  issueIds?: string[];
  usage?: {
    tokenInput?: number;
    tokenOutput?: number;
    usdCost?: number;
  };
  trace?: {
    command?: string;
    args?: string[] | null;
    cwd?: string | null;
    exitCode?: number | null;
    elapsedMs?: number;
    timedOut?: boolean;
    failureType?: string;
    timeoutSource?: "runtime" | "watchdog" | null;
    usageSource?: string | null;
    attemptCount?: number;
    attempts?: Array<{
      attempt: number;
      code: number | null;
      timedOut: boolean;
      elapsedMs: number;
      signal: string | null;
      spawnErrorCode?: string;
      forcedKill: boolean;
    }>;
    session?: {
      currentSessionId?: string | null;
      resumedSessionId?: string | null;
      resumeAttempted?: boolean;
      resumeSkippedReason?: string | null;
      clearedStaleSession?: boolean;
    } | null;
    structuredOutputSource?: "stdout" | "stderr" | null;
    structuredOutputDiagnostics?: Record<string, unknown> | null;
    stdoutPreview?: string;
    stderrPreview?: string;
  } | null;
  diagnostics?: {
    requestId?: string | null;
    trigger?: string | null;
    stateParseError?: string | null;
  };
}

interface AuditRow {
  eventType: string;
  entityType: string;
  entityId: string;
  payload?: Record<string, unknown>;
}

interface AgentMemoryListItem {
  agentId: string;
  relativePath: string;
  path: string;
}

interface AgentMemoryListResponse {
  items: AgentMemoryListItem[];
}

interface AgentMemoryFileResponse {
  relativePath: string;
  content: string;
  sizeBytes: number;
}

interface MemoryContextPreviewResponse {
  compiledPreview: string;
}

type RuntimeState = {
  command?: string;
  args?: string[];
  cwd?: string;
  timeoutMs?: number;
  interruptGraceSec?: number;
  retryCount?: number;
  retryBackoffMs?: number;
  env?: Record<string, string>;
  model?: string;
  thinkingEffort?: "auto" | "low" | "medium" | "high";
  runPolicy?: {
    sandboxMode?: "workspace_write" | "full_access";
    allowWebSearch?: boolean;
  };
};

function shortId(value: string) {
  return value.length > 12 ? `${value.slice(0, 8)}...` : value;
}

function formatDateTime(value: string | null | undefined) {
  return value ? new Date(value).toLocaleString() : "Not set";
}

function formatRunDuration(startedAt: string, finishedAt?: string | null) {
  if (!finishedAt) {
    return "running";
  }
  const ms = new Date(finishedAt).getTime() - new Date(startedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) {
    return "n/a";
  }
  if (ms < 1000) {
    return `${ms}ms`;
  }
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatRunStatusLabel(status: string) {
  return status === "started" ? "running" : status;
}

function isRunActive(run: Pick<HeartbeatRunRow, "status" | "finishedAt">) {
  return !run.finishedAt || run.status === "started" || run.status === "running";
}

function formatRunMessage(message: string | null | undefined) {
  if (!message) {
    return "No message";
  }
  const trimmed = message.trim();
  if (!trimmed) {
    return "No message";
  }
  const fencedMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const candidate = fencedMatch ? fencedMatch[1]!.trim() : trimmed;
  try {
    const parsed = JSON.parse(candidate) as { summary?: unknown; message?: unknown };
    if (typeof parsed.summary === "string" && parsed.summary.trim()) {
      return parsed.summary.trim();
    }
    if (typeof parsed.message === "string" && parsed.message.trim()) {
      return parsed.message.trim();
    }
  } catch {
    const summaryMatch = candidate.match(/"summary"\s*:\s*"([^"]+)"/i);
    if (summaryMatch?.[1]?.trim()) {
      return summaryMatch[1].trim();
    }
  }
  return candidate.replace(/\s+/g, " ").trim();
}

function formatHeartbeatInterval(seconds: number) {
  if (seconds <= 60) {
    return "Every minute";
  }
  if (seconds < 3600) {
    const minutes = Math.round(seconds / 60);
    return `Every ${minutes} minute${minutes === 1 ? "" : "s"}`;
  }
  const hours = Math.round(seconds / 3600);
  return `Every ${hours} hour${hours === 1 ? "" : "s"}`;
}

function formatHeartbeatCadence(cronExpression: string | undefined) {
  if (!cronExpression) {
    return "Not configured";
  }
  const normalized = cronExpression.trim();
  if (normalized === "* * * * *") {
    return "Every minute";
  }
  const stepMatch = normalized.match(/^\*\/(\d+)\s+\*\s+\*\s+\*\s+\*$/);
  if (stepMatch) {
    const minutes = Number(stepMatch[1]);
    if (Number.isInteger(minutes) && minutes > 0) {
      return `Every ${minutes} minute${minutes === 1 ? "" : "s"}`;
    }
  }
  const fixedMinuteMatch = normalized.match(/^(\d+)\s+\*\s+\*\s+\*\s+\*$/);
  if (fixedMinuteMatch) {
    const minuteValue = fixedMinuteMatch[1];
    if (!minuteValue) {
      return formatHeartbeatInterval(heartbeatCronToIntervalSec(cronExpression, 300));
    }
    const minute = minuteValue.padStart(2, "0");
    return `Every hour at :${minute}`;
  }
  return formatHeartbeatInterval(heartbeatCronToIntervalSec(cronExpression, 300));
}

const PROVIDER_LABELS: Record<string, string> = {
  claude_code: "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
  opencode: "OpenCode",
  gemini_cli: "Gemini CLI",
  openai_api: "OpenAI API",
  anthropic_api: "Anthropic API",
  http: "HTTP",
  shell: "Shell"
};

const SIDEBAR_VISIBLE_PROVIDER_TYPES: RuntimeProviderType[] = ["claude_code", "codex", "opencode", "gemini_cli"];

function normalizeRuntimeProvider(providerType: string): RuntimeProviderType | null {
  if (
    providerType === "claude_code" ||
    providerType === "codex" ||
    providerType === "cursor" ||
    providerType === "opencode" ||
    providerType === "gemini_cli" ||
    providerType === "openai_api" ||
    providerType === "anthropic_api" ||
    providerType === "http" ||
    providerType === "shell"
  ) {
    return providerType;
  }
  return null;
}

function getProviderLabel(providerType: string) {
  return PROVIDER_LABELS[providerType] ?? providerType;
}

function getModelLabel(providerType: string, modelId: string) {
  const runtimeProvider = normalizeRuntimeProvider(providerType);
  if (!runtimeProvider) {
    return modelId;
  }
  const matching = getModelOptionsForProvider(runtimeProvider, modelId).find((option) => option.value === modelId);
  return matching?.label ?? modelId;
}

function providerRequiresNamedModel(providerType: RuntimeProviderType) {
  return providerType !== "http" && providerType !== "shell";
}

function parseStateBlob(raw: string | undefined) {
  if (!raw) {
    return { runtime: null, promptTemplate: null };
  }
  try {
    const parsed = JSON.parse(raw) as {
      runtime?: RuntimeState;
      promptTemplate?: string;
      prompt?: string;
      systemPrompt?: string;
    };
    return {
      runtime: parsed.runtime ?? null,
      promptTemplate: parsed.promptTemplate ?? parsed.prompt ?? parsed.systemPrompt ?? null
    };
  } catch {
    return { runtime: null, promptTemplate: null };
  }
}

function ConfigRow({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className={styles.configRowContainer1}>
      <div className={styles.configRowContainer2}>{label}</div>
      <div className={styles.configRowContainer3}>
        <div>{value}</div>
        {detail ? <div className={styles.mutedTextContainer}>{detail}</div> : null}
      </div>
    </div>
  );
}

export function AgentDetailPageClient({
  companyId,
  companies,
  agent,
  agents,
  issues,
  heartbeatRuns,
  costEntries,
  auditEvents
}: {
  companyId: string;
  companies: Array<{ id: string; name: string }>;
  agent: AgentRow;
  agents: AgentRow[];
  issues: IssueRow[];
  heartbeatRuns: HeartbeatRunRow[];
  costEntries: CostRow[];
  auditEvents: AuditRow[];
}) {
  const router = useRouter();
  const [actionError, setActionError] = useState<string | null>(null);
  const [sidebarError, setSidebarError] = useState<string | null>(null);
  const [memoryError, setMemoryError] = useState<string | null>(null);
  const [pendingActionKeys, setPendingActionKeys] = useState<Record<string, boolean>>({});
  const [memoryFiles, setMemoryFiles] = useState<AgentMemoryListItem[]>([]);
  const [selectedMemoryPath, setSelectedMemoryPath] = useState<string>("");
  const [selectedMemoryContent, setSelectedMemoryContent] = useState<string>("");
  const [compiledContextPreview, setCompiledContextPreview] = useState<string>("");
  const [memoryLoading, setMemoryLoading] = useState(false);
  const [memoryDialogOpen, setMemoryDialogOpen] = useState(false);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [terminateDialogOpen, setTerminateDialogOpen] = useState(false);
  const managerNameById = useMemo(() => new Map(agents.map((entry) => [entry.id, entry.name])), [agents]);

  const agentRuns = useMemo(
    () =>
      heartbeatRuns
        .filter((run) => run.agentId === agent.id)
        .filter((run) => !isSkippedRun(run))
        .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()),
    [agent.id, heartbeatRuns]
  );

  const latestRun = agentRuns[0] ?? null;
  const activeRun = agentRuns.find((run) => isRunActive(run)) ?? null;
  const liveStatus = activeRun ? "running" : agent.status;
  const liveStatusDetail = activeRun
    ? `Run ${shortId(activeRun.id)} started ${formatSmartDateTime(activeRun.startedAt, { includeSeconds: true })}`
    : undefined;

  const agentCosts = useMemo(() => costEntries.filter((entry) => entry.agentId === agent.id), [agent.id, costEntries]);

  const costSummary = useMemo(
    () =>
      agentCosts.reduce(
        (acc, entry) => {
          acc.input += entry.tokenInput;
          acc.output += entry.tokenOutput;
          acc.usd += entry.usdCost;
          return acc;
        },
        { input: 0, output: 0, usd: 0 }
      ),
    [agentCosts]
  );
  const usedBudgetUsd = typeof agent.usedBudgetUsd === "number" ? agent.usedBudgetUsd : 0;

  const state = useMemo(() => {
    const parsed = parseStateBlob(agent.stateBlob);
    return {
      ...parsed,
      runtime: parseRuntimeFromAgentColumns(agent) ?? parsed.runtime
    };
  }, [agent]);
  const managerName = agent.managerAgentId ? managerNameById.get(agent.managerAgentId) ?? shortId(agent.managerAgentId) : "Unassigned";
  const managerOptions = useMemo(
    () =>
      agents
        .filter((entry) => entry.id !== agent.id)
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)),
    [agent.id, agents]
  );
  const configuredProviderType = normalizeRuntimeProvider(agent.providerType);
  const configuredModelId =
    state.runtime?.model?.trim() ||
    agent.runtimeModel?.trim() ||
    (() => {
      const provider = configuredProviderType;
      return provider ? getDefaultModelForProvider(provider) ?? "" : "";
    })();
  const configuredModelLabel = configuredModelId ? getModelLabel(agent.providerType, configuredModelId) : "Not configured";
  const completedIssues = useMemo(
    () =>
      issues
        .filter((issue) => issue.assigneeAgentId === agent.id && issue.status === "done")
        .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()),
    [agent.id, issues]
  );
  const recentDeliveryIssues = useMemo(
    () =>
      issues
        .filter((issue) => issue.assigneeAgentId === agent.id && (issue.status === "in_review" || issue.status === "done"))
        .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()),
    [agent.id, issues]
  );
  const openAssignedIssueCount = useMemo(
    () =>
      issues.filter(
        (issue) => issue.assigneeAgentId === agent.id && issue.status !== "done" && issue.status !== "canceled"
      ).length,
    [agent.id, issues]
  );
  const blockedIssueCount = useMemo(
    () => issues.filter((issue) => issue.assigneeAgentId === agent.id && issue.status === "blocked").length,
    [agent.id, issues]
  );
  const runHealth = useMemo(() => {
    const completed = agentRuns.filter((run) => run.status === "completed").length;
    const failed = agentRuns.filter((run) => run.status === "failed").length;
    const relevant = completed + failed;
    const successRate = relevant > 0 ? (completed / relevant) * 100 : 0;
    return { completed, failed, successRate };
  }, [agentRuns]);
  const avgCostPerCompletedIssue = completedIssues.length > 0 ? costSummary.usd / completedIssues.length : 0;
  const [selectedProviderType, setSelectedProviderType] = useState(agent.providerType);
  const [selectedModelId, setSelectedModelId] = useState(configuredModelId);
  const providerOptions = useMemo(() => {
    const options = SIDEBAR_VISIBLE_PROVIDER_TYPES.map((providerType) => ({
      value: providerType,
      label: getProviderLabel(providerType)
    }));
    if (options.some((option) => option.value === selectedProviderType)) {
      return options;
    }
    return [...options, { value: selectedProviderType, label: getProviderLabel(selectedProviderType) }];
  }, [selectedProviderType]);
  const modelOptions = useMemo(() => {
    const provider = normalizeRuntimeProvider(selectedProviderType);
    if (!provider) {
      return [];
    }
    return getModelOptionsForProvider(provider, selectedModelId).filter((option) => option.value.trim().length > 0);
  }, [selectedProviderType, selectedModelId]);
  const completedIssueColumns = useMemo<ColumnDef<IssueRow>[]>(
    () => [
      {
        accessorKey: "title",
        header: ({ column }) => <DataTableColumnHeader column={column} title="Issue" />,
        cell: ({ row }) => (
          <Link href={`/issues/${row.original.id}?companyId=${companyId}`} className={styles.runIdLink}>
            {row.original.title}
          </Link>
        )
      },
      {
        accessorKey: "priority",
        header: ({ column }) => <DataTableColumnHeader column={column} title="Priority" />,
        cell: ({ row }) => <Badge variant="outline">{row.original.priority}</Badge>
      },
      {
        accessorKey: "updatedAt",
        header: ({ column }) => <DataTableColumnHeader column={column} title="Last updated" />,
        cell: ({ row }) => (
          <time
            className={styles.runTableDateTime}
            dateTime={row.original.updatedAt}
            title={formatDateTime(row.original.updatedAt)}
          >
            {formatSmartDateTime(row.original.updatedAt, { includeSeconds: true })}
          </time>
        )
      }
    ],
    [companyId]
  );
  const agentRunColumns = useMemo<ColumnDef<HeartbeatRunRow>[]>(
    () => [
      {
        accessorKey: "id",
        header: ({ column }) => <DataTableColumnHeader column={column} title="Run" />,
        cell: ({ row }) => (
          <Link className={styles.runIdLink} href={`/runs/${row.original.id}?companyId=${companyId}&agentId=${agent.id}`}>
            {shortId(row.original.id)}
          </Link>
        )
      },
      {
        accessorKey: "status",
        header: ({ column }) => <DataTableColumnHeader column={column} title="Status" />,
        cell: ({ row }) => (
          <Badge variant="outline" className={getStatusBadgeClassName(row.original.status)}>
            {formatRunStatusLabel(row.original.status)}
          </Badge>
        )
      },
      {
        id: "duration",
        header: "Duration",
        cell: ({ row }) => (
          <div className={styles.runTableCellMuted}>{formatRunDuration(row.original.startedAt, row.original.finishedAt)}</div>
        )
      },
      {
        accessorKey: "startedAt",
        header: ({ column }) => <DataTableColumnHeader column={column} title="Started" />,
        cell: ({ row }) => (
          <time
            className={styles.runTableDateTime}
            dateTime={row.original.startedAt}
            title={formatDateTime(row.original.startedAt)}
          >
            {formatSmartDateTime(row.original.startedAt, { includeSeconds: true })}
          </time>
        )
      },
      {
        accessorKey: "message",
        header: "Message",
        cell: ({ row }) => {
          const displayMessage = formatRunMessage(row.original.message);
          const previewMessage = displayMessage.length > 120 ? `${displayMessage.slice(0, 117)}...` : displayMessage;
          return (
            <div className={styles.runMessageCell} title={displayMessage}>
              {previewMessage}
            </div>
          );
        }
      },
      {
        id: "actions",
        header: () => <div className={styles.tableHeaderAlignRight}>Actions</div>,
        enableSorting: false,
        cell: ({ row }) => (
          <div className={styles.runActionsCell}>
            <Button
              size="sm"
              variant="outline"
              disabled={pendingActionKeys[`run:${row.original.id}:redo`] === true}
              onClick={() => {
                if (window.confirm("Redo from scratch? This starts a new run without previous session context.")) {
                  void redoRun(row.original.id);
                }
              }}
            >
              {pendingActionKeys[`run:${row.original.id}:redo`] === true ? "Starting..." : "Redo"}
            </Button>
          </div>
        )
      }
    ],
    [agent.id, companyId, pendingActionKeys]
  );
  const configuredThinkingEffort = state.runtime?.thinkingEffort ?? agent.runtimeThinkingEffort ?? "auto";
  const [selectedThinkingEffort, setSelectedThinkingEffort] = useState<"auto" | "low" | "medium" | "high">(
    configuredThinkingEffort
  );
  const [selectedManagerAgentId, setSelectedManagerAgentId] = useState(agent.managerAgentId ?? "__none");

  const capabilityHints = useMemo(() => {
    const capabilities = new Set<string>();
    capabilities.add(`${agent.role} execution ownership`);
    capabilities.add("Issue execution and updates");
    if (state.runtime?.command) {
      capabilities.add(`Runs via ${state.runtime.command}`);
    } else {
      capabilities.add("Uses workspace runtime defaults");
    }
    if (state.runtime?.cwd) {
      capabilities.add(`Scoped to ${state.runtime.cwd}`);
    }
    return Array.from(capabilities);
  }, [agent.role, state.runtime]);

  const invokeDisabledReason =
    agent.status === "paused"
      ? "Agent is paused. Resume before invoking."
      : agent.status === "terminated"
        ? "Agent is terminated and cannot run."
        : null;

  useEffect(() => {
    setSelectedProviderType(agent.providerType);
  }, [agent.providerType]);

  useEffect(() => {
    setSelectedModelId(configuredModelId);
  }, [configuredModelId]);

  useEffect(() => {
    setSelectedThinkingEffort(configuredThinkingEffort);
  }, [configuredThinkingEffort]);

  useEffect(() => {
    setSelectedManagerAgentId(agent.managerAgentId ?? "__none");
  }, [agent.managerAgentId]);

  useEffect(() => {
    let mounted = true;
    if (!companyId) {
      return () => {
        mounted = false;
      };
    }
    void (async () => {
      setMemoryLoading(true);
      setMemoryError(null);
      try {
        const [filesResponse, previewResponse] = await Promise.all([
          apiGet<AgentMemoryListResponse>(
            `/observability/memory?agentId=${encodeURIComponent(agent.id)}&limit=40`,
            companyId
          ),
          apiGet<MemoryContextPreviewResponse>(`/observability/memory/${encodeURIComponent(agent.id)}/context-preview`, companyId)
        ]);
        if (!mounted) {
          return;
        }
        const nextFiles = filesResponse.data.items
          .filter((entry) => entry.agentId === agent.id)
          .sort((left, right) => left.relativePath.localeCompare(right.relativePath));
        setMemoryFiles(nextFiles);
        setCompiledContextPreview(previewResponse.data.compiledPreview ?? "");
        setSelectedMemoryPath((prev) => {
          if (prev && nextFiles.some((entry) => entry.relativePath === prev)) {
            return prev;
          }
          return nextFiles[0]?.relativePath ?? "";
        });
      } catch (error) {
        if (!mounted) {
          return;
        }
        setMemoryError(error instanceof ApiError ? error.message : "Failed to load memory context.");
      } finally {
        if (mounted) {
          setMemoryLoading(false);
        }
      }
    })();
    return () => {
      mounted = false;
    };
  }, [agent.id, companyId]);

  useEffect(() => {
    let mounted = true;
    if (!companyId || !selectedMemoryPath) {
      setSelectedMemoryContent("");
      return () => {
        mounted = false;
      };
    }
    void (async () => {
      try {
        const response = await apiGet<AgentMemoryFileResponse>(
          `/observability/memory/${encodeURIComponent(agent.id)}/file?path=${encodeURIComponent(selectedMemoryPath)}`,
          companyId
        );
        if (!mounted) {
          return;
        }
        setSelectedMemoryContent(response.data.content ?? "");
      } catch (error) {
        if (!mounted) {
          return;
        }
        setMemoryError(error instanceof ApiError ? error.message : "Failed to read memory file.");
      }
    })();
    return () => {
      mounted = false;
    };
  }, [agent.id, companyId, selectedMemoryPath]);

  const isActionPending = useCallback(
    (actionKey: string) => pendingActionKeys[actionKey] === true,
    [pendingActionKeys]
  );

  async function runAgentAction(action: () => Promise<void>, fallbackMessage: string, actionKey: string) {
    setActionError(null);
    if (isActionPending(actionKey)) {
      return;
    }
    setPendingActionKeys((prev) => ({ ...prev, [actionKey]: true }));
    try {
      await action();
      router.refresh();
    } catch (error) {
      setActionError(error instanceof ApiError ? error.message : fallbackMessage);
    } finally {
      setPendingActionKeys((prev) => {
        if (!prev[actionKey]) {
          return prev;
        }
        const next = { ...prev };
        delete next[actionKey];
        return next;
      });
    }
  }

  async function runHeartbeat() {
    await runAgentAction(async () => {
      await apiPost("/heartbeats/run-agent", companyId, { agentId: agent.id });
    }, "Failed to run heartbeat.", `agent:${agent.id}:invoke`);
  }

  async function stopRun(runId: string) {
    await runAgentAction(async () => {
      await apiPost(`/heartbeats/${runId}/stop`, companyId, {});
    }, "Failed to stop run.", `run:${runId}:stop`);
  }

  async function resumeRun(runId: string) {
    await runAgentAction(async () => {
      await apiPost(`/heartbeats/${runId}/resume`, companyId, {});
    }, "Failed to resume run.", `run:${runId}:resume`);
  }

  async function redoRun(runId: string) {
    await runAgentAction(async () => {
      await apiPost(`/heartbeats/${runId}/redo`, companyId, {});
    }, "Failed to redo run.", `run:${runId}:redo`);
  }

  async function pauseAgent() {
    await runAgentAction(async () => {
      await apiPost(`/agents/${agent.id}/pause`, companyId, {});
    }, "Failed to pause agent.", `agent:${agent.id}:pause`);
  }

  async function resumeAgent() {
    await runAgentAction(async () => {
      await apiPost(`/agents/${agent.id}/resume`, companyId, {});
    }, "Failed to resume agent.", `agent:${agent.id}:resume`);
  }

  async function terminateAgent() {
    await runAgentAction(async () => {
      await apiPost(`/agents/${agent.id}/terminate`, companyId, {});
    }, "Failed to terminate agent.", `agent:${agent.id}:terminate`);
  }

  async function updateSidebarSettings(
    payload: {
      runtimeConfig?: { runtimeModel?: string; runtimeThinkingEffort?: "auto" | "low" | "medium" | "high" };
      providerType?: RuntimeProviderType;
      managerAgentId?: string | null;
    },
    actionKey: string
  ) {
    setSidebarError(null);
    if (isActionPending(actionKey)) {
      return;
    }
    setPendingActionKeys((prev) => ({ ...prev, [actionKey]: true }));
    try {
      await apiPut(`/agents/${agent.id}`, companyId, payload);
      router.refresh();
    } catch (error) {
      setSidebarError(error instanceof ApiError ? error.message : "Failed to update agent settings.");
      throw error;
    } finally {
      setPendingActionKeys((prev) => {
        if (!prev[actionKey]) {
          return prev;
        }
        const next = { ...prev };
        delete next[actionKey];
        return next;
      });
    }
  }

  async function handleModelChange(nextModelId: string) {
    const previousModelId = selectedModelId;
    setSelectedModelId(nextModelId);
    try {
      await updateSidebarSettings({ runtimeConfig: { runtimeModel: nextModelId } }, `agent:${agent.id}:runtime-model`);
    } catch {
      setSelectedModelId(previousModelId);
    }
  }

  async function handleProviderChange(nextProviderType: string) {
    const nextProvider = normalizeRuntimeProvider(nextProviderType);
    if (!nextProvider || nextProviderType === selectedProviderType) {
      return;
    }
    const previousProviderType = selectedProviderType;
    const previousModelId = selectedModelId;
    const nextProviderModelOptions = getModelOptionsForProvider(nextProvider, selectedModelId).filter(
      (option) => option.value.trim().length > 0
    );
    const nextProviderDefaultModel = getDefaultModelForProvider(nextProvider) ?? "";
    const nextProviderHasCurrentModel = nextProviderModelOptions.some((option) => option.value === selectedModelId);
    const nextProviderModelId = nextProviderHasCurrentModel
      ? selectedModelId
      : (nextProviderModelOptions.find((option) => option.value === nextProviderDefaultModel)?.value ??
        nextProviderModelOptions[0]?.value ??
        "");
    if (providerRequiresNamedModel(nextProvider) && nextProviderModelId.trim().length === 0) {
      setSidebarError("No models are available for the selected provider.");
      return;
    }
    setSelectedProviderType(nextProvider);
    setSelectedModelId(nextProviderModelId);
    if (nextProvider === "codex") {
      setSelectedThinkingEffort("auto");
    }
    try {
      await updateSidebarSettings(
        {
          providerType: nextProvider,
          runtimeConfig: {
            runtimeModel: nextProviderModelId,
            ...(nextProvider === "codex" ? { runtimeThinkingEffort: "auto" as const } : {})
          }
        },
        `agent:${agent.id}:provider`
      );
    } catch {
      setSelectedProviderType(previousProviderType);
      setSelectedModelId(previousModelId);
    }
  }

  async function handleThinkingEffortChange(nextThinkingEffort: "auto" | "low" | "medium" | "high") {
    const previousThinkingEffort = selectedThinkingEffort;
    setSelectedThinkingEffort(nextThinkingEffort);
    try {
      await updateSidebarSettings(
        { runtimeConfig: { runtimeThinkingEffort: nextThinkingEffort } },
        `agent:${agent.id}:runtime-thinking-effort`
      );
    } catch {
      setSelectedThinkingEffort(previousThinkingEffort);
    }
  }

  async function handleManagerChange(nextManagerAgentId: string) {
    const previousManagerAgentId = selectedManagerAgentId;
    setSelectedManagerAgentId(nextManagerAgentId);
    try {
      await updateSidebarSettings(
        { managerAgentId: nextManagerAgentId === "__none" ? null : nextManagerAgentId },
        `agent:${agent.id}:manager`
      );
    } catch {
      setSelectedManagerAgentId(previousManagerAgentId);
    }
  }

  const invokeActionKey = `agent:${agent.id}:invoke`;

  const leftPane = (
    <div className={styles.agentDetailLeftPaneContainer}>
      <div className={styles.agentHeaderContainer1}>
        <div className={styles.agentHeaderIdentity}>
          <AgentAvatar
            seed={agentAvatarSeed(agent.id, agent.name, agent.avatarSeed)}
            name={agent.name}
            className={styles.agentHeaderAvatar}
            size={128}
          />
          <SectionHeading
            title={agent.name}
            description="The active things your AI workforce is working on."
          />
        </div>
        <div className={styles.agentHeaderContainer4}>
          <Button
            size="sm"
            onClick={() => void runHeartbeat()}
            disabled={invokeDisabledReason !== null || isActionPending(invokeActionKey)}
          >
            {isActionPending(invokeActionKey) ? "Running..." : "Invoke"}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="outline" aria-label="Open more actions">
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {agent.status === "paused" ? (
                <DropdownMenuItem
                  disabled={isActionPending(`agent:${agent.id}:resume`)}
                  onSelect={(event) => {
                    event.preventDefault();
                    if (window.confirm(`Resume "${agent.name}" so heartbeats can run again?`)) {
                      void resumeAgent();
                    }
                  }}
                >
                  Resume
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem
                  disabled={isActionPending(`agent:${agent.id}:pause`)}
                  onSelect={(event) => {
                    event.preventDefault();
                    if (window.confirm(`Pause "${agent.name}" and block new heartbeat runs?`)) {
                      void pauseAgent();
                    }
                  }}
                >
                  Pause
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={(event) => {
                  event.preventDefault();
                  setEditDialogOpen(true);
                }}
              >
                Edit
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={(event) => {
                  event.preventDefault();
                  setMemoryDialogOpen(true);
                }}
              >
                Memory
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                disabled={agent.status === "terminated" || isActionPending(`agent:${agent.id}:terminate`)}
                onSelect={(event) => {
                  event.preventDefault();
                  setTerminateDialogOpen(true);
                }}
              >
                Terminate
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      {invokeDisabledReason ? (
        <Alert>
          <AlertDescription>{invokeDisabledReason}</AlertDescription>
        </Alert>
      ) : null}

      <div className={styles.costSectionContainer}>
        <div className={styles.costGridCardContent}>
          <MetricCard label="Open issues" value={openAssignedIssueCount.toLocaleString()} />
          <MetricCard label="Blocked issues" value={blockedIssueCount.toLocaleString()} />
          <MetricCard label="Run success rate" value={`${runHealth.successRate.toFixed(1)}%`} />
          <MetricCard label="Avg cost/completed issue" value={`$${avgCostPerCompletedIssue.toFixed(2)}`} />
        </div>
      </div>

      <SectionHeading title="Runs" description="Heartbeat runs scoped to this agent." />
      <DataTable
        columns={agentRunColumns}
        data={agentRuns}
        emptyMessage="No runs have executed for this agent yet."
        showViewOptions={false}
      />

      <SectionHeading title="Recent issues" description="Latest done and in-review issues assigned to this agent." />
      <DataTable
        columns={completedIssueColumns}
        data={recentDeliveryIssues}
        emptyMessage="No done or in-review issues for this agent yet."
        showViewOptions={false}
      />
    </div>
  );

  const rightPane = (
    <div className={styles.agentSidebarContainer}>
      <Card>
        <CardContent className={styles.agentSidebarControlsCardContent}>
          <Field>
            <FieldLabel>Provider</FieldLabel>
            <Select
              value={selectedProviderType}
              onValueChange={(value) => void handleProviderChange(value)}
              disabled={isActionPending(`agent:${agent.id}:provider`) || agent.status === "terminated"}
            >
              <SelectTrigger className={styles.agentSidebarSelectTrigger}>
                <SelectValue placeholder="Select a provider" />
              </SelectTrigger>
              <SelectContent>
                {providerOptions.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          <Field className={styles.agentSidebarField}>
            <FieldLabel>Model</FieldLabel>
            <Select
              value={selectedModelId}
              onValueChange={(value) => void handleModelChange(value)}
              disabled={
                modelOptions.length === 0 ||
                isActionPending(`agent:${agent.id}:runtime-model`) ||
                isActionPending(`agent:${agent.id}:provider`) ||
                agent.status === "terminated"
              }
            >
              <SelectTrigger className={styles.agentSidebarSelectTrigger}>
                <SelectValue placeholder={modelOptions.length === 0 ? "Not configurable for this provider" : "Select a model"} />
              </SelectTrigger>
              <SelectContent>
                {modelOptions.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          {showThinkingEffortControlForProvider(selectedProviderType) ? (
            <Field className={styles.agentSidebarField}>
              <FieldLabel>Thinking effort</FieldLabel>
              <Select
                value={selectedThinkingEffort}
                onValueChange={(value) => void handleThinkingEffortChange(value as "auto" | "low" | "medium" | "high")}
                disabled={isActionPending(`agent:${agent.id}:runtime-thinking-effort`) || agent.status === "terminated"}
              >
                <SelectTrigger className={styles.agentSidebarSelectTrigger}>
                  <SelectValue placeholder="Select thinking effort" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">Auto</SelectItem>
                  <SelectItem value="low">Low</SelectItem>
                  <SelectItem value="medium">Medium</SelectItem>
                  <SelectItem value="high">High</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          ) : null}

          <Field className={styles.agentSidebarField}>
            <FieldLabel>Reports to</FieldLabel>
            <Select
              value={selectedManagerAgentId}
              onValueChange={(value) => void handleManagerChange(value)}
              disabled={isActionPending(`agent:${agent.id}:manager`) || agent.status === "terminated"}
            >
              <SelectTrigger className={styles.agentSidebarSelectTrigger}>
                <SelectValue placeholder="No manager" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none">No manager</SelectItem>
                {managerOptions.map((entry) => (
                  <SelectItem key={entry.id} value={entry.id}>
                    {entry.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          {sidebarError ? <div className={styles.agentSidebarErrorText}>{sidebarError}</div> : null}
        </CardContent>
      </Card>

      <Card>
        <CardContent className={styles.configCardContent}>
          <ConfigRow label="Agent ID" value={agent.id} />
          <ConfigRow label="Role" value={agent.role ?? "Not set"} />
          <ConfigRow label="Status" value={liveStatus} detail={liveStatusDetail} />
          <ConfigRow label="Heartbeat" value={formatHeartbeatCadence(agent.heartbeatCron)} />
        </CardContent>
      </Card>

      <Card>
        <CardContent className={styles.configCardContent}>
          <ConfigRow
            label="Monthly budget"
            value={typeof agent.monthlyBudgetUsd === "number" ? `$${agent.monthlyBudgetUsd.toFixed(2)}` : "Not set"}
          />
          <ConfigRow label="Budget used (month)" value={`$${usedBudgetUsd.toFixed(2)}`} />
          <ConfigRow label="Input tokens" value={costSummary.input.toLocaleString()} />
          <ConfigRow label="Output tokens" value={costSummary.output.toLocaleString()} />
        </CardContent>
      </Card>
    </div>
  );

  return (
    <>
      {actionError ? (
        <Alert variant="destructive" className={styles.agentActionAlert}>
          <AlertTitle>Action failed</AlertTitle>
          <AlertDescription>{actionError}</AlertDescription>
        </Alert>
      ) : null}
      <AppShell leftPane={leftPane} rightPane={rightPane} activeNav="Agents" companies={companies} activeCompanyId={companyId} />
      <CreateAgentModal
        companyId={companyId}
        availableAgents={agents.map((entry) => ({ id: entry.id, name: entry.name }))}
        agent={{
          id: agent.id,
          name: agent.name,
          role: agent.role,
          managerAgentId: agent.managerAgentId,
          providerType: agent.providerType as
            | "claude_code"
            | "codex"
            | "cursor"
            | "opencode"
            | "openai_api"
            | "anthropic_api"
            | "http"
            | "shell",
          heartbeatCron: agent.heartbeatCron,
          monthlyBudgetUsd: agent.monthlyBudgetUsd,
          canHireAgents: agent.canHireAgents,
          runtimeCommand: agent.runtimeCommand,
          runtimeArgsJson: agent.runtimeArgsJson,
          runtimeCwd: agent.runtimeCwd,
          runtimeEnvJson: agent.runtimeEnvJson,
          runtimeModel: agent.runtimeModel,
          runtimeThinkingEffort: agent.runtimeThinkingEffort,
          bootstrapPrompt: agent.bootstrapPrompt,
          runtimeTimeoutSec: agent.runtimeTimeoutSec,
          interruptGraceSec: agent.interruptGraceSec,
          runPolicyJson: agent.runPolicyJson,
          stateBlob: agent.stateBlob
        }}
        open={editDialogOpen}
        onOpenChange={setEditDialogOpen}
        hideTrigger
      />
      <Dialog open={terminateDialogOpen} onOpenChange={setTerminateDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Terminate agent?</DialogTitle>
            <DialogDescription>{`Terminate "${agent.name}". This blocks all future runs.`}</DialogDescription>
          </DialogHeader>
          <DialogFooter showCloseButton>
            <Button
              variant="destructive"
              disabled={isActionPending(`agent:${agent.id}:terminate`)}
              onClick={() => {
                setTerminateDialogOpen(false);
                void terminateAgent();
              }}
            >
              {isActionPending(`agent:${agent.id}:terminate`) ? "Terminating..." : "Terminate"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={memoryDialogOpen} onOpenChange={setMemoryDialogOpen}>
        <DialogContent size="xl">
          <DialogHeader>
            <DialogTitle>Memory Context</DialogTitle>
            <DialogDescription>Inspect durable notes and the effective context preview used for this agent.</DialogDescription>
          </DialogHeader>
          <div className={styles.issueListCardContent}>
            {memoryError ? <Alert variant="destructive"><AlertDescription>{memoryError}</AlertDescription></Alert> : null}
            <Field>
              <FieldLabel>Memory file</FieldLabel>
              <Select
                value={selectedMemoryPath || "__none"}
                onValueChange={(value) => setSelectedMemoryPath(value === "__none" ? "" : value)}
                disabled={memoryLoading || memoryFiles.length === 0}
              >
                <SelectTrigger className={styles.agentSidebarSelectTrigger}>
                  <SelectValue placeholder={memoryFiles.length > 0 ? "Select a memory file" : "No memory files yet"} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none">No file selected</SelectItem>
                  {memoryFiles.map((file) => (
                    <SelectItem key={file.relativePath} value={file.relativePath}>
                      {file.relativePath}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <div className={styles.memoryPreviewLabel}>Selected file contents</div>
            <pre className={styles.memoryPreviewBlock}>{selectedMemoryContent || "No file selected."}</pre>
            <div className={styles.memoryPreviewLabel}>Effective context preview</div>
            <pre className={styles.memoryPreviewBlock}>{compiledContextPreview || "No preview available."}</pre>
          </div>
          <DialogFooter showCloseButton />
        </DialogContent>
      </Dialog>
    </>
  );
}
