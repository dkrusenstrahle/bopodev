"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import dynamic from "next/dynamic";
import Link from "next/link";
import type { Route } from "next";
import type { ColumnDef } from "@tanstack/react-table";
import { AppShell } from "@/components/app-shell";
import { AgentAvatar } from "@/components/agent-avatar";
import { IssueWorkspace } from "@/components/issue-workspace";
import { CreateAgentModal } from "@/components/modals/create-agent-modal";
import { CreateCompanyModal } from "@/components/modals/create-company-modal";
import { ConfirmActionModal } from "@/components/modals/confirm-action-modal";
import { CreateGoalModal } from "@/components/modals/create-goal-modal";
import { CreateIssueModal } from "@/components/modals/create-issue-modal";
import { CreateProjectModal } from "@/components/modals/create-project-modal";
import { TextActionModal } from "@/components/modals/text-action-modal";
import { CompanyFileExportCard, CompanyFileImportCard } from "@/components/company-file-export-panel";
import { TemplatePreviewContent } from "@/components/template-preview-content";
import { ApiError, apiDelete, apiGet, apiPost, apiPut } from "@/lib/api";
import { agentAvatarSeed } from "@/lib/agent-avatar";
import { cn } from "@/lib/utils";
import { getGoalLevelBadgeClassName, getStatusBadgeClassName } from "@/lib/status-presentation";
import { getSupportedModelOptionsForProvider } from "@/lib/agent-runtime-options";
import { formatAuditEventLabel } from "@/lib/event-display";
import { formatSmartDateTime } from "@/lib/smart-date";
import { isNoAssignedWorkRun, isStoppedRun, resolveWindowStart, summarizeCosts } from "@/lib/workspace-logic";
import type { SectionLabel } from "@/lib/sections";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { DataTable } from "@/components/ui/data-table";
import { DataTableColumnHeader } from "@/components/ui/data-table-column-header";
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger
} from "@/components/ui/drawer";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldGroup } from "@/components/ui/field";
import { FieldLabelWithHelp } from "@/components/ui/field-label-with-help";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  PolarAngleAxis,
  PolarGrid,
  RadialBar,
  RadialBarChart,
  XAxis,
  YAxis
} from "recharts";
import { LayoutGrid, Network, SlidersHorizontal, Table } from "lucide-react";
import { AGENT_ROLE_LABELS, AGENT_ROLE_KEYS, type AgentRoleKey } from "bopodev-contracts";
import styles from "./workspace-client.module.scss";
import {
  EmptyState,
  MetricCard,
  SectionHeading,
  formatDateTime,
  goalStatusOptions
} from "@/components/workspace/shared";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { ModelPricingRow, TemplateRow } from "@/components/workspace/types";
import {
  MODELS_PROVIDER_FALLBACKS,
  normalizeModelIdForCatalog,
  parseRuntimeModelFromStateBlob,
  resolveModelCatalogProvider,
  resolveNamedModelForAgent
} from "@/components/workspace/workspace-client-model";
import {
  buildRecentDayKeys,
  formatMonthLabel,
  formatRelativeAgeCompact,
  localCalendarDayInMonthKey,
  localCalendarMonthUtcRange,
  monthKeyFromDate
} from "@/components/workspace/workspace-client-time";

const AgentRuntimeDefaultsCard = dynamic(
  () => import("@/components/agent-runtime-defaults-card").then((module) => module.AgentRuntimeDefaultsCard),
  {
    loading: () => null
  }
);
const OrgChart = dynamic(() => import("@/components/org-chart").then((module) => module.OrgChart), {
  loading: () => <div>Loading org chart...</div>
});
interface IssueRow {
  id: string;
  companyId: string;
  projectId: string;
  parentIssueId: string | null;
  goalIds?: string[];
  assigneeAgentId: string | null;
  title: string;
  body?: string | null;
  status: "todo" | "in_progress" | "blocked" | "in_review" | "done" | "canceled";
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
  avatarSeed?: string | null;
  lucideIconName?: string | null;
  role: string;
  roleKey?: AgentRoleKey | null;
  title?: string | null;
  capabilities?: string | null;
  managerAgentId: string | null;
  status: string;
  providerType: string;
  heartbeatCron?: string;
  monthlyBudgetUsd?: number;
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
  usedBudgetUsd?: number;
}

type RuntimeDefaultsProviderType =
  | "claude_code"
  | "codex"
  | "opencode"
  | "openai_api"
  | "anthropic_api"
  | "openclaw_gateway"
  | "http"
  | "shell";

function isRuntimeDefaultsProviderType(value: unknown): value is RuntimeDefaultsProviderType {
  return (
    value === "claude_code" ||
    value === "codex" ||
    value === "opencode" ||
    value === "openai_api" ||
    value === "anthropic_api" ||
    value === "openclaw_gateway" ||
    value === "http" ||
    value === "shell"
  );
}

interface HeartbeatRunRow {
  id: string;
  agentId: string;
  status: string;
  runType: "work" | "no_assigned_work" | "budget_skip" | "overlap_skip" | "other_skip" | "failed" | "running";
  message: string | null;
  startedAt: string;
  finishedAt?: string | null;
}

interface RunDetailsPayload {
  result?: string;
  errorType?: string;
  issueIds?: string[];
  usage?: {
    tokenInput?: number;
    tokenOutput?: number;
    usdCost?: number;
  };
  trace?: {
    command?: string;
    exitCode?: number | null;
    elapsedMs?: number;
    timedOut?: boolean;
    failureType?: string;
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
    stdoutPreview?: string;
    stderrPreview?: string;
  } | null;
  diagnostics?: {
    requestId?: string | null;
    trigger?: string | null;
    stateParseError?: string | null;
  };
}

interface GoalRow {
  id: string;
  projectId: string | null;
  parentGoalId: string | null;
  ownerAgentId?: string | null;
  level: string;
  title: string;
  description?: string | null;
  status: string;
}

interface ApprovalRow {
  id: string;
  action: string;
  status: string;
  createdAt: string;
  resolvedAt?: string | null;
  payload?: Record<string, unknown>;
}

interface GovernanceInboxRow {
  approval: {
    id: string;
    companyId: string;
    requestedByAgentId: string | null;
    action: string;
    payload: Record<string, unknown>;
    status: "pending" | "approved" | "rejected" | "overridden";
    createdAt: string;
    resolvedAt: string | null;
  };
  seenAt: string | null;
  dismissedAt: string | null;
  isPending: boolean;
}

interface AttentionRow {
  key: string;
  category: "approval_required" | "blocker_escalation" | "budget_hard_stop" | "stalled_work" | "run_failure_spike" | "board_mentioned_comment";
  severity: "info" | "warning" | "critical";
  requiredActor: "board" | "member" | "agent" | "system";
  title: string;
  contextSummary: string;
  actionLabel: string;
  actionHref: string;
  impactSummary: string;
  evidence: {
    issueId?: string;
    runId?: string;
    projectId?: string;
    approvalId?: string;
    commentId?: string;
    agentId?: string;
  };
  sourceTimestamp: string;
  state: "open" | "acknowledged" | "resolved" | "dismissed";
  seenAt: string | null;
  acknowledgedAt: string | null;
  dismissedAt: string | null;
  resolvedAt: string | null;
}

function describeApprovalPayload(payload: Record<string, unknown> | undefined) {
  if (!payload) {
    return "No payload";
  }
  const name = typeof payload.name === "string" ? payload.name : null;
  const role = resolvePayloadRoleLabel(payload);
  const projectId = typeof payload.projectId === "string" ? payload.projectId : null;
  const parentGoalId = typeof payload.parentGoalId === "string" ? payload.parentGoalId : null;
  const title = typeof payload.title === "string" ? payload.title : null;
  const fragments = [name, role, title, projectId ? `project:${shortId(projectId)}` : null, parentGoalId ? `parent:${shortId(parentGoalId)}` : null].filter(
    (value): value is string => Boolean(value)
  );
  return fragments.length > 0 ? fragments.join(" · ") : "Payload ready";
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

function resolvePayloadRoleLabel(payload: Record<string, unknown>) {
  const title = typeof payload.title === "string" ? payload.title.trim() : "";
  if (title) {
    return title;
  }
  const roleKey = normalizeRoleKey(typeof payload.roleKey === "string" ? payload.roleKey : null);
  if (roleKey) {
    return AGENT_ROLE_LABELS[roleKey];
  }
  return typeof payload.role === "string" ? payload.role : null;
}

function formatApprovalPayloadDetails(payload: Record<string, unknown> | undefined) {
  if (!payload) {
    return "No payload.";
  }
  try {
    return JSON.stringify(payload, null, 2);
  } catch {
    return "Payload cannot be rendered.";
  }
}

function toAttentionActionHref(actionHref: string, companyId: string | null) {
  if (!companyId) {
    return actionHref;
  }
  const [pathname, existingQuery = ""] = actionHref.split("?");
  const query = new URLSearchParams(existingQuery);
  if (!query.get("companyId")) {
    query.set("companyId", companyId);
  }
  const queryString = query.toString();
  return queryString ? `${pathname}?${queryString}` : pathname;
}

interface AuditRow {
  id: string;
  eventType: string;
  entityType: string;
  entityId: string;
  createdAt: string;
  payload?: Record<string, unknown>;
}

interface CostRow {
  id: string;
  costCategory?: string | null;
  assistantThreadId?: string | null;
  assistantMessageId?: string | null;
  issueId: string | null;
  projectId?: string | null;
  agentId?: string | null;
  providerType: string;
  runtimeModelId?: string | null;
  pricingProviderType?: string | null;
  pricingModelId?: string | null;
  pricingSource?: "exact" | "missing" | null;
  tokenInput: number;
  tokenOutput: number;
  usdCost: number;
  createdAt: string;
}

interface ProjectRow {
  id: string;
  name: string;
  description: string | null;
  status: "planned" | "active" | "paused" | "blocked" | "completed" | "archived";
  plannedStartAt: string | null;
  monthlyBudgetUsd?: number;
  usedBudgetUsd?: number;
  budgetWindowStartAt?: string | null;
  executionWorkspacePolicy?: Record<string, unknown> | null;
  workspaces: Array<{
    id: string;
    companyId: string;
    projectId: string;
    name: string;
    cwd: string | null;
    repoUrl: string | null;
    repoRef: string | null;
    isPrimary: boolean;
    createdAt: string;
    updatedAt: string;
  }>;
  primaryWorkspace: {
    id: string;
    companyId: string;
    projectId: string;
    name: string;
    cwd: string | null;
    repoUrl: string | null;
    repoRef: string | null;
    isPrimary: boolean;
    createdAt: string;
    updatedAt: string;
  } | null;
}

interface CompanyRow {
  id: string;
  name: string;
  mission: string | null;
}

interface PluginRow {
  id: string;
  name: string;
  description?: string | null;
  promptTemplate?: string | null;
  apiVersion?: string;
  version: string;
  kind: string;
  runtimeType: string;
  runtimeEntrypoint: string;
  entrypoints?: Record<string, unknown> | null;
  uiSlots?: Array<Record<string, unknown>>;
  hooks: string[];
  capabilities: string[];
  /** Rows in `plugin_installs` for this company; rollback needs ≥2. */
  installRevisionCount?: number;
  companyConfig: {
    enabled: boolean;
    priority: number;
    config: Record<string, unknown>;
    grantedCapabilities: string[];
  } | null;
}

function formatUsdCost(value: number) {
  if (!Number.isFinite(value) || value <= 0) {
    return "$0.00";
  }
  if (value < 0.01) {
    return `$${value.toFixed(6)}`;
  }
  return `$${value.toFixed(2)}`;
}

const KNOWN_COST_PROVIDER_TITLES: Record<string, string> = {
  claude_code: "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
  opencode: "OpenCode",
  gemini_cli: "Gemini CLI",
  gemini_api: "Gemini API",
  openai_api: "OpenAI API",
  anthropic_api: "Anthropic API",
  openclaw_gateway: "OpenClaw Gateway",
  http: "HTTP",
  shell: "Shell"
};

function formatCostProviderTitle(providerType: string) {
  const known = KNOWN_COST_PROVIDER_TITLES[providerType];
  if (known) {
    return known;
  }
  return providerType
    .split(/[_\s.-]+/)
    .filter(Boolean)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1).toLowerCase())
    .join(" ");
}

const COST_MODEL_UNSET_KEY = "__unset__";

function costEntryModelKey(entry: Pick<CostRow, "runtimeModelId" | "pricingModelId">) {
  const raw = entry.runtimeModelId?.trim() || entry.pricingModelId?.trim() || "";
  return raw || COST_MODEL_UNSET_KEY;
}

function formatCostModelTitle(modelKey: string) {
  if (modelKey === COST_MODEL_UNSET_KEY) {
    return "Unknown model";
  }
  if (modelKey.length > 52) {
    return `${modelKey.slice(0, 49)}…`;
  }
  return modelKey;
}

type CostDailyChartRow = {
  day: number;
  label: string;
  dateLabel: string;
  usd: number;
  tokens: number;
  inputTokens: number;
  outputTokens: number;
};

function CostDailyBreakdownChartCard({
  title,
  chartMonthLabel,
  daily,
  totalUsd,
  totalTokens,
  emptyLabel,
  metaLine,
  threadMessageCount
}: {
  title: string;
  chartMonthLabel: string;
  daily: CostDailyChartRow[];
  totalUsd: number;
  totalTokens: number;
  emptyLabel: string;
  /** Extra context under the subtitle (e.g. message count for chat threads). */
  metaLine?: string;
  /** Read-only stat beside USD/Tokens for owner-assistant threads (messages in the selected month). */
  threadMessageCount?: number;
}) {
  const gradientBaseId = useId().replace(/:/g, "");
  const chartConfig = {
    usd: { label: "Spend (USD)", color: "var(--chart-2)" },
    tokens: { label: "Tokens", color: "var(--chart-4)" }
  } satisfies ChartConfig;
  const usdGradientId = `cd-usd-${gradientBaseId}`;
  const tokensGradientId = `cd-tok-${gradientBaseId}`;
  const hasAnyActivity = daily.some((row) => row.usd > 0 || row.tokens > 0);

  return (
    <Card className={styles.costProviderDailyCard}>
      <CardHeader className={styles.costProviderDailyCardHeader}>
        <CardTitle className={styles.costProviderDailyCardTitle}>{title}</CardTitle>
        <CardDescription>
          Day-by-day usage for {chartMonthLabel}.
          {metaLine ? <span className="ui-cost-chart-meta-line">{metaLine}</span> : null}
        </CardDescription>
        <CardAction className={styles.costProviderDailyCardAction}>
          <div role="group" aria-label="Month totals" className={styles.costProviderDailyMetricGroup}>
            <div
              className={cn(
                styles.costProviderDailyMetricButton,
                styles.costProviderDailyMetricButtonInactive,
                "ui-pointer-events-none-cursor-default"
              )}
            >
              <span className={styles.costProviderDailyMetricLabel}>USD</span>
              <span className={styles.costProviderDailyMetricValue}>{formatUsdCost(totalUsd)}</span>
            </div>
            <div
              className={cn(
                styles.costProviderDailyMetricButton,
                styles.costProviderDailyMetricButtonInactive,
                "ui-pointer-events-none-cursor-default"
              )}
            >
              <span className={styles.costProviderDailyMetricLabel}>Tokens</span>
              <span className={styles.costProviderDailyMetricValue}>{totalTokens.toLocaleString()}</span>
            </div>
            {typeof threadMessageCount === "number" && threadMessageCount > 0 ? (
              <div
                className={cn(
                  styles.costProviderDailyMetricButton,
                  styles.costProviderDailyMetricButtonInactive,
                  "ui-pointer-events-none-cursor-default"
                )}
              >
                <span className={styles.costProviderDailyMetricLabel}>Messages</span>
                <span className={styles.costProviderDailyMetricValue}>{threadMessageCount.toLocaleString()}</span>
              </div>
            ) : null}
          </div>
        </CardAction>
      </CardHeader>
      <CardContent className={styles.costProviderDailyCardContent}>
        {hasAnyActivity ? (
          <ChartContainer config={chartConfig} className={styles.costProviderDailyChartContainer}>
            <BarChart
              accessibilityLayer
              data={daily}
              margin={{ top: 8, left: 2, right: 2, bottom: 4 }}
              barCategoryGap="18%"
              barGap={2}
            >
              <defs>
                <linearGradient id={usdGradientId} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="4%" stopColor="var(--color-usd)" stopOpacity={0.95} />
                  <stop offset="96%" stopColor="var(--color-usd)" stopOpacity={0.55} />
                </linearGradient>
                <linearGradient id={tokensGradientId} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="4%" stopColor="var(--color-tokens)" stopOpacity={0.95} />
                  <stop offset="96%" stopColor="var(--color-tokens)" stopOpacity={0.55} />
                </linearGradient>
              </defs>
              <CartesianGrid vertical={false} strokeDasharray="4 4" strokeOpacity={0.3} />
              <XAxis
                dataKey="dateLabel"
                tickLine={false}
                axisLine={false}
                tickMargin={8}
                minTickGap={28}
                interval="preserveStartEnd"
              />
              <YAxis yAxisId="tokens" orientation="left" hide width={0} domain={[0, "auto"]} />
              <YAxis yAxisId="usd" orientation="right" hide width={0} domain={[0, "auto"]} />
              <ChartTooltip
                content={({ active, payload, label }) => {
                  if (!active || !payload?.length) {
                    return null;
                  }
                  return (
                    <div className="ui-chart-tooltip">
                      {label != null ? <div className="ui-font-medium">{label}</div> : null}
                      <div className="ui-chart-tooltip-rows">
                        {payload.map((item, index) => {
                          const key = String(item.dataKey ?? item.name ?? index);
                          const isUsd = key === "usd";
                          const raw = item.value;
                          const num = typeof raw === "number" ? raw : Number(raw);
                          const display = isUsd ? formatUsdCost(Number.isFinite(num) ? num : 0) : (Number.isFinite(num) ? num : 0).toLocaleString();
                          const color =
                            item.color ?? (isUsd ? "var(--color-usd)" : "var(--color-tokens)");
                          const conf = chartConfig[isUsd ? "usd" : "tokens"];
                          return (
                            <div key={`${key}-${index}`} className="ui-chart-tooltip-row">
                              <span className="ui-chart-tooltip-swatch" style={{ backgroundColor: color }} />
                              <span className="ui-text-muted">{conf.label}</span>
                              <span className="ui-chart-tooltip-value">{display}</span>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                }}
                cursor={{ fill: "var(--muted)", opacity: 0.2 }}
              />
              <Bar
                yAxisId="tokens"
                dataKey="tokens"
                name="tokens"
                fill={`url(#${tokensGradientId})`}
                radius={[3, 3, 0, 0]}
                maxBarSize={14}
              />
              <Bar
                yAxisId="usd"
                dataKey="usd"
                name="usd"
                fill={`url(#${usdGradientId})`}
                radius={[3, 3, 0, 0]}
                maxBarSize={14}
              />
            </BarChart>
          </ChartContainer>
        ) : (
          <EmptyState>{emptyLabel}</EmptyState>
        )}
      </CardContent>
    </Card>
  );
}

function AgentBudgetSpendCard({
  agentName,
  chartMonthLabel,
  monthlyBudgetUsd,
  usedBudgetUsd,
  ledgerUsdMonth,
  daily
}: {
  agentName: string;
  chartMonthLabel: string;
  monthlyBudgetUsd: number;
  usedBudgetUsd: number;
  ledgerUsdMonth: number;
  daily: CostDailyChartRow[];
}) {
  const gradientBaseId = useId().replace(/:/g, "");
  const radialConfig = {
    utilization: { label: "Budget used", color: "var(--chart-2)" }
  } satisfies ChartConfig;
  const barConfig = {
    usd: { label: "Ledger spend (USD)", color: "var(--chart-1)" }
  } satisfies ChartConfig;
  const barGradientId = `abs-usd-${gradientBaseId}`;
  const hasCap = monthlyBudgetUsd > 0;
  const hasDailySpend = daily.some((row) => row.usd > 0);
  const utilizationRawPct = hasCap ? (usedBudgetUsd / monthlyBudgetUsd) * 100 : 0;
  const utilizationRadial = hasCap ? Math.min(100, utilizationRawPct) : 0;
  const utilizationLabel = hasCap ? `${Math.round(utilizationRawPct)}%` : "—";
  const radialRow = [{ utilization: utilizationRadial }];

  return (
    <Card className={styles.costAgentBudgetCard}>
      <CardHeader className={styles.costAgentBudgetCardHeader}>
        <CardTitle className={styles.costAgentBudgetCardTitle}>{agentName}</CardTitle>
        <CardDescription className={styles.costAgentBudgetCardDescription}>
          Envelope · {formatUsdCost(usedBudgetUsd)} of {hasCap ? formatUsdCost(monthlyBudgetUsd) : "no cap"} · Ledger{" "}
          {formatUsdCost(ledgerUsdMonth)} in {chartMonthLabel}.
        </CardDescription>
      </CardHeader>
      <CardContent className={styles.costAgentBudgetCardContent}>
        <div className={styles.costAgentBudgetBody}>
          <div className={styles.costAgentBudgetRadialCol}>
            <div className={styles.costAgentBudgetRadialMeta}>
              <span className={styles.costAgentBudgetRadialFigure}>{utilizationLabel}</span>
            </div>
            <ChartContainer config={radialConfig} className={styles.costAgentBudgetRadialChart}>
              <RadialBarChart
                accessibilityLayer
                data={radialRow}
                innerRadius="58%"
                outerRadius="100%"
                startAngle={90}
                endAngle={-270}
                margin={{ top: 0, right: 0, bottom: 0, left: 0 }}
              >
                <PolarGrid gridType="circle" radialLines={false} stroke="none" className={styles.costAgentBudgetPolarGrid} />
                <PolarAngleAxis type="number" domain={[0, 100]} tick={false} tickLine={false} axisLine={false} />
                <RadialBar dataKey="utilization" cornerRadius={6} fill="var(--color-utilization)" background className={styles.costAgentBudgetRadialBar} />
                <ChartTooltip content={<ChartTooltipContent hideLabel />} cursor={false} />
              </RadialBarChart>
            </ChartContainer>
            {hasCap ? null : <p className={styles.costAgentBudgetRadialHint}>Set a monthly budget on the agent to track utilization.</p>}
          </div>
          <div className={styles.costAgentBudgetSpendCol}>
            {hasDailySpend ? (
              <ChartContainer config={barConfig} className={styles.costAgentBudgetBarChart}>
                <BarChart accessibilityLayer data={daily} margin={{ top: 8, left: -8, right: -8, bottom: 4 }}>
                  <defs>
                    <linearGradient id={barGradientId} x1="0" y1="0" x2="0" y2="1">
                      <stop offset="8%" stopColor="var(--color-usd)" stopOpacity={0.92} />
                      <stop offset="94%" stopColor="var(--color-usd)" stopOpacity={0.52} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid vertical={false} strokeDasharray="4 4" strokeOpacity={0.3} />
                  <XAxis dataKey="dateLabel" tickLine={false} axisLine={false} tickMargin={8} minTickGap={24} interval="preserveStartEnd" />
                  <YAxis hide />
                  <ChartTooltip content={<ChartTooltipContent indicator="line" />} cursor={{ fill: "var(--muted)", opacity: 0.2 }} />
                  <Bar
                    dataKey="usd"
                    fill={`url(#${barGradientId})`}
                    radius={[4, 4, 0, 0]}
                    maxBarSize={12}
                    minPointSize={2}
                  />
                </BarChart>
              </ChartContainer>
            ) : (
              <EmptyState>No ledger spend for this agent in this month.</EmptyState>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function formatDate(value: string | null) {
  if (!value) {
    return "Not set";
  }
  return new Date(value).toLocaleDateString();
}

function shortId(value: string) {
  return value.length > 12 ? `${value.slice(0, 8)}...` : value;
}

function formatDuration(startedAt: string, finishedAt?: string | null) {
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

function formatRunTypeLabel(runType: HeartbeatRunRow["runType"] | "all" | "exclude_no_assigned_work") {
  if (runType === "all") {
    return "All run types";
  }
  if (runType === "exclude_no_assigned_work") {
    return "All relevant";
  }
  if (runType === "no_assigned_work") {
    return "No assigned work";
  }
  return runType.replaceAll("_", " ");
}

function formatApprovalActionLabel(action: string) {
  return action.replaceAll("_", " ");
}

function formatAttentionCategoryLabel(category: AttentionRow["category"]) {
  return category.replaceAll("_", " ");
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
  const apiErrorMatch = candidate.match(/^API\s+Error:?\s*(\d{3})?\s*([\s\S]*)$/i);
  const apiStatusCode = apiErrorMatch?.[1] ?? null;
  const apiPayloadCandidate = apiErrorMatch?.[2]?.trim() ?? null;
  const jsonCandidate = apiPayloadCandidate && apiPayloadCandidate.startsWith("{") ? apiPayloadCandidate : candidate;

  try {
    const parsed = JSON.parse(jsonCandidate) as {
      summary?: unknown;
      message?: unknown;
      type?: unknown;
      error?: { type?: unknown; message?: unknown } | unknown;
    };
    const parsedError =
      parsed.error && typeof parsed.error === "object" && !Array.isArray(parsed.error)
        ? (parsed.error as { type?: unknown; message?: unknown })
        : null;
    const messageText =
      typeof parsed.summary === "string" && parsed.summary.trim()
        ? parsed.summary.trim()
        : typeof parsed.message === "string" && parsed.message.trim()
          ? parsed.message.trim()
          : typeof parsedError?.message === "string" && parsedError.message.trim()
            ? parsedError.message.trim()
            : null;
    if (apiStatusCode) {
      if (messageText) {
        return `API error ${apiStatusCode}: ${messageText}`;
      }
      return `API error ${apiStatusCode}`;
    }
    if (typeof parsedError?.type === "string" && parsedError.type.trim() && messageText) {
      return `${parsedError.type.trim().replaceAll("_", " ")}: ${messageText}`;
    }
    if (typeof parsed.type === "string" && parsed.type.trim() && messageText) {
      return `${parsed.type.trim().replaceAll("_", " ")}: ${messageText}`;
    }
    if (messageText) {
      return messageText;
    }
  } catch {
    if (apiStatusCode) {
      const compactPayload = (apiPayloadCandidate ?? "").replace(/\s+/g, " ").trim();
      if (compactPayload) {
        return `API error ${apiStatusCode}: ${compactPayload}`;
      }
      return `API error ${apiStatusCode}`;
    }
    const summaryMatch = candidate.match(/"summary"\s*:\s*"([^"]+)"/i);
    if (summaryMatch?.[1]?.trim()) {
      return summaryMatch[1].trim();
    }
  }

  return candidate.replace(/\s+/g, " ").trim();
}

function formatAttentionContextSummary(contextSummary: string, maxLength = 120) {
  const normalized = contextSummary.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "Review details and take action.";
  }
  const firstSentenceMatch = normalized.match(/^(.+?[.!?])(?:\s|$)/);
  const focused = (firstSentenceMatch?.[1] ?? normalized).trim();
  if (focused.length <= maxLength) {
    return focused;
  }
  return `${focused.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

export function WorkspaceClient({
  activeNav,
  companyId,
  activeCompany,
  companies,
  issues,
  agents,
  heartbeatRuns,
  goals,
  approvals,
  governanceInbox = [],
  attentionItems = [],
  auditEvents,
  costEntries,
  projects,
  plugins = [],
  templates = []
}: {
  activeNav: SectionLabel;
  companyId: string | null;
  activeCompany: CompanyRow | null;
  companies: CompanyRow[];
  issues: IssueRow[];
  agents: AgentRow[];
  heartbeatRuns: HeartbeatRunRow[];
  goals: GoalRow[];
  approvals: ApprovalRow[];
  governanceInbox?: GovernanceInboxRow[];
  attentionItems?: AttentionRow[];
  auditEvents: AuditRow[];
  costEntries: CostRow[];
  projects: ProjectRow[];
  plugins?: PluginRow[];
  templates?: TemplateRow[];
}) {
  const router = useRouter();
  const [actionError, setActionError] = useState<string | null>(null);
  const [pluginActionNotice, setPluginActionNotice] = useState<{ kind: "success" | "error"; message: string } | null>(null);
  const [pendingActionKeys, setPendingActionKeys] = useState<Record<string, boolean>>({});
  const [runsStatusFilter, setRunsStatusFilter] = useState<string>("all");
  const [runsAgentFilter, setRunsAgentFilter] = useState<string>("all");
  const [runsTypeFilter, setRunsTypeFilter] = useState<
    "all" | "exclude_no_assigned_work" | HeartbeatRunRow["runType"]
  >("exclude_no_assigned_work");
  const [runsWindowFilter, setRunsWindowFilter] = useState<"today" | "7d" | "30d" | "90d" | "all">("30d");
  const [runsQuery, setRunsQuery] = useState("");
  const [traceEventFilter, setTraceEventFilter] = useState<string>("all");
  const [traceEntityFilter, setTraceEntityFilter] = useState<string>("all");
  const [traceWindowFilter, setTraceWindowFilter] = useState<"today" | "7d" | "30d" | "90d" | "all">("30d");
  const [traceQuery, setTraceQuery] = useState("");
  const [governanceStatusFilter, setGovernanceStatusFilter] = useState<string>("all");
  const [governanceActionFilter, setGovernanceActionFilter] = useState<string>("all");
  const [governanceWindowFilter, setGovernanceWindowFilter] = useState<"today" | "7d" | "30d" | "90d" | "all">("30d");
  const [governanceQuery, setGovernanceQuery] = useState("");
  const [goalsStatusFilter, setGoalsStatusFilter] = useState<string>("all");
  const [goalsLevelFilter, setGoalsLevelFilter] = useState<string>("all");
  const [goalsParentFilter, setGoalsParentFilter] = useState<string>("all");
  const [goalsQuery, setGoalsQuery] = useState("");
  const [projectsQuery, setProjectsQuery] = useState("");
  const [projectsActivityFilter, setProjectsActivityFilter] = useState<"all" | "active" | "no_open_issues" | "no_issues">("all");
  const [agentsStatusFilter, setAgentsStatusFilter] = useState<string>("all");
  const [agentsProviderFilter, setAgentsProviderFilter] = useState<string>("all");
  const [agentsReportToFilter, setAgentsReportToFilter] = useState<string>("all");
  const [agentsModelFilter, setAgentsModelFilter] = useState<string>("all");
  const [agentsQuery, setAgentsQuery] = useState("");
  const [agentsViewMode, setAgentsViewMode] = useState<"table" | "cards" | "structure">("table");
  const [agentsMobileFiltersOpen, setAgentsMobileFiltersOpen] = useState(false);
  const [inboxQuery, setInboxQuery] = useState("");
  const [inboxStateFilter, setInboxStateFilter] = useState<"all" | "pending" | "resolved">("all");
  const [inboxSeenFilter, setInboxSeenFilter] = useState<"all" | "seen" | "unseen">("all");
  const [inboxDismissedFilter, setInboxDismissedFilter] = useState<"all" | "active" | "dismissed">("all");
  const [attentionSeverityFilter, setAttentionSeverityFilter] = useState<"all" | "critical" | "warning" | "info">("all");
  const [attentionStateFilter, setAttentionStateFilter] = useState<"all" | "open" | "acknowledged" | "dismissed" | "resolved">("open");
  const [attentionCategoryFilter, setAttentionCategoryFilter] = useState<"all" | AttentionRow["category"]>("all");
  const [attentionActorFilter, setAttentionActorFilter] = useState<"all" | AttentionRow["requiredActor"]>("all");
  const [attentionOverdueFilter, setAttentionOverdueFilter] = useState<"all" | "overdue" | "on_track">("all");
  const [selectedAttentionItem, setSelectedAttentionItem] = useState<AttentionRow | null>(null);
  const [attentionDetailsOpen, setAttentionDetailsOpen] = useState(false);
  const [attentionPayloadExpanded, setAttentionPayloadExpanded] = useState(false);
  const [pluginsQuery, setPluginsQuery] = useState("");
  const [pluginsStatusFilter, setPluginsStatusFilter] = useState<"all" | "active" | "installed" | "not_installed">("all");
  const [pluginsKindFilter, setPluginsKindFilter] = useState<string>("all");
  const [templatesQuery, setTemplatesQuery] = useState("");
  const [templatesStatusFilter, setTemplatesStatusFilter] = useState<"all" | TemplateRow["status"]>("all");
  const [templatesVisibilityFilter, setTemplatesVisibilityFilter] = useState<"all" | TemplateRow["visibility"]>("all");
  const [selectedTemplate, setSelectedTemplate] = useState<TemplateRow | null>(null);
  const [templateDetailsOpen, setTemplateDetailsOpen] = useState(false);
  const [installPluginDialogOpen, setInstallPluginDialogOpen] = useState(false);
  const [pluginPackageName, setPluginPackageName] = useState("");
  const [pluginPackageVersion, setPluginPackageVersion] = useState("");
  const [modelPricing, setModelPricing] = useState<ModelPricingRow[]>([]);
  const [modelProviderFilter, setModelProviderFilter] = useState<string>("all");
  const [modelQuery, setModelQuery] = useState("");
  const [modelDialogOpen, setModelDialogOpen] = useState(false);
  const [modelDialogValue, setModelDialogValue] = useState<{
    providerType: string;
    modelId: string;
    inputUsdPer1M: string;
    outputUsdPer1M: string;
  } | null>(null);
  const searchParams = useSearchParams();
  const appliedInboxPresetRef = useRef<string>("");
  const ceoAgent = useMemo(
    () => agents.find((entry) => entry.roleKey === "ceo" || entry.name === "CEO") ?? null,
    [agents]
  );
  const [hiringDelegate, setHiringDelegate] = useState<{
    agentId: string;
    name: string;
    role: string;
    roleKey?: AgentRoleKey | null;
  } | null>(null);
  useEffect(() => {
    if (!pluginActionNotice) {
      return;
    }
    const timer = setTimeout(() => {
      setPluginActionNotice(null);
    }, 2000);
    return () => {
      clearTimeout(timer);
    };
  }, [pluginActionNotice]);
  useEffect(() => {
    if (!companyId) {
      setHiringDelegate(null);
      return;
    }
    let cancelled = false;
    void apiGet<{
      delegate: { agentId: string; name: string; role: string; roleKey?: AgentRoleKey | null } | null;
    }>("/agents/hiring-delegate", companyId)
      .then((result) => {
        if (cancelled) {
          return;
        }
        setHiringDelegate(result.data.delegate ?? null);
      })
      .catch(() => {
        if (cancelled) {
          return;
        }
        setHiringDelegate(null);
      });
    return () => {
      cancelled = true;
    };
  }, [companyId]);
  const onboardingRuntimeFallback = useMemo(() => {
    if (!ceoAgent || !isRuntimeDefaultsProviderType(ceoAgent.providerType)) {
      return undefined;
    }
    return {
      providerType: ceoAgent.providerType,
      runtimeModel: ceoAgent.runtimeModel ?? parseRuntimeModelFromStateBlob(ceoAgent.stateBlob)
    };
  }, [ceoAgent]);
  const deleteCompanyDetails = useMemo(
    () =>
      [
        "This action permanently deletes:",
        `- Company: ${activeCompany?.name ?? "Current company"}`,
        `- Projects: ${projects.length}`,
        `- Goals: ${goals.length}`,
        `- Agents: ${agents.length}`,
        `- Issues: ${issues.length}`,
        `- Approval records: ${approvals.length}`,
        `- Governance inbox items: ${governanceInbox.length}`,
        `- Board attention items: ${attentionItems.length}`,
        `- Audit events: ${auditEvents.length}`,
        `- Heartbeat runs: ${heartbeatRuns.length}`,
        `- Cost ledger entries: ${costEntries.length}`,
        `- Plugins: ${plugins.length}`,
        `- Templates: ${templates.length}`,
        "",
        "This cannot be undone."
      ].join("\n"),
    [
      activeCompany?.name,
      projects.length,
      goals.length,
      agents.length,
      issues.length,
      approvals.length,
      governanceInbox.length,
      attentionItems.length,
      auditEvents.length,
      heartbeatRuns.length,
      costEntries.length,
      plugins.length,
      templates.length
    ]
  );
  const isDashboardNav = activeNav === "Dashboard";
  const isProjectsNav = activeNav === "Projects";
  const isGoalsNav = activeNav === "Goals";
  const isAgentsNav = activeNav === "Agents";
  const isInboxNav = activeNav === "Inbox";
  const isGovernanceNav = false;
  const isLogsNav = activeNav === "Logs";
  const isRunsNav = activeNav === "Runs";
  const isCostsNav = activeNav === "Costs";
  const isPluginsNav = activeNav === "Plugins";
  const isModelsNav = activeNav === "Models";
  const isTemplatesNav = activeNav === "Templates";
  const includeCostAggregations = isCostsNav || isDashboardNav;

  useEffect(() => {
    if (!isInboxNav) {
      return;
    }
    const querySignature = searchParams.toString();
    if (appliedInboxPresetRef.current === querySignature) {
      return;
    }
    appliedInboxPresetRef.current = querySignature;

    const preset = searchParams.get("preset");
    if (preset === "board-decisions") {
      setAttentionCategoryFilter("approval_required");
      setAttentionStateFilter("open");
      setAttentionActorFilter("board");
      setInboxDismissedFilter("active");
      return;
    }

    const category = searchParams.get("category");
    if (category === "approval_required" || category === "blocker_escalation" || category === "budget_hard_stop" || category === "stalled_work" || category === "run_failure_spike" || category === "board_mentioned_comment") {
      setAttentionCategoryFilter(category);
    } else if (category === "all") {
      setAttentionCategoryFilter("all");
    }

    const severity = searchParams.get("severity");
    if (severity === "critical" || severity === "warning" || severity === "info") {
      setAttentionSeverityFilter(severity);
    } else if (severity === "all") {
      setAttentionSeverityFilter("all");
    }

    const state = searchParams.get("state");
    if (state === "open" || state === "acknowledged" || state === "dismissed" || state === "resolved" || state === "all") {
      setAttentionStateFilter(state);
    }

    const requiredActor = searchParams.get("requiredActor");
    if (requiredActor === "board" || requiredActor === "member" || requiredActor === "agent" || requiredActor === "system") {
      setAttentionActorFilter(requiredActor);
    } else if (requiredActor === "all") {
      setAttentionActorFilter("all");
    }

    const overdue = searchParams.get("overdue");
    if (overdue === "overdue" || overdue === "on_track" || overdue === "all") {
      setAttentionOverdueFilter(overdue);
    }

    const seen = searchParams.get("seen");
    if (seen === "all" || seen === "seen" || seen === "unseen") {
      setInboxSeenFilter(seen);
    }

    const dismissed = searchParams.get("dismissed");
    if (dismissed === "all" || dismissed === "active" || dismissed === "dismissed") {
      setInboxDismissedFilter(dismissed);
    }
  }, [isInboxNav, searchParams]);

  const isActionPending = useCallback(
    (actionKey: string) => pendingActionKeys[actionKey] === true,
    [pendingActionKeys]
  );

  async function runCrudAction(
    action: () => Promise<void>,
    fallbackMessage: string,
    actionKey?: string,
    options?: { refresh?: boolean }
  ) {
    setActionError(null);
    if (!companyId) {
      setActionError("Create or select a company first.");
      return;
    }
    if (actionKey && isActionPending(actionKey)) {
      return;
    }
    if (actionKey) {
      setPendingActionKeys((prev) => ({ ...prev, [actionKey]: true }));
    }
    try {
      await action();
      if (options?.refresh !== false) {
        router.refresh();
      }
    } catch (error) {
      if (error instanceof ApiError) {
        setActionError(error.message);
      } else {
        setActionError(fallbackMessage);
      }
    } finally {
      if (actionKey) {
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
  }

  async function updateGoalStatus(goalId: string, status: string) {
    await runCrudAction(async () => {
      await apiPut(`/goals/${goalId}`, companyId!, { status });
    }, "Failed to update goal status.");
  }

  async function removeCompany(company: CompanyRow) {
    if (company.id === companyId) {
      setActionError("Cannot delete the active company.");
      return;
    }
    await runCrudAction(async () => {
      await apiDelete(`/companies/${company.id}`, companyId!);
    }, "Failed to delete company.", `company:${company.id}:delete`);
  }

  async function removeActiveCompanyFromSettings() {
    if (!activeCompany || !companyId) {
      setActionError("Create or select a company first.");
      return;
    }
    const fallbackCompany = companies.find((entry) => entry.id !== activeCompany.id) ?? null;
    const fallbackHref = fallbackCompany
      ? (`/settings?companyId=${encodeURIComponent(fallbackCompany.id)}` as Route)
      : ("/settings" as Route);
    await runCrudAction(
      async () => {
        await apiDelete(`/companies/${activeCompany.id}`, companyId);
        router.push(fallbackHref);
      },
      "Failed to delete company.",
      `company:${activeCompany.id}:delete:active`,
      { refresh: false }
    );
  }

  async function resolveApproval(approvalId: string, status: "approved" | "rejected" | "overridden") {
    await runCrudAction(async () => {
      await apiPost("/governance/resolve", companyId!, { approvalId, status });
    }, "Failed to resolve approval.", `approval:${approvalId}:resolve`);
  }

  async function markInboxSeen(approvalId: string) {
    await runCrudAction(async () => {
      await apiPost(`/governance/inbox/${approvalId}/seen`, companyId!, {});
    }, "Failed to mark inbox item as seen.", `inbox:${approvalId}:seen`);
  }

  async function dismissInboxItem(approvalId: string) {
    await runCrudAction(async () => {
      await apiPost(`/governance/inbox/${approvalId}/dismiss`, companyId!, {});
    }, "Failed to dismiss inbox item.", `inbox:${approvalId}:dismiss`);
  }

  async function undismissInboxItem(approvalId: string) {
    await runCrudAction(async () => {
      await apiPost(`/governance/inbox/${approvalId}/undismiss`, companyId!, {});
    }, "Failed to restore inbox item.", `inbox:${approvalId}:undismiss`);
  }

  async function dismissAttention(itemKey: string) {
    await runCrudAction(async () => {
      await apiPost(`/attention/${encodeURIComponent(itemKey)}/dismiss`, companyId!, {});
    }, "Failed to dismiss attention item.", `attention:${itemKey}:dismiss`);
  }

  async function deletePlugin(pluginId: string) {
    await runCrudAction(async () => {
      await apiDelete(`/plugins/${pluginId}`, companyId!);
    }, "Failed to delete plugin.", `plugin:${pluginId}:delete`);
  }

  async function setPluginEnabled(plugin: PluginRow, enabled: boolean) {
    await runCrudAction(async () => {
      await apiPut(`/plugins/${plugin.id}`, companyId!, {
        enabled,
        priority: plugin.companyConfig?.priority ?? 100,
        grantedCapabilities: plugin.companyConfig?.grantedCapabilities ?? [],
        config: plugin.companyConfig?.config ?? {},
        requestApproval: false
      });
    }, `Failed to ${enabled ? "activate" : "deactivate"} plugin.`, `plugin:${plugin.id}:${enabled ? "activate" : "deactivate"}`);
  }

  async function checkPluginHealth(pluginId: string) {
    setActionError(null);
    setPluginActionNotice(null);
    if (!companyId) {
      setPluginActionNotice({ kind: "error", message: "Create or select a company first." });
      return;
    }
    const actionKey = `plugin:${pluginId}:health`;
    if (isActionPending(actionKey)) {
      return;
    }
    setPendingActionKeys((prev) => ({ ...prev, [actionKey]: true }));
    try {
      const response = await apiGet<{ ok: boolean; data: unknown }>(`/plugins/${pluginId}/health`, companyId);
      const payload = response.data.data ?? response.data;
      const message =
        typeof payload === "object" &&
        payload !== null &&
        "status" in (payload as Record<string, unknown>) &&
        String((payload as Record<string, unknown>).status) === "ok"
          ? "Plugin is healthy."
          : "Health check completed.";
      setPluginActionNotice({ kind: "success", message });
    } catch (error) {
      setPluginActionNotice({
        kind: "error",
        message: error instanceof ApiError ? error.message : "Failed to fetch plugin health."
      });
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

  async function rollbackPlugin(pluginId: string) {
    setActionError(null);
    setPluginActionNotice(null);
    if (!companyId) {
      setPluginActionNotice({ kind: "error", message: "Create or select a company first." });
      return;
    }
    const actionKey = `plugin:${pluginId}:rollback`;
    if (isActionPending(actionKey)) {
      return;
    }
    setPendingActionKeys((prev) => ({ ...prev, [actionKey]: true }));
    try {
      const installs = await apiGet<Array<{ id: string }>>(`/plugins/${pluginId}/installs?limit=2`, companyId);
      const rows = installs.data ?? [];
      if (rows.length < 2) {
        throw new Error(
          "Rollback needs at least two recorded installs for this plugin (for example, upgrade the same package twice from the registry). Filesystem-only plugins have no install history yet."
        );
      }
      await apiPost(`/plugins/${pluginId}/rollback`, companyId, {
        installId: rows[1]?.id
      });
      setPluginActionNotice({ kind: "success", message: "Plugin rolled back." });
      router.refresh();
    } catch (error) {
      setPluginActionNotice({
        kind: "error",
        message:
          error instanceof ApiError
            ? error.message
            : error instanceof Error
              ? error.message
              : "Failed to rollback plugin."
      });
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

  async function applyTemplate(templateId: string) {
    await runCrudAction(async () => {
      await apiPost(`/templates/${templateId}/apply`, companyId!, {
        requestApproval: false,
        variables: {}
      });
    }, "Failed to apply template.", `template:${templateId}:apply`);
  }

  function openTemplateDetails(template: TemplateRow) {
    setSelectedTemplate(template);
    setTemplateDetailsOpen(true);
  }

  function openCreatePluginDialog() {
    setPluginPackageName("");
    setPluginPackageVersion("");
    setInstallPluginDialogOpen(true);
  }

  async function stopHeartbeatRunById(runId: string) {
    await runCrudAction(async () => {
      await apiPost(`/heartbeats/${runId}/stop`, companyId!, {});
    }, "Failed to stop heartbeat run.", `run:${runId}:stop`);
  }

  async function resumeHeartbeatRunById(runId: string) {
    await runCrudAction(async () => {
      await apiPost(`/heartbeats/${runId}/resume`, companyId!, {});
    }, "Failed to resume run.", `run:${runId}:resume`);
  }

  async function redoHeartbeatRunById(runId: string) {
    await runCrudAction(async () => {
      await apiPost(`/heartbeats/${runId}/redo`, companyId!, {});
    }, "Failed to redo run.", `run:${runId}:redo`);
  }

  const pendingApprovals = useMemo(
    () => (isDashboardNav ? approvals.filter((approval) => approval.status === "pending") : []),
    [approvals, isDashboardNav]
  );
  const approvalById = useMemo(() => new Map(approvals.map((approval) => [approval.id, approval])), [approvals]);
  const selectedAttentionApproval = useMemo(() => {
    const approvalId = selectedAttentionItem?.evidence.approvalId;
    if (!approvalId) {
      return null;
    }
    return approvalById.get(approvalId) ?? null;
  }, [approvalById, selectedAttentionItem]);
  const selectedAttentionHasPendingApproval = selectedAttentionApproval?.status === "pending";
  const pendingApprovalsCount = useMemo(
    () =>
      attentionItems.reduce(
        (count, item) =>
          count +
          (item.category === "approval_required" && (item.state === "open" || item.state === "acknowledged") ? 1 : 0),
        0
      ),
    [attentionItems]
  );
  const isAttentionOverdue = useCallback((item: AttentionRow) => {
    if (item.state === "resolved" || item.state === "dismissed") {
      return false;
    }
    const ageMs = Date.now() - new Date(item.sourceTimestamp).getTime();
    if (item.severity === "critical") {
      return ageMs >= 6 * 60 * 60 * 1000;
    }
    if (item.category === "approval_required") {
      return ageMs >= 12 * 60 * 60 * 1000;
    }
    return ageMs >= 24 * 60 * 60 * 1000;
  }, []);
  const sortedInboxItems = useMemo(
    () => {
      if (!isInboxNav) {
        return [];
      }
      return [...governanceInbox].sort((a, b) => {
        if (a.isPending !== b.isPending) {
          return a.isPending ? -1 : 1;
        }
        const aTimestamp = a.isPending ? a.approval.createdAt : (a.approval.resolvedAt ?? a.approval.createdAt);
        const bTimestamp = b.isPending ? b.approval.createdAt : (b.approval.resolvedAt ?? b.approval.createdAt);
        return new Date(bTimestamp).getTime() - new Date(aTimestamp).getTime();
      });
    },
    [governanceInbox, isInboxNav]
  );
  const filteredInboxItems = useMemo(() => {
    if (!isInboxNav) {
      return [];
    }
    const normalizedQuery = inboxQuery.trim().toLowerCase();
    return sortedInboxItems.filter((item) => {
      if (inboxStateFilter === "pending" && !item.isPending) {
        return false;
      }
      if (inboxStateFilter === "resolved" && item.isPending) {
        return false;
      }
      if (inboxSeenFilter === "seen" && !item.seenAt) {
        return false;
      }
      if (inboxSeenFilter === "unseen" && item.seenAt) {
        return false;
      }
      if (inboxDismissedFilter === "active" && item.dismissedAt) {
        return false;
      }
      if (inboxDismissedFilter === "dismissed" && !item.dismissedAt) {
        return false;
      }
      if (!normalizedQuery) {
        return true;
      }
      const payloadText = JSON.stringify(item.approval.payload ?? {}).toLowerCase();
      return (
        item.approval.action.toLowerCase().includes(normalizedQuery) ||
        item.approval.status.toLowerCase().includes(normalizedQuery) ||
        payloadText.includes(normalizedQuery)
      );
    });
  }, [inboxDismissedFilter, inboxQuery, inboxSeenFilter, inboxStateFilter, isInboxNav, sortedInboxItems]);
  const inboxSummary = useMemo(() => {
    const total = governanceInbox.length;
    const pending = governanceInbox.filter((item) => item.isPending).length;
    const resolved = total - pending;
    const dismissed = governanceInbox.filter((item) => item.dismissedAt).length;
    const unseen = governanceInbox.filter((item) => !item.seenAt).length;
    return { total, pending, resolved, dismissed, unseen };
  }, [governanceInbox]);
  const sortedAttentionItems = useMemo(() => {
    if (!isInboxNav) {
      return [];
    }
    return [...attentionItems].sort((a, b) => {
      const stateRank = (state: AttentionRow["state"]) =>
        state === "open" ? 0 : state === "acknowledged" ? 1 : state === "dismissed" ? 2 : 3;
      const severityRank = (severity: AttentionRow["severity"]) =>
        severity === "critical" ? 0 : severity === "warning" ? 1 : 2;
      const byState = stateRank(a.state) - stateRank(b.state);
      if (byState !== 0) {
        return byState;
      }
      const bySeverity = severityRank(a.severity) - severityRank(b.severity);
      if (bySeverity !== 0) {
        return bySeverity;
      }
      return new Date(b.sourceTimestamp).getTime() - new Date(a.sourceTimestamp).getTime();
    });
  }, [attentionItems, isInboxNav]);
  const filteredAttentionItems = useMemo(() => {
    if (!isInboxNav) {
      return [];
    }
    const normalizedQuery = inboxQuery.trim().toLowerCase();
    return sortedAttentionItems.filter((item) => {
      if (attentionStateFilter !== "all" && item.state !== attentionStateFilter) {
        return false;
      }
      if (attentionSeverityFilter !== "all" && item.severity !== attentionSeverityFilter) {
        return false;
      }
      if (attentionCategoryFilter !== "all" && item.category !== attentionCategoryFilter) {
        return false;
      }
      if (attentionActorFilter !== "all" && item.requiredActor !== attentionActorFilter) {
        return false;
      }
      if (attentionOverdueFilter === "overdue" && !isAttentionOverdue(item)) {
        return false;
      }
      if (attentionOverdueFilter === "on_track" && isAttentionOverdue(item)) {
        return false;
      }
      if (inboxSeenFilter === "seen" && !item.seenAt) {
        return false;
      }
      if (inboxSeenFilter === "unseen" && item.seenAt) {
        return false;
      }
      if (inboxDismissedFilter === "active" && item.state === "dismissed") {
        return false;
      }
      if (inboxDismissedFilter === "dismissed" && item.state !== "dismissed") {
        return false;
      }
      if (!normalizedQuery) {
        return true;
      }
      return (
        item.title.toLowerCase().includes(normalizedQuery) ||
        item.contextSummary.toLowerCase().includes(normalizedQuery) ||
        item.category.toLowerCase().includes(normalizedQuery) ||
        item.actionLabel.toLowerCase().includes(normalizedQuery)
      );
    });
  }, [
    attentionSeverityFilter,
    attentionStateFilter,
    attentionCategoryFilter,
    attentionActorFilter,
    attentionOverdueFilter,
    inboxDismissedFilter,
    inboxQuery,
    inboxSeenFilter,
    isAttentionOverdue,
    isInboxNav,
    sortedAttentionItems
  ]);
  const attentionSummary = useMemo(() => {
    const total = attentionItems.length;
    const open = attentionItems.filter((item) => item.state === "open" || item.state === "acknowledged").length;
    const critical = attentionItems.filter((item) => item.severity === "critical" && item.state !== "resolved").length;
    const unresolved = attentionItems.filter((item) => item.state === "open").length;
    const unresolvedWarnings = attentionItems.filter(
      (item) => item.severity === "warning" && (item.state === "open" || item.state === "acknowledged")
    ).length;
    return { total, open, critical, unresolved, unresolvedWarnings };
  }, [attentionItems]);
  const agentById = useMemo(() => new Map(agents.map((agent) => [agent.id, agent])), [agents]);
  const agentNameById = useMemo(() => new Map(agents.map((agent) => [agent.id, agent.name])), [agents]);
  const costMonthOptions = useMemo(() => {
    if (!includeCostAggregations) {
      return [];
    }
    const options = new Set<string>();
    for (const entry of costEntries) {
      options.add(monthKeyFromDate(entry.createdAt));
    }
    return Array.from(options)
      .filter((value) => value !== "unknown")
      .sort((a, b) => b.localeCompare(a));
  }, [costEntries, includeCostAggregations]);
  const [selectedCostMonth, setSelectedCostMonth] = useState<string>(() => costMonthOptions[0] ?? "all");
  const activeCostMonth = costMonthOptions.includes(selectedCostMonth) ? selectedCostMonth : (costMonthOptions[0] ?? "all");
  const filteredCostEntries = useMemo(
    () => {
      if (!includeCostAggregations) {
        return [];
      }
      return activeCostMonth === "all"
        ? costEntries
        : costEntries.filter((entry) => monthKeyFromDate(entry.createdAt) === activeCostMonth);
    },
    [activeCostMonth, costEntries, includeCostAggregations]
  );
  const costEntryProviderOptions = useMemo(() => {
    if (!includeCostAggregations) {
      return [];
    }
    const set = new Set<string>();
    for (const entry of filteredCostEntries) {
      set.add(entry.providerType);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [filteredCostEntries, includeCostAggregations]);
  const costEntryAgentOptions = useMemo(() => {
    if (!includeCostAggregations) {
      return [] as { id: string; name: string }[];
    }
    const ids = new Set<string>();
    for (const entry of filteredCostEntries) {
      if (entry.agentId) {
        ids.add(entry.agentId);
      }
    }
    return Array.from(ids)
      .map((id) => ({ id, name: agentNameById.get(id) ?? id }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [agentNameById, filteredCostEntries, includeCostAggregations]);
  const [costEntriesSearchQuery, setCostEntriesSearchQuery] = useState("");
  const [costEntriesProviderFilter, setCostEntriesProviderFilter] = useState("all");
  const [costEntriesAgentFilter, setCostEntriesAgentFilter] = useState("all");
  const [costEntriesScopeFilter, setCostEntriesScopeFilter] = useState<"all" | "agent" | "issue">("all");
  useEffect(() => {
    if (costEntriesProviderFilter !== "all" && !costEntryProviderOptions.includes(costEntriesProviderFilter)) {
      setCostEntriesProviderFilter("all");
    }
  }, [costEntriesProviderFilter, costEntryProviderOptions]);
  useEffect(() => {
    if (costEntriesAgentFilter !== "all" && !costEntryAgentOptions.some((row) => row.id === costEntriesAgentFilter)) {
      setCostEntriesAgentFilter("all");
    }
  }, [costEntriesAgentFilter, costEntryAgentOptions]);
  const costTableFilteredEntries = useMemo(() => {
    if (!includeCostAggregations) {
      return [];
    }
    const normalizedQuery = costEntriesSearchQuery.trim().toLowerCase();
    return filteredCostEntries.filter((entry) => {
      if (costEntriesProviderFilter !== "all" && entry.providerType !== costEntriesProviderFilter) {
        return false;
      }
      if (costEntriesAgentFilter !== "all" && entry.agentId !== costEntriesAgentFilter) {
        return false;
      }
      if (costEntriesScopeFilter === "agent" && !entry.agentId) {
        return false;
      }
      if (costEntriesScopeFilter === "issue" && !entry.issueId) {
        return false;
      }
      if (!normalizedQuery) {
        return true;
      }
      const model = (entry.runtimeModelId ?? entry.pricingModelId ?? "").toLowerCase();
      const category = (entry.costCategory ?? "").toLowerCase();
      return (
        entry.providerType.toLowerCase().includes(normalizedQuery) ||
        model.includes(normalizedQuery) ||
        category.includes(normalizedQuery) ||
        (entry.assistantThreadId?.toLowerCase().includes(normalizedQuery) ?? false) ||
        (entry.agentId?.toLowerCase().includes(normalizedQuery) ?? false) ||
        (entry.issueId?.toLowerCase().includes(normalizedQuery) ?? false) ||
        entry.id.toLowerCase().includes(normalizedQuery)
      );
    });
  }, [
    costEntriesAgentFilter,
    costEntriesProviderFilter,
    costEntriesScopeFilter,
    costEntriesSearchQuery,
    filteredCostEntries,
    includeCostAggregations
  ]);
  const todayCostEntries = useMemo(() => {
    if (!includeCostAggregations) {
      return [];
    }
    const now = new Date();
    return costEntries.filter((entry) => {
      const createdAt = new Date(entry.createdAt);
      return (
        createdAt.getFullYear() === now.getFullYear() &&
        createdAt.getMonth() === now.getMonth() &&
        createdAt.getDate() === now.getDate()
      );
    });
  }, [costEntries, includeCostAggregations]);
  const todayCostSummary = useMemo(() => summarizeCosts(todayCostEntries), [todayCostEntries]);
  const selectedMonthSummary = useMemo(() => summarizeCosts(filteredCostEntries), [filteredCostEntries]);
  const previousMonthSummary = useMemo(() => {
    if (!includeCostAggregations) {
      return { input: 0, output: 0, usd: 0 };
    }
    const match = activeCostMonth.match(/^(\d{4})-(\d{2})$/);
    if (activeCostMonth === "all" || !match) {
      return { input: 0, output: 0, usd: 0 };
    }
    const year = Number(match[1]);
    const month = Number(match[2]);
    const previous = new Date(year, month - 2, 1);
    const previousMonthKey = `${previous.getFullYear()}-${String(previous.getMonth() + 1).padStart(2, "0")}`;
    const previousEntries = costEntries.filter((entry) => monthKeyFromDate(entry.createdAt) === previousMonthKey);
    return summarizeCosts(previousEntries);
  }, [activeCostMonth, costEntries, includeCostAggregations]);
  const selectedMonthLabel = activeCostMonth === "all" ? "All time" : formatMonthLabel(activeCostMonth);
  const selectedMonthChartData = useMemo(() => {
    if (!includeCostAggregations) {
      return [];
    }
    const targetMonth = activeCostMonth === "all" ? costMonthOptions[0] : activeCostMonth;
    const match = targetMonth?.match(/^(\d{4})-(\d{2})$/);
    if (!match) {
      return [];
    }
    const year = Number(match[1]);
    const month = Number(match[2]);
    const daysInMonth = new Date(year, month, 0).getDate();
    const byDay = new Map<number, { usd: number; inputTokens: number; outputTokens: number }>();
    for (let day = 1; day <= daysInMonth; day += 1) {
      byDay.set(day, { usd: 0, inputTokens: 0, outputTokens: 0 });
    }
    for (const entry of costEntries) {
      if (monthKeyFromDate(entry.createdAt) !== targetMonth) {
        continue;
      }
      const day = new Date(entry.createdAt).getDate();
      const current = byDay.get(day);
      if (!current) {
        continue;
      }
      current.usd += entry.usdCost;
      current.inputTokens += entry.tokenInput;
      current.outputTokens += entry.tokenOutput;
    }
    const dailySeries = Array.from(byDay.entries()).map(([day, values]) => ({
      label: String(day).padStart(2, "0"),
      usd: values.usd,
      inputTokens: values.inputTokens,
      outputTokens: values.outputTokens,
      tokens: values.inputTokens + values.outputTokens
    }));
    let cumulativeUsd = 0;
    return dailySeries.map((entry) => {
      cumulativeUsd += entry.usd;
      return {
        ...entry,
        cumulativeUsd
      };
    });
  }, [activeCostMonth, costEntries, costMonthOptions, includeCostAggregations]);
  const monthlyCostChartData = useMemo(() => {
    if (!includeCostAggregations) {
      return [];
    }
    const byMonth = new Map<string, { usd: number; tokens: number }>();
    for (const entry of costEntries) {
      const month = monthKeyFromDate(entry.createdAt);
      if (month === "unknown") {
        continue;
      }
      const current = byMonth.get(month) ?? { usd: 0, tokens: 0 };
      current.usd += entry.usdCost;
      current.tokens += entry.tokenInput + entry.tokenOutput;
      byMonth.set(month, current);
    }
    const sortedMonths = Array.from(byMonth.keys()).sort((a, b) => a.localeCompare(b));
    let windowMonths: string[];
    if (activeCostMonth === "all") {
      windowMonths = sortedMonths.slice(-6);
    } else {
      const idx = sortedMonths.indexOf(activeCostMonth);
      if (idx === -1) {
        windowMonths = [activeCostMonth];
      } else {
        windowMonths = sortedMonths.slice(Math.max(0, idx - 5), idx + 1);
      }
    }
    return windowMonths.map((month) => {
      const value = byMonth.get(month) ?? { usd: 0, tokens: 0 };
      return {
        label: month.slice(2),
        usd: value.usd,
        tokens: value.tokens
      };
    });
  }, [activeCostMonth, costEntries, includeCostAggregations]);
  const costDailyConfig = {
    usd: { label: "Daily spend", color: "var(--chart-2)" }
  } satisfies ChartConfig;
  const costTokenMixConfig = {
    inputTokens: { label: "Input tokens", color: "var(--chart-3)" },
    outputTokens: { label: "Output tokens", color: "var(--chart-4)" }
  } satisfies ChartConfig;
  const costCumulativeConfig = {
    cumulativeUsd: { label: "Cumulative USD", color: "var(--chart-5)" }
  } satisfies ChartConfig;
  const costMonthlyConfig = {
    usd: { label: "USD", color: "var(--chart-1)" }
  } satisfies ChartConfig;
  const hasCostTokenMixData = selectedMonthChartData.some((entry) => entry.inputTokens > 0 || entry.outputTokens > 0);
  const hasMonthlySpendData = monthlyCostChartData.some((entry) => entry.usd > 0);
  const costDailyTargetMonthKey = useMemo(() => {
    if (!includeCostAggregations) {
      return null;
    }
    if (activeCostMonth === "all") {
      return costMonthOptions[0] ?? null;
    }
    return costMonthOptions.includes(activeCostMonth) ? activeCostMonth : null;
  }, [activeCostMonth, costMonthOptions, includeCostAggregations]);

  const [assistantChatThreadStats, setAssistantChatThreadStats] = useState<Array<{ threadId: string; messageCount: number }>>(
    []
  );
  useEffect(() => {
    if (!includeCostAggregations || !companyId || !costDailyTargetMonthKey) {
      setAssistantChatThreadStats([]);
      return;
    }
    const range = localCalendarMonthUtcRange(costDailyTargetMonthKey);
    if (!range) {
      setAssistantChatThreadStats([]);
      return;
    }
    let cancelled = false;
    const qs = `from=${encodeURIComponent(range.fromIso)}&toExclusive=${encodeURIComponent(range.toExclusiveIso)}`;
    void apiGet<{ threads: Array<{ threadId: string; messageCount: number }> }>(
      `/observability/assistant-chat-threads?${qs}`,
      companyId
    )
      .then((res) => {
        if (!cancelled) {
          setAssistantChatThreadStats(Array.isArray(res.data.threads) ? res.data.threads : []);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setAssistantChatThreadStats([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [companyId, costDailyTargetMonthKey, includeCostAggregations]);

  const providerDailyChartMonthLabel = useMemo(() => {
    if (!costDailyTargetMonthKey) {
      return selectedMonthLabel;
    }
    return formatMonthLabel(costDailyTargetMonthKey);
  }, [costDailyTargetMonthKey, selectedMonthLabel]);
  const providerDailyCostBreakdown = useMemo(() => {
    if (!includeCostAggregations || !costDailyTargetMonthKey) {
      return [];
    }
    const match = costDailyTargetMonthKey.match(/^(\d{4})-(\d{2})$/);
    if (!match) {
      return [];
    }
    const year = Number(match[1]);
    const month = Number(match[2]);
    const daysInMonth = new Date(year, month, 0).getDate();
    const totals = new Map<string, { usd: number; tokens: number }>();
    for (const entry of costEntries) {
      if (monthKeyFromDate(entry.createdAt) !== costDailyTargetMonthKey) {
        continue;
      }
      const t = totals.get(entry.providerType) ?? { usd: 0, tokens: 0 };
      t.usd += entry.usdCost;
      t.tokens += entry.tokenInput + entry.tokenOutput;
      totals.set(entry.providerType, t);
    }
    const providers = Array.from(totals.entries()).sort((a, b) => b[1].usd - a[1].usd || a[0].localeCompare(b[0]));
    return providers.map(([providerType]) => {
      const byDay = new Map<number, { usd: number; inputTokens: number; outputTokens: number }>();
      for (let day = 1; day <= daysInMonth; day += 1) {
        byDay.set(day, { usd: 0, inputTokens: 0, outputTokens: 0 });
      }
      for (const entry of costEntries) {
        if (monthKeyFromDate(entry.createdAt) !== costDailyTargetMonthKey) {
          continue;
        }
        if (entry.providerType !== providerType) {
          continue;
        }
        const day = new Date(entry.createdAt).getDate();
        const current = byDay.get(day);
        if (!current) {
          continue;
        }
        current.usd += entry.usdCost;
        current.inputTokens += entry.tokenInput;
        current.outputTokens += entry.tokenOutput;
      }
      const agg = totals.get(providerType)!;
      const daily: CostDailyChartRow[] = [];
      for (let day = 1; day <= daysInMonth; day += 1) {
        const v = byDay.get(day)!;
        const d = new Date(year, month - 1, day);
        daily.push({
          day,
          label: String(day).padStart(2, "0"),
          dateLabel: d.toLocaleString(undefined, { month: "short", day: "numeric" }),
          usd: v.usd,
          inputTokens: v.inputTokens,
          outputTokens: v.outputTokens,
          tokens: v.inputTokens + v.outputTokens
        });
      }
      return {
        providerType,
        daily,
        totalUsd: agg.usd,
        totalTokens: agg.tokens
      };
    });
  }, [costDailyTargetMonthKey, costEntries, includeCostAggregations]);
  const modelDailyCostBreakdown = useMemo(() => {
    if (!includeCostAggregations || !costDailyTargetMonthKey) {
      return [];
    }
    const match = costDailyTargetMonthKey.match(/^(\d{4})-(\d{2})$/);
    if (!match) {
      return [];
    }
    const year = Number(match[1]);
    const month = Number(match[2]);
    const daysInMonth = new Date(year, month, 0).getDate();
    const totals = new Map<string, { usd: number; tokens: number }>();
    for (const entry of costEntries) {
      if (monthKeyFromDate(entry.createdAt) !== costDailyTargetMonthKey) {
        continue;
      }
      const modelKey = costEntryModelKey(entry);
      const t = totals.get(modelKey) ?? { usd: 0, tokens: 0 };
      t.usd += entry.usdCost;
      t.tokens += entry.tokenInput + entry.tokenOutput;
      totals.set(modelKey, t);
    }
    const modelKeys = Array.from(totals.entries()).sort((a, b) => b[1].usd - a[1].usd || a[0].localeCompare(b[0]));
    return modelKeys.map(([modelKey]) => {
      const byDay = new Map<number, { usd: number; inputTokens: number; outputTokens: number }>();
      for (let day = 1; day <= daysInMonth; day += 1) {
        byDay.set(day, { usd: 0, inputTokens: 0, outputTokens: 0 });
      }
      for (const entry of costEntries) {
        if (monthKeyFromDate(entry.createdAt) !== costDailyTargetMonthKey) {
          continue;
        }
        if (costEntryModelKey(entry) !== modelKey) {
          continue;
        }
        const day = new Date(entry.createdAt).getDate();
        const current = byDay.get(day);
        if (!current) {
          continue;
        }
        current.usd += entry.usdCost;
        current.inputTokens += entry.tokenInput;
        current.outputTokens += entry.tokenOutput;
      }
      const agg = totals.get(modelKey)!;
      const daily: CostDailyChartRow[] = [];
      for (let day = 1; day <= daysInMonth; day += 1) {
        const v = byDay.get(day)!;
        const d = new Date(year, month - 1, day);
        daily.push({
          day,
          label: String(day).padStart(2, "0"),
          dateLabel: d.toLocaleString(undefined, { month: "short", day: "numeric" }),
          usd: v.usd,
          inputTokens: v.inputTokens,
          outputTokens: v.outputTokens,
          tokens: v.inputTokens + v.outputTokens
        });
      }
      return {
        modelKey,
        daily,
        totalUsd: agg.usd,
        totalTokens: agg.tokens
      };
    });
  }, [costDailyTargetMonthKey, costEntries, includeCostAggregations]);
  const agentCostBudgetBreakdown = useMemo(() => {
    if (!includeCostAggregations || !costDailyTargetMonthKey) {
      return [];
    }
    const match = costDailyTargetMonthKey.match(/^(\d{4})-(\d{2})$/);
    if (!match) {
      return [];
    }
    const year = Number(match[1]);
    const month = Number(match[2]);
    const daysInMonth = new Date(year, month, 0).getDate();
    const rows: Array<{
      agentId: string;
      agentName: string;
      monthlyBudgetUsd: number;
      usedBudgetUsd: number;
      ledgerUsdMonth: number;
      daily: CostDailyChartRow[];
    }> = [];
    for (const agent of agents) {
      const cap = agent.monthlyBudgetUsd ?? 0;
      const used = agent.usedBudgetUsd ?? 0;
      let ledgerUsdMonth = 0;
      for (const entry of costEntries) {
        if (entry.agentId !== agent.id) {
          continue;
        }
        if (monthKeyFromDate(entry.createdAt) !== costDailyTargetMonthKey) {
          continue;
        }
        ledgerUsdMonth += entry.usdCost;
      }
      if (cap <= 0 && used <= 0 && ledgerUsdMonth <= 0) {
        continue;
      }
      const byDay = new Map<number, { usd: number; inputTokens: number; outputTokens: number }>();
      for (let day = 1; day <= daysInMonth; day += 1) {
        byDay.set(day, { usd: 0, inputTokens: 0, outputTokens: 0 });
      }
      for (const entry of costEntries) {
        if (entry.agentId !== agent.id) {
          continue;
        }
        if (monthKeyFromDate(entry.createdAt) !== costDailyTargetMonthKey) {
          continue;
        }
        const day = new Date(entry.createdAt).getDate();
        const current = byDay.get(day);
        if (!current) {
          continue;
        }
        current.usd += entry.usdCost;
        current.inputTokens += entry.tokenInput;
        current.outputTokens += entry.tokenOutput;
      }
      const daily: CostDailyChartRow[] = [];
      for (let day = 1; day <= daysInMonth; day += 1) {
        const v = byDay.get(day)!;
        const d = new Date(year, month - 1, day);
        daily.push({
          day,
          label: String(day).padStart(2, "0"),
          dateLabel: d.toLocaleString(undefined, { month: "short", day: "numeric" }),
          usd: v.usd,
          inputTokens: v.inputTokens,
          outputTokens: v.outputTokens,
          tokens: v.inputTokens + v.outputTokens
        });
      }
      rows.push({
        agentId: agent.id,
        agentName: agent.name,
        monthlyBudgetUsd: cap,
        usedBudgetUsd: used,
        ledgerUsdMonth,
        daily
      });
    }
    return rows.sort((a, b) => b.ledgerUsdMonth - a.ledgerUsdMonth || a.agentName.localeCompare(b.agentName));
  }, [agents, costEntries, costDailyTargetMonthKey, includeCostAggregations]);

  /** Single combined owner-assistant ledger series for the Costs "By chats" tab (all threads in the month). */
  const ownerAssistantMonthlyChatsCost = useMemo(() => {
    if (!includeCostAggregations || !costDailyTargetMonthKey) {
      return null;
    }
    const match = costDailyTargetMonthKey.match(/^(\d{4})-(\d{2})$/);
    if (!match) {
      return null;
    }
    const year = Number(match[1]);
    const month = Number(match[2]);
    const daysInMonth = new Date(year, month, 0).getDate();
    const byDay = new Map<number, { usd: number; inputTokens: number; outputTokens: number }>();
    for (let day = 1; day <= daysInMonth; day += 1) {
      byDay.set(day, { usd: 0, inputTokens: 0, outputTokens: 0 });
    }
    const threadIdsWithLedger = new Set<string>();
    let totalUsd = 0;
    let totalTokens = 0;
    for (const entry of costEntries) {
      if (entry.costCategory !== "company_assistant" || !entry.assistantThreadId) {
        continue;
      }
      if (monthKeyFromDate(entry.createdAt) !== costDailyTargetMonthKey) {
        continue;
      }
      threadIdsWithLedger.add(entry.assistantThreadId);
      const usd = Number(entry.usdCost) || 0;
      const tin = Number(entry.tokenInput) || 0;
      const tout = Number(entry.tokenOutput) || 0;
      totalUsd += usd;
      totalTokens += tin + tout;
      const day = localCalendarDayInMonthKey(entry.createdAt, costDailyTargetMonthKey);
      if (day === null || day < 1 || day > daysInMonth) {
        continue;
      }
      const current = byDay.get(day);
      if (!current) {
        continue;
      }
      current.usd += usd;
      current.inputTokens += tin;
      current.outputTokens += tout;
    }
    const totalMessages = assistantChatThreadStats.reduce((acc, row) => acc + row.messageCount, 0);
    const threadIdsFromStats = new Set(assistantChatThreadStats.map((s) => s.threadId));
    const activeThreadCount = new Set([...threadIdsWithLedger, ...threadIdsFromStats]).size;
    const daily: CostDailyChartRow[] = [];
    for (let day = 1; day <= daysInMonth; day += 1) {
      const v = byDay.get(day)!;
      const d = new Date(year, month - 1, day);
      daily.push({
        day,
        label: String(day).padStart(2, "0"),
        dateLabel: d.toLocaleString(undefined, { month: "short", day: "numeric" }),
        usd: v.usd,
        inputTokens: v.inputTokens,
        outputTokens: v.outputTokens,
        tokens: v.inputTokens + v.outputTokens
      });
    }
    return {
      daily,
      totalUsd,
      totalTokens,
      totalMessages,
      activeThreadCount
    };
  }, [assistantChatThreadStats, costDailyTargetMonthKey, costEntries, includeCostAggregations]);

  const runDetailsByRunId = useMemo(() => {
    if (!isRunsNav) {
      return new Map<string, RunDetailsPayload>();
    }
    const details = new Map<string, RunDetailsPayload>();
    for (const event of auditEvents) {
      if (event.entityType !== "heartbeat_run") {
        continue;
      }
      if (event.eventType !== "heartbeat.completed" && event.eventType !== "heartbeat.failed") {
        continue;
      }
      details.set(event.entityId, (event.payload ?? {}) as RunDetailsPayload);
    }
    return details;
  }, [auditEvents, isRunsNav]);
  const runStatusOptions = useMemo(() => {
    if (!isRunsNav) {
      return [];
    }
    const preferredOrder = ["started", "completed", "failed", "skipped"];
    const observed = Array.from(new Set(heartbeatRuns.map((run) => run.status)));
    const additional = observed
      .filter((status) => !preferredOrder.includes(status))
      .sort((a, b) => a.localeCompare(b));
    return preferredOrder.concat(additional);
  }, [heartbeatRuns, isRunsNav]);
  const runTypeOptions = useMemo(
    () => (isRunsNav ? Array.from(new Set(heartbeatRuns.map((run) => run.runType))).sort((a, b) => a.localeCompare(b)) : []),
    [heartbeatRuns, isRunsNav]
  );
  const filteredHeartbeatRuns = useMemo(() => {
    if (!isRunsNav) {
      return [];
    }
    const windowStart = resolveWindowStart(runsWindowFilter);
    const normalizedQuery = runsQuery.trim().toLowerCase();
    return heartbeatRuns
      .filter((run) => {
        if (
          runsTypeFilter === "exclude_no_assigned_work" &&
          (isNoAssignedWorkRun(run) || run.status === "skipped" || run.runType.endsWith("_skip"))
        ) {
          return false;
        }
        if (runsTypeFilter !== "all" && runsTypeFilter !== "exclude_no_assigned_work" && run.runType !== runsTypeFilter) {
          return false;
        }
        if (runsStatusFilter !== "all" && run.status !== runsStatusFilter) {
          return false;
        }
        if (runsAgentFilter !== "all" && run.agentId !== runsAgentFilter) {
          return false;
        }
        if (windowStart && new Date(run.startedAt) < windowStart) {
          return false;
        }
        if (!normalizedQuery) {
          return true;
        }
        const agentName = agentNameById.get(run.agentId) ?? run.agentId;
        return (
          run.id.toLowerCase().includes(normalizedQuery) ||
          formatRunMessage(run.message).toLowerCase().includes(normalizedQuery) ||
          formatRunStatusLabel(run.status).toLowerCase().includes(normalizedQuery) ||
          agentName.toLowerCase().includes(normalizedQuery)
        );
      })
      .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
  }, [agentNameById, heartbeatRuns, isRunsNav, runsAgentFilter, runsQuery, runsStatusFilter, runsTypeFilter, runsWindowFilter]);
  const runsSummary = useMemo(() => {
    const total = heartbeatRuns.length;
    const completed = heartbeatRuns.filter((run) => run.status === "completed").length;
    const failed = heartbeatRuns.filter((run) => run.status === "failed").length;
    const running = heartbeatRuns.filter((run) => !run.finishedAt).length;
    const durations = heartbeatRuns
      .filter((run) => run.finishedAt)
      .map((run) => new Date(run.finishedAt!).getTime() - new Date(run.startedAt).getTime())
      .filter((value) => Number.isFinite(value) && value >= 0);
    const avgMs = durations.length > 0 ? durations.reduce((sum, value) => sum + value, 0) / durations.length : 0;
    const avgDuration = avgMs < 1000 ? `${Math.round(avgMs)}ms` : `${(avgMs / 1000).toFixed(1)}s`;
    const successRate = total > 0 ? (completed / total) * 100 : 0;
    return { total, completed, failed, running, avgDuration, successRate };
  }, [heartbeatRuns]);
  const runsDailyChartData = useMemo(() => {
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
    for (const run of filteredHeartbeatRuns) {
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
  }, [filteredHeartbeatRuns]);
  const runsChartConfig = {
    completed: { label: "Completed", color: "var(--chart-1)" },
    failed: { label: "Failed", color: "var(--chart-5)" }
  } satisfies ChartConfig;
  const runsTopAgentsChartData = useMemo(() => {
    const byAgent = new Map<string, { total: number; failed: number }>();
    for (const run of filteredHeartbeatRuns) {
      const current = byAgent.get(run.agentId) ?? { total: 0, failed: 0 };
      current.total += 1;
      if (run.status === "failed") {
        current.failed += 1;
      }
      byAgent.set(run.agentId, current);
    }
    return Array.from(byAgent.entries())
      .sort((a, b) => b[1].total - a[1].total)
      .slice(0, 6)
      .map(([agentId, values]) => {
        const agentName = agentNameById.get(agentId) ?? shortId(agentId);
        return {
          agent: agentName.length > 18 ? `${agentName.slice(0, 15)}...` : agentName,
          total: values.total,
          failed: values.failed
        };
      });
  }, [agentNameById, filteredHeartbeatRuns]);
  const hasRunsChartData = runsDailyChartData.some((entry) => entry.completed > 0 || entry.failed > 0) || runsTopAgentsChartData.length > 0;
  const runsTopAgentsChartConfig = {
    total: { label: "Total runs", color: "var(--chart-2)" },
    failed: { label: "Failed runs", color: "var(--chart-5)" }
  } satisfies ChartConfig;
  const traceEventOptions = useMemo(
    () => (isLogsNav ? Array.from(new Set(auditEvents.map((event) => event.eventType))).sort((a, b) => a.localeCompare(b)) : []),
    [auditEvents, isLogsNav]
  );
  const traceEntityOptions = useMemo(
    () =>
      isLogsNav ? Array.from(new Set(auditEvents.map((event) => event.entityType))).sort((a, b) => a.localeCompare(b)) : [],
    [auditEvents, isLogsNav]
  );
  const filteredAuditEvents = useMemo(() => {
    if (!isLogsNav) {
      return [];
    }
    const windowStart = resolveWindowStart(traceWindowFilter);
    const normalizedQuery = traceQuery.trim().toLowerCase();
    return auditEvents
      .filter((event) => {
        if (traceEventFilter !== "all" && event.eventType !== traceEventFilter) {
          return false;
        }
        if (traceEntityFilter !== "all" && event.entityType !== traceEntityFilter) {
          return false;
        }
        if (windowStart && new Date(event.createdAt) < windowStart) {
          return false;
        }
        if (!normalizedQuery) {
          return true;
        }
        return (
          event.eventType.toLowerCase().includes(normalizedQuery) ||
          event.entityType.toLowerCase().includes(normalizedQuery) ||
          event.entityId.toLowerCase().includes(normalizedQuery)
        );
      })
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }, [auditEvents, isLogsNav, traceEntityFilter, traceEventFilter, traceQuery, traceWindowFilter]);
  const traceSummary = useMemo(() => {
    const total = auditEvents.length;
    const entitySet = new Set(auditEvents.map((event) => `${event.entityType}:${event.entityId}`));
    const eventTypeCounts = new Map<string, number>();
    let anomalies = 0;
    for (const event of auditEvents) {
      eventTypeCounts.set(event.eventType, (eventTypeCounts.get(event.eventType) ?? 0) + 1);
      if (/(fail|error|reject|timeout)/i.test(event.eventType)) {
        anomalies += 1;
      }
    }
    const topEventType =
      Array.from(eventTypeCounts.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] ??
      "n/a";
    return {
      total,
      uniqueEntities: entitySet.size,
      uniqueEventTypes: eventTypeCounts.size,
      anomalies,
      topEventType
    };
  }, [auditEvents]);
  const traceDailyChartData = useMemo(() => {
    const now = new Date();
    const days = 14;
    const byDay = new Map<string, { total: number; anomalies: number }>();
    for (let i = days - 1; i >= 0; i -= 1) {
      const day = new Date(now);
      day.setHours(0, 0, 0, 0);
      day.setDate(day.getDate() - i);
      const key = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
      byDay.set(key, { total: 0, anomalies: 0 });
    }
    for (const event of filteredAuditEvents) {
      const day = new Date(event.createdAt);
      day.setHours(0, 0, 0, 0);
      const key = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
      const current = byDay.get(key);
      if (!current) {
        continue;
      }
      current.total += 1;
      if (/(fail|error|reject|timeout)/i.test(event.eventType)) {
        current.anomalies += 1;
      }
    }
    return Array.from(byDay.entries()).map(([date, values]) => ({
      label: date.slice(5),
      total: values.total,
      anomalies: values.anomalies
    }));
  }, [filteredAuditEvents]);
  const traceChartConfig = {
    total: { label: "Events", color: "var(--chart-2)" },
    anomalies: { label: "Anomalies", color: "var(--chart-5)" }
  } satisfies ChartConfig;
  const traceEventTypeChartData = useMemo(() => {
    const counts = new Map<string, { total: number; anomalies: number }>();
    for (const event of filteredAuditEvents) {
      const current = counts.get(event.eventType) ?? { total: 0, anomalies: 0 };
      current.total += 1;
      if (/(fail|error|reject|timeout)/i.test(event.eventType)) {
        current.anomalies += 1;
      }
      counts.set(event.eventType, current);
    }
    return Array.from(counts.entries())
      .sort((a, b) => b[1].total - a[1].total)
      .slice(0, 8)
      .map(([eventType, values]) => {
        const label = formatAuditEventLabel({ eventType, entityType: "", entityId: "" }, () => undefined);
        return {
          eventType: label.length > 28 ? `${label.slice(0, 25)}…` : label,
          total: values.total,
          anomalies: values.anomalies
        };
      });
  }, [filteredAuditEvents]);
  const hasTraceChartData = traceDailyChartData.some((entry) => entry.total > 0 || entry.anomalies > 0) || traceEventTypeChartData.length > 0;
  const traceEventTypeChartConfig = {
    total: { label: "Total", color: "var(--chart-2)" },
    anomalies: { label: "Anomalies", color: "var(--chart-5)" }
  } satisfies ChartConfig;
  const governanceStatusOptions = useMemo(
    () =>
      isGovernanceNav ? Array.from(new Set(approvals.map((approval) => approval.status))).sort((a, b) => a.localeCompare(b)) : [],
    [approvals, isGovernanceNav]
  );
  const governanceActionOptions = useMemo(
    () =>
      isGovernanceNav ? Array.from(new Set(approvals.map((approval) => approval.action))).sort((a, b) => a.localeCompare(b)) : [],
    [approvals, isGovernanceNav]
  );
  const filteredApprovals = useMemo(() => {
    if (!isGovernanceNav) {
      return [];
    }
    const windowStart = resolveWindowStart(governanceWindowFilter);
    const normalizedQuery = governanceQuery.trim().toLowerCase();
    return approvals
      .filter((approval) => {
        if (governanceStatusFilter !== "all" && approval.status !== governanceStatusFilter) {
          return false;
        }
        if (governanceActionFilter !== "all" && approval.action !== governanceActionFilter) {
          return false;
        }
        if (windowStart && new Date(approval.createdAt) < windowStart) {
          return false;
        }
        if (!normalizedQuery) {
          return true;
        }
        const payloadText = JSON.stringify(approval.payload ?? {}).toLowerCase();
        return (
          approval.action.toLowerCase().includes(normalizedQuery) ||
          approval.status.toLowerCase().includes(normalizedQuery) ||
          payloadText.includes(normalizedQuery)
        );
      })
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }, [approvals, governanceActionFilter, governanceQuery, governanceStatusFilter, governanceWindowFilter, isGovernanceNav]);
  const governanceSummary = useMemo(() => {
    const total = approvals.length;
    const pending = approvals.filter((approval) => approval.status === "pending").length;
    const approved = approvals.filter((approval) => approval.status === "approved").length;
    const rejected = approvals.filter((approval) => approval.status === "rejected").length;
    const overridden = approvals.filter((approval) => approval.status === "overridden").length;
    const resolved = approvals.filter((approval) => approval.status !== "pending");
    const avgResolutionMs =
      resolved.length > 0
        ? resolved
            .map((approval) => {
              if (!approval.resolvedAt) {
                return 0;
              }
              return new Date(approval.resolvedAt).getTime() - new Date(approval.createdAt).getTime();
            })
            .filter((value) => Number.isFinite(value) && value > 0)
            .reduce((sum, value, _, arr) => sum + value / arr.length, 0)
        : 0;
    const avgResolutionLabel =
      avgResolutionMs < 1_000
        ? `${Math.round(avgResolutionMs)}ms`
        : avgResolutionMs < 60_000
          ? `${(avgResolutionMs / 1_000).toFixed(1)}s`
          : `${(avgResolutionMs / 60_000).toFixed(1)}m`;
    return { total, pending, approved, rejected, overridden, avgResolutionLabel };
  }, [approvals]);
  const goalsLevelOptions = useMemo(
    () =>
      isGoalsNav ? Array.from(new Set(goals.map((goal) => goal.level))).sort((a, b) => a.localeCompare(b)) : [],
    [goals, isGoalsNav]
  );
  const goalsParentFilterOptions = useMemo(() => {
    if (!isGoalsNav) {
      return [] as Array<{ id: string; title: string }>;
    }
    const parentIds = new Set<string>();
    for (const g of goals) {
      const pid = g.parentGoalId?.trim();
      if (pid) {
        parentIds.add(pid);
      }
    }
    return Array.from(parentIds)
      .map((id) => {
        const row = goals.find((x) => x.id === id);
        return { id, title: row?.title?.trim() || id };
      })
      .sort((a, b) => a.title.localeCompare(b.title));
  }, [goals, isGoalsNav]);
  const filteredGoals = useMemo(() => {
    if (!isGoalsNav) {
      return [];
    }
    const normalizedQuery = goalsQuery.trim().toLowerCase();
    return goals.filter((goal) => {
      if (goalsStatusFilter !== "all" && goal.status !== goalsStatusFilter) {
        return false;
      }
      if (goalsLevelFilter !== "all" && goal.level !== goalsLevelFilter) {
        return false;
      }
      if (goalsParentFilter === "no_parent") {
        if (goal.parentGoalId?.trim()) {
          return false;
        }
      } else if (goalsParentFilter !== "all") {
        if (goal.parentGoalId?.trim() !== goalsParentFilter) {
          return false;
        }
      }
      if (!normalizedQuery) {
        return true;
      }
      const projectName = goal.projectId ? (projects.find((project) => project.id === goal.projectId)?.name ?? "") : "";
      const parentPid = goal.parentGoalId?.trim();
      const parentTitle = parentPid ? (goals.find((g) => g.id === parentPid)?.title ?? "") : "";
      return (
        goal.title.toLowerCase().includes(normalizedQuery) ||
        (goal.description ?? "").toLowerCase().includes(normalizedQuery) ||
        goal.status.toLowerCase().includes(normalizedQuery) ||
        goal.level.toLowerCase().includes(normalizedQuery) ||
        projectName.toLowerCase().includes(normalizedQuery) ||
        parentTitle.toLowerCase().includes(normalizedQuery)
      );
    });
  }, [goals, goalsLevelFilter, goalsParentFilter, goalsQuery, goalsStatusFilter, isGoalsNav, projects]);
  const projectIssueSummaryById = useMemo(() => {
    if (!isProjectsNav) {
      return new Map<string, { total: number; open: number }>();
    }
    const summary = new Map<string, { total: number; open: number }>();
    for (const project of projects) {
      summary.set(project.id, { total: 0, open: 0 });
    }
    for (const issue of issues) {
      const current = summary.get(issue.projectId) ?? { total: 0, open: 0 };
      current.total += 1;
      if (issue.status !== "done" && issue.status !== "canceled") {
        current.open += 1;
      }
      summary.set(issue.projectId, current);
    }
    return summary;
  }, [issues, isProjectsNav, projects]);
  const projectGoalCountById = useMemo(() => {
    if (!isProjectsNav) {
      return new Map<string, number>();
    }
    const summary = new Map<string, number>();
    for (const project of projects) {
      summary.set(project.id, 0);
    }
    for (const goal of goals) {
      if (!goal.projectId) {
        continue;
      }
      summary.set(goal.projectId, (summary.get(goal.projectId) ?? 0) + 1);
    }
    return summary;
  }, [goals, isProjectsNav, projects]);
  const filteredProjects = useMemo(() => {
    if (!isProjectsNav) {
      return [];
    }
    const normalizedQuery = projectsQuery.trim().toLowerCase();
    return projects.filter((project) => {
      const issueSummary = projectIssueSummaryById.get(project.id) ?? { total: 0, open: 0 };
      if (projectsActivityFilter === "active" && issueSummary.open === 0) {
        return false;
      }
      if (projectsActivityFilter === "no_open_issues" && issueSummary.open > 0) {
        return false;
      }
      if (projectsActivityFilter === "no_issues" && issueSummary.total > 0) {
        return false;
      }
      if (!normalizedQuery) {
        return true;
      }
      return (
        project.name.toLowerCase().includes(normalizedQuery) ||
        (project.description ?? "").toLowerCase().includes(normalizedQuery) ||
        project.status.toLowerCase().includes(normalizedQuery) ||
        (project.primaryWorkspace?.cwd ?? "").toLowerCase().includes(normalizedQuery) ||
        (project.primaryWorkspace?.repoUrl ?? "").toLowerCase().includes(normalizedQuery)
      );
    });
  }, [isProjectsNav, projectIssueSummaryById, projects, projectsActivityFilter, projectsQuery]);
  const suggestedAgentRuntimeCwd = useMemo(() => {
    const uniqueWorkspacePaths = Array.from(
      new Set(
        projects
          .map((project) => project.primaryWorkspace?.cwd?.trim() ?? "")
          .filter((value) => value.length > 0)
      )
    );
    return uniqueWorkspacePaths.length === 1 ? uniqueWorkspacePaths[0] : undefined;
  }, [projects]);
  const agentStatusOptions = useMemo(
    () => Array.from(new Set(agents.map((agent) => agent.status))).sort((a, b) => a.localeCompare(b)),
    [agents]
  );
  const agentProviderOptions = useMemo(
    () => Array.from(new Set(agents.map((agent) => agent.providerType))).sort((a, b) => a.localeCompare(b)),
    [agents]
  );
  const agentReportToOptions = useMemo(() => {
    const managerIds = Array.from(
      new Set(
        agents
          .map((agent) => agent.managerAgentId)
          .filter((managerId): managerId is string => typeof managerId === "string")
      )
    );
    return managerIds
      .map((managerId) => ({
        value: managerId,
        label: agentNameById.get(managerId) ?? `Unknown (${shortId(managerId)})`
      }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [agentNameById, agents]);
  const agentModelOptions = useMemo(() => {
    const models = Array.from(new Set(agents.map((agent) => resolveNamedModelForAgent(agent) ?? "unconfigured")));
    return models.sort((a, b) => a.localeCompare(b));
  }, [agents]);
  const filteredAgents = useMemo(() => {
    if (!isAgentsNav) {
      return [];
    }
    const normalizedQuery = agentsQuery.trim().toLowerCase();
    return agents.filter((agent) => {
      if (agentsStatusFilter !== "all" && agent.status !== agentsStatusFilter) {
        return false;
      }
      if (agentsProviderFilter !== "all" && agent.providerType !== agentsProviderFilter) {
        return false;
      }
      if (agentsReportToFilter !== "all") {
        if (agentsReportToFilter === "none") {
          if (agent.managerAgentId) {
            return false;
          }
        } else if (agent.managerAgentId !== agentsReportToFilter) {
          return false;
        }
      }
      if (agentsModelFilter !== "all") {
        const model = resolveNamedModelForAgent(agent) ?? "unconfigured";
        if (model !== agentsModelFilter) {
          return false;
        }
      }
      if (!normalizedQuery) {
        return true;
      }
      return (
        agent.name.toLowerCase().includes(normalizedQuery) ||
        getAgentDisplayRole(agent).toLowerCase().includes(normalizedQuery) ||
        agent.status.toLowerCase().includes(normalizedQuery) ||
        agent.providerType.toLowerCase().includes(normalizedQuery)
      );
    });
  }, [agents, agentsModelFilter, agentsProviderFilter, agentsQuery, agentsReportToFilter, agentsStatusFilter, isAgentsNav]);
  const agentsToolbarFilters = useMemo(
    () => (
      <div className="ui-toolbar-filters">
        <Input
          value={agentsQuery}
          onChange={(event) => setAgentsQuery(event.target.value)}
          placeholder="Search name, role/title, status, or provider..."
          className="ui-toolbar-filter-input"
        />
        <Select value={agentsStatusFilter} onValueChange={setAgentsStatusFilter}>
          <SelectTrigger className="ui-toolbar-filter-select">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            {agentStatusOptions.map((status) => (
              <SelectItem key={status} value={status}>
                {status}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={agentsProviderFilter} onValueChange={setAgentsProviderFilter}>
          <SelectTrigger className="ui-toolbar-filter-select">
            <SelectValue placeholder="Provider" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All providers</SelectItem>
            {agentProviderOptions.map((provider) => (
              <SelectItem key={provider} value={provider}>
                {provider}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={agentsReportToFilter} onValueChange={setAgentsReportToFilter}>
          <SelectTrigger className="ui-toolbar-filter-select">
            <SelectValue placeholder="Report to" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All managers</SelectItem>
            <SelectItem value="none">No manager</SelectItem>
            {agentReportToOptions.map((manager) => (
              <SelectItem key={manager.value} value={manager.value}>
                {manager.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={agentsModelFilter} onValueChange={setAgentsModelFilter}>
          <SelectTrigger className="ui-toolbar-filter-select">
            <SelectValue placeholder="Model" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All models</SelectItem>
            {agentModelOptions.map((model) => (
              <SelectItem key={model} value={model}>
                {model === "unconfigured" ? "Unconfigured" : model}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    ),
    [
      agentModelOptions,
      agentProviderOptions,
      agentReportToOptions,
      agentStatusOptions,
      agentsModelFilter,
      agentsProviderFilter,
      agentsQuery,
      agentsReportToFilter,
      agentsStatusFilter
    ]
  );
  const agentsViewToggle = (
    <ButtonGroup className={styles.agentsViewToggleGroup}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="outline"
            size="icon"
            className={cn(
              styles.agentsViewToggleButton,
              agentsViewMode === "table" ? styles.agentsViewToggleButtonActive : undefined
            )}
            onClick={() => setAgentsViewMode("table")}
            aria-label="Table view"
          >
            <Table className="size-4" aria-hidden />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Table</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="outline"
            size="icon"
            className={cn(
              styles.agentsViewToggleButton,
              agentsViewMode === "cards" ? styles.agentsViewToggleButtonActive : undefined
            )}
            onClick={() => setAgentsViewMode("cards")}
            aria-label="Cards view"
          >
            <LayoutGrid className="size-4" aria-hidden />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Cards</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="outline"
            size="icon"
            className={cn(
              styles.agentsViewToggleButton,
              agentsViewMode === "structure" ? styles.agentsViewToggleButtonActive : undefined
            )}
            onClick={() => setAgentsViewMode("structure")}
            aria-label="Org chart view"
          >
            <Network className="size-4" aria-hidden />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Org</TooltipContent>
      </Tooltip>
    </ButtonGroup>
  );
  const pluginKindOptions = useMemo(
    () => Array.from(new Set(plugins.map((plugin) => plugin.kind))).sort((a, b) => a.localeCompare(b)),
    [plugins]
  );
  const filteredPlugins = useMemo(() => {
    if (!isPluginsNav) {
      return [];
    }
    const normalizedQuery = pluginsQuery.trim().toLowerCase();
    return plugins.filter((plugin) => {
      const installed = Boolean(plugin.companyConfig);
      const active = Boolean(plugin.companyConfig?.enabled);
      if (pluginsStatusFilter === "active" && !active) {
        return false;
      }
      if (pluginsStatusFilter === "installed" && (!installed || active)) {
        return false;
      }
      if (pluginsStatusFilter === "not_installed" && installed) {
        return false;
      }
      if (pluginsKindFilter !== "all" && plugin.kind !== pluginsKindFilter) {
        return false;
      }
      if (!normalizedQuery) {
        return true;
      }
      return (
        plugin.name.toLowerCase().includes(normalizedQuery) ||
        plugin.id.toLowerCase().includes(normalizedQuery) ||
        plugin.kind.toLowerCase().includes(normalizedQuery) ||
        plugin.capabilities.some((capability) => capability.toLowerCase().includes(normalizedQuery)) ||
        plugin.hooks.some((hook) => hook.toLowerCase().includes(normalizedQuery))
      );
    });
  }, [isPluginsNav, plugins, pluginsKindFilter, pluginsQuery, pluginsStatusFilter]);
  const pluginsSummary = useMemo(() => {
    const total = plugins.length;
    const installed = plugins.filter((plugin) => Boolean(plugin.companyConfig)).length;
    const active = plugins.filter((plugin) => Boolean(plugin.companyConfig?.enabled)).length;
    const kinds = new Set(plugins.map((plugin) => plugin.kind)).size;
    const grantedCapabilities = plugins.reduce(
      (sum, plugin) => sum + (plugin.companyConfig?.grantedCapabilities.length ?? 0),
      0
    );
    return { total, installed, active, kinds, grantedCapabilities };
  }, [plugins]);
  const filteredTemplates = useMemo(() => {
    if (!isTemplatesNav) {
      return [];
    }
    const normalizedQuery = templatesQuery.trim().toLowerCase();
    return templates.filter((template) => {
      if (templatesStatusFilter !== "all" && template.status !== templatesStatusFilter) {
        return false;
      }
      if (templatesVisibilityFilter !== "all" && template.visibility !== templatesVisibilityFilter) {
        return false;
      }
      if (!normalizedQuery) {
        return true;
      }
      return (
        template.name.toLowerCase().includes(normalizedQuery) ||
        template.slug.toLowerCase().includes(normalizedQuery) ||
        template.currentVersion.toLowerCase().includes(normalizedQuery) ||
        template.status.toLowerCase().includes(normalizedQuery)
      );
    });
  }, [isTemplatesNav, templates, templatesQuery, templatesStatusFilter, templatesVisibilityFilter]);
  const pluginBuilderValidationError = useMemo(() => {
    if (!pluginPackageName.trim()) {
      return "npm package name is required.";
    }
    return null;
  }, [pluginPackageName]);
  const agentModelPairs = useMemo(() => {
    const pairs: Array<{ providerType: string; modelId: string }> = [];
    for (const agent of agents) {
      const provider = resolveModelCatalogProvider(agent.providerType?.trim() ?? "");
      if (!provider) continue;
      const rawModel =
        agent.runtimeModel?.trim() ||
        parseRuntimeModelFromStateBlob(agent.stateBlob);
      const model = normalizeModelIdForCatalog(provider, rawModel);
      if (!model) continue;
      pairs.push({ providerType: provider, modelId: model });
    }
    const seen = new Set<string>();
    const deduped: Array<{ providerType: string; modelId: string }> = [];
    for (const pair of pairs) {
      const key = `${pair.providerType}::${pair.modelId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(pair);
    }
    return deduped;
  }, [agents]);

  const mergedModelPricing = useMemo<ModelPricingRow[]>(() => {
    const byKey = new Map<string, ModelPricingRow>();
    // Seed catalog defaults so the models page always lists known provider models.
    for (const providerType of MODELS_PROVIDER_FALLBACKS) {
      const sourceProvider =
        providerType === "opencode" ? "opencode" : providerType === "gemini_api" ? "gemini_cli" : providerType;
      const defaults = getSupportedModelOptionsForProvider(sourceProvider).filter((option) => option.value.trim().length > 0);
      for (const option of defaults) {
        const modelId = normalizeModelIdForCatalog(providerType, option.value);
        if (!modelId) continue;
        const key = `${providerType}::${modelId}`;
        if (byKey.has(key)) continue;
        byKey.set(key, {
          providerType,
          modelId,
          displayName: option.label,
          inputUsdPer1M: 0,
          outputUsdPer1M: 0,
          currency: "USD",
          updatedAt: null,
          updatedBy: null
        });
      }
    }
    // Start with derived entries from agent models.
    for (const pair of agentModelPairs) {
      const normalizedModel = normalizeModelIdForCatalog(pair.providerType, pair.modelId);
      if (!normalizedModel) continue;
      const key = `${pair.providerType}::${normalizedModel}`;
      if (byKey.has(key)) continue;
      byKey.set(key, {
        providerType: pair.providerType,
        modelId: normalizedModel,
        displayName: null,
        inputUsdPer1M: 0,
        outputUsdPer1M: 0,
        currency: "USD",
        updatedAt: null,
        updatedBy: null
      });
    }
    // Overlay persisted pricing from API.
    for (const row of modelPricing) {
      const providerType = row.providerType.trim();
      const normalizedModel = normalizeModelIdForCatalog(providerType, row.modelId);
      if (!normalizedModel) continue;
      const key = `${providerType}::${normalizedModel}`;
      byKey.set(key, {
        ...row,
        providerType,
        modelId: normalizedModel
      });
    }
    return Array.from(byKey.values()).sort((a, b) => {
      if (a.providerType === b.providerType) {
        return a.modelId.localeCompare(b.modelId);
      }
      return a.providerType.localeCompare(b.providerType);
    });
  }, [agentModelPairs, modelPricing]);

  const configuredModelPricingKeys = useMemo(() => {
    return new Set(
      modelPricing
        .map((row) => {
          const providerType = row.providerType.trim();
          const modelId = normalizeModelIdForCatalog(providerType, row.modelId);
          if (!modelId) return null;
          return `${providerType}::${modelId}`;
        })
        .filter((entry): entry is string => Boolean(entry))
    );
  }, [modelPricing]);

  const missingModelPricingPairs = useMemo(() => {
    return agentModelPairs.filter((pair) => !configuredModelPricingKeys.has(`${pair.providerType}::${pair.modelId}`));
  }, [agentModelPairs, configuredModelPricingKeys]);

  const availableModelProviders = useMemo(() => {
    return [...MODELS_PROVIDER_FALLBACKS];
  }, []);

  const availableModelsByProvider = useMemo(() => {
    const modelsByProvider = new Map<string, Set<string>>();
    const addModel = (providerType: string, modelId: string | null | undefined) => {
      const provider = resolveModelCatalogProvider(providerType);
      const model = normalizeModelIdForCatalog(provider ?? providerType, modelId);
      if (!provider || !model) {
        return;
      }
      const existing = modelsByProvider.get(provider) ?? new Set<string>();
      existing.add(model);
      modelsByProvider.set(provider, existing);
    };
    for (const row of mergedModelPricing) {
      addModel(row.providerType, row.modelId);
    }
    for (const pair of agentModelPairs) {
      addModel(pair.providerType, pair.modelId);
    }
    for (const providerType of MODELS_PROVIDER_FALLBACKS) {
      const sourceProvider =
        providerType === "opencode" ? "opencode" : providerType === "gemini_api" ? "gemini_cli" : providerType;
      const defaults = getSupportedModelOptionsForProvider(sourceProvider).filter((option) => option.value.trim().length > 0);
      for (const option of defaults) {
        addModel(providerType, option.value);
      }
    }
    const normalized = new Map<string, string[]>();
    for (const [providerType, models] of modelsByProvider.entries()) {
      normalized.set(providerType, Array.from(models).sort());
    }
    return normalized;
  }, [agentModelPairs, mergedModelPricing]);

  const filteredModelPricing = useMemo(() => {
    const rows = mergedModelPricing;
    if (!isModelsNav) {
      return rows;
    }
    const normalizedQuery = modelQuery.trim().toLowerCase();
    return rows.filter((row) => {
      if (modelProviderFilter !== "all" && row.providerType !== modelProviderFilter) {
        return false;
      }
      if (!normalizedQuery) {
        return true;
      }
      return (
        row.modelId.toLowerCase().includes(normalizedQuery) ||
        row.providerType.toLowerCase().includes(normalizedQuery)
      );
    });
  }, [isModelsNav, mergedModelPricing, modelProviderFilter, modelQuery]);

  useEffect(() => {
    setModelPricing([]);
  }, [companyId, isModelsNav]);
  const dashboardIssueStatusData = useMemo(() => {
    if (!isDashboardNav) {
      return [];
    }
    const statuses: Array<IssueRow["status"]> = ["todo", "in_progress", "blocked", "in_review", "done", "canceled"];
    const counts = new Map<IssueRow["status"], number>(statuses.map((status) => [status, 0]));
    for (const issue of issues) {
      counts.set(issue.status, (counts.get(issue.status) ?? 0) + 1);
    }
    return statuses.map((status) => ({
      label: status.replace("_", " "),
      total: counts.get(status) ?? 0
    }));
  }, [issues, isDashboardNav]);
  const dashboardRunsDailyData = useMemo(() => {
    if (!isDashboardNav) {
      return [];
    }
    const now = new Date();
    const byDay = new Map<string, { completed: number; failed: number; skipped: number; total: number }>();
    for (let i = 13; i >= 0; i -= 1) {
      const day = new Date(now);
      day.setHours(0, 0, 0, 0);
      day.setDate(day.getDate() - i);
      const key = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
      byDay.set(key, { completed: 0, failed: 0, skipped: 0, total: 0 });
    }
    for (const run of heartbeatRuns) {
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
      } else if (run.status === "skipped") {
        current.skipped += 1;
      }
      current.total += 1;
    }
    return Array.from(byDay.entries()).map(([date, values]) => ({
      label: date.slice(5),
      completed: values.completed,
      failed: values.failed,
      skipped: values.skipped,
      total: values.total
    }));
  }, [heartbeatRuns, isDashboardNav]);
  const dashboardCostTrendData = useMemo(
    () => monthlyCostChartData.map((entry) => ({ label: entry.label, usd: entry.usd })),
    [monthlyCostChartData]
  );
  const dashboardOpenIssues = useMemo(
    () => (isDashboardNav ? issues.filter((issue) => issue.status !== "done" && issue.status !== "canceled") : []),
    [issues, isDashboardNav]
  );
  const staleIssueCount = useMemo(() => {
    if (!isDashboardNav) {
      return 0;
    }
    const now = Date.now();
    return dashboardOpenIssues.filter((issue) => now - new Date(issue.updatedAt).getTime() > 7 * 24 * 60 * 60 * 1000).length;
  }, [dashboardOpenIssues, isDashboardNav]);
  const oldestPendingApprovalAge = useMemo(() => {
    if (!isDashboardNav) {
      return "none";
    }
    if (pendingApprovals.length === 0) {
      return "none";
    }
    const oldest = Math.min(...pendingApprovals.map((approval) => new Date(approval.createdAt).getTime()));
    return formatRelativeAgeCompact(new Date(oldest).toISOString());
  }, [isDashboardNav, pendingApprovals]);
  const dashboardPendingApprovalsByAction = useMemo(() => {
    if (!isDashboardNav) {
      return [];
    }
    const counts = new Map<string, number>();
    for (const approval of pendingApprovals) {
      counts.set(approval.action, (counts.get(approval.action) ?? 0) + 1);
    }
    return Array.from(counts.entries())
      .map(([action, total]) => ({
        action,
        label: formatApprovalActionLabel(action),
        total
      }))
      .sort((a, b) => (b.total === a.total ? a.label.localeCompare(b.label) : b.total - a.total));
  }, [isDashboardNav, pendingApprovals]);
  const dashboardPendingApprovalPreview = useMemo(() => {
    if (!isDashboardNav) {
      return [];
    }
    const inboxByApprovalId = new Map(governanceInbox.map((entry) => [entry.approval.id, entry]));
    return pendingApprovals
      .map((approval) => {
        const inboxItem = inboxByApprovalId.get(approval.id);
        const requestedById = inboxItem?.approval.requestedByAgentId ?? null;
        const requestedBy =
          requestedById && requestedById.trim().length > 0
            ? (agentNameById.get(requestedById) ?? shortId(requestedById))
            : "system";
        return {
          id: approval.id,
          actionLabel: formatApprovalActionLabel(approval.action),
          payloadSummary: describeApprovalPayload(approval.payload),
          requestedBy,
          createdAt: approval.createdAt,
          ageLabel: formatRelativeAgeCompact(approval.createdAt)
        };
      })
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
      .slice(0, 3);
  }, [agentNameById, governanceInbox, isDashboardNav, pendingApprovals]);
  const dashboardNeedsAttention = useMemo(() => {
    if (!isDashboardNav) {
      return { staleOpenIssues: 0, blockedIssues: 0, failedRuns24h: 0, failedRuns7d: 0 };
    }
    const now = Date.now();
    const last24hMs = 24 * 60 * 60 * 1000;
    const last7dMs = 7 * 24 * 60 * 60 * 1000;
    const blockedIssues = issues.filter((issue) => issue.status === "blocked").length;
    const failedRuns24h = heartbeatRuns.filter((run) => run.status === "failed" && now - new Date(run.startedAt).getTime() <= last24hMs).length;
    const failedRuns7d = heartbeatRuns.filter((run) => run.status === "failed" && now - new Date(run.startedAt).getTime() <= last7dMs).length;
    return {
      staleOpenIssues: staleIssueCount,
      blockedIssues,
      failedRuns24h,
      failedRuns7d
    };
  }, [heartbeatRuns, isDashboardNav, issues, staleIssueCount]);
  const dashboardAttentionSummary = useMemo(() => {
    if (!isDashboardNav) {
      return { open: 0, critical: 0, warning: 0 };
    }
    const active = attentionItems.filter((item) => item.state === "open" || item.state === "acknowledged");
    return {
      open: active.length,
      critical: active.filter((item) => item.severity === "critical").length,
      warning: active.filter((item) => item.severity === "warning").length
    };
  }, [attentionItems, isDashboardNav]);
  const dashboardAttentionPreview = useMemo(
    () =>
      isDashboardNav
        ? attentionItems
            .filter((item) => item.state === "open" || item.state === "acknowledged")
            .sort((a, b) => new Date(b.sourceTimestamp).getTime() - new Date(a.sourceTimestamp).getTime())
            .slice(0, 5)
        : [],
    [attentionItems, isDashboardNav]
  );
  const topCostAgent = useMemo(() => {
    if (!isDashboardNav) {
      return "No agent spend yet";
    }
    const byAgent = new Map<string, number>();
    for (const entry of costEntries) {
      if (!entry.agentId) {
        continue;
      }
      byAgent.set(entry.agentId, (byAgent.get(entry.agentId) ?? 0) + entry.usdCost);
    }
    const top = Array.from(byAgent.entries()).sort((a, b) => b[1] - a[1])[0];
    if (!top) {
      return "No agent spend yet";
    }
    return `${agentNameById.get(top[0]) ?? shortId(top[0])} ($${top[1].toFixed(2)})`;
  }, [agentNameById, costEntries, isDashboardNav]);
  const dashboardRunHealth = useMemo(() => {
    if (!isDashboardNav) {
      return {
        runsLast24h: 0,
        completedLast24h: 0,
        failedLast24h: 0,
        skippedLast24h: 0,
        successRate24h: 0
      };
    }
    const now = Date.now();
    const last24hMs = 24 * 60 * 60 * 1000;
    const recentRuns = heartbeatRuns.filter((run) => now - new Date(run.startedAt).getTime() <= last24hMs);
    const completedLast24h = recentRuns.filter((run) => run.status === "completed").length;
    const failedLast24h = recentRuns.filter((run) => run.status === "failed").length;
    const skippedLast24h = recentRuns.filter((run) => run.status === "skipped").length;
    const relevantRuns = completedLast24h + failedLast24h;
    const successRate24h = relevantRuns > 0 ? (completedLast24h / relevantRuns) * 100 : 0;
    return {
      runsLast24h: recentRuns.length,
      completedLast24h,
      failedLast24h,
      skippedLast24h,
      successRate24h
    };
  }, [heartbeatRuns, isDashboardNav]);
  const dashboardAgentStatusData = useMemo(() => {
    if (!isDashboardNav) {
      return [];
    }
    const counts = new Map<string, number>();
    for (const agent of agents) {
      counts.set(agent.status, (counts.get(agent.status) ?? 0) + 1);
    }
    return Array.from(counts.entries())
      .map(([status, total]) => ({ label: status.replaceAll("_", " "), total }))
      .sort((a, b) => (b.total === a.total ? a.label.localeCompare(b.label) : b.total - a.total));
  }, [agents, isDashboardNav]);
  const dashboardAgentProviderData = useMemo(() => {
    if (!isDashboardNav) {
      return [];
    }
    const counts = new Map<string, number>();
    for (const agent of agents) {
      counts.set(agent.providerType, (counts.get(agent.providerType) ?? 0) + 1);
    }
    return Array.from(counts.entries())
      .map(([label, total]) => ({ label, total }))
      .sort((a, b) => (b.total === a.total ? a.label.localeCompare(b.label) : b.total - a.total));
  }, [agents, isDashboardNav]);
  const dashboardIssueAgingData = useMemo(() => {
    if (!isDashboardNav) {
      return [];
    }
    const now = Date.now();
    const buckets = [
      { label: "<24h", min: 0, max: 24 },
      { label: "1-3d", min: 24, max: 72 },
      { label: "3-7d", min: 72, max: 168 },
      { label: ">7d", min: 168, max: Number.POSITIVE_INFINITY }
    ];
    const totals = new Map<string, number>(buckets.map((bucket) => [bucket.label, 0]));
    for (const issue of dashboardOpenIssues) {
      const ageHours = (now - new Date(issue.updatedAt).getTime()) / (1000 * 60 * 60);
      const bucket = buckets.find((entry) => ageHours >= entry.min && ageHours < entry.max);
      if (!bucket) {
        continue;
      }
      totals.set(bucket.label, (totals.get(bucket.label) ?? 0) + 1);
    }
    return buckets.map((bucket) => ({ label: bucket.label, total: totals.get(bucket.label) ?? 0 }));
  }, [dashboardOpenIssues, isDashboardNav]);
  const dashboardAssignmentCoverageData = useMemo(() => {
    if (!isDashboardNav) {
      return [];
    }
    const assigned = dashboardOpenIssues.filter((issue) => Boolean(issue.assigneeAgentId)).length;
    const unassigned = dashboardOpenIssues.length - assigned;
    const blocked = dashboardOpenIssues.filter((issue) => issue.status === "blocked").length;
    return [
      { label: "Assigned", total: assigned },
      { label: "Unassigned", total: unassigned },
      { label: "Blocked", total: blocked }
    ];
  }, [dashboardOpenIssues, isDashboardNav]);
  const dashboardApprovalAgingData = useMemo(() => {
    if (!isDashboardNav) {
      return [];
    }
    const now = Date.now();
    const buckets = [
      { label: "<1h", minHours: 0, maxHours: 1 },
      { label: "1-6h", minHours: 1, maxHours: 6 },
      { label: "6-24h", minHours: 6, maxHours: 24 },
      { label: ">24h", minHours: 24, maxHours: Number.POSITIVE_INFINITY }
    ];
    const totals = new Map<string, number>(buckets.map((bucket) => [bucket.label, 0]));
    for (const approval of pendingApprovals) {
      const ageHours = (now - new Date(approval.createdAt).getTime()) / (1000 * 60 * 60);
      const bucket = buckets.find((entry) => ageHours >= entry.minHours && ageHours < entry.maxHours);
      if (!bucket) {
        continue;
      }
      totals.set(bucket.label, (totals.get(bucket.label) ?? 0) + 1);
    }
    return buckets.map((bucket) => ({ label: bucket.label, total: totals.get(bucket.label) ?? 0 }));
  }, [isDashboardNav, pendingApprovals]);
  const dashboardApprovalsByActionData = useMemo(
    () =>
      dashboardPendingApprovalsByAction.map((entry) => ({
        label: entry.label,
        total: entry.total
      })),
    [dashboardPendingApprovalsByAction]
  );
  const dashboardCostByAgentData = useMemo(() => {
    if (!isDashboardNav) {
      return [];
    }
    const byAgent = new Map<string, number>();
    for (const entry of costEntries) {
      if (!entry.agentId) {
        continue;
      }
      byAgent.set(entry.agentId, (byAgent.get(entry.agentId) ?? 0) + entry.usdCost);
    }
    return Array.from(byAgent.entries())
      .map(([agentId, usd]) => ({
        label: agentNameById.get(agentId) ?? shortId(agentId),
        usd: Number(usd.toFixed(4))
      }))
      .sort((a, b) => b.usd - a.usd)
      .slice(0, 6);
  }, [agentNameById, costEntries, isDashboardNav]);
  const dashboardAgentSnapshots = useMemo(() => {
    if (!isDashboardNav) {
      return [];
    }
    const dayKeys = buildRecentDayKeys(14);
    const pendingApprovalsByRequester = new Map<string, number>();
    for (const inboxItem of governanceInbox) {
      if (inboxItem.approval.status !== "pending") {
        continue;
      }
      const requester = inboxItem.approval.requestedByAgentId;
      if (!requester) {
        continue;
      }
      pendingApprovalsByRequester.set(requester, (pendingApprovalsByRequester.get(requester) ?? 0) + 1);
    }
    const runWindowStart = Date.now() - 24 * 60 * 60 * 1000;
    const spendWindowStart = Date.now() - 30 * 24 * 60 * 60 * 1000;
    return agents
      .filter((agent) => agent.status !== "terminated")
      .map((agent) => {
        const assignedOpenIssues = dashboardOpenIssues.filter((issue) => issue.assigneeAgentId === agent.id);
        const blockedAssignedIssues = assignedOpenIssues.filter((issue) => issue.status === "blocked").length;
        const needsApproval = pendingApprovalsByRequester.get(agent.id) ?? 0;
        const runs24h = heartbeatRuns.filter((run) => run.agentId === agent.id && new Date(run.startedAt).getTime() >= runWindowStart);
        const completed24h = runs24h.filter((run) => run.status === "completed").length;
        const failed24h = runs24h.filter((run) => run.status === "failed").length;
        const spend30d = costEntries
          .filter((entry) => entry.agentId === agent.id && new Date(entry.createdAt).getTime() >= spendWindowStart)
          .reduce((sum, entry) => sum + entry.usdCost, 0);
        const byDay = new Map(dayKeys.map((key) => [key, { total: 0, failed: 0 }]));
        for (const run of heartbeatRuns) {
          if (run.agentId !== agent.id) {
            continue;
          }
          const day = new Date(run.startedAt);
          day.setHours(0, 0, 0, 0);
          const key = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
          const current = byDay.get(key);
          if (!current) {
            continue;
          }
          current.total += 1;
          if (run.status === "failed") {
            current.failed += 1;
          }
        }
        const trend = Array.from(byDay.entries()).map(([key, values]) => ({
          label: key.slice(5),
          total: values.total,
          failed: values.failed
        }));
        return {
          id: agent.id,
          name: agent.name,
          role: getAgentDisplayRole(agent),
          status: agent.status,
          openAssigned: assignedOpenIssues.length,
          blockedAssigned: blockedAssignedIssues,
          needsApproval,
          runs24h: runs24h.length,
          completed24h,
          failed24h,
          spend30d,
          trend
        };
      })
      .sort((a, b) => {
        if (b.openAssigned !== a.openAssigned) {
          return b.openAssigned - a.openAssigned;
        }
        if (b.needsApproval !== a.needsApproval) {
          return b.needsApproval - a.needsApproval;
        }
        return b.runs24h - a.runs24h;
      });
  }, [agents, costEntries, dashboardOpenIssues, governanceInbox, heartbeatRuns, isDashboardNav]);
  const dashboardIssueConfig = {
    total: { label: "Issues", color: "var(--chart-1)" }
  } satisfies ChartConfig;
  const dashboardRunsConfig = {
    completed: { label: "Completed", color: "var(--chart-1)" },
    failed: { label: "Failed", color: "var(--chart-5)" },
    skipped: { label: "Skipped", color: "var(--chart-3)" }
  } satisfies ChartConfig;
  const dashboardRunsVolumeConfig = {
    total: { label: "Runs", color: "var(--chart-2)" }
  } satisfies ChartConfig;
  const dashboardAgentsConfig = {
    total: { label: "Agents", color: "var(--chart-3)" }
  } satisfies ChartConfig;
  const dashboardApprovalsConfig = {
    total: { label: "Approvals", color: "var(--chart-4)" }
  } satisfies ChartConfig;
  const dashboardCostConfig = {
    usd: { label: "USD", color: "var(--chart-2)" }
  } satisfies ChartConfig;
  const dashboardAgentTrendConfig = {
    total: { label: "Runs", color: "var(--chart-1)" },
    failed: { label: "Failed", color: "var(--chart-5)" }
  } satisfies ChartConfig;
  const projectColumns = useMemo<ColumnDef<ProjectRow>[]>(
    () => [
      {
        accessorKey: "name",
        header: ({ column }) => <DataTableColumnHeader column={column} title="Project" />,
        cell: ({ row }) =>
          companyId ? (
            <Link
              href={{
                pathname: `/projects/${row.original.id}`,
                query: { companyId }
              }}
              className={styles.renderSectionActionsLink}
            >
              {row.original.name}
            </Link>
          ) : (
            <div className={styles.formatDurationContainer1}>{row.original.name}</div>
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
        id: "plannedStartAt",
        header: "Start",
        cell: ({ row }) => <div className={styles.formatDurationContainer1}>{formatDate(row.original.plannedStartAt)}</div>
      },
      {
        id: "budget",
        header: ({ column }) => <DataTableColumnHeader column={column} title="Budget (used/month)" />,
        accessorFn: (row) => {
          const monthlyBudget = row.monthlyBudgetUsd ?? 0;
          const usedBudget = row.usedBudgetUsd ?? 0;
          return monthlyBudget > 0 ? usedBudget / monthlyBudget : usedBudget;
        },
        cell: ({ row }) => (
          <div className={styles.formatDurationContainer1}>
            {`${formatUsdCost(row.original.usedBudgetUsd ?? 0)} / ${formatUsdCost(row.original.monthlyBudgetUsd ?? 0)}`}
          </div>
        )
      }
    ],
    [companyId]
  );

  const goalColumns = useMemo<ColumnDef<GoalRow>[]>(
    () => [
      {
        accessorKey: "title",
        header: ({ column }) => <DataTableColumnHeader column={column} title="Goal" />,
        cell: ({ row }) => {
          const goal = row.original;
          return (
            <div className={styles.formatDurationContainer4}>
              <CreateGoalModal
                companyId={companyId!}
                agents={agents.map((a) => ({ id: a.id, name: a.name }))}
                allGoals={goals.map((g) => ({
                  id: g.id,
                  title: g.title,
                  level: g.level,
                  projectId: g.projectId,
                  parentGoalId: g.parentGoalId
                }))}
                goal={{
                  id: goal.id,
                  level: goal.level as "company" | "project" | "agent",
                  title: goal.title,
                  description: goal.description ?? null,
                  status: goal.status,
                  ownerAgentId: goal.ownerAgentId ?? null,
                  projectId: goal.projectId,
                  parentGoalId: goal.parentGoalId
                }}
                trigger={
                  <button type="button" className={cn("ui-link-medium text-left", styles.formatDurationContainer1)}>
                    {goal.title}
                  </button>
                }
              />
            </div>
          );
        }
      },
      {
        accessorKey: "level",
        header: ({ column }) => <DataTableColumnHeader column={column} title="Level" />,
        cell: ({ row }) => (
          <Badge variant="outline" className={getGoalLevelBadgeClassName(row.original.level)}>
            {row.original.level}
          </Badge>
        )
      },
      {
        id: "parentGoal",
        header: ({ column }) => <DataTableColumnHeader column={column} title="Parent goal" />,
        accessorFn: (row) => {
          const pid = row.parentGoalId?.trim();
          if (!pid) {
            return "";
          }
          return goals.find((g) => g.id === pid)?.title ?? pid;
        },
        cell: ({ row }) => {
          const pid = row.original.parentGoalId?.trim();
          if (!pid) {
            return (
              <div className={cn(styles.formatDurationContainer1, "text-muted-foreground")}>No goal</div>
            );
          }
          const parent = goals.find((g) => g.id === pid);
          const label = parent?.title?.trim() || pid;
          return (
            <div className={styles.formatDurationContainer1} title={label}>
              {label}
            </div>
          );
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
      }
    ],
    [agents, companyId, goals]
  );

  const agentColumns = useMemo<ColumnDef<AgentRow>[]>(
    () => [
      {
        accessorKey: "name",
        header: ({ column }) => <DataTableColumnHeader column={column} title="Agent" />,
        cell: ({ row }) => (
          <div className={styles.agentTableIdentity}>
            <AgentAvatar
              seed={agentAvatarSeed(row.original.id, row.original.name, row.original.avatarSeed)}
              name={row.original.name}
              className={styles.agentTableAvatar}
              size={64}
              lucideIconName={row.original.lucideIconName}
            />
            <Link
              href={`/agents/${row.original.id}?companyId=${companyId || ""}` as Route}
              className={styles.renderSectionActionsLink}
            >
              {row.original.name}
            </Link>
          </div>
        )
      },
      {
        accessorKey: "role",
        header: ({ column }) => <DataTableColumnHeader column={column} title="Role" />,
        accessorFn: (row) => getAgentDisplayRole(row),
        cell: ({ row }) => <span>{getAgentDisplayRole(row.original)}</span>
      },
      {
        id: "monthlyBudgetUsd",
        header: ({ column }) => <DataTableColumnHeader column={column} title="Budget" />,
        accessorFn: (row) => row.monthlyBudgetUsd ?? 0,
        cell: ({ row }) => <div className={styles.formatDurationContainer1}>{formatUsdCost(row.original.monthlyBudgetUsd ?? 0)}</div>
      },
      {
        id: "reportTo",
        accessorFn: (row) => (row.managerAgentId ? (agentNameById.get(row.managerAgentId) ?? "Unknown") : "None"),
        header: ({ column }) => <DataTableColumnHeader column={column} title="Report to" />,
        cell: ({ row }) => {
          const managerId = row.original.managerAgentId;
          if (!managerId) {
            return <span>None</span>;
          }
          const managerName = agentNameById.get(managerId);
          if (!managerName) {
            return <span>Unknown</span>;
          }
          return (
            <Link href={`/agents/${managerId}?companyId=${companyId || ""}` as Route} className={styles.renderSectionActionsLink}>
              {managerName}
            </Link>
          );
        }
      },
      {
        id: "runtimeModel",
        accessorFn: (row) => resolveNamedModelForAgent(row) ?? "",
        header: ({ column }) => <DataTableColumnHeader column={column} title="Model" />,
        cell: ({ row }) => {
          const model = resolveNamedModelForAgent(row.original);
          return <div className={styles.formatDurationContainer1}>{model ?? "-"}</div>;
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
      }
    ],
    [agentNameById, companyId]
  );

  const approvalColumns = useMemo<ColumnDef<ApprovalRow>[]>(
    () => [
      {
        accessorKey: "action",
        header: ({ column }) => <DataTableColumnHeader column={column} title="Action" />,
        cell: ({ row }) => <div className={styles.formatDurationContainer1}>{row.original.action}</div>
      },
      {
        accessorKey: "status",
        header: ({ column }) => <DataTableColumnHeader column={column} title="Status" />,
        cell: ({ row }) => <Badge variant="outline" className={getStatusBadgeClassName(row.original.status)}>{row.original.status}</Badge>
      },
      {
        id: "payload",
        header: "Payload",
        cell: ({ row }) => <div className={styles.formatDurationContainer5}>{describeApprovalPayload(row.original.payload)}</div>
      },
      {
        accessorKey: "createdAt",
        header: ({ column }) => <DataTableColumnHeader column={column} title="Created" />,
        cell: ({ row }) => <div className={styles.formatDurationContainer5}>{formatDateTime(row.original.createdAt)}</div>
      },
      {
        id: "actions",
        header: () => <div className={styles.tableHeaderAlignRight}>Actions</div>,
        enableSorting: false,
        cell: ({ row }) =>
          row.original.status === "pending" ? (
            <div className={styles.formatDurationContainer3}>
              <ConfirmActionModal
                triggerLabel="Approve"
                triggerVariant="outline"
                triggerSize="sm"
                title="Approve request?"
                description="Apply the queued change to the control plane."
                details={formatApprovalPayloadDetails(row.original.payload)}
                confirmLabel="Approve"
                onConfirm={() => resolveApproval(row.original.id, "approved")}
                triggerDisabled={isActionPending(`approval:${row.original.id}:resolve`)}
              />
              <ConfirmActionModal
                triggerLabel="Reject"
                triggerVariant="outline"
                title="Reject request?"
                description="Reject this governance request."
                details={formatApprovalPayloadDetails(row.original.payload)}
                confirmLabel="Reject"
                onConfirm={() => resolveApproval(row.original.id, "rejected")}
                triggerDisabled={isActionPending(`approval:${row.original.id}:resolve`)}
              />
              <ConfirmActionModal
                triggerLabel="Override"
                triggerVariant="outline"
                title="Override request?"
                description="Mark the request as overridden without applying it."
                details={formatApprovalPayloadDetails(row.original.payload)}
                confirmLabel="Override"
                onConfirm={() => resolveApproval(row.original.id, "overridden")}
                triggerDisabled={isActionPending(`approval:${row.original.id}:resolve`)}
              />
            </div>
          ) : (
            <span className={styles.formatDurationLabel}>Resolved</span>
          )
      }
    ],
    [isActionPending]
  );

  const inboxColumns = useMemo<ColumnDef<GovernanceInboxRow>[]>(
    () => [
      {
        id: "action",
        accessorFn: (row) => row.approval.action,
        header: ({ column }) => <DataTableColumnHeader column={column} title="Action" />,
        cell: ({ row }) => <div className={styles.formatDurationContainer1}>{row.original.approval.action}</div>
      },
      {
        id: "status",
        accessorFn: (row) => row.approval.status,
        header: ({ column }) => <DataTableColumnHeader column={column} title="Status" />,
        cell: ({ row }) => (
          <div className={styles.formatDurationContainer3}>
            <Badge variant="outline" className={getStatusBadgeClassName(row.original.approval.status)}>
              {row.original.approval.status}
            </Badge>
            {!row.original.seenAt ? <Badge variant="outline">Unseen</Badge> : null}
            {row.original.dismissedAt ? <Badge variant="outline">Dismissed</Badge> : null}
          </div>
        )
      },
      {
        id: "payload",
        header: "Payload",
        cell: ({ row }) => <div className={styles.formatDurationContainer5}>{describeApprovalPayload(row.original.approval.payload)}</div>
      },
      {
        id: "createdAt",
        accessorFn: (row) => row.approval.createdAt,
        header: ({ column }) => <DataTableColumnHeader column={column} title="Created" />,
        cell: ({ row }) => <div className={styles.formatDurationContainer5}>{formatDateTime(row.original.approval.createdAt)}</div>
      },
      {
        id: "resolvedAt",
        accessorFn: (row) => row.approval.resolvedAt ?? "",
        header: ({ column }) => <DataTableColumnHeader column={column} title="Resolved" />,
        cell: ({ row }) => (
          <div className={styles.formatDurationContainer5}>
            {row.original.approval.resolvedAt ? formatDateTime(row.original.approval.resolvedAt) : "Pending"}
          </div>
        )
      },
      {
        id: "actions",
        header: () => <div className={styles.tableHeaderAlignRight}>Actions</div>,
        enableSorting: false,
        cell: ({ row }) => (
          <div className={styles.formatDurationContainer3}>
            {!row.original.seenAt ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => markInboxSeen(row.original.approval.id)}
                disabled={isActionPending(`inbox:${row.original.approval.id}:seen`)}
              >
                Mark seen
              </Button>
            ) : null}
            {!row.original.dismissedAt ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => dismissInboxItem(row.original.approval.id)}
                disabled={isActionPending(`inbox:${row.original.approval.id}:dismiss`)}
              >
                Dismiss
              </Button>
            ) : (
              <Button
                variant="outline"
                size="sm"
                onClick={() => undismissInboxItem(row.original.approval.id)}
                disabled={isActionPending(`inbox:${row.original.approval.id}:undismiss`)}
              >
                Restore
              </Button>
            )}
            <Button asChild variant="outline" size="sm">
              <Link href={{ pathname: "/inbox", query: { companyId: companyId!, preset: "board-decisions" } }}>
                Open
              </Link>
            </Button>
          </div>
        )
      }
    ],
    [companyId, isActionPending]
  );

  const attentionColumns = useMemo<ColumnDef<AttentionRow>[]>(
    () => [
      {
        accessorKey: "title",
        header: ({ column }) => <DataTableColumnHeader column={column} title="Item" />,
        cell: ({ row }) => {
          const focusedContext = formatAttentionContextSummary(row.original.contextSummary);
          return (
            <div className={styles.formatDurationContainer5} title={row.original.contextSummary}>
              <div className={styles.formatDurationContainer1}>{row.original.title}</div>
              <div className={styles.attentionItemContext}>{focusedContext}</div>
            </div>
          );
        }
      },
      {
        id: "category",
        accessorFn: (row) => row.category,
        header: ({ column }) => <DataTableColumnHeader column={column} title="Category" />,
        cell: ({ row }) => <Badge variant="outline">{formatAttentionCategoryLabel(row.original.category)}</Badge>
      },
      {
        id: "severity",
        accessorFn: (row) => row.severity,
        header: ({ column }) => <DataTableColumnHeader column={column} title="Severity" />,
        cell: ({ row }) => (
          <Badge variant="outline" className={getStatusBadgeClassName(row.original.severity === "critical" ? "failed" : row.original.severity)}>
            {row.original.severity}
          </Badge>
        )
      },
      {
        id: "source",
        accessorFn: (row) => row.sourceTimestamp,
        header: ({ column }) => <DataTableColumnHeader column={column} title="Updated" />,
        cell: ({ row }) => <div className={styles.formatDurationContainer5}>{formatDateTime(row.original.sourceTimestamp)}</div>
      },
      {
        id: "actions",
        header: () => <div className={styles.tableHeaderAlignRight}>Actions</div>,
        enableSorting: false,
        cell: ({ row }) => {
          const linkedApproval =
            row.original.category === "approval_required" && row.original.evidence.approvalId
              ? approvalById.get(row.original.evidence.approvalId)
              : undefined;
          const hasApprovalPrimaryAction = linkedApproval?.status === "pending" && Boolean(row.original.evidence.approvalId);
          const hasLinkPrimaryAction = !hasApprovalPrimaryAction && Boolean(row.original.actionLabel && row.original.actionHref);

          return (
            <div className={styles.formatDurationContainer3} onClick={(event) => event.stopPropagation()}>
              {hasApprovalPrimaryAction ? (
                <ConfirmActionModal
                  triggerLabel="Approve"
                  triggerVariant="primary"
                  triggerSize="sm"
                  title="Approve request?"
                  description="Apply the queued change to the control plane."
                  details={formatApprovalPayloadDetails(linkedApproval?.payload)}
                  confirmLabel="Approve"
                  onConfirm={() => resolveApproval(row.original.evidence.approvalId!, "approved")}
                  triggerDisabled={isActionPending(`approval:${row.original.evidence.approvalId}:resolve`)}
                />
              ) : null}
              {hasLinkPrimaryAction ? (
                <Button asChild variant="outline" size="sm">
                  <a href={toAttentionActionHref(row.original.actionHref, companyId)}>{row.original.actionLabel}</a>
                </Button>
              ) : null}
              {row.original.state !== "dismissed" ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => dismissAttention(row.original.key)}
                  disabled={isActionPending(`attention:${row.original.key}:dismiss`)}
                >
                  Dismiss
                </Button>
              ) : null}
            </div>
          );
        }
      }
    ],
    [approvalById, companyId, isActionPending]
  );

  const auditColumns = useMemo<ColumnDef<AuditRow>[]>(
    () => [
      {
        accessorKey: "eventType",
        header: ({ column }) => <DataTableColumnHeader column={column} title="Event" />,
        cell: ({ row }) => (
          <div className={styles.formatDurationContainer1} title={row.original.eventType}>
            {formatAuditEventLabel(row.original, (id) => agentNameById.get(id))}
          </div>
        )
      },
      {
        id: "entity",
        header: "Entity",
        cell: ({ row }) => (
          <div className={styles.formatDurationContainer5}>
            {row.original.entityType} · {shortId(row.original.entityId)}
          </div>
        )
      },
      {
        accessorKey: "createdAt",
        header: ({ column }) => <DataTableColumnHeader column={column} title="Created" />,
        cell: ({ row }) => (
          <time
            className={cn(styles.formatDurationContainer5, "tabular-nums")}
            dateTime={row.original.createdAt}
            title={formatDateTime(row.original.createdAt)}
          >
            {formatSmartDateTime(row.original.createdAt)}
          </time>
        )
      }
    ],
    [agentNameById]
  );

  const heartbeatRunColumns = useMemo<ColumnDef<HeartbeatRunRow>[]>(
    () => [
      {
        accessorKey: "id",
        header: ({ column }) => <DataTableColumnHeader column={column} title="Run" />,
        cell: ({ row }) => (
          <Link
            className={`${styles.formatDurationContainer1} ${styles.runIdLink}`}
            href={{ pathname: `/runs/${row.original.id}` as Route, query: { companyId: companyId ?? undefined } }}
            onClick={(event) => event.stopPropagation()}
          >
            {shortId(row.original.id)}
          </Link>
        )
      },
      {
        id: "agent",
        header: "Agent",
        cell: ({ row }) => {
          const runAgent = agentById.get(row.original.agentId);
          const runAgentName = runAgent?.name ?? agentNameById.get(row.original.agentId) ?? shortId(row.original.agentId);
          return (
            <div className={styles.agentTableIdentity}>
              <AgentAvatar
                seed={agentAvatarSeed(row.original.agentId, runAgentName, runAgent?.avatarSeed)}
                name={runAgentName}
                className={styles.agentTableAvatar}
                lucideIconName={runAgent?.lucideIconName}
              />
              <span className={styles.formatDurationContainer5}>{runAgentName}</span>
            </div>
          );
        }
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
          <div className={styles.formatDurationContainer5}>{formatDuration(row.original.startedAt, row.original.finishedAt)}</div>
        )
      },
      {
        accessorKey: "startedAt",
        header: ({ column }) => <DataTableColumnHeader column={column} title="Started" />,
        cell: ({ row }) => (
          <time
            className={cn(styles.formatDurationContainer5, "tabular-nums")}
            dateTime={row.original.startedAt}
            title={formatDateTime(row.original.startedAt)}
          >
            {formatSmartDateTime(row.original.startedAt, { includeSeconds: true })}
          </time>
        )
      },
      {
        id: "actions",
        header: () => <div className={styles.tableHeaderAlignRight}>Actions</div>,
        enableSorting: false,
        cell: ({ row }) => (
          <div className={styles.formatDurationContainer3}>
            {row.original.status === "started" ? (
              <Button
                size="sm"
                variant="destructive"
                disabled={isActionPending(`run:${row.original.id}:stop`)}
                onClick={() => {
                  if (window.confirm("Stop this run now?")) {
                    void stopHeartbeatRunById(row.original.id);
                  }
                }}
              >
                {isActionPending(`run:${row.original.id}:stop`) ? "Stopping..." : "Stop"}
              </Button>
            ) : (
              <>
                {isStoppedRun(row.original, runDetailsByRunId.get(row.original.id)) ? (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={isActionPending(`run:${row.original.id}:resume`) || isActionPending(`run:${row.original.id}:redo`)}
                    onClick={() => void resumeHeartbeatRunById(row.original.id)}
                  >
                    {isActionPending(`run:${row.original.id}:resume`) ? "Resuming..." : "Resume"}
                  </Button>
                ) : null}
                <Button
                  size="sm"
                  variant="outline"
                  disabled={isActionPending(`run:${row.original.id}:redo`) || isActionPending(`run:${row.original.id}:resume`)}
                  onClick={() => {
                    if (
                      window.confirm("Redo from scratch? This starts a new run without previous session context.")
                    ) {
                      void redoHeartbeatRunById(row.original.id);
                    }
                  }}
                >
                  {isActionPending(`run:${row.original.id}:redo`) ? "Starting..." : "Redo"}
                </Button>
              </>
            )}
          </div>
        )
      }
    ],
    [agentById, agentNameById, isActionPending, runDetailsByRunId]
  );

  const costColumns = useMemo<ColumnDef<CostRow>[]>(
    () => [
      {
        accessorKey: "providerType",
        header: ({ column }) => <DataTableColumnHeader column={column} title="Provider" />,
        cell: ({ row }) => <div className={styles.formatDurationContainer1}>{row.original.providerType}</div>
      },
      {
        id: "modelId",
        accessorFn: (row) => row.runtimeModelId ?? row.pricingModelId ?? "",
        header: ({ column }) => <DataTableColumnHeader column={column} title="Model" />,
        cell: ({ row }) => (
          <div className={styles.formatDurationContainer1}>{row.original.runtimeModelId ?? row.original.pricingModelId ?? "-"}</div>
        )
      },
      {
        accessorKey: "tokenInput",
        header: ({ column }) => <DataTableColumnHeader column={column} title="Input tokens" />,
        cell: ({ row }) => <div className={styles.formatDurationContainer5}>{row.original.tokenInput.toLocaleString()}</div>
      },
      {
        accessorKey: "tokenOutput",
        header: ({ column }) => <DataTableColumnHeader column={column} title="Output tokens" />,
        cell: ({ row }) => <div className={styles.formatDurationContainer5}>{row.original.tokenOutput.toLocaleString()}</div>
      },
      {
        accessorKey: "usdCost",
        header: ({ column }) => <DataTableColumnHeader column={column} title="Cost" />,
        cell: ({ row }) => <div className={styles.formatDurationContainer5}>{formatUsdCost(row.original.usdCost)}</div>
      },
      {
        id: "scope",
        header: "Scope",
        cell: ({ row }) => (
          <div className={styles.formatDurationContainer5}>
            {row.original.agentId && companyId ? (
              <Link href={`/agents/${row.original.agentId}?companyId=${companyId}` as Route}>
                {`Agent`}
              </Link>
            ) : (
              "agent:unscoped"
            )}
            {row.original.issueId && companyId ? (
              <>
                {" · "}
                <Link href={`/issues/${row.original.issueId}?companyId=${companyId}` as Route}>
                  {`Issue`}
                </Link>
              </>
            ) : null}
          </div>
        )
      },
      {
        accessorKey: "createdAt",
        header: ({ column }) => <DataTableColumnHeader column={column} title="Created" />,
        cell: ({ row }) => (
          <time
            className={cn(styles.formatDurationContainer5, "tabular-nums")}
            dateTime={row.original.createdAt}
            title={formatDateTime(row.original.createdAt)}
          >
            {formatSmartDateTime(row.original.createdAt)}
          </time>
        )
      }
    ],
    [companyId]
  );

  const companyColumns = useMemo<ColumnDef<CompanyRow>[]>(
    () => [
      {
        accessorKey: "name",
        header: ({ column }) => <DataTableColumnHeader column={column} title="Company" />,
        cell: ({ row }) => <div className={styles.formatDurationContainer1}>{row.original.name}</div>
      },
      {
        accessorKey: "mission",
        header: "Mission",
        cell: ({ row }) => (
          <div className={styles.formatDurationContainer2}>{row.original.mission ?? "No mission"}</div>
        )
      },
      {
        id: "actions",
        header: "Actions",
        enableSorting: false,
        cell: ({ row }) => {
          const company = row.original;
          return (
            <div className={styles.formatDurationContainer3}>
              <TextActionModal
                triggerLabel="Edit"
                title="Edit company"
                description="Update the company name."
                submitLabel="Save"
                initialValue={company.name}
                placeholder="Company name"
                onSubmit={(nextName) =>
                  runCrudAction(
                    async () => {
                      await apiPut(`/companies/${company.id}`, companyId!, { name: nextName });
                    },
                    "Failed to update company."
                  )
                }
              />
              <ConfirmActionModal
                triggerLabel="Delete"
                title="Delete company?"
                description={`Delete "${company.name}".`}
                confirmLabel="Delete"
                onConfirm={() => removeCompany(company)}
                triggerDisabled={isActionPending(`company:${company.id}:delete`)}
              />
            </div>
          );
        }
      }
    ],
    [companyId, isActionPending]
  );
  const pluginColumns = useMemo<ColumnDef<PluginRow>[]>(
    () => [
      {
        accessorKey: "name",
        header: ({ column }) => <DataTableColumnHeader column={column} title="Plugin" />,
        cell: ({ row }) => {
          const plugin = row.original;
          return (
            <div className={styles.workspaceSectionCellStack}>
              <div className={styles.workspaceSectionCellPrimary}>{plugin.name}</div>
            </div>
          );
        }
      },
      {
        accessorKey: "version",
        header: ({ column }) => <DataTableColumnHeader column={column} title="Version" />,
        cell: ({ row }) => <div className={styles.formatDurationContainer5}>{row.original.version}</div>
      },
      {
        accessorKey: "kind",
        header: ({ column }) => <DataTableColumnHeader column={column} title="Kind" />,
        cell: ({ row }) => <div className={styles.formatDurationContainer5}>{row.original.kind}</div>
      },
      {
        accessorKey: "capabilities",
        header: "Capabilities",
        cell: ({ row }) => {
          const plugin = row.original;
          return (
            <div className={styles.workspaceSectionBadges}>
              {plugin.capabilities.length > 0 ? (
                plugin.capabilities.map((capability) => (
                  <Badge key={`${plugin.id}-${capability}`} variant="outline">
                    {capability}
                  </Badge>
                ))
              ) : (
                <span className={styles.workspaceSectionMutedText}>-</span>
              )}
            </div>
          );
        }
      },
      {
        id: "status",
        header: "Status",
        cell: ({ row }) => {
          const plugin = row.original;
          if (!plugin.companyConfig) {
            return <Badge variant="outline">Not installed</Badge>;
          }
          return plugin.companyConfig.enabled ? <Badge>Active</Badge> : <Badge variant="secondary">Installed</Badge>;
        }
      },
      {
        id: "actions",
        header: () => <div className={styles.tableHeaderAlignRight}>Actions</div>,
        cell: ({ row }) => {
          const plugin = row.original;
          const activateActionKey = `plugin:${plugin.id}:activate`;
          const deactivateActionKey = `plugin:${plugin.id}:deactivate`;
          return (
            <div className={styles.formatDurationContainer3}>
              {plugin.companyConfig ? (
                plugin.companyConfig.enabled ? (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={isActionPending(deactivateActionKey)}
                    onClick={() => setPluginEnabled(plugin, false)}
                  >
                    Deactivate
                  </Button>
                ) : (
                  <Button
                    variant="default"
                    size="sm"
                    disabled={isActionPending(activateActionKey)}
                    onClick={() => setPluginEnabled(plugin, true)}
                  >
                    Activate
                  </Button>
                )
              ) : null}
              {plugin.companyConfig?.enabled ? (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={isActionPending(`plugin:${plugin.id}:health`)}
                  onClick={() => checkPluginHealth(plugin.id)}
                >
                  Health
                </Button>
              ) : null}
              {plugin.companyConfig?.enabled ? (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={
                    isActionPending(`plugin:${plugin.id}:rollback`) || (plugin.installRevisionCount ?? 0) < 2
                  }
                  title={
                    (plugin.installRevisionCount ?? 0) < 2
                      ? "Rollback needs at least two recorded installs (e.g. two registry upgrades). Filesystem plugins have no install history until you install or upgrade from the registry."
                      : undefined
                  }
                  onClick={() => rollbackPlugin(plugin.id)}
                >
                  Rollback
                </Button>
              ) : null}
              <ConfirmActionModal
                triggerLabel="Delete"
                triggerVariant="outline"
                triggerSize="sm"
                title="Delete plugin?"
                description={`Delete "${plugin.name}" from catalog and remove its plugin folder/file from disk.`}
                confirmLabel="Delete"
                onConfirm={() => deletePlugin(plugin.id)}
                triggerDisabled={isActionPending(`plugin:${plugin.id}:delete`)}
              />
            </div>
          );
        }
      }
    ],
    [checkPluginHealth, deletePlugin, isActionPending, rollbackPlugin, setPluginEnabled]
  );
  const templateColumns = useMemo<ColumnDef<TemplateRow>[]>(
    () => [
      {
        accessorKey: "name",
        header: ({ column }) => <DataTableColumnHeader column={column} title="Template" />,
        cell: ({ row }) => {
          const template = row.original;
          return (
            <div className={styles.workspaceSectionCellStack}>
              <div className={styles.workspaceSectionCellPrimary}>{template.name}</div>
            </div>
          );
        }
      },
      {
        accessorKey: "currentVersion",
        header: ({ column }) => <DataTableColumnHeader column={column} title="Version" />,
        cell: ({ row }) => <div className={styles.formatDurationContainer5}>{row.original.currentVersion}</div>
      },
      {
        accessorKey: "status",
        header: ({ column }) => <DataTableColumnHeader column={column} title="Status" />,
        cell: ({ row }) => <Badge variant="outline">{row.original.status}</Badge>
      },
      {
        accessorKey: "visibility",
        header: ({ column }) => <DataTableColumnHeader column={column} title="Visibility" />,
        cell: ({ row }) => <div className={styles.formatDurationContainer5}>{row.original.visibility}</div>
      },
      {
        id: "actions",
        header: () => <div className={styles.tableHeaderAlignRight}>Actions</div>,
        cell: ({ row }) => {
          const template = row.original;
          const applyActionKey = `template:${template.id}:apply`;
          const applyPending = isActionPending(applyActionKey);
          return (
            <div className={styles.formatDurationContainer3}>
              <Button
                variant="default"
                size="sm"
                disabled={applyPending}
                onClick={() => applyTemplate(template.id)}
              >
                {applyPending ? "Importing..." : "Import"}
              </Button>
              <Button variant="outline" size="sm" onClick={() => openTemplateDetails(template)}>
                View
              </Button>
            </div>
          );
        }
      }
    ],
    [applyTemplate, isActionPending]
  );

  function renderSectionActions(section: SectionLabel) {
    if (!companyId && section !== "Settings") {
      return null;
    }

    const scopedCompanyId = companyId ?? "bootstrap-company";

    switch (section) {
      case "Dashboard":
        return (
          <div className={styles.renderSectionActionsContainer1}>
            <CreateProjectModal companyId={scopedCompanyId} goals={goals} />
            <CreateIssueModal
              companyId={scopedCompanyId}
              projects={projects}
              agents={agents}
              goals={goals.map((g) => ({ id: g.id, title: g.title, projectId: g.projectId }))}
            />
          </div>
        );
      case "Projects":
        return (
          <div className={styles.renderSectionActionsContainer1}>
            <CreateProjectModal companyId={scopedCompanyId} goals={goals} />
            <CreateIssueModal
              companyId={scopedCompanyId}
              projects={projects}
              agents={agents}
              goals={goals.map((g) => ({ id: g.id, title: g.title, projectId: g.projectId }))}
            />
          </div>
        );
      case "Issues":
        return (
          <div className={styles.renderSectionActionsContainer1}>
            <CreateIssueModal
              companyId={scopedCompanyId}
              projects={projects}
              agents={agents}
              goals={goals.map((g) => ({ id: g.id, title: g.title, projectId: g.projectId }))}
            />
            <CreateProjectModal companyId={scopedCompanyId} goals={goals} />
          </div>
        );
      case "Goals":
        return (
          <div className={styles.renderSectionActionsContainer1}>
            <CreateGoalModal
              companyId={scopedCompanyId}
              agents={agents.map((a) => ({ id: a.id, name: a.name }))}
              allGoals={goals.map((g) => ({
                id: g.id,
                title: g.title,
                level: g.level,
                projectId: g.projectId,
                parentGoalId: g.parentGoalId
              }))}
            />
          </div>
        );
      case "Agents":
      case "Organization":
        return (
          <div className={styles.renderSectionActionsContainer1}>
            <CreateAgentModal
              companyId={scopedCompanyId}
              availableAgents={agents.map((entry) => ({ id: entry.id, name: entry.name }))}
              projects={projects.map((project) => ({ id: project.id, name: project.name }))}
              delegateAgentId={hiringDelegate?.agentId ?? ceoAgent?.id ?? null}
              delegateAgentLabel={hiringDelegate?.name ?? ceoAgent?.name ?? undefined}
              suggestedRuntimeCwd={suggestedAgentRuntimeCwd}
              fallbackDefaults={onboardingRuntimeFallback}
            />
          </div>
        );
      case "Templates":
        return (
          <div className={styles.renderSectionActionsContainer1}>
            <Button asChild variant="outline" size="sm">
              <Link href={{ pathname: "/settings/templates", query: { companyId: scopedCompanyId } }}>Open templates</Link>
            </Button>
          </div>
        );
      case "Settings":
        return (
          <div className={styles.renderSectionActionsContainer1}>
            <CreateCompanyModal companyId={scopedCompanyId} />
          </div>
        );
      default:
        return null;
    }
  }

  const emptyWorkspaceState = (
    <>
      <div className={styles.renderSectionActionsContainer1}>
        <CreateCompanyModal companyId="bootstrap-company" />
        <Button asChild variant="outline" size="sm">
          <Link href={{ pathname: "/settings/templates" as Route }}>Browse templates</Link>
        </Button>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>First Run</CardTitle>
          <CardDescription>
            Start by creating a company. Once the company exists, you can add projects, issues, goals, and agents from
            the same workspace without leaving the current view.
          </CardDescription>
        </CardHeader>
        <CardContent className={styles.renderSectionActionsCardContent1}>
          <div>Create a company and define its mission.</div>
          <div>Create a project to give issue work a home.</div>
          <div>Create issues, then hire an agent and approve it from Governance.</div>
        </CardContent>
      </Card>
    </>
  );

  const leftPane = (() => {
    if (!activeCompany || !companyId) {
      return emptyWorkspaceState;
    }

    switch (activeNav) {
      case "Dashboard":
        return (
          <>
            <SectionHeading
              title="Dashboard"
              description="Birds-eye snapshot of company execution, workforce, governance, and spend."
            />
            <Alert variant={dashboardAttentionSummary.critical > 0 ? "destructive" : "default"}>
              <AlertTitle>
                {dashboardAttentionSummary.open === 0
                  ? "All clear"
                  : `Needs attention (${dashboardAttentionSummary.critical} critical / ${dashboardAttentionSummary.warning} warning)`}
              </AlertTitle>
              <AlertDescription>
                {dashboardAttentionSummary.open === 0
                  ? "No active board-level blockers right now."
                  : "Action queue is active. Review top attention items below to keep delivery smooth."}
              </AlertDescription>
            </Alert>
            <div className={styles.dashboardSummaryStats}>
              <MetricCard label="Open work" value={dashboardOpenIssues.length} hint={`${staleIssueCount} stale over 7d`} />
              <MetricCard
                label="Active agents"
                value={agents.filter((agent) => agent.status !== "terminated").length}
                hint={`${dashboardAgentProviderData.length} providers`}
              />
              <MetricCard label="Pending approvals" value={pendingApprovals.length} hint={`Oldest pending: ${oldestPendingApprovalAge}`} />
              <MetricCard
                label="Run success (24h)"
                value={`${dashboardRunHealth.successRate24h.toFixed(0)}%`}
                hint={`${dashboardRunHealth.completedLast24h}/${Math.max(dashboardRunHealth.completedLast24h + dashboardRunHealth.failedLast24h, 1)} completed`}
              />
              <MetricCard label="Spend today" value={formatUsdCost(todayCostSummary.usd)} hint={`${todayCostSummary.input + todayCostSummary.output} tokens`} />
              <MetricCard label="Spend (last 6m)" value={formatUsdCost(dashboardCostTrendData.reduce((sum, row) => sum + row.usd, 0))} hint={topCostAgent} />
            </div>
            {dashboardAgentSnapshots.length > 0 ? (
              <div
                className={cn(
                  styles.dashboardAgentSpotlightGrid,
                  dashboardAgentSnapshots.length === 1 ? styles.dashboardAgentSpotlightGridSingle : null
                )}
              >
                {dashboardAgentSnapshots.map((agentSnapshot) => (
                  <Card key={agentSnapshot.id} className={styles.dashboardAgentSpotlightCard}>
                    <CardHeader>
                      <span
                        className={cn(
                          styles.dashboardAgentStatusDot,
                          agentSnapshot.status === "active" || agentSnapshot.status === "working"
                            ? styles.dashboardAgentStatusDotWorking
                            : styles.dashboardAgentStatusDotIdle
                        )}
                        aria-label={agentSnapshot.status === "active" || agentSnapshot.status === "working" ? "Working" : "Idle"}
                        title={agentSnapshot.status === "active" || agentSnapshot.status === "working" ? "Working" : "Idle"}
                      />
                      <CardTitle>{agentSnapshot.name}</CardTitle>
                      <CardDescription>
                        {agentSnapshot.role} · {agentSnapshot.status.replaceAll("_", " ")}
                      </CardDescription>
                    </CardHeader>
                    <CardContent className={styles.dashboardAgentSpotlightContent}>
                      <div className={styles.dashboardAgentSpotlightStats}>
                        <div className={styles.dashboardAgentSpotlightMetric}>
                          <span>Open assigned</span>
                          <Badge variant="outline">{agentSnapshot.openAssigned}</Badge>
                        </div>
                        <div className={styles.dashboardAgentSpotlightMetric}>
                          <span>Blocked</span>
                          <Badge variant="outline">{agentSnapshot.blockedAssigned}</Badge>
                        </div>
                        <div className={styles.dashboardAgentSpotlightMetric}>
                          <span>Needs approval</span>
                          <Badge variant="outline">{agentSnapshot.needsApproval}</Badge>
                        </div>
                        <div className={styles.dashboardAgentSpotlightMetric}>
                          <span>Runs 24h</span>
                          <Badge variant="outline">{agentSnapshot.runs24h}</Badge>
                        </div>
                        <div className={styles.dashboardAgentSpotlightMetric}>
                          <span>Failed 24h</span>
                          <Badge variant="outline">{agentSnapshot.failed24h}</Badge>
                        </div>
                        <div className={styles.dashboardAgentSpotlightMetric}>
                          <span>Spend 30d</span>
                          <Badge variant="outline">{formatUsdCost(agentSnapshot.spend30d)}</Badge>
                        </div>
                      </div>
                      <ChartContainer config={dashboardAgentTrendConfig} className={styles.dashboardAgentSpotlightChart}>
                        <LineChart accessibilityLayer data={agentSnapshot.trend} margin={{ top: 8, left: -8, right: -8 }}>
                          <CartesianGrid vertical={false} strokeDasharray="4 4" strokeOpacity={0.28} />
                          <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={10} minTickGap={20} />
                          <YAxis hide />
                          <ChartTooltip content={<ChartTooltipContent indicator="line" />} cursor={false} />
                          <Line type="monotone" dataKey="total" stroke="var(--color-total)" strokeWidth={2} dot={false} />
                          <Line type="monotone" dataKey="failed" stroke="var(--color-failed)" strokeWidth={1.8} dot={false} />
                        </LineChart>
                      </ChartContainer>
                    </CardContent>
                  </Card>
                ))}
              </div>
            ) : null}
            <div className={styles.dashboardAttentionGrid}>
              <Card className={styles.dashboardAttentionCard}>
                <CardHeader>
                  <CardTitle>Board action queue</CardTitle>
                  <CardDescription>Prioritized items that need ownership and response.</CardDescription>
                </CardHeader>
                <CardContent className={styles.dashboardActionQueueContent}>
                  {dashboardAttentionPreview.length > 0 ? (
                    <ul className={styles.dashboardApprovalPreviewList}>
                      {dashboardAttentionPreview.map((item) => (
                        <li key={item.key} className={styles.dashboardApprovalPreviewItem}>
                          <div className={styles.dashboardApprovalPreviewTitle}>
                            <span>{item.title}</span>
                            <span>{item.severity}</span>
                          </div>
                          <div className={styles.dashboardApprovalPreviewMeta}>
                            <span title={item.contextSummary}>{formatAttentionContextSummary(item.contextSummary, 96)}</span>
                            <span>{formatRelativeAgeCompact(item.sourceTimestamp)} ago</span>
                          </div>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <div className={styles.dashboardActionQueueEmpty}>No active attention items right now.</div>
                  )}
                  {dashboardAttentionPreview.length > 0 ? (
                    <div className={styles.dashboardActionQueueActions}>
                      <Button asChild size="sm">
                        <Link href={{ pathname: "/inbox", query: { companyId: companyId! } }}>Open inbox queue</Link>
                      </Button>
                    </div>
                  ) : null}
                </CardContent>
              </Card>
              <Card className={styles.dashboardAttentionCard}>
                <CardHeader>
                  <CardTitle>Needs attention now</CardTitle>
                  <CardDescription>Signals likely to slow down delivery if unresolved this cycle.</CardDescription>
                </CardHeader>
                <CardContent className={styles.dashboardAttentionContent}>
                  <div className={styles.dashboardAttentionRow}>
                    <span>Blocked issues</span>
                    <Badge variant="outline">{dashboardNeedsAttention.blockedIssues}</Badge>
                  </div>
                  <div className={styles.dashboardAttentionRow}>
                    <span>Unassigned open issues</span>
                    <Badge variant="outline">{dashboardAssignmentCoverageData.find((entry) => entry.label === "Unassigned")?.total ?? 0}</Badge>
                  </div>
                  <div className={styles.dashboardAttentionRow}>
                    <span>Stale open issues (&gt;7d)</span>
                    <Badge variant="outline">{dashboardNeedsAttention.staleOpenIssues}</Badge>
                  </div>
                  <div className={styles.dashboardAttentionRow}>
                    <span>Failed runs (24h)</span>
                    <Badge variant="outline">{dashboardNeedsAttention.failedRuns24h}</Badge>
                  </div>
                  <div className={styles.dashboardActionQueueActions}>
                    <Button asChild size="sm" variant="outline">
                      <Link href={{ pathname: "/issues", query: { companyId: companyId! } }}>Open issues</Link>
                    </Button>
                    <Button asChild size="sm" variant="outline">
                      <Link href={{ pathname: "/runs", query: { companyId: companyId! } }}>Open runs</Link>
                    </Button>
                  </div>
                </CardContent>
              </Card>
              <Card className={styles.dashboardAttentionCard}>
                <CardHeader>
                  <CardTitle>Live approval queue</CardTitle>
                  <CardDescription>Oldest requests that still need your decision.</CardDescription>
                </CardHeader>
                <CardContent className={styles.dashboardActionQueueContent}>
                  {dashboardPendingApprovalPreview.length > 0 ? (
                    <ul className={styles.dashboardApprovalPreviewList}>
                      {dashboardPendingApprovalPreview.map((item) => (
                        <li key={item.id} className={styles.dashboardApprovalPreviewItem}>
                          <div className={styles.dashboardApprovalPreviewTitle}>
                            <span>{item.actionLabel}</span>
                            <span>{item.ageLabel} ago</span>
                          </div>
                          <div className={styles.dashboardApprovalPreviewMeta}>
                            <span>{item.payloadSummary}</span>
                            <span>requested by {item.requestedBy}</span>
                          </div>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <div className={styles.dashboardActionQueueEmpty}>No pending approvals right now.</div>
                  )}
                  {dashboardPendingApprovalPreview.length > 0 ? (
                    <div className={styles.dashboardActionQueueActions}>
                      <Button asChild size="sm">
                        <Link href={{ pathname: "/inbox", query: { companyId: companyId!, preset: "board-decisions" } }}>Review approvals</Link>
                      </Button>
                      <Button asChild size="sm" variant="outline">
                        <Link href={{ pathname: "/inbox", query: { companyId: companyId! } }}>Open inbox</Link>
                      </Button>
                    </div>
                  ) : null}
                </CardContent>
              </Card>
            </div>
          </>
        );
      case "Projects":
        return (
          <>
            <SectionHeading
              title="Projects"
              description="Groups of issues and their related goals."
              actions={
                <>
                  <CreateProjectModal companyId={companyId} goals={goals} />
                </>
              }
            />
            <DataTable
              columns={projectColumns}
              data={filteredProjects}
              emptyMessage="No projects match current filters."
              toolbarActions={
                <div className="ui-toolbar-filters">
                  <Input
                    value={projectsQuery}
                    onChange={(event) => setProjectsQuery(event.target.value)}
                    placeholder="Search project name or description..."
                    className="ui-toolbar-filter-input"
                  />
                  <Select
                    value={projectsActivityFilter}
                    onValueChange={(value) => setProjectsActivityFilter(value as "all" | "active" | "no_open_issues" | "no_issues")}
                  >
                    <SelectTrigger className="ui-toolbar-filter-select">
                      <SelectValue placeholder="Activity" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All projects</SelectItem>
                      <SelectItem value="active">With open issues</SelectItem>
                      <SelectItem value="no_open_issues">No open issues</SelectItem>
                      <SelectItem value="no_issues">No issues</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              }
            />
          </>
        );
      case "Issues":
        return (
          <IssueWorkspace
            issues={issues}
            agents={agents}
            projects={projects}
            companyId={companyId}
            headerActions={
              <>
                <CreateIssueModal
                  companyId={companyId}
                  projects={projects}
                  agents={agents}
                  goals={goals.map((g) => ({ id: g.id, title: g.title, projectId: g.projectId }))}
                />
              </>
            }
          />
        );
      case "Goals":
        return (
          <>
            <SectionHeading
              title="Goals"
              description="Strategic goals stay attached to the selected company scope."
              actions={
                <CreateGoalModal
                  companyId={companyId}
                  triggerSize="sm"
                  agents={agents.map((a) => ({ id: a.id, name: a.name }))}
                  allGoals={goals.map((g) => ({
                    id: g.id,
                    title: g.title,
                    level: g.level,
                    projectId: g.projectId,
                    parentGoalId: g.parentGoalId
                  }))}
                />
              }
            />
            <DataTable
              columns={goalColumns}
              data={filteredGoals}
              emptyMessage="No goals match current filters."
              toolbarActions={
                <div className="ui-toolbar-filters">
                  <Input
                    value={goalsQuery}
                    onChange={(event) => setGoalsQuery(event.target.value)}
                    placeholder="Search title, description, status, level, project, or parent goal..."
                    className="ui-toolbar-filter-input"
                  />
                  <Select value={goalsStatusFilter} onValueChange={setGoalsStatusFilter}>
                    <SelectTrigger className="ui-toolbar-filter-select">
                      <SelectValue placeholder="Status" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All statuses</SelectItem>
                      {goalStatusOptions.map((status) => (
                        <SelectItem key={status.value} value={status.value}>
                          {status.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Select value={goalsLevelFilter} onValueChange={setGoalsLevelFilter}>
                    <SelectTrigger className="ui-toolbar-filter-select">
                      <SelectValue placeholder="Level" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All levels</SelectItem>
                      {goalsLevelOptions.map((level) => (
                        <SelectItem key={level} value={level}>
                          {level}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Select value={goalsParentFilter} onValueChange={setGoalsParentFilter}>
                    <SelectTrigger className="ui-toolbar-filter-select">
                      <SelectValue placeholder="Parent goal" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All parent goals</SelectItem>
                      <SelectItem value="no_parent">No parent goal</SelectItem>
                      {goalsParentFilterOptions.map((p) => (
                        <SelectItem key={p.id} value={p.id}>
                          {p.title}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              }
            />
          </>
        );
      case "Agents":
        return (
          <>
            <SectionHeading
              title="Agents"
              description="Your AI workforce."
              actions={
                <CreateAgentModal
                  companyId={companyId}
                  availableAgents={agents.map((entry) => ({ id: entry.id, name: entry.name }))}
                  projects={projects.map((project) => ({ id: project.id, name: project.name }))}
                  delegateAgentId={hiringDelegate?.agentId ?? ceoAgent?.id ?? null}
                  delegateAgentLabel={hiringDelegate?.name ?? ceoAgent?.name ?? undefined}
                  suggestedRuntimeCwd={suggestedAgentRuntimeCwd}
                  fallbackDefaults={onboardingRuntimeFallback}
                />
              }
            />
            <>
              {agentsViewMode === "table" ? (
                <DataTable
                  columns={agentColumns}
                  data={filteredAgents}
                  emptyMessage="No agents match current filters."
                  showHorizontalScrollbarOnHover
                  toolbarActions={agentsToolbarFilters}
                  toolbarTrailing={agentsViewToggle}
                />
              ) : agentsViewMode === "cards" ? (
                <div className="ui-data-table">
                  <div className="ui-data-table-toolbar">
                    <div className="ui-data-table-toolbar-actions ui-data-table-toolbar-actions-inline">{agentsToolbarFilters}</div>
                    <div className="ui-data-table-toolbar-actions ui-data-table-toolbar-actions-mobile">
                      <Drawer open={agentsMobileFiltersOpen} onOpenChange={setAgentsMobileFiltersOpen}>
                        <DrawerTrigger asChild>
                          <Button variant="outline" size="sm" className="ui-data-table-mobile-actions-trigger">
                            <SlidersHorizontal />
                            Filters
                          </Button>
                        </DrawerTrigger>
                        <DrawerContent className="ui-mobile-safe-bottom">
                          <DrawerHeader>
                            <DrawerTitle>Filters</DrawerTitle>
                            <DrawerDescription>Refine agents with quick mobile controls.</DrawerDescription>
                          </DrawerHeader>
                          <div className="ui-drawer-filters-body">{agentsToolbarFilters}</div>
                        </DrawerContent>
                      </Drawer>
                    </div>
                    <div className="ui-data-table-toolbar-right">{agentsViewToggle}</div>
                  </div>
                  {filteredAgents.length === 0 ? (
                    <div className="ui-data-table-surface">
                      <div className="ui-data-table-empty-centered">No agents match current filters.</div>
                    </div>
                  ) : (
                    <div className={styles.agentsDirectoryCardGrid}>
                      {filteredAgents.map((agent) => {
                        const managerId = agent.managerAgentId;
                        const managerName = managerId ? agentNameById.get(managerId) : undefined;
                        const model = resolveNamedModelForAgent(agent);
                        const cap = agent.monthlyBudgetUsd ?? 0;
                        const used = agent.usedBudgetUsd ?? 0;
                        const budgetLine =
                          cap > 0 ? `${formatUsdCost(used)} of ${formatUsdCost(cap)}` : `${formatUsdCost(used)} spent · no monthly cap`;
                        return (
                          <Link
                            key={agent.id}
                            href={`/agents/${agent.id}?companyId=${companyId || ""}` as Route}
                            className={styles.agentsDirectoryCardLink}
                          >
                            <Card className={styles.agentsDirectoryCard}>
                              <CardHeader className={styles.agentsDirectoryCardHeader}>
                                <AgentAvatar
                                  seed={agentAvatarSeed(agent.id, agent.name, agent.avatarSeed)}
                                  name={agent.name}
                                  className={styles.agentsDirectoryCardAvatar}
                                  size={56}
                                  lucideIconName={agent.lucideIconName}
                                />
                                <div className={styles.agentsDirectoryCardTitleBlock}>
                                  <CardTitle className={styles.agentsDirectoryCardName}>{agent.name}</CardTitle>
                                  <CardDescription className={styles.agentsDirectoryCardRole}>
                                    {getAgentDisplayRole(agent)}
                                  </CardDescription>
                                </div>
                                <Badge variant="outline" className={cn("ui-shrink-0", getStatusBadgeClassName(agent.status))}>
                                  {agent.status}
                                </Badge>
                              </CardHeader>
                              <CardContent className={styles.agentsDirectoryCardBody}>
                                <div className={styles.agentsDirectoryCardMetaRow}>
                                  <span className={styles.agentsDirectoryCardMetaLabel}>Provider</span>
                                  <span className={styles.agentsDirectoryCardMetaValue}>{agent.providerType}</span>
                                </div>
                                <div className={styles.agentsDirectoryCardMetaRow}>
                                  <span className={styles.agentsDirectoryCardMetaLabel}>Model</span>
                                  <span className={styles.agentsDirectoryCardMetaValue}>{model ?? "—"}</span>
                                </div>
                                <div className={styles.agentsDirectoryCardMetaRow}>
                                  <span className={styles.agentsDirectoryCardMetaLabel}>Report to</span>
                                  <span className={styles.agentsDirectoryCardMetaValue}>
                                    {managerId && managerName ? (
                                      managerName
                                    ) : managerId ? (
                                      "Unknown"
                                    ) : (
                                      "None"
                                    )}
                                  </span>
                                </div>
                                <div className={styles.agentsDirectoryCardMetaRow}>
                                  <span className={styles.agentsDirectoryCardMetaLabel}>Budget</span>
                                  <span className={styles.agentsDirectoryCardMetaValue}>{budgetLine}</span>
                                </div>
                              </CardContent>
                            </Card>
                          </Link>
                        );
                      })}
                    </div>
                  )}
                </div>
              ) : (
                <div className="ui-data-table">
                  <div className="ui-data-table-toolbar">
                    <div className="ui-data-table-toolbar-actions ui-data-table-toolbar-actions-inline">{agentsToolbarFilters}</div>
                    <div className="ui-data-table-toolbar-actions ui-data-table-toolbar-actions-mobile">
                      <Drawer open={agentsMobileFiltersOpen} onOpenChange={setAgentsMobileFiltersOpen}>
                        <DrawerTrigger asChild>
                          <Button variant="outline" size="sm" className="ui-data-table-mobile-actions-trigger">
                            <SlidersHorizontal />
                            Filters
                          </Button>
                        </DrawerTrigger>
                        <DrawerContent className="ui-mobile-safe-bottom">
                          <DrawerHeader>
                            <DrawerTitle>Filters</DrawerTitle>
                            <DrawerDescription>Refine agents with quick mobile controls.</DrawerDescription>
                          </DrawerHeader>
                          <div className="ui-drawer-filters-body">{agentsToolbarFilters}</div>
                        </DrawerContent>
                      </Drawer>
                    </div>
                    <div className="ui-data-table-toolbar-right">{agentsViewToggle}</div>
                  </div>
                  {filteredAgents.length === 0 ? (
                    <div className="ui-data-table-surface">
                      <div className="ui-data-table-empty-centered">No agents match current filters.</div>
                    </div>
                  ) : (
                    <>
                      {/* Same filters as table/cards; managers outside filteredAgents appear as extra roots (OrgChart orphan banner). */}
                      <OrgChart
                        agents={filteredAgents}
                        embedded
                        onAgentSelect={(agentId) => router.push(`/agents/${agentId}?companyId=${companyId || ""}` as Route)}
                      />
                    </>
                  )}
                </div>
              )}
            </>
          </>
        );
      case "Organization":
        return (
          <>
          <SectionHeading
              title="Organization"
              description="The org chart of the company's agents."
            />
            <OrgChart
              agents={agents}
              onAgentSelect={(agentId) => router.push(`/agents/${agentId}?companyId=${companyId || ""}` as Route)}
            />
          </>
        );
      case "Inbox":
        return (
          <>
            <SectionHeading
              title="Inbox"
              description="Unified board action queue for approvals, blockers, budget hard-stops, and escalations."
            />
            <div className="ui-stats">
              <MetricCard label="Attention items" value={attentionSummary.total} />
              <MetricCard label="Open queue" value={attentionSummary.open} />
              <MetricCard label="Critical / Warnings" value={`${attentionSummary.critical} / ${attentionSummary.unresolvedWarnings}`} />
              <MetricCard label="Unresolved now" value={attentionSummary.unresolved} />
            </div>
            <SectionHeading title="Attention items" description="Unified board action queue for approvals, blockers, budget hard-stops, and escalations." />
            <DataTable
              columns={attentionColumns}
              data={filteredAttentionItems}
              emptyMessage="No attention items match current filters."
              onRowClick={(item) => {
                setSelectedAttentionItem(item);
                setAttentionPayloadExpanded(false);
                setAttentionDetailsOpen(true);
              }}
              toolbarActions={
                <div className={styles.governanceFiltersCardContent}>
                  <Input
                    value={inboxQuery}
                    onChange={(event) => setInboxQuery(event.target.value)}
                    placeholder="Search title, context, category, or action..."
                    className={styles.governanceFiltersInput}
                  />
                  <Select
                    value={attentionStateFilter}
                    onValueChange={(value) =>
                      setAttentionStateFilter(value as "all" | "open" | "acknowledged" | "dismissed" | "resolved")
                    }
                  >
                    <SelectTrigger className={styles.governanceFiltersSelect}>
                      <SelectValue placeholder="State" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All states</SelectItem>
                      <SelectItem value="open">Open</SelectItem>
                      <SelectItem value="acknowledged">Acknowledged</SelectItem>
                      <SelectItem value="dismissed">Dismissed</SelectItem>
                      <SelectItem value="resolved">Resolved</SelectItem>
                    </SelectContent>
                  </Select>
                  <Select
                    value={attentionSeverityFilter}
                    onValueChange={(value) => setAttentionSeverityFilter(value as "all" | "critical" | "warning" | "info")}
                  >
                    <SelectTrigger className={styles.governanceFiltersSelect}>
                      <SelectValue placeholder="Severity" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All severities</SelectItem>
                      <SelectItem value="critical">Critical</SelectItem>
                      <SelectItem value="warning">Warning</SelectItem>
                      <SelectItem value="info">Info</SelectItem>
                    </SelectContent>
                  </Select>
                  <Select
                    value={attentionCategoryFilter}
                    onValueChange={(value) =>
                      setAttentionCategoryFilter(
                        value as "all" | "approval_required" | "blocker_escalation" | "budget_hard_stop" | "stalled_work" | "run_failure_spike" | "board_mentioned_comment"
                      )
                    }
                  >
                    <SelectTrigger className={styles.governanceFiltersSelect}>
                      <SelectValue placeholder="Category" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All categories</SelectItem>
                      <SelectItem value="approval_required">Approval required</SelectItem>
                      <SelectItem value="blocker_escalation">Blocker escalation</SelectItem>
                      <SelectItem value="budget_hard_stop">Budget hard stop</SelectItem>
                      <SelectItem value="stalled_work">Stalled work</SelectItem>
                      <SelectItem value="run_failure_spike">Run failure spike</SelectItem>
                      <SelectItem value="board_mentioned_comment">Board mention</SelectItem>
                    </SelectContent>
                  </Select>
                  <Select
                    value={attentionActorFilter}
                    onValueChange={(value) => setAttentionActorFilter(value as "all" | "board" | "member" | "agent" | "system")}
                  >
                    <SelectTrigger className={styles.governanceFiltersSelect}>
                      <SelectValue placeholder="Required actor" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All actors</SelectItem>
                      <SelectItem value="board">Board</SelectItem>
                      <SelectItem value="member">Member</SelectItem>
                      <SelectItem value="agent">Agent</SelectItem>
                      <SelectItem value="system">System</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              }
            />
            <Dialog
              open={attentionDetailsOpen}
              onOpenChange={(open) => {
                setAttentionDetailsOpen(open);
                if (!open) {
                  setSelectedAttentionItem(null);
                  setAttentionPayloadExpanded(false);
                }
              }}
            >
              <DialogContent className="ui-dialog-content-scroll-tall">
                <DialogHeader>
                  <DialogTitle>{selectedAttentionItem?.title ?? "Inbox item details"}</DialogTitle>
                  <DialogDescription>
                    {selectedAttentionItem ? formatAttentionContextSummary(selectedAttentionItem.contextSummary, 180) : "Review details and take action."}
                  </DialogDescription>
                </DialogHeader>
                {selectedAttentionItem ? (
                  <div className={styles.attentionDialogBody}>
                    <div className={styles.attentionDialogMetaGrid}>
                      <div className={styles.attentionDialogMetaItem}>
                        <div className={styles.attentionDialogMetaLabel}>Category</div>
                        {formatAttentionCategoryLabel(selectedAttentionItem.category)}
                      </div>
                      <div className={styles.attentionDialogMetaItem}>
                        <div className={styles.attentionDialogMetaLabel}>Severity</div>
                        {selectedAttentionItem.severity}
                      </div>
                      <div className={styles.attentionDialogMetaItem}>
                        <div className={styles.attentionDialogMetaLabel}>Required actor</div>
                        {selectedAttentionItem.requiredActor}
                      </div>
                      <div className={styles.attentionDialogMetaItem}>
                        <div className={styles.attentionDialogMetaLabel}>State</div>
                        {selectedAttentionItem.state.replaceAll("_", " ")}
                      </div>
                      <div className={styles.attentionDialogMetaItem}>
                        <div className={styles.attentionDialogMetaLabel}>Updated</div>
                        <div className={styles.attentionDialogMetaValue}>{formatDateTime(selectedAttentionItem.sourceTimestamp)}</div>
                      </div>
                      <div className={styles.attentionDialogMetaItem}>
                        <div className={styles.attentionDialogMetaLabel}>Age</div>
                        <div className={styles.attentionDialogMetaValue}>
                          {formatRelativeAgeCompact(selectedAttentionItem.sourceTimestamp)}
                          {isAttentionOverdue(selectedAttentionItem) ? (
                            <Badge variant="outline" className={styles.attentionDialogOverdueBadge}>
                              Overdue
                            </Badge>
                          ) : null}
                        </div>
                      </div>
                    </div>
                    <div className={styles.attentionDialogSection}>
                      <div className={styles.attentionDialogMetaLabel}>Impact summary</div>
                      <div className={styles.attentionDialogMetaValue}>{selectedAttentionItem.impactSummary || "No impact summary."}</div>
                    </div>
                    {selectedAttentionApproval ? (
                      <>
                        <div className={styles.attentionDialogSection}>
                          <div className={styles.attentionDialogMetaLabel}>Approval action</div>
                          <div className={styles.attentionDialogMetaValue}>{formatApprovalActionLabel(selectedAttentionApproval.action)}</div>
                        </div>
                        <div className={styles.attentionDialogSection}>
                          <div className={styles.attentionDialogSectionHeader}>
                            <div className={styles.attentionDialogMetaLabel}>Approval payload</div>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className={styles.attentionDialogPayloadToggle}
                              onClick={() => setAttentionPayloadExpanded((current) => !current)}
                            >
                              {attentionPayloadExpanded ? "Hide payload" : "Show payload"}
                            </Button>
                          </div>
                          <div className={styles.attentionDialogMetaValue}>{describeApprovalPayload(selectedAttentionApproval.payload)}</div>
                          {attentionPayloadExpanded ? (
                            <pre className={styles.attentionDialogPayload}>
                              {formatApprovalPayloadDetails(selectedAttentionApproval.payload)}
                            </pre>
                          ) : null}
                        </div>
                      </>
                    ) : null}
                  </div>
                ) : null}
                <DialogFooter className={styles.attentionDialogFooter}>
                  <div className={styles.attentionDialogActionGroup}>
                    {selectedAttentionItem && selectedAttentionItem.state !== "dismissed" ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setAttentionDetailsOpen(false);
                          void dismissAttention(selectedAttentionItem.key);
                        }}
                        disabled={isActionPending(`attention:${selectedAttentionItem.key}:dismiss`)}
                      >
                        Dismiss
                      </Button>
                    ) : null}
                    {selectedAttentionHasPendingApproval && selectedAttentionItem?.evidence.approvalId ? (
                      <Button
                        variant="default"
                        size="sm"
                        onClick={() => {
                          setAttentionDetailsOpen(false);
                          void resolveApproval(selectedAttentionItem.evidence.approvalId!, "approved");
                        }}
                        disabled={isActionPending(`approval:${selectedAttentionItem.evidence.approvalId}:resolve`)}
                      >
                        {isActionPending(`approval:${selectedAttentionItem.evidence.approvalId}:resolve`) ? "Approving..." : "Approve"}
                      </Button>
                    ) : selectedAttentionItem ? (
                      <Button asChild variant="default" size="sm">
                        <a href={toAttentionActionHref(selectedAttentionItem.actionHref, companyId)}>{selectedAttentionItem.actionLabel}</a>
                      </Button>
                    ) : null}
                  </div>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </>
        );
      case "Logs":
        return (
          <>
            <SectionHeading
              title="Logs"
              description="Audit events emitted by workspace actions and governance flows."
            />
            <div className={cn("ui-stats", "mt-4")}>
              <MetricCard label="Events in scope" value={traceSummary.total} />
              <MetricCard label="Unique entities" value={traceSummary.uniqueEntities} />
              <MetricCard
                label="Event types"
                value={traceSummary.uniqueEventTypes}
                hint={`Top: ${formatAuditEventLabel({ eventType: traceSummary.topEventType, entityType: "", entityId: "" }, () => undefined)}`}
              />
              <MetricCard label="Anomalies" value={traceSummary.anomalies} hint="fail/error/reject/timeout events" />
            </div>
            {hasTraceChartData ? (
              <div className={styles.traceChartsGrid}>
                <Card>
                  <CardHeader>
                    <CardTitle>Trace trend</CardTitle>
                    <CardDescription>Daily event volume and anomalies (last 14 days, based on current filters).</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <ChartContainer config={traceChartConfig} className={styles.traceTrendChartContainer}>
                      <AreaChart accessibilityLayer data={traceDailyChartData} margin={{ top: 8, left: -8, right: -8 }}>
                        <defs>
                          <linearGradient id="traceTotalGradient" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="10%" stopColor="var(--color-total)" stopOpacity={0.45} />
                            <stop offset="90%" stopColor="var(--color-total)" stopOpacity={0.05} />
                          </linearGradient>
                          <linearGradient id="traceAnomaliesGradient" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="10%" stopColor="var(--color-anomalies)" stopOpacity={0.4} />
                            <stop offset="90%" stopColor="var(--color-anomalies)" stopOpacity={0.04} />
                          </linearGradient>
                        </defs>
                        <CartesianGrid vertical={false} strokeDasharray="4 4" strokeOpacity={0.3} />
                        <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={10} minTickGap={22} />
                        <YAxis hide />
                        <ChartTooltip content={<ChartTooltipContent indicator="line" />} cursor={false} />
                        <Area
                          type="monotone"
                          dataKey="total"
                          stroke="var(--color-total)"
                          fill="url(#traceTotalGradient)"
                          fillOpacity={1}
                          strokeWidth={2}
                        />
                        <Area
                          type="monotone"
                          dataKey="anomalies"
                          stroke="var(--color-anomalies)"
                          fill="url(#traceAnomaliesGradient)"
                          fillOpacity={1}
                          strokeWidth={2}
                        />
                      </AreaChart>
                    </ChartContainer>
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader>
                    <CardTitle>Top event types</CardTitle>
                    <CardDescription>Most frequent log event types in scope, with anomaly counts.</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <ChartContainer config={traceEventTypeChartConfig} className={styles.traceTrendChartContainer}>
                      <BarChart accessibilityLayer data={traceEventTypeChartData} margin={{ top: 8, left: -8, right: -8 }}>
                        <CartesianGrid vertical={false} strokeDasharray="4 4" strokeOpacity={0.3} />
                        <XAxis dataKey="eventType" tickLine={false} axisLine={false} tickMargin={10} minTickGap={12} />
                        <YAxis hide />
                        <ChartTooltip content={<ChartTooltipContent />} cursor={false} />
                        <Bar dataKey="total" fill="var(--color-total)" radius={[6, 6, 0, 0]} />
                        <Bar dataKey="anomalies" fill="var(--color-anomalies)" radius={[6, 6, 0, 0]} />
                      </BarChart>
                    </ChartContainer>
                  </CardContent>
                </Card>
              </div>
            ) : null}

<SectionHeading title="Audit events" description="Audit events emitted by workspace actions and governance flows." />
            <DataTable
              columns={auditColumns}
              data={filteredAuditEvents}
              emptyMessage="No trace logs match current filters."
              toolbarActions={
                <div className={styles.traceFiltersCardContent}>
                  <Input
                    value={traceQuery}
                    onChange={(event) => setTraceQuery(event.target.value)}
                    placeholder="Search event type, entity type, or entity id..."
                    className={styles.traceFiltersInput}
                  />
                  <Select value={traceEventFilter} onValueChange={setTraceEventFilter}>
                    <SelectTrigger className={styles.traceFiltersSelect}>
                      <SelectValue placeholder="Event type" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All event types</SelectItem>
                      {traceEventOptions.map((eventType) => (
                        <SelectItem key={eventType} value={eventType}>
                          {formatAuditEventLabel({ eventType, entityType: "", entityId: "" }, () => undefined)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Select value={traceEntityFilter} onValueChange={setTraceEntityFilter}>
                    <SelectTrigger className={styles.traceFiltersSelect}>
                      <SelectValue placeholder="Entity type" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All entity types</SelectItem>
                      {traceEntityOptions.map((entityType) => (
                        <SelectItem key={entityType} value={entityType}>
                          {entityType}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Select
                    value={traceWindowFilter}
                    onValueChange={(value) => setTraceWindowFilter(value as "today" | "7d" | "30d" | "90d" | "all")}
                  >
                    <SelectTrigger className={styles.traceFiltersSelect}>
                      <SelectValue placeholder="Window" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="today">Today</SelectItem>
                      <SelectItem value="7d">Last 7 days</SelectItem>
                      <SelectItem value="30d">Last 30 days</SelectItem>
                      <SelectItem value="90d">Last 90 days</SelectItem>
                      <SelectItem value="all">All time</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              }
            />
          </>
        );
      case "Runs":
        return (
          <>
            <SectionHeading
              title="Runs"
              description="Heartbeat runs from agent execution, including status, duration, and diagnostics."
            />
            <div className={cn("ui-stats", "mt-4")}>
              <MetricCard label="Runs in scope" value={runsSummary.total} />
              <MetricCard label="Success rate" value={`${runsSummary.successRate.toFixed(1)}%`} />
              <MetricCard label="Failed runs" value={runsSummary.failed} />
              <MetricCard label="Avg duration" value={runsSummary.avgDuration} />
            </div>
            {hasRunsChartData ? (
              <div className={styles.runTrendChartsGrid}>
                <Card>
                  <CardHeader>
                    <CardTitle>Run trend</CardTitle>
                    <CardDescription>1Daily completed vs failed runs (last 14 days, based on current filters).</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <ChartContainer config={runsChartConfig} className={styles.runTrendChartContainer}>
                      <AreaChart accessibilityLayer data={runsDailyChartData} margin={{ top: 8, left: -8, right: -8 }}>
                        <defs>
                          <linearGradient id="runsCompletedGradient" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="10%" stopColor="var(--color-completed)" stopOpacity={0.45} />
                            <stop offset="90%" stopColor="var(--color-completed)" stopOpacity={0.06} />
                          </linearGradient>
                          <linearGradient id="runsFailedGradient" x1="0" y1="0" x2="0" y2="1">
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
                          fill="url(#runsCompletedGradient)"
                          fillOpacity={1}
                          strokeWidth={2}
                        />
                        <Area
                          type="monotone"
                          dataKey="failed"
                          stroke="var(--color-failed)"
                          fill="url(#runsFailedGradient)"
                          fillOpacity={1}
                          strokeWidth={2}
                        />
                      </AreaChart>
                    </ChartContainer>
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader>
                    <CardTitle>Top agents by run volume</CardTitle>
                    <CardDescription>Most active agents in current scope, with failed-run overlay.</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <ChartContainer config={runsTopAgentsChartConfig} className={styles.runInsightsChartContainer}>
                      <BarChart accessibilityLayer data={runsTopAgentsChartData} margin={{ top: 8, left: -8, right: -8 }}>
                        <CartesianGrid vertical={false} strokeDasharray="4 4" strokeOpacity={0.3} />
                        <XAxis dataKey="agent" tickLine={false} axisLine={false} tickMargin={10} minTickGap={14} />
                        <YAxis hide />
                        <ChartTooltip content={<ChartTooltipContent />} cursor={false} />
                        <Bar dataKey="total" fill="var(--color-total)" radius={[6, 6, 0, 0]} />
                        <Bar dataKey="failed" fill="var(--color-failed)" radius={[6, 6, 0, 0]} />
                      </BarChart>
                    </ChartContainer>
                  </CardContent>
                </Card>
              </div>
            ) : null}
            <SectionHeading title="Heartbeats" description="Heartbeat runs scoped to this agent." />
            <DataTable
              columns={heartbeatRunColumns}
              data={filteredHeartbeatRuns}
              emptyMessage="No heartbeat runs match current filters."
              toolbarActions={
                <div className="ui-toolbar-filters">
                  <Input
                    value={runsQuery}
                    onChange={(event) => setRunsQuery(event.target.value)}
                    placeholder="Search run id, message, status, or agent..."
                    className="ui-toolbar-filter-input"
                  />
                  <Select value={runsStatusFilter} onValueChange={setRunsStatusFilter}>
                    <SelectTrigger className="ui-toolbar-filter-select">
                      <SelectValue placeholder="Status" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All statuses</SelectItem>
                      {runStatusOptions.map((status) => (
                        <SelectItem key={status} value={status}>
                          {formatRunStatusLabel(status)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Select value={runsAgentFilter} onValueChange={setRunsAgentFilter}>
                    <SelectTrigger className="ui-toolbar-filter-select">
                      <SelectValue placeholder="Agent" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All agents</SelectItem>
                      {agents.map((agent) => (
                        <SelectItem key={agent.id} value={agent.id}>
                          {agent.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Select
                    value={runsTypeFilter}
                    onValueChange={(value) =>
                      setRunsTypeFilter(value as "all" | "exclude_no_assigned_work" | HeartbeatRunRow["runType"])
                    }
                  >
                    <SelectTrigger className="ui-toolbar-filter-select">
                      <SelectValue placeholder="Run type" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="exclude_no_assigned_work">
                        {formatRunTypeLabel("exclude_no_assigned_work")}
                      </SelectItem>
                      <SelectItem value="all">{formatRunTypeLabel("all")}</SelectItem>
                      {runTypeOptions.map((runType) => (
                        <SelectItem key={runType} value={runType}>
                          {formatRunTypeLabel(runType)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Select
                    value={runsWindowFilter}
                    onValueChange={(value) => setRunsWindowFilter(value as "today" | "7d" | "30d" | "90d" | "all")}
                  >
                    <SelectTrigger className="ui-toolbar-filter-select">
                      <SelectValue placeholder="Window" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="today">Today</SelectItem>
                      <SelectItem value="7d">Last 7 days</SelectItem>
                      <SelectItem value="30d">Last 30 days</SelectItem>
                      <SelectItem value="90d">Last 90 days</SelectItem>
                      <SelectItem value="all">All time</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              }
            />
          </>
        );
      case "Costs":
        return (
          <>
            <SectionHeading
              title="Costs"
              description="Tracked token and cost usage for agents, owner-assistant chats, and issue execution."
              actions={
                <Select value={activeCostMonth} onValueChange={setSelectedCostMonth}>
                  <SelectTrigger className={styles.costLedgerSelectTrigger}>
                    <SelectValue placeholder="Select month" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All time</SelectItem>
                    {costMonthOptions.map((month) => (
                      <SelectItem key={month} value={month}>
                        {formatMonthLabel(month)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              }
            />
            <Tabs defaultValue="overview" className={styles.costTabsRoot}>
              <TabsList>
                <TabsTrigger value="overview">Overview</TabsTrigger>
                <TabsTrigger value="by-provider">By provider</TabsTrigger>
                <TabsTrigger value="by-model">By model</TabsTrigger>
                <TabsTrigger value="by-agent">By agent</TabsTrigger>
                <TabsTrigger value="by-chats">By chats</TabsTrigger>
              </TabsList>
              <TabsContent value="overview" className={styles.costTabsOverviewContent}>
            <div className="ui-stats">
              <MetricCard
                label="Today · Input Tokens"
                value={todayCostSummary.input.toLocaleString()}
                hint={`${todayCostEntries.length} entries`}
              />
              <MetricCard
                label="Today · Output Tokens"
                value={todayCostSummary.output.toLocaleString()}
                hint={`${formatUsdCost(todayCostSummary.usd)} spent`}
              />
              <MetricCard
                label={`${selectedMonthLabel} · Total Tokens`}
                value={(selectedMonthSummary.input + selectedMonthSummary.output).toLocaleString()}
                hint={`${filteredCostEntries.length} entries`}
              />
              <MetricCard
                label={`${selectedMonthLabel} · USD`}
                value={formatUsdCost(selectedMonthSummary.usd)}
                hint={
                  activeCostMonth === "all"
                    ? "Across all recorded entries."
                    : `${previousMonthSummary.usd > 0 ? ((selectedMonthSummary.usd / previousMonthSummary.usd - 1) * 100).toFixed(1) : "0.0"}% vs previous month`
                }
              />
            </div>
            <div className="ui-cost-charts-grid">
                <Card>
                  <CardHeader>
                    <CardTitle>Daily spend trend</CardTitle>
                    <CardDescription>
                      {activeCostMonth === "all"
                        ? "Showing the latest available month. Change month for a focused view."
                        : `${selectedMonthLabel} spend by day`}
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    {hasCostTokenMixData ? (
                      <ChartContainer config={costDailyConfig} className={styles.costLedgerChartContainer}>
                        <BarChart accessibilityLayer data={selectedMonthChartData} margin={{ top: 8, left: -8, right: -8 }}>
                          <defs>
                            <linearGradient id="costDailyUsdBarGradient" x1="0" y1="0" x2="0" y2="1">
                              <stop offset="4%" stopColor="var(--color-usd)" stopOpacity={0.95} />
                              <stop offset="96%" stopColor="var(--color-usd)" stopOpacity={0.55} />
                            </linearGradient>
                          </defs>
                          <CartesianGrid vertical={false} strokeDasharray="4 4" strokeOpacity={0.3} />
                          <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={10} minTickGap={22} />
                          <YAxis hide />
                          <ChartTooltip content={<ChartTooltipContent indicator="line" />} cursor={false} />
                          <Bar
                            dataKey="usd"
                            fill="url(#costDailyUsdBarGradient)"
                            radius={[4, 4, 0, 0]}
                            maxBarSize={24}
                            minPointSize={3}
                          />
                        </BarChart>
                      </ChartContainer>
                    ) : (
                      <EmptyState>No input or output token usage was reported for this month.</EmptyState>
                    )}
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader>
                    <CardTitle>Daily token mix</CardTitle>
                    <CardDescription>{selectedMonthLabel} input and output token volumes.</CardDescription>
                  </CardHeader>
                  <CardContent>
                    {hasCostTokenMixData ? (
                      <ChartContainer config={costTokenMixConfig} className={styles.costLedgerChartContainer}>
                        <BarChart accessibilityLayer data={selectedMonthChartData} margin={{ top: 8, left: -8, right: -8 }}>
                          <defs>
                            <linearGradient id="costTokenInputBarGradient" x1="0" y1="0" x2="0" y2="1">
                              <stop offset="8%" stopColor="var(--color-inputTokens)" stopOpacity={0.92} />
                              <stop offset="94%" stopColor="var(--color-inputTokens)" stopOpacity={0.52} />
                            </linearGradient>
                            <linearGradient id="costTokenOutputBarGradient" x1="0" y1="0" x2="0" y2="1">
                              <stop offset="8%" stopColor="var(--color-outputTokens)" stopOpacity={0.92} />
                              <stop offset="94%" stopColor="var(--color-outputTokens)" stopOpacity={0.52} />
                            </linearGradient>
                          </defs>
                          <CartesianGrid vertical={false} strokeDasharray="4 4" strokeOpacity={0.3} />
                          <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={10} minTickGap={22} />
                          <YAxis hide />
                          <ChartTooltip content={<ChartTooltipContent indicator="line" />} cursor={false} />
                          <Bar
                            dataKey="inputTokens"
                            stackId="tokens"
                            fill="url(#costTokenInputBarGradient)"
                            radius={[4, 4, 0, 0]}
                            maxBarSize={24}
                            minPointSize={2}
                          />
                          <Bar
                            dataKey="outputTokens"
                            stackId="tokens"
                            fill="url(#costTokenOutputBarGradient)"
                            radius={[4, 4, 0, 0]}
                            maxBarSize={24}
                            minPointSize={2}
                          />
                        </BarChart>
                      </ChartContainer>
                    ) : (
                      <EmptyState>No input or output token usage was reported for this month.</EmptyState>
                    )}
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader>
                    <CardTitle>Cumulative spend</CardTitle>
                    <CardDescription>{selectedMonthLabel} running spend progression in USD.</CardDescription>
                  </CardHeader>
                  <CardContent>
                    {hasCostTokenMixData ? (
                      <ChartContainer config={costCumulativeConfig} className={styles.costLedgerChartContainer}>
                        <AreaChart accessibilityLayer data={selectedMonthChartData} margin={{ top: 8, left: -8, right: -8 }}>
                          <defs>
                            <linearGradient id="costCumulativeUsdGradient" x1="0" y1="0" x2="0" y2="1">
                              <stop offset="8%" stopColor="var(--color-cumulativeUsd)" stopOpacity={0.5} />
                              <stop offset="90%" stopColor="var(--color-cumulativeUsd)" stopOpacity={0.04} />
                            </linearGradient>
                          </defs>
                          <CartesianGrid vertical={false} strokeDasharray="4 4" strokeOpacity={0.35} />
                          <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={10} minTickGap={20} />
                          <YAxis hide />
                          <ChartTooltip content={<ChartTooltipContent indicator="line" />} cursor={false} />
                          <Area
                            type="monotone"
                            dataKey="cumulativeUsd"
                            stroke="var(--color-cumulativeUsd)"
                            fill="url(#costCumulativeUsdGradient)"
                            fillOpacity={1}
                            strokeWidth={2.2}
                          />
                        </AreaChart>
                      </ChartContainer>
                    ) : (
                      <EmptyState>No input or output token usage was reported for this month.</EmptyState>
                    )}
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader>
                    <CardTitle>Monthly spend trend</CardTitle>
                    <CardDescription>
                      {activeCostMonth === "all"
                        ? "Last 6 months total spend in USD."
                        : `Up to 6 months through ${selectedMonthLabel} (USD).`}
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    {hasMonthlySpendData ? (
                      <ChartContainer config={costMonthlyConfig} className={styles.costLedgerChartContainer}>
                        <BarChart accessibilityLayer data={monthlyCostChartData} margin={{ top: 8, left: -8, right: -8 }}>
                          <defs>
                            <linearGradient id="costMonthlyUsdBarGradient" x1="0" y1="0" x2="0" y2="1">
                              <stop offset="8%" stopColor="var(--color-usd)" stopOpacity={0.92} />
                              <stop offset="94%" stopColor="var(--color-usd)" stopOpacity={0.52} />
                            </linearGradient>
                          </defs>
                          <CartesianGrid vertical={false} strokeDasharray="4 4" strokeOpacity={0.35} />
                          <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={10} minTickGap={20} />
                          <YAxis hide />
                          <ChartTooltip content={<ChartTooltipContent indicator="line" />} cursor={false} />
                          <Bar
                            dataKey="usd"
                            fill="url(#costMonthlyUsdBarGradient)"
                            radius={[4, 4, 0, 0]}
                            maxBarSize={28}
                            minPointSize={3}
                          />
                        </BarChart>
                      </ChartContainer>
                    ) : (
                      <EmptyState>No spend has been recorded yet for the available months.</EmptyState>
                    )}
                  </CardContent>
                </Card>
              </div>
            <SectionHeading title="Entries" description="Filter rows within the month shown above; charts reflect the selected month only." />
            <DataTable
              columns={costColumns}
              data={costTableFilteredEntries}
              emptyMessage="No entries match the current filters."
              toolbarActions={
                <div className="ui-toolbar-filters">
                  <Input
                    value={costEntriesSearchQuery}
                    onChange={(event) => setCostEntriesSearchQuery(event.target.value)}
                    placeholder="Search provider, model, agent or issue id…"
                    className="ui-toolbar-filter-input"
                  />
                  <Select value={costEntriesProviderFilter} onValueChange={setCostEntriesProviderFilter}>
                    <SelectTrigger className="ui-toolbar-filter-select">
                      <SelectValue placeholder="Provider" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All providers</SelectItem>
                      {costEntryProviderOptions.map((provider) => (
                        <SelectItem key={provider} value={provider}>
                          {provider}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Select value={costEntriesAgentFilter} onValueChange={setCostEntriesAgentFilter}>
                    <SelectTrigger className="ui-toolbar-filter-select">
                      <SelectValue placeholder="Agent" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All agents</SelectItem>
                      {costEntryAgentOptions.map((agent) => (
                        <SelectItem key={agent.id} value={agent.id}>
                          {agent.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Select
                    value={costEntriesScopeFilter}
                    onValueChange={(value) => setCostEntriesScopeFilter(value as "all" | "agent" | "issue")}
                  >
                    <SelectTrigger className="ui-toolbar-filter-select">
                      <SelectValue placeholder="Scope" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All scopes</SelectItem>
                      <SelectItem value="agent">With agent</SelectItem>
                      <SelectItem value="issue">With issue</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              }
            />
              </TabsContent>
              <TabsContent value="by-provider" className={styles.costTabsByProviderContent}>
                {!costDailyTargetMonthKey ? (
                  <EmptyState>No months with cost data yet.</EmptyState>
                ) : providerDailyCostBreakdown.length === 0 ? (
                  <EmptyState>
                    No spend was recorded for {providerDailyChartMonthLabel}, or all amounts are zero.
                  </EmptyState>
                ) : (
                  <div className={styles.costProviderDailyGrid}>
                    {providerDailyCostBreakdown.map((row) => (
                      <CostDailyBreakdownChartCard
                        key={row.providerType}
                        title={formatCostProviderTitle(row.providerType)}
                        chartMonthLabel={providerDailyChartMonthLabel}
                        daily={row.daily}
                        totalUsd={row.totalUsd}
                        totalTokens={row.totalTokens}
                        emptyLabel="No usage for this provider in this month."
                      />
                    ))}
                  </div>
                )}
              </TabsContent>
              <TabsContent value="by-model" className={styles.costTabsByProviderContent}>
                {!costDailyTargetMonthKey ? (
                  <EmptyState>No months with cost data yet.</EmptyState>
                ) : modelDailyCostBreakdown.length === 0 ? (
                  <EmptyState>
                    No spend was recorded for {providerDailyChartMonthLabel}, or all amounts are zero.
                  </EmptyState>
                ) : (
                  <div className={styles.costProviderDailyGrid}>
                    {modelDailyCostBreakdown.map((row) => (
                      <CostDailyBreakdownChartCard
                        key={row.modelKey}
                        title={formatCostModelTitle(row.modelKey)}
                        chartMonthLabel={providerDailyChartMonthLabel}
                        daily={row.daily}
                        totalUsd={row.totalUsd}
                        totalTokens={row.totalTokens}
                        emptyLabel="No usage for this model in this month."
                      />
                    ))}
                  </div>
                )}
              </TabsContent>
              <TabsContent value="by-agent" className={styles.costTabsByProviderContent}>
                {!costDailyTargetMonthKey ? (
                  <EmptyState>No months with cost data yet.</EmptyState>
                ) : agentCostBudgetBreakdown.length === 0 ? (
                  <EmptyState>
                    No agents with budget, usage, or ledger spend for {providerDailyChartMonthLabel}.
                  </EmptyState>
                ) : (
                  <div className={styles.costProviderDailyGrid}>
                    {agentCostBudgetBreakdown.map((row) => (
                      <AgentBudgetSpendCard
                        key={row.agentId}
                        agentName={row.agentName}
                        chartMonthLabel={providerDailyChartMonthLabel}
                        monthlyBudgetUsd={row.monthlyBudgetUsd}
                        usedBudgetUsd={row.usedBudgetUsd}
                        ledgerUsdMonth={row.ledgerUsdMonth}
                        daily={row.daily}
                      />
                    ))}
                  </div>
                )}
              </TabsContent>
              <TabsContent value="by-chats" className={styles.costTabsByProviderContent}>
                {!costDailyTargetMonthKey ? (
                  <EmptyState>No months with cost data yet.</EmptyState>
                ) : !ownerAssistantMonthlyChatsCost || ownerAssistantMonthlyChatsCost.activeThreadCount === 0 ? (
                  <EmptyState>
                    No owner-assistant conversations in {providerDailyChartMonthLabel} (no messages in that month, or the
                    request failed). Chat activity is listed from stored messages; ledger rows add metered tokens when the
                    brain reports them.
                  </EmptyState>
                ) : (
                  <div className={styles.costProviderDailyGrid}>
                    <CostDailyBreakdownChartCard
                      key={costDailyTargetMonthKey}
                      title="All owner-assistant conversations"
                      chartMonthLabel={providerDailyChartMonthLabel}
                      daily={ownerAssistantMonthlyChatsCost.daily}
                      totalUsd={ownerAssistantMonthlyChatsCost.totalUsd}
                      totalTokens={ownerAssistantMonthlyChatsCost.totalTokens}
                      metaLine={
                        ownerAssistantMonthlyChatsCost.activeThreadCount > 0
                          ? `${ownerAssistantMonthlyChatsCost.activeThreadCount} conversation${
                              ownerAssistantMonthlyChatsCost.activeThreadCount === 1 ? "" : "s"
                            } in this month`
                          : undefined
                      }
                      threadMessageCount={
                        ownerAssistantMonthlyChatsCost.totalMessages > 0
                          ? ownerAssistantMonthlyChatsCost.totalMessages
                          : undefined
                      }
                      emptyLabel={
                        ownerAssistantMonthlyChatsCost.totalUsd <= 0 && ownerAssistantMonthlyChatsCost.totalTokens <= 0
                          ? ownerAssistantMonthlyChatsCost.totalMessages > 0
                            ? "No metered tokens or USD in the ledger for this month yet. CLI brains record usage when the runtime reports it; otherwise use Anthropic API or OpenAI API for metering."
                            : "No metered tokens or USD for owner-assistant chat this month. Provider spend may still apply outside Bopo."
                          : "No usage for owner-assistant chat in this month."
                      }
                    />
                  </div>
                )}
              </TabsContent>
            </Tabs>
          </>
        );
      case "Settings":
        return (
          <>
            <SectionHeading
              title="Settings"
              description="Update the company name and mission."
            />
            <Card>
              <CardHeader>
                <CardTitle>Company Context</CardTitle>
                <CardDescription>Update the shared identity and mission agents should inherit.</CardDescription>
              </CardHeader>
              <CardContent className={styles.renderSectionActionsCardContent3}>
                <div className={styles.renderSectionActionsContainer3}>
                  <div className={styles.renderSectionActionsContainer4}>{activeCompany.name}</div>
                  <div className={styles.renderSectionActionsContainer5}>
                    {activeCompany.mission ?? "No mission configured yet. Edit the company mission to anchor goal-aware execution."}
                  </div>
                </div>
                <div className={styles.renderSectionActionsContainer6}>
                  <TextActionModal
                    triggerLabel="Rename Company"
                    triggerVariant="outline"
                    title="Rename company"
                    description="Update the company name used across the workspace."
                    submitLabel="Save"
                    initialValue={activeCompany.name}
                    placeholder="Company name"
                    onSubmit={(nextName) =>
                      runCrudAction(
                        async () => {
                          await apiPut(`/companies/${activeCompany.id}`, companyId!, { name: nextName });
                        },
                        "Failed to update company."
                      )
                    }
                  />
                  <TextActionModal
                    triggerLabel="Edit Mission"
                    triggerVariant="outline"
                    title="Edit mission"
                    description="Define the mission that should be visible to your agent runtime context."
                    submitLabel="Save"
                    initialValue={activeCompany.mission ?? ""}
                    placeholder="Mission"
                    onSubmit={(mission) =>
                      runCrudAction(
                        async () => {
                          await apiPut(`/companies/${activeCompany.id}`, companyId!, { mission });
                        },
                        "Failed to update mission."
                      )
                    }
                    multiline
                  />
                </div>
              </CardContent>
            </Card>
            <AgentRuntimeDefaultsCard
              companyId={companyId}
              fallbackDefaults={onboardingRuntimeFallback}
              activeCompanyName={activeCompany.name}
              deleteCompanyDetails={deleteCompanyDetails}
              onDeleteCompany={removeActiveCompanyFromSettings}
              deleteActionPending={isActionPending(`company:${activeCompany.id}:delete:active`)}
            />
          </>
        );
      case "Plugins": {
        return (
          <>
            <SectionHeading
              title="Plugins"
              description="Install v2 package plugins, activate/deactivate, and manage catalog entries."
              actions={
                <Button
                  variant="default"
                  size="sm"
                  onClick={openCreatePluginDialog}
                >
                  New plugin
                </Button>
              }
            />
            {pluginActionNotice ? (
              <Alert variant={pluginActionNotice.kind === "error" ? "destructive" : "default"} className="ui-alert--mb-section">
                <AlertTitle>{pluginActionNotice.kind === "error" ? "Plugin action failed" : "Plugin health"}</AlertTitle>
                <AlertDescription className="whitespace-pre-wrap break-words">{pluginActionNotice.message}</AlertDescription>
              </Alert>
            ) : null}
            <DataTable
              columns={pluginColumns}
              data={filteredPlugins}
              emptyMessage="No plugins match current filters."
              toolbarActions={
                <div className={styles.governanceFiltersCardContent}>
                  <Input
                    value={pluginsQuery}
                    onChange={(event) => setPluginsQuery(event.target.value)}
                    placeholder="Search plugins, hooks, capabilities..."
                    className={styles.governanceFiltersInput}
                  />
                  <Select value={pluginsStatusFilter} onValueChange={(value) => setPluginsStatusFilter(value as typeof pluginsStatusFilter)}>
                    <SelectTrigger className={styles.governanceFiltersSelect}>
                      <SelectValue placeholder="Status" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All statuses</SelectItem>
                      <SelectItem value="active">Active</SelectItem>
                      <SelectItem value="installed">Installed (inactive)</SelectItem>
                      <SelectItem value="not_installed">Not installed</SelectItem>
                    </SelectContent>
                  </Select>
                  <Select value={pluginsKindFilter} onValueChange={setPluginsKindFilter}>
                    <SelectTrigger className={styles.governanceFiltersSelect}>
                      <SelectValue placeholder="Kind" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All kinds</SelectItem>
                      {pluginKindOptions.map((kind) => (
                        <SelectItem key={kind} value={kind}>
                          {kind}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              }
            />
            <Dialog
              open={installPluginDialogOpen}
              onOpenChange={setInstallPluginDialogOpen}
            >
              <DialogContent size="2xl">
                <DialogHeader>
                  <DialogTitle>Install plugin package</DialogTitle>
                  <DialogDescription>Install a plugin by npm package name.</DialogDescription>
                </DialogHeader>
                <form
                  className="ui-space-y-4"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void runCrudAction(
                      async () => {
                        await apiPost("/plugins/install", companyId!, {
                          packageName: pluginPackageName.trim(),
                          version: pluginPackageVersion.trim() || undefined,
                          install: true
                        });
                        setInstallPluginDialogOpen(false);
                      },
                      "Failed to install plugin package.",
                      "plugin:install"
                    );
                  }}
                >
                  <div className="ui-dialog-content-scrollable">
                    <FieldGroup>
                      <Field>
                        <FieldLabelWithHelp
                          htmlFor="plugin-package-name"
                          helpText="Registry package reference for the plugin. Example: @scope/my-bopo-plugin">
                          npm package name
                        </FieldLabelWithHelp>
                        <Input
                          id="plugin-package-name"
                          value={pluginPackageName}
                          onChange={(event) => setPluginPackageName(event.target.value)}
                          placeholder="@scope/plugin-name"
                        />
                      </Field>
                      <Field>
                        <FieldLabelWithHelp
                          htmlFor="plugin-package-version"
                          helpText="Optional semver or dist-tag. Leave empty for latest.">
                          Version (optional)
                        </FieldLabelWithHelp>
                        <Input
                          id="plugin-package-version"
                          value={pluginPackageVersion}
                          onChange={(event) => setPluginPackageVersion(event.target.value)}
                          placeholder="latest"
                        />
                      </Field>
                    </FieldGroup>
                  </div>
                  <DialogFooter showCloseButton>
                    <Button
                      type="submit"
                      disabled={Boolean(pluginBuilderValidationError) || isActionPending("plugin:install")}
                    >
                      Install
                    </Button>
                  </DialogFooter>
                </form>
              </DialogContent>
            </Dialog>
          </>
        );
      }
      case "Templates":
        return (
          <>
            <SectionHeading
              title="Templates"
              description="Portable org templates for reproducible company setup."
            />
            <Tabs defaultValue="templates" className="ui-tabs-mt-4">
              <TabsList className="ui-tabs-list-mb-4">
                <TabsTrigger value="templates">Templates</TabsTrigger>
                {companyId && activeCompany ? (
                  <>
                    <TabsTrigger value="export">Export</TabsTrigger>
                    <TabsTrigger value="import">Import</TabsTrigger>
                  </>
                ) : null}
              </TabsList>
              <TabsContent value="templates" className="ui-tabs-content-flush">
                <DataTable
                  columns={templateColumns}
                  data={filteredTemplates}
                  emptyMessage="No templates available yet."
                  toolbarActions={
                    <div className={styles.governanceFiltersCardContent}>
                      <Input
                        value={templatesQuery}
                        onChange={(event) => setTemplatesQuery(event.target.value)}
                        placeholder="Search template name, slug, version..."
                        className={styles.governanceFiltersInput}
                      />
                      <Select value={templatesStatusFilter} onValueChange={(value) => setTemplatesStatusFilter(value as "all" | TemplateRow["status"])}>
                        <SelectTrigger className={styles.governanceFiltersSelect}>
                          <SelectValue placeholder="Status" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="all">All statuses</SelectItem>
                          <SelectItem value="draft">Draft</SelectItem>
                          <SelectItem value="published">Published</SelectItem>
                          <SelectItem value="archived">Archived</SelectItem>
                        </SelectContent>
                      </Select>
                      <Select
                        value={templatesVisibilityFilter}
                        onValueChange={(value) => setTemplatesVisibilityFilter(value as "all" | TemplateRow["visibility"])}
                      >
                        <SelectTrigger className={styles.governanceFiltersSelect}>
                          <SelectValue placeholder="Visibility" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="all">All visibility</SelectItem>
                          <SelectItem value="company">Company</SelectItem>
                          <SelectItem value="private">Private</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  }
                />
                <Dialog open={templateDetailsOpen} onOpenChange={setTemplateDetailsOpen}>
                  <DialogContent size="xl" className="ui-dialog-content-template-preview">
                    <DialogHeader className="ui-dialog-header-shrink">
                      <DialogTitle>{selectedTemplate?.name ?? "Template details"}</DialogTitle>
                      <DialogDescription>
                        {selectedTemplate?.description?.trim() || "Portable org template details and manifest."}
                      </DialogDescription>
                    </DialogHeader>
                    <div className="ui-dialog-body-scroll-template">
                      {selectedTemplate ? (
                        <div className="ui-space-y-6">
                          <div className="ui-template-preview-grid">
                            <div className="ui-template-preview-stat">
                              <div className="ui-template-preview-stat-label">Slug</div>
                              <div className="ui-template-preview-stat-value">{selectedTemplate.slug}</div>
                            </div>
                            <div className="ui-template-preview-stat">
                              <div className="ui-template-preview-stat-label">Version</div>
                              <div className="ui-template-preview-stat-value">{selectedTemplate.currentVersion}</div>
                            </div>
                            <div className="ui-template-preview-stat">
                              <div className="ui-template-preview-stat-label">Status</div>
                              <Badge variant="outline" className="ui-mt-1">
                                {selectedTemplate.status}
                              </Badge>
                            </div>
                          </div>
                          <TemplatePreviewContent template={selectedTemplate} />
                        </div>
                      ) : null}
                    </div>
                    <DialogFooter className="ui-dialog-footer-shrink">
                      <Button type="button" variant="outline" onClick={() => setTemplateDetailsOpen(false)}>
                        Close
                      </Button>
                    </DialogFooter>
                  </DialogContent>
                </Dialog>
              </TabsContent>
              {companyId && activeCompany ? (
                <>
                  <TabsContent value="export" className="ui-tabs-content-flush">
                    <CompanyFileExportCard companyId={companyId} companyName={activeCompany.name} />
                  </TabsContent>
                  <TabsContent value="import" className="ui-tabs-content-flush">
                    <CompanyFileImportCard />
                  </TabsContent>
                </>
              ) : null}
            </Tabs>
          </>
        );
      case "Models":
        return (
          <>
            <SectionHeading
              title="Models"
              description="Model pricing is file-managed in the API service and is no longer editable from the UI."
            />
            {!companyId ? (
              <EmptyState>Create or select a company to view model catalog details.</EmptyState>
            ) : (
              <Alert>
                <AlertTitle>Pricing is read-only in UI</AlertTitle>
                <AlertDescription>
                  Model prices are now sourced from provider pricing files in the API codebase.
                </AlertDescription>
              </Alert>
            )}
          </>
        );
      default:
        return (
          <>
            <SectionHeading
              title="Companies"
              description="Manage all available company workspaces from one control plane."
            />
            <DataTable columns={companyColumns} data={companies} emptyMessage="No companies yet." />
          </>
        );
    }
  })();

  return (
    <>
      {actionError ? (
        <Alert variant="destructive" className={styles.renderSectionActionsAlert}>
          <AlertTitle>Action failed</AlertTitle>
          <AlertDescription>{actionError}</AlertDescription>
        </Alert>
      ) : null}
      <AppShell
        leftPane={leftPane}
        activeNav={activeNav}
        companies={companies}
        activeCompanyId={companyId}
        pendingApprovalsCount={pendingApprovalsCount}
        leftPaneScrollable={false}
        singleScroll
      />
    </>
  );
}
