import { ApiError, apiGet } from "@/lib/api";
import {
  AgentSchema,
  ApprovalRequestSchema,
  AuditEventSchema,
  CompanySchema,
  CostLedgerEntrySchema,
  BoardAttentionListResponseSchema,
  GoalSchema,
  HeartbeatRunDetailSchema,
  IssueSchema,
  ListHeartbeatRunMessagesResponseSchema,
  ProjectSchema,
  TemplateSchema,
  type ExecutionOutcome,
  type HeartbeatRunDetail,
  type HeartbeatRunMessage,
  type HeartbeatRunTranscriptEventKind,
  GovernanceInboxResponseSchema
} from "bopodev-contracts";

const defaultCompanyId = process.env.NEXT_PUBLIC_DEFAULT_COMPANY_ID ?? "demo-company";

type ApiResult<T> = {
  ok: boolean;
  data: T;
};

export interface WorkspaceData {
  companyId: string | null;
  activeCompany: { id: string; name: string; mission: string | null } | null;
  companies: Array<{ id: string; name: string; mission: string | null }>;
  issues: Array<{
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
  }>;
  agents: Array<{
    id: string;
    name: string;
    avatarSeed?: string | null;
    role: string;
    managerAgentId: string | null;
    status: string;
    providerType: string;
    heartbeatCron?: string;
    monthlyBudgetUsd?: number;
    usedBudgetUsd?: number;
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
  }>;
  heartbeatRuns: Array<{
    id: string;
    agentId: string;
    status: string;
    publicStatus?: "started" | "completed" | "failed";
    runType: "work" | "no_assigned_work" | "budget_skip" | "overlap_skip" | "other_skip" | "failed" | "running";
    message: string | null;
    outcome?: ExecutionOutcome | null;
    startedAt: string;
    finishedAt?: string | null;
  }>;
  goals: Array<{
    id: string;
    projectId: string | null;
    parentGoalId: string | null;
    level: string;
    title: string;
    description?: string | null;
    status: string;
  }>;
  approvals: Array<{
    id: string;
    action: string;
    status: string;
    createdAt: string;
    resolvedAt?: string | null;
    payload?: Record<string, unknown>;
  }>;
  governanceInbox: Array<{
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
  }>;
  attentionItems: Array<{
    key: string;
    category:
      | "approval_required"
      | "blocker_escalation"
      | "budget_hard_stop"
      | "stalled_work"
      | "run_failure_spike"
      | "board_mentioned_comment";
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
  }>;
  auditEvents: Array<{
    id: string;
    eventType: string;
    entityType: string;
    entityId: string;
    createdAt: string;
    payload?: Record<string, unknown>;
  }>;
  costEntries: Array<{
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
  }>;
  projects: Array<{
    id: string;
    name: string;
    description: string | null;
    status: "planned" | "active" | "paused" | "blocked" | "completed" | "archived";
    plannedStartAt: string | null;
    monthlyBudgetUsd: number;
    usedBudgetUsd: number;
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
  }>;
  templates: Array<{
    id: string;
    companyId: string;
    slug: string;
    name: string;
    description?: string | null;
    currentVersion: string;
    status: "draft" | "published" | "archived";
    visibility: "company" | "private";
    variables: Array<{
      key: string;
      label?: string;
      description?: string;
      type: "string" | "number" | "boolean" | "select";
      required: boolean;
      defaultValue?: unknown;
      options?: string[];
    }>;
    manifest: Record<string, unknown>;
    createdAt: string;
    updatedAt: string;
  }>;
}

export type HeartbeatRunMessageRow = HeartbeatRunMessage;
export type HeartbeatRunDetailData = HeartbeatRunDetail;

type WorkspaceDataSection =
  | "issues"
  | "agents"
  | "heartbeatRuns"
  | "goals"
  | "approvals"
  | "governanceInbox"
  | "attentionItems"
  | "auditEvents"
  | "costEntries"
  | "projects"
  | "templates";

export interface WorkspaceDataLoadOptions {
  include?: Partial<Record<WorkspaceDataSection, boolean>>;
  /** Max rows from GET /observability/heartbeats (API caps at 500). */
  heartbeatRunsLimit?: number;
}

async function loadIssues(companyId: string) {
  const result = (await apiGet("/issues", companyId)) as ApiResult<WorkspaceData["issues"]>;
  return parseApiData("issues", IssueSchema.array(), result.data);
}

async function loadCompanies(companyId?: string | null) {
  const result = (await apiGet("/companies", companyId)) as ApiResult<WorkspaceData["companies"]>;
  const companies = parseApiData("companies", CompanySchema.array(), result.data);
  return companies.map((company) => ({
    id: company.id,
    name: company.name,
    mission: company.mission ?? null
  }));
}

async function loadAgents(companyId: string) {
  const result = (await apiGet("/agents", companyId)) as ApiResult<WorkspaceData["agents"]>;
  return parseApiData("agents", AgentSchema.array(), result.data);
}

async function loadHeartbeatRuns(companyId: string, limit?: number) {
  const query =
    typeof limit === "number" && Number.isFinite(limit)
      ? `?limit=${Math.min(500, Math.max(1, Math.floor(limit)))}`
      : "";
  const result = (await apiGet(`/observability/heartbeats${query}`, companyId)) as ApiResult<WorkspaceData["heartbeatRuns"]>;
  return Array.isArray(result.data) ? result.data : [];
}

export async function loadHeartbeatRunDetail(companyId: string, runId: string) {
  const result = (await apiGet(
    `/observability/heartbeats/${encodeURIComponent(runId)}`,
    companyId
  )) as ApiResult<HeartbeatRunDetailData>;
  return parseApiData("heartbeat run detail", HeartbeatRunDetailSchema, result.data);
}

export async function loadHeartbeatRunMessages(
  companyId: string,
  runId: string,
  cursor?: string,
  limit = 200,
  options?: { signalOnly?: boolean; kinds?: HeartbeatRunTranscriptEventKind[] }
) {
  const params = new URLSearchParams();
  params.set("limit", String(limit));
  if (typeof options?.signalOnly === "boolean") {
    params.set("signalOnly", options.signalOnly ? "true" : "false");
  }
  if (options?.kinds && options.kinds.length > 0) {
    params.set("kinds", options.kinds.join(","));
  }
  if (cursor && cursor.trim().length > 0) {
    params.set("cursor", cursor);
  }
  const suffix = params.toString();
  const result = (await apiGet(
    `/observability/heartbeats/${encodeURIComponent(runId)}/messages${suffix ? `?${suffix}` : ""}`,
    companyId
  )) as ApiResult<{ runId: string; items: HeartbeatRunMessageRow[]; nextCursor: string | null }>;
  return parseApiData("heartbeat run messages", ListHeartbeatRunMessagesResponseSchema, result.data);
}

async function loadGoals(companyId: string) {
  const result = (await apiGet("/goals", companyId)) as ApiResult<WorkspaceData["goals"]>;
  return parseApiData("goals", GoalSchema.array(), result.data);
}

async function loadApprovals(companyId: string) {
  // Deprecated for board queue UX; Inbox should read canonical board actions from /attention.
  // Kept temporarily for compatibility and historical approval-focused views.
  const result = (await apiGet("/governance/approvals", companyId)) as ApiResult<WorkspaceData["approvals"]>;
  return parseApiData("approvals", ApprovalRequestSchema.array(), result.data);
}

async function loadGovernanceInbox(companyId: string) {
  const result = (await apiGet("/governance/inbox", companyId)) as ApiResult<{
    actorId: string;
    resolvedWindowDays: number;
    items: WorkspaceData["governanceInbox"];
  }>;
  return parseApiData("governance inbox", GovernanceInboxResponseSchema, result.data).items;
}

async function loadAttentionItems(companyId: string) {
  const result = (await apiGet("/attention", companyId)) as ApiResult<{
    actorId: string;
    items: WorkspaceData["attentionItems"];
  }>;
  return parseApiData("board attention", BoardAttentionListResponseSchema, result.data).items;
}

async function loadAuditEvents(companyId: string) {
  const result = (await apiGet("/observability/logs", companyId)) as ApiResult<WorkspaceData["auditEvents"]>;
  return parseApiData("audit events", AuditEventSchema.array(), result.data);
}

async function loadCostEntries(companyId: string) {
  const result = (await apiGet("/observability/costs", companyId)) as ApiResult<WorkspaceData["costEntries"]>;
  return parseApiData("cost entries", CostLedgerEntrySchema.array(), result.data);
}

async function loadProjects(companyId: string) {
  const result = (await apiGet("/projects", companyId)) as ApiResult<WorkspaceData["projects"]>;
  const projects = parseApiData("projects", ProjectSchema.array(), result.data);
  return projects.map((project) => ({
    ...project,
    description: project.description ?? null,
    plannedStartAt: project.plannedStartAt ?? null,
    workspaces: project.workspaces.map((workspace) => ({
      ...workspace,
      cwd: workspace.cwd ?? null,
      repoUrl: workspace.repoUrl ?? null,
      repoRef: workspace.repoRef ?? null
    })),
    primaryWorkspace: project.primaryWorkspace
      ? {
          ...project.primaryWorkspace,
          cwd: project.primaryWorkspace.cwd ?? null,
          repoUrl: project.primaryWorkspace.repoUrl ?? null,
          repoRef: project.primaryWorkspace.repoRef ?? null
        }
      : null
  }));
}

async function loadTemplates(companyId: string) {
  const result = (await apiGet("/templates", companyId)) as ApiResult<WorkspaceData["templates"]>;
  return parseApiData("templates", TemplateSchema.array(), result.data);
}

export async function loadWorkspaceData(
  requestedCompanyId?: string | null,
  options: WorkspaceDataLoadOptions = {}
): Promise<WorkspaceData> {
  const heartbeatRunsLimit = options.heartbeatRunsLimit;
  const include = {
    issues: true,
    agents: true,
    heartbeatRuns: true,
    goals: true,
    approvals: false,
    governanceInbox: false,
    attentionItems: true,
    auditEvents: true,
    costEntries: true,
    projects: true,
    templates: false,
    ...options.include
  } satisfies Record<WorkspaceDataSection, boolean>;
  const emptyWorkspaceData = (): WorkspaceData => ({
    companyId: null,
    activeCompany: null,
    companies: [],
    issues: [],
    agents: [],
    heartbeatRuns: [],
    goals: [],
    approvals: [],
    governanceInbox: [],
    attentionItems: [],
    auditEvents: [],
    costEntries: [],
    projects: [],
    templates: []
  });
  let companies: WorkspaceData["companies"] = [];
  try {
    companies = await loadCompanies(requestedCompanyId);
  } catch (error) {
    // During local startup the API can be briefly unavailable; return an empty workspace instead of crashing SSR.
    if (error instanceof ApiError || error instanceof TypeError) {
      return emptyWorkspaceData();
    }
    throw error;
  }
  const activeCompany =
    companies.find((company) => company.id === requestedCompanyId) ??
    companies.find((company) => company.id === defaultCompanyId) ??
    companies[0] ??
    null;

  if (!activeCompany) {
    return emptyWorkspaceData();
  }

  const companyId = activeCompany.id;
  const [issues, agents, heartbeatRuns, goals, approvals, governanceInbox, attentionItems, auditEvents, costEntries, projects, templates] = await Promise.all(
    [
      include.issues ? loadIssues(companyId) : Promise.resolve([]),
      include.agents ? loadAgents(companyId) : Promise.resolve([]),
      include.heartbeatRuns ? loadHeartbeatRuns(companyId, heartbeatRunsLimit) : Promise.resolve([]),
      include.goals ? loadGoals(companyId) : Promise.resolve([]),
      include.approvals ? loadApprovals(companyId) : Promise.resolve([]),
      include.governanceInbox ? loadGovernanceInbox(companyId) : Promise.resolve([]),
      include.attentionItems ? loadAttentionItems(companyId) : Promise.resolve([]),
      include.auditEvents ? loadAuditEvents(companyId) : Promise.resolve([]),
      include.costEntries ? loadCostEntries(companyId) : Promise.resolve([]),
      include.projects ? loadProjects(companyId) : Promise.resolve([]),
      include.templates ? loadTemplates(companyId) : Promise.resolve([])
    ]
  );

  return {
    companyId,
    activeCompany,
    companies,
    issues,
    agents,
    heartbeatRuns,
    goals,
    approvals,
    governanceInbox,
    attentionItems,
    auditEvents,
    costEntries,
    projects,
    templates
  };
}

function parseApiData<T>(
  resourceName: string,
  schema: { safeParse: (value: unknown) => { success: boolean; data?: T; error?: { issues?: Array<{ path?: unknown[]; message?: string }> } } },
  data: unknown
): T {
  const parsed = schema.safeParse(data);
  if (parsed.success) {
    return parsed.data as T;
  }
  throw new Error(
    `API contract mismatch for '${resourceName}': ${(parsed.error?.issues ?? [])
      .map((issue) => `${(issue.path ?? []).join(".") || "<root>"} ${issue.message ?? "Invalid value"}`)
      .join("; ")}`
  );
}
