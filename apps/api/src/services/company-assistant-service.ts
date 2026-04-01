import type { BopoDb } from "bopodev-db";
import {
  aggregateCompanyCostLedgerAllTime,
  aggregateCompanyCostLedgerInRange,
  appendAuditEvent,
  appendCost,
  getCompany,
  getIssue,
  listAgents,
  listApprovalRequests,
  listAuditEvents,
  listCostEntries,
  listGoals,
  listHeartbeatRuns,
  listIssueComments,
  listIssueGoalIdsBatch,
  listIssues,
  listProjectWorkspaces,
  listProjects,
  getAssistantThreadById,
  getOrCreateAssistantThread,
  insertAssistantMessage,
  listAssistantMessages
} from "bopodev-db";
import {
  listAgentOperatingMarkdownFiles,
  readAgentOperatingFile
} from "./agent-operating-file-service";
import {
  listAgentMemoryFiles,
  listCompanyMemoryFiles,
  listProjectMemoryFiles,
  loadAgentMemoryContext,
  readAgentMemoryFile,
  readCompanyMemoryFile,
  readProjectMemoryFile
} from "./memory-file-service";
import { getWorkLoop, listWorkLoops } from "./work-loop-service/work-loop-service";
import {
  runAssistantWithTools,
  type AssistantToolDefinition,
  type AssistantChatMessage
} from "./company-assistant-llm";
import { calculateModelPricedUsdCost } from "./model-pricing";
import { type AskCliBrainId, isAskCliBrain, parseAskBrain } from "./company-assistant-brain";
import { runCompanyAssistantBrainCliTurn } from "./company-assistant-cli";
import type { DirectApiProvider } from "bopodev-agent-sdk";

const MAX_TOOL_JSON_CHARS = 48_000;
const DEFAULT_MAX_TOOL_ROUNDS = 8;
const DEFAULT_TIMEOUT_MS = 120_000;

/** `cost_ledger.cost_category` for owner-assistant API turns */
const COMPANY_ASSISTANT_COST_CATEGORY = "company_assistant";

/**
 * One cost_ledger row per assistant reply: API rows include metered tokens/USD when the provider
 * reports usage; CLI rows and zero-usage API rows still append so Costs / By chats can attribute
 * turns to threads (USD may be $0).
 */
async function recordCompanyAssistantTurnLedger(input: {
  db: BopoDb;
  companyId: string;
  threadId: string;
  assistantMessageId: string;
  mode: "api" | "cli";
  /** `anthropic_api` / `openai_api` for API; codex / cursor / … for CLI */
  brain: string;
  runtimeModelId: string | null;
  tokenInput: number;
  tokenOutput: number;
  /** CLI: parsed from runtime `parsedUsage` when the adapter reports it */
  runtimeUsdCost?: number;
}) {
  const base = {
    companyId: input.companyId,
    runId: null as string | null,
    costCategory: COMPANY_ASSISTANT_COST_CATEGORY,
    assistantThreadId: input.threadId,
    assistantMessageId: input.assistantMessageId,
    providerType: input.brain
  };

  if (input.mode === "cli") {
    const ti = Math.max(0, Math.floor(input.tokenInput));
    const to = Math.max(0, Math.floor(input.tokenOutput));
    const runtimeUsd = Math.max(0, Number(input.runtimeUsdCost ?? 0) || 0);
    const hasMetered = ti > 0 || to > 0 || runtimeUsd > 0;
    if (!hasMetered) {
      await appendCost(input.db, {
        ...base,
        runtimeModelId: null,
        pricingProviderType: null,
        pricingModelId: null,
        pricingSource: null,
        usdCostStatus: "unknown" as const,
        tokenInput: 0,
        tokenOutput: 0,
        usdCost: "0.000000"
      });
      return;
    }
    const usdCostStatus: "exact" | "estimated" | "unknown" =
      runtimeUsd > 0 ? "exact" : ti > 0 || to > 0 ? "unknown" : "unknown";
    await appendCost(input.db, {
      ...base,
      runtimeModelId: null,
      pricingProviderType: null,
      pricingModelId: null,
      pricingSource: runtimeUsd > 0 ? ("exact" as const) : null,
      usdCostStatus,
      tokenInput: ti,
      tokenOutput: to,
      usdCost: runtimeUsd > 0 ? runtimeUsd.toFixed(6) : "0.000000"
    });
    return;
  }

  const modelId = input.runtimeModelId?.trim() || null;
  const isDirectApi = input.brain === "anthropic_api" || input.brain === "openai_api";
  const hasTokenUsage = input.tokenInput > 0 || input.tokenOutput > 0;

  if (isDirectApi && hasTokenUsage) {
    const pricingDecision = await calculateModelPricedUsdCost({
      db: input.db,
      companyId: input.companyId,
      providerType: input.brain,
      pricingProviderType: input.brain,
      modelId,
      tokenInput: input.tokenInput,
      tokenOutput: input.tokenOutput
    });
    const pricedUsdCost = Math.max(0, pricingDecision.usdCost);
    const usdCostStatus: "exact" | "estimated" | "unknown" =
      pricedUsdCost > 0 ? "estimated" : "unknown";
    const effectiveUsdCost = usdCostStatus === "estimated" ? pricedUsdCost : 0;
    await appendCost(input.db, {
      ...base,
      runtimeModelId: modelId,
      pricingProviderType: pricingDecision.pricingProviderType,
      pricingModelId: pricingDecision.pricingModelId,
      pricingSource: pricingDecision.pricingSource,
      usdCostStatus,
      tokenInput: input.tokenInput,
      tokenOutput: input.tokenOutput,
      usdCost: effectiveUsdCost.toFixed(6)
    });
    return;
  }

  await appendCost(input.db, {
    ...base,
    runtimeModelId: modelId,
    pricingProviderType: null,
    pricingModelId: null,
    pricingSource: null,
    usdCostStatus: "unknown" as const,
    tokenInput: input.tokenInput,
    tokenOutput: input.tokenOutput,
    usdCost: "0.000000"
  });
}

function capToolOutput(value: unknown): string {
  const raw = typeof value === "string" ? value : JSON.stringify(value);
  if (raw.length <= MAX_TOOL_JSON_CHARS) {
    return raw;
  }
  return `${raw.slice(0, MAX_TOOL_JSON_CHARS)}\n…(truncated)`;
}

function parseJsonArray(raw: string | null | undefined): string[] {
  if (!raw) {
    return [];
  }
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function serializeIssue(row: Record<string, unknown>, goalIds: string[]) {
  return {
    id: row.id,
    projectId: row.projectId,
    parentIssueId: row.parentIssueId ?? null,
    routineId: row.routineId ?? null,
    title: row.title,
    body: row.body ?? null,
    status: row.status,
    priority: row.priority,
    assigneeAgentId: row.assigneeAgentId ?? null,
    labels: parseJsonArray(row.labelsJson as string),
    tags: parseJsonArray(row.tagsJson as string),
    goalIds,
    updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : String(row.updatedAt),
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt)
  };
}

function serializeRoutineRow(row: Record<string, unknown>) {
  return {
    id: row.id,
    projectId: row.projectId,
    title: row.title,
    description: row.description ?? null,
    assigneeAgentId: row.assigneeAgentId,
    status: row.status,
    priority: row.priority,
    goalIds: parseJsonArray(row.goalIdsJson as string),
    updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : String(row.updatedAt)
  };
}

function sanitizeAgentRow(row: Record<string, unknown>) {
  return {
    id: row.id,
    name: row.name,
    role: row.role,
    roleKey: row.roleKey ?? null,
    title: row.title ?? null,
    capabilities: row.capabilities ?? null,
    status: row.status,
    managerAgentId: row.managerAgentId ?? null,
    providerType: row.providerType,
    heartbeatCron: row.heartbeatCron,
    canHireAgents: row.canHireAgents ?? null,
    canAssignAgents: row.canAssignAgents ?? null,
    canCreateIssues: row.canCreateIssues ?? null
  };
}

export const ASSISTANT_TOOLS: AssistantToolDefinition[] = [
  {
    name: "get_company",
    description: "Load the active company name and mission statement.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  },
  {
    name: "list_projects",
    description: "List all projects for the company with status and descriptions.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  },
  {
    name: "get_project",
    description: "Get one project by id, including workspace metadata.",
    inputSchema: {
      type: "object",
      properties: { project_id: { type: "string", description: "Project id" } },
      required: ["project_id"],
      additionalProperties: false
    }
  },
  {
    name: "list_issues",
    description: "List issues with optional filters. Prefer small limits. Sorted by most recently updated.",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", description: "Optional: todo|in_progress|blocked|in_review|done|canceled" },
        project_id: { type: "string" },
        limit: { type: "number", description: "Max rows, default 30, max 100" }
      },
      additionalProperties: false
    }
  },
  {
    name: "get_issue",
    description: "Load full issue detail including description and linked goal ids.",
    inputSchema: {
      type: "object",
      properties: { issue_id: { type: "string" } },
      required: ["issue_id"],
      additionalProperties: false
    }
  },
  {
    name: "list_issue_comments",
    description: "List recent comments on an issue (newest last, capped).",
    inputSchema: {
      type: "object",
      properties: {
        issue_id: { type: "string" },
        limit: { type: "number", description: "Default 25, max 50" }
      },
      required: ["issue_id"],
      additionalProperties: false
    }
  },
  {
    name: "list_goals",
    description: "List goals for the company.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  },
  {
    name: "get_goal",
    description: "Get a single goal by id.",
    inputSchema: {
      type: "object",
      properties: { goal_id: { type: "string" } },
      required: ["goal_id"],
      additionalProperties: false
    }
  },
  {
    name: "list_routines",
    description: "List recurring routines (scheduled work that opens issues per run).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  },
  {
    name: "get_routine",
    description: "Get one routine by id.",
    inputSchema: {
      type: "object",
      properties: { routine_id: { type: "string" } },
      required: ["routine_id"],
      additionalProperties: false
    }
  },
  {
    name: "list_agents",
    description: "List agents (directory fields only, no secrets).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  },
  {
    name: "get_agent",
    description: "Get one agent directory profile (no runtime secrets).",
    inputSchema: {
      type: "object",
      properties: { agent_id: { type: "string" } },
      required: ["agent_id"],
      additionalProperties: false
    }
  },
  {
    name: "list_pending_approvals",
    description: "List pending governance approval requests.",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "number" } },
      additionalProperties: false
    }
  },
  {
    name: "list_recent_heartbeat_runs",
    description: "Recent heartbeat runs with status.",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "number" } },
      additionalProperties: false
    }
  },
  {
    name: "list_cost_entries",
    description:
      "Recent cost ledger rows: token_input, token_output, usd_cost, provider, agent, run/issue links. For **monthly or all-time totals**, prefer **get_cost_usage_summary**.",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "number" } },
      additionalProperties: false
    }
  },
  {
    name: "get_cost_usage_summary",
    description:
      "Exact aggregates from cost_ledger: ledger row count, total input/output tokens, total USD (string, full precision). Use current_month_utc for 'this month' questions (UTC calendar month); all_time for lifetime totals.",
    inputSchema: {
      type: "object",
      properties: {
        period: {
          type: "string",
          enum: ["current_month_utc", "all_time"],
          description: "current_month_utc = entire UTC calendar month containing now; all_time = every row for the company"
        }
      },
      required: ["period"],
      additionalProperties: false
    }
  },
  {
    name: "list_audit_events",
    description: "Recent coarse audit events for the company.",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "number" } },
      additionalProperties: false
    }
  },
  {
    name: "memory_context_preview",
    description:
      "Merged memory context (company + optional projects + agent) as used by heartbeats: tacit notes, durable facts, daily notes. Pass agent_id and optional project_ids.",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: { type: "string" },
        project_ids: {
          type: "array",
          items: { type: "string" },
          description: "Optional project ids to include project memory roots"
        },
        query: { type: "string", description: "Optional keyword hint for fact/note ranking" }
      },
      required: ["agent_id"],
      additionalProperties: false
    }
  },
  {
    name: "list_company_memory_files",
    description: "List files under the company-wide memory directory.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  },
  {
    name: "read_company_memory_file",
    description: "Read a file from company memory by relative path.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false
    }
  },
  {
    name: "list_project_memory_files",
    description: "List memory files for a project.",
    inputSchema: {
      type: "object",
      properties: { project_id: { type: "string" } },
      required: ["project_id"],
      additionalProperties: false
    }
  },
  {
    name: "read_project_memory_file",
    description: "Read a project memory file by relative path.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string" },
        path: { type: "string" }
      },
      required: ["project_id", "path"],
      additionalProperties: false
    }
  },
  {
    name: "list_agent_memory_files",
    description: "List memory files for an agent.",
    inputSchema: {
      type: "object",
      properties: { agent_id: { type: "string" } },
      required: ["agent_id"],
      additionalProperties: false
    }
  },
  {
    name: "read_agent_memory_file",
    description: "Read an agent memory file by relative path.",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: { type: "string" },
        path: { type: "string" }
      },
      required: ["agent_id", "path"],
      additionalProperties: false
    }
  },
  {
    name: "list_agent_operating_files",
    description: "List markdown operating docs for an agent.",
    inputSchema: {
      type: "object",
      properties: { agent_id: { type: "string" } },
      required: ["agent_id"],
      additionalProperties: false
    }
  },
  {
    name: "read_agent_operating_file",
    description: "Read an agent operating markdown file by relative path.",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: { type: "string" },
        path: { type: "string" }
      },
      required: ["agent_id", "path"],
      additionalProperties: false
    }
  }
];

export async function executeAssistantTool(
  db: BopoDb,
  companyId: string,
  name: string,
  args: Record<string, unknown>
): Promise<string> {
  switch (name) {
    case "get_company": {
      const row = await getCompany(db, companyId);
      return capToolOutput(row ? { id: row.id, name: row.name, mission: row.mission ?? null } : { error: "not_found" });
    }
    case "list_projects": {
      const rows = await listProjects(db, companyId);
      return capToolOutput(
        rows.map((p) => ({
          id: p.id,
          name: p.name,
          status: p.status,
          description: p.description ?? null
        }))
      );
    }
    case "get_project": {
      const projectId = String(args.project_id ?? "").trim();
      const rows = await listProjects(db, companyId);
      const p = rows.find((r) => r.id === projectId);
      if (!p) {
        return capToolOutput({ error: "project_not_found" });
      }
      const workspaces = await listProjectWorkspaces(db, companyId, projectId);
      return capToolOutput({
        ...p,
        workspaces: workspaces.map((w) => ({
          id: w.id,
          name: w.name,
          cwd: w.cwd ?? null,
          repoUrl: w.repoUrl ?? null,
          isPrimary: w.isPrimary
        }))
      });
    }
    case "list_issues": {
      const status = typeof args.status === "string" ? args.status.trim() : "";
      const projectId = typeof args.project_id === "string" ? args.project_id.trim() : "";
      let limit = typeof args.limit === "number" && Number.isFinite(args.limit) ? Math.floor(args.limit) : 30;
      limit = Math.min(100, Math.max(1, limit));
      const rows = await listIssues(db, companyId, projectId || undefined);
      const filtered = rows
        .filter((r) => !status || String(r.status) === status)
        .slice(0, limit);
      const goalMap = await listIssueGoalIdsBatch(
        db,
        companyId,
        filtered.map((r) => r.id)
      );
      return capToolOutput(
        filtered.map((r) => serializeIssue(r as unknown as Record<string, unknown>, goalMap.get(r.id) ?? []))
      );
    }
    case "get_issue": {
      const issueId = String(args.issue_id ?? "").trim();
      const row = await getIssue(db, companyId, issueId);
      if (!row) {
        return capToolOutput({ error: "issue_not_found" });
      }
      const goalMap = await listIssueGoalIdsBatch(db, companyId, [issueId]);
      return capToolOutput(serializeIssue(row as unknown as Record<string, unknown>, goalMap.get(issueId) ?? []));
    }
    case "list_issue_comments": {
      const issueId = String(args.issue_id ?? "").trim();
      let lim = typeof args.limit === "number" ? Math.floor(args.limit) : 25;
      lim = Math.min(50, Math.max(1, lim));
      const comments = await listIssueComments(db, companyId, issueId);
      const slice = comments.slice(-lim).map((c) => ({
        id: c.id,
        authorType: c.authorType,
        authorId: c.authorId,
        body: c.body,
        createdAt:
          c.createdAt && typeof (c.createdAt as { toISOString?: () => string }).toISOString === "function"
            ? (c.createdAt as Date).toISOString()
            : String(c.createdAt)
      }));
      return capToolOutput(slice);
    }
    case "list_goals": {
      const goals = await listGoals(db, companyId);
      return capToolOutput(
        goals.map((g) => ({
          id: g.id,
          title: g.title,
          status: g.status,
          level: g.level,
          projectId: g.projectId ?? null,
          description: g.description ?? null
        }))
      );
    }
    case "get_goal": {
      const goalId = String(args.goal_id ?? "").trim();
      const goals = await listGoals(db, companyId);
      const g = goals.find((x) => x.id === goalId);
      return capToolOutput(g ?? { error: "goal_not_found" });
    }
    case "list_routines": {
      const loops = await listWorkLoops(db, companyId);
      return capToolOutput(loops.map((l) => serializeRoutineRow(l as unknown as Record<string, unknown>)));
    }
    case "get_routine": {
      const routineId = String(args.routine_id ?? "").trim();
      const row = await getWorkLoop(db, companyId, routineId);
      return capToolOutput(row ? serializeRoutineRow(row as unknown as Record<string, unknown>) : { error: "routine_not_found" });
    }
    case "list_agents": {
      const agents = await listAgents(db, companyId);
      return capToolOutput(agents.map((a) => sanitizeAgentRow(a as unknown as Record<string, unknown>)));
    }
    case "get_agent": {
      const agentId = String(args.agent_id ?? "").trim();
      const agents = await listAgents(db, companyId);
      const a = agents.find((x) => x.id === agentId);
      return capToolOutput(a ? sanitizeAgentRow(a as unknown as Record<string, unknown>) : { error: "agent_not_found" });
    }
    case "list_pending_approvals": {
      let lim = typeof args.limit === "number" ? Math.floor(args.limit) : 30;
      lim = Math.min(50, Math.max(1, lim));
      const rows = await listApprovalRequests(db, companyId);
      const pending = rows.filter((r) => r.status === "pending").slice(0, lim);
      return capToolOutput(
        pending.map((r) => ({
          id: r.id,
          action: r.action,
          status: r.status,
          createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : String(r.createdAt)
        }))
      );
    }
    case "list_recent_heartbeat_runs": {
      let lim = typeof args.limit === "number" ? Math.floor(args.limit) : 20;
      lim = Math.min(50, Math.max(1, lim));
      const runs = await listHeartbeatRuns(db, companyId, lim);
      return capToolOutput(
        runs.map((r) => ({
          id: r.id,
          agentId: r.agentId,
          status: r.status,
          startedAt: r.startedAt instanceof Date ? r.startedAt.toISOString() : String(r.startedAt),
          finishedAt: r.finishedAt ? (r.finishedAt instanceof Date ? r.finishedAt.toISOString() : String(r.finishedAt)) : null
        }))
      );
    }
    case "list_cost_entries": {
      let lim = typeof args.limit === "number" ? Math.floor(args.limit) : 30;
      lim = Math.min(100, Math.max(1, lim));
      const rows = await listCostEntries(db, companyId, lim);
      return capToolOutput(rows);
    }
    case "get_cost_usage_summary": {
      const period = String(args.period ?? "").trim();
      if (period === "current_month_utc") {
        const ref = new Date();
        const y = ref.getUTCFullYear();
        const m0 = ref.getUTCMonth();
        const start = new Date(Date.UTC(y, m0, 1, 0, 0, 0, 0));
        const endExclusive = new Date(Date.UTC(y, m0 + 1, 1, 0, 0, 0, 0));
        const agg = await aggregateCompanyCostLedgerInRange(db, companyId, start, endExclusive);
        return capToolOutput({
          period,
          calendarMonthUtc: `${y}-${String(m0 + 1).padStart(2, "0")}`,
          rangeStartUtcInclusive: start.toISOString(),
          rangeEndUtcExclusive: endExclusive.toISOString(),
          ...agg
        });
      }
      if (period === "all_time") {
        const agg = await aggregateCompanyCostLedgerAllTime(db, companyId);
        return capToolOutput({ period, ...agg });
      }
      return capToolOutput({
        error: "invalid_period",
        allowed: ["current_month_utc", "all_time"]
      });
    }
    case "list_audit_events": {
      let lim = typeof args.limit === "number" ? Math.floor(args.limit) : 25;
      lim = Math.min(100, Math.max(1, lim));
      const rows = await listAuditEvents(db, companyId, lim);
      return capToolOutput(rows);
    }
    case "memory_context_preview": {
      const agentId = String(args.agent_id ?? "").trim();
      const projectIds = Array.isArray(args.project_ids)
        ? (args.project_ids as unknown[]).filter((x): x is string => typeof x === "string")
        : [];
      const queryText = typeof args.query === "string" ? args.query.trim() : "";
      const agents = await listAgents(db, companyId);
      if (!agents.some((a) => a.id === agentId)) {
        return capToolOutput({ error: "agent_not_found" });
      }
      const ctx = await loadAgentMemoryContext({
        companyId,
        agentId,
        projectIds,
        queryText: queryText || undefined
      });
      return capToolOutput({
        memoryRoot: ctx.memoryRoot,
        tacitNotes: ctx.tacitNotes ?? null,
        durableFacts: ctx.durableFacts ?? [],
        dailyNotes: ctx.dailyNotes ?? []
      });
    }
    case "list_company_memory_files": {
      const files = await listCompanyMemoryFiles({ companyId, maxFiles: 200 });
      return capToolOutput(files.map((f) => ({ path: f.relativePath })));
    }
    case "read_company_memory_file": {
      const path = String(args.path ?? "").trim();
      try {
        const file = await readCompanyMemoryFile({ companyId, relativePath: path });
        return capToolOutput({ path: file.relativePath, content: file.content });
      } catch (e) {
        return capToolOutput({ error: String(e) });
      }
    }
    case "list_project_memory_files": {
      const projectId = String(args.project_id ?? "").trim();
      const files = await listProjectMemoryFiles({ companyId, projectId, maxFiles: 200 });
      return capToolOutput(files.map((f) => ({ path: f.relativePath })));
    }
    case "read_project_memory_file": {
      const projectId = String(args.project_id ?? "").trim();
      const path = String(args.path ?? "").trim();
      try {
        const file = await readProjectMemoryFile({ companyId, projectId, relativePath: path });
        return capToolOutput({ path: file.relativePath, content: file.content });
      } catch (e) {
        return capToolOutput({ error: String(e) });
      }
    }
    case "list_agent_memory_files": {
      const agentId = String(args.agent_id ?? "").trim();
      const files = await listAgentMemoryFiles({ companyId, agentId, maxFiles: 200 });
      return capToolOutput(files.map((f) => ({ path: f.relativePath })));
    }
    case "read_agent_memory_file": {
      const agentId = String(args.agent_id ?? "").trim();
      const path = String(args.path ?? "").trim();
      try {
        const file = await readAgentMemoryFile({ companyId, agentId, relativePath: path });
        return capToolOutput({ path: file.relativePath, content: file.content });
      } catch (e) {
        return capToolOutput({ error: String(e) });
      }
    }
    case "list_agent_operating_files": {
      const agentId = String(args.agent_id ?? "").trim();
      const files = await listAgentOperatingMarkdownFiles({ companyId, agentId, maxFiles: 200 });
      return capToolOutput(files.map((f) => ({ path: f.relativePath })));
    }
    case "read_agent_operating_file": {
      const agentId = String(args.agent_id ?? "").trim();
      const path = String(args.path ?? "").trim();
      try {
        const file = await readAgentOperatingFile({ companyId, agentId, relativePath: path });
        return capToolOutput({ path: file.relativePath, content: file.content });
      } catch (e) {
        return capToolOutput({ error: String(e) });
      }
    }
    default:
      return capToolOutput({ error: "unknown_tool", name });
  }
}

export type AssistantCeoPersona = {
  agentId: string | null;
  name: string;
  title: string | null;
  avatarSeed: string;
};

export async function getCompanyCeoPersona(db: BopoDb, companyId: string): Promise<AssistantCeoPersona> {
  const agents = await listAgents(db, companyId);
  const ceo =
    agents.find((a) => String(a.roleKey ?? "").toLowerCase() === "ceo") ??
    agents.find((a) => String(a.role ?? "").toUpperCase() === "CEO");
  if (!ceo) {
    return { agentId: null, name: "CEO", title: null, avatarSeed: "" };
  }
  return {
    agentId: ceo.id,
    name: (ceo.name && String(ceo.name).trim()) || "CEO",
    title: ceo.title ? String(ceo.title).trim() || null : null,
    avatarSeed: (ceo.avatarSeed && String(ceo.avatarSeed).trim()) || ""
  };
}

function ceoPromptDisplayName(persona: AssistantCeoPersona): string {
  if (persona.title?.trim()) {
    return `${persona.name} (${persona.title})`;
  }
  return persona.name;
}

function buildSystemPrompt(companyId: string, companyName: string, persona: AssistantCeoPersona) {
  const who = ceoPromptDisplayName(persona);
  return [
    `You are ${who}, the CEO of ${companyName}. The owner/operator is talking with you in Chat: sound human—warm, direct, plain language, short paragraphs. Use bullet lists only when comparing several items; otherwise prefer flowing prose.`,
    `Scope: this session is fixed to one company (${companyId}). Never claim access to other companies.`,
    "**Answer only what they asked.** Do not volunteer status briefings, metrics, or “here’s what’s going on” summaries—agent activity, approvals, heartbeats, runs, costs, spend, tokens, project/issue inventories, etc.—unless the user clearly asked for that information or a specific fact. If they only greet you (“hi”, “hello”) or make small talk, reply in one or two friendly sentences and offer help; **do not call tools** and do not mention internal numbers or operational state.",
    "**Tools:** Call tools only when the user’s message requires company data you cannot infer from the chat. Use the **narrowest** calls that answer the question (e.g. for **tokens / USD this month or all-time**, **get_cost_usage_summary**; for recent line-level costs, **list_cost_entries**). Use memory/operating file tools only when relevant to the question. If memory conflicts with structured data, prefer structured data and mention the mismatch briefly.",
    "Never paste raw JSON, NDJSON, or internal event logs. When you do cite numbers from tools, keep them proportional to the question—no extra dashboards.",
    "Be concise. If data is missing, say what you could not find.",
    `Active company: ${companyName} (${companyId}).`
  ].join("\n");
}

async function resolveAssistantThreadForTurn(db: BopoDb, companyId: string, threadId: string | null | undefined) {
  const trimmed = threadId?.trim();
  if (trimmed) {
    const row = await getAssistantThreadById(db, companyId, trimmed);
    if (!row) {
      throw new Error("Chat thread not found.");
    }
    return row;
  }
  return getOrCreateAssistantThread(db, companyId);
}

export async function runCompanyAssistantTurn(input: {
  db: BopoDb;
  companyId: string;
  userMessage: string;
  actorType: "human" | "agent" | "system";
  actorId: string;
  /** Adapter id (e.g. anthropic_api, codex). Defaults from BOPO_ASSISTANT_PROVIDER for API. */
  brain?: string | null;
  /** When set, append to this thread; otherwise use latest-or-create for the company. */
  threadId?: string | null;
}): Promise<{
  userMessageId: string;
  assistantMessageId: string;
  assistantBody: string;
  toolRoundCount: number;
  mode: "api" | "cli";
  brain: string;
  threadId: string;
  cliElapsedMs?: number;
}> {
  const company = await getCompany(input.db, input.companyId);
  if (!company) {
    throw new Error("Company not found.");
  }

  const ceoPersona = await getCompanyCeoPersona(input.db, input.companyId);

  const thread = await resolveAssistantThreadForTurn(input.db, input.companyId, input.threadId);
  const userRow = await insertAssistantMessage(input.db, {
    threadId: thread.id,
    companyId: input.companyId,
    role: "user",
    body: input.userMessage
  });

  const prior = await listAssistantMessages(input.db, thread.id, 80);
  const chatHistory: AssistantChatMessage[] = prior
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({ role: m.role as "user" | "assistant", content: m.body }));

  const brain = parseAskBrain(input.brain);
  let text: string;
  let toolRoundCount = 0;
  let mode: "api" | "cli" = "api";
  let cliElapsedMs: number | undefined;
  let cliMetered = { tokenInput: 0, tokenOutput: 0, usdCost: 0 };

  if (isAskCliBrain(brain)) {
    const cli = await runCompanyAssistantBrainCliTurn({
      db: input.db,
      companyId: input.companyId,
      providerType: brain as AskCliBrainId,
      userMessage: input.userMessage,
      ceoDisplayName: ceoPromptDisplayName(ceoPersona)
    });
    text = cli.assistantBody;
    mode = "cli";
    cliElapsedMs = cli.elapsedMs;
    cliMetered = { tokenInput: cli.tokenInput, tokenOutput: cli.tokenOutput, usdCost: cli.usdCost };
  } else {
    const maxRounds = Math.min(
      20,
      Math.max(1, Number(process.env.BOPO_ASSISTANT_MAX_TOOL_ROUNDS) || DEFAULT_MAX_TOOL_ROUNDS)
    );
    const timeoutMs = Math.min(
      300_000,
      Math.max(10_000, Number(process.env.BOPO_ASSISTANT_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS)
    );

    const provider = brain as DirectApiProvider;
    const apiTurn = await runAssistantWithTools({
      provider,
      system: buildSystemPrompt(input.companyId, company.name, ceoPersona),
      chatHistory,
      tools: ASSISTANT_TOOLS,
      executeTool: (name, args) => executeAssistantTool(input.db, input.companyId, name, args),
      maxToolRounds: maxRounds,
      timeoutMs
    });
    text = apiTurn.text;
    toolRoundCount = apiTurn.toolRoundCount;

    const assistantRowApi = await insertAssistantMessage(input.db, {
      threadId: thread.id,
      companyId: input.companyId,
      role: "assistant",
      body: text,
      metadataJson: JSON.stringify({
        mode: "api",
        brain: provider,
        toolRoundCount,
        model: apiTurn.runtimeModelId
      })
    });

    await recordCompanyAssistantTurnLedger({
      db: input.db,
      companyId: input.companyId,
      threadId: thread.id,
      assistantMessageId: assistantRowApi.id,
      mode: "api",
      brain: provider,
      runtimeModelId: apiTurn.runtimeModelId,
      tokenInput: apiTurn.tokenInput,
      tokenOutput: apiTurn.tokenOutput
    });

    await appendAuditEvent(input.db, {
      companyId: input.companyId,
      actorType: input.actorType as "human" | "agent" | "system",
      actorId: input.actorId,
      eventType: "company_assistant.turn",
      entityType: "company_assistant_message",
      entityId: assistantRowApi.id,
      payload: {
        threadId: thread.id,
        userMessageId: userRow.id,
        assistantMessageId: assistantRowApi.id,
        toolRoundCount,
        mode: "api",
        brain: provider
      }
    });

    return {
      userMessageId: userRow.id,
      assistantMessageId: assistantRowApi.id,
      assistantBody: text,
      toolRoundCount,
      mode: "api",
      brain: provider,
      threadId: thread.id
    };
  }

  const assistantRow = await insertAssistantMessage(input.db, {
    threadId: thread.id,
    companyId: input.companyId,
    role: "assistant",
    body: text,
    metadataJson: JSON.stringify({
      mode: "cli",
      brain,
      cliElapsedMs: cliElapsedMs ?? null,
      toolRoundCount: 0
    })
  });

  await recordCompanyAssistantTurnLedger({
    db: input.db,
    companyId: input.companyId,
    threadId: thread.id,
    assistantMessageId: assistantRow.id,
    mode: "cli",
    brain,
    runtimeModelId: null,
    tokenInput: cliMetered.tokenInput,
    tokenOutput: cliMetered.tokenOutput,
    runtimeUsdCost: cliMetered.usdCost
  });

  await appendAuditEvent(input.db, {
    companyId: input.companyId,
    actorType: input.actorType as "human" | "agent" | "system",
    actorId: input.actorId,
    eventType: "company_assistant.turn",
    entityType: "company_assistant_message",
    entityId: assistantRow.id,
    payload: {
      threadId: thread.id,
      userMessageId: userRow.id,
      assistantMessageId: assistantRow.id,
      toolRoundCount: 0,
      mode: "cli",
      brain
    }
  });

  return {
    userMessageId: userRow.id,
    assistantMessageId: assistantRow.id,
    assistantBody: text,
    toolRoundCount: 0,
    mode: "cli",
    brain,
    threadId: thread.id,
    cliElapsedMs
  };
}
