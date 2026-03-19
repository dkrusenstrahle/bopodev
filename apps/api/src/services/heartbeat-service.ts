import { mkdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { resolveAdapter } from "bopodev-agent-sdk";
import type { AgentState, HeartbeatContext } from "bopodev-agent-sdk";
import {
  type AgentFinalRunOutput,
  ControlPlaneHeadersJsonSchema,
  ControlPlaneRequestHeadersSchema,
  ControlPlaneRuntimeEnvSchema,
  ExecutionOutcomeSchema,
  type ExecutionOutcome,
  type RunArtifact,
  type RunCompletionReason,
  type RunCompletionReport,
  type RunCostSummary
} from "bopodev-contracts";
import type { BopoDb } from "bopodev-db";
import {
  addIssueComment,
  approvalRequests,
  agents,
  appendActivity,
  appendHeartbeatRunMessages,
  companies,
  createApprovalRequest,
  goals,
  heartbeatRuns,
  issueComments,
  issueAttachments,
  issues,
  projects
} from "bopodev-db";
import { appendAuditEvent, appendCost } from "bopodev-db";
import { parseRuntimeConfigFromAgentRow } from "../lib/agent-config";
import { bootstrapRepositoryWorkspace, ensureIsolatedGitWorktree, GitRuntimeError } from "../lib/git-runtime";
import {
  isInsidePath,
  normalizeCompanyWorkspacePath,
  resolveCompanyWorkspaceRootPath,
  resolveProjectWorkspacePath
} from "../lib/instance-paths";
import { assertRuntimeCwdForCompany, getProjectWorkspaceContextMap, hasText, resolveAgentFallbackWorkspace } from "../lib/workspace-policy";
import type { RealtimeHub } from "../realtime/hub";
import { createHeartbeatRunsRealtimeEvent } from "../realtime/heartbeat-runs";
import { publishAttentionSnapshot } from "../realtime/attention";
import { publishOfficeOccupantForAgent } from "../realtime/office-space";
import { appendProjectBudgetUsage, checkAgentBudget, checkProjectBudget } from "./budget-service";
import { appendDurableFact, loadAgentMemoryContext, persistHeartbeatMemory } from "./memory-file-service";
import { calculateModelPricedUsdCost } from "./model-pricing";
import { runPluginHook } from "./plugin-runtime";

type HeartbeatRunTrigger = "manual" | "scheduler";
type HeartbeatRunMode = "default" | "resume" | "redo";
type HeartbeatProviderType =
  | "claude_code"
  | "codex"
  | "cursor"
  | "opencode"
  | "gemini_cli"
  | "openai_api"
  | "anthropic_api"
  | "http"
  | "shell";

type ActiveHeartbeatRun = {
  companyId: string;
  agentId: string;
  abortController: AbortController;
  cancelReason?: string | null;
  cancelRequestedAt?: string | null;
  cancelRequestedBy?: string | null;
};

const activeHeartbeatRuns = new Map<string, ActiveHeartbeatRun>();
type HeartbeatWakeContext = {
  reason?: string | null;
  commentId?: string | null;
  commentBody?: string | null;
  issueIds?: string[];
};

const AGENT_COMMENT_EMOJI_REGEX = /[\p{Extended_Pictographic}\uFE0F\u200D]/gu;

type RunDigestSignal = {
  sequence: number;
  kind: "system" | "assistant" | "thinking" | "tool_call" | "tool_result" | "result" | "stderr";
  label: string | null;
  text: string | null;
  payload: string | null;
  signalLevel: "high" | "medium" | "low" | "noise";
  groupKey: string | null;
  source: "stdout" | "stderr" | "trace_fallback";
};

type RunDigest = {
  status: "completed" | "failed" | "skipped";
  headline: string;
  summary: string;
  successes: string[];
  failures: string[];
  blockers: string[];
  nextAction: string;
  evidence: {
    transcriptSignalCount: number;
    outcomeActionCount: number;
    outcomeBlockerCount: number;
    failureType: string | null;
  };
};

type RunTerminalPresentation = {
  internalStatus: "completed" | "failed" | "skipped";
  publicStatus: "completed" | "failed";
  completionReason: RunCompletionReason;
};

export async function claimIssuesForAgent(
  db: BopoDb,
  companyId: string,
  agentId: string,
  heartbeatRunId: string,
  maxItems = 5
) {
  const result = await db.execute(sql`
    WITH candidate AS (
      SELECT id
      FROM issues
      WHERE company_id = ${companyId}
        AND assignee_agent_id = ${agentId}
        AND status IN ('todo', 'in_progress')
        AND is_claimed = false
      ORDER BY
        CASE priority
          WHEN 'urgent' THEN 0
          WHEN 'high' THEN 1
          WHEN 'medium' THEN 2
          WHEN 'low' THEN 3
          ELSE 4
        END ASC,
        updated_at ASC
      LIMIT ${maxItems}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE issues i
    SET is_claimed = true,
        claimed_by_heartbeat_run_id = ${heartbeatRunId},
        updated_at = CURRENT_TIMESTAMP
    FROM candidate c
    WHERE i.id = c.id
    RETURNING i.id, i.project_id, i.parent_issue_id, i.title, i.body, i.status, i.priority, i.labels_json, i.tags_json;
  `);

  return (result.rows ?? []) as Array<{
    id: string;
    project_id: string;
    parent_issue_id: string | null;
    title: string;
    body: string | null;
    status: string;
    priority: string;
    labels_json: string;
    tags_json: string;
  }>;
}

export async function releaseClaimedIssues(db: BopoDb, companyId: string, issueIds: string[]) {
  if (issueIds.length === 0) {
    return;
  }
  await db
    .update(issues)
    .set({ isClaimed: false, claimedByHeartbeatRunId: null, updatedAt: new Date() })
    .where(and(eq(issues.companyId, companyId), inArray(issues.id, issueIds)));
}

export async function stopHeartbeatRun(
  db: BopoDb,
  companyId: string,
  runId: string,
  options?: { requestId?: string; actorId?: string; trigger?: HeartbeatRunTrigger; realtimeHub?: RealtimeHub }
) {
  const runTrigger = options?.trigger ?? "manual";
  const [run] = await db
    .select({
      id: heartbeatRuns.id,
      status: heartbeatRuns.status,
      agentId: heartbeatRuns.agentId
    })
    .from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.id, runId)))
    .limit(1);
  if (!run) {
    return { ok: false as const, reason: "not_found" as const };
  }
  if (run.status !== "started") {
    return { ok: false as const, reason: "invalid_status" as const, status: run.status };
  }
  const active = activeHeartbeatRuns.get(runId);
  const cancelReason = "cancelled by stop request";
  const cancelRequestedAt = new Date().toISOString();
  if (active) {
    active.cancelReason = cancelReason;
    active.cancelRequestedAt = cancelRequestedAt;
    active.cancelRequestedBy = options?.actorId ?? null;
    active.abortController.abort(cancelReason);
  } else {
    const finishedAt = new Date();
    await db
      .update(heartbeatRuns)
      .set({
        status: "failed",
        finishedAt,
        message: "Heartbeat cancelled by stop request."
      })
      .where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.id, runId)));
    publishHeartbeatRunStatus(options?.realtimeHub, {
      companyId,
      runId,
      status: "failed",
      message: "Heartbeat cancelled by stop request.",
      finishedAt
    });
  }
  await appendAuditEvent(db, {
    companyId,
    actorType: "system",
    eventType: "heartbeat.cancel_requested",
    entityType: "heartbeat_run",
    entityId: runId,
    correlationId: options?.requestId ?? runId,
    payload: {
      agentId: run.agentId,
      trigger: runTrigger,
      requestId: options?.requestId ?? null,
      actorId: options?.actorId ?? null,
      inMemoryAbortRegistered: Boolean(active)
    }
  });
  if (!active) {
    await appendAuditEvent(db, {
      companyId,
      actorType: "system",
      eventType: "heartbeat.cancelled",
      entityType: "heartbeat_run",
      entityId: runId,
      correlationId: options?.requestId ?? runId,
      payload: {
        agentId: run.agentId,
        reason: cancelReason,
        trigger: runTrigger,
        requestId: options?.requestId ?? null,
        actorId: options?.actorId ?? null
      }
    });
  }
  return { ok: true as const, runId, agentId: run.agentId, status: run.status };
}

export async function findPendingProjectBudgetOverrideBlocksForAgent(
  db: BopoDb,
  companyId: string,
  agentId: string
) {
  const assignedRows = await db
    .select({ projectId: issues.projectId })
    .from(issues)
    .where(
      and(
        eq(issues.companyId, companyId),
        eq(issues.assigneeAgentId, agentId),
        inArray(issues.status, ["todo", "in_progress"])
      )
    );
  const assignedProjectIds = new Set(assignedRows.map((row) => row.projectId));
  if (assignedProjectIds.size === 0) {
    return [] as string[];
  }
  const pendingOverrides = await db
    .select({ payloadJson: approvalRequests.payloadJson })
    .from(approvalRequests)
    .where(
      and(
        eq(approvalRequests.companyId, companyId),
        eq(approvalRequests.action, "override_budget"),
        eq(approvalRequests.status, "pending")
      )
    );
  const blockedProjectIds = new Set<string>();
  for (const approval of pendingOverrides) {
    try {
      const payload = JSON.parse(approval.payloadJson) as Record<string, unknown>;
      const projectId = typeof payload.projectId === "string" ? payload.projectId.trim() : "";
      if (projectId && assignedProjectIds.has(projectId)) {
        blockedProjectIds.add(projectId);
      }
    } catch {
      // Ignore malformed payloads to keep enforcement resilient.
    }
  }
  return Array.from(blockedProjectIds);
}

export async function runHeartbeatForAgent(
  db: BopoDb,
  companyId: string,
  agentId: string,
  options?: {
    requestId?: string;
    trigger?: HeartbeatRunTrigger;
    realtimeHub?: RealtimeHub;
    mode?: HeartbeatRunMode;
    sourceRunId?: string;
    wakeContext?: HeartbeatWakeContext;
  }
) {
  const runMode = options?.mode ?? "default";
  const runTrigger = options?.trigger ?? "manual";
  const [agent] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.companyId, companyId), eq(agents.id, agentId)))
    .limit(1);

  if (!agent || agent.status === "paused" || agent.status === "terminated") {
    return null;
  }

  const persistedRuntime = parseRuntimeConfigFromAgentRow(agent as unknown as Record<string, unknown>);
  const startedRuns = await db
    .select({ id: heartbeatRuns.id, startedAt: heartbeatRuns.startedAt })
    .from(heartbeatRuns)
    .where(
      and(
        eq(heartbeatRuns.companyId, companyId),
        eq(heartbeatRuns.agentId, agentId),
        eq(heartbeatRuns.status, "started")
      )
    );
  const staleRunThresholdMs = resolveStaleRunThresholdMs();
  const effectiveStaleRunThresholdMs = resolveEffectiveStaleRunThresholdMs({
    baseThresholdMs: staleRunThresholdMs,
    runtimeTimeoutSec: persistedRuntime.runtimeTimeoutSec,
    interruptGraceSec: persistedRuntime.interruptGraceSec
  });
  const nowTs = Date.now();
  const staleRuns = startedRuns.filter((run) => {
    const startedAt = run.startedAt.getTime();
    return nowTs - startedAt >= effectiveStaleRunThresholdMs;
  });

  if (staleRuns.length > 0) {
    await recoverStaleHeartbeatRuns(db, companyId, agentId, staleRuns, {
      requestId: options?.requestId,
      trigger: runTrigger,
      staleRunThresholdMs: effectiveStaleRunThresholdMs
    });
  }

  const budgetCheck = await checkAgentBudget(db, companyId, agentId);
  const runId = nanoid(14);
  let blockedProjectBudgetChecks: Array<{ projectId: string; utilizationPct: number; monthlyBudgetUsd: number; usedBudgetUsd: number }> =
    [];
  if (budgetCheck.allowed) {
    const projectIds = await loadProjectIdsForRunBudgetCheck(db, companyId, agentId, options?.wakeContext);
    const projectChecks = await Promise.all(projectIds.map((projectId) => checkProjectBudget(db, companyId, projectId)));
    blockedProjectBudgetChecks = projectChecks
      .filter((entry) => entry.hardStopped)
      .map((entry) => ({
        projectId: entry.projectId,
        utilizationPct: entry.utilizationPct,
        monthlyBudgetUsd: entry.monthlyBudgetUsd,
        usedBudgetUsd: entry.usedBudgetUsd
      }));
  }
  if (blockedProjectBudgetChecks.length > 0) {
    const blockedProjectIds = blockedProjectBudgetChecks.map((entry) => entry.projectId);
    const message = `Heartbeat skipped due to project budget hard-stop: ${blockedProjectIds.join(",")}.`;
    const runDigest = buildRunDigest({
      status: "skipped",
      executionSummary: message,
      outcome: null,
      trace: null,
      signals: []
    });
    const runReport = buildRunCompletionReport({
      companyId,
      agentName: agent.name,
      providerType: agent.providerType as HeartbeatProviderType,
      issueIds: [],
      executionSummary: message,
      outcome: null,
      trace: null,
      digest: runDigest,
      terminal: resolveRunTerminalPresentation({
        internalStatus: "skipped",
        executionSummary: message,
        outcome: null,
        trace: null
      }),
      cost: buildRunCostSummary({
        tokenInput: 0,
        tokenOutput: 0,
        usdCost: null,
        usdCostStatus: "unknown",
        pricingSource: null,
        source: "none"
      })
    });
    const runListMessage = buildRunListMessageFromReport(runReport);
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "skipped",
      finishedAt: new Date(),
      message: runListMessage
    });
    publishHeartbeatRunStatus(options?.realtimeHub, {
      companyId,
      runId,
      status: "skipped",
      message: runListMessage,
      finishedAt: new Date()
    });
    await appendAuditEvent(db, {
      companyId,
      actorType: "system",
      eventType: "heartbeat.failed",
      entityType: "heartbeat_run",
      entityId: runId,
      correlationId: options?.requestId ?? runId,
      payload: {
        agentId,
        issueIds: [],
        result: runReport.resultSummary,
        message: runListMessage,
        errorType: runReport.completionReason,
        errorMessage: message,
        report: runReport,
        outcome: null,
        usage: {
          tokenInput: 0,
          tokenOutput: 0,
          usdCostStatus: "unknown",
          source: "none"
        },
        trace: null,
        diagnostics: {
          requestId: options?.requestId,
          trigger: runTrigger
        }
      }
    });
    for (const blockedProject of blockedProjectBudgetChecks) {
      const approvalId = await ensureProjectBudgetOverrideApprovalRequest(db, {
        companyId,
        projectId: blockedProject.projectId,
        utilizationPct: blockedProject.utilizationPct,
        monthlyBudgetUsd: blockedProject.monthlyBudgetUsd,
        usedBudgetUsd: blockedProject.usedBudgetUsd,
        runId
      });
      if (approvalId && options?.realtimeHub) {
        await publishAttentionSnapshot(db, options.realtimeHub, companyId);
      }
      await appendAuditEvent(db, {
        companyId,
        actorType: "system",
        eventType: "project_budget.hard_stop",
        entityType: "project",
        entityId: blockedProject.projectId,
        payload: {
          utilizationPct: blockedProject.utilizationPct,
          monthlyBudgetUsd: blockedProject.monthlyBudgetUsd,
          usedBudgetUsd: blockedProject.usedBudgetUsd,
          runId
        }
      });
    }
    await publishOfficeOccupantForAgent(db, options?.realtimeHub, companyId, agentId);
    return runId;
  }
  if (budgetCheck.allowed) {
    const claimed = await insertStartedRunAtomic(db, {
      id: runId,
      companyId,
      agentId,
      message: "Heartbeat started."
    });
    if (!claimed) {
      const skippedRunId = nanoid(14);
      const skippedAt = new Date();
      const overlapMessage = "Heartbeat skipped: another run is already in progress for this agent.";
      const runDigest = buildRunDigest({
        status: "skipped",
        executionSummary: overlapMessage,
        outcome: null,
        trace: null,
        signals: []
      });
      const runReport = buildRunCompletionReport({
        companyId,
        agentName: agent.name,
        providerType: agent.providerType as HeartbeatProviderType,
        issueIds: [],
        executionSummary: overlapMessage,
        outcome: null,
        trace: null,
        digest: runDigest,
        terminal: resolveRunTerminalPresentation({
          internalStatus: "skipped",
          executionSummary: overlapMessage,
          outcome: null,
          trace: null
        }),
        cost: buildRunCostSummary({
          tokenInput: 0,
          tokenOutput: 0,
          usdCost: null,
          usdCostStatus: "unknown",
          pricingSource: null,
          source: "none"
        })
      });
      const runListMessage = buildRunListMessageFromReport(runReport);
      await db.insert(heartbeatRuns).values({
        id: skippedRunId,
        companyId,
        agentId,
        status: "skipped",
        finishedAt: skippedAt,
        message: runListMessage
      });
      publishHeartbeatRunStatus(options?.realtimeHub, {
        companyId,
        runId: skippedRunId,
        status: "skipped",
        message: runListMessage,
        finishedAt: skippedAt
      });
      await appendAuditEvent(db, {
        companyId,
        actorType: "system",
        eventType: "heartbeat.failed",
        entityType: "heartbeat_run",
        entityId: skippedRunId,
        correlationId: options?.requestId ?? skippedRunId,
        payload: {
          agentId,
          issueIds: [],
          result: runReport.resultSummary,
          message: runListMessage,
          errorType: runReport.completionReason,
          errorMessage: overlapMessage,
          report: runReport,
          outcome: null,
          usage: {
            tokenInput: 0,
            tokenOutput: 0,
            usdCostStatus: "unknown",
            source: "none"
          },
          trace: null,
          diagnostics: { requestId: options?.requestId, trigger: runTrigger }
        }
      });
      return skippedRunId;
    }
  } else {
    const budgetMessage = "Heartbeat skipped due to budget hard-stop.";
    const runDigest = buildRunDigest({
      status: "skipped",
      executionSummary: budgetMessage,
      outcome: null,
      trace: null,
      signals: []
    });
    const runReport = buildRunCompletionReport({
      companyId,
      agentName: agent.name,
      providerType: agent.providerType as HeartbeatProviderType,
      issueIds: [],
      executionSummary: budgetMessage,
      outcome: null,
      trace: null,
      digest: runDigest,
      terminal: resolveRunTerminalPresentation({
        internalStatus: "skipped",
        executionSummary: budgetMessage,
        outcome: null,
        trace: null
      }),
      cost: buildRunCostSummary({
        tokenInput: 0,
        tokenOutput: 0,
        usdCost: null,
        usdCostStatus: "unknown",
        pricingSource: null,
        source: "none"
      })
    });
    const runListMessage = buildRunListMessageFromReport(runReport);
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "skipped",
      finishedAt: new Date(),
      message: runListMessage
    });
    publishHeartbeatRunStatus(options?.realtimeHub, {
      companyId,
      runId,
      status: "skipped",
      message: runListMessage,
      finishedAt: new Date()
    });
    await appendAuditEvent(db, {
      companyId,
      actorType: "system",
      eventType: "heartbeat.failed",
      entityType: "heartbeat_run",
      entityId: runId,
      correlationId: options?.requestId ?? runId,
      payload: {
        agentId,
        issueIds: [],
        result: runReport.resultSummary,
        message: runListMessage,
        errorType: runReport.completionReason,
        errorMessage: budgetMessage,
        report: runReport,
        outcome: null,
        usage: {
          tokenInput: 0,
          tokenOutput: 0,
          usdCostStatus: "unknown",
          source: "none"
        },
        trace: null,
        diagnostics: { requestId: options?.requestId, trigger: runTrigger }
      }
    });
  }

  if (budgetCheck.allowed) {
    await appendAuditEvent(db, {
      companyId,
      actorType: "system",
      eventType: "heartbeat.started",
      entityType: "heartbeat_run",
      entityId: runId,
      correlationId: options?.requestId ?? runId,
      payload: {
        agentId,
        requestId: options?.requestId ?? null,
        trigger: runTrigger,
        mode: runMode,
        sourceRunId: options?.sourceRunId ?? null,
        wakeContext: options?.wakeContext ?? null
      }
    });
    publishHeartbeatRunStatus(options?.realtimeHub, {
      companyId,
      runId,
      status: "started",
      message: "Heartbeat started."
    });
  }

  if (!budgetCheck.allowed) {
    const approvalId = await ensureBudgetOverrideApprovalRequest(db, {
      companyId,
      agentId,
      utilizationPct: budgetCheck.utilizationPct,
      usedBudgetUsd: Number(agent.usedBudgetUsd),
      monthlyBudgetUsd: Number(agent.monthlyBudgetUsd),
      runId
    });
    if (approvalId && options?.realtimeHub) {
      await publishAttentionSnapshot(db, options.realtimeHub, companyId);
    }
    await appendAuditEvent(db, {
      companyId,
      actorType: "system",
      eventType: "budget.hard_stop",
      entityType: "agent",
      entityId: agentId,
      payload: { utilizationPct: budgetCheck.utilizationPct }
    });
    await publishOfficeOccupantForAgent(db, options?.realtimeHub, companyId, agentId);
    return runId;
  }

  if (budgetCheck.utilizationPct >= 80) {
    await appendAuditEvent(db, {
      companyId,
      actorType: "system",
      eventType: "budget.soft_warning",
      entityType: "agent",
      entityId: agentId,
      payload: { utilizationPct: budgetCheck.utilizationPct }
    });
  }

  let issueIds: string[] = [];
  let claimedIssueIds: string[] = [];
  let executionWorkItemsForBudget: Array<{ issueId: string; projectId: string }> = [];
  let state: AgentState & {
    runtime?: {
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
      bootstrapPrompt?: string;
      runPolicy?: {
        sandboxMode?: "workspace_write" | "full_access";
        allowWebSearch?: boolean;
      };
    };
  } = {};
  let executionSummary = "";
  let executionTrace: unknown = null;
  let executionOutcome: ExecutionOutcome | null = null;
  let memoryContext: HeartbeatContext["memoryContext"] | undefined;
  let stateParseError: string | null = null;
  let runtimeLaunchSummary: ReturnType<typeof summarizeRuntimeLaunch> | null = null;
  let primaryIssueId: string | null = null;
  let primaryProjectId: string | null = null;
  let providerUsageLimitDisposition:
    | {
        message: string;
        notifyBoard: boolean;
        pauseAgent: boolean;
      }
    | null = null;
  let transcriptSequence = 0;
  let transcriptWriteQueue = Promise.resolve();
  let transcriptLiveCount = 0;
  let transcriptLiveUsefulCount = 0;
  let transcriptLiveHighSignalCount = 0;
  let transcriptPersistFailureReported = false;
  let pluginFailureSummary: string[] = [];
  const seenResultMessages = new Set<string>();
  const runDigestSignals: RunDigestSignal[] = [];

  const enqueueTranscriptEvent = (event: {
    kind: string;
    label?: string;
    text?: string;
    payload?: string;
    signalLevel?: "high" | "medium" | "low" | "noise";
    groupKey?: string;
    source?: "stdout" | "stderr" | "trace_fallback";
  }) => {
    const sequence = transcriptSequence++;
    const createdAt = new Date();
    const messageId = nanoid(14);
    const signalLevel = normalizeTranscriptSignalLevel(event.signalLevel, event.kind);
    const groupKey = event.groupKey ?? defaultTranscriptGroupKey(event.kind, event.label);
    const source = event.source ?? "stdout";
    const normalizedResultText = event.kind === "result" ? normalizeTranscriptResultText(event.text) : "";
    if (event.kind === "result" && normalizedResultText.length > 0) {
      seenResultMessages.add(normalizedResultText);
    }
    transcriptLiveCount += 1;
    if (isUsefulTranscriptSignal(signalLevel)) {
      transcriptLiveUsefulCount += 1;
    }
    if (signalLevel === "high") {
      transcriptLiveHighSignalCount += 1;
    }
    if (isUsefulTranscriptSignal(signalLevel)) {
      runDigestSignals.push({
        sequence,
        kind: normalizeTranscriptKind(event.kind),
        label: event.label ?? null,
        text: event.text ?? null,
        payload: event.payload ?? null,
        signalLevel,
        groupKey: groupKey ?? null,
        source
      });
      if (runDigestSignals.length > 200) {
        runDigestSignals.splice(0, runDigestSignals.length - 200);
      }
    }
    transcriptWriteQueue = transcriptWriteQueue
      .then(async () => {
        await appendHeartbeatRunMessages(db, {
          companyId,
          runId,
          messages: [
            {
              id: messageId,
              sequence,
              kind: event.kind,
              label: event.label ?? null,
              text: event.text ?? null,
              payloadJson: event.payload ?? null,
              signalLevel,
              groupKey,
              source,
              createdAt
            }
          ]
        });
        options?.realtimeHub?.publish(
          createHeartbeatRunsRealtimeEvent(companyId, {
            type: "run.transcript.append",
            runId,
            messages: [
              {
                id: messageId,
                runId,
                sequence,
                kind: normalizeTranscriptKind(event.kind),
                label: event.label ?? null,
                text: event.text ?? null,
                payload: event.payload ?? null,
                signalLevel,
                groupKey,
                source,
                createdAt: createdAt.toISOString()
              }
            ]
          })
        );
      })
      .catch(async (error) => {
        if (transcriptPersistFailureReported) {
          return;
        }
        transcriptPersistFailureReported = true;
        try {
          await appendAuditEvent(db, {
            companyId,
            actorType: "system",
            eventType: "heartbeat.transcript_persist_failed",
            entityType: "heartbeat_run",
            entityId: runId,
            correlationId: options?.requestId ?? runId,
            payload: {
              agentId,
              sequence,
              messageId,
              error: String(error)
            }
          });
        } catch {
          // Best effort: keep run execution resilient even when observability insert fails.
        }
      });
  };
  const emitCanonicalResultEvent = (text: string, label: "completed" | "failed") => {
    const trimmed = text.trim();
    if (!trimmed) {
      return;
    }
    const normalized = normalizeTranscriptResultText(trimmed);
    if (normalized.length > 0 && seenResultMessages.has(normalized)) {
      return;
    }
    enqueueTranscriptEvent({
      kind: "result",
      label,
      text: trimmed,
      signalLevel: "high",
      groupKey: "result",
      source: "trace_fallback"
    });
  };

  try {
    await runPluginHook(db, {
      hook: "beforeClaim",
      context: {
        companyId,
        agentId,
        runId,
        requestId: options?.requestId,
        providerType: agent.providerType
      },
      failClosed: false
    });
    const isCommentOrderWake = options?.wakeContext?.reason === "issue_comment_recipient";
    const workItems = isCommentOrderWake ? [] : await claimIssuesForAgent(db, companyId, agentId, runId);
    const wakeWorkItems = await loadWakeContextWorkItems(db, companyId, options?.wakeContext?.issueIds);
    const contextWorkItems = resolveExecutionWorkItems(workItems, wakeWorkItems, options?.wakeContext);
    executionWorkItemsForBudget = contextWorkItems.map((item) => ({ issueId: item.id, projectId: item.project_id }));
    claimedIssueIds = workItems.map((item) => item.id);
    issueIds = contextWorkItems.map((item) => item.id);
    primaryIssueId = contextWorkItems[0]?.id ?? null;
    primaryProjectId = contextWorkItems[0]?.project_id ?? null;
    const resolvedWakeContext = await resolveHeartbeatWakeContext(db, companyId, options?.wakeContext);
    await runPluginHook(db, {
      hook: "afterClaim",
      context: {
        companyId,
        agentId,
        runId,
        requestId: options?.requestId,
        providerType: agent.providerType,
        workItemCount: contextWorkItems.length
      },
      failClosed: false
    });
    await publishOfficeOccupantForAgent(db, options?.realtimeHub, companyId, agentId);
    const adapter = resolveAdapter(agent.providerType as HeartbeatProviderType);
    const parsedState = parseAgentState(agent.stateBlob);
    state = parsedState.state;
    stateParseError = parsedState.parseError;
    if (runMode === "redo") {
      state = clearResumeState(state);
    }
    const heartbeatRuntimeEnv = buildHeartbeatRuntimeEnv({
      companyId,
      agentId: agent.id,
      heartbeatRunId: runId,
      canHireAgents: agent.canHireAgents,
      wakeContext: options?.wakeContext
    });
    const runtimeFromConfig = {
      command: persistedRuntime.runtimeCommand,
      args: persistedRuntime.runtimeArgs,
      cwd: persistedRuntime.runtimeCwd,
      timeoutMs: persistedRuntime.runtimeTimeoutSec > 0 ? persistedRuntime.runtimeTimeoutSec * 1000 : undefined,
      env: {
        ...persistedRuntime.runtimeEnv,
        ...heartbeatRuntimeEnv
      },
      onTranscriptEvent: (event: {
        kind: string;
        label?: string;
        text?: string;
        payload?: string;
        signalLevel?: "high" | "medium" | "low" | "noise";
        groupKey?: string;
        source?: "stdout" | "stderr" | "trace_fallback";
      }) => {
        enqueueTranscriptEvent({
          kind: event.kind,
          label: event.label,
          text: event.text,
          payload: event.payload,
          signalLevel: event.signalLevel,
          groupKey: event.groupKey,
          source: event.source
        });
      },
      model: persistedRuntime.runtimeModel,
      thinkingEffort: persistedRuntime.runtimeThinkingEffort,
      bootstrapPrompt: persistedRuntime.bootstrapPrompt,
      interruptGraceSec: persistedRuntime.interruptGraceSec,
      runPolicy: persistedRuntime.runPolicy
    };
    const mergedRuntime = mergeRuntimeForExecution(runtimeFromConfig, state.runtime);
    const workspaceResolution = await resolveRuntimeWorkspaceForWorkItems(
      db,
      companyId,
      agent.id,
      contextWorkItems,
      mergedRuntime
    );
    state = {
      ...state,
      runtime: workspaceResolution.runtime
    };
    let context = await buildHeartbeatContext(db, companyId, {
      agentId,
      agentName: agent.name,
      agentRole: agent.role,
      managerAgentId: agent.managerAgentId,
      providerType: agent.providerType as HeartbeatProviderType,
      heartbeatRunId: runId,
      state,
      memoryContext,
      runtime: workspaceResolution.runtime,
      workItems: contextWorkItems,
      wakeContext: resolvedWakeContext
    });
    const memoryQueryText = [
      context.company.mission ?? "",
      ...(context.goalContext?.companyGoals ?? []),
      ...(context.goalContext?.projectGoals ?? []),
      ...context.workItems.map((item) => `${item.title} ${item.body ?? ""}`)
    ]
      .join(" ")
      .trim();
    memoryContext = await loadAgentMemoryContext({
      companyId,
      agentId,
      projectIds: context.workItems.map((item) => item.projectId),
      queryText: memoryQueryText
    });
    context = {
      ...context,
      memoryContext
    };
    if (workspaceResolution.warnings.length > 0) {
      await appendAuditEvent(db, {
        companyId,
        actorType: "system",
        eventType: "heartbeat.workspace_resolution_warning",
        entityType: "heartbeat_run",
        entityId: runId,
        correlationId: options?.requestId ?? runId,
        payload: {
          agentId,
          source: workspaceResolution.source,
          runtimeCwd: workspaceResolution.runtime.cwd ?? null,
          warnings: workspaceResolution.warnings
        }
      });
      for (const issueId of issueIds) {
        await appendActivity(db, {
          companyId,
          issueId,
          actorType: "system",
          eventType: "issue.workspace_fallback",
          payload: {
            heartbeatRunId: runId,
            agentId,
            source: workspaceResolution.source,
            warnings: workspaceResolution.warnings
          }
        });
      }
    }

    const controlPlaneEnvValidation = validateControlPlaneRuntimeEnv(
      workspaceResolution.runtime.env ?? {},
      runId
    );
    if (!controlPlaneEnvValidation.ok) {
      await appendAuditEvent(db, {
        companyId,
        actorType: "system",
        eventType: "heartbeat.control_plane_env_invalid",
        entityType: "heartbeat_run",
        entityId: runId,
        correlationId: options?.requestId ?? runId,
        payload: {
          agentId,
          providerType: agent.providerType,
          validationErrorCode: controlPlaneEnvValidation.validationErrorCode,
          invalidFieldPaths: controlPlaneEnvValidation.invalidFieldPaths
        }
      });
      throw new Error(
        `Control-plane runtime env is invalid. Invalid fields: ${controlPlaneEnvValidation.invalidFieldPaths.join(", ")}`
      );
    }

    if (
      resolveControlPlanePreflightEnabled() &&
      shouldRequireControlPlanePreflight(
        agent.providerType as HeartbeatProviderType,
        contextWorkItems.length
      )
    ) {
      const preflight = await runControlPlaneConnectivityPreflight({
        apiBaseUrl: resolveControlPlaneEnv(workspaceResolution.runtime.env ?? {}, "API_BASE_URL"),
        runtimeEnv: workspaceResolution.runtime.env ?? {},
        timeoutMs: resolveControlPlanePreflightTimeoutMs()
      });
      await appendAuditEvent(db, {
        companyId,
        actorType: "system",
        eventType: preflight.ok ? "heartbeat.control_plane_preflight_passed" : "heartbeat.control_plane_preflight_failed",
        entityType: "heartbeat_run",
        entityId: runId,
        correlationId: options?.requestId ?? runId,
        payload: {
          agentId,
          providerType: agent.providerType,
          ...preflight
        }
      });
      if (!preflight.ok) {
        throw new Error(`Control-plane connectivity preflight failed: ${preflight.message}`);
      }
    }

    runtimeLaunchSummary = summarizeRuntimeLaunch(
      agent.providerType as HeartbeatProviderType,
      workspaceResolution.runtime
    );
    await appendAuditEvent(db, {
      companyId,
      actorType: "system",
      eventType: "heartbeat.runtime_launch",
      entityType: "heartbeat_run",
      entityId: runId,
      correlationId: options?.requestId ?? runId,
      payload: {
        agentId,
        runtime: runtimeLaunchSummary,
        diagnostics: {
          requestId: options?.requestId ?? null,
          trigger: runTrigger,
          mode: runMode,
          sourceRunId: options?.sourceRunId ?? null
        }
      }
    });
    if (runMode === "resume" || runMode === "redo") {
      await appendAuditEvent(db, {
        companyId,
        actorType: "system",
        eventType: runMode === "resume" ? "heartbeat.resumed" : "heartbeat.redo_started",
        entityType: "heartbeat_run",
        entityId: runId,
        correlationId: options?.requestId ?? runId,
        payload: {
          agentId,
          sourceRunId: options?.sourceRunId ?? null,
          requestId: options?.requestId ?? null,
          trigger: runTrigger
        }
      });
    }

    const activeRunAbort = new AbortController();
    registerActiveHeartbeatRun(runId, {
      companyId,
      agentId,
      abortController: activeRunAbort
    });

    const beforeAdapterHook = await runPluginHook(db, {
      hook: "beforeAdapterExecute",
      context: {
        companyId,
        agentId,
        runId,
        requestId: options?.requestId,
        providerType: agent.providerType,
        workItemCount: contextWorkItems.length,
        runtime: {
          command: workspaceResolution.runtime.command,
          cwd: workspaceResolution.runtime.cwd
        }
      },
      failClosed: true
    });
    if (beforeAdapterHook.blocked) {
      pluginFailureSummary = beforeAdapterHook.failures;
      throw new Error(`Plugin policy blocked adapter execution: ${beforeAdapterHook.failures.join(" | ")}`);
    }
    if (beforeAdapterHook.promptAppend && beforeAdapterHook.promptAppend.trim().length > 0) {
      const existingPrompt = context.runtime?.bootstrapPrompt ?? "";
      const nextPrompt = existingPrompt.trim().length > 0
        ? `${existingPrompt}\n\n${beforeAdapterHook.promptAppend}`
        : beforeAdapterHook.promptAppend;
      context = {
        ...context,
        runtime: {
          ...(context.runtime ?? {}),
          bootstrapPrompt: nextPrompt
        }
      };
    }

    const execution = await executeAdapterWithWatchdog({
      execute: (abortSignal) =>
        adapter.execute({
          ...context,
          runtime: {
            ...(context.runtime ?? {}),
            abortSignal
          }
        }),
      providerType: agent.providerType as HeartbeatProviderType,
      runtime: workspaceResolution.runtime,
      externalAbortSignal: activeRunAbort.signal
    });
    const usageLimitHint = execution.dispositionHint?.kind === "provider_usage_limited" ? execution.dispositionHint : null;
    if (usageLimitHint) {
      providerUsageLimitDisposition = {
        message: usageLimitHint.message,
        notifyBoard: usageLimitHint.notifyBoard,
        pauseAgent: usageLimitHint.pauseAgent
      };
    }
    executionSummary =
      usageLimitHint?.message && usageLimitHint.message.trim().length > 0 ? usageLimitHint.message.trim() : execution.summary;
    executionSummary = sanitizeAgentSummaryCommentBody(extractNaturalRunUpdate(executionSummary));
    const persistedExecutionStatus: "ok" | "failed" | "skipped" = usageLimitHint ? "skipped" : execution.status;
    const persistedRunStatus: "completed" | "failed" | "skipped" =
      persistedExecutionStatus === "ok" ? "completed" : persistedExecutionStatus;
    const normalizedUsage = execution.usage ?? {
      inputTokens: Math.max(0, execution.tokenInput),
      cachedInputTokens: 0,
      outputTokens: Math.max(0, execution.tokenOutput),
      ...(execution.usdCost > 0 ? { costUsd: execution.usdCost } : {}),
      ...(execution.summary ? { summary: execution.summary } : {})
    };
    const effectiveTokenInput = normalizedUsage.inputTokens + normalizedUsage.cachedInputTokens;
    const effectiveTokenOutput = normalizedUsage.outputTokens;
    const effectiveRuntimeUsdCost = normalizedUsage.costUsd ?? (execution.usdCost > 0 ? execution.usdCost : 0);
    const afterAdapterHook = await runPluginHook(db, {
      hook: "afterAdapterExecute",
      context: {
        companyId,
        agentId,
        runId,
        requestId: options?.requestId,
        providerType: agent.providerType,
        status: execution.status,
        summary: execution.summary,
        trace: execution.trace ?? null,
        outcome: execution.outcome ?? null
      },
      failClosed: false
    });
    if (afterAdapterHook.failures.length > 0) {
      pluginFailureSummary = [...pluginFailureSummary, ...afterAdapterHook.failures];
    }
    executionTrace = execution.trace ?? null;
    const runtimeModelId = resolveRuntimeModelId({
      runtimeModel: persistedRuntime.runtimeModel,
      stateBlob: agent.stateBlob
    });
    const effectivePricingProviderType = execution.pricingProviderType ?? agent.providerType;
    const effectivePricingModelId = execution.pricingModelId ?? runtimeModelId;
    const costDecision = await appendFinishedRunCostEntry({
      db,
      companyId,
      runId,
      providerType: agent.providerType,
      runtimeModelId: effectivePricingModelId ?? runtimeModelId,
      pricingProviderType: effectivePricingProviderType,
      pricingModelId: effectivePricingModelId,
      tokenInput: effectiveTokenInput,
      tokenOutput: effectiveTokenOutput,
      runtimeUsdCost: effectiveRuntimeUsdCost,
      failureType: readTraceString(execution.trace, "failureType"),
      issueId: primaryIssueId,
      projectId: primaryProjectId,
      agentId,
      status: persistedExecutionStatus
    });
    const executionUsdCost = costDecision.usdCost;
    await appendProjectBudgetUsage(db, {
      companyId,
      projectCostsUsd: buildProjectBudgetCostAllocations(executionWorkItemsForBudget, executionUsdCost)
    });
    const parsedOutcome = ExecutionOutcomeSchema.safeParse(execution.outcome);
    executionOutcome = parsedOutcome.success ? parsedOutcome.data : null;
    const persistedMemory = await persistHeartbeatMemory({
      companyId,
      agentId,
      runId,
      status: persistedExecutionStatus === "ok" ? "ok" : "failed",
      summary: executionSummary,
      outcomeKind: executionOutcome?.kind ?? null,
      mission: context.company.mission ?? null,
      goalContext: {
        companyGoals: context.goalContext?.companyGoals ?? [],
        projectGoals: context.goalContext?.projectGoals ?? []
      }
    });
    await appendAuditEvent(db, {
      companyId,
      actorType: "system",
      eventType: "heartbeat.memory_updated",
      entityType: "heartbeat_run",
      entityId: runId,
      correlationId: options?.requestId ?? runId,
      payload: {
        agentId,
        memoryRoot: persistedMemory.memoryRoot,
        dailyNotePath: persistedMemory.dailyNotePath,
        candidateFacts: persistedMemory.candidateFacts
      }
    });
    if (execution.status === "ok" && !usageLimitHint) {
      for (const fact of persistedMemory.candidateFacts) {
        const targetFile = await appendDurableFact({
          companyId,
          agentId,
          fact,
          sourceRunId: runId
        });
        await appendAuditEvent(db, {
          companyId,
          actorType: "system",
          eventType: "heartbeat.memory_fact_promoted",
          entityType: "heartbeat_run",
          entityId: runId,
          correlationId: options?.requestId ?? runId,
          payload: {
            agentId,
            fact,
            targetFile
          }
        });
      }
    }
    const missionAlignment = computeMissionAlignmentSignal({
      summary: executionSummary,
      mission: context.company.mission ?? null,
      companyGoals: context.goalContext?.companyGoals ?? [],
      projectGoals: context.goalContext?.projectGoals ?? []
    });
    await appendAuditEvent(db, {
      companyId,
      actorType: "system",
      eventType: "heartbeat.memory_alignment_scored",
      entityType: "heartbeat_run",
      entityId: runId,
      correlationId: options?.requestId ?? runId,
      payload: {
        agentId,
        score: missionAlignment.score,
        matchedMissionTerms: missionAlignment.matchedMissionTerms,
        matchedGoalTerms: missionAlignment.matchedGoalTerms
      }
    });

    if (
      execution.nextState ||
      executionUsdCost > 0 ||
      effectiveTokenInput > 0 ||
      effectiveTokenOutput > 0 ||
      persistedExecutionStatus !== "skipped"
    ) {
      await db
        .update(agents)
        .set({
          stateBlob: JSON.stringify(execution.nextState ?? state),
          runtimeModel: effectivePricingModelId ?? persistedRuntime.runtimeModel ?? null,
          usedBudgetUsd: sql`${agents.usedBudgetUsd} + ${executionUsdCost}`,
          tokenUsage: sql`${agents.tokenUsage} + ${effectiveTokenInput + effectiveTokenOutput}`,
          updatedAt: new Date()
        })
        .where(and(eq(agents.companyId, companyId), eq(agents.id, agentId)));
    }

    const shouldAdvanceIssuesToReview = shouldPromoteIssuesToReview({
      summary: execution.summary,
      tokenInput: effectiveTokenInput,
      tokenOutput: effectiveTokenOutput,
      usdCost: executionUsdCost,
      trace: executionTrace,
      outcome: executionOutcome
    });

    if (issueIds.length > 0 && execution.status === "ok" && shouldAdvanceIssuesToReview) {
      await db
        .update(issues)
        .set({ status: "in_review", updatedAt: new Date() })
        .where(and(eq(issues.companyId, companyId), inArray(issues.id, issueIds)));

      for (const issueId of issueIds) {
        await appendActivity(db, {
          companyId,
          issueId,
          actorType: "system",
          eventType: "issue.sent_to_review",
          payload: { heartbeatRunId: runId, agentId }
        });
      }
    } else if (issueIds.length > 0 && execution.status === "ok") {
      for (const issueId of issueIds) {
        await appendActivity(db, {
          companyId,
          issueId,
          actorType: "system",
          eventType: "issue.review_gate_blocked",
          payload: { heartbeatRunId: runId, agentId, reason: "insufficient_real_execution_evidence" }
        });
      }
      await appendAuditEvent(db, {
        companyId,
        actorType: "system",
        eventType: "heartbeat.review_gate_blocked",
        entityType: "heartbeat_run",
        entityId: runId,
        correlationId: options?.requestId ?? runId,
        payload: {
          agentId,
          issueIds,
          reason: "insufficient_real_execution_evidence",
          summary: execution.summary,
          outcome: executionOutcome,
          usage: {
            tokenInput: effectiveTokenInput,
            tokenOutput: effectiveTokenOutput,
            usdCost: executionUsdCost
          }
        }
      });
    }

    const beforePersistHook = await runPluginHook(db, {
      hook: "beforePersist",
      context: {
        companyId,
        agentId,
        runId,
        requestId: options?.requestId,
        providerType: agent.providerType,
        status: persistedExecutionStatus,
        summary: executionSummary
      },
      failClosed: false
    });
    if (beforePersistHook.failures.length > 0) {
      pluginFailureSummary = [...pluginFailureSummary, ...beforePersistHook.failures];
    }

    const runDigest = buildRunDigest({
      status: persistedRunStatus,
      executionSummary,
      outcome: executionOutcome,
      trace: executionTrace,
      signals: runDigestSignals
    });
    const terminalPresentation = resolveRunTerminalPresentation({
      internalStatus: persistedRunStatus,
      executionSummary,
      outcome: executionOutcome,
      trace: executionTrace
    });
    const runCost = buildRunCostSummary({
      tokenInput: effectiveTokenInput,
      tokenOutput: effectiveTokenOutput,
      usdCost: costDecision.usdCostStatus === "unknown" ? null : executionUsdCost,
      usdCostStatus: costDecision.usdCostStatus,
      pricingSource: costDecision.pricingSource ?? null,
      source: readTraceString(execution.trace, "usageSource") ?? "unknown"
    });
    const runReport = buildRunCompletionReport({
      companyId,
      agentName: agent.name,
      providerType: agent.providerType as HeartbeatProviderType,
      issueIds,
      executionSummary,
      outcome: executionOutcome,
      finalRunOutput: execution.finalRunOutput ?? null,
      trace: executionTrace,
      digest: runDigest,
      terminal: terminalPresentation,
      cost: runCost,
      runtimeCwd: workspaceResolution.runtime.cwd
    });
    emitCanonicalResultEvent(runReport.resultSummary, runReport.finalStatus);
    const runListMessage = buildRunListMessageFromReport(runReport);
    await db
      .update(heartbeatRuns)
      .set({
        status: persistedRunStatus,
        finishedAt: new Date(),
        message: runListMessage
      })
      .where(eq(heartbeatRuns.id, runId));
    publishHeartbeatRunStatus(options?.realtimeHub, {
      companyId,
      runId,
      status: persistedRunStatus,
      message: runListMessage,
      finishedAt: new Date()
    });
    await appendAuditEvent(db, {
      companyId,
      actorType: "system",
      eventType: "heartbeat.run_digest",
      entityType: "heartbeat_run",
      entityId: runId,
      correlationId: options?.requestId ?? runId,
      payload: runDigest
    });
    try {
      await appendRunSummaryComments(db, {
        companyId,
        issueIds,
        agentId,
        runId,
        report: runReport
      });
    } catch (commentError) {
      await appendAuditEvent(db, {
        companyId,
        actorType: "system",
        eventType: "heartbeat.run_comment_failed",
        entityType: "heartbeat_run",
        entityId: runId,
        correlationId: options?.requestId ?? runId,
        payload: {
          agentId,
          issueIds,
          error: String(commentError)
        }
      });
    }

    const fallbackMessages = normalizeTraceTranscript(executionTrace);
    const fallbackHighSignalCount = fallbackMessages.filter((message) => message.signalLevel === "high").length;
    const shouldAppendFallback =
      !providerUsageLimitDisposition &&
      fallbackMessages.length > 0 &&
      (transcriptLiveCount === 0 ||
        transcriptLiveUsefulCount < 2 ||
        transcriptLiveHighSignalCount < 1 ||
        (transcriptLiveHighSignalCount < 2 && fallbackHighSignalCount > transcriptLiveHighSignalCount));
    if (shouldAppendFallback) {
      const createdAt = new Date();
      const dedupedFallbackMessages = fallbackMessages.filter((message) => {
        if (message.kind !== "result") {
          return true;
        }
        const normalized = normalizeTranscriptResultText(message.text);
        if (!normalized) {
          return true;
        }
        if (seenResultMessages.has(normalized)) {
          return false;
        }
        seenResultMessages.add(normalized);
        return true;
      });
      const rows: Array<{
        id: string;
        sequence: number;
        kind: "system" | "assistant" | "thinking" | "tool_call" | "tool_result" | "result" | "stderr";
        label: string | null;
        text: string | null;
        payloadJson: string | null;
        signalLevel: "high" | "medium" | "low" | "noise";
        groupKey: string | null;
        source: "trace_fallback";
        createdAt: Date;
      }> = dedupedFallbackMessages.map((message) => ({
        id: nanoid(14),
        sequence: transcriptSequence++,
        kind: message.kind,
        label: message.label ?? null,
        text: message.text ?? null,
        payloadJson: message.payload ?? null,
        signalLevel: message.signalLevel,
        groupKey: message.groupKey ?? null,
        source: "trace_fallback",
        createdAt
      }));
      for (const row of rows) {
        if (!isUsefulTranscriptSignal(row.signalLevel)) {
          continue;
        }
        runDigestSignals.push({
          sequence: row.sequence,
          kind: row.kind,
          label: row.label,
          text: row.text,
          payload: row.payloadJson,
          signalLevel: row.signalLevel,
          groupKey: row.groupKey,
          source: "trace_fallback"
        });
      }
      if (runDigestSignals.length > 200) {
        runDigestSignals.splice(0, runDigestSignals.length - 200);
      }
      await appendHeartbeatRunMessages(db, {
        companyId,
        runId,
        messages: rows
      });
      options?.realtimeHub?.publish(
        createHeartbeatRunsRealtimeEvent(companyId, {
          type: "run.transcript.append",
          runId,
          messages: rows.map((row) => ({
            id: row.id,
            runId,
            sequence: row.sequence,
            kind: normalizeTranscriptKind(row.kind),
            label: row.label,
            text: row.text,
            payload: row.payloadJson,
            signalLevel: row.signalLevel ?? undefined,
            groupKey: row.groupKey ?? undefined,
            source: row.source ?? undefined,
            createdAt: row.createdAt.toISOString()
          }))
        })
      );
    }

    const afterPersistHook = await runPluginHook(db, {
      hook: "afterPersist",
      context: {
        companyId,
        agentId,
        runId,
        requestId: options?.requestId,
        providerType: agent.providerType,
        status: persistedExecutionStatus,
        summary: executionSummary,
        trace: executionTrace,
        outcome: executionOutcome
      },
      failClosed: false
    });
    if (afterPersistHook.failures.length > 0) {
      pluginFailureSummary = [...pluginFailureSummary, ...afterPersistHook.failures];
    }

    if (providerUsageLimitDisposition) {
      await appendAuditEvent(db, {
        companyId,
        actorType: "system",
        eventType: "heartbeat.provider_usage_limited",
        entityType: "heartbeat_run",
        entityId: runId,
        correlationId: options?.requestId ?? runId,
        payload: {
          agentId,
          providerType: agent.providerType,
          issueIds,
          message: providerUsageLimitDisposition.message
        }
      });
      const pauseResult = providerUsageLimitDisposition.pauseAgent
        ? await pauseAgentForProviderUsageLimit(db, {
            companyId,
            agentId,
            requestId: options?.requestId ?? runId,
            runId,
            providerType: agent.providerType,
            message: providerUsageLimitDisposition.message
          })
        : { paused: false };
      if (providerUsageLimitDisposition.notifyBoard) {
        await appendProviderUsageLimitBoardComments(db, {
          companyId,
          issueIds,
          agentId,
          runId,
          providerType: agent.providerType,
          message: providerUsageLimitDisposition.message,
          paused: pauseResult.paused
        });
        if (options?.realtimeHub) {
          await publishAttentionSnapshot(db, options.realtimeHub, companyId);
        }
      }
      await publishOfficeOccupantForAgent(db, options?.realtimeHub, companyId, agentId);
    }

    await appendAuditEvent(db, {
      companyId,
      actorType: "system",
      eventType: "heartbeat.completed",
      entityType: "heartbeat_run",
      entityId: runId,
      correlationId: options?.requestId ?? runId,
      payload: {
        agentId,
        status: persistedRunStatus,
        result: runReport.resultSummary,
        message: runListMessage,
        report: runReport,
        outcome: executionOutcome,
        issueIds,
        usage: {
          tokenInput: effectiveTokenInput,
          tokenOutput: effectiveTokenOutput,
          usdCost: executionUsdCost,
          usdCostStatus: costDecision.usdCostStatus,
          source: readTraceString(execution.trace, "usageSource") ?? "unknown"
        },
        trace: execution.trace ?? null,
        diagnostics: {
          stateParseError,
          requestId: options?.requestId,
          trigger: runTrigger,
          pluginFailures: pluginFailureSummary
        }
      }
    });
  } catch (error) {
    const classified = classifyHeartbeatError(error);
    executionSummary =
      classified.type === "cancelled"
        ? "Heartbeat cancelled by stop request."
        : `Heartbeat failed (${classified.type}): ${classified.message}`;
    emitCanonicalResultEvent(executionSummary, "failed");
    const pluginErrorHook = await runPluginHook(db, {
      hook: "onError",
      context: {
        companyId,
        agentId,
        runId,
        requestId: options?.requestId,
        providerType: agent.providerType,
        error: String(error),
        summary: executionSummary
      },
      failClosed: false
    });
    if (pluginErrorHook.failures.length > 0) {
      pluginFailureSummary = [...pluginFailureSummary, ...pluginErrorHook.failures];
    }
    if (!executionTrace && classified.type === "cancelled") {
      executionTrace = {
        command: runtimeLaunchSummary?.command ?? null,
        args: runtimeLaunchSummary?.args ?? [],
        cwd: runtimeLaunchSummary?.cwd ?? null,
        failureType: "cancelled",
        timedOut: false,
        timeoutSource: null
      };
    } else if (!executionTrace && classified.type === "timeout") {
      executionTrace = {
        command: runtimeLaunchSummary?.command ?? null,
        args: runtimeLaunchSummary?.args ?? [],
        cwd: runtimeLaunchSummary?.cwd ?? null,
        failureType: classified.timeoutSource === "watchdog" ? "watchdog_timeout" : "runtime_timeout",
        timedOut: true,
        timeoutSource: classified.timeoutSource ?? "watchdog"
      };
    } else if (!executionTrace && runtimeLaunchSummary) {
      executionTrace = {
        command: runtimeLaunchSummary.command ?? null,
        args: runtimeLaunchSummary.args ?? [],
        cwd: runtimeLaunchSummary.cwd ?? null
      };
    }
    try {
      const failedMemory = await persistHeartbeatMemory({
        companyId,
        agentId,
        runId,
        status: "failed",
        summary: executionSummary,
        outcomeKind: executionOutcome?.kind ?? null
      });
      await appendAuditEvent(db, {
        companyId,
        actorType: "system",
        eventType: "heartbeat.memory_updated",
        entityType: "heartbeat_run",
        entityId: runId,
        correlationId: options?.requestId ?? runId,
        payload: {
          agentId,
          memoryRoot: failedMemory.memoryRoot,
          dailyNotePath: failedMemory.dailyNotePath,
          candidateFacts: failedMemory.candidateFacts,
          failurePath: true
        }
      });
    } catch {
      // best effort; do not mask primary heartbeat failure.
    }
    const runtimeModelId = resolveRuntimeModelId({
      runtimeModel: persistedRuntime.runtimeModel,
      stateBlob: agent.stateBlob
    });
    const failureCostDecision = await appendFinishedRunCostEntry({
      db,
      companyId,
      runId,
      providerType: agent.providerType,
      runtimeModelId,
      pricingProviderType: agent.providerType,
      pricingModelId: runtimeModelId,
      tokenInput: 0,
      tokenOutput: 0,
      issueId: primaryIssueId,
      projectId: primaryProjectId,
      agentId,
      status: "failed"
    });
    await appendProjectBudgetUsage(db, {
      companyId,
      projectCostsUsd: buildProjectBudgetCostAllocations(executionWorkItemsForBudget, failureCostDecision.usdCost)
    });
    const runDigest = buildRunDigest({
      status: "failed",
      executionSummary,
      outcome: executionOutcome,
      trace: executionTrace,
      signals: runDigestSignals
    });
    const runCost = buildRunCostSummary({
      tokenInput: 0,
      tokenOutput: 0,
      usdCost: failureCostDecision.usdCostStatus === "unknown" ? null : failureCostDecision.usdCost,
      usdCostStatus: failureCostDecision.usdCostStatus,
      pricingSource: failureCostDecision.pricingSource ?? null,
      source: readTraceString(executionTrace, "usageSource") ?? "unknown"
    });
    const runReport = buildRunCompletionReport({
      companyId,
      agentName: agent.name,
      providerType: agent.providerType as HeartbeatProviderType,
      issueIds,
      executionSummary,
      outcome: executionOutcome,
      finalRunOutput: null,
      trace: executionTrace,
      digest: runDigest,
      terminal: resolveRunTerminalPresentation({
        internalStatus: "failed",
        executionSummary,
        outcome: executionOutcome,
        trace: executionTrace,
        errorType: classified.type
      }),
      cost: runCost,
      runtimeCwd: runtimeLaunchSummary?.cwd ?? persistedRuntime.runtimeCwd ?? null,
      errorType: classified.type,
      errorMessage: classified.message
    });
    const runListMessage = buildRunListMessageFromReport(runReport);
    await db
      .update(heartbeatRuns)
      .set({
        status: "failed",
        finishedAt: new Date(),
        message: runListMessage
      })
      .where(eq(heartbeatRuns.id, runId));
    publishHeartbeatRunStatus(options?.realtimeHub, {
      companyId,
      runId,
      status: "failed",
      message: runListMessage,
      finishedAt: new Date()
    });
    emitCanonicalResultEvent(runReport.resultSummary, runReport.finalStatus);
    await appendAuditEvent(db, {
      companyId,
      actorType: "system",
      eventType: "heartbeat.run_digest",
      entityType: "heartbeat_run",
      entityId: runId,
      correlationId: options?.requestId ?? runId,
      payload: runDigest
    });
    try {
      await appendRunSummaryComments(db, {
        companyId,
        issueIds,
        agentId,
        runId,
        report: runReport
      });
    } catch (commentError) {
      await appendAuditEvent(db, {
        companyId,
        actorType: "system",
        eventType: "heartbeat.run_comment_failed",
        entityType: "heartbeat_run",
        entityId: runId,
        correlationId: options?.requestId ?? runId,
        payload: {
          agentId,
          issueIds,
          error: String(commentError)
        }
      });
    }
    await appendAuditEvent(db, {
      companyId,
      actorType: "system",
      eventType: "heartbeat.failed",
      entityType: "heartbeat_run",
      entityId: runId,
      correlationId: options?.requestId ?? runId,
      payload: {
        agentId,
        issueIds,
        result: runReport.resultSummary,
        message: runListMessage,
        errorType: classified.type,
        errorMessage: classified.message,
        report: runReport,
        outcome: executionOutcome,
        usage: {
          tokenInput: 0,
          tokenOutput: 0,
          usdCost: failureCostDecision.usdCost,
          usdCostStatus: failureCostDecision.usdCostStatus,
          source: readTraceString(executionTrace, "usageSource") ?? "unknown"
        },
        trace: executionTrace,
        diagnostics: {
          stateParseError,
          requestId: options?.requestId,
          trigger: runTrigger,
          pluginFailures: pluginFailureSummary
        }
      }
    });
    if (classified.type === "cancelled") {
      await appendAuditEvent(db, {
        companyId,
        actorType: "system",
        eventType: "heartbeat.cancelled",
        entityType: "heartbeat_run",
        entityId: runId,
        correlationId: options?.requestId ?? runId,
        payload: {
          agentId,
          requestId: options?.requestId ?? null,
          trigger: runTrigger,
          result: executionSummary
        }
      });
    }
  } finally {
    await transcriptWriteQueue;
    unregisterActiveHeartbeatRun(runId);
    try {
      await releaseClaimedIssues(db, companyId, claimedIssueIds);
    } catch (releaseError) {
      await appendAuditEvent(db, {
        companyId,
        actorType: "system",
        eventType: "heartbeat.release_failed",
        entityType: "heartbeat_run",
        entityId: runId,
        correlationId: options?.requestId ?? runId,
        payload: {
          agentId,
          issueIds: claimedIssueIds,
          error: String(releaseError)
        }
      });
    }
    await publishOfficeOccupantForAgent(db, options?.realtimeHub, companyId, agentId);
    try {
      const queueModule = await import("./heartbeat-queue-service");
      queueModule.triggerHeartbeatQueueWorker(db, companyId, {
        requestId: options?.requestId,
        realtimeHub: options?.realtimeHub
      });
    } catch {
      // Queue worker trigger is best-effort to keep heartbeat execution resilient.
    }
  }

  return runId;
}

async function insertStartedRunAtomic(
  db: BopoDb,
  input: { id: string; companyId: string; agentId: string; message: string }
) {
  const result = await db.execute(sql`
    INSERT INTO heartbeat_runs (id, company_id, agent_id, status, message)
    VALUES (${input.id}, ${input.companyId}, ${input.agentId}, 'started', ${input.message})
    ON CONFLICT DO NOTHING
    RETURNING id
  `);
  return (result.rows ?? []).length > 0;
}

async function recoverStaleHeartbeatRuns(
  db: BopoDb,
  companyId: string,
  agentId: string,
  staleRuns: Array<{ id: string; startedAt: Date }>,
  input: { requestId?: string; trigger: "manual" | "scheduler"; staleRunThresholdMs: number }
) {
  const staleRunIds = staleRuns.map((run) => run.id);
  if (staleRunIds.length === 0) {
    return;
  }

  await db
    .update(heartbeatRuns)
    .set({
      status: "failed",
      finishedAt: new Date(),
      message: "Heartbeat auto-failed after stale in-progress timeout."
    })
    .where(
      and(
        eq(heartbeatRuns.companyId, companyId),
        eq(heartbeatRuns.agentId, agentId),
        inArray(heartbeatRuns.id, staleRunIds),
        eq(heartbeatRuns.status, "started")
      )
    );

  const claimedIssueRows = await db
    .select({ id: issues.id })
    .from(issues)
    .where(and(eq(issues.companyId, companyId), inArray(issues.claimedByHeartbeatRunId, staleRunIds), eq(issues.isClaimed, true)));
  await releaseClaimedIssues(
    db,
    companyId,
    claimedIssueRows.map((row) => row.id)
  );

  for (const staleRun of staleRuns) {
    await appendAuditEvent(db, {
      companyId,
      actorType: "system",
      eventType: "heartbeat.stale_recovered",
      entityType: "heartbeat_run",
      entityId: staleRun.id,
      correlationId: input.requestId ?? staleRun.id,
      payload: {
        agentId,
        trigger: input.trigger,
        requestId: input.requestId ?? null,
        staleRunThresholdMs: input.staleRunThresholdMs,
        staleForMs: Date.now() - staleRun.startedAt.getTime()
      }
    });
  }
}

export async function runHeartbeatSweep(
  db: BopoDb,
  companyId: string,
  options?: { requestId?: string; realtimeHub?: RealtimeHub }
) {
  const companyAgents = await db.select().from(agents).where(eq(agents.companyId, companyId));
  const latestRunByAgent = await listLatestRunByAgent(db, companyId);

  const now = new Date();
  const enqueuedJobIds: string[] = [];
  const dueAgents: Array<{ id: string }> = [];
  let skippedNotDue = 0;
  let skippedStatus = 0;
  let skippedBudgetBlocked = 0;
  let failedStarts = 0;
  const sweepStartedAt = Date.now();
  for (const agent of companyAgents) {
    if (agent.status !== "idle" && agent.status !== "running") {
      skippedStatus += 1;
      continue;
    }
    if (!isHeartbeatDue(agent.heartbeatCron, latestRunByAgent.get(agent.id) ?? null, now)) {
      skippedNotDue += 1;
      continue;
    }
    const blockedProjectIds = await findPendingProjectBudgetOverrideBlocksForAgent(db, companyId, agent.id);
    if (blockedProjectIds.length > 0) {
      skippedBudgetBlocked += 1;
      continue;
    }
    dueAgents.push({ id: agent.id });
  }
  const sweepConcurrency = resolveHeartbeatSweepConcurrency(dueAgents.length);
  const queueModule = await import("./heartbeat-queue-service");
  await runWithConcurrency(dueAgents, sweepConcurrency, async (agent) => {
    try {
      const job = await queueModule.enqueueHeartbeatQueueJob(db, {
        companyId,
        agentId: agent.id,
        jobType: "scheduler",
        priority: 80,
        idempotencyKey: options?.requestId ? `scheduler:${agent.id}:${options.requestId}` : null,
        payload: {}
      });
      enqueuedJobIds.push(job.id);
      queueModule.triggerHeartbeatQueueWorker(db, companyId, {
        requestId: options?.requestId,
        realtimeHub: options?.realtimeHub
      });
    } catch {
      failedStarts += 1;
    }
  });
  await appendAuditEvent(db, {
    companyId,
    actorType: "system",
    eventType: "heartbeat.sweep.completed",
    entityType: "company",
    entityId: companyId,
    correlationId: options?.requestId ?? null,
    payload: {
      runIds: enqueuedJobIds,
      startedCount: enqueuedJobIds.length,
      dueCount: dueAgents.length,
      failedStarts,
      skippedStatus,
      skippedNotDue,
      skippedBudgetBlocked,
      concurrency: sweepConcurrency,
      elapsedMs: Date.now() - sweepStartedAt,
      requestId: options?.requestId ?? null
    }
  });
  return enqueuedJobIds;
}

async function listLatestRunByAgent(db: BopoDb, companyId: string) {
  const result = await db.execute(sql`
    SELECT agent_id, MAX(started_at) AS latest_started_at
    FROM heartbeat_runs
    WHERE company_id = ${companyId}
    GROUP BY agent_id
  `);
  const latestRunByAgent = new Map<string, Date>();
  for (const row of result.rows ?? []) {
    const agentId = typeof row.agent_id === "string" ? row.agent_id : null;
    if (!agentId) {
      continue;
    }
    const startedAt = coerceDate(row.latest_started_at);
    if (!startedAt) {
      continue;
    }
    latestRunByAgent.set(agentId, startedAt);
  }
  return latestRunByAgent;
}

function coerceDate(value: unknown) {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value === "string" || typeof value === "number") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

async function loadWakeContextWorkItems(db: BopoDb, companyId: string, wakeIssueIds?: string[]) {
  const normalizedIds = Array.from(new Set((wakeIssueIds ?? []).filter((id) => id.trim().length > 0)));
  if (normalizedIds.length === 0) {
    return [] as Array<{
      id: string;
      project_id: string;
      parent_issue_id: string | null;
      title: string;
      body: string | null;
      status: string;
      priority: string;
      labels_json: string;
      tags_json: string;
    }>;
  }
  const rows = await db
    .select({
      id: issues.id,
      project_id: issues.projectId,
      parent_issue_id: issues.parentIssueId,
      title: issues.title,
      body: issues.body,
      status: issues.status,
      priority: issues.priority,
      labels_json: issues.labelsJson,
      tags_json: issues.tagsJson
    })
    .from(issues)
    .where(and(eq(issues.companyId, companyId), inArray(issues.id, normalizedIds)));
  const sortOrder = new Map(normalizedIds.map((id, index) => [id, index]));
  return rows.sort((a, b) => (sortOrder.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (sortOrder.get(b.id) ?? Number.MAX_SAFE_INTEGER));
}

function mergeContextWorkItems(
  assigned: Array<{
    id: string;
    project_id: string;
    parent_issue_id: string | null;
    title: string;
    body: string | null;
    status: string;
    priority: string;
    labels_json: string;
    tags_json: string;
  }>,
  wakeContext: Array<{
    id: string;
    project_id: string;
    parent_issue_id: string | null;
    title: string;
    body: string | null;
    status: string;
    priority: string;
    labels_json: string;
    tags_json: string;
  }>
) {
  const seen = new Set<string>();
  const merged: typeof assigned = [];
  for (const item of assigned) {
    if (!seen.has(item.id)) {
      seen.add(item.id);
      merged.push(item);
    }
  }
  for (const item of wakeContext) {
    if (!seen.has(item.id)) {
      seen.add(item.id);
      merged.push(item);
    }
  }
  return merged;
}

function resolveExecutionWorkItems(
  assigned: Array<{
    id: string;
    project_id: string;
    parent_issue_id: string | null;
    title: string;
    body: string | null;
    status: string;
    priority: string;
    labels_json: string;
    tags_json: string;
  }>,
  wakeContextItems: Array<{
    id: string;
    project_id: string;
    parent_issue_id: string | null;
    title: string;
    body: string | null;
    status: string;
    priority: string;
    labels_json: string;
    tags_json: string;
  }>,
  wakeContext?: HeartbeatWakeContext
) {
  if (wakeContext?.reason === "issue_comment_recipient" && wakeContextItems.length > 0) {
    return wakeContextItems;
  }
  return mergeContextWorkItems(assigned, wakeContextItems);
}

async function resolveHeartbeatWakeContext(
  db: BopoDb,
  companyId: string,
  wakeContext?: HeartbeatWakeContext
): Promise<HeartbeatWakeContext | undefined> {
  if (!wakeContext) {
    return undefined;
  }
  const commentBody = wakeContext.commentId
    ? await loadWakeContextCommentBody(db, companyId, wakeContext.commentId)
    : null;
  return {
    reason: wakeContext.reason ?? null,
    commentId: wakeContext.commentId ?? null,
    commentBody,
    issueIds: wakeContext.issueIds ?? []
  };
}

async function loadWakeContextCommentBody(db: BopoDb, companyId: string, commentId: string) {
  const [comment] = await db
    .select({ body: issueComments.body })
    .from(issueComments)
    .where(and(eq(issueComments.companyId, companyId), eq(issueComments.id, commentId)))
    .limit(1);
  const body = comment?.body?.trim();
  return body && body.length > 0 ? body : null;
}

async function buildHeartbeatContext(
  db: BopoDb,
  companyId: string,
  input: {
    agentId: string;
    agentName: string;
    agentRole: string;
    managerAgentId: string | null;
    providerType: HeartbeatProviderType;
    heartbeatRunId: string;
    state: AgentState;
    memoryContext?: HeartbeatContext["memoryContext"];
    runtime?: { command?: string; args?: string[]; cwd?: string; timeoutMs?: number };
    wakeContext?: HeartbeatWakeContext;
    workItems: Array<{
      id: string;
      project_id: string;
      parent_issue_id: string | null;
      title: string;
      body: string | null;
      status: string;
      priority: string;
      labels_json: string;
      tags_json: string;
    }>;
  }
): Promise<HeartbeatContext> {
  const [company] = await db
    .select({ name: companies.name, mission: companies.mission })
    .from(companies)
    .where(eq(companies.id, companyId))
    .limit(1);
  const projectIds = Array.from(new Set(input.workItems.map((item) => item.project_id)));
  const projectRows =
    projectIds.length > 0
      ? await db
          .select({ id: projects.id, name: projects.name })
          .from(projects)
          .where(and(eq(projects.companyId, companyId), inArray(projects.id, projectIds)))
      : [];
  const projectNameById = new Map(projectRows.map((row) => [row.id, row.name]));
  const projectWorkspaceContextMap = await getProjectWorkspaceContextMap(db, companyId, projectIds);
  const projectWorkspaceMap = new Map(
    Array.from(projectWorkspaceContextMap.entries()).map(([projectId, context]) => [projectId, context.cwd])
  );
  const issueIds = input.workItems.map((item) => item.id);
  const childIssueRows =
    issueIds.length > 0
      ? await db
          .select({
            id: issues.id,
            parentIssueId: issues.parentIssueId
          })
          .from(issues)
          .where(and(eq(issues.companyId, companyId), inArray(issues.parentIssueId, issueIds)))
      : [];
  const childIssueIdsByParent = new Map<string, string[]>();
  for (const row of childIssueRows) {
    if (!row.parentIssueId) {
      continue;
    }
    const existing = childIssueIdsByParent.get(row.parentIssueId) ?? [];
    existing.push(row.id);
    childIssueIdsByParent.set(row.parentIssueId, existing);
  }
  const attachmentRows =
    issueIds.length > 0
      ? await db
          .select({
            id: issueAttachments.id,
            issueId: issueAttachments.issueId,
            projectId: issueAttachments.projectId,
            fileName: issueAttachments.fileName,
            mimeType: issueAttachments.mimeType,
            fileSizeBytes: issueAttachments.fileSizeBytes,
            relativePath: issueAttachments.relativePath
          })
          .from(issueAttachments)
          .where(and(eq(issueAttachments.companyId, companyId), inArray(issueAttachments.issueId, issueIds)))
      : [];
  const attachmentsByIssue = new Map<
    string,
    Array<{
      id: string;
      fileName: string;
      mimeType: string | null;
      fileSizeBytes: number;
      relativePath: string;
      absolutePath: string;
    }>
  >();
  for (const row of attachmentRows) {
    const projectWorkspace = projectWorkspaceMap.get(row.projectId) ?? resolveProjectWorkspacePath(companyId, row.projectId);
    const absolutePath = resolve(projectWorkspace, row.relativePath);
    if (!isInsidePath(projectWorkspace, absolutePath)) {
      continue;
    }
    const existing = attachmentsByIssue.get(row.issueId) ?? [];
    existing.push({
      id: row.id,
      fileName: row.fileName,
      mimeType: row.mimeType,
      fileSizeBytes: row.fileSizeBytes,
      relativePath: row.relativePath,
      absolutePath
    });
    attachmentsByIssue.set(row.issueId, existing);
  }
  const goalRows = await db
    .select({
      id: goals.id,
      level: goals.level,
      title: goals.title,
      status: goals.status,
      projectId: goals.projectId
    })
    .from(goals)
    .where(eq(goals.companyId, companyId));

  const activeCompanyGoals = goalRows
    .filter((goal) => goal.status === "active" && goal.level === "company")
    .map((goal) => goal.title);
  const activeProjectGoals = goalRows
    .filter(
      (goal) =>
        goal.status === "active" && goal.level === "project" && goal.projectId && projectIds.includes(goal.projectId)
    )
    .map((goal) => goal.title);
  const activeAgentGoals = goalRows
    .filter((goal) => goal.status === "active" && goal.level === "agent")
    .map((goal) => goal.title);
  const isCommentOrderWake = input.wakeContext?.reason === "issue_comment_recipient";

  return {
    companyId,
    agentId: input.agentId,
    providerType: input.providerType,
    heartbeatRunId: input.heartbeatRunId,
    company: {
      name: company?.name ?? "Unknown company",
      mission: company?.mission ?? null
    },
    agent: {
      name: input.agentName,
      role: input.agentRole,
      managerAgentId: input.managerAgentId
    },
    state: input.state,
    memoryContext: input.memoryContext,
    runtime: input.runtime,
    wakeContext: input.wakeContext
      ? {
          reason: input.wakeContext.reason ?? null,
          commentId: input.wakeContext.commentId ?? null,
          commentBody: input.wakeContext.commentBody ?? null,
          issueIds: input.wakeContext.issueIds ?? []
        }
      : undefined,
    goalContext: {
      companyGoals: activeCompanyGoals,
      projectGoals: activeProjectGoals,
      agentGoals: activeAgentGoals
    },
    workItems: input.workItems.map((item) => ({
      issueId: item.id,
      projectId: item.project_id,
      parentIssueId: item.parent_issue_id,
      childIssueIds: childIssueIdsByParent.get(item.id) ?? [],
      projectName: projectNameById.get(item.project_id) ?? null,
      title: item.title,
      // Comment-order runs should treat linked issues as context-only, not as a full issue execution order.
      body: isCommentOrderWake ? null : item.body,
      status: item.status,
      priority: item.priority,
      labels: parseStringArray(item.labels_json),
      tags: parseStringArray(item.tags_json),
      attachments: isCommentOrderWake ? [] : (attachmentsByIssue.get(item.id) ?? [])
    }))
  };
}

function parseStringArray(value: string | null) {
  if (!value) {
    return [];
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.map((entry) => String(entry)) : [];
  } catch {
    return [];
  }
}

function computeMissionAlignmentSignal(input: {
  summary: string;
  mission: string | null;
  companyGoals: string[];
  projectGoals: string[];
}) {
  const summaryTokens = new Set(tokenizeAlignmentText(input.summary));
  const missionTokens = tokenizeAlignmentText(input.mission ?? "");
  const goalTokens = tokenizeAlignmentText([...input.companyGoals, ...input.projectGoals].join(" "));
  const matchedMissionTerms = missionTokens.filter((token) => summaryTokens.has(token));
  const matchedGoalTerms = goalTokens.filter((token) => summaryTokens.has(token));
  const missionScore = missionTokens.length > 0 ? matchedMissionTerms.length / missionTokens.length : 0;
  const goalScore = goalTokens.length > 0 ? matchedGoalTerms.length / goalTokens.length : 0;
  const score = Number(Math.min(1, missionScore * 0.55 + goalScore * 0.45).toFixed(3));
  return {
    score,
    matchedMissionTerms,
    matchedGoalTerms
  };
}

function tokenizeAlignmentText(value: string) {
  return Array.from(
    new Set(
      value
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .map((entry) => entry.trim())
        .filter((entry) => entry.length >= 3)
    )
  );
}

async function loadProjectIdsForRunBudgetCheck(
  db: BopoDb,
  companyId: string,
  agentId: string,
  wakeContext?: HeartbeatWakeContext
) {
  const projectIds = new Set<string>();
  const isCommentOrderWake = wakeContext?.reason === "issue_comment_recipient";
  if (!isCommentOrderWake) {
    const assignedRows = await db
      .select({ projectId: issues.projectId })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          eq(issues.assigneeAgentId, agentId),
          inArray(issues.status, ["todo", "in_progress"]),
          eq(issues.isClaimed, false)
        )
      );
    for (const row of assignedRows) {
      projectIds.add(row.projectId);
    }
  }
  const wakeIssueIds = Array.from(new Set((wakeContext?.issueIds ?? []).map((entry) => entry.trim()).filter(Boolean)));
  if (wakeIssueIds.length > 0) {
    const wakeRows = await db
      .select({ projectId: issues.projectId })
      .from(issues)
      .where(and(eq(issues.companyId, companyId), inArray(issues.id, wakeIssueIds)));
    for (const row of wakeRows) {
      projectIds.add(row.projectId);
    }
  }
  return Array.from(projectIds);
}

function buildProjectBudgetCostAllocations(
  workItems: Array<{ issueId: string; projectId: string }>,
  usdCost: number
): Array<{ projectId: string; usdCost: number }> {
  const effectiveCost = Math.max(0, usdCost);
  if (effectiveCost <= 0 || workItems.length === 0) {
    return [];
  }
  const issueCountByProject = new Map<string, number>();
  for (const item of workItems) {
    issueCountByProject.set(item.projectId, (issueCountByProject.get(item.projectId) ?? 0) + 1);
  }
  const totalIssues = Array.from(issueCountByProject.values()).reduce((sum, count) => sum + count, 0);
  if (totalIssues <= 0) {
    return [];
  }
  const projectIds = Array.from(issueCountByProject.keys());
  let allocated = 0;
  const allocations = projectIds.map((projectId, index) => {
    if (index === projectIds.length - 1) {
      return {
        projectId,
        usdCost: Number((effectiveCost - allocated).toFixed(6))
      };
    }
    const count = issueCountByProject.get(projectId) ?? 0;
    const share = Number(((effectiveCost * count) / totalIssues).toFixed(6));
    allocated += share;
    return {
      projectId,
      usdCost: share
    };
  });
  return allocations.filter((entry) => entry.usdCost > 0);
}

async function ensureBudgetOverrideApprovalRequest(
  db: BopoDb,
  input: {
    companyId: string;
    agentId: string;
    utilizationPct: number;
    usedBudgetUsd: number;
    monthlyBudgetUsd: number;
    runId: string;
  }
): Promise<string | null> {
  const pendingOverrides = await db
    .select({ id: approvalRequests.id, payloadJson: approvalRequests.payloadJson })
    .from(approvalRequests)
    .where(
      and(
        eq(approvalRequests.companyId, input.companyId),
        eq(approvalRequests.action, "override_budget"),
        eq(approvalRequests.status, "pending")
      )
    );
  const alreadyPending = pendingOverrides.some((approval) => {
    try {
      const payload = JSON.parse(approval.payloadJson) as Record<string, unknown>;
      return payload.agentId === input.agentId;
    } catch {
      return false;
    }
  });
  if (alreadyPending) {
    return null;
  }
  const recommendedAdditionalBudgetUsd = Math.max(1, Math.ceil(Math.max(input.monthlyBudgetUsd * 0.25, 1)));
  const approvalId = await createApprovalRequest(db, {
    companyId: input.companyId,
    action: "override_budget",
    payload: {
      agentId: input.agentId,
      reason: "Agent reached budget hard-stop and needs additional funds.",
      currentMonthlyBudgetUsd: input.monthlyBudgetUsd,
      usedBudgetUsd: input.usedBudgetUsd,
      utilizationPct: input.utilizationPct,
      additionalBudgetUsd: recommendedAdditionalBudgetUsd,
      revisedMonthlyBudgetUsd: Number((input.monthlyBudgetUsd + recommendedAdditionalBudgetUsd).toFixed(4)),
      triggerRunId: input.runId
    }
  });
  await appendAuditEvent(db, {
    companyId: input.companyId,
    actorType: "system",
    eventType: "budget.override_requested",
    entityType: "approval",
    entityId: approvalId,
    correlationId: input.runId,
    payload: {
      agentId: input.agentId,
      runId: input.runId,
      currentMonthlyBudgetUsd: input.monthlyBudgetUsd,
      usedBudgetUsd: input.usedBudgetUsd,
      utilizationPct: input.utilizationPct,
      additionalBudgetUsd: recommendedAdditionalBudgetUsd
    }
  });
  return approvalId;
}

async function ensureProjectBudgetOverrideApprovalRequest(
  db: BopoDb,
  input: {
    companyId: string;
    projectId: string;
    utilizationPct: number;
    usedBudgetUsd: number;
    monthlyBudgetUsd: number;
    runId: string;
  }
): Promise<string | null> {
  const pendingOverrides = await db
    .select({ id: approvalRequests.id, payloadJson: approvalRequests.payloadJson })
    .from(approvalRequests)
    .where(
      and(
        eq(approvalRequests.companyId, input.companyId),
        eq(approvalRequests.action, "override_budget"),
        eq(approvalRequests.status, "pending")
      )
    );
  const alreadyPending = pendingOverrides.some((approval) => {
    try {
      const payload = JSON.parse(approval.payloadJson) as Record<string, unknown>;
      return payload.projectId === input.projectId;
    } catch {
      return false;
    }
  });
  if (alreadyPending) {
    return null;
  }
  const recommendedAdditionalBudgetUsd = Math.max(1, Math.ceil(Math.max(input.monthlyBudgetUsd * 0.25, 1)));
  const approvalId = await createApprovalRequest(db, {
    companyId: input.companyId,
    action: "override_budget",
    payload: {
      projectId: input.projectId,
      reason: "Project reached budget hard-stop and needs additional funds.",
      currentMonthlyBudgetUsd: input.monthlyBudgetUsd,
      usedBudgetUsd: input.usedBudgetUsd,
      utilizationPct: input.utilizationPct,
      additionalBudgetUsd: recommendedAdditionalBudgetUsd,
      revisedMonthlyBudgetUsd: Number((input.monthlyBudgetUsd + recommendedAdditionalBudgetUsd).toFixed(4)),
      triggerRunId: input.runId
    }
  });
  await appendAuditEvent(db, {
    companyId: input.companyId,
    actorType: "system",
    eventType: "project_budget.override_requested",
    entityType: "approval",
    entityId: approvalId,
    correlationId: input.runId,
    payload: {
      projectId: input.projectId,
      runId: input.runId,
      currentMonthlyBudgetUsd: input.monthlyBudgetUsd,
      usedBudgetUsd: input.usedBudgetUsd,
      utilizationPct: input.utilizationPct,
      additionalBudgetUsd: recommendedAdditionalBudgetUsd
    }
  });
  return approvalId;
}

function sanitizeAgentSummaryCommentBody(body: string) {
  const sanitized = body.replace(AGENT_COMMENT_EMOJI_REGEX, "").trim();
  return sanitized.length > 0 ? sanitized : "Run update.";
}

function extractNaturalRunUpdate(executionSummary: string) {
  const normalized = executionSummary.trim();
  const jsonSummary = extractSummaryFromJsonLikeText(normalized);
  const source = jsonSummary ?? normalized;
  const lines = source
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => !line.startsWith("{") && !line.startsWith("}"));
  const compact = (lines.length > 0 ? lines.slice(0, 2).join(" ") : source)
    .replace(/^run (failure )?summary\s*:\s*/i, "")
    .replace(/^completed all assigned issue steps\s*:\s*/i, "")
    .replace(/^issue status\s*:\s*/i, "")
    .replace(/`+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const bounded = compact.length > 260 ? `${compact.slice(0, 257).trimEnd()}...` : compact;
  if (!bounded) {
    return "Run update.";
  }
  return /[.!?]$/.test(bounded) ? bounded : `${bounded}.`;
}

function buildRunDigest(input: {
  status: "completed" | "failed" | "skipped";
  executionSummary: string;
  outcome: ExecutionOutcome | null;
  trace: unknown;
  signals: RunDigestSignal[];
}): RunDigest {
  const summary = sanitizeAgentSummaryCommentBody(extractNaturalRunUpdate(input.executionSummary));
  const successes: string[] = [];
  const failures: string[] = [];
  const blockers: string[] = [];
  if (input.outcome) {
    for (const action of input.outcome.actions) {
      const detail = summarizeRunDigestPoint(action.detail);
      if (!detail) {
        continue;
      }
      if (action.status === "ok") {
        successes.push(detail);
      } else if (action.status === "error") {
        failures.push(detail);
      }
    }
    for (const blocker of input.outcome.blockers) {
      const detail = summarizeRunDigestPoint(blocker.message);
      if (detail) {
        blockers.push(detail);
      }
    }
  }
  for (const signal of input.signals) {
    if (signal.signalLevel !== "high" && signal.signalLevel !== "medium") {
      continue;
    }
    const signalText = summarizeRunDigestPoint(signal.text ?? signal.payload ?? "");
    if (!signalText) {
      continue;
    }
    if (signal.kind === "tool_result" || signal.kind === "stderr") {
      if (looksLikeRunFailureSignal(signalText)) {
        failures.push(signalText);
      } else if (signal.kind === "tool_result") {
        successes.push(signalText);
      }
      continue;
    }
    if (signal.kind === "result" && !looksLikeRunFailureSignal(signalText)) {
      successes.push(signalText);
    }
  }
  if (input.status === "completed" && successes.length === 0) {
    successes.push(summary);
  }
  if (input.status === "failed" && failures.length === 0) {
    failures.push(summary);
  }
  if (input.status === "failed" && blockers.length === 0) {
    const traceFailureType = summarizeRunDigestPoint(readTraceString(input.trace, "failureType") ?? "");
    if (traceFailureType) {
      blockers.push(`failure type: ${traceFailureType}`);
    }
  }
  const uniqueSuccesses = dedupeRunDigestPoints(successes, 3);
  const uniqueFailures = dedupeRunDigestPoints(failures, 3);
  const uniqueBlockers = dedupeRunDigestPoints(blockers, 2);
  const headline =
    input.status === "completed"
      ? `Run completed: ${summary}`
      : input.status === "failed"
        ? `Run failed: ${summary}`
        : `Run skipped: ${summary}`;
  const nextAction = resolveRunDigestNextAction({
    status: input.status,
    blockers: uniqueBlockers,
    failures: uniqueFailures
  });
  return {
    status: input.status,
    headline,
    summary,
    successes: uniqueSuccesses,
    failures: uniqueFailures,
    blockers: uniqueBlockers,
    nextAction,
    evidence: {
      transcriptSignalCount: input.signals.length,
      outcomeActionCount: input.outcome?.actions.length ?? 0,
      outcomeBlockerCount: input.outcome?.blockers.length ?? 0,
      failureType: readTraceString(input.trace, "failureType")
    }
  };
}

function summarizeRunDigestPoint(value: string | null | undefined) {
  if (!value) {
    return "";
  }
  const normalized = sanitizeAgentSummaryCommentBody(extractNaturalRunUpdate(value));
  if (!normalized || normalized.toLowerCase() === "run update.") {
    return "";
  }
  const bounded = normalized.length > 180 ? `${normalized.slice(0, 177).trimEnd()}...` : normalized;
  return bounded;
}

function dedupeRunDigestPoints(values: string[], limit: number) {
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const value of values) {
    const key = value.toLowerCase().replace(/\s+/g, " ").trim();
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(value);
    if (deduped.length >= limit) {
      break;
    }
  }
  return deduped;
}

function looksLikeRunFailureSignal(value: string) {
  const normalized = value.toLowerCase();
  return /(failed|error|exception|timed out|timeout|unauthorized|not supported|unsupported|no capacity|rate limit|429|500|blocked|unable to)/.test(
    normalized
  );
}

function resolveRunDigestNextAction(input: { status: "completed" | "failed" | "skipped"; blockers: string[]; failures: string[] }) {
  if (input.status === "completed") {
    return "Review outputs and move the issue to the next workflow state.";
  }
  const combined = [...input.blockers, ...input.failures].join(" ").toLowerCase();
  if (combined.includes("auth") || combined.includes("unauthorized") || combined.includes("login")) {
    return "Fix credentials/authentication, then rerun.";
  }
  if (combined.includes("model") && (combined.includes("not supported") || combined.includes("unavailable"))) {
    return "Select a supported model and rerun.";
  }
  if (combined.includes("usage limit") || combined.includes("rate limit") || combined.includes("no capacity")) {
    return "Retry after provider quota/capacity recovers.";
  }
  return "Fix listed failures/blockers and rerun.";
}

function resolveRunTerminalPresentation(input: {
  internalStatus: "completed" | "failed" | "skipped";
  executionSummary: string;
  outcome: ExecutionOutcome | null;
  trace: unknown;
  errorType?: string | null;
}) : RunTerminalPresentation {
  if (isNoAssignedWorkOutcomeForReport(input.outcome)) {
    return {
      internalStatus: input.internalStatus,
      publicStatus: "completed",
      completionReason: "no_assigned_work"
    };
  }
  if (input.internalStatus === "completed") {
    return {
      internalStatus: input.internalStatus,
      publicStatus: "completed",
      completionReason: "task_completed"
    };
  }
  const completionReason = inferRunCompletionReason(input);
  return {
    internalStatus: input.internalStatus,
    publicStatus: "failed",
    completionReason
  };
}

function inferRunCompletionReason(input: {
  internalStatus: "completed" | "failed" | "skipped";
  executionSummary: string;
  outcome: ExecutionOutcome | null;
  trace: unknown;
  errorType?: string | null;
}): RunCompletionReason {
  const texts = [
    input.executionSummary,
    readTraceString(input.trace, "failureType") ?? "",
    readTraceString(input.trace, "stderrPreview") ?? "",
    input.errorType ?? "",
    ...(input.outcome?.blockers ?? []).flatMap((blocker) => [blocker.code, blocker.message]),
    ...(input.outcome?.actions ?? []).flatMap((action) => [action.type, action.detail ?? ""])
  ];
  const combined = texts.join("\n").toLowerCase();
  if (
    combined.includes("insufficient_quota") ||
    combined.includes("billing_hard_limit_reached") ||
    combined.includes("out of funds") ||
    combined.includes("payment required")
  ) {
    return "provider_out_of_funds";
  }
  if (
    combined.includes("usage limit") ||
    combined.includes("rate limit") ||
    combined.includes("429") ||
    combined.includes("quota")
  ) {
    return combined.includes("quota") ? "provider_quota_exhausted" : "provider_rate_limited";
  }
  if (combined.includes("budget hard-stop")) {
    return "budget_hard_stop";
  }
  if (combined.includes("already in progress") || combined.includes("skipped_overlap")) {
    return "overlap_in_progress";
  }
  if (combined.includes("unauthorized") || combined.includes("auth") || combined.includes("api key")) {
    return "auth_error";
  }
  if (combined.includes("contract") || combined.includes("missing_structured_output")) {
    return "contract_invalid";
  }
  if (combined.includes("watchdog_timeout") || combined.includes("runtime_timeout") || combined.includes("timed out")) {
    return "timeout";
  }
  if (combined.includes("cancelled")) {
    return "cancelled";
  }
  if (combined.includes("enoent") || combined.includes("runtime_missing")) {
    return "runtime_missing";
  }
  if (
    combined.includes("provider unavailable") ||
    combined.includes("no capacity") ||
    combined.includes("unavailable") ||
    combined.includes("http_error")
  ) {
    return "provider_unavailable";
  }
  if (input.outcome?.kind === "blocked") {
    return "blocked";
  }
  return "runtime_error";
}

function isNoAssignedWorkOutcomeForReport(outcome: ExecutionOutcome | null) {
  if (!outcome) {
    return false;
  }
  if (outcome.kind !== "skipped") {
    return false;
  }
  if (outcome.issueIdsTouched.length === 0) {
    return true;
  }
  return outcome.actions.some((action) => action.type === "heartbeat.skip");
}

function buildRunCostSummary(input: {
  tokenInput: number;
  tokenOutput: number;
  usdCost: number | null;
  usdCostStatus: "exact" | "estimated" | "unknown";
  pricingSource: string | null;
  source: string | null;
}): RunCostSummary {
  return {
    tokenInput: Math.max(0, input.tokenInput),
    tokenOutput: Math.max(0, input.tokenOutput),
    usdCost: input.usdCostStatus === "unknown" ? null : Math.max(0, input.usdCost ?? 0),
    usdCostStatus: input.usdCostStatus,
    pricingSource: input.pricingSource ?? null,
    source: input.source ?? null
  };
}

function buildRunArtifacts(input: {
  outcome: ExecutionOutcome | null;
  finalRunOutput?: AgentFinalRunOutput | null;
  runtimeCwd?: string | null;
  workspaceRootPath?: string | null;
}): RunArtifact[] {
  const sourceArtifacts =
    input.finalRunOutput?.artifacts && input.finalRunOutput.artifacts.length > 0
      ? input.finalRunOutput.artifacts
      : input.outcome?.artifacts ?? [];
  if (sourceArtifacts.length === 0) {
    return [];
  }
  const runtimeCwd = input.runtimeCwd?.trim() ? input.runtimeCwd.trim() : null;
  const workspaceRootPath = input.workspaceRootPath?.trim() ? input.workspaceRootPath.trim() : null;
  return sourceArtifacts.map((artifact) => {
    const originalPath = artifact.path.trim();
    const isAbsolute = originalPath.startsWith("/");
    const absolutePath = isAbsolute ? originalPath : runtimeCwd ? resolve(runtimeCwd, originalPath) : null;
    let relativePathValue: string | null = null;
    if (absolutePath && workspaceRootPath && isInsidePath(workspaceRootPath, absolutePath)) {
      const candidate = relative(workspaceRootPath, absolutePath);
      relativePathValue = candidate || null;
    } else if (!isAbsolute) {
      relativePathValue = originalPath;
    } else if (runtimeCwd) {
      const candidate = relative(runtimeCwd, originalPath);
      relativePathValue = candidate && !candidate.startsWith("..") ? candidate : null;
    }
    return {
      path: originalPath,
      kind: artifact.kind,
      label: describeArtifact(artifact.kind, relativePathValue ?? absolutePath ?? originalPath),
      relativePath: relativePathValue,
      absolutePath
    };
  });
}

function describeArtifact(kind: string, location: string) {
  const normalizedKind = kind.toLowerCase();
  if (normalizedKind.includes("folder") || normalizedKind.includes("directory") || normalizedKind === "website") {
    return `Created ${normalizedKind.replace(/_/g, " ")} at ${location}`;
  }
  if (normalizedKind.includes("file")) {
    return `Updated file ${location}`;
  }
  return `Produced ${normalizedKind.replace(/_/g, " ")} at ${location}`;
}

function buildRunCompletionReport(input: {
  companyId?: string;
  agentName: string;
  providerType: HeartbeatProviderType;
  issueIds: string[];
  executionSummary: string;
  outcome: ExecutionOutcome | null;
  finalRunOutput?: AgentFinalRunOutput | null;
  trace: unknown;
  digest: RunDigest;
  terminal: RunTerminalPresentation;
  cost: RunCostSummary;
  runtimeCwd?: string | null;
  errorType?: string | null;
  errorMessage?: string | null;
}): RunCompletionReport {
  const workspaceRootPath = input.companyId ? resolveCompanyWorkspaceRootPath(input.companyId) : null;
  const artifacts = buildRunArtifacts({
    outcome: input.outcome,
    finalRunOutput: input.finalRunOutput,
    runtimeCwd: input.runtimeCwd,
    workspaceRootPath
  });
  const fallbackSummary = sanitizeAgentSummaryCommentBody(extractNaturalRunUpdate(input.executionSummary));
  const employeeComment =
    input.finalRunOutput?.employee_comment?.trim() || buildLegacyEmployeeComment(fallbackSummary);
  const results = input.finalRunOutput
    ? input.finalRunOutput.results.filter((value): value is string => Boolean(value))
    : input.terminal.publicStatus === "completed"
      ? dedupeRunDigestPoints(
          [
            input.digest.successes[0],
            artifacts[0]?.label,
            input.terminal.completionReason === "no_assigned_work" ? "No assigned work was available for this run." : null
          ].filter((value): value is string => Boolean(value)),
          4
        )
      : [];
  const errors =
    input.finalRunOutput?.errors.filter((value): value is string => Boolean(value)) ??
    dedupeRunDigestPoints([...input.digest.blockers, ...input.digest.failures].filter((value): value is string => Boolean(value)), 4);
  const summary = firstMeaningfulReportLine(employeeComment) || results[0] || fallbackSummary;
  const resultSummary =
    results[0] ??
    (input.terminal.publicStatus === "completed"
      ? artifacts[0]?.label ??
        (input.terminal.completionReason === "no_assigned_work" ? "No assigned work was available for this run." : summary)
      : input.finalRunOutput
        ? summary
        : "No valid final run output was produced.");
  const statusHeadline =
    input.terminal.publicStatus === "completed"
      ? `Completed: ${summary}`
      : `Failed: ${summary}`;
  const blockers = dedupeRunDigestPoints(errors, 4);
  const artifactPaths = artifacts
    .map((artifact) => artifact.relativePath ?? artifact.absolutePath ?? artifact.path)
    .filter((value): value is string => Boolean(value));
  const managerReport = {
    agentName: input.agentName,
    providerType: input.providerType,
    whatWasDone: results[0] ?? (input.terminal.publicStatus === "completed" ? input.digest.successes[0] ?? summary : summary),
    resultSummary,
    artifactPaths,
    blockers,
    nextAction: input.digest.nextAction,
    costLine: formatRunCostLine(input.cost)
  };
  const fallbackOutcome: ExecutionOutcome = input.outcome ?? {
    kind:
      input.terminal.completionReason === "no_assigned_work"
        ? "skipped"
        : input.terminal.publicStatus === "completed"
          ? "completed"
          : "failed",
    issueIdsTouched: input.issueIds,
    artifacts: artifacts.map((artifact) => ({ path: artifact.path, kind: artifact.kind })),
    actions:
      results.length > 0
        ? results.slice(0, 4).map((result) => ({
            type: input.terminal.publicStatus === "completed" ? "run.completed" : "run.failed",
            status: input.terminal.publicStatus === "completed" ? "ok" : "error",
            detail: result
          }))
        : [
            {
              type: input.terminal.publicStatus === "completed" ? "run.completed" : "run.failed",
              status: input.terminal.publicStatus === "completed" ? "ok" : "error",
              detail: managerReport.whatWasDone
            }
          ],
    blockers: blockers.map((message) => ({
      code: input.terminal.completionReason,
      message,
      retryable: input.terminal.publicStatus !== "completed"
    })),
    nextSuggestedState: input.terminal.publicStatus === "completed" ? "in_review" : "blocked"
  };
  return {
    finalStatus: input.terminal.publicStatus,
    completionReason: input.terminal.completionReason,
    statusHeadline,
    summary,
    employeeComment,
    results,
    errors,
    resultStatus: artifacts.length > 0 ? "reported" : "none_reported",
    resultSummary,
    issueIds: input.issueIds,
    artifacts,
    blockers,
    nextAction: input.digest.nextAction,
    cost: input.cost,
    managerReport,
    outcome: input.outcome ?? fallbackOutcome,
    debug: {
      persistedRunStatus: input.terminal.internalStatus,
      failureType: readTraceString(input.trace, "failureType"),
      errorType: input.errorType ?? null,
      errorMessage: input.errorMessage ?? null
    }
  };
}

function firstMeaningfulReportLine(value: string) {
  for (const rawLine of value.split(/\r?\n/)) {
    const line = rawLine.replace(/^[#>*\-\s`]+/, "").trim();
    if (line) {
      return line;
    }
  }
  return "";
}

function buildLegacyEmployeeComment(summary: string) {
  return summary;
}

function formatRunCostLine(cost: RunCostSummary) {
  const tokens = `${cost.tokenInput} input / ${cost.tokenOutput} output tokens`;
  if (cost.usdCostStatus === "unknown" || cost.usdCost === null || cost.usdCost === undefined) {
    return `${tokens}; dollar cost unknown`;
  }
  const qualifier = cost.usdCostStatus === "estimated" ? "estimated" : "exact";
  return `${tokens}; ${qualifier} cost $${cost.usdCost.toFixed(6)}`;
}

function buildHumanRunUpdateCommentFromReport(
  report: RunCompletionReport,
  options: { runId: string; companyId: string }
) {
  const lines = [
    report.employeeComment.trim(),
    "",
    `- Status: ${report.finalStatus}`,
    `- Agent: ${report.managerReport.agentName}`,
    `- Provider: ${report.managerReport.providerType}`,
    ""
  ];
  if (report.results.length > 0) {
    lines.push("### Results", "");
    for (const result of report.results) {
      lines.push(`- ${result}`);
    }
    lines.push("");
  }
  lines.push("### Result", "", `- What was done: ${report.managerReport.whatWasDone}`, `- Summary: ${report.managerReport.resultSummary}`);
  if (report.artifacts.length > 0) {
    for (const [artifactIndex, artifact] of report.artifacts.entries()) {
      lines.push(`- Artifact: ${formatRunArtifactMarkdownLink(artifact, { ...options, artifactIndex })}`);
    }
  }
  lines.push("");
  lines.push("### Cost", "");
  lines.push(`- Input tokens: \`${report.cost.tokenInput}\``);
  lines.push(`- Output tokens: \`${report.cost.tokenOutput}\``);
  lines.push(`- Dollar cost: ${formatRunCostForHumanReport(report.cost)}`);
  if (report.errors.length > 0) {
    lines.push("");
    lines.push("### Errors", "");
    for (const error of report.errors) {
      lines.push(`- ${error}`);
    }
  }
  return lines.join("\n");
}

function formatRunArtifactMarkdownLink(
  artifact: RunArtifact,
  options: { runId: string; companyId: string; artifactIndex: number }
) {
  const label = artifact.relativePath ?? artifact.absolutePath ?? artifact.path;
  const href = buildRunArtifactLinkHref(options);
  if (!label) {
    return "`artifact`";
  }
  if (!href) {
    return `\`${label}\``;
  }
  return `[${label}](${href})`;
}

function buildRunArtifactLinkHref(options: { runId: string; companyId: string; artifactIndex: number }) {
  const apiBaseUrl = resolveControlPlaneApiBaseUrl().replace(/\/+$/, "");
  const runId = encodeURIComponent(options.runId);
  const artifactIndex = encodeURIComponent(String(options.artifactIndex));
  const companyId = encodeURIComponent(options.companyId);
  return `${apiBaseUrl}/observability/heartbeats/${runId}/artifacts/${artifactIndex}/download?companyId=${companyId}`;
}

function formatRunCostForHumanReport(cost: RunCostSummary) {
  if (cost.usdCostStatus === "unknown" || cost.usdCost === null || cost.usdCost === undefined) {
    return "unknown";
  }
  const qualifier = cost.usdCostStatus === "estimated" ? "estimated " : "exact ";
  return `${qualifier}\`$${cost.usdCost.toFixed(6)}\``;
}

function buildRunListMessageFromReport(report: RunCompletionReport) {
  const resultParts =
    report.finalStatus === "completed"
      ? report.results.length > 0
        ? report.results.slice(0, 2)
        : [report.resultSummary]
      : [];
  const parts = [report.statusHeadline, ...resultParts];
  if (report.artifacts.length > 0) {
    parts.push(`Artifacts: ${report.managerReport.artifactPaths.join(", ")}`);
  }
  if (report.cost.usdCostStatus === "unknown") {
    parts.push("Cost: unknown");
  } else if (report.cost.usdCost !== null && report.cost.usdCost !== undefined) {
    parts.push(`Cost: $${report.cost.usdCost.toFixed(6)}`);
  }
  const compact = parts.filter(Boolean).join(" | ");
  return compact.length > 220 ? `${compact.slice(0, 217).trimEnd()}...` : compact;
}

function isMachineNoiseLine(text: string) {
  const normalized = text.trim();
  if (!normalized) {
    return true;
  }
  if (normalized.length > 220) {
    return true;
  }
  const patterns = [
    /^command:\s*/i,
    /^\s*[\[{].*[\]}]\s*$/,
    /\/bin\/(bash|zsh|sh)/i,
    /(^|\s)(\/Users\/|\/home\/|\/private\/var\/|[A-Za-z]:\\)/,
    /\b(stderr|stdout|stack trace|exit code|payload_json|tokeninput|tokenoutput|usdcost)\b/i,
    /(^|\s)at\s+\S+:\d+:\d+/,
    /```/,
    /\{[\s\S]*"(summary|tokenInput|tokenOutput|usdCost|trace|error)"[\s\S]*\}/i
  ];
  return patterns.some((pattern) => pattern.test(normalized));
}

function extractSummaryFromJsonLikeText(input: string) {
  const fencedMatch = input.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fencedMatch?.[1]?.trim() ?? input.match(/\{[\s\S]*\}\s*$/)?.[0]?.trim();
  if (!candidate) {
    return null;
  }
  try {
    const parsed = JSON.parse(candidate) as Record<string, unknown>;
    const summary = parsed.summary;
    if (typeof summary === "string" && summary.trim().length > 0) {
      return summary.trim();
    }
  } catch {
    // Fall through to regex extraction for loosely-formatted JSON.
  }
  const summaryMatch = candidate.match(/"summary"\s*:\s*"([\s\S]*?)"/);
  const summary = summaryMatch?.[1]
    ?.replace(/\\"/g, "\"")
    .replace(/\\n/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return summary && summary.length > 0 ? summary : null;
}

async function appendRunSummaryComments(
  db: BopoDb,
  input: {
    companyId: string;
    issueIds: string[];
    agentId: string;
    runId: string;
    report: RunCompletionReport;
  }
) {
  if (input.issueIds.length === 0) {
    return;
  }
  const commentBody = buildHumanRunUpdateCommentFromReport(input.report, {
    runId: input.runId,
    companyId: input.companyId
  });
  for (const issueId of input.issueIds) {
    const existingRunComments = await db
      .select({ id: issueComments.id })
      .from(issueComments)
      .where(
        and(
          eq(issueComments.companyId, input.companyId),
          eq(issueComments.issueId, issueId),
          eq(issueComments.runId, input.runId),
          eq(issueComments.authorType, "agent"),
          eq(issueComments.authorId, input.agentId)
        )
      )
      .orderBy(desc(issueComments.createdAt));
    if (existingRunComments.length > 0) {
      await db.delete(issueComments).where(
        and(
          eq(issueComments.companyId, input.companyId),
          inArray(
            issueComments.id,
            existingRunComments.map((comment) => comment.id)
          )
        )
      );
    }
    await addIssueComment(db, {
      companyId: input.companyId,
      issueId,
      authorType: "agent",
      authorId: input.agentId,
      runId: input.runId,
      body: commentBody
    });
  }
}

async function appendProviderUsageLimitBoardComments(
  db: BopoDb,
  input: {
    companyId: string;
    issueIds: string[];
    agentId: string;
    runId: string;
    providerType: string;
    message: string;
    paused: boolean;
  }
) {
  if (input.issueIds.length === 0) {
    return;
  }
  const commentBody = buildProviderUsageLimitBoardCommentBody(input);
  for (const issueId of input.issueIds) {
    const [existingRunComment] = await db
      .select({ id: issueComments.id })
      .from(issueComments)
      .where(
        and(
          eq(issueComments.companyId, input.companyId),
          eq(issueComments.issueId, issueId),
          eq(issueComments.runId, input.runId),
          eq(issueComments.authorType, "system"),
          eq(issueComments.authorId, input.agentId)
        )
      )
      .limit(1);
    if (existingRunComment) {
      continue;
    }
    await addIssueComment(db, {
      companyId: input.companyId,
      issueId,
      authorType: "system",
      authorId: input.agentId,
      runId: input.runId,
      recipients: [
        {
          recipientType: "board",
          deliveryStatus: "pending"
        }
      ],
      body: commentBody
    });
  }
}

function buildProviderUsageLimitBoardCommentBody(input: {
  providerType: string;
  message: string;
  paused: boolean;
}) {
  const providerLabel = input.providerType.replace(/[_-]+/g, " ").trim();
  const normalizedProvider = providerLabel.charAt(0).toUpperCase() + providerLabel.slice(1);
  const agentStateLine = input.paused ? "Agent paused." : "Agent already paused.";
  return `${normalizedProvider} usage limit reached.\nRun failed due to provider limits.\n${agentStateLine}\nNext: resume after usage reset or billing/credential fix.`;
}

async function pauseAgentForProviderUsageLimit(
  db: BopoDb,
  input: {
    companyId: string;
    agentId: string;
    requestId: string;
    runId: string;
    providerType: string;
    message: string;
  }
) {
  const [agentRow] = await db
    .select({ status: agents.status })
    .from(agents)
    .where(and(eq(agents.companyId, input.companyId), eq(agents.id, input.agentId)))
    .limit(1);
  if (!agentRow || agentRow.status === "paused" || agentRow.status === "terminated") {
    return { paused: false as const };
  }
  await db
    .update(agents)
    .set({ status: "paused", updatedAt: new Date() })
    .where(and(eq(agents.companyId, input.companyId), eq(agents.id, input.agentId)));
  await appendAuditEvent(db, {
    companyId: input.companyId,
    actorType: "system",
    eventType: "agent.paused_auto_provider_limit",
    entityType: "agent",
    entityId: input.agentId,
    correlationId: input.requestId,
    payload: {
      runId: input.runId,
      providerType: input.providerType,
      reason: input.message
    }
  });
  return { paused: true as const };
}

function parseAgentState(stateBlob: string | null) {
  if (!stateBlob) {
    return { state: {} as AgentState, parseError: null };
  }
  try {
    return {
      state: JSON.parse(stateBlob) as AgentState & {
        runtime?: {
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
          bootstrapPrompt?: string;
          runPolicy?: {
            sandboxMode?: "workspace_write" | "full_access";
            allowWebSearch?: boolean;
          };
        };
      },
      parseError: null
    };
  } catch (error) {
    return {
      state: {} as AgentState,
      parseError: String(error)
    };
  }
}

function classifyHeartbeatError(error: unknown) {
  const message = String(error);
  const normalized = message.toLowerCase();
  if (error instanceof AdapterExecutionCancelledError || normalized.includes("adapter execution cancelled")) {
    return { type: "cancelled" as const, timeoutSource: null, message };
  }
  if (error instanceof AdapterExecutionWatchdogTimeoutError || normalized.includes("adapter execution timed out")) {
    return { type: "timeout" as const, timeoutSource: "watchdog" as const, message };
  }
  if (message.includes("ENOENT")) {
    return { type: "runtime_missing" as const, timeoutSource: null, message };
  }
  if (normalized.includes("timeout") || normalized.includes("timed out")) {
    return { type: "timeout" as const, timeoutSource: "runtime" as const, message };
  }
  return { type: "unknown" as const, timeoutSource: null, message };
}

function shouldPromoteIssuesToReview(input: {
  summary: string;
  tokenInput: number;
  tokenOutput: number;
  usdCost: number;
  trace: unknown;
  outcome: ExecutionOutcome | null;
}) {
  if (input.outcome) {
    if (isBootstrapDemoSummary(input.summary)) {
      return false;
    }
    if (input.outcome.kind !== "completed") {
      return false;
    }
    if (input.outcome.blockers.length > 0) {
      return false;
    }
    if (input.outcome.nextSuggestedState === "blocked") {
      return false;
    }
    return true;
  }
  return !isBootstrapDemoSummary(input.summary) && hasRealExecutionEvidence(input);
}

function isBootstrapDemoSummary(summary: string) {
  const normalized = summary.trim().toLowerCase();
  return normalized === "ceo bootstrap heartbeat" || normalized.startsWith("ceo bootstrap heartbeat ");
}

function hasRealExecutionEvidence(input: {
  tokenInput: number;
  tokenOutput: number;
  usdCost: number;
  trace: unknown;
}) {
  if (input.tokenInput > 0 || input.tokenOutput > 0 || input.usdCost > 0) {
    return true;
  }
  const stdoutPreview = readTraceString(input.trace, "stdoutPreview");
  if (!stdoutPreview) {
    return false;
  }
  return !looksLikeEchoedPrompt(stdoutPreview);
}

function looksLikeEchoedPrompt(stdoutPreview: string) {
  const normalized = stdoutPreview.toLowerCase();
  return (
    normalized.includes("execution directives:") &&
    normalized.includes("at the end of your response, include exactly one json object on a single line:")
  );
}

function readTraceString(trace: unknown, key: string) {
  if (!trace || typeof trace !== "object") {
    return null;
  }
  const value = (trace as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function normalizeTraceTranscript(trace: unknown) {
  type NormalizedTranscriptMessage = {
    kind: "system" | "assistant" | "thinking" | "tool_call" | "tool_result" | "result" | "stderr";
    label: string | undefined;
    text: string | undefined;
    payload: string | undefined;
    signalLevel: "high" | "medium" | "low" | "noise";
    groupKey: string | undefined;
  };
  if (!trace || typeof trace !== "object") {
    return [] as NormalizedTranscriptMessage[];
  }
  const transcript = (trace as Record<string, unknown>).transcript;
  if (!Array.isArray(transcript)) {
    return [];
  }
  const normalized: NormalizedTranscriptMessage[] = [];
  for (const entry of transcript) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const kind = normalizeTranscriptKind(String(record.kind ?? "system"));
    const label = typeof record.label === "string" ? record.label : undefined;
    normalized.push({
      kind,
      label: typeof record.label === "string" ? record.label : undefined,
      text: typeof record.text === "string" ? record.text : undefined,
      payload: typeof record.payload === "string" ? record.payload : undefined,
      signalLevel: normalizeTranscriptSignalLevel(
        typeof record.signalLevel === "string" ? (record.signalLevel as "high" | "medium" | "low" | "noise") : undefined,
        kind
      ),
      groupKey:
        typeof record.groupKey === "string" && record.groupKey.trim().length > 0
          ? record.groupKey
          : defaultTranscriptGroupKey(kind, label)
    });
  }
  return normalized;
}

function normalizeTranscriptKind(
  value: string
): "system" | "assistant" | "thinking" | "tool_call" | "tool_result" | "result" | "stderr" {
  const normalized = value.trim().toLowerCase();
  if (
    normalized === "system" ||
    normalized === "assistant" ||
    normalized === "thinking" ||
    normalized === "tool_call" ||
    normalized === "tool_result" ||
    normalized === "result" ||
    normalized === "stderr"
  ) {
    return normalized;
  }
  return "system";
}

function normalizeTranscriptResultText(value: string | undefined) {
  const normalized = (value ?? "").replace(/\s+/g, " ").trim().toLowerCase();
  return normalized;
}

function defaultTranscriptGroupKey(kind: string, label?: string) {
  if (kind === "tool_call" || kind === "tool_result") {
    return `tool:${(label ?? "unknown").trim().toLowerCase()}`;
  }
  if (kind === "result") {
    return "result";
  }
  if (kind === "assistant") {
    return "assistant";
  }
  if (kind === "stderr") {
    return "stderr";
  }
  return "system";
}

function normalizeTranscriptSignalLevel(
  value: "high" | "medium" | "low" | "noise" | undefined,
  kind: string
): "high" | "medium" | "low" | "noise" {
  if (value === "high" || value === "medium" || value === "low" || value === "noise") {
    return value;
  }
  if (kind === "tool_call" || kind === "tool_result" || kind === "result") {
    return "high";
  }
  if (kind === "assistant") {
    return "medium";
  }
  if (kind === "stderr") {
    return "low";
  }
  return "noise";
}

function isUsefulTranscriptSignal(level: "high" | "medium" | "low" | "noise") {
  return level === "high" || level === "medium";
}

function publishHeartbeatRunStatus(
  realtimeHub: RealtimeHub | undefined,
  input: {
    companyId: string;
    runId: string;
    status: "started" | "completed" | "failed" | "skipped";
    message?: string | null;
    startedAt?: Date;
    finishedAt?: Date;
  }
) {
  if (!realtimeHub) {
    return;
  }
  realtimeHub.publish(
    createHeartbeatRunsRealtimeEvent(input.companyId, {
      type: "run.status.updated",
      runId: input.runId,
      status: input.status,
      message: input.message ?? null,
      startedAt: input.startedAt?.toISOString(),
      finishedAt: input.finishedAt?.toISOString() ?? null
    })
  );
}

async function resolveRuntimeWorkspaceForWorkItems(
  db: BopoDb,
  companyId: string,
  agentId: string,
  workItems: Array<{ id?: string; project_id: string }>,
  runtime:
    | {
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
        bootstrapPrompt?: string;
        runPolicy?: {
          sandboxMode?: "workspace_write" | "full_access";
          allowWebSearch?: boolean;
        };
      }
    | undefined
) {
  const normalizedRuntimeCwd = runtime?.cwd?.trim();
  const warnings: string[] = [];
  const projectIds = Array.from(new Set(workItems.map((item) => item.project_id)));
  const projectWorkspaceContextMap = await getProjectWorkspaceContextMap(db, companyId, projectIds);
  for (const projectId of projectIds) {
    const projectContext = projectWorkspaceContextMap.get(projectId);
    if (!projectContext) {
      continue;
    }
    const mode = projectContext.policy?.mode ?? "project_primary";
    const baseWorkspaceCwd = hasText(projectContext.cwd)
      ? normalizeCompanyWorkspacePath(companyId, projectContext.cwd as string)
      : projectContext.repoUrl
        ? resolveProjectWorkspacePath(companyId, projectId)
        : null;
    if (mode === "agent_default" && hasText(normalizedRuntimeCwd)) {
      const boundedRuntimeCwd = assertRuntimeCwdForCompany(companyId, normalizedRuntimeCwd!, "runtime.cwd");
      return {
        source: "agent_runtime",
        warnings,
        runtime: {
          ...runtime,
          cwd: boundedRuntimeCwd
        }
      };
    }
    if (!baseWorkspaceCwd) {
      continue;
    }
    let selectedWorkspaceCwd = normalizeCompanyWorkspacePath(companyId, baseWorkspaceCwd);
    const projectIssue = workItems.find((item) => item.project_id === projectId);
    await mkdir(baseWorkspaceCwd, { recursive: true });
    try {
      if (hasText(projectContext.repoUrl)) {
        const bootstrap = await bootstrapRepositoryWorkspace({
          companyId,
          projectId,
          cwd: baseWorkspaceCwd,
          repoUrl: projectContext.repoUrl as string,
          repoRef: projectContext.repoRef,
          policy: projectContext.policy,
          runtimeEnv: runtime?.env
        });
        selectedWorkspaceCwd = normalizeCompanyWorkspacePath(companyId, bootstrap.cwd);
      }
      if (
        mode === "isolated" &&
        projectContext.policy?.strategy?.type === "git_worktree" &&
        resolveGitWorktreeIsolationEnabled()
      ) {
        const worktree = await ensureIsolatedGitWorktree({
          companyId,
          repoCwd: selectedWorkspaceCwd,
          projectId,
          agentId,
          issueId: projectIssue?.id ?? null,
          repoRef: projectContext.repoRef,
          policy: projectContext.policy
        });
        selectedWorkspaceCwd = normalizeCompanyWorkspacePath(companyId, worktree.cwd);
      } else if (mode === "isolated" && projectContext.policy?.strategy?.type === "git_worktree") {
        warnings.push(
          "Project execution workspace policy mode 'isolated' is configured with git_worktree, but BOPO_ENABLE_GIT_WORKTREE_ISOLATION is disabled. Falling back to primary project workspace."
        );
      }
    } catch (error) {
      const message = error instanceof GitRuntimeError ? error.message : String(error);
      warnings.push(`Workspace bootstrap failed for project '${projectId}': ${message}`);
    }

    if (projectIssue?.id) {
      const issueScopedWorkspaceCwd = normalizeCompanyWorkspacePath(
        companyId,
        join(selectedWorkspaceCwd, "issues", projectIssue.id)
      );
      await mkdir(issueScopedWorkspaceCwd, { recursive: true });
      selectedWorkspaceCwd = issueScopedWorkspaceCwd;
    }

    if (hasText(normalizedRuntimeCwd) && normalizedRuntimeCwd !== selectedWorkspaceCwd) {
      warnings.push(
        `Runtime cwd '${normalizedRuntimeCwd}' was overridden to project workspace '${selectedWorkspaceCwd}' for assigned work.`
      );
    }
    return {
      source: "project_workspace",
      warnings,
      runtime: {
        ...runtime,
        cwd: selectedWorkspaceCwd
      }
    };
  }

  if (projectIds.length > 0) {
    warnings.push("Assigned project has no primary workspace cwd/repo configured. Falling back to agent workspace.");
  }

  if (hasText(normalizedRuntimeCwd)) {
    const boundedRuntimeCwd = assertRuntimeCwdForCompany(companyId, normalizedRuntimeCwd!, "runtime.cwd");
    return {
      source: "agent_runtime",
      warnings,
      runtime: {
        ...runtime,
        cwd: boundedRuntimeCwd
      }
    };
  }

  const fallbackWorkspace = normalizeCompanyWorkspacePath(companyId, resolveAgentFallbackWorkspace(companyId, agentId));
  await mkdir(fallbackWorkspace, { recursive: true });
  warnings.push(`Runtime cwd was not configured. Falling back to '${fallbackWorkspace}'.`);
  return {
    source: "agent_fallback",
    warnings,
    runtime: {
      ...runtime,
      cwd: fallbackWorkspace
    }
  };
}

function resolveGitWorktreeIsolationEnabled() {
  const value = String(process.env.BOPO_ENABLE_GIT_WORKTREE_ISOLATION ?? "")
    .trim()
    .toLowerCase();
  return value === "1" || value === "true";
}

function resolveStaleRunThresholdMs() {
  const parsed = Number(process.env.BOPO_HEARTBEAT_STALE_RUN_MS ?? 10 * 60 * 1000);
  if (!Number.isFinite(parsed) || parsed < 1_000) {
    return 10 * 60 * 1000;
  }
  return parsed;
}

function resolveHeartbeatSweepConcurrency(dueAgentsCount: number) {
  const configured = Number(process.env.BOPO_HEARTBEAT_SWEEP_CONCURRENCY ?? "4");
  const fallback = 4;
  const normalized = Number.isFinite(configured) ? Math.floor(configured) : fallback;
  if (normalized < 1) {
    return 1;
  }
  // Prevent scheduler bursts from starving the API event loop.
  const bounded = Math.min(normalized, 16);
  return Math.min(bounded, Math.max(1, dueAgentsCount));
}

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>
) {
  if (items.length === 0) {
    return;
  }
  const workerCount = Math.max(1, Math.min(Math.floor(concurrency), items.length));
  let cursor = 0;
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (cursor < items.length) {
        const index = cursor;
        cursor += 1;
        await worker(items[index] as T, index);
      }
    })
  );
}

function resolveEffectiveStaleRunThresholdMs(input: {
  baseThresholdMs: number;
  runtimeTimeoutSec: number;
  interruptGraceSec: number;
}) {
  if (!Number.isFinite(input.runtimeTimeoutSec) || input.runtimeTimeoutSec <= 0) {
    return input.baseThresholdMs;
  }
  const timeoutMs = Math.floor(input.runtimeTimeoutSec * 1000);
  const graceMs = Math.max(5_000, Math.floor(Math.max(0, input.interruptGraceSec) * 1000));
  const jitterBufferMs = 30_000;
  const derivedThresholdMs = timeoutMs + graceMs + jitterBufferMs;
  const minimumThresholdMs = 30_000;
  return Math.max(minimumThresholdMs, Math.min(input.baseThresholdMs, derivedThresholdMs));
}

async function executeAdapterWithWatchdog<T>(input: {
  execute: (abortSignal: AbortSignal) => Promise<T>;
  providerType: HeartbeatProviderType;
  externalAbortSignal?: AbortSignal;
  runtime:
    | {
        timeoutMs?: number;
        interruptGraceSec?: number;
      }
    | undefined;
}) {
  const timeoutMs = resolveAdapterWatchdogTimeoutMs(input.providerType, input.runtime);
  if (timeoutMs <= 0) {
    return input.execute(input.externalAbortSignal ?? new AbortController().signal);
  }
  const executionAbort = new AbortController();
  let timer: NodeJS.Timeout | null = null;
  let externalAbortListener: (() => void) | null = null;
  try {
    if (input.externalAbortSignal) {
      externalAbortListener = () => {
        if (!executionAbort.signal.aborted) {
          executionAbort.abort("external");
        }
      };
      if (input.externalAbortSignal.aborted) {
        externalAbortListener();
      } else {
        input.externalAbortSignal.addEventListener("abort", externalAbortListener, { once: true });
      }
    }
    const executionPromise = input.execute(executionAbort.signal);
    // If watchdog timeout wins race, suppress late adapter rejections after abort.
    void executionPromise.catch(() => undefined);
    const cancellationPromise = new Promise<T>((_, reject) => {
      if (!input.externalAbortSignal) {
        return;
      }
      if (input.externalAbortSignal.aborted) {
        reject(new AdapterExecutionCancelledError("adapter execution cancelled by external stop request"));
        return;
      }
      input.externalAbortSignal.addEventListener(
        "abort",
        () => {
          reject(new AdapterExecutionCancelledError("adapter execution cancelled by external stop request"));
        },
        { once: true }
      );
    });
    return await Promise.race([
      executionPromise,
      cancellationPromise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          if (!executionAbort.signal.aborted) {
            executionAbort.abort("watchdog");
          }
          reject(new AdapterExecutionWatchdogTimeoutError(timeoutMs));
        }, timeoutMs);
      })
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
    if (input.externalAbortSignal && externalAbortListener) {
      input.externalAbortSignal.removeEventListener("abort", externalAbortListener);
    }
  }
}

class AdapterExecutionWatchdogTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`adapter execution timed out after ${timeoutMs}ms`);
    this.name = "AdapterExecutionWatchdogTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

class AdapterExecutionCancelledError extends Error {
  constructor(message = "adapter execution cancelled") {
    super(message);
    this.name = "AdapterExecutionCancelledError";
  }
}

function resolveAdapterWatchdogTimeoutMs(
  providerType: HeartbeatProviderType,
  runtime:
    | {
        timeoutMs?: number;
        interruptGraceSec?: number;
      }
    | undefined
) {
  const expectedBudgetMs = estimateProviderExecutionBudgetMs(providerType, runtime);
  const fallback = Number(process.env.BOPO_HEARTBEAT_EXECUTION_TIMEOUT_MS ?? expectedBudgetMs);
  if (!Number.isFinite(fallback) || fallback < 30_000) {
    return expectedBudgetMs;
  }
  return Math.floor(Math.min(fallback, 15 * 60 * 1000));
}

function estimateProviderExecutionBudgetMs(
  providerType: HeartbeatProviderType,
  runtime:
    | {
        timeoutMs?: number;
        interruptGraceSec?: number;
        retryCount?: number;
      }
    | undefined
) {
  const perAttemptTimeoutMs = resolveRuntimeAttemptTimeoutMs(providerType, runtime?.timeoutMs);
  const perAttemptGraceMs = Math.max(5_000, Math.floor(Math.max(0, runtime?.interruptGraceSec ?? 0) * 1000));
  const retryCount = resolveRuntimeRetryCount(providerType, runtime?.retryCount);
  const attemptsPerExecution = Math.max(1, Math.min(3, 1 + retryCount));
  const executionMultiplier = providerType === "claude_code" ? 3 : 1;
  const expectedAttempts = attemptsPerExecution * executionMultiplier;
  const jitterBufferMs = 30_000;
  return Math.floor(perAttemptTimeoutMs * expectedAttempts + perAttemptGraceMs * expectedAttempts + jitterBufferMs);
}

function resolveRuntimeAttemptTimeoutMs(
  providerType: HeartbeatProviderType,
  configuredTimeoutMs: number | undefined
) {
  if (Number.isFinite(configuredTimeoutMs) && (configuredTimeoutMs ?? 0) > 0) {
    return Math.floor(configuredTimeoutMs ?? 0);
  }
  if (providerType === "claude_code" || providerType === "codex" || providerType === "opencode" || providerType === "cursor") {
    return 15 * 60 * 1000;
  }
  return 15 * 60 * 1000;
}

function resolveRuntimeRetryCount(
  providerType: HeartbeatProviderType,
  configuredRetryCount: number | undefined
) {
  if (Number.isFinite(configuredRetryCount)) {
    return Math.max(0, Math.min(2, Math.floor(configuredRetryCount ?? 0)));
  }
  return providerType === "codex" || providerType === "opencode" ? 1 : 0;
}

function mergeRuntimeForExecution(
  runtimeFromConfig:
    | {
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
        bootstrapPrompt?: string;
        runPolicy?: {
          sandboxMode?: "workspace_write" | "full_access";
          allowWebSearch?: boolean;
        };
      }
    | undefined,
  runtimeFromState:
    | {
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
        bootstrapPrompt?: string;
        runPolicy?: {
          sandboxMode?: "workspace_write" | "full_access";
          allowWebSearch?: boolean;
        };
      }
    | undefined
) {
  const merged = {
    ...(runtimeFromConfig ?? {}),
    ...(runtimeFromState ?? {})
  };
  return {
    ...merged,
    // Keep system-injected BOPODEV_* context even when state runtime carries env:{}.
    env: {
      ...(runtimeFromState?.env ?? {}),
      ...(runtimeFromConfig?.env ?? {})
    }
  };
}

function registerActiveHeartbeatRun(runId: string, run: ActiveHeartbeatRun) {
  activeHeartbeatRuns.set(runId, run);
}

function unregisterActiveHeartbeatRun(runId: string) {
  activeHeartbeatRuns.delete(runId);
}

function clearResumeState(
  state: AgentState & {
    runtime?: {
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
      bootstrapPrompt?: string;
      runPolicy?: {
        sandboxMode?: "workspace_write" | "full_access";
        allowWebSearch?: boolean;
      };
    };
  }
) {
  const nextState = { ...state } as AgentState & Record<string, unknown>;
  delete nextState.sessionId;
  delete nextState.cwd;
  delete nextState.cursorSession;
  return nextState as AgentState & {
    runtime?: {
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
      bootstrapPrompt?: string;
      runPolicy?: {
        sandboxMode?: "workspace_write" | "full_access";
        allowWebSearch?: boolean;
      };
    };
  };
}

function resolveControlPlaneEnv(runtimeEnv: Record<string, string>, suffix: string) {
  const next = runtimeEnv[`BOPODEV_${suffix}`];
  return hasText(next) ? (next as string) : "";
}

function resolveControlPlaneProcessEnv(suffix: string) {
  return process.env[`BOPODEV_${suffix}`];
}

function buildHeartbeatRuntimeEnv(input: {
  companyId: string;
  agentId: string;
  heartbeatRunId: string;
  canHireAgents: boolean;
  wakeContext?: HeartbeatWakeContext;
}) {
  const apiBaseUrl = resolveControlPlaneApiBaseUrl();
  const actorPermissions = ["issues:write", ...(input.canHireAgents ? ["agents:write"] : [])].join(",");
  const actorHeaders = JSON.stringify({
    "x-company-id": input.companyId,
    "x-actor-type": "agent",
    "x-actor-id": input.agentId,
    "x-actor-companies": input.companyId,
    "x-actor-permissions": actorPermissions
  });

  const codexApiKey = resolveCodexApiKey();
  const claudeApiKey = resolveClaudeApiKey();
  return {
    BOPODEV_AGENT_ID: input.agentId,
    BOPODEV_COMPANY_ID: input.companyId,
    BOPODEV_RUN_ID: input.heartbeatRunId,
    BOPODEV_FORCE_MANAGED_CODEX_HOME: "false",
    BOPODEV_API_BASE_URL: apiBaseUrl,
    BOPODEV_API_URL: apiBaseUrl,
    BOPODEV_ACTOR_TYPE: "agent",
    BOPODEV_ACTOR_ID: input.agentId,
    BOPODEV_ACTOR_COMPANIES: input.companyId,
    BOPODEV_ACTOR_PERMISSIONS: actorPermissions,
    BOPODEV_REQUEST_HEADERS_JSON: actorHeaders,
    BOPODEV_REQUEST_APPROVAL_DEFAULT: "true",
    BOPODEV_CAN_HIRE_AGENTS: input.canHireAgents ? "true" : "false",
    ...(input.wakeContext?.reason ? { BOPODEV_WAKE_REASON: input.wakeContext.reason } : {}),
    ...(input.wakeContext?.commentId ? { BOPODEV_WAKE_COMMENT_ID: input.wakeContext.commentId } : {}),
    ...(input.wakeContext?.issueIds?.length ? { BOPODEV_LINKED_ISSUE_IDS: input.wakeContext.issueIds.join(",") } : {}),
    ...(codexApiKey ? { OPENAI_API_KEY: codexApiKey } : {}),
    ...(claudeApiKey ? { ANTHROPIC_API_KEY: claudeApiKey } : {})
  } satisfies Record<string, string>;
}

function resolveControlPlaneApiBaseUrl() {
  // Agent runtimes must call the control-plane API directly; do not inherit
  // browser-facing NEXT_PUBLIC_API_URL (can point to non-runtime endpoints).
  const configured = resolveControlPlaneProcessEnv("API_BASE_URL");
  return normalizeControlPlaneApiBaseUrl(configured) ?? "http://127.0.0.1:4020";
}

function resolveCodexApiKey() {
  const configured = process.env.BOPO_OPENAI_API_KEY ?? process.env.OPENAI_API_KEY;
  const value = configured?.trim();
  return value && value.length > 0 ? value : null;
}

function resolveClaudeApiKey() {
  const configured = process.env.BOPO_ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_API_KEY;
  const value = configured?.trim();
  return value && value.length > 0 ? value : null;
}

function summarizeRuntimeLaunch(
  providerType: HeartbeatProviderType,
  runtime:
    | {
        command?: string;
        args?: string[];
        cwd?: string;
        timeoutMs?: number;
        env?: Record<string, string>;
        runPolicy?: {
          sandboxMode?: "workspace_write" | "full_access";
          allowWebSearch?: boolean;
        };
      }
    | undefined
) {
  const env = runtime?.env ?? {};
  const hasOpenAiKey = typeof env.OPENAI_API_KEY === "string" && env.OPENAI_API_KEY.trim().length > 0;
  const hasAnthropicKey = typeof env.ANTHROPIC_API_KEY === "string" && env.ANTHROPIC_API_KEY.trim().length > 0;
  const hasExplicitCodexHome = typeof env.CODEX_HOME === "string" && env.CODEX_HOME.trim().length > 0;
  const codexHomeMode =
    providerType !== "codex"
      ? null
      : hasExplicitCodexHome
        ? "explicit"
        : hasText(resolveControlPlaneEnv(env, "COMPANY_ID")) && hasText(resolveControlPlaneEnv(env, "AGENT_ID"))
          ? "managed"
          : "default";
  const authMode = providerType !== "codex" ? null : hasOpenAiKey ? "api_key" : "session";

  return {
    command: runtime?.command ?? null,
    args: runtime?.args ?? [],
    cwd: runtime?.cwd ?? null,
    timeoutMs: runtime?.timeoutMs ?? null,
    runPolicy: runtime?.runPolicy ?? null,
    authMode,
    codexHomeMode,
    envFlags: {
      hasOpenAiKey,
      hasAnthropicKey,
      hasExplicitCodexHome,
      hasControlPlaneBaseUrl: hasText(resolveControlPlaneEnv(env, "API_BASE_URL")),
      hasRequestHeadersJson: hasText(resolveControlPlaneEnv(env, "REQUEST_HEADERS_JSON"))
    }
  };
}

function normalizeControlPlaneApiBaseUrl(raw: string | undefined) {
  const value = raw?.trim();
  if (!value) {
    return null;
  }
  try {
    const url = new URL(value);
    if (!url.protocol || (url.protocol !== "http:" && url.protocol !== "https:")) {
      return null;
    }
    // Keep local addresses canonical to avoid split diagnostics between localhost/127.0.0.1.
    if (url.hostname === "localhost") {
      url.hostname = "127.0.0.1";
    }
    url.pathname = "";
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

function validateControlPlaneRuntimeEnv(runtimeEnv: Record<string, string>, runId: string) {
  const parsed = ControlPlaneRuntimeEnvSchema.safeParse(runtimeEnv);
  const invalidFieldPaths = parsed.success
    ? []
    : parsed.error.issues.map((issue) => (issue.path.length > 0 ? issue.path.join(".") : "<root>"));
  const runtimeRunId = resolveControlPlaneEnv(runtimeEnv, "RUN_ID");
  const mismatchError = runtimeRunId && runtimeRunId !== runId ? ["BOPODEV_RUN_ID(mismatch)"] : [];
  const allInvalidFieldPaths = [...invalidFieldPaths, ...mismatchError];
  return {
    ok: allInvalidFieldPaths.length === 0,
    validationErrorCode: parsed.success ? (mismatchError.length > 0 ? "run_id_mismatch" : null) : "invalid_control_plane_runtime_env",
    invalidFieldPaths: allInvalidFieldPaths
  };
}

function shouldRequireControlPlanePreflight(
  providerType: HeartbeatProviderType,
  workItemCount: number
) {
  if (workItemCount < 1) {
    return false;
  }
  return (
    providerType === "codex" ||
    providerType === "claude_code" ||
    providerType === "cursor" ||
    providerType === "opencode" ||
    providerType === "gemini_cli"
  );
}

function resolveControlPlanePreflightEnabled() {
  const value = String(resolveControlPlaneProcessEnv("COMMUNICATION_PREFLIGHT") ?? "")
    .trim()
    .toLowerCase();
  return value === "1" || value === "true";
}

function resolveControlPlanePreflightTimeoutMs() {
  const parsed = Number(resolveControlPlaneProcessEnv("COMMUNICATION_PREFLIGHT_TIMEOUT_MS") ?? "1500");
  if (!Number.isFinite(parsed) || parsed < 200) {
    return 1500;
  }
  return Math.floor(parsed);
}

async function runControlPlaneConnectivityPreflight(input: {
  apiBaseUrl: string;
  runtimeEnv: Record<string, string>;
  timeoutMs: number;
}) {
  const normalizedApiBaseUrl = normalizeControlPlaneApiBaseUrl(input.apiBaseUrl);
  if (!normalizedApiBaseUrl) {
    return {
      ok: false as const,
      message: `Invalid BOPODEV_API_BASE_URL '${input.apiBaseUrl || "<empty>"}'.`,
      endpoint: null
    };
  }

  const headerResolution = resolveControlPlaneHeaders(input.runtimeEnv);
  if (!headerResolution.ok) {
    return {
      ok: false as const,
      message: headerResolution.message,
      endpoint: `${normalizedApiBaseUrl}/agents`
    };
  }
  const requestHeaders = headerResolution.headers;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs);
  const endpoint = `${normalizedApiBaseUrl}/agents`;
  try {
    const response = await fetch(endpoint, {
      method: "GET",
      headers: requestHeaders,
      signal: controller.signal
    });
    if (!response.ok) {
      return {
        ok: false as const,
        message: `Control plane responded ${response.status} ${response.statusText}.`,
        endpoint
      };
    }
    return {
      ok: true as const,
      message: "Control-plane preflight passed.",
      endpoint
    };
  } catch (error) {
    return {
      ok: false as const,
      message: String(error),
      endpoint
    };
  } finally {
    clearTimeout(timeout);
  }
}

function resolveControlPlaneHeaders(runtimeEnv: Record<string, string>):
  | { ok: true; headers: Record<string, string> }
  | { ok: false; message: string } {
  const directHeaderResult = ControlPlaneRequestHeadersSchema.safeParse({
    "x-company-id": resolveControlPlaneEnv(runtimeEnv, "COMPANY_ID"),
    "x-actor-type": resolveControlPlaneEnv(runtimeEnv, "ACTOR_TYPE"),
    "x-actor-id": resolveControlPlaneEnv(runtimeEnv, "ACTOR_ID"),
    "x-actor-companies": resolveControlPlaneEnv(runtimeEnv, "ACTOR_COMPANIES"),
    "x-actor-permissions": resolveControlPlaneEnv(runtimeEnv, "ACTOR_PERMISSIONS")
  });
  if (directHeaderResult.success) {
    return { ok: true, headers: directHeaderResult.data };
  }

  const jsonHeadersRaw = resolveControlPlaneEnv(runtimeEnv, "REQUEST_HEADERS_JSON");
  if (!hasText(jsonHeadersRaw)) {
    return {
      ok: false,
      message:
        "Missing control-plane actor headers. Provide BOPODEV_ACTOR_* vars or BOPODEV_REQUEST_HEADERS_JSON."
    };
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(jsonHeadersRaw as string);
  } catch {
    return {
      ok: false,
      message: "Invalid BOPODEV_REQUEST_HEADERS_JSON; expected JSON object of string headers."
    };
  }
  const jsonHeadersResult = ControlPlaneHeadersJsonSchema.safeParse(parsedJson);
  if (!jsonHeadersResult.success) {
    return {
      ok: false,
      message: `Invalid BOPODEV_REQUEST_HEADERS_JSON fields: ${jsonHeadersResult.error.issues
        .map((issue) => issue.path.join("."))
        .join(", ")}`
    };
  }
  return { ok: true, headers: jsonHeadersResult.data };
}

function resolveRuntimeModelId(input: { runtimeModel?: string; stateBlob?: string | null }) {
  const runtimeModel = input.runtimeModel?.trim();
  if (runtimeModel) {
    return runtimeModel;
  }
  if (!input.stateBlob) {
    return null;
  }
  try {
    const parsed = JSON.parse(input.stateBlob) as { runtime?: { model?: unknown } };
    const modelId = parsed.runtime?.model;
    return typeof modelId === "string" && modelId.trim().length > 0 ? modelId.trim() : null;
  } catch {
    return null;
  }
}

async function appendFinishedRunCostEntry(input: {
  db: BopoDb;
  companyId: string;
  runId?: string | null;
  providerType: string;
  runtimeModelId: string | null;
  pricingProviderType?: string | null;
  pricingModelId?: string | null;
  tokenInput: number;
  tokenOutput: number;
  runtimeUsdCost?: number;
  failureType?: string | null;
  issueId?: string | null;
  projectId?: string | null;
  agentId?: string | null;
  status: "ok" | "failed" | "skipped";
}) {
  const pricingDecision = await calculateModelPricedUsdCost({
    db: input.db,
    companyId: input.companyId,
    providerType: input.providerType,
    pricingProviderType: input.pricingProviderType ?? input.providerType,
    modelId: input.pricingModelId ?? input.runtimeModelId,
    tokenInput: input.tokenInput,
    tokenOutput: input.tokenOutput
  });

  const shouldPersist = input.status === "ok" || input.status === "failed";
  const runtimeUsdCost = Math.max(0, input.runtimeUsdCost ?? 0);
  const pricedUsdCost = Math.max(0, pricingDecision.usdCost);
  const usdCostStatus: "exact" | "estimated" | "unknown" =
    runtimeUsdCost > 0 ? "exact" : pricedUsdCost > 0 ? "estimated" : "unknown";
  const effectiveUsdCost = usdCostStatus === "exact" ? runtimeUsdCost : usdCostStatus === "estimated" ? pricedUsdCost : 0;
  const effectivePricingSource = pricingDecision.pricingSource;
  const shouldPersistWithUsage =
    shouldPersist && (input.tokenInput > 0 || input.tokenOutput > 0 || usdCostStatus !== "unknown");
  if (shouldPersistWithUsage) {
    await appendCost(input.db, {
      companyId: input.companyId,
      runId: input.runId ?? null,
      providerType: input.providerType,
      runtimeModelId: input.runtimeModelId,
      pricingProviderType: pricingDecision.pricingProviderType,
      pricingModelId: pricingDecision.pricingModelId,
      pricingSource: effectivePricingSource,
      usdCostStatus,
      tokenInput: input.tokenInput,
      tokenOutput: input.tokenOutput,
      usdCost: effectiveUsdCost.toFixed(6),
      issueId: input.issueId ?? null,
      projectId: input.projectId ?? null,
      agentId: input.agentId ?? null
    });
  }

  return {
    ...pricingDecision,
    pricingSource: effectivePricingSource,
    usdCost: effectiveUsdCost,
    usdCostStatus
  };
}

function isHeartbeatDue(cronExpression: string, lastRunAt: Date | null, now: Date) {
  const normalizedNow = truncateToMinute(now);
  if (!matchesCronExpression(cronExpression, normalizedNow)) {
    return false;
  }
  if (!lastRunAt) {
    return true;
  }
  return truncateToMinute(lastRunAt).getTime() !== normalizedNow.getTime();
}

function truncateToMinute(date: Date) {
  const clone = new Date(date);
  clone.setSeconds(0, 0);
  return clone;
}

function matchesCronExpression(expression: string, date: Date) {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) {
    return false;
  }

  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts as [string, string, string, string, string];
  return (
    matchesCronField(minute, date.getMinutes(), 0, 59) &&
    matchesCronField(hour, date.getHours(), 0, 23) &&
    matchesCronField(dayOfMonth, date.getDate(), 1, 31) &&
    matchesCronField(month, date.getMonth() + 1, 1, 12) &&
    matchesCronField(dayOfWeek, date.getDay(), 0, 6)
  );
}

function matchesCronField(field: string, value: number, min: number, max: number) {
  return field.split(",").some((part) => matchesCronPart(part.trim(), value, min, max));
}

function matchesCronPart(part: string, value: number, min: number, max: number): boolean {
  if (part === "*") {
    return true;
  }

  const stepMatch = part.match(/^\*\/(\d+)$/);
  if (stepMatch) {
    const step = Number(stepMatch[1]);
    return Number.isInteger(step) && step > 0 ? (value - min) % step === 0 : false;
  }

  const rangeMatch = part.match(/^(\d+)-(\d+)$/);
  if (rangeMatch) {
    const start = Number(rangeMatch[1]);
    const end = Number(rangeMatch[2]);
    return start <= value && value <= end;
  }

  const exact = Number(part);
  return Number.isInteger(exact) && exact >= min && exact <= max && exact === value;
}
