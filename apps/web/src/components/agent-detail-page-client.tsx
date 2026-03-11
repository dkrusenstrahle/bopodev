"use client";

import Link from "next/link";
import { useCallback, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { ExecutionOutcome } from "bopodev-contracts";
import { AppShell } from "@/components/app-shell";
import { AgentAvatar } from "@/components/agent-avatar";
import { ConfirmActionModal } from "@/components/modals/confirm-action-modal";
import { CreateAgentModal } from "@/components/modals/create-agent-modal";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { ApiError, apiDelete, apiPost } from "@/lib/api";
import { agentAvatarSeed } from "@/lib/agent-avatar";
import { parseRuntimeFromAgentColumns } from "@/lib/agent-detail-logic";
import { getStatusBadgeClassName } from "@/lib/status-presentation";
import { isSkippedRun } from "@/lib/workspace-logic";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
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

function formatRelative(value: string | null | undefined) {
  if (!value) {
    return "never";
  }
  const diffMs = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(diffMs) || diffMs < 0) {
    return "unknown";
  }
  if (diffMs < 60_000) {
    return "just now";
  }
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatRunStatusLabel(status: string) {
  return status === "started" ? "running" : status;
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

function dateKey(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function buildLastNDaysSeries<T>(days: number, rows: T[], getDateValue: (row: T) => string) {
  const now = new Date();
  const buckets = new Map<string, number>();
  for (let index = days - 1; index >= 0; index -= 1) {
    const day = new Date(now);
    day.setHours(0, 0, 0, 0);
    day.setDate(day.getDate() - index);
    buckets.set(dateKey(day), 0);
  }
  for (const row of rows) {
    const value = getDateValue(row);
    const key = dateKey(new Date(value));
    if (buckets.has(key)) {
      buckets.set(key, (buckets.get(key) ?? 0) + 1);
    }
  }
  return Array.from(buckets.entries()).map(([label, value]) => ({ label, value }));
}

function BarMetricChart({
  data,
  label,
  colorToken,
  valueDomain
}: {
  data: Array<{ label: string; value: number }>;
  label: string;
  colorToken: string;
  valueDomain?: [number, number];
}) {
  const config = {
    value: {
      label,
      color: colorToken
    }
  } satisfies ChartConfig;
  const gradientId = `agent-metric-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;

  return (
    <ChartContainer config={config} className={styles.chartContainer}>
      <BarChart accessibilityLayer data={data} margin={{ top: 8, right: -8, left: -8, bottom: 0 }}>
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="var(--color-value)" stopOpacity={0.95} />
            <stop offset="95%" stopColor="var(--color-value)" stopOpacity={0.65} />
          </linearGradient>
        </defs>
        <CartesianGrid vertical={false} strokeDasharray="4 4" strokeOpacity={0.3} />
        <XAxis
          dataKey="label"
          tickLine={false}
          axisLine={false}
          tickMargin={10}
          minTickGap={20}
          tickFormatter={(value) => {
            const text = String(value);
            if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
              return text.slice(5);
            }
            return text.replaceAll("_", " ").slice(0, 10);
          }}
        />
        <YAxis hide domain={valueDomain} />
        <ChartTooltip content={<ChartTooltipContent indicator="line" />} cursor={false} />
        <Bar dataKey="value" fill={`url(#${gradientId})`} radius={[8, 8, 0, 0]} maxBarSize={34} />
      </BarChart>
    </ChartContainer>
  );
}

function ConfigRow({ label, value }: { label: string; value: string }) {
  return (
    <div className={styles.configRowContainer1}>
      <div className={styles.configRowContainer2}>{label}</div>
      <div className={styles.configRowContainer3}>{value}</div>
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
  const [pendingActionKeys, setPendingActionKeys] = useState<Record<string, boolean>>({});
  const managerNameById = useMemo(() => new Map(agents.map((entry) => [entry.id, entry.name])), [agents]);

  const agentIssues = useMemo(
    () =>
      issues
        .filter((issue) => issue.assigneeAgentId === agent.id)
        .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()),
    [agent.id, issues]
  );

  const agentRuns = useMemo(
    () =>
      heartbeatRuns
        .filter((run) => run.agentId === agent.id)
        .filter((run) => !isSkippedRun(run))
        .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()),
    [agent.id, heartbeatRuns]
  );

  const latestRun = agentRuns[0] ?? null;
  const recentRuns = agentRuns.slice(0, 6);

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

  const state = useMemo(() => {
    const parsed = parseStateBlob(agent.stateBlob);
    return {
      ...parsed,
      runtime: parseRuntimeFromAgentColumns(agent) ?? parsed.runtime
    };
  }, [agent]);
  const managerName = agent.managerAgentId ? managerNameById.get(agent.managerAgentId) ?? shortId(agent.managerAgentId) : "Unassigned";
  const runActivityBars = useMemo(() => buildLastNDaysSeries(14, agentRuns, (run) => run.startedAt), [agentRuns]);
  const successRateBars = useMemo(() => {
    const now = new Date();
    const keys: string[] = [];
    for (let index = 13; index >= 0; index -= 1) {
      const day = new Date(now);
      day.setHours(0, 0, 0, 0);
      day.setDate(day.getDate() - index);
      keys.push(dateKey(day));
    }
    const byDay = new Map<string, { total: number; success: number }>();
    for (const key of keys) {
      byDay.set(key, { total: 0, success: 0 });
    }
    for (const run of agentRuns) {
      const key = dateKey(new Date(run.startedAt));
      if (!byDay.has(key)) {
        continue;
      }
      const current = byDay.get(key)!;
      current.total += 1;
      if (run.status === "completed") {
        current.success += 1;
      }
    }
    return keys.map((key) => {
      const entry = byDay.get(key)!;
      return { label: key, value: entry.total > 0 ? Math.round((entry.success / entry.total) * 100) : 0 };
    });
  }, [agentRuns]);

  const issuesByPriority = useMemo(() => {
    const priorityOrder = ["critical", "high", "medium", "low"];
    const counts = new Map<string, number>();
    for (const issue of agentIssues) {
      const key = issue.priority.toLowerCase();
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return priorityOrder.map((key) => ({ label: key, value: counts.get(key) ?? 0 }));
  }, [agentIssues]);

  const issuesByStatus = useMemo(() => {
    const statusOrder = ["todo", "in_progress", "in_review", "blocked", "done"];
    const counts = new Map<string, number>();
    for (const issue of agentIssues) {
      counts.set(issue.status, (counts.get(issue.status) ?? 0) + 1);
    }
    return statusOrder.map((key) => ({ label: key, value: counts.get(key) ?? 0 }));
  }, [agentIssues]);

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

  async function removeAgent() {
    await runAgentAction(async () => {
      await apiDelete(`/agents/${agent.id}`, companyId);
      router.push(`/agents?companyId=${companyId}` as Parameters<typeof router.push>[0]);
    }, "Failed to delete agent.", `agent:${agent.id}:delete`);
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
          {agent.status === "paused" ? (
            <ConfirmActionModal
              triggerLabel="Resume"
              triggerVariant="primary"
              title="Resume agent?"
              description={`Resume "${agent.name}" so heartbeats can run again.`}
              confirmLabel="Resume"
              onConfirm={resumeAgent}
              triggerDisabled={isActionPending(`agent:${agent.id}:resume`)}
            />
          ) : (
            <ConfirmActionModal
              triggerLabel="Pause"
              triggerVariant="ghost"
              title="Pause agent?"
              description={`Pause "${agent.name}" and block new heartbeat runs.`}
              confirmLabel="Pause"
              onConfirm={pauseAgent}
              triggerDisabled={isActionPending(`agent:${agent.id}:pause`)}
            />
          )}
          {agent.status !== "terminated" ? (
            <ConfirmActionModal
              triggerLabel="Terminate"
              triggerVariant="ghost"
              title="Terminate agent?"
              description={`Terminate "${agent.name}". This blocks all future runs.`}
              confirmLabel="Terminate"
              onConfirm={terminateAgent}
              triggerDisabled={isActionPending(`agent:${agent.id}:terminate`)}
            />
          ) : null}
          <CreateAgentModal
            companyId={companyId}
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
            triggerVariant="ghost"
            title="Delete agent?"
            description={`Delete "${agent.name}".`}
            confirmLabel="Delete"
            onConfirm={removeAgent}
            triggerDisabled={isActionPending(`agent:${agent.id}:delete`)}
          />
        </div>
      </div>
      {invokeDisabledReason ? (
        <Alert>
          <AlertDescription>{invokeDisabledReason}</AlertDescription>
        </Alert>
      ) : null}

      <div className={styles.chartGridContainer}>
        <Card>
          <CardHeader>
            <CardTitle>Run Activity</CardTitle>
            <CardDescription>Last 14 days</CardDescription>
          </CardHeader>
          <CardContent className={styles.chartCardContent}>
            <BarMetricChart data={runActivityBars} label="Runs" colorToken="var(--chart-1)" />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Issues by Priority</CardTitle>
            <CardDescription>Assigned backlog</CardDescription>
          </CardHeader>
          <CardContent className={styles.chartCardContent}>
            <BarMetricChart data={issuesByPriority} label="Issues" colorToken="var(--chart-4)" />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Issues by Status</CardTitle>
            <CardDescription>Execution state</CardDescription>
          </CardHeader>
          <CardContent className={styles.chartCardContent}>
            <BarMetricChart data={issuesByStatus} label="Issues" colorToken="var(--chart-2)" />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Success Rate</CardTitle>
            <CardDescription>Daily completion percentage</CardDescription>
          </CardHeader>
          <CardContent className={styles.chartCardContent}>
            <BarMetricChart data={successRateBars} label="Success %" colorToken="var(--chart-5)" valueDomain={[0, 100]} />
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Recent Issues</CardTitle>
          <CardDescription>Most recently updated issues assigned to this agent.</CardDescription>
        </CardHeader>
        <CardContent className={styles.issueListCardContent}>
          {agentIssues.length === 0 ? (
            <div className={styles.mutedTextContainer}>No assigned issues yet.</div>
          ) : (
            agentIssues.slice(0, 6).map((issue) => (
              <div key={issue.id} className={styles.issueRowContainer1}>
                <div className={styles.issueRowContainer2}>
                  <Link href={`/issues/${issue.id}?companyId=${companyId}`} className={styles.agentHeaderLink}>
                    {issue.title}
                  </Link>
                  <div className={styles.issueRowContainer3}>{formatDateTime(issue.updatedAt)}</div>
                </div>
                <div className={styles.issueRowContainer4}>
                  <Badge variant="outline">{issue.priority}</Badge>
                  <Badge variant="outline" className={getStatusBadgeClassName(issue.status)}>
                    {issue.status}
                  </Badge>
                </div>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Recent Runs</CardTitle>
          <CardDescription>Most recent heartbeat runs for this agent.</CardDescription>
        </CardHeader>
        <CardContent className={styles.issueListCardContent}>
          {recentRuns.length === 0 ? (
            <div className={styles.mutedTextContainer}>No runs have executed yet.</div>
          ) : (
            recentRuns.map((run) => (
              <div key={run.id} className={styles.issueRowContainer1}>
                <div className={styles.issueRowContainer2}>
                  <Link
                    href={{
                      pathname: `/runs/${run.id}`,
                      query: { companyId, agentId: agent.id }
                    }}
                    className={styles.agentHeaderLink}
                  >
                    {shortId(run.id)}
                  </Link>
                  <div className={styles.issueRowContainer3}>{formatRelative(run.startedAt)}</div>
                </div>
                <div className={styles.issueRowContainer4}>
                  <Badge variant="outline" className={getStatusBadgeClassName(run.status)}>
                    {formatRunStatusLabel(run.status)}
                  </Badge>
                  {run.outcome?.kind ? <Badge variant="outline">{run.outcome.kind}</Badge> : null}
                </div>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      <div className={styles.costSectionContainer}>
        <div className={styles.costSectionHeadingContainer}>
          <h3 className={styles.costSectionTitle}>Costs</h3>
          <p className={styles.costSectionDescription}>Aggregated usage for this agent.</p>
        </div>
        <div className={styles.costGridCardContent}>
          <MetricCard label="Input tokens" value={costSummary.input.toLocaleString()} />
          <MetricCard label="Output tokens" value={costSummary.output.toLocaleString()} />
          <MetricCard label="Cost entries" value={agentCosts.length.toLocaleString()} />
          <MetricCard label="Total cost" value={costSummary.usd.toFixed(2)} />
        </div>
      </div>

      <div className={styles.configGridContainer}>
        <Card>
          <CardHeader>
            <CardTitle>Configuration</CardTitle>
            <CardDescription>Runtime and ownership details.</CardDescription>
          </CardHeader>
          <CardContent className={styles.configCardContent}>
            <ConfigRow label="Agent ID" value={agent.id} />
            <ConfigRow label="Adapter" value={agent.providerType} />
            <ConfigRow label="Status" value={agent.status} />
            <ConfigRow label="Heartbeat" value={agent.heartbeatCron ?? "Not configured"} />
            <ConfigRow label="Last heartbeat" value={formatDateTime(latestRun?.startedAt)} />
            <ConfigRow label="Reports to" value={managerName} />
            <ConfigRow label="Monthly budget" value={typeof agent.monthlyBudgetUsd === "number" ? `$${agent.monthlyBudgetUsd}` : "Not set"} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Prompt Template</CardTitle>
            <CardDescription>Current runtime context persisted in state.</CardDescription>
          </CardHeader>
          <CardContent className={styles.promptCardContent}>
            <div className={styles.promptPre}>
              {state.promptTemplate ?? "No explicit prompt template found in state."}
            </div>
          </CardContent>
        </Card>
      </div>
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
      <AppShell leftPane={leftPane} rightPane={null} activeNav="Agents" companies={companies} activeCompanyId={companyId} />
    </>
  );
}
