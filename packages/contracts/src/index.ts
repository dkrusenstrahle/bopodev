import { z } from "zod";

export const EntityIdSchema = z.string().min(1);
export type EntityId = z.infer<typeof EntityIdSchema>;

export const CompanySchema = z.object({
  id: EntityIdSchema,
  name: z.string().min(1),
  mission: z.string().nullable().optional(),
  createdAt: z.string()
});

export const ProjectSchema = z.object({
  id: EntityIdSchema,
  companyId: EntityIdSchema,
  name: z.string().min(1),
  description: z.string().nullable().optional(),
  status: z.enum(["planned", "active", "paused", "blocked", "completed", "archived"]),
  plannedStartAt: z.string().nullable().optional(),
  monthlyBudgetUsd: z.number().positive(),
  usedBudgetUsd: z.number().nonnegative(),
  budgetWindowStartAt: z.string().nullable().optional(),
  executionWorkspacePolicy: z.record(z.string(), z.unknown()).nullable().optional(),
  gitDiagnostics: z
    .object({
      workspaceStatus: z.enum(["hybrid", "repo_only", "local_only", "unconfigured"]).optional(),
      cloneState: z.enum(["ready", "missing", "n/a"]).optional(),
      authMode: z.enum(["host", "env_token"]).optional(),
      tokenEnvVar: z.string().nullable().optional(),
      effectiveCwd: z.string().nullable().optional()
    })
    .optional(),
  workspaces: z
    .array(
      z.object({
        id: EntityIdSchema,
        companyId: EntityIdSchema,
        projectId: EntityIdSchema,
        name: z.string().min(1),
        cwd: z.string().nullable().optional(),
        repoUrl: z.string().url().nullable().optional(),
        repoRef: z.string().nullable().optional(),
        isPrimary: z.boolean(),
        createdAt: z.string(),
        updatedAt: z.string()
      })
    )
    .default([]),
  primaryWorkspace: z
    .object({
      id: EntityIdSchema,
      companyId: EntityIdSchema,
      projectId: EntityIdSchema,
      name: z.string().min(1),
      cwd: z.string().nullable().optional(),
      repoUrl: z.string().url().nullable().optional(),
      repoRef: z.string().nullable().optional(),
      isPrimary: z.boolean(),
      createdAt: z.string(),
      updatedAt: z.string()
    })
    .nullable()
    .optional(),
  createdAt: z.string()
});

export const ExecutionWorkspaceModeSchema = z.enum(["project_primary", "isolated", "agent_default"]);
export type ExecutionWorkspaceMode = z.infer<typeof ExecutionWorkspaceModeSchema>;
export const ExecutionWorkspaceStrategyTypeSchema = z.enum(["git_worktree"]);
export type ExecutionWorkspaceStrategyType = z.infer<typeof ExecutionWorkspaceStrategyTypeSchema>;
export const ProjectExecutionWorkspacePolicySchema = z
  .object({
    mode: ExecutionWorkspaceModeSchema.optional(),
    strategy: z
      .object({
        type: ExecutionWorkspaceStrategyTypeSchema.optional(),
        rootDir: z.string().nullable().optional(),
        branchPrefix: z.string().nullable().optional()
      })
      .nullable()
      .optional(),
    credentials: z
      .object({
        mode: z.enum(["host", "env_token"]).optional(),
        tokenEnvVar: z.string().nullable().optional(),
        username: z.string().nullable().optional()
      })
      .nullable()
      .optional(),
    allowRemotes: z.array(z.string()).nullable().optional(),
    allowBranchPrefixes: z.array(z.string()).nullable().optional()
  })
  .partial();
export type ProjectExecutionWorkspacePolicy = z.infer<typeof ProjectExecutionWorkspacePolicySchema>;

export const IssueStatusSchema = z.enum([
  "todo",
  "in_progress",
  "blocked",
  "in_review",
  "done",
  "canceled"
]);
export type IssueStatus = z.infer<typeof IssueStatusSchema>;

export const IssuePrioritySchema = z.enum(["none", "low", "medium", "high", "urgent"]);
export type IssuePriority = z.infer<typeof IssuePrioritySchema>;

export const IssueSchema = z.object({
  id: EntityIdSchema,
  companyId: EntityIdSchema,
  projectId: EntityIdSchema,
  parentIssueId: EntityIdSchema.nullable(),
  title: z.string().min(1),
  body: z.string().nullable().optional(),
  status: IssueStatusSchema,
  priority: IssuePrioritySchema,
  assigneeAgentId: EntityIdSchema.nullable(),
  labels: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([]),
  createdAt: z.string(),
  updatedAt: z.string()
});

export const IssueAttachmentSchema = z.object({
  id: EntityIdSchema,
  companyId: EntityIdSchema,
  issueId: EntityIdSchema,
  projectId: EntityIdSchema,
  fileName: z.string().min(1),
  mimeType: z.string().nullable().optional(),
  fileSizeBytes: z.number().int().nonnegative(),
  relativePath: z.string().min(1),
  uploadedByActorType: z.enum(["human", "agent", "system"]),
  uploadedByActorId: z.string().nullable().optional(),
  createdAt: z.string()
});
export type IssueAttachment = z.infer<typeof IssueAttachmentSchema>;

/** Single-issue GET: core issue fields plus attachment metadata and API download paths. */
export const IssueAttachmentWithDownloadSchema = IssueAttachmentSchema.extend({
  downloadPath: z.string().min(1)
});
export const IssueDetailSchema = IssueSchema.extend({
  attachments: z.array(IssueAttachmentWithDownloadSchema)
});
export type IssueDetail = z.infer<typeof IssueDetailSchema>;

export const IssueCommentRecipientSchema = z.object({
  recipientType: z.enum(["agent", "board", "member"]),
  recipientId: z.string().nullable().optional(),
  deliveryStatus: z.enum(["pending", "dispatched", "failed", "skipped"]).default("pending"),
  dispatchedRunId: z.string().nullable().optional(),
  dispatchedAt: z.string().nullable().optional(),
  acknowledgedAt: z.string().nullable().optional()
});
export type IssueCommentRecipient = z.infer<typeof IssueCommentRecipientSchema>;

export const IssueCommentSchema = z.object({
  id: EntityIdSchema,
  issueId: EntityIdSchema,
  companyId: EntityIdSchema,
  authorType: z.enum(["human", "agent", "system"]),
  authorId: z.string().nullable().optional(),
  recipients: z.array(IssueCommentRecipientSchema).default([]),
  runId: EntityIdSchema.nullable().optional(),
  body: z.string().min(1),
  createdAt: z.string()
});
export type IssueComment = z.infer<typeof IssueCommentSchema>;

export const GoalLevelSchema = z.enum(["company", "project", "agent"]);
export const AgentRoleKeySchema = z.enum([
  "ceo",
  "cto",
  "cmo",
  "cfo",
  "engineer",
  "designer",
  "pm",
  "qa",
  "devops",
  "researcher",
  "general"
]);
export type AgentRoleKey = z.infer<typeof AgentRoleKeySchema>;
export const AGENT_ROLE_KEYS = AgentRoleKeySchema.options;
export const AGENT_ROLE_LABELS: Record<AgentRoleKey, string> = {
  ceo: "CEO",
  cto: "CTO",
  cmo: "CMO",
  cfo: "CFO",
  engineer: "Engineer",
  designer: "Designer",
  pm: "PM",
  qa: "QA",
  devops: "DevOps",
  researcher: "Researcher",
  general: "General"
};

export const GoalSchema = z.object({
  id: EntityIdSchema,
  companyId: EntityIdSchema,
  projectId: EntityIdSchema.nullable(),
  parentGoalId: EntityIdSchema.nullable(),
  level: GoalLevelSchema,
  title: z.string().min(1),
  description: z.string().nullable().optional(),
  status: z.enum(["draft", "active", "completed", "archived"]),
  createdAt: z.string(),
  updatedAt: z.string()
});

export const TemplateStatusSchema = z.enum(["draft", "published", "archived"]);
export type TemplateStatus = z.infer<typeof TemplateStatusSchema>;
export const TemplateVisibilitySchema = z.enum(["company", "private"]);
export type TemplateVisibility = z.infer<typeof TemplateVisibilitySchema>;
export const TemplateVariableTypeSchema = z.enum(["string", "number", "boolean", "select"]);
export type TemplateVariableType = z.infer<typeof TemplateVariableTypeSchema>;
export const TemplateVariableSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1).optional(),
  description: z.string().optional(),
  type: TemplateVariableTypeSchema.default("string"),
  required: z.boolean().default(false),
  defaultValue: z.unknown().optional(),
  options: z.array(z.string().min(1)).default([])
});
export type TemplateVariable = z.infer<typeof TemplateVariableSchema>;
export const TemplateManifestProjectSchema = z.object({
  key: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  status: z.enum(["planned", "active", "paused", "blocked", "completed", "archived"]).optional()
});
export const TemplateManifestGoalSchema = z.object({
  key: z.string().min(1),
  level: GoalLevelSchema,
  title: z.string().min(1),
  description: z.string().optional(),
  projectKey: z.string().optional()
});
export const TemplateManifestAgentSchema = z.object({
  key: z.string().min(1),
  role: z.string().min(1),
  roleKey: AgentRoleKeySchema.optional(),
  title: z.string().nullable().optional(),
  name: z.string().min(1),
  providerType: z.lazy(() => ProviderTypeSchema).default("shell"),
  heartbeatCron: z.string().default("*/5 * * * *"),
  monthlyBudgetUsd: z.number().nonnegative().default(0),
  canHireAgents: z.boolean().default(false),
  managerAgentKey: z.string().optional(),
  runtimeConfig: z.lazy(() => AgentRuntimeConfigSchema.partial()).optional()
});
export const TemplateManifestIssueSchema = z.object({
  key: z.string().min(1).optional(),
  title: z.string().min(1),
  body: z.string().optional(),
  status: IssueStatusSchema.optional(),
  priority: IssuePrioritySchema.optional(),
  projectKey: z.string().min(1),
  assigneeAgentKey: z.string().optional(),
  labels: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([])
});
export const TemplateManifestPluginSchema = z.object({
  pluginId: z.string().min(1),
  enabled: z.boolean().optional(),
  priority: z.number().int().min(0).max(1000).optional(),
  grantedCapabilities: z.array(z.string().min(1)).default([]),
  config: z.record(z.string(), z.unknown()).default({})
});
export const TemplateRecurrenceJobSchema = z.object({
  id: z.string().min(1).optional(),
  cron: z.string().min(1),
  targetType: z.enum(["agent", "template_task"]).default("agent"),
  targetKey: z.string().min(1),
  instruction: z.string().optional()
});
export const TemplateManifestSchema = z.object({
  company: z
    .object({
      mission: z.string().optional(),
      settings: z.record(z.string(), z.unknown()).default({})
    })
    .optional(),
  projects: z.array(TemplateManifestProjectSchema).default([]),
  goals: z.array(TemplateManifestGoalSchema).default([]),
  agents: z.array(TemplateManifestAgentSchema).default([]),
  issues: z.array(TemplateManifestIssueSchema).default([]),
  plugins: z.array(TemplateManifestPluginSchema).default([]),
  recurrence: z.array(TemplateRecurrenceJobSchema).default([])
});
export type TemplateManifest = z.infer<typeof TemplateManifestSchema>;
export const TemplateManifestDefault: TemplateManifest = {
  projects: [],
  goals: [],
  agents: [],
  issues: [],
  plugins: [],
  recurrence: []
};
export const TemplateSchema = z.object({
  id: EntityIdSchema,
  companyId: EntityIdSchema,
  slug: z.string().min(1),
  name: z.string().min(1),
  description: z.string().nullable().optional(),
  currentVersion: z.string().min(1),
  status: TemplateStatusSchema,
  visibility: TemplateVisibilitySchema,
  variables: z.array(TemplateVariableSchema).default([]),
  manifest: TemplateManifestSchema,
  createdAt: z.string(),
  updatedAt: z.string()
});
export type Template = z.infer<typeof TemplateSchema>;
export const TemplateCreateRequestSchema = z.object({
  slug: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  currentVersion: z.string().min(1).default("1.0.0"),
  status: TemplateStatusSchema.default("draft"),
  visibility: TemplateVisibilitySchema.default("company"),
  variables: z.array(TemplateVariableSchema).default([]),
  manifest: TemplateManifestSchema.default(TemplateManifestDefault)
});
export type TemplateCreateRequest = z.infer<typeof TemplateCreateRequestSchema>;
export const TemplateUpdateRequestSchema = z
  .object({
    slug: z.string().min(1).optional(),
    name: z.string().min(1).optional(),
    description: z.string().nullable().optional(),
    currentVersion: z.string().min(1).optional(),
    status: TemplateStatusSchema.optional(),
    visibility: TemplateVisibilitySchema.optional(),
    variables: z.array(TemplateVariableSchema).optional(),
    manifest: TemplateManifestSchema.optional()
  })
  .refine((payload) => Object.keys(payload).length > 0, "At least one field must be provided.");
export type TemplateUpdateRequest = z.infer<typeof TemplateUpdateRequestSchema>;
export const TemplatePreviewRequestSchema = z.object({
  variables: z.record(z.string(), z.unknown()).default({}),
  mode: z.enum(["apply_company", "create_company"]).default("apply_company"),
  targetCompanyName: z.string().min(1).optional()
});
export type TemplatePreviewRequest = z.infer<typeof TemplatePreviewRequestSchema>;
export const TemplatePreviewResponseSchema = z.object({
  templateId: EntityIdSchema,
  templateVersion: z.string().min(1),
  plannedActions: z.array(z.string()),
  summary: z.object({
    projects: z.number().int().nonnegative(),
    goals: z.number().int().nonnegative(),
    agents: z.number().int().nonnegative(),
    issues: z.number().int().nonnegative(),
    plugins: z.number().int().nonnegative(),
    recurrence: z.number().int().nonnegative()
  }),
  warnings: z.array(z.string())
});
export type TemplatePreviewResponse = z.infer<typeof TemplatePreviewResponseSchema>;
export const TemplateApplyRequestSchema = z.object({
  variables: z.record(z.string(), z.unknown()).default({}),
  requestApproval: z.boolean().default(false),
  mode: z.enum(["apply_company", "create_company"]).default("apply_company"),
  targetCompanyName: z.string().min(1).optional()
});
export type TemplateApplyRequest = z.infer<typeof TemplateApplyRequestSchema>;
export const TemplateApplyResponseSchema = z.object({
  applied: z.boolean(),
  queuedForApproval: z.boolean().optional(),
  approvalId: z.string().optional(),
  installId: z.string().optional(),
  summary: TemplatePreviewResponseSchema.shape.summary,
  warnings: z.array(z.string()).default([])
});
export type TemplateApplyResponse = z.infer<typeof TemplateApplyResponseSchema>;
export const TemplateExportSchema = z.object({
  schemaVersion: z.literal("bopo.template.v1"),
  template: TemplateCreateRequestSchema.extend({
    currentVersion: z.string().min(1)
  })
});
export type TemplateExport = z.infer<typeof TemplateExportSchema>;
export const TemplateImportRequestSchema = z.object({
  template: TemplateExportSchema,
  overwrite: z.boolean().default(false)
});
export type TemplateImportRequest = z.infer<typeof TemplateImportRequestSchema>;
export const TemplateVersionSchema = z.object({
  id: EntityIdSchema,
  companyId: EntityIdSchema,
  templateId: EntityIdSchema,
  version: z.string().min(1),
  manifest: TemplateManifestSchema,
  createdAt: z.string()
});
export type TemplateVersion = z.infer<typeof TemplateVersionSchema>;
export const TemplateInstallSchema = z.object({
  id: EntityIdSchema,
  companyId: EntityIdSchema,
  templateId: EntityIdSchema.nullable(),
  templateVersionId: EntityIdSchema.nullable(),
  status: z.enum(["applied", "queued", "failed"]),
  summary: z.record(z.string(), z.unknown()).default({}),
  variables: z.record(z.string(), z.unknown()).default({}),
  createdAt: z.string()
});
export type TemplateInstall = z.infer<typeof TemplateInstallSchema>;

export const AgentStatusSchema = z.enum(["idle", "running", "paused", "terminated"]);
export const ProviderTypeSchema = z.enum([
  "claude_code",
  "codex",
  "cursor",
  "opencode",
  "gemini_cli",
  "openai_api",
  "anthropic_api",
  "http",
  "shell"
]);
export type ProviderType = z.infer<typeof ProviderTypeSchema>;
const HeaderValueSchema = z.string().trim().min(1);
export const RequestActorHeadersSchema = z.object({
  "x-actor-type": z.enum(["board", "member", "agent"]).optional(),
  "x-actor-id": HeaderValueSchema.optional(),
  "x-actor-companies": z.string().optional(),
  "x-actor-permissions": z.string().optional()
});
export type RequestActorHeaders = z.infer<typeof RequestActorHeadersSchema>;
export const ControlPlaneRequestHeadersSchema = z.object({
  "x-company-id": HeaderValueSchema,
  "x-actor-type": z.enum(["board", "member", "agent"]),
  "x-actor-id": HeaderValueSchema,
  "x-actor-companies": HeaderValueSchema,
  "x-actor-permissions": HeaderValueSchema
});
export type ControlPlaneRequestHeaders = z.infer<typeof ControlPlaneRequestHeadersSchema>;
export const ControlPlaneHeadersJsonSchema = ControlPlaneRequestHeadersSchema.strict();
export const ControlPlaneRuntimeEnvSchema = z
  .object({
    BOPODEV_AGENT_ID: HeaderValueSchema.optional(),
    BOPODEV_COMPANY_ID: HeaderValueSchema.optional(),
    BOPODEV_RUN_ID: HeaderValueSchema.optional(),
    BOPODEV_API_BASE_URL: HeaderValueSchema.optional(),
    BOPODEV_ACTOR_TYPE: z.enum(["board", "member", "agent"]).optional(),
    BOPODEV_ACTOR_ID: HeaderValueSchema.optional(),
    BOPODEV_ACTOR_COMPANIES: z.string().optional(),
    BOPODEV_ACTOR_PERMISSIONS: z.string().optional(),
    BOPODEV_REQUEST_HEADERS_JSON: z.string().optional(),
    BOPODEV_WAKE_REASON: z.string().optional(),
    BOPODEV_WAKE_COMMENT_ID: z.string().optional(),
    BOPODEV_LINKED_ISSUE_IDS: z.string().optional(),
    BOPODEV_COMPANY_WORKSPACE_ROOT: z.string().optional(),
    BOPODEV_AGENT_HOME: z.string().optional(),
    BOPODEV_AGENT_OPERATING_DIR: z.string().optional()
  })
  .superRefine((value, ctx) => {
    const actorType = value.BOPODEV_ACTOR_TYPE;
    const actorId = value.BOPODEV_ACTOR_ID;
    const actorCompanies = value.BOPODEV_ACTOR_COMPANIES;
    const actorPermissions = value.BOPODEV_ACTOR_PERMISSIONS;
    const agentId = value.BOPODEV_AGENT_ID;
    const companyId = value.BOPODEV_COMPANY_ID;
    const runId = value.BOPODEV_RUN_ID;
    const apiBaseUrl = value.BOPODEV_API_BASE_URL;

    if (!agentId || !companyId || !runId || !apiBaseUrl) {
      ctx.addIssue({
        code: "custom",
        message:
          "Control-plane runtime identity is missing. Provide BOPODEV_AGENT_ID/COMPANY_ID/RUN_ID/API_BASE_URL.",
        path: ["BOPODEV_AGENT_ID"]
      });
    }
    const hasDirectHeaders =
      actorType && actorId && actorCompanies !== undefined && actorPermissions !== undefined;
    const jsonHeaders = value.BOPODEV_REQUEST_HEADERS_JSON;
    const hasJsonHeaders = typeof jsonHeaders === "string" && jsonHeaders.trim().length > 0;
    if (!hasDirectHeaders && !hasJsonHeaders) {
      ctx.addIssue({
        code: "custom",
        message:
          "Control-plane actor identity is missing. Provide BOPODEV_ACTOR_* vars or BOPODEV_REQUEST_HEADERS_JSON.",
        path: ["BOPODEV_REQUEST_HEADERS_JSON"]
      });
    }
  });
export type ControlPlaneRuntimeEnv = z.infer<typeof ControlPlaneRuntimeEnvSchema>;
export const ExecutionOutcomeKindSchema = z.enum(["completed", "blocked", "failed", "skipped"]);
export const ExecutionOutcomeActionSchema = z.object({
  type: z.string().min(1),
  targetId: z.string().min(1).optional(),
  status: z.enum(["ok", "warn", "error"]),
  detail: z.string().optional()
});
export const ExecutionOutcomeArtifactSchema = z.object({
  path: z.string().min(1),
  kind: z.string().min(1)
});
export const ExecutionOutcomeBlockerSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  retryable: z.boolean()
});
export const ExecutionOutcomeSchema = z.object({
  kind: ExecutionOutcomeKindSchema,
  issueIdsTouched: z.array(z.string().min(1)).default([]),
  artifacts: z.array(ExecutionOutcomeArtifactSchema).default([]),
  actions: z.array(ExecutionOutcomeActionSchema).default([]),
  blockers: z.array(ExecutionOutcomeBlockerSchema).default([]),
  nextSuggestedState: z.enum(["todo", "in_progress", "blocked", "in_review", "done"]).optional()
});
export type ExecutionOutcome = z.infer<typeof ExecutionOutcomeSchema>;
export const AgentFinalRunOutputArtifactSchema = z
  .object({
    kind: z.string().min(1),
    path: z.string().min(1)
  })
  .strict();
export type AgentFinalRunOutputArtifact = z.infer<typeof AgentFinalRunOutputArtifactSchema>;
export const AgentFinalRunOutputSchema = z
  .object({
    employee_comment: z.string().min(1),
    results: z.array(z.string().min(1)).default([]),
    errors: z.array(z.string().min(1)).default([]),
    artifacts: z.array(AgentFinalRunOutputArtifactSchema).default([])
  })
  .passthrough();
export type AgentFinalRunOutput = z.infer<typeof AgentFinalRunOutputSchema>;
export const RunUsdCostStatusSchema = z.enum(["exact", "estimated", "unknown"]);
export type RunUsdCostStatus = z.infer<typeof RunUsdCostStatusSchema>;
export const RunCompletionReasonSchema = z.enum([
  "task_completed",
  "no_assigned_work",
  "blocked",
  "provider_rate_limited",
  "provider_out_of_funds",
  "provider_quota_exhausted",
  "auth_error",
  "timeout",
  "cancelled",
  "contract_invalid",
  "runtime_error",
  "runtime_missing",
  "budget_hard_stop",
  "overlap_in_progress",
  "provider_unavailable",
  "unknown"
]);
export type RunCompletionReason = z.infer<typeof RunCompletionReasonSchema>;
export const RunResultStatusSchema = z.enum(["reported", "none_reported"]);
export type RunResultStatus = z.infer<typeof RunResultStatusSchema>;
export const RunArtifactSchema = z.object({
  path: z.string().min(1),
  kind: z.string().min(1),
  label: z.string().nullable().optional(),
  relativePath: z.string().nullable().optional(),
  absolutePath: z.string().nullable().optional(),
  /** Set by API after heartbeat: file exists under company workspace at resolved path */
  verifiedOnDisk: z.boolean().optional()
});
export type RunArtifact = z.infer<typeof RunArtifactSchema>;
export const RunCostSummarySchema = z.object({
  tokenInput: z.number().nonnegative().default(0),
  tokenOutput: z.number().nonnegative().default(0),
  usdCost: z.number().nonnegative().nullable().optional(),
  usdCostStatus: RunUsdCostStatusSchema.default("unknown"),
  pricingSource: z.string().nullable().optional(),
  source: z.string().nullable().optional()
});
export type RunCostSummary = z.infer<typeof RunCostSummarySchema>;
export const RunManagerReportSchema = z.object({
  agentName: z.string().min(1),
  providerType: ProviderTypeSchema,
  whatWasDone: z.string().min(1),
  resultSummary: z.string().min(1),
  artifactPaths: z.array(z.string().min(1)).default([]),
  blockers: z.array(z.string().min(1)).default([]),
  nextAction: z.string().min(1),
  costLine: z.string().min(1)
});
export type RunManagerReport = z.infer<typeof RunManagerReportSchema>;
export const RunCompletionReportSchema = z.object({
  finalStatus: z.enum(["completed", "failed"]),
  completionReason: RunCompletionReasonSchema,
  statusHeadline: z.string().min(1),
  summary: z.string().min(1),
  employeeComment: z.string().min(1),
  results: z.array(z.string().min(1)).default([]),
  errors: z.array(z.string().min(1)).default([]),
  resultStatus: RunResultStatusSchema.default("none_reported"),
  resultSummary: z.string().min(1),
  issueIds: z.array(EntityIdSchema).default([]),
  artifacts: z.array(RunArtifactSchema).default([]),
  blockers: z.array(z.string().min(1)).default([]),
  nextAction: z.string().min(1),
  cost: RunCostSummarySchema,
  managerReport: RunManagerReportSchema,
  outcome: ExecutionOutcomeSchema.nullable().optional(),
  debug: z
    .object({
      persistedRunStatus: z.string().nullable().optional(),
      failureType: z.string().nullable().optional(),
      errorType: z.string().nullable().optional(),
      errorMessage: z.string().nullable().optional()
    })
    .nullable()
    .optional()
});
export type RunCompletionReport = z.infer<typeof RunCompletionReportSchema>;
export const ThinkingEffortSchema = z.enum(["auto", "low", "medium", "high"]);
export type ThinkingEffort = z.infer<typeof ThinkingEffortSchema>;
export const SandboxModeSchema = z.enum(["workspace_write", "full_access"]);
export type SandboxMode = z.infer<typeof SandboxModeSchema>;
export const RunPolicySchema = z.object({
  sandboxMode: SandboxModeSchema.default("workspace_write"),
  allowWebSearch: z.boolean().default(false)
});
export type RunPolicy = z.infer<typeof RunPolicySchema>;
export const AgentRuntimeConfigSchema = z.object({
  runtimeCommand: z.string().optional(),
  runtimeArgs: z.array(z.string()).default([]),
  runtimeCwd: z.string().optional(),
  runtimeEnv: z.record(z.string(), z.string()).default({}),
  runtimeModel: z.string().optional(),
  runtimeThinkingEffort: ThinkingEffortSchema.default("auto"),
  bootstrapPrompt: z.string().optional(),
  runtimeTimeoutSec: z.number().int().nonnegative().default(0),
  interruptGraceSec: z.number().int().nonnegative().default(15),
  runPolicy: RunPolicySchema.default({
    sandboxMode: "workspace_write",
    allowWebSearch: false
  })
});
export type AgentRuntimeConfig = z.infer<typeof AgentRuntimeConfigSchema>;

export const PluginKindSchema = z.enum(["lifecycle", "tool", "integration"]);
export type PluginKind = z.infer<typeof PluginKindSchema>;
export const PluginHookSchema = z.enum([
  "beforeClaim",
  "afterClaim",
  "beforeAdapterExecute",
  "afterAdapterExecute",
  "beforePersist",
  "afterPersist",
  "onError"
]);
export type PluginHook = z.infer<typeof PluginHookSchema>;
export const PluginCapabilitySchema = z.enum([
  "emit_audit",
  "read_memory",
  "write_memory",
  "queue_publish",
  "network",
  "tool_expose",
  "issue_write"
]);
export type PluginCapability = z.infer<typeof PluginCapabilitySchema>;
export const PluginRuntimeTypeSchema = z.enum(["builtin", "stdio", "http", "prompt"]);
export type PluginRuntimeType = z.infer<typeof PluginRuntimeTypeSchema>;
export const PluginWebhookRequestSchema = z.object({
  url: z.string().url(),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).default("POST"),
  headers: z.record(z.string(), z.string()).default({}),
  body: z.record(z.string(), z.unknown()).optional(),
  timeoutMs: z.number().int().positive().max(15000).default(5000)
});
export type PluginWebhookRequest = z.infer<typeof PluginWebhookRequestSchema>;
export const PluginTraceEventSchema = z.object({
  eventType: z.string().min(1),
  payload: z.record(z.string(), z.unknown()).default({})
});
export type PluginTraceEvent = z.infer<typeof PluginTraceEventSchema>;
export const PluginManifestSchema = z.object({
  id: z.string().min(1),
  version: z.string().min(1),
  displayName: z.string().min(1),
  description: z.string().optional(),
  kind: PluginKindSchema,
  hooks: z.array(PluginHookSchema).default([]),
  capabilities: z.array(PluginCapabilitySchema).default([]),
  runtime: z.object({
    type: PluginRuntimeTypeSchema,
    entrypoint: z.string().min(1),
    timeoutMs: z.number().int().positive().max(120000).default(10000),
    retryCount: z.number().int().nonnegative().max(2).default(0),
    promptTemplate: z.string().optional()
  }),
  configSchema: z.record(z.string(), z.unknown()).optional(),
  minimumBopoVersion: z.string().optional()
});
export type PluginManifest = z.infer<typeof PluginManifestSchema>;
export const PluginPromptExecutionResultSchema = z.object({
  promptAppend: z.string().max(20000).optional(),
  traceEvents: z.array(PluginTraceEventSchema).max(20).default([]),
  webhookRequests: z.array(PluginWebhookRequestSchema).max(5).default([]),
  diagnostics: z.record(z.string(), z.unknown()).default({})
});
export type PluginPromptExecutionResult = z.infer<typeof PluginPromptExecutionResultSchema>;
export const PluginRunStatusSchema = z.enum(["ok", "skipped", "failed", "blocked"]);
export type PluginRunStatus = z.infer<typeof PluginRunStatusSchema>;
export const PluginInvocationResultSchema = z.object({
  status: PluginRunStatusSchema,
  summary: z.string().default(""),
  diagnostics: z.record(z.string(), z.unknown()).default({}),
  blockers: z
    .array(
      z.object({
        code: z.string().min(1),
        message: z.string().min(1),
        retryable: z.boolean().default(false)
      })
    )
    .default([]),
  metadataPatch: z.record(z.string(), z.unknown()).optional()
});
export type PluginInvocationResult = z.infer<typeof PluginInvocationResultSchema>;

export const AgentCreateRequestSchema = z.object({
  managerAgentId: z.string().optional(),
  role: z.string().min(1).optional(),
  roleKey: AgentRoleKeySchema.optional(),
  title: z.string().nullable().optional(),
  name: z.string().min(1),
  providerType: ProviderTypeSchema,
  heartbeatCron: z.string().min(1),
  monthlyBudgetUsd: z.number().nonnegative(),
  canHireAgents: z.boolean().default(false),
  sourceIssueId: z.string().min(1).optional(),
  sourceIssueIds: z.array(z.string().min(1)).default([]),
  delegationIntent: z
    .object({
      intentType: z.literal("agent_hiring_request"),
      requestedRole: z.string().nullable().optional(),
      requestedRoleKey: AgentRoleKeySchema.nullable().optional(),
      requestedTitle: z.string().nullable().optional(),
      requestedName: z.string().nullable().optional(),
      requestedManagerAgentId: z.string().nullable().optional(),
      requestedProviderType: ProviderTypeSchema.nullable().optional(),
      requestedRuntimeModel: z.string().nullable().optional()
    })
    .optional(),
  requestApproval: z.boolean().default(true),
  runtimeConfig: AgentRuntimeConfigSchema.partial().default({})
});
export type AgentCreateRequest = z.infer<typeof AgentCreateRequestSchema>;

export const AgentUpdateRequestSchema = z
  .object({
    managerAgentId: z.string().nullable().optional(),
    role: z.string().min(1).optional(),
    roleKey: AgentRoleKeySchema.nullable().optional(),
    title: z.string().nullable().optional(),
    name: z.string().min(1).optional(),
    providerType: ProviderTypeSchema.optional(),
    status: AgentStatusSchema.optional(),
    heartbeatCron: z.string().min(1).optional(),
    monthlyBudgetUsd: z.number().nonnegative().optional(),
    canHireAgents: z.boolean().optional(),
    runtimeConfig: AgentRuntimeConfigSchema.partial().optional()
  })
  .refine((payload) => Object.keys(payload).length > 0, "At least one field must be provided.");
export type AgentUpdateRequest = z.infer<typeof AgentUpdateRequestSchema>;

export const AgentSchema = z.object({
  id: EntityIdSchema,
  companyId: EntityIdSchema,
  managerAgentId: EntityIdSchema.nullable(),
  role: z.string().min(1),
  roleKey: AgentRoleKeySchema.nullable().optional(),
  title: z.string().nullable().optional(),
  name: z.string().min(1),
  providerType: ProviderTypeSchema,
  status: AgentStatusSchema,
  heartbeatCron: z.string().min(1),
  monthlyBudgetUsd: z.number().nonnegative(),
  usedBudgetUsd: z.number().nonnegative().default(0),
  tokenUsage: z.number().nonnegative().default(0),
  canHireAgents: z.boolean().default(false),
  avatarSeed: z.string().optional(),
  runtimeCommand: z.string().nullable().optional(),
  runtimeArgsJson: z.string().nullable().optional(),
  runtimeCwd: z.string().nullable().optional(),
  runtimeEnvJson: z.string().nullable().optional(),
  runtimeModel: z.string().nullable().optional(),
  runtimeThinkingEffort: ThinkingEffortSchema.nullable().optional(),
  bootstrapPrompt: z.string().nullable().optional(),
  runtimeTimeoutSec: z.number().int().nonnegative().nullable().optional(),
  interruptGraceSec: z.number().int().nonnegative().nullable().optional(),
  runPolicyJson: z.string().nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string()
});

export const ApprovalActionSchema = z.enum([
  "hire_agent",
  "activate_goal",
  "override_budget",
  "pause_agent",
  "terminate_agent",
  "promote_memory_fact",
  "grant_plugin_capabilities",
  "apply_template"
]);

export const ApprovalRequestSchema = z.object({
  id: EntityIdSchema,
  companyId: EntityIdSchema,
  requestedByAgentId: EntityIdSchema.nullable(),
  action: ApprovalActionSchema,
  payload: z.record(z.string(), z.unknown()),
  status: z.enum(["pending", "approved", "rejected", "overridden"]),
  createdAt: z.string(),
  resolvedAt: z.string().nullable()
});
export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;

export const ApprovalNotificationEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("approvals.snapshot"),
    approvals: z.array(ApprovalRequestSchema)
  }),
  z.object({
    type: z.literal("approval.created"),
    approval: ApprovalRequestSchema
  }),
  z.object({
    type: z.literal("approval.resolved"),
    approval: ApprovalRequestSchema
  })
]);
export type ApprovalNotificationEvent = z.infer<typeof ApprovalNotificationEventSchema>;

export const GovernanceInboxItemSchema = z.object({
  approval: ApprovalRequestSchema,
  seenAt: z.string().nullable(),
  dismissedAt: z.string().nullable(),
  isPending: z.boolean()
});
export type GovernanceInboxItem = z.infer<typeof GovernanceInboxItemSchema>;

export const GovernanceInboxResponseSchema = z.object({
  actorId: z.string().min(1),
  resolvedWindowDays: z.number().int().positive(),
  items: z.array(GovernanceInboxItemSchema)
});
export type GovernanceInboxResponse = z.infer<typeof GovernanceInboxResponseSchema>;

export const BoardAttentionCategorySchema = z.enum([
  "approval_required",
  "blocker_escalation",
  "budget_hard_stop",
  "stalled_work",
  "run_failure_spike",
  "board_mentioned_comment"
]);
export type BoardAttentionCategory = z.infer<typeof BoardAttentionCategorySchema>;

export const BoardAttentionSeveritySchema = z.enum(["info", "warning", "critical"]);
export type BoardAttentionSeverity = z.infer<typeof BoardAttentionSeveritySchema>;

export const BoardAttentionRequiredActorSchema = z.enum(["board", "member", "agent", "system"]);
export type BoardAttentionRequiredActor = z.infer<typeof BoardAttentionRequiredActorSchema>;

export const BoardAttentionStateSchema = z.enum(["open", "acknowledged", "resolved", "dismissed"]);
export type BoardAttentionState = z.infer<typeof BoardAttentionStateSchema>;

export const BoardAttentionEvidenceSchema = z.object({
  issueId: EntityIdSchema.optional(),
  runId: EntityIdSchema.optional(),
  projectId: EntityIdSchema.optional(),
  approvalId: EntityIdSchema.optional(),
  commentId: EntityIdSchema.optional(),
  agentId: EntityIdSchema.optional()
});
export type BoardAttentionEvidence = z.infer<typeof BoardAttentionEvidenceSchema>;

export const BoardAttentionItemSchema = z.object({
  key: z.string().min(1),
  category: BoardAttentionCategorySchema,
  severity: BoardAttentionSeveritySchema,
  requiredActor: BoardAttentionRequiredActorSchema,
  title: z.string().min(1),
  contextSummary: z.string().min(1),
  actionLabel: z.string().min(1),
  actionHref: z.string().min(1),
  impactSummary: z.string().min(1),
  evidence: BoardAttentionEvidenceSchema.default({}),
  sourceTimestamp: z.string(),
  state: BoardAttentionStateSchema,
  seenAt: z.string().nullable(),
  acknowledgedAt: z.string().nullable(),
  dismissedAt: z.string().nullable(),
  resolvedAt: z.string().nullable()
});
export type BoardAttentionItem = z.infer<typeof BoardAttentionItemSchema>;

export const BoardAttentionListResponseSchema = z.object({
  actorId: z.string().min(1),
  items: z.array(BoardAttentionItemSchema)
});
export type BoardAttentionListResponse = z.infer<typeof BoardAttentionListResponseSchema>;

export const BoardAttentionNotificationEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("attention.snapshot"),
    items: z.array(BoardAttentionItemSchema)
  }),
  z.object({
    type: z.literal("attention.updated"),
    item: BoardAttentionItemSchema
  }),
  z.object({
    type: z.literal("attention.resolved"),
    key: z.string().min(1)
  })
]);
export type BoardAttentionNotificationEvent = z.infer<typeof BoardAttentionNotificationEventSchema>;

export const OfficeRoomSchema = z.enum(["waiting_room", "work_space", "security"]);
export type OfficeRoom = z.infer<typeof OfficeRoomSchema>;

export const OfficeOccupantKindSchema = z.enum(["agent", "hire_candidate"]);
export type OfficeOccupantKind = z.infer<typeof OfficeOccupantKindSchema>;

export const OfficeOccupantStatusSchema = z.enum(["idle", "working", "waiting_for_approval", "paused"]);
export type OfficeOccupantStatus = z.infer<typeof OfficeOccupantStatusSchema>;

export const OfficeOccupantSchema = z.object({
  id: z.string().min(1),
  kind: OfficeOccupantKindSchema,
  companyId: EntityIdSchema,
  agentId: EntityIdSchema.nullable(),
  approvalId: EntityIdSchema.nullable(),
  displayName: z.string().min(1),
  role: z.string().nullable(),
  room: OfficeRoomSchema,
  status: OfficeOccupantStatusSchema,
  taskLabel: z.string().min(1),
  providerType: ProviderTypeSchema.nullable(),
  avatarSeed: z.string().nullable().optional(),
  focusEntityType: z.enum(["issue", "approval", "agent", "system"]).nullable(),
  focusEntityId: z.string().nullable(),
  updatedAt: z.string()
});
export type OfficeOccupant = z.infer<typeof OfficeOccupantSchema>;

export const OfficeSpaceEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("office.snapshot"),
    occupants: z.array(OfficeOccupantSchema)
  }),
  z.object({
    type: z.literal("office.occupant.updated"),
    occupant: OfficeOccupantSchema
  }),
  z.object({
    type: z.literal("office.occupant.left"),
    occupantId: z.string().min(1)
  })
]);
export type OfficeSpaceEvent = z.infer<typeof OfficeSpaceEventSchema>;

export const HeartbeatRunTranscriptEventKindSchema = z.enum([
  "system",
  "assistant",
  "thinking",
  "tool_call",
  "tool_result",
  "result",
  "stderr"
]);
export type HeartbeatRunTranscriptEventKind = z.infer<typeof HeartbeatRunTranscriptEventKindSchema>;
export const HeartbeatRunTranscriptSignalLevelSchema = z.enum(["high", "medium", "low", "noise"]);
export type HeartbeatRunTranscriptSignalLevel = z.infer<typeof HeartbeatRunTranscriptSignalLevelSchema>;
export const HeartbeatRunTranscriptSourceSchema = z.enum(["stdout", "stderr", "trace_fallback"]);
export type HeartbeatRunTranscriptSource = z.infer<typeof HeartbeatRunTranscriptSourceSchema>;

export const HeartbeatRunRealtimeEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("runs.snapshot"),
    runs: z.array(
      z.object({
        runId: EntityIdSchema,
        status: z.enum(["started", "completed", "failed", "skipped"]),
        message: z.string().nullable().optional(),
        startedAt: z.string(),
        finishedAt: z.string().nullable().optional()
      })
    ),
    transcripts: z.array(
      z.object({
        runId: EntityIdSchema,
        messages: z.array(
          z.object({
            id: EntityIdSchema,
            runId: EntityIdSchema,
            sequence: z.number().int().nonnegative(),
            kind: HeartbeatRunTranscriptEventKindSchema,
            label: z.string().nullable().optional(),
            text: z.string().nullable().optional(),
            payload: z.string().nullable().optional(),
            signalLevel: HeartbeatRunTranscriptSignalLevelSchema.optional(),
            groupKey: z.string().nullable().optional(),
            source: HeartbeatRunTranscriptSourceSchema.optional(),
            createdAt: z.string()
          })
        ),
        nextCursor: z.string().nullable()
      })
    )
  }),
  z.object({
    type: z.literal("run.status.updated"),
    runId: EntityIdSchema,
    status: z.enum(["started", "completed", "failed", "skipped"]),
    message: z.string().nullable().optional(),
    startedAt: z.string().optional(),
    finishedAt: z.string().nullable().optional()
  }),
  z.object({
    type: z.literal("run.transcript.append"),
    runId: EntityIdSchema,
    messages: z.array(
      z.object({
        id: EntityIdSchema,
        runId: EntityIdSchema,
        sequence: z.number().int().nonnegative(),
        kind: HeartbeatRunTranscriptEventKindSchema,
        label: z.string().nullable().optional(),
        text: z.string().nullable().optional(),
        payload: z.string().nullable().optional(),
        signalLevel: HeartbeatRunTranscriptSignalLevelSchema.optional(),
        groupKey: z.string().nullable().optional(),
        source: HeartbeatRunTranscriptSourceSchema.optional(),
        createdAt: z.string()
      })
    )
  }),
  z.object({
    type: z.literal("run.transcript.snapshot"),
    runId: EntityIdSchema,
    messages: z.array(
      z.object({
        id: EntityIdSchema,
        runId: EntityIdSchema,
        sequence: z.number().int().nonnegative(),
        kind: HeartbeatRunTranscriptEventKindSchema,
        label: z.string().nullable().optional(),
        text: z.string().nullable().optional(),
        payload: z.string().nullable().optional(),
        signalLevel: HeartbeatRunTranscriptSignalLevelSchema.optional(),
        groupKey: z.string().nullable().optional(),
        source: HeartbeatRunTranscriptSourceSchema.optional(),
        createdAt: z.string()
      })
    ),
    nextCursor: z.string().nullable()
  })
]);
export type HeartbeatRunRealtimeEvent = z.infer<typeof HeartbeatRunRealtimeEventSchema>;

export const RealtimeChannelSchema = z.enum(["governance", "office-space", "heartbeat-runs", "attention"]);
export type RealtimeChannel = z.infer<typeof RealtimeChannelSchema>;

export const RealtimeEventEnvelopeSchema = z.discriminatedUnion("channel", [
  z.object({
    channel: z.literal("governance"),
    event: ApprovalNotificationEventSchema
  }),
  z.object({
    channel: z.literal("office-space"),
    event: OfficeSpaceEventSchema
  }),
  z.object({
    channel: z.literal("heartbeat-runs"),
    event: HeartbeatRunRealtimeEventSchema
  }),
  z.object({
    channel: z.literal("attention"),
    event: BoardAttentionNotificationEventSchema
  })
]);
export type RealtimeEventEnvelope = z.infer<typeof RealtimeEventEnvelopeSchema>;

export const RealtimeSubscribedMessageSchema = z.object({
  kind: z.literal("subscribed"),
  companyId: EntityIdSchema,
  channels: z.array(RealtimeChannelSchema)
});

export const RealtimeEventMessageSchema = z.discriminatedUnion("channel", [
  z.object({
    kind: z.literal("event"),
    companyId: EntityIdSchema,
    channel: z.literal("governance"),
    event: ApprovalNotificationEventSchema
  }),
  z.object({
    kind: z.literal("event"),
    companyId: EntityIdSchema,
    channel: z.literal("office-space"),
    event: OfficeSpaceEventSchema
  }),
  z.object({
    kind: z.literal("event"),
    companyId: EntityIdSchema,
    channel: z.literal("heartbeat-runs"),
    event: HeartbeatRunRealtimeEventSchema
  }),
  z.object({
    kind: z.literal("event"),
    companyId: EntityIdSchema,
    channel: z.literal("attention"),
    event: BoardAttentionNotificationEventSchema
  })
]);

export const RealtimeMessageSchema = z.union([
  RealtimeSubscribedMessageSchema,
  RealtimeEventMessageSchema
]);
export type RealtimeMessage = z.infer<typeof RealtimeMessageSchema>;

export const CostLedgerEntrySchema = z.object({
  id: EntityIdSchema,
  companyId: EntityIdSchema,
  runId: EntityIdSchema.nullable().optional(),
  projectId: EntityIdSchema.nullable(),
  issueId: EntityIdSchema.nullable(),
  agentId: EntityIdSchema.nullable(),
  providerType: ProviderTypeSchema,
  runtimeModelId: z.string().nullable().optional(),
  pricingProviderType: z.enum(["openai_api", "anthropic_api", "opencode", "gemini_api"]).nullable().optional(),
  pricingModelId: z.string().nullable().optional(),
  pricingSource: z.enum(["exact", "missing"]).nullable().optional(),
  tokenInput: z.number().int().nonnegative(),
  tokenOutput: z.number().int().nonnegative(),
  usdCost: z.number().nonnegative(),
  usdCostStatus: RunUsdCostStatusSchema.nullable().optional(),
  createdAt: z.string()
});

export const AuditEventSchema = z.object({
  id: EntityIdSchema,
  companyId: EntityIdSchema,
  actorType: z.enum(["human", "agent", "system"]),
  actorId: z.string().nullable(),
  eventType: z.string().min(1),
  entityType: z.string().min(1),
  entityId: z.string().min(1),
  correlationId: z.string().nullable(),
  payload: z.record(z.string(), z.unknown()),
  createdAt: z.string()
});

export const HeartbeatRunTypeSchema = z.enum([
  "work",
  "no_assigned_work",
  "budget_skip",
  "overlap_skip",
  "other_skip",
  "failed",
  "running"
]);

export const HeartbeatRunSchema = z.object({
  id: EntityIdSchema,
  companyId: EntityIdSchema,
  agentId: EntityIdSchema,
  status: z.enum(["started", "completed", "failed", "skipped"]),
  publicStatus: z.enum(["started", "completed", "failed"]).optional(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  message: z.string().optional(),
  runType: HeartbeatRunTypeSchema.optional()
});

export const HeartbeatRunMessageSchema = z.object({
  id: EntityIdSchema,
  companyId: EntityIdSchema,
  runId: EntityIdSchema,
  sequence: z.number().int().nonnegative(),
  kind: HeartbeatRunTranscriptEventKindSchema,
  label: z.string().nullable().optional(),
  text: z.string().nullable().optional(),
  payload: z.string().nullable().optional(),
  signalLevel: HeartbeatRunTranscriptSignalLevelSchema.optional(),
  groupKey: z.string().nullable().optional(),
  source: HeartbeatRunTranscriptSourceSchema.optional(),
  createdAt: z.string()
});
export type HeartbeatRunMessage = z.infer<typeof HeartbeatRunMessageSchema>;

export const ListHeartbeatRunMessagesResponseSchema = z.object({
  runId: EntityIdSchema,
  items: z.array(HeartbeatRunMessageSchema),
  nextCursor: z.string().nullable()
});
export type ListHeartbeatRunMessagesResponse = z.infer<typeof ListHeartbeatRunMessagesResponseSchema>;

export const HeartbeatRunDetailSchema = z.object({
  run: HeartbeatRunSchema,
  details: z
    .object({
      status: z.string().nullable().optional(),
      message: z.string().nullable().optional(),
      errorMessage: z.string().nullable().optional(),
      result: z.string().nullable().optional(),
      issueIds: z.array(EntityIdSchema).optional(),
      outcome: ExecutionOutcomeSchema.nullable().optional(),
      report: RunCompletionReportSchema.nullable().optional(),
      usage: z
        .object({
          tokenInput: z.number().nonnegative().optional(),
          tokenOutput: z.number().nonnegative().optional(),
          usdCost: z.number().nonnegative().optional(),
          usdCostStatus: RunUsdCostStatusSchema.optional(),
          source: z.string().nullable().optional()
        })
        .nullable()
        .optional(),
      trace: z.record(z.string(), z.unknown()).nullable().optional(),
      diagnostics: z.record(z.string(), z.unknown()).nullable().optional()
    })
    .nullable(),
  transcript: z.object({
    hasPersistedMessages: z.boolean(),
    fallbackFromTrace: z.boolean(),
    truncated: z.boolean()
  })
});
export type HeartbeatRunDetail = z.infer<typeof HeartbeatRunDetailSchema>;

export const PaginatedSchema = <T extends z.ZodTypeAny>(item: T) =>
  z.object({
    items: z.array(item),
    nextCursor: z.string().nullable()
  });
