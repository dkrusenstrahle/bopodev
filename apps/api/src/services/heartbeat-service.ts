import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { resolveAdapter } from "bopodev-agent-sdk";
import type { AgentState, HeartbeatContext } from "bopodev-agent-sdk";
import {
  ControlPlaneHeadersJsonSchema,
  ControlPlaneRequestHeadersSchema,
  ControlPlaneRuntimeEnvSchema,
  ExecutionOutcomeSchema,
  type ExecutionOutcome
} from "bopodev-contracts";
import type { BopoDb } from "bopodev-db";
import {
  agents,
  appendActivity,
  appendHeartbeatRunMessages,
  companies,
  goals,
  heartbeatRuns,
  issueAttachments,
  issues,
  projects
} from "bopodev-db";
import { appendAuditEvent, appendCost } from "bopodev-db";
import { parseRuntimeConfigFromAgentRow } from "../lib/agent-config";
import { resolveProjectWorkspacePath } from "../lib/instance-paths";
import { getProjectWorkspaceMap, hasText, resolveAgentFallbackWorkspace } from "../lib/workspace-policy";
import type { RealtimeHub } from "../realtime/hub";
import { createHeartbeatRunsRealtimeEvent } from "../realtime/heartbeat-runs";
import { publishOfficeOccupantForAgent } from "../realtime/office-space";
import { checkAgentBudget } from "./budget-service";
import { appendDurableFact, loadAgentMemoryContext, persistHeartbeatMemory } from "./memory-file-service";
import { runPluginHook } from "./plugin-runtime";

type HeartbeatRunTrigger = "manual" | "scheduler";
type HeartbeatRunMode = "default" | "resume" | "redo";
type HeartbeatProviderType =
  | "claude_code"
  | "codex"
  | "cursor"
  | "opencode"
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
      ORDER BY updated_at ASC
      LIMIT ${maxItems}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE issues i
    SET is_claimed = true,
        claimed_by_heartbeat_run_id = ${heartbeatRunId},
        updated_at = CURRENT_TIMESTAMP
    FROM candidate c
    WHERE i.id = c.id
    RETURNING i.id, i.project_id, i.title, i.body, i.status, i.priority, i.labels_json, i.tags_json;
  `);

  return (result.rows ?? []) as Array<{
    id: string;
    project_id: string;
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
      await db.insert(heartbeatRuns).values({
        id: skippedRunId,
        companyId,
        agentId,
        status: "skipped",
        finishedAt: skippedAt,
        message: "Heartbeat skipped: another run is already in progress for this agent."
      });
      publishHeartbeatRunStatus(options?.realtimeHub, {
        companyId,
        runId: skippedRunId,
        status: "skipped",
        message: "Heartbeat skipped: another run is already in progress for this agent.",
        finishedAt: skippedAt
      });
      await appendAuditEvent(db, {
        companyId,
        actorType: "system",
        eventType: "heartbeat.skipped_overlap",
        entityType: "heartbeat_run",
        entityId: skippedRunId,
        correlationId: options?.requestId ?? skippedRunId,
        payload: { agentId, requestId: options?.requestId, trigger: runTrigger }
      });
      return skippedRunId;
    }
  } else {
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "skipped",
      message: "Heartbeat skipped due to budget hard-stop."
    });
    publishHeartbeatRunStatus(options?.realtimeHub, {
      companyId,
      runId,
      status: "skipped",
      message: "Heartbeat skipped due to budget hard-stop."
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
        sourceRunId: options?.sourceRunId ?? null
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
  let transcriptSequence = 0;
  let transcriptWriteQueue = Promise.resolve();
  let transcriptLiveCount = 0;
  let transcriptLiveUsefulCount = 0;
  let transcriptLiveHighSignalCount = 0;
  let transcriptPersistFailureReported = false;
  let pluginFailureSummary: string[] = [];

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
    transcriptLiveCount += 1;
    if (isUsefulTranscriptSignal(signalLevel)) {
      transcriptLiveUsefulCount += 1;
    }
    if (signalLevel === "high") {
      transcriptLiveHighSignalCount += 1;
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
    const workItems = await claimIssuesForAgent(db, companyId, agentId, runId);
    issueIds = workItems.map((item) => item.id);
    await runPluginHook(db, {
      hook: "afterClaim",
      context: {
        companyId,
        agentId,
        runId,
        requestId: options?.requestId,
        providerType: agent.providerType,
        workItemCount: workItems.length
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
      canHireAgents: agent.canHireAgents
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
      workItems,
      mergedRuntime
    );
    state = {
      ...state,
      runtime: workspaceResolution.runtime
    };
    memoryContext = await loadAgentMemoryContext({
      companyId,
      agentId
    });

    const context = await buildHeartbeatContext(db, companyId, {
      agentId,
      agentName: agent.name,
      agentRole: agent.role,
      managerAgentId: agent.managerAgentId,
      providerType: agent.providerType as HeartbeatProviderType,
      heartbeatRunId: runId,
      state,
      memoryContext,
      runtime: workspaceResolution.runtime,
      workItems
    });
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
        workItems.length
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
        workItemCount: workItems.length,
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
    executionSummary = execution.summary;
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
    emitCanonicalResultEvent(executionSummary, "completed");
    executionTrace = execution.trace ?? null;
    const parsedOutcome = ExecutionOutcomeSchema.safeParse(execution.outcome);
    executionOutcome = parsedOutcome.success ? parsedOutcome.data : null;
    const persistedMemory = await persistHeartbeatMemory({
      companyId,
      agentId,
      runId,
      status: execution.status,
      summary: execution.summary,
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
        memoryRoot: persistedMemory.memoryRoot,
        dailyNotePath: persistedMemory.dailyNotePath,
        candidateFacts: persistedMemory.candidateFacts
      }
    });
    if (execution.status === "ok") {
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

    if (execution.tokenInput > 0 || execution.tokenOutput > 0 || execution.usdCost > 0) {
      await appendCost(db, {
        companyId,
        providerType: agent.providerType,
        tokenInput: execution.tokenInput,
        tokenOutput: execution.tokenOutput,
        usdCost: execution.usdCost.toFixed(6),
        issueId: workItems[0]?.id ?? null,
        projectId: workItems[0]?.project_id ?? null,
        agentId
      });
    }

    if (
      execution.nextState ||
      execution.usdCost > 0 ||
      execution.tokenInput > 0 ||
      execution.tokenOutput > 0 ||
      execution.status !== "skipped"
    ) {
      await db
        .update(agents)
        .set({
          stateBlob: JSON.stringify(execution.nextState ?? state),
          usedBudgetUsd: sql`${agents.usedBudgetUsd} + ${execution.usdCost}`,
          tokenUsage: sql`${agents.tokenUsage} + ${execution.tokenInput + execution.tokenOutput}`,
          updatedAt: new Date()
        })
        .where(and(eq(agents.companyId, companyId), eq(agents.id, agentId)));
    }

    const shouldAdvanceIssuesToReview = shouldPromoteIssuesToReview({
      summary: execution.summary,
      tokenInput: execution.tokenInput,
      tokenOutput: execution.tokenOutput,
      usdCost: execution.usdCost,
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
            tokenInput: execution.tokenInput,
            tokenOutput: execution.tokenOutput,
            usdCost: execution.usdCost
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
        status: execution.status,
        summary: execution.summary
      },
      failClosed: false
    });
    if (beforePersistHook.failures.length > 0) {
      pluginFailureSummary = [...pluginFailureSummary, ...beforePersistHook.failures];
    }

    await db
      .update(heartbeatRuns)
      .set({
        status: execution.status === "failed" ? "failed" : "completed",
        finishedAt: new Date(),
        message: execution.summary
      })
      .where(eq(heartbeatRuns.id, runId));
    publishHeartbeatRunStatus(options?.realtimeHub, {
      companyId,
      runId,
      status: execution.status === "failed" ? "failed" : "completed",
      message: execution.summary,
      finishedAt: new Date()
    });

    const fallbackMessages = normalizeTraceTranscript(executionTrace);
    const fallbackHighSignalCount = fallbackMessages.filter((message) => message.signalLevel === "high").length;
    const shouldAppendFallback =
      fallbackMessages.length > 0 &&
      (transcriptLiveCount === 0 ||
        transcriptLiveUsefulCount < 2 ||
        transcriptLiveHighSignalCount < 1 ||
        (transcriptLiveHighSignalCount < 2 && fallbackHighSignalCount > transcriptLiveHighSignalCount));
    if (shouldAppendFallback) {
      const createdAt = new Date();
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
      }> = fallbackMessages.map((message) => ({
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
        status: execution.status,
        summary: execution.summary,
        trace: executionTrace,
        outcome: executionOutcome
      },
      failClosed: false
    });
    if (afterPersistHook.failures.length > 0) {
      pluginFailureSummary = [...pluginFailureSummary, ...afterPersistHook.failures];
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
        result: execution.summary,
        message: execution.summary,
        outcome: executionOutcome,
        issueIds,
        usage: {
          tokenInput: execution.tokenInput,
          tokenOutput: execution.tokenOutput,
          usdCost: execution.usdCost,
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
    await db
      .update(heartbeatRuns)
      .set({
        status: "failed",
        finishedAt: new Date(),
        message: executionSummary
      })
      .where(eq(heartbeatRuns.id, runId));
    publishHeartbeatRunStatus(options?.realtimeHub, {
      companyId,
      runId,
      status: "failed",
      message: executionSummary,
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
        issueIds,
        result: executionSummary,
        message: executionSummary,
        errorType: classified.type,
        errorMessage: classified.message,
        outcome: executionOutcome,
        usage: {
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
      await releaseClaimedIssues(db, companyId, issueIds);
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
          issueIds,
          error: String(releaseError)
        }
      });
    }
    await publishOfficeOccupantForAgent(db, options?.realtimeHub, companyId, agentId);
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
  const recentRuns = await db
    .select({ agentId: heartbeatRuns.agentId, startedAt: heartbeatRuns.startedAt })
    .from(heartbeatRuns)
    .where(eq(heartbeatRuns.companyId, companyId))
    .orderBy(desc(heartbeatRuns.startedAt));
  const latestRunByAgent = new Map<string, Date>();
  for (const run of recentRuns) {
    if (!latestRunByAgent.has(run.agentId)) {
      latestRunByAgent.set(run.agentId, run.startedAt);
    }
  }

  const now = new Date();
  const runs: string[] = [];
  let skippedNotDue = 0;
  let skippedStatus = 0;
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
    try {
      const runId = await runHeartbeatForAgent(db, companyId, agent.id, {
        trigger: "scheduler",
        requestId: options?.requestId,
        realtimeHub: options?.realtimeHub
      });
      if (runId) {
        runs.push(runId);
      }
    } catch {
      failedStarts += 1;
    }
  }
  await appendAuditEvent(db, {
    companyId,
    actorType: "system",
    eventType: "heartbeat.sweep.completed",
    entityType: "company",
    entityId: companyId,
    correlationId: options?.requestId ?? null,
    payload: {
      runIds: runs,
      startedCount: runs.length,
      failedStarts,
      skippedStatus,
      skippedNotDue,
      elapsedMs: Date.now() - sweepStartedAt,
      requestId: options?.requestId ?? null
    }
  });
  return runs;
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
    workItems: Array<{
      id: string;
      project_id: string;
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
  const projectWorkspaceMap = await getProjectWorkspaceMap(db, companyId, projectIds);
  const issueIds = input.workItems.map((item) => item.id);
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
    goalContext: {
      companyGoals: activeCompanyGoals,
      projectGoals: activeProjectGoals,
      agentGoals: activeAgentGoals
    },
    workItems: input.workItems.map((item) => ({
      issueId: item.id,
      projectId: item.project_id,
      projectName: projectNameById.get(item.project_id) ?? null,
      title: item.title,
      body: item.body,
      status: item.status,
      priority: item.priority,
      labels: parseStringArray(item.labels_json),
      tags: parseStringArray(item.tags_json),
      attachments: attachmentsByIssue.get(item.id) ?? []
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
  workItems: Array<{ project_id: string }>,
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
  const projectWorkspaceMap = await getProjectWorkspaceMap(db, companyId, projectIds);

  let selectedProjectWorkspace: string | null = null;
  for (const projectId of projectIds) {
    const projectWorkspace = projectWorkspaceMap.get(projectId) ?? null;
    if (hasText(projectWorkspace)) {
      selectedProjectWorkspace = projectWorkspace;
      break;
    }
  }

  if (selectedProjectWorkspace) {
    await mkdir(selectedProjectWorkspace, { recursive: true });
    if (hasText(normalizedRuntimeCwd) && normalizedRuntimeCwd !== selectedProjectWorkspace) {
      warnings.push(
        `Runtime cwd '${normalizedRuntimeCwd}' was overridden to project workspace '${selectedProjectWorkspace}' for assigned work.`
      );
    }
    return {
      source: "project_workspace",
      warnings,
      runtime: {
        ...runtime,
        cwd: selectedProjectWorkspace
      }
    };
  }

  if (projectIds.length > 0) {
    warnings.push("Assigned project has no local workspace path configured. Falling back to agent workspace.");
  }

  if (hasText(normalizedRuntimeCwd)) {
    return {
      source: "agent_runtime",
      warnings,
      runtime: {
        ...runtime,
        cwd: normalizedRuntimeCwd
      }
    };
  }

  const fallbackWorkspace = resolveAgentFallbackWorkspace(companyId, agentId);
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

function resolveStaleRunThresholdMs() {
  const parsed = Number(process.env.BOPO_HEARTBEAT_STALE_RUN_MS ?? 10 * 60 * 1000);
  if (!Number.isFinite(parsed) || parsed < 1_000) {
    return 10 * 60 * 1000;
  }
  return parsed;
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
}) {
  const apiBaseUrl = resolveControlPlaneApiBaseUrl();
  const actorPermissions = ["issues:write", "agents:write"].join(",");
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
    BOPODEV_ACTOR_TYPE: "agent",
    BOPODEV_ACTOR_ID: input.agentId,
    BOPODEV_ACTOR_COMPANIES: input.companyId,
    BOPODEV_ACTOR_PERMISSIONS: actorPermissions,
    BOPODEV_REQUEST_HEADERS_JSON: actorHeaders,
    BOPODEV_REQUEST_APPROVAL_DEFAULT: "true",
    BOPODEV_CAN_HIRE_AGENTS: input.canHireAgents ? "true" : "false",
    ...(codexApiKey ? { OPENAI_API_KEY: codexApiKey } : {}),
    ...(claudeApiKey ? { ANTHROPIC_API_KEY: claudeApiKey } : {})
  } satisfies Record<string, string>;
}

function resolveControlPlaneApiBaseUrl() {
  const configured = resolveControlPlaneProcessEnv("API_BASE_URL") ?? process.env.NEXT_PUBLIC_API_URL;
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
    providerType === "opencode"
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
