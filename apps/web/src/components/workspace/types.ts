export interface IssueRow {
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

export interface AgentRow {
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

export interface HeartbeatRunRow {
  id: string;
  agentId: string;
  status: string;
  runType: "work" | "no_assigned_work" | "budget_skip" | "overlap_skip" | "other_skip" | "failed" | "running";
  message: string | null;
  startedAt: string;
  finishedAt?: string | null;
}

export interface RunDetailsPayload {
  result?: string;
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

export interface GoalRow {
  id: string;
  projectId: string | null;
  parentGoalId: string | null;
  level: string;
  title: string;
  description?: string | null;
  status: string;
}

export interface ApprovalRow {
  id: string;
  action: string;
  status: string;
  createdAt: string;
  resolvedAt?: string | null;
  payload?: Record<string, unknown>;
}

export interface GovernanceInboxRow {
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

export interface AuditRow {
  id: string;
  eventType: string;
  entityType: string;
  entityId: string;
  createdAt: string;
  payload?: Record<string, unknown>;
}

export interface CostRow {
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

export interface ProjectRow {
  id: string;
  name: string;
  description: string | null;
  status: "planned" | "active" | "paused" | "blocked" | "completed" | "archived";
  plannedStartAt: string | null;
  workspaceLocalPath: string | null;
  workspaceGithubRepo: string | null;
}

export interface CompanyRow {
  id: string;
  name: string;
  mission: string | null;
}

export interface PluginRow {
  id: string;
  name: string;
  description?: string | null;
  promptTemplate?: string | null;
  version: string;
  kind: string;
  runtimeType: string;
  runtimeEntrypoint: string;
  hooks: string[];
  capabilities: string[];
  companyConfig: {
    enabled: boolean;
    priority: number;
    config: Record<string, unknown>;
    grantedCapabilities: string[];
  } | null;
}

export interface PluginRunRow {
  id: string;
  runId: string | null;
  pluginId: string;
  hook: string;
  status: string;
  createdAt: string;
  diagnostics?: Record<string, unknown>;
}
