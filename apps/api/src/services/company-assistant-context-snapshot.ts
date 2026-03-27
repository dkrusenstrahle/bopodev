import type { BopoDb } from "bopodev-db";
import {
  aggregateCompanyCostLedgerAllTime,
  aggregateCompanyCostLedgerInRange,
  getCompany,
  listAgents,
  listApprovalRequests,
  listCostEntries,
  listGoals,
  listHeartbeatRuns,
  listIssueGoalIdsBatch,
  listIssues,
  listProjects
} from "bopodev-db";
import { loadAgentMemoryContext } from "./memory-file-service";

const MAX_SNAPSHOT_CHARS = 96_000;

function parseJsonArray(raw: string | null | undefined): string[] {
  if (!raw) {
    return [];
  }
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function serializeIssue(row: Record<string, unknown>, goalIds: string[]) {
  return {
    id: row.id,
    projectId: row.projectId,
    parentIssueId: row.parentIssueId ?? null,
    loopId: row.loopId ?? null,
    title: row.title,
    body: row.body ?? null,
    status: row.status,
    priority: row.priority,
    assigneeAgentId: row.assigneeAgentId ?? null,
    labels: parseJsonArray(row.labelsJson as string),
    tags: parseJsonArray(row.tagsJson as string),
    goalIds,
    updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : String(row.updatedAt)
  };
}

const COST_SNAPSHOT_ROW_LIMIT = 60;

function serializeCostRow(row: {
  id: string;
  runId: string | null;
  projectId: string | null;
  issueId: string | null;
  agentId: string | null;
  providerType: string;
  runtimeModelId: string | null;
  tokenInput: number;
  tokenOutput: number;
  usdCost: string;
  usdCostStatus: string | null;
  createdAt: Date;
}) {
  return {
    id: row.id,
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt),
    providerType: row.providerType,
    runtimeModelId: row.runtimeModelId ?? null,
    agentId: row.agentId ?? null,
    runId: row.runId ?? null,
    issueId: row.issueId ?? null,
    projectId: row.projectId ?? null,
    tokenInput: row.tokenInput,
    tokenOutput: row.tokenOutput,
    usdCost: String(row.usdCost),
    usdCostStatus: row.usdCostStatus ?? null
  };
}

function sumCostRows(
  rows: Array<{ tokenInput: number; tokenOutput: number; usdCost: string }>
): { tokenInput: number; tokenOutput: number; usd: number } {
  let tokenInput = 0;
  let tokenOutput = 0;
  let usd = 0;
  for (const r of rows) {
    tokenInput += Number(r.tokenInput) || 0;
    tokenOutput += Number(r.tokenOutput) || 0;
    usd += Number.parseFloat(String(r.usdCost)) || 0;
  }
  return { tokenInput, tokenOutput, usd };
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
    canHireAgents: row.canHireAgents ?? null
  };
}

function resolveMemoryAnchorAgentId(
  agents: Awaited<ReturnType<typeof listAgents>>
): string | null {
  const active = agents
    .filter((a) => a.status !== "terminated")
    .sort((a, b) => a.name.localeCompare(b.name));
  return active[0]?.id ?? null;
}

/**
 * Read-only JSON bundle for owner-assistant CLI runs.
 * Memory uses the first non-terminated agent as anchor (company + agent memory roots), or omits agent-only roots when none exist.
 */
export async function buildCompanyAssistantContextSnapshot(
  db: BopoDb,
  companyId: string,
  userQueryHint: string
): Promise<string> {
  const agents = await listAgents(db, companyId);
  const memoryAgentId = resolveMemoryAnchorAgentId(agents);

  const company = await getCompany(db, companyId);
  const projects = await listProjects(db, companyId);
  const allIssues = await listIssues(db, companyId);
  const issuesSorted = [...allIssues].sort((a, b) => {
    const ta = a.updatedAt instanceof Date ? a.updatedAt.getTime() : 0;
    const tb = b.updatedAt instanceof Date ? b.updatedAt.getTime() : 0;
    return tb - ta;
  });
  let issueLimit = 45;
  let issuesSlice = issuesSorted.slice(0, issueLimit);
  let goalMap = await listIssueGoalIdsBatch(
    db,
    companyId,
    issuesSlice.map((r) => r.id)
  );
  const goals = await listGoals(db, companyId);
  const approvals = await listApprovalRequests(db, companyId);
  const pending = approvals.filter((r) => r.status === "pending").slice(0, 25);
  const runs = await listHeartbeatRuns(db, companyId, 18);
  const costRowsRaw = await listCostEntries(db, companyId, COST_SNAPSHOT_ROW_LIMIT);
  const costRows = costRowsRaw.map((r) =>
    serializeCostRow({
      id: r.id,
      runId: r.runId ?? null,
      projectId: r.projectId ?? null,
      issueId: r.issueId ?? null,
      agentId: r.agentId ?? null,
      providerType: r.providerType,
      runtimeModelId: r.runtimeModelId ?? null,
      tokenInput: r.tokenInput ?? 0,
      tokenOutput: r.tokenOutput ?? 0,
      usdCost: String(r.usdCost ?? "0"),
      usdCostStatus: r.usdCostStatus ?? null,
      createdAt: r.createdAt instanceof Date ? r.createdAt : new Date(String(r.createdAt))
    })
  );
  const costTotalsRecent = sumCostRows(costRows);

  const monthRef = new Date();
  const yUtc = monthRef.getUTCFullYear();
  const mUtc = monthRef.getUTCMonth();
  const monthStartUtc = new Date(Date.UTC(yUtc, mUtc, 1, 0, 0, 0, 0));
  const monthEndExclusiveUtc = new Date(Date.UTC(yUtc, mUtc + 1, 1, 0, 0, 0, 0));
  const [costMonthUtc, costAllTime] = await Promise.all([
    aggregateCompanyCostLedgerInRange(db, companyId, monthStartUtc, monthEndExclusiveUtc),
    aggregateCompanyCostLedgerAllTime(db, companyId)
  ]);

  const memoryContext = memoryAgentId
    ? await loadAgentMemoryContext({
        companyId,
        agentId: memoryAgentId,
        projectIds: [],
        queryText: userQueryHint.trim() || undefined
      })
    : {
        memoryRoot: "",
        tacitNotes: undefined as string | undefined,
        durableFacts: [] as string[],
        dailyNotes: [] as string[]
      };

  const buildPayload = () => ({
    company: company
      ? { id: company.id, name: company.name, mission: company.mission ?? null }
      : { error: "not_found" },
    projects: projects.map((p) => ({
      id: p.id,
      name: p.name,
      status: p.status,
      description: p.description ?? null
    })),
    issues: issuesSlice.map((r) =>
      serializeIssue(r as unknown as Record<string, unknown>, goalMap.get(r.id) ?? [])
    ),
    goals: goals.map((g) => ({
      id: g.id,
      title: g.title,
      status: g.status,
      level: g.level,
      projectId: g.projectId ?? null,
      description: g.description ?? null
    })),
    agents: agents
      .filter((a) => a.status !== "terminated")
      .map((a) => sanitizeAgentRow(a as unknown as Record<string, unknown>)),
    pendingApprovals: pending.map((r) => ({
      id: r.id,
      action: r.action,
      status: r.status,
      createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : String(r.createdAt)
    })),
    recentHeartbeatRuns: runs.map((r) => ({
      id: r.id,
      agentId: r.agentId,
      status: r.status,
      startedAt: r.startedAt instanceof Date ? r.startedAt.toISOString() : String(r.startedAt),
      finishedAt: r.finishedAt
        ? r.finishedAt instanceof Date
          ? r.finishedAt.toISOString()
          : String(r.finishedAt)
        : null
    })),
    costAndUsage: {
      note: `monthToDateUtc and allTime are exact sums over cost_ledger in the database. recentEntries (max ${COST_SNAPSHOT_ROW_LIMIT}) is for line-level detail only—do not treat totalsInListedRows as monthly or all-time totals.`,
      monthToDateUtc: {
        calendarMonth: `${yUtc}-${String(mUtc + 1).padStart(2, "0")}`,
        rangeStartUtcInclusive: monthStartUtc.toISOString(),
        rangeEndUtcExclusive: monthEndExclusiveUtc.toISOString(),
        ledgerRowCount: costMonthUtc.rowCount,
        tokenInput: costMonthUtc.tokenInput,
        tokenOutput: costMonthUtc.tokenOutput,
        usdTotal: costMonthUtc.usdTotal
      },
      allTime: {
        ledgerRowCount: costAllTime.rowCount,
        tokenInput: costAllTime.tokenInput,
        tokenOutput: costAllTime.tokenOutput,
        usdTotal: costAllTime.usdTotal
      },
      recentSample: {
        rowCount: costRows.length,
        totalsInListedRows: {
          usd: costTotalsRecent.usd,
          tokenInput: costTotalsRecent.tokenInput,
          tokenOutput: costTotalsRecent.tokenOutput
        },
        entries: costRows
      }
    },
    memoryContext: {
      memoryRoot: memoryContext.memoryRoot,
      tacitNotes: memoryContext.tacitNotes ?? null,
      durableFacts: memoryContext.durableFacts ?? [],
      dailyNotes: memoryContext.dailyNotes ?? []
    }
  });

  let payload = buildPayload();
  let raw = JSON.stringify(payload);
  while (raw.length > MAX_SNAPSHOT_CHARS && issueLimit > 8) {
    issueLimit -= 8;
    issuesSlice = issuesSorted.slice(0, issueLimit);
    goalMap = await listIssueGoalIdsBatch(
      db,
      companyId,
      issuesSlice.map((r) => r.id)
    );
    payload = buildPayload();
    raw = JSON.stringify(payload);
  }
  if (raw.length > MAX_SNAPSHOT_CHARS) {
    return `${raw.slice(0, MAX_SNAPSHOT_CHARS)}\n…(snapshot truncated)`;
  }
  return raw;
}
