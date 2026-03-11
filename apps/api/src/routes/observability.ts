import { Router } from "express";
import {
  getHeartbeatRun,
  listAgents,
  listAuditEvents,
  listCostEntries,
  listHeartbeatRunMessages,
  listHeartbeatRuns,
  listPluginRuns
} from "bopodev-db";
import type { AppContext } from "../context";
import { sendError, sendOk } from "../http";
import { requireCompanyScope } from "../middleware/company-scope";
import { listAgentMemoryFiles, readAgentMemoryFile } from "../services/memory-file-service";

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
          const outcome = details?.outcome ?? null;
          return {
            ...serializeRunRow(run, outcome),
            outcome
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
      run: serializeRunRow(run, details?.outcome ?? null),
      details,
      transcript: {
        hasPersistedMessages: transcriptResult.items.length > 0,
        fallbackFromTrace: transcriptResult.items.length === 0 && traceTranscript.length > 0,
        truncated: traceTranscript.length >= 120
      }
    });
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
  outcome: unknown
) {
  const runType = resolveRunType(run, outcome);
  return {
    id: run.id,
    companyId: run.companyId,
    agentId: run.agentId,
    status: run.status,
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
  outcome: unknown
): "work" | "no_assigned_work" | "budget_skip" | "overlap_skip" | "other_skip" | "failed" | "running" {
  if (run.status === "started") {
    return "running";
  }
  if (run.status === "failed") {
    return "failed";
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
  if (isNoAssignedWorkOutcome(outcome)) {
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
