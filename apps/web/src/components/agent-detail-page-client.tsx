"use client";

import Link from "next/link";
import type { Route } from "next";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { ColumnDef } from "@tanstack/react-table";
import { BUILTIN_BOPO_SKILL_IDS, companySkillAllowlistOnly, type ExecutionOutcome } from "bopodev-contracts";
import { AppShell } from "@/components/app-shell";
import { AgentAvatar } from "@/components/agent-avatar";
import { DataTable } from "@/components/ui/data-table";
import { DataTableColumnHeader } from "@/components/ui/data-table-column-header";
import { CollapsibleMarkdown, COLLAPSIBLE_MARKDOWN_BODY_MAX_HEIGHT_PX } from "@/components/markdown-view";
import { AgentAppearanceModal } from "@/components/modals/agent-appearance-modal";
import { CreateAgentModal } from "@/components/modals/create-agent-modal";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ApiError, apiGet, apiPost, apiPut } from "@/lib/api";
import { agentAvatarSeed } from "@/lib/agent-avatar";
import { parseRuntimeFromAgentColumns } from "@/lib/agent-detail-logic";
import { buildAdapterModelsRequestBody, fetchAdapterModelsForProvider } from "@/lib/adapter-models-api";
import { getModelOptionsForProvider, heartbeatCronToIntervalSec } from "@/lib/agent-runtime-options";
import {
  buildModelPickerOptions,
  getDefaultModelForProvider,
  type RuntimeProviderType,
  type ServerAdapterModelEntry
} from "@/lib/model-registry-options";
import { showThinkingEffortControlForProvider } from "@/lib/provider-runtime-ui";
import { formatSmartDateTime } from "@/lib/smart-date";
import { getPriorityBadgeClassName, getStatusBadgeClassName } from "@/lib/status-presentation";
import { isSkippedRun } from "@/lib/workspace-logic";
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { MoreHorizontal } from "lucide-react";
import { SectionHeading } from "./workspace/shared";

interface AgentRow {
  id: string;
  name: string;
  avatarSeed?: string | null;
  lucideIconName?: string | null;
  role: string;
  capabilities?: string | null;
  managerAgentId: string | null;
  status: string;
  providerType: string;
  heartbeatCron?: string;
  monthlyBudgetUsd?: number;
  usedBudgetUsd?: number;
  canHireAgents?: boolean;
  canAssignAgents?: boolean;
  canCreateIssues?: boolean;
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
  /** null = all company skills (legacy). Otherwise company ids only; built-in skills always inject. */
  enabledSkillIds?: string[] | null;
}

interface IssueRow {
  id: string;
  assigneeAgentId: string | null;
  title: string;
  priority: string;
  status: "todo" | "in_progress" | "blocked" | "in_review" | "done" | "canceled";
  updatedAt: string;
}

interface AgentRoutineRow {
  id: string;
  title: string;
  projectId: string;
  assigneeAgentId: string;
  status: string;
  lastTriggeredAt: string | null;
  updatedAt: string;
}

interface AgentBuiltinSkillTableRow {
  skillId: string;
  title: string;
}

interface AgentCompanySkillPickerRow {
  skillId: string;
  /** Sidebar display title from the skills library, or the skill id when unset. */
  title: string;
}

interface CompanySkillListItem {
  skillId: string;
  sidebarTitle: string | null;
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

type SidebarAdapterModelsState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error" }
  | { status: "ok"; models: ServerAdapterModelEntry[] };

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
  openclaw_gateway: "OpenClaw Gateway",
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
    providerType === "openclaw_gateway" ||
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

const BUILTIN_SKILL_TITLES: Record<string, string> = {
  "bopodev-control-plane": "Bopo control plane",
  "bopodev-create-agent": "Bopo create agent",
  "para-memory-files": "PARA memory files"
};

function providerSupportsSkillLibrary(providerType: string): boolean {
  return (
    providerType === "codex" ||
    providerType === "claude_code" ||
    providerType === "cursor" ||
    providerType === "opencode"
  );
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
  return providerType !== "http" && providerType !== "shell" && providerType !== "openclaw_gateway";
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

const AGENT_RUNS_AREA_CHART_CONFIG = {
  completed: { label: "Completed", color: "var(--chart-1)" },
  failed: { label: "Failed", color: "var(--chart-5)" }
} satisfies ChartConfig;

const AGENT_ISSUES_AREA_CHART_CONFIG = {
  done: { label: "Done", color: "var(--chart-1)" },
  inReview: { label: "In review", color: "var(--chart-2)" },
  active: { label: "Open / active", color: "var(--chart-3)" }
} satisfies ChartConfig;

function formatAgentBudgetInput(agent: { monthlyBudgetUsd?: number }): string {
  return typeof agent.monthlyBudgetUsd === "number" ? String(agent.monthlyBudgetUsd) : "";
}

/** Parses sidebar budget text; empty string is treated as 0. */
function parseNonnegativeUsdBudget(raw: string): number | null {
  const t = raw.trim();
  if (t === "") {
    return 0;
  }
  const n = Number(t);
  if (!Number.isFinite(n) || n < 0) {
    return null;
  }
  return n;
}

function ConfigRow({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="ui-config-kv-row">
      <div className="ui-config-kv-label">{label}</div>
      <div className="ui-config-kv-value">
        <div>{value}</div>
        {detail ? <div className="ui-muted-detail">{detail}</div> : null}
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
  auditEvents,
  projects
}: {
  companyId: string;
  companies: Array<{ id: string; name: string }>;
  agent: AgentRow;
  agents: AgentRow[];
  issues: IssueRow[];
  heartbeatRuns: HeartbeatRunRow[];
  costEntries: CostRow[];
  auditEvents: AuditRow[];
  projects: Array<{ id: string; name: string }>;
}) {
  const router = useRouter();
  const [actionError, setActionError] = useState<string | null>(null);
  const [sidebarError, setSidebarError] = useState<string | null>(null);
  const [pendingActionKeys, setPendingActionKeys] = useState<Record<string, boolean>>({});
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [appearanceDialogOpen, setAppearanceDialogOpen] = useState(false);
  const [terminateDialogOpen, setTerminateDialogOpen] = useState(false);
  const [agentRoutines, setAgentRoutines] = useState<AgentRoutineRow[]>([]);
  const [routinesLoading, setRoutinesLoading] = useState(true);
  const [routinesError, setRoutinesError] = useState<string | null>(null);
  const [companySkillsItems, setCompanySkillsItems] = useState<CompanySkillListItem[]>([]);
  const [companySkillsLoading, setCompanySkillsLoading] = useState(false);
  const [companySkillsError, setCompanySkillsError] = useState<string | null>(null);

  const loadAgentRoutines = useCallback(async () => {
    if (!companyId) {
      setAgentRoutines([]);
      setRoutinesLoading(false);
      return;
    }
    setRoutinesLoading(true);
    setRoutinesError(null);
    try {
      const res = await apiGet<{ data: AgentRoutineRow[] }>("/routines", companyId);
      const rows = res.data.data ?? [];
      setAgentRoutines(
        rows
          .filter((loop) => loop.assigneeAgentId === agent.id)
          .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
      );
    } catch (e) {
      setAgentRoutines([]);
      setRoutinesError(e instanceof ApiError ? e.message : "Failed to load routines.");
    } finally {
      setRoutinesLoading(false);
    }
  }, [companyId, agent.id]);

  useEffect(() => {
    void loadAgentRoutines();
  }, [loadAgentRoutines]);

  useEffect(() => {
    if (!companyId || !providerSupportsSkillLibrary(agent.providerType)) {
      setCompanySkillsItems([]);
      setCompanySkillsLoading(false);
      setCompanySkillsError(null);
      return;
    }
    let cancelled = false;
    setCompanySkillsLoading(true);
    setCompanySkillsError(null);
    void apiGet<{ items: CompanySkillListItem[] }>("/observability/company-skills", companyId)
      .then((res) => {
        if (cancelled) {
          return;
        }
        const raw = res.data.items ?? [];
        setCompanySkillsItems(
          raw.map((row) => ({
            skillId: row.skillId,
            sidebarTitle: row.sidebarTitle ?? null
          }))
        );
      })
      .catch((e) => {
        if (cancelled) {
          return;
        }
        setCompanySkillsItems([]);
        setCompanySkillsError(e instanceof ApiError ? e.message : "Failed to load company skills.");
      })
      .finally(() => {
        if (!cancelled) {
          setCompanySkillsLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [companyId, agent.providerType]);

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
  const recentDeliveryIssues = useMemo(
    () =>
      issues
        .filter((issue) => issue.assigneeAgentId === agent.id && (issue.status === "in_review" || issue.status === "done"))
        .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()),
    [agent.id, issues]
  );

  const explicitCompanySkillIds = useMemo(() => {
    const es = agent.enabledSkillIds;
    if (es === null || es === undefined) {
      return null;
    }
    return companySkillAllowlistOnly(es);
  }, [agent.enabledSkillIds]);

  const skillsTabSuffix = useMemo(() => {
    if (!providerSupportsSkillLibrary(agent.providerType)) {
      return "";
    }
    if (explicitCompanySkillIds === null) {
      if (companySkillsLoading) {
        return "";
      }
      return ` (${BUILTIN_BOPO_SKILL_IDS.length + companySkillsItems.length})`;
    }
    return ` (${BUILTIN_BOPO_SKILL_IDS.length + explicitCompanySkillIds.length})`;
  }, [agent.providerType, explicitCompanySkillIds, companySkillsLoading, companySkillsItems.length]);

  const chartGradientId = useId().replace(/:/g, "");
  const sidebarBudgetFieldId = useId();

  const agentRunsDailyChartData = useMemo(() => {
    const now = new Date();
    const days = 14;
    const byDay = new Map<string, { completed: number; failed: number }>();
    for (let i = days - 1; i >= 0; i -= 1) {
      const day = new Date(now);
      day.setHours(0, 0, 0, 0);
      day.setDate(day.getDate() - i);
      const key = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
      byDay.set(key, { completed: 0, failed: 0 });
    }
    for (const run of agentRuns) {
      const day = new Date(run.startedAt);
      day.setHours(0, 0, 0, 0);
      const key = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
      const current = byDay.get(key);
      if (!current) {
        continue;
      }
      if (run.status === "completed") {
        current.completed += 1;
      } else if (run.status === "failed") {
        current.failed += 1;
      }
    }
    return Array.from(byDay.entries()).map(([date, values]) => ({
      label: date.slice(5),
      completed: values.completed,
      failed: values.failed
    }));
  }, [agentRuns]);

  const agentIssueActivityByDay = useMemo(() => {
    const now = new Date();
    const days = 14;
    const byDay = new Map<string, { done: number; inReview: number; active: number }>();
    for (let i = days - 1; i >= 0; i -= 1) {
      const day = new Date(now);
      day.setHours(0, 0, 0, 0);
      day.setDate(day.getDate() - i);
      const key = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
      byDay.set(key, { done: 0, inReview: 0, active: 0 });
    }
    for (const issue of issues) {
      if (issue.assigneeAgentId !== agent.id || issue.status === "canceled") {
        continue;
      }
      const day = new Date(issue.updatedAt);
      day.setHours(0, 0, 0, 0);
      const key = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
      const current = byDay.get(key);
      if (!current) {
        continue;
      }
      if (issue.status === "done") {
        current.done += 1;
      } else if (issue.status === "in_review") {
        current.inReview += 1;
      } else {
        current.active += 1;
      }
    }
    return Array.from(byDay.entries()).map(([date, values]) => ({
      label: date.slice(5),
      done: values.done,
      inReview: values.inReview,
      active: values.active
    }));
  }, [agent.id, issues]);

  const hasAgentRunsTrend = useMemo(
    () => agentRunsDailyChartData.some((row) => row.completed > 0 || row.failed > 0),
    [agentRunsDailyChartData]
  );
  const hasAgentIssuesTrend = useMemo(
    () => agentIssueActivityByDay.some((row) => row.done > 0 || row.inReview > 0 || row.active > 0),
    [agentIssueActivityByDay]
  );

  const [selectedProviderType, setSelectedProviderType] = useState(agent.providerType);
  const [selectedModelId, setSelectedModelId] = useState(configuredModelId);
  const [sidebarAdapterModels, setSidebarAdapterModels] = useState<SidebarAdapterModelsState>({ status: "idle" });
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
    if (!provider || !providerRequiresNamedModel(provider)) {
      return [];
    }
    const serverModels = sidebarAdapterModels.status === "ok" ? sidebarAdapterModels.models : undefined;
    return buildModelPickerOptions({
      rows: [],
      providerType: provider,
      serverModels,
      currentModel: selectedModelId,
      includeDefault: false
    }).filter((option) => option.value.trim().length > 0);
  }, [selectedProviderType, selectedModelId, sidebarAdapterModels]);
  const completedIssueColumns = useMemo<ColumnDef<IssueRow>[]>(
    () => [
      {
        accessorKey: "title",
        header: ({ column }) => <DataTableColumnHeader column={column} title="Issue" />,
        cell: ({ row }) => (
          <Link href={`/issues/${row.original.id}?companyId=${companyId}`} className="ui-run-table-link">
            {row.original.title}
          </Link>
        )
      },
      {
        accessorKey: "status",
        header: ({ column }) => <DataTableColumnHeader column={column} title="Status" />,
        cell: ({ row }) => (
          <Badge variant="outline" className={getStatusBadgeClassName(row.original.status)}>
            {row.original.status.replaceAll("_", " ")}
          </Badge>
        )
      },
      {
        accessorKey: "priority",
        header: ({ column }) => <DataTableColumnHeader column={column} title="Priority" />,
        cell: ({ row }) => (
          <Badge variant="outline" className={getPriorityBadgeClassName(row.original.priority)}>
            {row.original.priority}
          </Badge>
        )
      },
      {
        accessorKey: "updatedAt",
        header: ({ column }) => <DataTableColumnHeader column={column} title="Last updated" />,
        cell: ({ row }) => (
          <time
            className="ui-run-table-datetime"
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
  const agentRoutineColumns = useMemo<ColumnDef<AgentRoutineRow>[]>(
    () => [
      {
        accessorKey: "title",
        header: ({ column }) => <DataTableColumnHeader column={column} title="Routine" />,
        cell: ({ row }) => (
          <Link
            href={`/routines/${row.original.id}?companyId=${encodeURIComponent(companyId)}` as Route}
            className="ui-run-table-link"
          >
            {row.original.title}
          </Link>
        )
      },
      {
        accessorKey: "projectId",
        header: ({ column }) => <DataTableColumnHeader column={column} title="Project" />,
        cell: ({ row }) => {
          const name = projects.find((p) => p.id === row.original.projectId)?.name;
          return <span className="ui-run-table-cell-muted">{name ?? row.original.projectId}</span>;
        }
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
        accessorKey: "lastTriggeredAt",
        header: ({ column }) => <DataTableColumnHeader column={column} title="Last triggered" />,
        cell: ({ row }) =>
          row.original.lastTriggeredAt ? (
            <time
              className="ui-run-table-datetime"
              dateTime={row.original.lastTriggeredAt}
              title={formatDateTime(row.original.lastTriggeredAt)}
            >
              {formatSmartDateTime(row.original.lastTriggeredAt, { includeSeconds: true })}
            </time>
          ) : (
            <span className="ui-run-table-cell-muted">Never</span>
          )
      },
      {
        accessorKey: "updatedAt",
        header: ({ column }) => <DataTableColumnHeader column={column} title="Updated" />,
        cell: ({ row }) => (
          <time
            className="ui-run-table-datetime"
            dateTime={row.original.updatedAt}
            title={formatDateTime(row.original.updatedAt)}
          >
            {formatSmartDateTime(row.original.updatedAt, { includeSeconds: true })}
          </time>
        )
      }
    ],
    [companyId, projects]
  );
  const agentRunColumns = useMemo<ColumnDef<HeartbeatRunRow>[]>(
    () => [
      {
        accessorKey: "id",
        header: ({ column }) => <DataTableColumnHeader column={column} title="Run" />,
        cell: ({ row }) => (
          <Link className="ui-run-table-link" href={`/runs/${row.original.id}?companyId=${companyId}&agentId=${agent.id}`}>
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
          <div className="ui-run-table-cell-muted">{formatRunDuration(row.original.startedAt, row.original.finishedAt)}</div>
        )
      },
      {
        accessorKey: "startedAt",
        header: ({ column }) => <DataTableColumnHeader column={column} title="Started" />,
        cell: ({ row }) => (
          <time
            className="ui-run-table-datetime"
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
            <div className="ui-run-table-message" title={displayMessage}>
              {previewMessage}
            </div>
          );
        }
      },
      {
        id: "actions",
        header: () => <div className="ui-table-head-right">Actions</div>,
        enableSorting: false,
        cell: ({ row }) => (
          <div className="ui-run-table-actions">
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

  const builtinSkillTableRows = useMemo<AgentBuiltinSkillTableRow[]>(
    () =>
      BUILTIN_BOPO_SKILL_IDS.map((id) => ({
        skillId: id,
        title: BUILTIN_SKILL_TITLES[id] ?? id
      })),
    []
  );

  const builtinSkillColumns = useMemo<ColumnDef<AgentBuiltinSkillTableRow>[]>(
    () => [
      {
        accessorKey: "title",
        header: ({ column }) => <DataTableColumnHeader column={column} title="Name" />,
        cell: ({ row }) => <span className="font-medium">{row.original.title}</span>
      },
      {
        accessorKey: "skillId",
        header: ({ column }) => <DataTableColumnHeader column={column} title="Skill ID" />,
        cell: ({ row }) => (
          <span className="ui-run-table-cell-muted font-mono text-xs">{row.original.skillId}</span>
        )
      },
      {
        id: "open",
        header: ({ column }) => <DataTableColumnHeader column={column} title="Open" />,
        enableSorting: false,
        cell: ({ row }) => (
          <Link
            href={
              `/settings/skills?companyId=${encodeURIComponent(companyId)}&kind=builtin&skillId=${encodeURIComponent(row.original.skillId)}` as Route
            }
            className="ui-run-table-link text-sm"
          >
            View
          </Link>
        )
      }
    ],
    [companyId]
  );

  const companySkillLibraryIds = useMemo(
    () => companySkillsItems.map((row) => row.skillId),
    [companySkillsItems]
  );

  const companySkillTitleById = useMemo(() => {
    const m = new Map<string, string>();
    for (const row of companySkillsItems) {
      const label = row.sidebarTitle?.trim() || row.skillId;
      m.set(row.skillId, label);
    }
    return m;
  }, [companySkillsItems]);

  const companySkillPickerRows = useMemo<AgentCompanySkillPickerRow[]>(() => {
    const seen = new Set<string>();
    const ids: string[] = [];
    for (const row of companySkillsItems) {
      if (!seen.has(row.skillId)) {
        seen.add(row.skillId);
        ids.push(row.skillId);
      }
    }
    if (explicitCompanySkillIds) {
      for (const id of explicitCompanySkillIds) {
        if (!seen.has(id)) {
          seen.add(id);
          ids.push(id);
        }
      }
    }
    ids.sort((a, b) => a.localeCompare(b));
    return ids.map((skillId) => ({
      skillId,
      title: companySkillTitleById.get(skillId) ?? skillId
    }));
  }, [companySkillsItems, explicitCompanySkillIds, companySkillTitleById]);

  const configuredThinkingEffort = state.runtime?.thinkingEffort ?? agent.runtimeThinkingEffort ?? "auto";
  const [selectedThinkingEffort, setSelectedThinkingEffort] = useState<"auto" | "low" | "medium" | "high">(
    configuredThinkingEffort
  );
  const [selectedManagerAgentId, setSelectedManagerAgentId] = useState(agent.managerAgentId ?? "__none");
  const [budgetInput, setBudgetInput] = useState(() => formatAgentBudgetInput(agent));
  const agentRef = useRef(agent);
  agentRef.current = agent;
  const budgetAutosaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const updateSidebarSettingsRef = useRef<
    (
      payload: {
        runtimeConfig?: { runtimeModel?: string; runtimeThinkingEffort?: "auto" | "low" | "medium" | "high" };
        providerType?: RuntimeProviderType;
        managerAgentId?: string | null;
        monthlyBudgetUsd?: number;
      },
      actionKey: string
    ) => Promise<void>
  >(async () => {});

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
    const provider = normalizeRuntimeProvider(selectedProviderType);
    if (!provider || !providerRequiresNamedModel(provider)) {
      setSidebarAdapterModels({ status: "idle" });
      return;
    }
    setSidebarAdapterModels({ status: "loading" });
    const body = buildAdapterModelsRequestBody(agent);
    void fetchAdapterModelsForProvider(companyId, provider, body)
      .then((models) => setSidebarAdapterModels({ status: "ok", models }))
      .catch(() => setSidebarAdapterModels({ status: "error" }));
  }, [
    companyId,
    selectedProviderType,
    agent.id,
    agent.runtimeCommand,
    agent.runtimeArgsJson,
    agent.runtimeCwd,
    agent.runtimeEnvJson,
    agent.runtimeModel,
    agent.runtimeThinkingEffort,
    agent.bootstrapPrompt,
    agent.runtimeTimeoutSec,
    agent.interruptGraceSec,
    agent.runPolicyJson
  ]);

  useEffect(() => {
    setSelectedThinkingEffort(configuredThinkingEffort);
  }, [configuredThinkingEffort]);

  useEffect(() => {
    setSelectedManagerAgentId(agent.managerAgentId ?? "__none");
  }, [agent.managerAgentId]);

  useEffect(() => {
    setBudgetInput(formatAgentBudgetInput(agent));
  }, [agent.monthlyBudgetUsd]);

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

  const companySkillsActionKey = `agent:${agent.id}:company-skills`;

  async function persistCompanySkillAllowlist(next: string[] | null) {
    await runAgentAction(async () => {
      await apiPut(`/agents/${agent.id}`, companyId, { runtimeConfig: { enabledSkillIds: next } });
    }, "Failed to update company skills.", companySkillsActionKey);
  }

  async function handleCompanySkillToggle(skillId: string, checked: boolean) {
    const libraryIds = companySkillLibraryIds;
    const librarySorted = [...libraryIds].sort((a, b) => a.localeCompare(b));
    if (explicitCompanySkillIds === null) {
      if (!checked) {
        const nextExplicit = companySkillAllowlistOnly(libraryIds.filter((id) => id !== skillId));
        await persistCompanySkillAllowlist(nextExplicit);
      }
      return;
    }
    const nextSet = new Set(explicitCompanySkillIds);
    if (checked) {
      nextSet.add(skillId);
    } else {
      nextSet.delete(skillId);
    }
    let nextExplicit = companySkillAllowlistOnly([...nextSet]);
    nextExplicit = nextExplicit.slice().sort((a, b) => a.localeCompare(b));
    const matchesFullLibrary =
      librarySorted.length > 0 &&
      nextExplicit.length === librarySorted.length &&
      librarySorted.every((id, i) => id === nextExplicit[i]);
    await persistCompanySkillAllowlist(matchesFullLibrary ? null : nextExplicit);
  }

  const companySkillPickerColumns = useMemo<ColumnDef<AgentCompanySkillPickerRow>[]>(
    () => [
      {
        id: "include",
        meta: {
          headerClassName: "w-20 min-w-20 max-w-24 shrink-0 !px-2 !text-center",
          cellClassName: "w-20 min-w-20 max-w-24 shrink-0 !px-2 align-middle"
        },
        header: ({ column }) => <DataTableColumnHeader column={column} title="Include" />,
        enableSorting: false,
        cell: ({ row }) => {
          const skillId = row.original.skillId;
          const included =
            explicitCompanySkillIds === null || explicitCompanySkillIds.includes(skillId);
          const disabled = agent.status === "terminated" || isActionPending(companySkillsActionKey);
          const checkboxId = `agent-detail-co-skill-${skillId}`;
          return (
            <div className="flex justify-center">
              <Checkbox
                id={checkboxId}
                checked={included}
                disabled={disabled}
                onCheckedChange={(value) => {
                  void handleCompanySkillToggle(skillId, value === true);
                }}
                aria-label={`Include ${row.original.title}`}
              />
            </div>
          );
        }
      },
      {
        accessorKey: "title",
        header: ({ column }) => <DataTableColumnHeader column={column} title="Name" />,
        cell: ({ row }) => {
          const skillId = row.original.skillId;
          const checkboxId = `agent-detail-co-skill-${skillId}`;
          return (
            <label htmlFor={checkboxId} className="font-medium cursor-pointer select-none">
              {row.original.title}
            </label>
          );
        }
      },
      {
        accessorKey: "skillId",
        header: ({ column }) => <DataTableColumnHeader column={column} title="Skill ID" />,
        cell: ({ row }) => (
          <span className="ui-run-table-cell-muted font-mono text-xs">{row.original.skillId}</span>
        )
      },
      {
        id: "open",
        header: ({ column }) => <DataTableColumnHeader column={column} title="Open" />,
        enableSorting: false,
        cell: ({ row }) => (
          <Link
            href={
              `/settings/skills?companyId=${encodeURIComponent(companyId)}&kind=company&skillId=${encodeURIComponent(row.original.skillId)}&path=SKILL.md` as Route
            }
            className="ui-run-table-link text-sm"
          >
            View
          </Link>
        )
      }
    ],
    [
      companyId,
      explicitCompanySkillIds,
      agent.status,
      companySkillsActionKey,
      isActionPending,
      pendingActionKeys,
      handleCompanySkillToggle
    ]
  );

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
      monthlyBudgetUsd?: number;
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

  updateSidebarSettingsRef.current = updateSidebarSettings;

  useEffect(() => {
    if (budgetAutosaveTimerRef.current) {
      clearTimeout(budgetAutosaveTimerRef.current);
    }
    budgetAutosaveTimerRef.current = setTimeout(() => {
      budgetAutosaveTimerRef.current = null;
      const raw = budgetInput;
      const parsed = parseNonnegativeUsdBudget(raw);
      if (parsed === null) {
        return;
      }
      const a = agentRef.current;
      const budgetActionKey = `agent:${a.id}:budget`;
      const serverVal = typeof a.monthlyBudgetUsd === "number" ? a.monthlyBudgetUsd : 0;
      if (Math.abs(parsed - serverVal) < 1e-6) {
        return;
      }
      void (async () => {
        try {
          await updateSidebarSettingsRef.current({ monthlyBudgetUsd: parsed }, budgetActionKey);
        } catch {
          setBudgetInput(formatAgentBudgetInput(agentRef.current));
        }
      })();
    }, 800);
    return () => {
      if (budgetAutosaveTimerRef.current) {
        clearTimeout(budgetAutosaveTimerRef.current);
        budgetAutosaveTimerRef.current = null;
      }
    };
  }, [budgetInput]);

  function flushBudgetOnBlur() {
    if (budgetAutosaveTimerRef.current) {
      clearTimeout(budgetAutosaveTimerRef.current);
      budgetAutosaveTimerRef.current = null;
    }
    const a = agentRef.current;
    const parsed = parseNonnegativeUsdBudget(budgetInput);
    if (parsed === null) {
      setSidebarError("Enter a valid monthly budget (0 or greater).");
      setBudgetInput(formatAgentBudgetInput(a));
      return;
    }
    setSidebarError(null);
    const serverVal = typeof a.monthlyBudgetUsd === "number" ? a.monthlyBudgetUsd : 0;
    if (Math.abs(parsed - serverVal) < 1e-6) {
      return;
    }
    void (async () => {
      try {
        await updateSidebarSettingsRef.current({ monthlyBudgetUsd: parsed }, `agent:${a.id}:budget`);
      } catch {
        setBudgetInput(formatAgentBudgetInput(agentRef.current));
      }
    })();
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
    <div className="ui-page-stack">
      <div className="ui-agent-header-bar">
        <div className="ui-agent-header-identity">
          <button
            type="button"
            className="ui-agent-header-avatar-trigger shrink-0 rounded-full border-0 bg-transparent p-0 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            onClick={() => setAppearanceDialogOpen(true)}
            aria-label={`Change appearance for ${agent.name}`}
            title="Change appearance"
          >
            <AgentAvatar
              seed={agentAvatarSeed(agent.id, agent.name, agent.avatarSeed)}
              name={agent.name}
              className="ui-agent-header-avatar"
              size={128}
              lucideIconName={agent.lucideIconName}
            />
          </button>
          <SectionHeading
            title={agent.name}
            description="The active things your AI workforce is working on."
          />
        </div>
        <div className="ui-agent-header-actions">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="outline" aria-label="Open more actions">
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem asChild>
                <Link href={{ pathname: `/agents/${agent.id}/docs`, query: { companyId } }}>Documents</Link>
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
          <Button size="sm" variant="outline" onClick={() => setEditDialogOpen(true)}>
            Edit
          </Button>
          {agent.status === "paused" ? (
            <Button
              size="sm"
              variant="outline"
              disabled={isActionPending(`agent:${agent.id}:resume`)}
              onClick={() => {
                if (window.confirm(`Resume "${agent.name}" so heartbeats can run again?`)) {
                  void resumeAgent();
                }
              }}
            >
              Resume
            </Button>
          ) : (
            <Button
              size="sm"
              variant="outline"
              disabled={agent.status === "terminated" || isActionPending(`agent:${agent.id}:pause`)}
              onClick={() => {
                if (window.confirm(`Pause "${agent.name}" and block new heartbeat runs?`)) {
                  void pauseAgent();
                }
              }}
            >
              Pause
            </Button>
          )}
          <Button
            size="sm"
            onClick={() => void runHeartbeat()}
            disabled={invokeDisabledReason !== null || isActionPending(invokeActionKey)}
          >
            {isActionPending(invokeActionKey) ? "Running..." : "Invoke"}
          </Button>
        </div>
      </div>
      {invokeDisabledReason ? (
        <Alert>
          <AlertDescription>{invokeDisabledReason}</AlertDescription>
        </Alert>
      ) : null}

      <Tabs defaultValue="dashboard" className="ui-tabs-gap-none">
        <TabsList>
          <TabsTrigger value="dashboard">Dashboard</TabsTrigger>
          <TabsTrigger value="issues">Issues ({recentDeliveryIssues.length})</TabsTrigger>
          <TabsTrigger value="routines">Routines ({agentRoutines.length})</TabsTrigger>
          <TabsTrigger value="skills">Skills{skillsTabSuffix}</TabsTrigger>
          <TabsTrigger value="runs">Runs ({agentRuns.length})</TabsTrigger>
        </TabsList>

        <TabsContent value="dashboard" className="ui-issue-tabs-content">
          <div className="ui-agent-dashboard-charts-grid">
            <Card>
              <CardHeader>
                <CardTitle>Run outcomes</CardTitle>
                <CardDescription>
                  Completed vs failed heartbeat runs by start day (last 14 days; skipped runs excluded).
                </CardDescription>
              </CardHeader>
              <CardContent>
                {hasAgentRunsTrend ? (
                  <ChartContainer config={AGENT_RUNS_AREA_CHART_CONFIG} className="ui-agent-dashboard-chart">
                    <AreaChart accessibilityLayer data={agentRunsDailyChartData} margin={{ top: 8, left: -8, right: -8 }}>
                      <defs>
                        <linearGradient id={`${chartGradientId}-runsCompleted`} x1="0" y1="0" x2="0" y2="1">
                          <stop offset="10%" stopColor="var(--color-completed)" stopOpacity={0.45} />
                          <stop offset="90%" stopColor="var(--color-completed)" stopOpacity={0.06} />
                        </linearGradient>
                        <linearGradient id={`${chartGradientId}-runsFailed`} x1="0" y1="0" x2="0" y2="1">
                          <stop offset="10%" stopColor="var(--color-failed)" stopOpacity={0.4} />
                          <stop offset="90%" stopColor="var(--color-failed)" stopOpacity={0.04} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid vertical={false} strokeDasharray="4 4" strokeOpacity={0.3} />
                      <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={10} minTickGap={22} />
                      <YAxis hide />
                      <ChartTooltip content={<ChartTooltipContent indicator="line" />} cursor={false} />
                      <Area
                        type="monotone"
                        dataKey="completed"
                        stroke="var(--color-completed)"
                        fill={`url(#${chartGradientId}-runsCompleted)`}
                        fillOpacity={1}
                        strokeWidth={2}
                      />
                      <Area
                        type="monotone"
                        dataKey="failed"
                        stroke="var(--color-failed)"
                        fill={`url(#${chartGradientId}-runsFailed)`}
                        fillOpacity={1}
                        strokeWidth={2}
                      />
                    </AreaChart>
                  </ChartContainer>
                ) : (
                  <p className="text-sm text-muted-foreground">No completed or failed runs in the last 14 days.</p>
                )}
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>Assigned issue activity</CardTitle>
                <CardDescription>
                  Issues counted on the day they were last updated, stacked by status (last 14 days).
                </CardDescription>
              </CardHeader>
              <CardContent>
                {hasAgentIssuesTrend ? (
                  <ChartContainer config={AGENT_ISSUES_AREA_CHART_CONFIG} className="ui-agent-dashboard-chart">
                    <AreaChart accessibilityLayer data={agentIssueActivityByDay} margin={{ top: 8, left: -8, right: -8 }}>
                      <defs>
                        <linearGradient id={`${chartGradientId}-issDone`} x1="0" y1="0" x2="0" y2="1">
                          <stop offset="10%" stopColor="var(--color-done)" stopOpacity={0.45} />
                          <stop offset="90%" stopColor="var(--color-done)" stopOpacity={0.06} />
                        </linearGradient>
                        <linearGradient id={`${chartGradientId}-issReview`} x1="0" y1="0" x2="0" y2="1">
                          <stop offset="10%" stopColor="var(--color-inReview)" stopOpacity={0.4} />
                          <stop offset="90%" stopColor="var(--color-inReview)" stopOpacity={0.06} />
                        </linearGradient>
                        <linearGradient id={`${chartGradientId}-issActive`} x1="0" y1="0" x2="0" y2="1">
                          <stop offset="10%" stopColor="var(--color-active)" stopOpacity={0.38} />
                          <stop offset="90%" stopColor="var(--color-active)" stopOpacity={0.05} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid vertical={false} strokeDasharray="4 4" strokeOpacity={0.3} />
                      <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={10} minTickGap={22} />
                      <YAxis hide />
                      <ChartTooltip content={<ChartTooltipContent indicator="line" />} cursor={false} />
                      <Area
                        type="monotone"
                        dataKey="done"
                        stackId="issues"
                        stroke="var(--color-done)"
                        fill={`url(#${chartGradientId}-issDone)`}
                        fillOpacity={1}
                        strokeWidth={2}
                      />
                      <Area
                        type="monotone"
                        dataKey="inReview"
                        stackId="issues"
                        stroke="var(--color-inReview)"
                        fill={`url(#${chartGradientId}-issReview)`}
                        fillOpacity={1}
                        strokeWidth={2}
                      />
                      <Area
                        type="monotone"
                        dataKey="active"
                        stackId="issues"
                        stroke="var(--color-active)"
                        fill={`url(#${chartGradientId}-issActive)`}
                        fillOpacity={1}
                        strokeWidth={2}
                      />
                    </AreaChart>
                  </ChartContainer>
                ) : (
                  <p className="text-sm text-muted-foreground">No assigned issue updates in the last 14 days.</p>
                )}
              </CardContent>
            </Card>
          </div>

          <SectionHeading
            title="Prompt"
            description="System-style instructions injected when this agent starts or resumes."
          />
          <Card>
            <CardContent className="ui-detail-sidebar-section">
              {agent.bootstrapPrompt?.trim() ? (
                <CollapsibleMarkdown
                  content={agent.bootstrapPrompt}
                  className="ui-markdown"
                  maxHeightPx={COLLAPSIBLE_MARKDOWN_BODY_MAX_HEIGHT_PX}
                />
              ) : (
                <p className="text-sm text-muted-foreground">No bootstrap prompt configured.</p>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="issues" className="ui-issue-tabs-content">
          <SectionHeading title="Issues" description="Latest done and in-review issues assigned to this agent." />
          <DataTable
            columns={completedIssueColumns}
            data={recentDeliveryIssues}
            emptyMessage="No done or in-review issues for this agent yet."
            defaultPageSize={10}
            showViewOptions={false}
          />
        </TabsContent>

        <TabsContent value="routines" className="ui-issue-tabs-content">
          <SectionHeading
            title="Routines"
            description="Scheduled routines where this agent is the assignee (opens issues on each run)."
          />
          {routinesLoading ? <p className="text-sm text-muted-foreground">Loading routines…</p> : null}
          {routinesError ? <p className="text-sm text-destructive">{routinesError}</p> : null}
          {!routinesLoading && !routinesError ? (
            <DataTable
              columns={agentRoutineColumns}
              data={agentRoutines}
              emptyMessage="No routines assign this agent yet."
              defaultPageSize={10}
              showViewOptions={false}
            />
          ) : null}
        </TabsContent>

        <TabsContent value="skills" className="ui-issue-tabs-content">
          {!providerSupportsSkillLibrary(agent.providerType) ? (
            <Card>
              <CardContent className="ui-detail-sidebar-section space-y-2">
                <p className="text-sm text-muted-foreground">
                  The skills library is only injected for Codex, Claude Code, Cursor, and OpenCode. This agent uses{" "}
                  <span className="text-foreground">{getProviderLabel(agent.providerType)}</span>.
                </p>
                {explicitCompanySkillIds !== null ? (
                  <p className="text-sm text-muted-foreground">
                    A skill allowlist is saved on this agent; it applies when you switch to a supported runtime.
                  </p>
                ) : null}
              </CardContent>
            </Card>
          ) : (
            <>
              <SectionHeading
                title="Skills"
                description="Always included when an allowlist is in effect."
              />
              <DataTable
                columns={builtinSkillColumns}
                data={builtinSkillTableRows}
                emptyMessage="No built-in skills."
                defaultPageSize={10}
                showViewOptions={false}
              />
              <div className="mt-8 space-y-6">
                <SectionHeading
                  title="Custom"
                  description={
                    explicitCompanySkillIds === null
                      ? "Every company skill is included. Uncheck any skill to use a custom allowlist instead."
                      : "Checked skills are included for this agent. Built-in skills above always apply."
                  }
                />
                {companySkillsLoading ? <p className="text-sm text-muted-foreground">Loading company skills…</p> : null}
                {companySkillsError ? <p className="text-sm text-destructive">{companySkillsError}</p> : null}
                {!companySkillsLoading && !companySkillsError ? (
                  <DataTable
                    columns={companySkillPickerColumns}
                    data={companySkillPickerRows}
                    emptyMessage="No company skills in the library yet. Add them under Company → Skills."
                    defaultPageSize={10}
                    showViewOptions={false}
                  />
                ) : null}
              </div>
            </>
          )}
        </TabsContent>

        <TabsContent value="runs" className="ui-issue-tabs-content">
          <SectionHeading title="Runs" description="Heartbeat runs scoped to this agent." />
          <DataTable
            columns={agentRunColumns}
            data={agentRuns}
            emptyMessage="No runs have executed for this agent yet."
            defaultPageSize={10}
            showViewOptions={false}
          />
        </TabsContent>
      </Tabs>
    </div>
  );

  const rightPane = (
    <div className="ui-detail-sidebar">
      <Card>
        <CardContent className="ui-sidebar-controls-stack">
          <Field>
            <FieldLabel>Provider</FieldLabel>
            <Select
              value={selectedProviderType}
              onValueChange={(value) => void handleProviderChange(value)}
              disabled={isActionPending(`agent:${agent.id}:provider`) || agent.status === "terminated"}
            >
              <SelectTrigger className="ui-select-trigger-full">
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

          <Field className="ui-sidebar-field-spaced">
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
              <SelectTrigger className="ui-select-trigger-full">
                <SelectValue placeholder={modelOptions.length === 0 ? "Not configurable" : "Select a model"} />
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
            <Field className="ui-sidebar-field-spaced">
              <FieldLabel>Thinking effort</FieldLabel>
              <Select
                value={selectedThinkingEffort}
                onValueChange={(value) => void handleThinkingEffortChange(value as "auto" | "low" | "medium" | "high")}
                disabled={isActionPending(`agent:${agent.id}:runtime-thinking-effort`) || agent.status === "terminated"}
              >
                <SelectTrigger className="ui-select-trigger-full">
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

          <Field className="ui-sidebar-field-spaced">
            <FieldLabel>Reports to</FieldLabel>
            <Select
              value={selectedManagerAgentId}
              onValueChange={(value) => void handleManagerChange(value)}
              disabled={isActionPending(`agent:${agent.id}:manager`) || agent.status === "terminated"}
            >
              <SelectTrigger className="ui-select-trigger-full">
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

          <Field className="ui-sidebar-field-spaced">
            <FieldLabel htmlFor={sidebarBudgetFieldId}>Monthly budget (USD)</FieldLabel>
            <Input
              id={sidebarBudgetFieldId}
              type="number"
              min={0}
              step={0.01}
              value={budgetInput}
              onChange={(e) => setBudgetInput(e.target.value)}
              onBlur={() => flushBudgetOnBlur()}
              readOnly={isActionPending(`agent:${agent.id}:budget`)}
              disabled={agent.status === "terminated"}
              aria-busy={isActionPending(`agent:${agent.id}:budget`)}
              aria-label="Monthly budget in US dollars"
            />
          </Field>

          {sidebarError ? <div className="ui-sidebar-error-text">{sidebarError}</div> : null}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="ui-config-card-stack">
          <ConfigRow label="Agent ID" value={agent.id} />
          <ConfigRow label="Role" value={agent.role ?? "Not set"} />
          <ConfigRow label="Status" value={liveStatus} detail={liveStatusDetail} />
          <ConfigRow label="Heartbeat" value={formatHeartbeatCadence(agent.heartbeatCron)} />
        </CardContent>
      </Card>

      <Card>
        <CardContent className="ui-config-card-stack">
          <ConfigRow
            label="Monthly budget"
            value={typeof agent.monthlyBudgetUsd === "number" ? `$${agent.monthlyBudgetUsd.toFixed(2)}` : "Not set"}
          />
          <ConfigRow label="Budget used (month)" value={`$${usedBudgetUsd.toFixed(2)}`} />
          <ConfigRow label="Input tokens" value={costSummary.input.toLocaleString()} />
          <ConfigRow label="Output tokens" value={costSummary.output.toLocaleString()} />
        </CardContent>
      </Card>

      <Card>
        <CardContent className="ui-config-kv-column">
          <div className="ui-config-kv-label">Capabilities</div>
          <div className="ui-config-kv-column-value">
            {agent.capabilities?.trim() ? (
              <CollapsibleMarkdown
                content={agent.capabilities.trim()}
                className="ui-markdown"
                maxHeightPx={COLLAPSIBLE_MARKDOWN_BODY_MAX_HEIGHT_PX}
              />
            ) : (
              "Not set"
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );

  return (
    <>
      {actionError ? (
        <Alert variant="destructive" className="ui-alert-margin">
          <AlertTitle>Action failed</AlertTitle>
          <AlertDescription>{actionError}</AlertDescription>
        </Alert>
      ) : null}
      <AppShell leftPane={leftPane} rightPane={rightPane} activeNav="Agents" companies={companies} activeCompanyId={companyId} />
      <AgentAppearanceModal
        companyId={companyId}
        agent={{
          id: agent.id,
          name: agent.name,
          avatarSeed: agent.avatarSeed,
          lucideIconName: agent.lucideIconName
        }}
        open={appearanceDialogOpen}
        onOpenChange={setAppearanceDialogOpen}
      />
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
            | "gemini_cli"
            | "openai_api"
            | "anthropic_api"
            | "openclaw_gateway"
            | "http"
            | "shell",
          heartbeatCron: agent.heartbeatCron,
          monthlyBudgetUsd: agent.monthlyBudgetUsd,
          canHireAgents: agent.canHireAgents,
          canAssignAgents: agent.canAssignAgents,
          canCreateIssues: agent.canCreateIssues,
          runtimeCommand: agent.runtimeCommand,
          runtimeArgsJson: agent.runtimeArgsJson,
          runtimeCwd: agent.runtimeCwd,
          runtimeEnvJson: agent.runtimeEnvJson,
          runtimeModel: agent.runtimeModel,
          runtimeThinkingEffort: agent.runtimeThinkingEffort,
          bootstrapPrompt: agent.bootstrapPrompt,
          capabilities: agent.capabilities,
          runtimeTimeoutSec: agent.runtimeTimeoutSec,
          interruptGraceSec: agent.interruptGraceSec,
          runPolicyJson: agent.runPolicyJson,
          stateBlob: agent.stateBlob,
          enabledSkillIds: agent.enabledSkillIds
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
    </>
  );
}
