"use client";

import { useCallback, useMemo, useState } from "react";
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
import { ApiError, apiDelete, apiPost, apiPut } from "@/lib/api";
import { agentAvatarSeed } from "@/lib/agent-avatar";
import { cn } from "@/lib/utils";
import { getStatusBadgeClassName } from "@/lib/status-presentation";
import { isNoAssignedWorkRun, isStoppedRun, resolveWindowStart, summarizeCosts } from "@/lib/workspace-logic";
import type { SectionLabel } from "@/lib/sections";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { DataTable } from "@/components/ui/data-table";
import { DataTableColumnHeader } from "@/components/ui/data-table-column-header";
import { Input } from "@/components/ui/input";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import styles from "./workspace-client.module.scss";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select";

const AgentRuntimeDefaultsCard = dynamic(
  () => import("@/components/agent-runtime-defaults-card").then((module) => module.AgentRuntimeDefaultsCard),
  {
    loading: () => <div>Loading runtime defaults...</div>
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
  workspaceLocalPath: string | null;
  workspaceGithubRepo: string | null;
}

interface CompanyRow {
  id: string;
  name: string;
  mission: string | null;
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
  projects
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
  const [agentsQuery, setAgentsQuery] = useState("");
  const [inboxQuery, setInboxQuery] = useState("");
  const [inboxStateFilter, setInboxStateFilter] = useState<"all" | "pending" | "resolved">("all");
  const [inboxSeenFilter, setInboxSeenFilter] = useState<"all" | "seen" | "unseen">("all");
  const [inboxDismissedFilter, setInboxDismissedFilter] = useState<"all" | "active" | "dismissed">("all");
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
  const includeCostAggregations = isCostsNav || isDashboardNav;

  const isActionPending = useCallback(
    (actionKey: string) => pendingActionKeys[actionKey] === true,
    [pendingActionKeys]
  );

  async function runCrudAction(action: () => Promise<void>, fallbackMessage: string, actionKey?: string) {
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
      router.refresh();
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
    const total = filteredInboxItems.length;
    const pending = filteredInboxItems.filter((item) => item.isPending).length;
    const resolved = total - pending;
    const dismissed = filteredInboxItems.filter((item) => item.dismissedAt).length;
    const unseen = filteredInboxItems.filter((item) => !item.seenAt).length;
    return { total, pending, resolved, dismissed, unseen };
  }, [filteredInboxItems]);
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
    const total = filteredHeartbeatRuns.length;
    const completed = filteredHeartbeatRuns.filter((run) => run.status === "completed").length;
    const failed = filteredHeartbeatRuns.filter((run) => run.status === "failed").length;
    const running = filteredHeartbeatRuns.filter((run) => !run.finishedAt).length;
    const durations = filteredHeartbeatRuns
      .filter((run) => run.finishedAt)
      .map((run) => new Date(run.finishedAt!).getTime() - new Date(run.startedAt).getTime())
      .filter((value) => Number.isFinite(value) && value >= 0);
    const avgMs = durations.length > 0 ? durations.reduce((sum, value) => sum + value, 0) / durations.length : 0;
    const avgDuration = avgMs < 1000 ? `${Math.round(avgMs)}ms` : `${(avgMs / 1000).toFixed(1)}s`;
    const successRate = total > 0 ? (completed / total) * 100 : 0;
    return { total, completed, failed, running, avgDuration, successRate };
  }, [filteredHeartbeatRuns]);
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
    const total = filteredAuditEvents.length;
    const entitySet = new Set(filteredAuditEvents.map((event) => `${event.entityType}:${event.entityId}`));
    const eventTypeCounts = new Map<string, number>();
    let anomalies = 0;
    for (const event of filteredAuditEvents) {
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
  }, [filteredAuditEvents]);
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
    const total = filteredApprovals.length;
    const pending = filteredApprovals.filter((approval) => approval.status === "pending").length;
    const approved = filteredApprovals.filter((approval) => approval.status === "approved").length;
    const rejected = filteredApprovals.filter((approval) => approval.status === "rejected").length;
    const overridden = filteredApprovals.filter((approval) => approval.status === "overridden").length;
    const resolved = filteredApprovals.filter((approval) => approval.status !== "pending");
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
  }, [filteredApprovals]);
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
        (project.workspaceLocalPath ?? "").toLowerCase().includes(normalizedQuery) ||
        (project.workspaceGithubRepo ?? "").toLowerCase().includes(normalizedQuery)
      );
    });
  }, [isProjectsNav, projectIssueSummaryById, projects, projectsActivityFilter, projectsQuery]);
  const suggestedAgentRuntimeCwd = useMemo(() => {
    const uniqueWorkspacePaths = Array.from(
      new Set(
        projects
          .map((project) => project.workspaceLocalPath?.trim() ?? "")
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
  }, [agents, agentsProviderFilter, agentsQuery, agentsStatusFilter, isAgentsNav]);
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
    const byDay = new Map<string, { completed: number; failed: number }>();
    for (let i = 13; i >= 0; i -= 1) {
      const day = new Date(now);
      day.setHours(0, 0, 0, 0);
      day.setDate(day.getDate() - i);
      const key = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
      byDay.set(key, { completed: 0, failed: 0 });
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
      }
    }
    return Array.from(byDay.entries()).map(([date, values]) => ({
      label: date.slice(5),
      completed: values.completed,
      failed: values.failed
    }));
  }, [heartbeatRuns, isDashboardNav]);
  const dashboardCostTrendData = useMemo(
    () => monthlyCostChartData.map((entry) => ({ label: entry.label, usd: entry.usd })),
    [monthlyCostChartData]
  );
  const staleIssueCount = useMemo(() => {
    if (!isDashboardNav) {
      return 0;
    }
    const now = Date.now();
    return issues.filter((issue) => {
      if (issue.status === "done" || issue.status === "canceled") {
        return false;
      }
      const updatedAgeMs = now - new Date(issue.updatedAt).getTime();
      return updatedAgeMs > 7 * 24 * 60 * 60 * 1000;
    }).length;
  }, [issues, isDashboardNav]);
  const oldestPendingApprovalAge = useMemo(() => {
    if (!isDashboardNav) {
      return "none";
    }
    const pending = approvals.filter((approval) => approval.status === "pending");
    if (pending.length === 0) {
      return "none";
    }
    const oldest = Math.min(...pending.map((approval) => new Date(approval.createdAt).getTime()));
    const ageHours = (Date.now() - oldest) / (1000 * 60 * 60);
    if (ageHours < 1) {
      return `${Math.max(Math.round(ageHours * 60), 1)}m`;
    }
    if (ageHours < 24) {
      return `${ageHours.toFixed(1)}h`;
    }
    return `${(ageHours / 24).toFixed(1)}d`;
  }, [approvals, isDashboardNav]);
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
  const dashboardIssueConfig = {
    total: { label: "Issues", color: "var(--chart-1)" }
  } satisfies ChartConfig;
  const dashboardRunsConfig = {
    completed: { label: "Completed", color: "var(--chart-1)" },
    failed: { label: "Failed", color: "var(--chart-5)" }
  } satisfies ChartConfig;
  const dashboardCostConfig = {
    usd: { label: "USD", color: "var(--chart-2)" }
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
        accessorKey: "providerType",
        header: ({ column }) => <DataTableColumnHeader column={column} title="Provider" />,
        cell: ({ row }) => <Badge variant="outline">{row.original.providerType}</Badge>
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
                suggestedRuntimeCwd={suggestedAgentRuntimeCwd}
                fallbackDefaults={onboardingRuntimeFallback}
                agent={{
                  id: agent.id,
                  name: agent.name,
                  role: agent.role,
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
    [companyId, isActionPending]
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
        cell: ({ row }) => <div className={styles.formatDurationContainer5}>${row.original.usdCost.toFixed(2)}</div>
      },
      {
        id: "scope",
        header: "Scope",
        cell: ({ row }) => (
          <div className={styles.formatDurationContainer5}>
            {row.original.agentId ? `agent:${shortId(row.original.agentId)}` : "agent:unscoped"}
            {row.original.issueId ? ` · issue:${shortId(row.original.issueId)}` : ""}
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
              suggestedRuntimeCwd={suggestedAgentRuntimeCwd}
              fallbackDefaults={onboardingRuntimeFallback}
            />
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
              description="Dashboard of the company's current status."
            />
            <div className="ui-stats">
              <MetricCard label="Open Issues" value={issues.filter((issue) => issue.status !== "done" && issue.status !== "canceled").length} />
              <MetricCard label="Active Agents" value={agents.filter((agent) => agent.status !== "terminated").length} />
              <MetricCard label="Pending Approvals" value={approvals.filter((approval) => approval.status === "pending").length} />
              <MetricCard label="Recent Heartbeats" value={heartbeatRuns.length} />
            </div>
            <div className={styles.dashboardChartsGrid}>
              <Card>
                <CardHeader>
                  <CardTitle>Issue status mix</CardTitle>
                  <CardDescription>Current distribution across all tracked statuses.</CardDescription>
                </CardHeader>
                <CardContent>
                  <ChartContainer config={dashboardIssueConfig} className={styles.dashboardChartContainer}>
                    <BarChart accessibilityLayer data={dashboardIssueStatusData} margin={{ top: 8, left: -8, right: -8 }}>
                      <CartesianGrid vertical={false} strokeDasharray="4 4" strokeOpacity={0.35} />
                      <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={10} minTickGap={20} />
                      <YAxis hide />
                      <ChartTooltip content={<ChartTooltipContent indicator="line" />} cursor={false} />
                      <Bar dataKey="total" fill="var(--color-total)" radius={[8, 8, 0, 0]} maxBarSize={34} />
                    </BarChart>
                  </ChartContainer>
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle>Run outcomes</CardTitle>
                  <CardDescription>Completed vs failed runs over the last 14 days.</CardDescription>
                </CardHeader>
                <CardContent>
                  <ChartContainer config={dashboardRunsConfig} className={styles.dashboardChartContainer}>
                    <AreaChart accessibilityLayer data={dashboardRunsDailyData} margin={{ top: 8, left: -8, right: -8 }}>
                      <defs>
                        <linearGradient id="dashboardRunsCompleted" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="10%" stopColor="var(--color-completed)" stopOpacity={0.45} />
                          <stop offset="90%" stopColor="var(--color-completed)" stopOpacity={0.06} />
                        </linearGradient>
                        <linearGradient id="dashboardRunsFailed" x1="0" y1="0" x2="0" y2="1">
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
                        fill="url(#dashboardRunsCompleted)"
                        strokeOpacity={1}
                        strokeWidth={2}
                      />
                      <Area
                        type="monotone"
                        dataKey="failed"
                        stroke="var(--color-failed)"
                        fill="url(#dashboardRunsFailed)"
                        strokeOpacity={1}
                        strokeWidth={2}
                      />
                    </AreaChart>
                  </ChartContainer>
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle>Cost trend</CardTitle>
                  <CardDescription>Monthly spend (last 6 months).</CardDescription>
                </CardHeader>
                <CardContent>
                  <ChartContainer config={dashboardCostConfig} className={styles.dashboardChartContainer}>
                    <AreaChart accessibilityLayer data={dashboardCostTrendData} margin={{ top: 8, left: -8, right: -8 }}>
                      <defs>
                        <linearGradient id="dashboardCostUsd" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="8%" stopColor="var(--color-usd)" stopOpacity={0.5} />
                          <stop offset="90%" stopColor="var(--color-usd)" stopOpacity={0.05} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid vertical={false} strokeDasharray="4 4" strokeOpacity={0.35} />
                      <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={10} minTickGap={20} />
                      <YAxis hide />
                      <ChartTooltip content={<ChartTooltipContent indicator="line" />} cursor={false} />
                      <Area type="monotone" dataKey="usd" stroke="var(--color-usd)" fill="url(#dashboardCostUsd)" fillOpacity={1} strokeWidth={2.2} />
                    </AreaChart>
                  </ChartContainer>
                </CardContent>
              </Card>
            </div>
            <div className={styles.dashboardInsightsGrid}>
              <Card>
                <CardHeader>
                  <CardTitle>Execution risks</CardTitle>
                </CardHeader>
                <CardContent className={styles.dashboardInsightsCardContent}>
                  <div>Stale open issues (&gt;7d): {staleIssueCount}</div>
                  <div>Oldest pending approval: {oldestPendingApprovalAge}</div>
                  <div>Top cost center: {topCostAgent}</div>
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle>Backlog signal</CardTitle>
                </CardHeader>
                <CardContent className={styles.dashboardInsightsCardContent}>
                  <div>In review: {issues.filter((issue) => issue.status === "in_review").length}</div>
                  <div>Blocked: {issues.filter((issue) => issue.status === "blocked").length}</div>
                  <div>Unassigned: {issues.filter((issue) => !issue.assigneeAgentId).length}</div>
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
              actions={<CreateGoalModal companyId={companyId} />}
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
                  suggestedRuntimeCwd={suggestedAgentRuntimeCwd}
                  fallbackDefaults={onboardingRuntimeFallback}
                />
              }
            />
            {agents.length === 0 ? (
              <EmptyState>Hire your first agent to populate the org chart and issue assignees.</EmptyState>
            ) : (
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
                  </div>
                }
              />
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
                    hint={`$${todayCostSummary.usd.toFixed(2)} spent`}
                  />
                  <MetricCard
                    label={`${selectedMonthLabel} · Total Tokens`}
                    value={(selectedMonthSummary.input + selectedMonthSummary.output).toLocaleString()}
                    hint={`${filteredCostEntries.length} entries`}
                  />
                  <MetricCard
                    label={`${selectedMonthLabel} · USD`}
                    value={`$${selectedMonthSummary.usd.toFixed(2)}`}
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
            <AgentRuntimeDefaultsCard fallbackDefaults={onboardingRuntimeFallback} />
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
      />
    </>
  );
}
