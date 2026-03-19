import { Router } from "express";
import { readFile, stat } from "node:fs/promises";
import { basename, isAbsolute, resolve } from "node:path";
import { z } from "zod";
import {
  getHeartbeatRun,
  listCompanies,
  listAgents,
  listAuditEvents,
  listCostEntries,
  listGoals,
  listHeartbeatRunMessages,
  listHeartbeatRuns,
  listModelPricing,
  listPluginRuns,
  upsertModelPricing
} from "bopodev-db";
import type { AppContext } from "../context";
import { sendError, sendOk } from "../http";
import { isInsidePath, resolveCompanyWorkspaceRootPath } from "../lib/instance-paths";
import { requireCompanyScope } from "../middleware/company-scope";
import { requirePermission } from "../middleware/request-actor";
import { listAgentMemoryFiles, loadAgentMemoryContext, readAgentMemoryFile } from "../services/memory-file-service";

export function createObservabilityRouter(ctx: AppContext) {
  const router = Router();
  router.use(requireCompanyScope);

  router.get("/logs", async (req, res) => {
    const rows = await listAuditEvents(ctx.db, req.companyId!);
    return sendOk(
      res,
      rows.map((row) => ({
        ...row,
        payload: parsePayload(row.payloadJson)
      }))
    );
  });

  router.get("/costs", async (req, res) => {
    const rows = await listCostEntries(ctx.db, req.companyId!);
    return sendOk(
      res,
      rows.map((row) => ({
        ...row,
        usdCost: typeof row.usdCost === "number" ? row.usdCost : Number(row.usdCost ?? 0)
      }))
    );
  });

  const modelPricingUpdateSchema = z.object({
    providerType: z.string().min(1),
    modelId: z.string().min(1),
    displayName: z.string().min(1).optional(),
    inputUsdPer1M: z.number().min(0),
    outputUsdPer1M: z.number().min(0),
    currency: z.string().min(1).optional()
  });

  router.get("/models/pricing", async (req, res) => {
    const rows = await listModelPricing(ctx.db, req.companyId!);
    return sendOk(
      res,
      rows.map((row) => ({
        companyId: row.companyId,
        providerType: row.providerType,
        modelId: row.modelId,
        displayName: row.displayName,
        inputUsdPer1M: typeof row.inputUsdPer1M === "number" ? row.inputUsdPer1M : Number(row.inputUsdPer1M ?? 0),
        outputUsdPer1M: typeof row.outputUsdPer1M === "number" ? row.outputUsdPer1M : Number(row.outputUsdPer1M ?? 0),
        currency: row.currency,
        updatedAt: row.updatedAt?.toISOString?.() ?? null,
        updatedBy: row.updatedBy ?? null
      }))
    );
  });

  router.put("/models/pricing", async (req, res) => {
    requirePermission("observability:write")(req, res, () => {});
    if (res.headersSent) {
      return;
    }
    const parsed = modelPricingUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(res, parsed.error.message, 422);
    }
    const payload = parsed.data;
    await upsertModelPricing(ctx.db, {
      companyId: req.companyId!,
      providerType: payload.providerType,
      modelId: payload.modelId,
      displayName: payload.displayName ?? null,
      inputUsdPer1M: payload.inputUsdPer1M.toFixed(6),
      outputUsdPer1M: payload.outputUsdPer1M.toFixed(6),
      currency: payload.currency ?? "USD",
      updatedBy: req.actor?.id ?? null
    });
    return sendOk(res, { ok: true });
  });

  router.get("/heartbeats", async (req, res) => {
    const companyId = req.companyId!;
    const rawLimit = Number(req.query.limit ?? 100);
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.floor(rawLimit), 1), 500) : 100;
    const statusFilter = typeof req.query.status === "string" && req.query.status.trim().length > 0 ? req.query.status.trim() : null;
    const agentFilter = typeof req.query.agentId === "string" && req.query.agentId.trim().length > 0 ? req.query.agentId.trim() : null;
    const [runs, auditRows] = await Promise.all([
      listHeartbeatRuns(ctx.db, companyId, limit),
      listAuditEvents(ctx.db, companyId)
    ]);
    const runDetailsByRunId = buildRunDetailsMap(auditRows);
    return sendOk(
      res,
      runs
        .filter((run) => (statusFilter ? run.status === statusFilter : true))
        .filter((run) => (agentFilter ? run.agentId === agentFilter : true))
        .map((run) => {
          const details = runDetailsByRunId.get(run.id);
          const report = toRecord(details?.report);
          const outcome = details?.outcome ?? report?.outcome ?? null;
          return {
            ...serializeRunRow(run, details),
            outcome,
            report: report ?? null
          };
        })
    );
  });

  router.get("/heartbeats/:runId", async (req, res) => {
    const companyId = req.companyId!;
    const runId = req.params.runId;
    const [run, auditRows, transcriptResult] = await Promise.all([
      getHeartbeatRun(ctx.db, companyId, runId),
      listAuditEvents(ctx.db, companyId, 500),
      listHeartbeatRunMessages(ctx.db, { companyId, runId, limit: 20 })
    ]);
    if (!run) {
      return sendError(res, "Run not found", 404);
    }
    const runDetailsByRunId = buildRunDetailsMap(auditRows);
    const details = runDetailsByRunId.get(runId) ?? null;
    const trace = toRecord(details?.trace);
    const traceTranscript = Array.isArray(trace?.transcript) ? trace.transcript : [];
    return sendOk(res, {
      run: serializeRunRow(run, details),
      details,
      transcript: {
        hasPersistedMessages: transcriptResult.items.length > 0,
        fallbackFromTrace: transcriptResult.items.length === 0 && traceTranscript.length > 0,
        truncated: traceTranscript.length >= 120
      }
    });
  });

  router.get("/heartbeats/:runId/artifacts/:artifactIndex/download", async (req, res) => {
    const companyId = req.companyId!;
    const runId = req.params.runId;
    const rawArtifactIndex = Number(req.params.artifactIndex);
    const artifactIndex = Number.isFinite(rawArtifactIndex) ? Math.floor(rawArtifactIndex) : NaN;
    if (!Number.isInteger(artifactIndex) || artifactIndex < 0) {
      return sendError(res, "Artifact index must be a non-negative integer.", 422);
    }
    const [run, auditRows] = await Promise.all([getHeartbeatRun(ctx.db, companyId, runId), listAuditEvents(ctx.db, companyId, 500)]);
    if (!run) {
      return sendError(res, "Run not found", 404);
    }
    const details = buildRunDetailsMap(auditRows).get(runId) ?? null;
    const report = toRecord(details?.report);
    const artifacts = Array.isArray(report?.artifacts)
      ? report.artifacts.filter((entry) => typeof entry === "object" && entry !== null)
      : [];
    const artifact = (artifacts[artifactIndex] ?? null) as Record<string, unknown> | null;
    if (!artifact) {
      return sendError(res, "Artifact not found.", 404);
    }
    const resolvedPath = resolveRunArtifactAbsolutePath(companyId, artifact);
    if (!resolvedPath) {
      return sendError(res, "Artifact path is invalid.", 422);
    }
    let stats: Awaited<ReturnType<typeof stat>>;
    try {
      stats = await stat(resolvedPath);
    } catch {
      return sendError(res, "Artifact not found on disk.", 404);
    }
    if (!stats.isFile()) {
      return sendError(res, "Artifact is not a file.", 422);
    }
    const buffer = await readFile(resolvedPath);
    res.setHeader("content-type", "application/octet-stream");
    res.setHeader("content-disposition", `inline; filename="${encodeURIComponent(basename(resolvedPath))}"`);
    return res.send(buffer);
  });

  router.get("/heartbeats/:runId/messages", async (req, res) => {
    const companyId = req.companyId!;
    const runId = req.params.runId;
    const rawLimit = Number(req.query.limit ?? 200);
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.floor(rawLimit), 1), 500) : 200;
    const afterRaw = typeof req.query.cursor === "string" ? Number(req.query.cursor) : NaN;
    const afterSequence = Number.isFinite(afterRaw) ? Math.floor(afterRaw) : undefined;
    const signalOnly = req.query.signalOnly !== "false";
    const requestedKinds =
      typeof req.query.kinds === "string"
        ? req.query.kinds
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean)
        : [];
    const allowedKinds = new Set(["system", "assistant", "thinking", "tool_call", "tool_result", "result", "stderr"]);
    const kindFilter = requestedKinds.filter((kind) => allowedKinds.has(kind));
    const [run, result] = await Promise.all([
      getHeartbeatRun(ctx.db, companyId, runId),
      listHeartbeatRunMessages(ctx.db, { companyId, runId, limit, afterSequence })
    ]);
    if (!run) {
      return sendError(res, "Run not found", 404);
    }
    const filteredItems = result.items
      .filter((message) => (kindFilter.length > 0 ? kindFilter.includes(message.kind) : true))
      .filter((message) => {
        if (!signalOnly) {
          return true;
        }
        if (message.kind === "tool_call" || message.kind === "tool_result" || message.kind === "result") {
          return true;
        }
        return message.signalLevel === "high" || message.signalLevel === "medium";
      });
    const derivedItems = deriveRelevantMessagesFromRawTranscript(result.items, run, kindFilter, signalOnly);
    const responseItems = [...filteredItems, ...derivedItems]
      .sort((a, b) => a.sequence - b.sequence)
      .filter((message, index, array) => {
        const previous = array[index - 1];
        if (!previous) {
          return true;
        }
        return !(
          previous.kind === message.kind &&
          previous.text === message.text &&
          previous.label === message.label &&
          previous.sequence === message.sequence
        );
      });
    return sendOk(res, {
      runId,
      items: responseItems.map((message) => ({
        id: message.id,
        companyId: message.companyId,
        runId: message.runId,
        sequence: message.sequence,
        kind: message.kind,
        label: message.label,
        text: message.text,
        payload: message.payloadJson,
        signalLevel: message.signalLevel ?? undefined,
        groupKey: message.groupKey,
        source: message.source ?? undefined,
        createdAt: message.createdAt.toISOString()
      })),
      nextCursor: result.nextCursor
    });
  });

  router.get("/memory", async (req, res) => {
    const companyId = req.companyId!;
    const agentIdFilter = typeof req.query.agentId === "string" && req.query.agentId.trim() ? req.query.agentId.trim() : null;
    const rawLimit = Number(req.query.limit ?? 100);
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.floor(rawLimit), 1), 500) : 100;
    const agents = await listAgents(ctx.db, companyId);
    const targetAgents = agentIdFilter ? agents.filter((agent) => agent.id === agentIdFilter) : agents;
    const fileRows = await Promise.all(
      targetAgents.map(async (agent) => ({
        agentId: agent.id,
        files: await listAgentMemoryFiles({
          companyId,
          agentId: agent.id,
          maxFiles: limit
        })
      }))
    );
    const flattened = fileRows
      .flatMap((row) =>
        row.files.map((file) => ({
          agentId: row.agentId,
          relativePath: file.relativePath,
          path: file.path
        }))
      )
      .slice(0, limit);
    return sendOk(res, {
      items: flattened
    });
  });

  router.get("/memory/:agentId/file", async (req, res) => {
    const companyId = req.companyId!;
    const agentId = req.params.agentId;
    const relativePath = typeof req.query.path === "string" ? req.query.path.trim() : "";
    if (!relativePath) {
      return sendError(res, "Query parameter 'path' is required.", 422);
    }
    try {
      const file = await readAgentMemoryFile({
        companyId,
        agentId,
        relativePath
      });
      return sendOk(res, file);
    } catch (error) {
      return sendError(res, String(error), 422);
    }
  });

  router.get("/memory/:agentId/context-preview", async (req, res) => {
    const companyId = req.companyId!;
    const agentId = req.params.agentId;
    const projectIds = typeof req.query.projectIds === "string"
      ? req.query.projectIds
          .split(",")
          .map((entry) => entry.trim())
          .filter(Boolean)
      : [];
    const queryText = typeof req.query.query === "string" ? req.query.query.trim() : "";
    const [agents, goals, companies] = await Promise.all([
      listAgents(ctx.db, companyId),
      listGoals(ctx.db, companyId),
      listCompanies(ctx.db)
    ]);
    const agent = agents.find((entry) => entry.id === agentId);
    if (!agent) {
      return sendError(res, "Agent not found", 404);
    }
    const company = companies.find((entry) => entry.id === companyId);
    const memoryContext = await loadAgentMemoryContext({
      companyId,
      agentId,
      projectIds,
      queryText: queryText.length > 0 ? queryText : undefined
    });
    const activeCompanyGoals = goals
      .filter((goal) => goal.status === "active" && goal.level === "company")
      .map((goal) => goal.title);
    const activeProjectGoals = goals
      .filter((goal) => goal.status === "active" && goal.level === "project" && goal.projectId && projectIds.includes(goal.projectId))
      .map((goal) => goal.title);
    const activeAgentGoals = goals
      .filter((goal) => goal.status === "active" && goal.level === "agent")
      .map((goal) => goal.title);
    const compiledPreview = [
      `Agent: ${agent.name} (${agent.role})`,
      `Company mission: ${company?.mission ?? "No mission set"}`,
      `Company goals: ${activeCompanyGoals.length > 0 ? activeCompanyGoals.join(" | ") : "None"}`,
      `Project goals: ${activeProjectGoals.length > 0 ? activeProjectGoals.join(" | ") : "None"}`,
      `Agent goals: ${activeAgentGoals.length > 0 ? activeAgentGoals.join(" | ") : "None"}`,
      `Tacit notes: ${memoryContext.tacitNotes ?? "None"}`,
      `Durable facts: ${memoryContext.durableFacts.join(" | ") || "None"}`,
      `Daily notes: ${memoryContext.dailyNotes.join(" | ") || "None"}`
    ].join("\n");
    return sendOk(res, {
      agentId,
      projectIds,
      companyMission: company?.mission ?? null,
      goalContext: {
        companyGoals: activeCompanyGoals,
        projectGoals: activeProjectGoals,
        agentGoals: activeAgentGoals
      },
      memoryContext,
      compiledPreview
    });
  });

  router.get("/plugins/runs", async (req, res) => {
    const companyId = req.companyId!;
    const pluginId = typeof req.query.pluginId === "string" && req.query.pluginId.trim() ? req.query.pluginId.trim() : undefined;
    const runId = typeof req.query.runId === "string" && req.query.runId.trim() ? req.query.runId.trim() : undefined;
    const rawLimit = Number(req.query.limit ?? 200);
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.floor(rawLimit), 1), 1000) : 200;
    const rows = await listPluginRuns(ctx.db, { companyId, pluginId, runId, limit });
    return sendOk(
      res,
      rows.map((row) => ({
        ...row,
        diagnostics: parsePayload(row.diagnosticsJson)
      }))
    );
  });

  return router;
}

function parsePayload(payloadJson: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(payloadJson) as unknown;
    return toRecord(parsed) ?? {};
  } catch {
    return {};
  }
}

function toRecord(value: unknown) {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function resolveRunArtifactAbsolutePath(companyId: string, artifact: Record<string, unknown>) {
  const companyWorkspaceRoot = resolveCompanyWorkspaceRootPath(companyId);
  const absolutePathRaw = normalizeAbsoluteArtifactPath(
    typeof artifact.absolutePath === "string" ? artifact.absolutePath.trim() : ""
  );
  const relativePathRaw = normalizeWorkspaceRelativeArtifactPath(
    typeof artifact.relativePath === "string"
      ? artifact.relativePath.trim()
      : typeof artifact.path === "string"
        ? artifact.path.trim()
        : "",
    companyId
  );
  const candidate = relativePathRaw
    ? resolve(companyWorkspaceRoot, relativePathRaw)
    : absolutePathRaw
      ? absolutePathRaw
      : "";
  if (!candidate) {
    return null;
  }
  const resolved = isAbsolute(candidate) ? resolve(candidate) : resolve(companyWorkspaceRoot, candidate);
  if (!isInsidePath(companyWorkspaceRoot, resolved)) {
    return null;
  }
  return resolved;
}

function normalizeAbsoluteArtifactPath(value: string) {
  const trimmed = value.trim();
  if (!trimmed || !isAbsolute(trimmed)) {
    return "";
  }
  return resolve(trimmed);
}

function normalizeWorkspaceRelativeArtifactPath(value: string, companyId: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  const unixSeparated = trimmed.replace(/\\/g, "/");
  if (isAbsolute(unixSeparated)) {
    return "";
  }
  const parts: string[] = [];
  for (const part of unixSeparated.split("/")) {
    if (!part || part === ".") {
      continue;
    }
    if (part === "..") {
      if (parts.length > 0 && parts[parts.length - 1] !== "..") {
        parts.pop();
      } else {
        parts.push(part);
      }
      continue;
    }
    parts.push(part);
  }
  const normalized = parts.join("/");
  if (!normalized) {
    return "";
  }
  const workspaceScopedMatch = normalized.match(/(?:^|\/)workspace\/([^/]+)\/(.+)$/);
  if (!workspaceScopedMatch) {
    return normalized;
  }
  const scopedCompanyId = workspaceScopedMatch[1];
  const scopedRelativePath = workspaceScopedMatch[2];
  if (!scopedCompanyId || !scopedRelativePath) {
    return "";
  }
  if (scopedCompanyId !== companyId) {
    return "";
  }
  return scopedRelativePath;
}

function serializeRunRow(
  run: {
  id: string;
  companyId: string;
  agentId: string;
  status: string;
  startedAt: Date;
  finishedAt: Date | null;
  message: string | null;
  },
  details: Record<string, unknown> | null | undefined
) {
  const runType = resolveRunType(run, details);
  const report = toRecord(details?.report);
  const publicStatusRaw = typeof report?.finalStatus === "string" ? report.finalStatus : null;
  const publicStatus =
    publicStatusRaw === "completed" || publicStatusRaw === "failed"
      ? publicStatusRaw
      : run.status === "started"
        ? "started"
        : run.status === "failed"
          ? "failed"
          : run.status === "completed"
            ? "completed"
            : "failed";
  return {
    id: run.id,
    companyId: run.companyId,
    agentId: run.agentId,
    status: run.status,
    publicStatus,
    startedAt: run.startedAt.toISOString(),
    finishedAt: run.finishedAt?.toISOString() ?? null,
    message: run.message ?? null,
    runType
  };
}

function resolveRunType(
  run: {
    status: string;
    message: string | null;
  },
  details: Record<string, unknown> | null | undefined
): "work" | "no_assigned_work" | "budget_skip" | "overlap_skip" | "other_skip" | "failed" | "running" {
  if (run.status === "started") {
    return "running";
  }
  const report = toRecord(details?.report);
  const completionReason = typeof report?.completionReason === "string" ? report.completionReason : null;
  if (run.status === "failed" || completionReason === "runtime_error" || completionReason === "provider_unavailable") {
    return "failed";
  }
  if (completionReason === "no_assigned_work") {
    return "no_assigned_work";
  }
  if (completionReason === "budget_hard_stop") {
    return "budget_skip";
  }
  if (completionReason === "overlap_in_progress") {
    return "overlap_skip";
  }
  const normalizedMessage = (run.message ?? "").toLowerCase();
  if (normalizedMessage.includes("already in progress")) {
    return "overlap_skip";
  }
  if (normalizedMessage.includes("budget hard-stop")) {
    return "budget_skip";
  }
  if (isNoAssignedWorkMessage(run.message)) {
    return "no_assigned_work";
  }
  if (isNoAssignedWorkOutcome(details?.outcome)) {
    return "no_assigned_work";
  }
  if (run.status === "skipped") {
    return "other_skip";
  }
  return "work";
}

function isNoAssignedWorkMessage(message: string | null) {
  return /\bno assigned work found\b/i.test(message ?? "");
}

function isNoAssignedWorkOutcome(outcome: unknown) {
  const record = toRecord(outcome);
  if (!record) {
    return false;
  }
  if (record.kind !== "skipped") {
    return false;
  }
  const issueIdsTouched = Array.isArray(record.issueIdsTouched)
    ? record.issueIdsTouched.filter((value) => typeof value === "string")
    : [];
  if (issueIdsTouched.length === 0) {
    return true;
  }
  const actions = Array.isArray(record.actions)
    ? record.actions.filter((value) => typeof value === "object" && value !== null)
    : [];
  return actions.some((action) => {
    const parsed = action as Record<string, unknown>;
    return parsed.type === "heartbeat.skip";
  });
}

function buildRunDetailsMap(
  auditRows: Array<{
    entityType: string;
    eventType: string;
    entityId: string;
    payloadJson: string;
    createdAt: Date;
  }>
) {
  const detailsByRunId = new Map<string, Record<string, unknown>>();
  const relevantRows = auditRows
    .filter(
      (row) =>
        row.entityType === "heartbeat_run" &&
        (row.eventType === "heartbeat.completed" || row.eventType === "heartbeat.failed")
    )
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  for (const row of relevantRows) {
    if (detailsByRunId.has(row.entityId)) {
      continue;
    }
    detailsByRunId.set(row.entityId, parsePayload(row.payloadJson));
  }
  return detailsByRunId;
}

function deriveRelevantMessagesFromRawTranscript(
  items: Array<{
    id: string;
    companyId: string;
    runId: string;
    sequence: number;
    kind: string;
    label: string | null;
    text: string | null;
    payloadJson: string | null;
    signalLevel: string | null;
    groupKey: string | null;
    source: string | null;
    createdAt: Date;
  }>,
  run: {
    id: string;
    companyId: string;
    status: string;
    message: string | null;
    finishedAt: Date | null;
  },
  kindFilter: string[],
  signalOnly: boolean
) {
  const derived: Array<{
    id: string;
    companyId: string;
    runId: string;
    sequence: number;
    kind: "assistant" | "tool_call" | "tool_result" | "result";
    label: string | null;
    text: string | null;
    payloadJson: string | null;
    signalLevel: "high" | "medium";
    groupKey: string | null;
    source: "stderr";
    createdAt: Date;
  }> = [];

  let inPromptBlock = true;
  let assistantAfterCodex = false;
  let pendingTool:
    | {
        sequence: number;
        createdAt: Date;
        command: string;
      }
    | undefined;
  let pendingResult:
    | {
        sequence: number;
        createdAt: Date;
        command: string;
        statusLine: string;
        output: string[];
      }
    | undefined;

  const flushPendingResult = () => {
    if (!pendingResult) {
      return;
    }
    const body = [pendingResult.statusLine, ...(pendingResult.output.length > 0 ? ["", ...pendingResult.output] : [])]
      .join("\n")
      .trim();
    derived.push({
      id: `derived-${run.id}-${pendingResult.sequence}-result`,
      companyId: run.companyId,
      runId: run.id,
      sequence: pendingResult.sequence * 10 + 1,
      kind: "tool_result",
      label: pendingResult.command,
      text: body || pendingResult.command,
      payloadJson: null,
      signalLevel: "high",
      groupKey: `tool:${pendingResult.command}`,
      source: "stderr",
      createdAt: pendingResult.createdAt
    });
    pendingResult = undefined;
  };

  for (const item of items) {
    const text = (item.text ?? "").trim();
    if (!text) {
      continue;
    }
    if (inPromptBlock) {
      if (text === "mcp startup: no servers" || text === "codex") {
        inPromptBlock = false;
      } else {
        continue;
      }
    }

    if (text === "codex") {
      flushPendingResult();
      assistantAfterCodex = true;
      continue;
    }
    if (text === "exec") {
      flushPendingResult();
      assistantAfterCodex = false;
      continue;
    }

    const inlineCommandMatch = /^(\/bin\/.+?) in .+? (succeeded|failed|exited .+?):$/i.exec(text);
    if (inlineCommandMatch) {
      const command = inlineCommandMatch[1]!.trim();
      derived.push({
        id: `derived-${run.id}-${item.sequence}-call`,
        companyId: run.companyId,
        runId: run.id,
        sequence: item.sequence * 10,
        kind: "tool_call",
        label: "command_execution",
        text: command,
        payloadJson: JSON.stringify({ command }),
        signalLevel: "high",
        groupKey: `tool:${command}`,
        source: "stderr",
        createdAt: item.createdAt
      });
      pendingResult = {
        sequence: item.sequence,
        createdAt: item.createdAt,
        command,
        statusLine: text.slice(command.length).trim(),
        output: []
      };
      assistantAfterCodex = false;
      continue;
    }

    if (text.startsWith("/bin/")) {
      flushPendingResult();
      pendingTool = {
        sequence: item.sequence,
        createdAt: item.createdAt,
        command: text
      };
      derived.push({
        id: `derived-${run.id}-${item.sequence}-call`,
        companyId: run.companyId,
        runId: run.id,
        sequence: item.sequence * 10,
        kind: "tool_call",
        label: "command_execution",
        text,
        payloadJson: JSON.stringify({ command: text }),
        signalLevel: "high",
        groupKey: `tool:${text}`,
        source: "stderr",
        createdAt: item.createdAt
      });
      assistantAfterCodex = false;
      continue;
    }

    if (/^(succeeded in \d+ms:|failed in \d+ms:|exited \d+ in \d+ms:)$/i.test(text) && pendingTool) {
      pendingResult = {
        sequence: pendingTool.sequence,
        createdAt: pendingTool.createdAt,
        command: pendingTool.command,
        statusLine: text,
        output: []
      };
      pendingTool = undefined;
      continue;
    }

    if (pendingResult) {
      if (text === "---" || text === "--------") {
        continue;
      }
      pendingResult.output.push(text);
      continue;
    }

    if (assistantAfterCodex && looksLikeUsefulAssistantText(text)) {
      derived.push({
        id: `derived-${run.id}-${item.sequence}-assistant`,
        companyId: run.companyId,
        runId: run.id,
        sequence: item.sequence * 10,
        kind: "assistant",
        label: null,
        text,
        payloadJson: null,
        signalLevel: "medium",
        groupKey: "assistant",
        source: "stderr",
        createdAt: item.createdAt
      });
      assistantAfterCodex = false;
    }
  }

  flushPendingResult();

  const runMessage = run.message?.trim();
  const shouldAppendRunSummary = Boolean(runMessage) && run.status !== "started";
  if (!derived.some((item) => item.kind === "result") && shouldAppendRunSummary && runMessage) {
    derived.push({
      id: `derived-${run.id}-final-result`,
      companyId: run.companyId,
      runId: run.id,
      sequence: (items[items.length - 1]?.sequence ?? 0) * 10 + 9,
      kind: "result",
      label: null,
      text: runMessage,
      payloadJson: null,
      signalLevel: "high",
      groupKey: "result",
      source: "stderr",
      createdAt: run.finishedAt ?? items[items.length - 1]?.createdAt ?? new Date()
    });
  }

  return derived
    .filter((item) => (kindFilter.length > 0 ? kindFilter.includes(item.kind) : true))
    .filter(() => (signalOnly ? true : true));
}

function looksLikeUsefulAssistantText(text: string) {
  const normalized = text.toLowerCase();
  if (normalized.length > 320) {
    return false;
  }
  return (
    normalized.includes("i’m ") ||
    normalized.includes("i'm ") ||
    normalized.includes("next i") ||
    normalized.includes("using `") ||
    normalized.includes("switching to") ||
    normalized.includes("the workspace already") ||
    normalized.includes("i have the") ||
    normalized.includes("i still need") ||
    normalized.includes("restoring")
  );
}
