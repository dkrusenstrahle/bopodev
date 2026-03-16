"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
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
import { RunDetailsModal } from "@/components/modals/run-details-modal";
import { TextActionModal } from "@/components/modals/text-action-modal";
import { ApiError, apiDelete, apiGet, apiPost, apiPut } from "@/lib/api";
import { agentAvatarSeed } from "@/lib/agent-avatar";
import { cn } from "@/lib/utils";
import { getStatusBadgeClassName } from "@/lib/status-presentation";
import { getSupportedModelOptionsForProvider } from "@/lib/agent-runtime-options";
import { isNoAssignedWorkRun, isStoppedRun, resolveWindowStart, summarizeCosts } from "@/lib/workspace-logic";
import type { SectionLabel } from "@/lib/sections";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { DataTable } from "@/components/ui/data-table";
import { DataTableColumnHeader } from "@/components/ui/data-table-column-header";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";
import styles from "./workspace-client.module.scss";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select";
import type { ModelPricingRow, TemplateRow } from "@/components/workspace/types";

const MODELS_PROVIDER_FALLBACKS = ["openai_api", "anthropic_api", "opencode", "gemini_api"] as const;

function resolveModelCatalogProvider(providerType: string) {
  const normalizedProvider = providerType.trim();
  if (normalizedProvider === "opencode") {
    return "opencode";
  }
  if (normalizedProvider === "gemini_api" || normalizedProvider === "gemini_cli") {
    return "gemini_api";
  }
  if (normalizedProvider === "anthropic_api" || normalizedProvider === "claude_code") {
    return "anthropic_api";
  }
  if (
    normalizedProvider === "openai_api" ||
    normalizedProvider === "codex" ||
    normalizedProvider === "cursor"
  ) {
    return "openai_api";
  }
  return null;
}

function normalizeModelIdForCatalog(providerType: string, modelId: string | null | undefined) {
  const normalizedModel = modelId?.trim();
  if (!normalizedModel) {
    return null;
  }
  if (providerType === "opencode" && normalizedModel === "big-pickle") {
    return "opencode/big-pickle";
  }
  return normalizedModel;
}

function resolveRuntimeProviderForModelDefaults(providerType: string) {
  const normalizedProviderType = providerType.trim();
  if (
    normalizedProviderType === "codex" ||
    normalizedProviderType === "claude_code" ||
    normalizedProviderType === "opencode" ||
    normalizedProviderType === "gemini_cli" ||
    normalizedProviderType === "openai_api" ||
    normalizedProviderType === "anthropic_api" ||
    normalizedProviderType === "http" ||
    normalizedProviderType === "shell"
  ) {
    return normalizedProviderType;
  }
  if (normalizedProviderType === "gemini_api") {
    return "gemini_cli";
  }
  return null;
}

function resolveNamedModelForAgent(agent: {
  providerType: string;
  runtimeModel?: string | null;
  stateBlob?: string;
}) {
  const configuredModel = agent.runtimeModel?.trim() || parseRuntimeModelFromStateBlob(agent.stateBlob);
  if (configuredModel) {
    return configuredModel;
  }
  const runtimeProvider = resolveRuntimeProviderForModelDefaults(agent.providerType);
  if (!runtimeProvider) {
    return null;
  }
  const fallback = getSupportedModelOptionsForProvider(runtimeProvider).find((option) => option.value.trim().length > 0);
  return fallback?.value ?? null;
}

const AgentRuntimeDefaultsCard = dynamic(
  () => import("@/components/agent-runtime-defaults-card").then((module) => module.AgentRuntimeDefaultsCard),
  {
    loading: () => <div>Loading runtime defaults...</div>
  }
);
const OrgChart = dynamic(() => import("@/components/org-chart").then((module) => module.OrgChart), {
  loading: () => <div>Loading org chart...</div>
});
const pluginBuilderHooks = [
  "beforeClaim",
  "afterClaim",
  "beforeAdapterExecute",
  "afterAdapterExecute",
  "beforePersist",
  "afterPersist",
  "onError"
] as const;

interface IssueRow {
  id: string;
  companyId: string;
  projectId: string;
  parentIssueId: string | null;
  assigneeAgentId: string | null;
  title: string;
  body?: string | null;
  status: "todo" | "in_progress" | "blocked" | "in_review" | "done" | "canceled";
  priority: string;
  labels: string[];
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

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

type RuntimeDefaultsProviderType =
  | "claude_code"
  | "codex"
  | "opencode"
  | "openai_api"
  | "anthropic_api"
  | "http"
  | "shell";

function isRuntimeDefaultsProviderType(value: unknown): value is RuntimeDefaultsProviderType {
  return (
    value === "claude_code" ||
    value === "codex" ||
    value === "opencode" ||
    value === "openai_api" ||
    value === "anthropic_api" ||
    value === "http" ||
    value === "shell"
  );
}

function parseRuntimeModelFromStateBlob(rawStateBlob: string | undefined) {
  if (!rawStateBlob) {
    return "";
  }
  try {
    const parsed = JSON.parse(rawStateBlob) as { runtime?: { model?: unknown } };
    return typeof parsed.runtime?.model === "string" ? parsed.runtime.model : "";
  } catch {
    return "";
  }
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

function describeApprovalPayload(payload: Record<string, unknown> | undefined) {
  if (!payload) {
    return "No payload";
  }
  const name = typeof payload.name === "string" ? payload.name : null;
  const role = typeof payload.role === "string" ? payload.role : null;
  const projectId = typeof payload.projectId === "string" ? payload.projectId : null;
  const parentGoalId = typeof payload.parentGoalId === "string" ? payload.parentGoalId : null;
  const title = typeof payload.title === "string" ? payload.title : null;
  const fragments = [name, role, title, projectId ? `project:${shortId(projectId)}` : null, parentGoalId ? `parent:${shortId(parentGoalId)}` : null].filter(
    (value): value is string => Boolean(value)
  );
  return fragments.length > 0 ? fragments.join(" · ") : "Payload ready";
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
  version: string;
  kind: string;
  runtimeType: string;
  runtimeEntrypoint: string;
  hooks: string[];
  capabilities: string[];
  companyConfig: {
    enabled: boolean;
    priority: number;
    config: Record<string, unknown>;
    grantedCapabilities: string[];
  } | null;
}

const goalStatusOptions = [
  { value: "draft", label: "Draft" },
  { value: "active", label: "Active" },
  { value: "completed", label: "Completed" },
  { value: "archived", label: "Archived" }
] as const;

function MetricCard({
  label,
  value,
  hint
}: {
  label: string;
  value: string | number;
  hint?: string;
}) {
  return (
    <Card className={cn(styles.metricCard, "ui-card-stat")}>
      <CardHeader className={styles.metricCardHeader}>
        <CardDescription className={styles.metricCardDescription}>{label}</CardDescription>
      </CardHeader>
      <CardContent className={styles.metricCardContent}>
        <div className={styles.metricCardContainer}>{value}</div>
        {hint ? <p className={styles.metricCardText}>{hint}</p> : null}
      </CardContent>
    </Card>
  );
}

function EmptyState({ children }: { children: React.ReactNode }) {
  return <div className={styles.emptyStateContainer}>{children}</div>;
}

function SectionHeading({
  title,
  description,
  actions
}: {
  title: string;
  description: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="ui-feature-section-row">
      <div>
        <h2 className="ui-feature-section-title">{title}</h2>
        <p className="ui-feature-section-description">{description}</p>
      </div>
      {actions ? <div className="ui-feature-section-actions">{actions}</div> : null}
    </div>
  );
}

function formatDateTime(value: string) {
  return new Date(value).toLocaleString();
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

function formatRelativeAgeCompact(timestamp: string | null) {
  if (!timestamp) {
    return "n/a";
  }
  const ageMs = Date.now() - new Date(timestamp).getTime();
  if (!Number.isFinite(ageMs)) {
    return "n/a";
  }
  const ageHours = ageMs / (1000 * 60 * 60);
  if (ageHours < 1) {
    return `${Math.max(Math.round(ageHours * 60), 1)}m`;
  }
  if (ageHours < 24) {
    return `${ageHours.toFixed(1)}h`;
  }
  return `${(ageHours / 24).toFixed(1)}d`;
}

function monthKeyFromDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "unknown";
  }
  const month = String(date.getMonth() + 1).padStart(2, "0");
  return `${date.getFullYear()}-${month}`;
}

function formatMonthLabel(monthKey: string) {
  const match = monthKey.match(/^(\d{4})-(\d{2})$/);
  if (!match) {
    return monthKey;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  return new Date(year, month - 1, 1).toLocaleString(undefined, { month: "long", year: "numeric" });
}

function dayKeyFromDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  date.setHours(0, 0, 0, 0);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function buildRecentDayKeys(days: number) {
  const now = new Date();
  const dayKeys: string[] = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const day = new Date(now);
    day.setHours(0, 0, 0, 0);
    day.setDate(day.getDate() - i);
    dayKeys.push(`${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`);
  }
  return dayKeys;
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
  auditEvents: AuditRow[];
  costEntries: CostRow[];
  projects: ProjectRow[];
  plugins?: PluginRow[];
  templates?: TemplateRow[];
}) {
  const router = useRouter();
  const [actionError, setActionError] = useState<string | null>(null);
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
  const [goalsQuery, setGoalsQuery] = useState("");
  const [projectsQuery, setProjectsQuery] = useState("");
  const [projectsActivityFilter, setProjectsActivityFilter] = useState<"all" | "active" | "no_open_issues" | "no_issues">("all");
  const [agentsStatusFilter, setAgentsStatusFilter] = useState<string>("all");
  const [agentsProviderFilter, setAgentsProviderFilter] = useState<string>("all");
  const [agentsReportToFilter, setAgentsReportToFilter] = useState<string>("all");
  const [agentsModelFilter, setAgentsModelFilter] = useState<string>("all");
  const [agentsQuery, setAgentsQuery] = useState("");
  const [inboxQuery, setInboxQuery] = useState("");
  const [inboxStateFilter, setInboxStateFilter] = useState<"all" | "pending" | "resolved">("all");
  const [inboxSeenFilter, setInboxSeenFilter] = useState<"all" | "seen" | "unseen">("all");
  const [inboxDismissedFilter, setInboxDismissedFilter] = useState<"all" | "active" | "dismissed">("all");
  const [pluginsQuery, setPluginsQuery] = useState("");
  const [pluginsStatusFilter, setPluginsStatusFilter] = useState<"all" | "active" | "installed" | "not_installed">("all");
  const [pluginsKindFilter, setPluginsKindFilter] = useState<string>("all");
  const [templatesQuery, setTemplatesQuery] = useState("");
  const [templatesStatusFilter, setTemplatesStatusFilter] = useState<"all" | TemplateRow["status"]>("all");
  const [templatesVisibilityFilter, setTemplatesVisibilityFilter] = useState<"all" | TemplateRow["visibility"]>("all");
  const [selectedTemplate, setSelectedTemplate] = useState<TemplateRow | null>(null);
  const [templateDetailsOpen, setTemplateDetailsOpen] = useState(false);
  const [installPluginDialogOpen, setInstallPluginDialogOpen] = useState(false);
  const [pluginBuilderMode, setPluginBuilderMode] = useState<"create" | "edit">("create");
  const [pluginBuilderId, setPluginBuilderId] = useState("");
  const [pluginBuilderName, setPluginBuilderName] = useState("");
  const [pluginBuilderDescription, setPluginBuilderDescription] = useState("");
  const [pluginBuilderHook, setPluginBuilderHook] = useState<(typeof pluginBuilderHooks)[number]>("beforeAdapterExecute");
  const [pluginBuilderCapabilities, setPluginBuilderCapabilities] = useState("emit_audit");
  const [pluginBuilderPromptTemplate, setPluginBuilderPromptTemplate] = useState("");
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
  const onboardingRuntimeFallback = useMemo(() => {
    const ceo = agents.find((entry) => entry.role === "CEO" || entry.name === "CEO");
    if (!ceo || !isRuntimeDefaultsProviderType(ceo.providerType)) {
      return undefined;
    }
    return {
      providerType: ceo.providerType,
      runtimeModel: ceo.runtimeModel ?? parseRuntimeModelFromStateBlob(ceo.stateBlob)
    };
  }, [agents]);
  const isDashboardNav = activeNav === "Dashboard";
  const isProjectsNav = activeNav === "Projects";
  const isGoalsNav = activeNav === "Goals";
  const isAgentsNav = activeNav === "Agents";
  const isInboxNav = activeNav === "Inbox";
  const isGovernanceNav = activeNav === "Approvals";
  const isLogsNav = activeNav === "Logs";
  const isRunsNav = activeNav === "Runs";
  const isCostsNav = activeNav === "Costs";
  const isPluginsNav = activeNav === "Plugins";
  const isModelsNav = activeNav === "Models";
  const isTemplatesNav = activeNav === "Templates";
  const includeCostAggregations = isCostsNav || isDashboardNav;

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

  async function removeGoal(goal: GoalRow) {
    await runCrudAction(async () => {
      await apiDelete(`/goals/${goal.id}`, companyId!);
    }, "Failed to delete goal.", `goal:${goal.id}:delete`);
  }

  async function removeProject(project: ProjectRow) {
    await runCrudAction(async () => {
      await apiDelete(`/projects/${project.id}`, companyId!);
    }, "Failed to delete project.", `project:${project.id}:delete`);
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

  async function removeAgent(agent: AgentRow) {
    await runCrudAction(async () => {
      await apiDelete(`/agents/${agent.id}`, companyId!);
    }, "Failed to delete agent.", `agent:${agent.id}:delete`);
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

  async function installPlugin(pluginId: string) {
    await runCrudAction(async () => {
      await apiPost(`/plugins/${pluginId}/install`, companyId!, {});
    }, "Failed to install plugin.", `plugin:${pluginId}:install`);
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
    setPluginBuilderMode("create");
    setPluginBuilderId("");
    setPluginBuilderName("");
    setPluginBuilderDescription("");
    setPluginBuilderHook("beforeAdapterExecute");
    setPluginBuilderCapabilities("emit_audit");
    setPluginBuilderPromptTemplate("");
    setInstallPluginDialogOpen(true);
  }

  function openEditPluginDialog(plugin: PluginRow) {
    const primaryHook = plugin.hooks[0];
    setPluginBuilderMode("edit");
    setPluginBuilderId(plugin.id);
    setPluginBuilderName(plugin.name);
    setPluginBuilderDescription(plugin.description ?? "");
    setPluginBuilderHook(
      pluginBuilderHooks.includes(primaryHook as (typeof pluginBuilderHooks)[number])
        ? (primaryHook as (typeof pluginBuilderHooks)[number])
        : "beforeAdapterExecute"
    );
    setPluginBuilderCapabilities(plugin.capabilities.join(","));
    setPluginBuilderPromptTemplate(plugin.promptTemplate ?? "");
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
  const pendingApprovalsCount = useMemo(
    () => approvals.reduce((count, approval) => count + (approval.status === "pending" ? 1 : 0), 0),
    [approvals]
  );
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
    const byDay = new Map<number, { usd: number; tokens: number }>();
    for (let day = 1; day <= daysInMonth; day += 1) {
      byDay.set(day, { usd: 0, tokens: 0 });
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
      current.tokens += entry.tokenInput + entry.tokenOutput;
    }
    return Array.from(byDay.entries()).map(([day, values]) => ({
      label: String(day).padStart(2, "0"),
      usd: Number(values.usd.toFixed(4)),
      tokens: values.tokens
    }));
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
    return Array.from(byMonth.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(-6)
      .map(([month, value]) => ({
        label: month.slice(2),
        usd: Number(value.usd.toFixed(4)),
        tokens: value.tokens
      }));
  }, [costEntries, includeCostAggregations]);
  const costDailyConfig = {
    usd: { label: "USD", color: "var(--chart-2)" },
    tokens: { label: "Tokens", color: "var(--chart-4)" }
  } satisfies ChartConfig;
  const costMonthlyConfig = {
    usd: { label: "USD", color: "var(--chart-1)" }
  } satisfies ChartConfig;
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
          (run.message ?? "").toLowerCase().includes(normalizedQuery) ||
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
      .map(([eventType, values]) => ({
        eventType: eventType.length > 22 ? `${eventType.slice(0, 19)}...` : eventType,
        total: values.total,
        anomalies: values.anomalies
      }));
  }, [filteredAuditEvents]);
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
      if (!normalizedQuery) {
        return true;
      }
      const projectName = goal.projectId ? (projects.find((project) => project.id === goal.projectId)?.name ?? "") : "";
      return (
        goal.title.toLowerCase().includes(normalizedQuery) ||
        (goal.description ?? "").toLowerCase().includes(normalizedQuery) ||
        goal.status.toLowerCase().includes(normalizedQuery) ||
        goal.level.toLowerCase().includes(normalizedQuery) ||
        projectName.toLowerCase().includes(normalizedQuery)
      );
    });
  }, [goals, goalsLevelFilter, goalsQuery, goalsStatusFilter, isGoalsNav, projects]);
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
  const projectsSummary = useMemo(() => {
    const total = projects.length;
    const withOpenIssues = projects.filter((project) => (projectIssueSummaryById.get(project.id)?.open ?? 0) > 0).length;
    const noOpenIssues = projects.filter((project) => {
      const summary = projectIssueSummaryById.get(project.id) ?? { total: 0, open: 0 };
      return summary.total > 0 && summary.open === 0;
    }).length;
    const noIssues = projects.filter((project) => (projectIssueSummaryById.get(project.id)?.total ?? 0) === 0).length;
    return { total, withOpenIssues, noOpenIssues, noIssues };
  }, [projectIssueSummaryById, projects]);
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
        agent.role.toLowerCase().includes(normalizedQuery) ||
        agent.status.toLowerCase().includes(normalizedQuery) ||
        agent.providerType.toLowerCase().includes(normalizedQuery)
      );
    });
  }, [agents, agentsModelFilter, agentsProviderFilter, agentsQuery, agentsReportToFilter, agentsStatusFilter, isAgentsNav]);
  const agentsInScopeForCharts = useMemo(() => {
    if (!isAgentsNav) {
      return [];
    }
    return filteredAgents;
  }, [filteredAgents, isAgentsNav]);
  const agentIdsInScopeForCharts = useMemo(
    () => new Set(agentsInScopeForCharts.map((agent) => agent.id)),
    [agentsInScopeForCharts]
  );
  const agentsRunsTrendData = useMemo(() => {
    if (!isAgentsNav) {
      return [];
    }
    const dayKeys = buildRecentDayKeys(14);
    const byDay = new Map(dayKeys.map((key) => [key, { total: 0, failed: 0, completed: 0 }]));
    for (const run of heartbeatRuns) {
      if (!agentIdsInScopeForCharts.has(run.agentId)) {
        continue;
      }
      const key = dayKeyFromDate(run.startedAt);
      if (!key) {
        continue;
      }
      const current = byDay.get(key);
      if (!current) {
        continue;
      }
      current.total += 1;
      if (run.status === "failed") {
        current.failed += 1;
      }
      if (run.status === "completed") {
        current.completed += 1;
      }
    }
    return dayKeys.map((key) => {
      const current = byDay.get(key) ?? { total: 0, failed: 0, completed: 0 };
      const relevant = current.completed + current.failed;
      return {
        label: key.slice(5),
        total: current.total,
        failed: current.failed,
        successRate: relevant > 0 ? Number(((current.completed / relevant) * 100).toFixed(1)) : 0
      };
    });
  }, [agentIdsInScopeForCharts, heartbeatRuns, isAgentsNav]);
  const agentsSpendTrendData = useMemo(() => {
    if (!isAgentsNav) {
      return [];
    }
    const dayKeys = buildRecentDayKeys(30);
    const byDay = new Map(dayKeys.map((key) => [key, 0]));
    for (const entry of costEntries) {
      if (!entry.agentId || !agentIdsInScopeForCharts.has(entry.agentId)) {
        continue;
      }
      const key = dayKeyFromDate(entry.createdAt);
      if (!key) {
        continue;
      }
      const current = byDay.get(key);
      if (typeof current !== "number") {
        continue;
      }
      byDay.set(key, current + entry.usdCost);
    }
    return dayKeys.map((key) => ({
      label: key.slice(5),
      usd: Number((byDay.get(key) ?? 0).toFixed(4))
    }));
  }, [agentIdsInScopeForCharts, costEntries, isAgentsNav]);
  const agentsInsightsHasData = useMemo(() => {
    if (!isAgentsNav) {
      return false;
    }
    const hasRunData = agentsRunsTrendData.some((entry) => entry.total > 0);
    const hasSpendData = agentsSpendTrendData.some((entry) => entry.usd > 0);
    return hasRunData || hasSpendData;
  }, [agentsRunsTrendData, agentsSpendTrendData, isAgentsNav]);
  const agentsRunsTrendConfig = {
    total: { label: "Total runs", color: "var(--chart-2)" },
    failed: { label: "Failed runs", color: "var(--chart-5)" }
  } satisfies ChartConfig;
  const agentsSpendTrendConfig = {
    usd: { label: "USD", color: "var(--chart-1)" }
  } satisfies ChartConfig;
  const agentsSuccessTrendConfig = {
    successRate: { label: "Success rate %", color: "var(--chart-3)" }
  } satisfies ChartConfig;
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
  const templatesSummary = useMemo(() => {
    const total = templates.length;
    const published = templates.filter((template) => template.status === "published").length;
    const draft = templates.filter((template) => template.status === "draft").length;
    const archived = templates.filter((template) => template.status === "archived").length;
    const companyVisible = templates.filter((template) => template.visibility === "company").length;
    const privateVisible = templates.filter((template) => template.visibility === "private").length;
    const variables = templates.reduce((sum, template) => sum + template.variables.length, 0);
    return { total, published, draft, archived, companyVisible, privateVisible, variables };
  }, [templates]);
  const pluginBuilderManifestJson = useMemo(() => {
    const capabilities = pluginBuilderCapabilities
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    return JSON.stringify(
      {
        id: pluginBuilderId.trim(),
        version: "0.1.0",
        displayName: pluginBuilderName.trim(),
        description: pluginBuilderDescription.trim(),
        kind: "lifecycle",
        hooks: [pluginBuilderHook],
        capabilities,
        runtime: {
          type: "prompt",
          entrypoint: "prompt:inline",
          timeoutMs: 5000,
          retryCount: 0,
          promptTemplate: pluginBuilderPromptTemplate.trim()
        }
      },
      null,
      2
    );
  }, [
    pluginBuilderCapabilities,
    pluginBuilderDescription,
    pluginBuilderHook,
    pluginBuilderId,
    pluginBuilderName,
    pluginBuilderPromptTemplate
  ]);
  const pluginBuilderValidationError = useMemo(() => {
    if (!pluginBuilderId.trim()) {
      return "Plugin id is required.";
    }
    if (!pluginBuilderName.trim()) {
      return "Plugin title is required.";
    }
    if (!pluginBuilderPromptTemplate.trim()) {
      return "Prompt template is required.";
    }
    return null;
  }, [pluginBuilderId, pluginBuilderName, pluginBuilderPromptTemplate]);
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
    if (!companyId || !isModelsNav) {
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const response = (await apiGet("/observability/models/pricing", companyId)) as {
          ok: true;
          data: ModelPricingRow[];
        };
        if (!cancelled) {
          setModelPricing(response.data);
        }
      } catch {
        // Best-effort fetch; errors are surfaced via runCrudAction when saving.
      }
    })();
    return () => {
      cancelled = true;
    };
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
    const now = new Date();
    const dayKeys: string[] = [];
    for (let i = 13; i >= 0; i -= 1) {
      const day = new Date(now);
      day.setHours(0, 0, 0, 0);
      day.setDate(day.getDate() - i);
      dayKeys.push(`${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`);
    }
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
          role: agent.role,
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
        id: "goals",
        header: "Goals",
        cell: ({ row }) => <div className={styles.formatDurationContainer1}>{projectGoalCountById.get(row.original.id) ?? 0}</div>
      },
      {
        id: "actions",
        header: () => <div className={styles.tableHeaderAlignRight}>Actions</div>,
        enableSorting: false,
        cell: ({ row }) => {
          const project = row.original;
          return (
            <div className={styles.formatDurationContainer3}>
              <CreateProjectModal
                companyId={companyId!}
                goals={goals}
                project={project}
                triggerLabel="Edit"
                triggerVariant="outline"
                triggerSize="sm"
              />
              <ConfirmActionModal
                triggerLabel="Delete"
                triggerVariant="outline"
                triggerSize="sm"
                title="Delete project?"
                description={`Delete "${project.name}" and all linked issues.`}
                confirmLabel="Delete"
                onConfirm={() => removeProject(project)}
                triggerDisabled={isActionPending(`project:${project.id}:delete`)}
              />
            </div>
          );
        }
      }
    ],
    [companyId, goals, isActionPending, projectGoalCountById]
  );

  const goalColumns = useMemo<ColumnDef<GoalRow>[]>(
    () => [
      {
        accessorKey: "title",
        header: ({ column }) => <DataTableColumnHeader column={column} title="Goal" />,
        cell: ({ row }) => (
          <div className={styles.formatDurationContainer4}>
            <div className={styles.formatDurationContainer1}>{row.original.title}</div>
            {row.original.description ? (
              <div className={styles.formatDurationContainer2}>{row.original.description}</div>
            ) : null}
          </div>
        )
      },
      {
        accessorKey: "level",
        header: ({ column }) => <DataTableColumnHeader column={column} title="Level" />,
        cell: ({ row }) => <Badge variant="outline">{row.original.level}</Badge>
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
        id: "actions",
        header: () => <div className={styles.tableHeaderAlignRight}>Actions</div>,
        enableSorting: false,
        cell: ({ row }) => {
          const goal = row.original;
          return (
            <div className={styles.formatDurationContainer3}>
              <CreateGoalModal
                companyId={companyId!}
                goal={{
                  id: goal.id,
                  level: goal.level as "company" | "project" | "agent",
                  title: goal.title,
                  description: goal.description ?? null,
                  status: goal.status
                }}
                triggerLabel="Edit"
                triggerVariant="outline"
                triggerSize="sm"
              />
              <ConfirmActionModal
                triggerLabel="Delete"
                triggerVariant="outline"
                triggerSize="sm"
                title="Delete goal?"
                description={`Delete "${goal.title}".`}
                confirmLabel="Delete"
                onConfirm={() => removeGoal(goal)}
                triggerDisabled={isActionPending(`goal:${goal.id}:delete`)}
              />
            </div>
          );
        }
      }
    ],
    [companyId, isActionPending, onboardingRuntimeFallback, suggestedAgentRuntimeCwd]
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
        header: ({ column }) => <DataTableColumnHeader column={column} title="Role" />
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
      },
      {
        id: "actions",
        header: () => <div className={styles.tableHeaderAlignRight}>Actions</div>,
        enableSorting: false,
        cell: ({ row }) => {
          const agent = row.original;
          return (
            <div className={styles.formatDurationContainer3}>
              <CreateAgentModal
                companyId={companyId!}
                availableAgents={agents.map((entry) => ({ id: entry.id, name: entry.name }))}
                suggestedRuntimeCwd={suggestedAgentRuntimeCwd}
                fallbackDefaults={onboardingRuntimeFallback}
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
                triggerLabel="Edit"
                triggerVariant="outline"
                triggerSize="sm"
              />
              <ConfirmActionModal
                triggerLabel="Delete"
                triggerVariant="outline"
                triggerSize="sm"
                title="Delete agent?"
                description={`Delete "${agent.name}".`}
                confirmLabel="Delete"
                onConfirm={() => removeAgent(agent)}
                triggerDisabled={isActionPending(`agent:${agent.id}:delete`)}
              />
            </div>
          );
        }
      }
    ],
    [agentNameById, agents, companyId, isActionPending, onboardingRuntimeFallback, suggestedAgentRuntimeCwd]
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
    [isActionPending, openEditPluginDialog]
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
              <Link href={{ pathname: "/governance", query: { companyId: companyId! } }}>
                Open
              </Link>
            </Button>
          </div>
        )
      }
    ],
    [companyId, isActionPending]
  );

  const auditColumns = useMemo<ColumnDef<AuditRow>[]>(
    () => [
      {
        accessorKey: "eventType",
        header: ({ column }) => <DataTableColumnHeader column={column} title="Event" />,
        cell: ({ row }) => <div className={styles.formatDurationContainer1}>{row.original.eventType}</div>
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
        cell: ({ row }) => <div className={styles.formatDurationContainer5}>{formatDateTime(row.original.createdAt)}</div>
      }
    ],
    []
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
        cell: ({ row }) => (
          <div className={styles.formatDurationContainer5}>{agentNameById.get(row.original.agentId) ?? shortId(row.original.agentId)}</div>
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
          <div className={styles.formatDurationContainer5}>{formatDuration(row.original.startedAt, row.original.finishedAt)}</div>
        )
      },
      {
        accessorKey: "startedAt",
        header: ({ column }) => <DataTableColumnHeader column={column} title="Started" />,
        cell: ({ row }) => <div className={styles.formatDurationContainer5}>{formatDateTime(row.original.startedAt)}</div>
      },
      {
        accessorKey: "message",
        header: "Message",
        cell: ({ row }) => (
          <div className={styles.runMessageCellContainer} title={row.original.message ?? "No message"}>
            {row.original.message ?? "No message"}
          </div>
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
    [agentNameById, isActionPending, runDetailsByRunId]
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
        cell: ({ row }) => <div className={styles.formatDurationContainer5}>{formatDateTime(row.original.createdAt)}</div>
      }
    ],
    [companyId]
  );

  const modelPricingColumns = useMemo<ColumnDef<ModelPricingRow>[]>(
    () => [
      {
        accessorKey: "providerType",
        header: ({ column }) => <DataTableColumnHeader column={column} title="Provider" />,
        cell: ({ row }) => <div className={styles.formatDurationContainer1}>{row.original.providerType}</div>
      },
      {
        accessorKey: "modelId",
        header: ({ column }) => <DataTableColumnHeader column={column} title="Model" />,
        cell: ({ row }) => <div className={styles.formatDurationContainer1}>{row.original.modelId}</div>
      },
      {
        accessorKey: "inputUsdPer1M",
        header: ({ column }) => <DataTableColumnHeader column={column} title="Input USD / 1M" />,
        cell: ({ row }) => (
          <div className={styles.formatDurationContainer5}>${row.original.inputUsdPer1M.toFixed(6)}</div>
        )
      },
      {
        accessorKey: "outputUsdPer1M",
        header: ({ column }) => <DataTableColumnHeader column={column} title="Output USD / 1M" />,
        cell: ({ row }) => (
          <div className={styles.formatDurationContainer5}>${row.original.outputUsdPer1M.toFixed(6)}</div>
        )
      },
      {
        id: "updated",
        header: "Last updated",
        cell: ({ row }) => (
          <div className={styles.formatDurationContainer5}>
            {row.original.updatedAt ? formatDateTime(row.original.updatedAt) : "n/a"}
          </div>
        )
      },
      {
        id: "actions",
        header: "Actions",
        enableSorting: false,
        cell: ({ row }) => {
          const entry = row.original;
          return (
            <div className={styles.formatDurationContainer3}>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  const normalizedProvider =
                    resolveModelCatalogProvider(entry.providerType) ?? "openai_api";
                  setModelDialogValue({
                    providerType: normalizedProvider,
                    modelId: entry.modelId,
                    inputUsdPer1M: entry.inputUsdPer1M.toString(),
                    outputUsdPer1M: entry.outputUsdPer1M.toString()
                  });
                  setModelDialogOpen(true);
                }}
              >
                Edit
              </Button>
            </div>
          );
        }
      }
    ],
    []
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
          const canDeletePlugin = !plugin.runtimeEntrypoint.startsWith("builtin:");
          const installActionKey = `plugin:${plugin.id}:install`;
          const activateActionKey = `plugin:${plugin.id}:activate`;
          const deactivateActionKey = `plugin:${plugin.id}:deactivate`;
          return (
            <div className={styles.formatDurationContainer3}>
              {!plugin.companyConfig ? (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={isActionPending(installActionKey)}
                  onClick={() => installPlugin(plugin.id)}
                >
                  Install
                </Button>
              ) : plugin.companyConfig.enabled ? (
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
                  variant="outline"
                  size="sm"
                  disabled={isActionPending(activateActionKey)}
                  onClick={() => setPluginEnabled(plugin, true)}
                >
                  Activate
                </Button>
              )}
              <Button
                variant="outline"
                size="sm"
                onClick={() => openEditPluginDialog(plugin)}
              >
                Edit
              </Button>
              {canDeletePlugin ? (
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
              ) : null}
            </div>
          );
        }
      }
    ],
    [deletePlugin, isActionPending]
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
                variant="outline"
                size="sm"
                disabled={applyPending}
                onClick={() => applyTemplate(template.id)}
              >
                {applyPending ? "Applying..." : "Apply"}
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
            <CreateIssueModal companyId={scopedCompanyId} projects={projects} agents={agents} />
          </div>
        );
      case "Projects":
        return (
          <div className={styles.renderSectionActionsContainer1}>
            <CreateProjectModal companyId={scopedCompanyId} goals={goals} />
            <CreateIssueModal companyId={scopedCompanyId} projects={projects} agents={agents} />
          </div>
        );
      case "Issues":
        return (
          <div className={styles.renderSectionActionsContainer1}>
            <CreateIssueModal companyId={scopedCompanyId} projects={projects} agents={agents} />
            <CreateProjectModal companyId={scopedCompanyId} goals={goals} />
          </div>
        );
      case "Goals":
        return (
          <div className={styles.renderSectionActionsContainer1}>
            <CreateGoalModal companyId={scopedCompanyId} />
          </div>
        );
      case "Agents":
      case "Organization":
        return (
          <div className={styles.renderSectionActionsContainer1}>
            <CreateAgentModal
              companyId={scopedCompanyId}
              availableAgents={agents.map((entry) => ({ id: entry.id, name: entry.name }))}
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
            <div className={styles.dashboardAgentSpotlightGrid}>
              {dashboardAgentSnapshots.length > 0 ? (
                dashboardAgentSnapshots.map((agentSnapshot) => (
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
                ))
              ) : (
                <Card>
                  <CardHeader>
                    <CardTitle>No active agents yet</CardTitle>
                    <CardDescription>Hire agents to unlock per-agent live workload and execution charts.</CardDescription>
                  </CardHeader>
                </Card>
              )}
            </div>
            <div className={styles.dashboardAttentionGrid}>
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
                  <div className={styles.dashboardActionQueueActions}>
                    <Button asChild size="sm">
                      <Link href={{ pathname: "/governance", query: { companyId: companyId! } }}>Review approvals</Link>
                    </Button>
                    <Button asChild size="sm" variant="outline">
                      <Link href={{ pathname: "/inbox", query: { companyId: companyId! } }}>Open inbox</Link>
                    </Button>
                  </div>
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
            {projects.length === 0 ? (
              <EmptyState>Create a project to unlock issue creation and dedicated project pages.</EmptyState>
            ) : (
              <>
                <div className={cn("ui-stats", "mt-4")}>
                  <MetricCard label="Total projects" value={projectsSummary.total} />
                  <MetricCard label="With open issues" value={projectsSummary.withOpenIssues} />
                  <MetricCard label="No open issues" value={projectsSummary.noOpenIssues} />
                  <MetricCard label="No issues" value={projectsSummary.noIssues} />
                </div>
                <DataTable
                  columns={projectColumns}
                  data={filteredProjects}
                  emptyMessage="No projects match current filters."
                  toolbarActions={
                    <div className={styles.goalsFiltersCardContent}>
                      <Input
                        value={projectsQuery}
                        onChange={(event) => setProjectsQuery(event.target.value)}
                        placeholder="Search project name or description..."
                        className={styles.goalsFiltersInput}
                      />
                      <Select
                        value={projectsActivityFilter}
                        onValueChange={(value) => setProjectsActivityFilter(value as "all" | "active" | "no_open_issues" | "no_issues")}
                      >
                        <SelectTrigger className={styles.goalsFiltersSelect}>
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
            )}
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
                <CreateIssueModal companyId={companyId} projects={projects} agents={agents} />
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
              actions={<CreateGoalModal companyId={companyId} triggerSize="sm" />}
            />
            {goals.length === 0 ? (
              <EmptyState>Create a goal to connect strategy with execution.</EmptyState>
            ) : (
              <DataTable
                columns={goalColumns}
                data={filteredGoals}
                emptyMessage="No goals match current filters."
                toolbarActions={
                  <div className={styles.goalsFiltersCardContent}>
                    <Input
                      value={goalsQuery}
                      onChange={(event) => setGoalsQuery(event.target.value)}
                      placeholder="Search title, description, status, level, or project..."
                      className={styles.goalsFiltersInput}
                    />
                    <Select value={goalsStatusFilter} onValueChange={setGoalsStatusFilter}>
                      <SelectTrigger className={styles.goalsFiltersSelect}>
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
                      <SelectTrigger className={styles.goalsFiltersSelect}>
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
                  </div>
                }
              />
            )}
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
                  suggestedRuntimeCwd={suggestedAgentRuntimeCwd}
                  fallbackDefaults={onboardingRuntimeFallback}
                />
              }
            />
            {agents.length === 0 ? (
              <EmptyState>Hire your first agent to populate the org chart and issue assignees.</EmptyState>
            ) : (
              <>
                {agentsInsightsHasData ? (
                  <div className={styles.agentsInsightsChartsGrid}>
                    <Card>
                      <CardHeader>
                        <CardTitle>Run volume trend</CardTitle>
                        <CardDescription>Daily total and failed runs over the last 14 days.</CardDescription>
                      </CardHeader>
                      <CardContent>
                        <ChartContainer config={agentsRunsTrendConfig} className={styles.agentsInsightsChartContainer}>
                          <LineChart accessibilityLayer data={agentsRunsTrendData} margin={{ top: 8, left: -8, right: -8 }}>
                            <CartesianGrid vertical={false} strokeDasharray="4 4" strokeOpacity={0.3} />
                            <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={10} minTickGap={20} />
                            <YAxis hide />
                            <ChartTooltip content={<ChartTooltipContent indicator="line" />} cursor={false} />
                            <Line type="monotone" dataKey="total" stroke="var(--color-total)" strokeWidth={2.2} dot={false} />
                            <Line type="monotone" dataKey="failed" stroke="var(--color-failed)" strokeWidth={2} dot={false} />
                          </LineChart>
                        </ChartContainer>
                      </CardContent>
                    </Card>
                    <Card>
                      <CardHeader>
                        <CardTitle>Spend trend</CardTitle>
                        <CardDescription>Daily USD spend over the last 30 days.</CardDescription>
                      </CardHeader>
                      <CardContent>
                        <ChartContainer config={agentsSpendTrendConfig} className={styles.agentsInsightsChartContainer}>
                          <LineChart accessibilityLayer data={agentsSpendTrendData} margin={{ top: 8, left: -8, right: -8 }}>
                            <CartesianGrid vertical={false} strokeDasharray="4 4" strokeOpacity={0.3} />
                            <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={10} minTickGap={20} />
                            <YAxis hide />
                            <ChartTooltip content={<ChartTooltipContent indicator="line" />} cursor={false} />
                            <Line type="monotone" dataKey="usd" stroke="var(--color-usd)" strokeWidth={2.2} dot={false} />
                          </LineChart>
                        </ChartContainer>
                      </CardContent>
                    </Card>
                    <Card>
                      <CardHeader>
                        <CardTitle>Success-rate trend</CardTitle>
                        <CardDescription>Daily completion quality from completed vs failed runs.</CardDescription>
                      </CardHeader>
                      <CardContent>
                        <ChartContainer config={agentsSuccessTrendConfig} className={styles.agentsInsightsChartContainer}>
                          <LineChart accessibilityLayer data={agentsRunsTrendData} margin={{ top: 8, left: -8, right: -8 }}>
                            <CartesianGrid vertical={false} strokeDasharray="4 4" strokeOpacity={0.3} />
                            <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={10} minTickGap={20} />
                            <YAxis hide />
                            <ChartTooltip content={<ChartTooltipContent indicator="line" />} cursor={false} />
                            <Line
                              type="monotone"
                              dataKey="successRate"
                              stroke="var(--color-successRate)"
                              strokeWidth={2.2}
                              dot={false}
                            />
                          </LineChart>
                        </ChartContainer>
                      </CardContent>
                    </Card>
                  </div>
                ) : (
                  <Card className={styles.agentsInsightsEmptyCard}>
                    <CardContent>
                      <p className="text-sm text-muted-foreground">
                        No recent run or spend activity for the selected agent filters.
                      </p>
                    </CardContent>
                  </Card>
                )}
                <DataTable
                  columns={agentColumns}
                  data={filteredAgents}
                  emptyMessage="No agents match current filters."
                  toolbarActions={
                    <div className={styles.agentsFiltersCardContent}>
                      <Input
                        value={agentsQuery}
                        onChange={(event) => setAgentsQuery(event.target.value)}
                        placeholder="Search name, role, status, or provider..."
                        className={styles.agentsFiltersInput}
                      />
                      <Select value={agentsStatusFilter} onValueChange={setAgentsStatusFilter}>
                        <SelectTrigger className={styles.agentsFiltersSelect}>
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
                        <SelectTrigger className={styles.agentsFiltersSelect}>
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
                        <SelectTrigger className={styles.agentsFiltersSelect}>
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
                        <SelectTrigger className={styles.agentsFiltersSelect}>
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
                  }
                />
              </>
            )}
          </>
        );
      case "Organization":
        return (
          <>
          <SectionHeading
              title="Organization"
              description="The org chart of the company's agents."
            />
            <OrgChart agents={agents} />
          </>
        );
      case "Inbox":
        return (
          <>
            <SectionHeading
              title="Inbox"
              description="Incoming items to approve or dismiss for the board."
            />
            {sortedInboxItems.length === 0 ? (
              <EmptyState>No inbox items in the current governance window.</EmptyState>
            ) : (
              <>
                <div className="ui-stats">
                  <MetricCard label="Items in inbox" value={inboxSummary.total} />
                  <MetricCard label="Pending actions" value={inboxSummary.pending} />
                  <MetricCard label="Resolved history" value={inboxSummary.resolved} />
                  <MetricCard label="Unseen / Dismissed" value={`${inboxSummary.unseen} / ${inboxSummary.dismissed}`} />
                </div>
                <DataTable
                  columns={inboxColumns}
                  data={filteredInboxItems}
                  emptyMessage="No inbox items match current filters."
                  toolbarActions={
                    <div className={styles.governanceFiltersCardContent}>
                      <Input
                        value={inboxQuery}
                        onChange={(event) => setInboxQuery(event.target.value)}
                        placeholder="Search action, status, or payload..."
                        className={styles.governanceFiltersInput}
                      />
                      <Select value={inboxStateFilter} onValueChange={(value) => setInboxStateFilter(value as "all" | "pending" | "resolved")}>
                        <SelectTrigger className={styles.governanceFiltersSelect}>
                          <SelectValue placeholder="Scope" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="all">All items</SelectItem>
                          <SelectItem value="pending">Pending</SelectItem>
                          <SelectItem value="resolved">Resolved</SelectItem>
                        </SelectContent>
                      </Select>
                      <Select value={inboxSeenFilter} onValueChange={(value) => setInboxSeenFilter(value as "all" | "seen" | "unseen")}>
                        <SelectTrigger className={styles.governanceFiltersSelect}>
                          <SelectValue placeholder="Seen" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="all">Seen + unseen</SelectItem>
                          <SelectItem value="unseen">Unseen only</SelectItem>
                          <SelectItem value="seen">Seen only</SelectItem>
                        </SelectContent>
                      </Select>
                      <Select
                        value={inboxDismissedFilter}
                        onValueChange={(value) => setInboxDismissedFilter(value as "all" | "active" | "dismissed")}
                      >
                        <SelectTrigger className={styles.governanceFiltersSelect}>
                          <SelectValue placeholder="Dismissed" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="all">All dismissal states</SelectItem>
                          <SelectItem value="active">Not dismissed</SelectItem>
                          <SelectItem value="dismissed">Dismissed only</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  }
                />
              </>
            )}
          </>
        );
      case "Approvals":
        return (
          <>
            <SectionHeading
              title="Approvals"
              description="Items to approve or dismiss for the board."
            />
            {approvals.length === 0 ? (
              <EmptyState>No approvals yet. Hire an agent or activate a goal to populate approvals.</EmptyState>
            ) : (
              <>
                <div className="ui-stats">
                  <MetricCard label="Approvals in scope" value={governanceSummary.total} />
                  <MetricCard label="Pending" value={governanceSummary.pending} />
                  <MetricCard
                    label="Approved / Rejected / Overridden"
                    value={`${governanceSummary.approved} / ${governanceSummary.rejected} / ${governanceSummary.overridden}`}
                  />
                  <MetricCard label="Avg resolution time" value={governanceSummary.avgResolutionLabel} />
                </div>
                <DataTable
                  columns={approvalColumns}
                  data={filteredApprovals}
                  emptyMessage="No approvals match current filters."
                  toolbarActions={
                    <div className={styles.governanceFiltersCardContent}>
                      <Input
                        value={governanceQuery}
                        onChange={(event) => setGovernanceQuery(event.target.value)}
                        placeholder="Search action, status, or payload..."
                        className={styles.governanceFiltersInput}
                      />
                      <Select value={governanceStatusFilter} onValueChange={setGovernanceStatusFilter}>
                        <SelectTrigger className={styles.governanceFiltersSelect}>
                          <SelectValue placeholder="Status" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="all">All statuses</SelectItem>
                          {governanceStatusOptions.map((status) => (
                            <SelectItem key={status} value={status}>
                              {status}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Select value={governanceActionFilter} onValueChange={setGovernanceActionFilter}>
                        <SelectTrigger className={styles.governanceFiltersSelect}>
                          <SelectValue placeholder="Action" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="all">All actions</SelectItem>
                          {governanceActionOptions.map((action) => (
                            <SelectItem key={action} value={action}>
                              {action}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Select
                        value={governanceWindowFilter}
                        onValueChange={(value) => setGovernanceWindowFilter(value as "today" | "7d" | "30d" | "90d" | "all")}
                      >
                        <SelectTrigger className={styles.governanceFiltersSelect}>
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
            )}
          </>
        );
      case "Logs":
        return (
          <>
            <SectionHeading
              title="Logs"
              description="Audit events emitted by workspace actions and governance flows."
            />
            {auditEvents.length === 0 ? (
              <EmptyState>Trace logs appear after workspace actions and governance events.</EmptyState>
            ) : (
              <>
                <div className={cn("ui-stats", "mt-4")}>
                  <MetricCard label="Events in scope" value={traceSummary.total} />
                  <MetricCard label="Unique entities" value={traceSummary.uniqueEntities} />
                  <MetricCard label="Event types" value={traceSummary.uniqueEventTypes} hint={`Top: ${traceSummary.topEventType}`} />
                  <MetricCard label="Anomalies" value={traceSummary.anomalies} hint="fail/error/reject/timeout events" />
                </div>
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
                              {eventType}
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
            )}
          </>
        );
      case "Runs":
        return (
          <>
            <SectionHeading
              title="Runs"
              description="Heartbeat runs from agent execution, including status, duration, and diagnostics."
            />
            {heartbeatRuns.length === 0 ? (
              <EmptyState>No heartbeat runs yet.</EmptyState>
            ) : (
              <>
                <div className={cn("ui-stats", "mt-4")}>
                  <MetricCard label="Runs in scope" value={runsSummary.total} />
                  <MetricCard label="Success rate" value={`${runsSummary.successRate.toFixed(1)}%`} />
                  <MetricCard label="Failed runs" value={runsSummary.failed} />
                  <MetricCard label="Avg duration" value={runsSummary.avgDuration} hint={`${runsSummary.running} currently running`} />
                </div>
                <div className={styles.runTrendChartsGrid}>
                  <Card>
                    <CardHeader>
                      <CardTitle>Run trend</CardTitle>
                      <CardDescription>Daily completed vs failed runs (last 14 days, based on current filters).</CardDescription>
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
                <DataTable
                  columns={heartbeatRunColumns}
                  data={filteredHeartbeatRuns}
                  emptyMessage="No heartbeat runs match current filters."
                  toolbarActions={
                    <div className={styles.runFiltersCardContent}>
                      <Input
                        value={runsQuery}
                        onChange={(event) => setRunsQuery(event.target.value)}
                        placeholder="Search run id, message, status, or agent..."
                        className={styles.runFiltersInput}
                      />
                      <Select value={runsStatusFilter} onValueChange={setRunsStatusFilter}>
                        <SelectTrigger className={styles.runFiltersSelect}>
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
                        <SelectTrigger className={styles.runFiltersSelect}>
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
                        <SelectTrigger className={styles.runFiltersSelect}>
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
                        <SelectTrigger className={styles.runFiltersSelect}>
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
            )}
          </>
        );
      case "Costs":
        return (
          <>
            <SectionHeading title="Costs" description="Tracked token and cost usage for agents and issue execution." />
            {costEntries.length === 0 ? (
              <EmptyState>No runtime cost data yet.</EmptyState>
            ) : (
              <>
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
                      <CardTitle>Daily usage</CardTitle>
                      <CardDescription>
                        {activeCostMonth === "all"
                          ? "Showing the latest available month. Change month for a focused view."
                          : `${selectedMonthLabel} by day`}
                      </CardDescription>
                    </CardHeader>
                    <CardContent>
                      <ChartContainer config={costDailyConfig} className={styles.costLedgerChartContainer}>
                        <AreaChart accessibilityLayer data={selectedMonthChartData} margin={{ top: 8, left: -8, right: -8 }}>
                          <defs>
                            <linearGradient id="costDailyUsdGradient" x1="0" y1="0" x2="0" y2="1">
                              <stop offset="10%" stopColor="var(--color-usd)" stopOpacity={0.45} />
                              <stop offset="90%" stopColor="var(--color-usd)" stopOpacity={0.05} />
                            </linearGradient>
                            <linearGradient id="costDailyTokensGradient" x1="0" y1="0" x2="0" y2="1">
                              <stop offset="10%" stopColor="var(--color-tokens)" stopOpacity={0.4} />
                              <stop offset="90%" stopColor="var(--color-tokens)" stopOpacity={0.04} />
                            </linearGradient>
                          </defs>
                          <CartesianGrid vertical={false} strokeDasharray="4 4" strokeOpacity={0.3} />
                          <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={10} minTickGap={22} />
                          <YAxis hide />
                          <ChartTooltip content={<ChartTooltipContent indicator="line" />} cursor={false} />
                          <Area
                            type="monotone"
                            dataKey="usd"
                            stroke="var(--color-usd)"
                            fill="url(#costDailyUsdGradient)"
                            fillOpacity={1}
                            strokeWidth={2}
                          />
                          <Area
                            type="monotone"
                            dataKey="tokens"
                            stroke="var(--color-tokens)"
                            fill="url(#costDailyTokensGradient)"
                            fillOpacity={1}
                            strokeWidth={2}
                          />
                        </AreaChart>
                      </ChartContainer>
                    </CardContent>
                  </Card>
                  <Card>
                    <CardHeader>
                      <CardTitle>Monthly spend trend</CardTitle>
                      <CardDescription>Last 6 months total spend in USD.</CardDescription>
                    </CardHeader>
                    <CardContent>
                      <ChartContainer config={costMonthlyConfig} className={styles.costLedgerChartContainer}>
                        <AreaChart accessibilityLayer data={monthlyCostChartData} margin={{ top: 8, left: -8, right: -8 }}>
                          <defs>
                            <linearGradient id="costMonthlyUsdGradient" x1="0" y1="0" x2="0" y2="1">
                              <stop offset="8%" stopColor="var(--color-usd)" stopOpacity={0.5} />
                              <stop offset="90%" stopColor="var(--color-usd)" stopOpacity={0.05} />
                            </linearGradient>
                          </defs>
                          <CartesianGrid vertical={false} strokeDasharray="4 4" strokeOpacity={0.35} />
                          <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={10} minTickGap={20} />
                          <YAxis hide />
                          <ChartTooltip content={<ChartTooltipContent indicator="line" />} cursor={false} />
                          <Area
                            type="monotone"
                            dataKey="usd"
                            stroke="var(--color-usd)"
                            fill="url(#costMonthlyUsdGradient)"
                            fillOpacity={1}
                            strokeWidth={2.2}
                          />
                        </AreaChart>
                      </ChartContainer>
                    </CardContent>
                  </Card>
                </div>
                <DataTable
                  columns={costColumns}
                  data={filteredCostEntries}
                  emptyMessage="No runtime cost data for the selected scope."
                  toolbarActions={
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
              </>
            )}
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
            <AgentRuntimeDefaultsCard companyId={companyId} fallbackDefaults={onboardingRuntimeFallback} />
          </>
        );
      case "Plugins": {
        return (
          <>
            <SectionHeading
              title="Plugins"
              description="Install plugins, activate or deactivate them, and manage installed plugin entries."
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
            <div className="ui-stats">
              <MetricCard label="Plugins in scope" value={pluginsSummary.total} />
              <MetricCard label="Active" value={pluginsSummary.active} />
              <MetricCard label="Installed" value={pluginsSummary.installed} />
              <MetricCard label="Kinds / Granted caps" value={`${pluginsSummary.kinds} / ${pluginsSummary.grantedCapabilities}`} />
            </div>
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
                  <DialogTitle>{pluginBuilderMode === "edit" ? "Edit plugin" : "Install plugin"}</DialogTitle>
                  <DialogDescription>
                    {pluginBuilderMode === "edit"
                      ? "Update plugin metadata and runtime prompt."
                      : "Create a prompt plugin."}
                  </DialogDescription>
                </DialogHeader>
                <form
                  className="space-y-4"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void runCrudAction(
                      async () => {
                        await apiPost("/plugins/install-from-json", companyId!, {
                          manifestJson: pluginBuilderManifestJson,
                          install: pluginBuilderMode === "create"
                        });
                        setInstallPluginDialogOpen(false);
                      },
                      "Failed to save plugin manifest JSON.",
                      "plugin:install-from-json"
                    );
                  }}
                >
                  <div className="ui-dialog-content-scrollable">
                    <FieldGroup>
                      <Field>
                        <FieldLabel htmlFor="plugin-builder-id">Plugin ID</FieldLabel>
                        <Input
                          id="plugin-builder-id"
                          value={pluginBuilderId}
                          onChange={(event) => setPluginBuilderId(event.target.value)}
                          placeholder="plugin-id"
                        />
                        <FieldDescription>Stable identifier used for file path and plugin registration.</FieldDescription>
                      </Field>
                      <Field>
                        <FieldLabel htmlFor="plugin-builder-title">Title</FieldLabel>
                        <Input
                          id="plugin-builder-title"
                          value={pluginBuilderName}
                          onChange={(event) => setPluginBuilderName(event.target.value)}
                          placeholder="Plugin title"
                        />
                      </Field>
                      <Field>
                        <FieldLabel htmlFor="plugin-builder-description">Description</FieldLabel>
                        <Textarea
                          id="plugin-builder-description"
                          value={pluginBuilderDescription}
                          onChange={(event) => setPluginBuilderDescription(event.target.value)}
                          className="min-h-[96px]"
                          placeholder="What this plugin does"
                        />
                      </Field>
                      <Field>
                        <FieldLabel>Run hook</FieldLabel>
                        <Select value={pluginBuilderHook} onValueChange={(value) => setPluginBuilderHook(value as (typeof pluginBuilderHooks)[number])}>
                          <SelectTrigger>
                            <SelectValue placeholder="Hook" />
                          </SelectTrigger>
                          <SelectContent>
                            {pluginBuilderHooks.map((hook) => (
                              <SelectItem key={hook} value={hook}>
                                {hook}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </Field>
                      <Field>
                        <FieldLabel htmlFor="plugin-builder-capabilities">Capabilities</FieldLabel>
                        <Input
                          id="plugin-builder-capabilities"
                          value={pluginBuilderCapabilities}
                          onChange={(event) => setPluginBuilderCapabilities(event.target.value)}
                          placeholder="emit_audit,network"
                        />
                        <FieldDescription>Comma-separated capabilities the plugin declares.</FieldDescription>
                      </Field>
                      <Field>
                        <FieldLabel htmlFor="plugin-builder-template">Prompt template</FieldLabel>
                        <Textarea
                          id="plugin-builder-template"
                          value={pluginBuilderPromptTemplate}
                          onChange={(event) => setPluginBuilderPromptTemplate(event.target.value)}
                          className="min-h-[140px] font-mono text-base"
                          placeholder="Example: Inject relevant knowledge for this run. Company={{companyId}} Agent={{agentId}}"
                        />
                        <FieldDescription>
                          Supports placeholders like {"{{companyId}}"}, {"{{agentId}}"}, {"{{runId}}"}, and {"{{pluginConfig}}"}.
                        </FieldDescription>
                      </Field>
                    </FieldGroup>
                  </div>
                  <DialogFooter showCloseButton>
                    <Button
                      type="submit"
                      disabled={Boolean(pluginBuilderValidationError) || isActionPending("plugin:install-from-json")}
                    >
                      {pluginBuilderMode === "edit" ? "Save changes" : "Save"}
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
            <div className="ui-stats">
              <MetricCard label="Templates in scope" value={templatesSummary.total} />
              <MetricCard label="Published" value={templatesSummary.published} />
              <MetricCard label="Draft / Archived" value={`${templatesSummary.draft} / ${templatesSummary.archived}`} />
              <MetricCard
                label="Company / Private · Variables"
                value={`${templatesSummary.companyVisible} / ${templatesSummary.privateVisible} · ${templatesSummary.variables}`}
              />
            </div>
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
              <DialogContent className="max-h-[80vh] overflow-y-auto sm:max-w-3xl">
                <DialogHeader>
                  <DialogTitle>{selectedTemplate?.name ?? "Template details"}</DialogTitle>
                  <DialogDescription>
                    {selectedTemplate?.description?.trim() || "Portable org template details and manifest."}
                  </DialogDescription>
                </DialogHeader>
                {selectedTemplate ? (
                  <div className="space-y-4">
                    <div className="grid gap-2 text-base sm:grid-cols-3">
                      <div>
                        <div className="text-muted-foreground">Slug</div>
                        <div className="font-mono">{selectedTemplate.slug}</div>
                      </div>
                      <div>
                        <div className="text-muted-foreground">Version</div>
                        <div className="font-mono">{selectedTemplate.currentVersion}</div>
                      </div>
                      <div>
                        <div className="text-muted-foreground">Status</div>
                        <div>{selectedTemplate.status}</div>
                      </div>
                    </div>
                    <div>
                      <div className="mb-1 text-base text-muted-foreground">Variables</div>
                      <pre className="rounded-md border bg-muted p-3 text-base whitespace-pre-wrap break-all">
                        {JSON.stringify(selectedTemplate.variables ?? [], null, 2)}
                      </pre>
                    </div>
                    <div>
                      <div className="mb-1 text-base text-muted-foreground">Manifest</div>
                      <pre className="rounded-md border bg-muted p-3 text-base whitespace-pre-wrap break-all">
                        {JSON.stringify(selectedTemplate.manifest ?? {}, null, 2)}
                      </pre>
                    </div>
                  </div>
                ) : null}
                <DialogFooter>
                  <Button type="button" variant="outline" onClick={() => setTemplateDetailsOpen(false)}>
                    Close
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </>
        );
      case "Models":
        return (
          <>
            <SectionHeading
              title="Models"
              description="Manage per-model input and output pricing used for LLM cost estimation."
              actions={
                <Button
                  variant="default"
                  size="sm"
                  disabled={!companyId}
                  onClick={() => {
                    setModelDialogValue({
                      providerType: "openai_api",
                      modelId: "",
                      inputUsdPer1M: "",
                      outputUsdPer1M: ""
                    });
                    setModelDialogOpen(true);
                  }}
                >
                  Add model
                </Button>
              }
            />
            {!companyId ? (
              <EmptyState>Create or select a company to configure model pricing.</EmptyState>
            ) : (
              <>
                {missingModelPricingPairs.length > 0 ? (
                  <Alert>
                    <AlertTitle>Missing pricing rows detected</AlertTitle>
                    <AlertDescription>
                      {missingModelPricingPairs.length} observed model
                      {missingModelPricingPairs.length === 1 ? "" : "s"} do not have an exact pricing row yet.
                      Runs are allowed, but those costs will be marked as missing pricing until rows are added.
                    </AlertDescription>
                  </Alert>
                ) : null}
                <DataTable
                  columns={modelPricingColumns}
                  data={filteredModelPricing}
                  emptyMessage="No model pricing configured yet."
                  toolbarActions={
                    <div className={styles.governanceFiltersCardContent}>
                      <Input
                        value={modelQuery}
                        onChange={(event) => setModelQuery(event.target.value)}
                        placeholder="Search by model or provider..."
                        className={styles.governanceFiltersInput}
                      />
                      <Select value={modelProviderFilter} onValueChange={setModelProviderFilter}>
                        <SelectTrigger className={styles.governanceFiltersSelect}>
                          <SelectValue placeholder="Provider" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="all">All providers</SelectItem>
                          {availableModelProviders.map((provider) => (
                            <SelectItem key={provider} value={provider}>
                              {provider}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  }
                />
                <Dialog
                  open={modelDialogOpen}
                  onOpenChange={(open) => {
                    setModelDialogOpen(open);
                    if (!open) {
                      setModelDialogValue(null);
                    }
                  }}
                >
                  <DialogContent>
                    <DialogHeader>
                      <DialogTitle>{modelDialogValue && modelPricing.some((row) => row.providerType === modelDialogValue.providerType && row.modelId === modelDialogValue.modelId) ? "Edit pricing" : "Add model pricing"}</DialogTitle>
                      <DialogDescription>Configure USD pricing per 1M tokens.</DialogDescription>
                    </DialogHeader>
                    {modelDialogValue ? (
                      <form
                        className={styles.modelPricingDialogForm}
                        onSubmit={(event) => {
                          event.preventDefault();
                          const trimmedProvider = modelDialogValue.providerType.trim();
                          const trimmedModelId = modelDialogValue.modelId.trim();
                          if (!trimmedProvider || !trimmedModelId || !companyId) {
                            return;
                          }
                          const inputRate = Number(modelDialogValue.inputUsdPer1M);
                          const outputRate = Number(modelDialogValue.outputUsdPer1M);
                          if (!Number.isFinite(inputRate) || inputRate < 0 || !Number.isFinite(outputRate) || outputRate < 0) {
                            setActionError("Input and output rates must be valid non-negative numbers.");
                            return;
                          }
                          void runCrudAction(
                            async () => {
                              await apiPut("/observability/models/pricing", companyId, {
                                providerType: trimmedProvider,
                                modelId: trimmedModelId,
                                inputUsdPer1M: inputRate,
                                outputUsdPer1M: outputRate
                              });
                              const response = (await apiGet("/observability/models/pricing", companyId)) as {
                                ok: true;
                                data: ModelPricingRow[];
                              };
                              setModelPricing(response.data);
                              setModelDialogOpen(false);
                              setModelDialogValue(null);
                            },
                            "Failed to save model pricing.",
                            "models:save-pricing",
                            { refresh: false }
                          );
                        }}
                      >
                        <div className="ui-dialog-content-scrollable">
                          <FieldGroup className={styles.modelPricingDialogPrimaryGroup}>
                            <Field>
                              <FieldLabel>Provider</FieldLabel>
                              <Select
                                value={modelDialogValue.providerType.trim() ? modelDialogValue.providerType : undefined}
                                onValueChange={(value) =>
                                  setModelDialogValue((current) =>
                                    current
                                      ? {
                                          ...current,
                                          providerType: value,
                                          modelId: ""
                                        }
                                      : current
                                  )
                                }
                              >
                                <SelectTrigger id="model-pricing-provider">
                                  <SelectValue placeholder="Select provider" />
                                </SelectTrigger>
                                <SelectContent>
                                  {availableModelProviders.map((provider) => (
                                    <SelectItem key={provider} value={provider}>
                                      {provider}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            </Field>
                            <Field>
                              <FieldLabel>Model ID</FieldLabel>
                              <Select
                                value={modelDialogValue.modelId.trim() ? modelDialogValue.modelId : undefined}
                                onValueChange={(value) =>
                                  setModelDialogValue((current) =>
                                    current
                                      ? {
                                          ...current,
                                          modelId: value
                                        }
                                      : current
                                  )
                                }
                                disabled={!modelDialogValue.providerType.trim()}
                              >
                                <SelectTrigger id="model-pricing-model-id">
                                  <SelectValue placeholder="Select model" />
                                </SelectTrigger>
                                <SelectContent>
                                  {(availableModelsByProvider.get(modelDialogValue.providerType.trim()) ?? []).map((modelId) => (
                                    <SelectItem key={modelId} value={modelId}>
                                      {modelId}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            </Field>
                          </FieldGroup>
                          <FieldGroup className={styles.modelPricingDialogPricingGroup}>
                            <Field>
                              <FieldLabel htmlFor="model-pricing-input-rate">Input / 1M</FieldLabel>
                              <Input
                                id="model-pricing-input-rate"
                                type="number"
                                step="0.000001"
                                min="0"
                                value={modelDialogValue.inputUsdPer1M}
                                onChange={(event) =>
                                  setModelDialogValue((current) =>
                                    current
                                      ? {
                                          ...current,
                                          inputUsdPer1M: event.target.value
                                        }
                                      : current
                                  )
                                }
                                required
                              />
                            </Field>
                            <Field className={styles.modelPricingDialogField}>
                              <FieldLabel htmlFor="model-pricing-output-rate">Output / 1M</FieldLabel>
                              <Input
                                id="model-pricing-output-rate"
                                type="number"
                                step="0.000001"
                                min="0"
                                value={modelDialogValue.outputUsdPer1M}
                                onChange={(event) =>
                                  setModelDialogValue((current) =>
                                    current
                                      ? {
                                          ...current,
                                          outputUsdPer1M: event.target.value
                                        }
                                      : current
                                  )
                                }
                                required
                              />
                            </Field>
                          </FieldGroup>
                        </div>
                        <DialogFooter showCloseButton>
                          <Button
                            type="submit"
                            disabled={
                              !modelDialogValue.providerType.trim() ||
                              !modelDialogValue.modelId.trim() ||
                              isActionPending("models:save-pricing")
                            }
                          >
                            Save
                          </Button>
                        </DialogFooter>
                      </form>
                    ) : null}
                  </DialogContent>
                </Dialog>
              </>
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
        leftPaneScrollable={activeNav !== "Organization"}
      />
    </>
  );
}
