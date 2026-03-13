import { ApiError, apiGet } from "@/lib/api";
import type { ExecutionOutcome } from "bopodev-contracts";

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

export interface HeartbeatRunMessageRow {
  id: string;
  companyId: string;
  runId: string;
  sequence: number;
  kind: "system" | "assistant" | "thinking" | "tool_call" | "tool_result" | "result" | "stderr";
  label?: string | null;
  text?: string | null;
  payload?: string | null;
  signalLevel?: "high" | "medium" | "low" | "noise";
  groupKey?: string | null;
  source?: "stdout" | "stderr" | "trace_fallback";
  createdAt: string;
}

export interface HeartbeatRunDetailData {
  run: {
    id: string;
    companyId: string;
    agentId: string;
    status: string;
    runType: "work" | "no_assigned_work" | "budget_skip" | "overlap_skip" | "other_skip" | "failed" | "running";
    message: string | null;
    startedAt: string;
    finishedAt?: string | null;
  };
  details: Record<string, unknown> | null;
  transcript: {
    hasPersistedMessages: boolean;
    fallbackFromTrace: boolean;
    truncated: boolean;
  };
}

type WorkspaceDataSection =
  | "issues"
  | "agents"
  | "heartbeatRuns"
  | "goals"
  | "approvals"
  | "governanceInbox"
  | "auditEvents"
  | "costEntries"
  | "projects"
  | "templates";

export interface WorkspaceDataLoadOptions {
  include?: Partial<Record<WorkspaceDataSection, boolean>>;
}

async function loadIssues(companyId: string) {
  const result = (await apiGet("/issues", companyId)) as ApiResult<WorkspaceData["issues"]>;
  return result.data;
}

async function loadCompanies(companyId: string) {
  const result = (await apiGet("/companies", companyId)) as ApiResult<WorkspaceData["companies"]>;
  return result.data;
}

async function loadAgents(companyId: string) {
  const result = (await apiGet("/agents", companyId)) as ApiResult<WorkspaceData["agents"]>;
  return result.data;
}

async function loadHeartbeatRuns(companyId: string) {
  const result = (await apiGet("/observability/heartbeats", companyId)) as ApiResult<WorkspaceData["heartbeatRuns"]>;
  return result.data;
}

export async function loadHeartbeatRunDetail(companyId: string, runId: string) {
  const result = (await apiGet(
    `/observability/heartbeats/${encodeURIComponent(runId)}`,
    companyId
  )) as ApiResult<HeartbeatRunDetailData>;
  return result.data;
}

export async function loadHeartbeatRunMessages(
  companyId: string,
  runId: string,
  cursor?: string,
  limit = 200,
  options?: {
    signalOnly?: boolean;
    kinds?: Array<"system" | "assistant" | "thinking" | "tool_call" | "tool_result" | "result" | "stderr">;
  }
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
  )) as ApiResult<{
    runId: string;
    items: HeartbeatRunMessageRow[];
    nextCursor: string | null;
  }>;
  return result.data;
}

async function loadGoals(companyId: string) {
  const result = (await apiGet("/goals", companyId)) as ApiResult<WorkspaceData["goals"]>;
  return result.data;
}

async function loadApprovals(companyId: string) {
  const result = (await apiGet("/governance/approvals", companyId)) as ApiResult<WorkspaceData["approvals"]>;
  return result.data;
}

async function loadGovernanceInbox(companyId: string) {
  const result = (await apiGet("/governance/inbox", companyId)) as ApiResult<{
    actorId: string;
    resolvedWindowDays: number;
    items: WorkspaceData["governanceInbox"];
  }>;
  return result.data.items;
}

async function loadAuditEvents(companyId: string) {
  const result = (await apiGet("/observability/logs", companyId)) as ApiResult<WorkspaceData["auditEvents"]>;
  return result.data;
}

async function loadCostEntries(companyId: string) {
  const result = (await apiGet("/observability/costs", companyId)) as ApiResult<WorkspaceData["costEntries"]>;
  return result.data;
}

async function loadProjects(companyId: string) {
  const result = (await apiGet("/projects", companyId)) as ApiResult<WorkspaceData["projects"]>;
  return result.data;
}

async function loadTemplates(companyId: string) {
  const result = (await apiGet("/templates", companyId)) as ApiResult<WorkspaceData["templates"]>;
  return result.data;
}

export async function loadWorkspaceData(
  requestedCompanyId?: string | null,
  options: WorkspaceDataLoadOptions = {}
): Promise<WorkspaceData> {
  const include = {
    issues: true,
    agents: true,
    heartbeatRuns: true,
    goals: true,
    approvals: true,
    governanceInbox: true,
    auditEvents: true,
    costEntries: true,
    projects: true,
    templates: true,
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
    auditEvents: [],
    costEntries: [],
    projects: [],
    templates: []
  });
  let companies: WorkspaceData["companies"] = [];
  try {
    companies = await loadCompanies(defaultCompanyId);
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
  const [issues, agents, heartbeatRuns, goals, approvals, governanceInbox, auditEvents, costEntries, projects, templates] = await Promise.all(
    [
      include.issues ? loadIssues(companyId) : Promise.resolve([]),
      include.agents ? loadAgents(companyId) : Promise.resolve([]),
      include.heartbeatRuns ? loadHeartbeatRuns(companyId) : Promise.resolve([]),
      include.goals ? loadGoals(companyId) : Promise.resolve([]),
      include.approvals ? loadApprovals(companyId) : Promise.resolve([]),
      include.governanceInbox ? loadGovernanceInbox(companyId) : Promise.resolve([]),
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
    auditEvents,
    costEntries,
    projects,
    templates
  };
}
