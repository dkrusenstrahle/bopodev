import { sql } from "drizzle-orm";
import { boolean, integer, numeric, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";

export const companies = pgTable("companies", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  mission: text("mission"),
  createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull()
});

export const projects = pgTable("projects", {
  id: text("id").primaryKey(),
  companyId: text("company_id")
    .notNull()
    .references(() => companies.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description"),
  status: text("status").notNull().default("planned"),
  plannedStartAt: timestamp("planned_start_at", { mode: "date" }),
  executionWorkspacePolicy: text("execution_workspace_policy"),
  createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { mode: "date" }).defaultNow().notNull()
});

export const projectWorkspaces = pgTable("project_workspaces", {
  id: text("id").primaryKey(),
  companyId: text("company_id")
    .notNull()
    .references(() => companies.id, { onDelete: "cascade" }),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  cwd: text("cwd"),
  repoUrl: text("repo_url"),
  repoRef: text("repo_ref"),
  isPrimary: boolean("is_primary").notNull().default(false),
  createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { mode: "date" }).defaultNow().notNull()
});

export const goals = pgTable("goals", {
  id: text("id").primaryKey(),
  companyId: text("company_id")
    .notNull()
    .references(() => companies.id, { onDelete: "cascade" }),
  projectId: text("project_id").references(() => projects.id, { onDelete: "set null" }),
  parentGoalId: text("parent_goal_id"),
  level: text("level").notNull(),
  title: text("title").notNull(),
  description: text("description"),
  status: text("status").notNull().default("draft"),
  createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { mode: "date" }).defaultNow().notNull()
});

export const agents = pgTable("agents", {
  id: text("id").primaryKey(),
  companyId: text("company_id")
    .notNull()
    .references(() => companies.id, { onDelete: "cascade" }),
  managerAgentId: text("manager_agent_id"),
  role: text("role").notNull(),
  name: text("name").notNull(),
  providerType: text("provider_type").notNull(),
  status: text("status").notNull().default("idle"),
  heartbeatCron: text("heartbeat_cron").notNull(),
  monthlyBudgetUsd: numeric("monthly_budget_usd", { precision: 12, scale: 4 })
    .notNull()
    .default("0"),
  usedBudgetUsd: numeric("used_budget_usd", { precision: 12, scale: 4 })
    .notNull()
    .default("0"),
  tokenUsage: integer("token_usage").notNull().default(0),
  canHireAgents: boolean("can_hire_agents").notNull().default(false),
  avatarSeed: text("avatar_seed").notNull().default(""),
  runtimeCommand: text("runtime_command"),
  runtimeArgsJson: text("runtime_args_json").notNull().default("[]"),
  runtimeCwd: text("runtime_cwd"),
  runtimeEnvJson: text("runtime_env_json").notNull().default("{}"),
  runtimeModel: text("runtime_model"),
  runtimeThinkingEffort: text("runtime_thinking_effort").notNull().default("auto"),
  bootstrapPrompt: text("bootstrap_prompt"),
  runtimeTimeoutSec: integer("runtime_timeout_sec").notNull().default(0),
  interruptGraceSec: integer("interrupt_grace_sec").notNull().default(15),
  runPolicyJson: text("run_policy_json").notNull().default("{}"),
  stateBlob: text("state_blob").notNull().default("{}"),
  createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { mode: "date" }).defaultNow().notNull()
});

export const issues = pgTable("issues", {
  id: text("id").primaryKey(),
  companyId: text("company_id")
    .notNull()
    .references(() => companies.id, { onDelete: "cascade" }),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  parentIssueId: text("parent_issue_id"),
  title: text("title").notNull(),
  body: text("body"),
  status: text("status").notNull().default("todo"),
  priority: text("priority").notNull().default("none"),
  assigneeAgentId: text("assignee_agent_id"),
  labelsJson: text("labels_json").notNull().default("[]"),
  tagsJson: text("tags_json").notNull().default("[]"),
  isClaimed: boolean("is_claimed").notNull().default(false),
  claimedByHeartbeatRunId: text("claimed_by_heartbeat_run_id"),
  createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { mode: "date" }).defaultNow().notNull()
});

export const issueComments = pgTable("issue_comments", {
  id: text("id").primaryKey(),
  issueId: text("issue_id")
    .notNull()
    .references(() => issues.id, { onDelete: "cascade" }),
  companyId: text("company_id")
    .notNull()
    .references(() => companies.id, { onDelete: "cascade" }),
  authorType: text("author_type").notNull(),
  authorId: text("author_id"),
  recipientsJson: text("recipients_json").notNull().default("[]"),
  runId: text("run_id"),
  body: text("body").notNull(),
  createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull()
});

export const issueAttachments = pgTable("issue_attachments", {
  id: text("id").primaryKey(),
  companyId: text("company_id")
    .notNull()
    .references(() => companies.id, { onDelete: "cascade" }),
  issueId: text("issue_id")
    .notNull()
    .references(() => issues.id, { onDelete: "cascade" }),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  fileName: text("file_name").notNull(),
  mimeType: text("mime_type"),
  fileSizeBytes: integer("file_size_bytes").notNull(),
  relativePath: text("relative_path").notNull(),
  uploadedByActorType: text("uploaded_by_actor_type").notNull().default("human"),
  uploadedByActorId: text("uploaded_by_actor_id"),
  createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull()
});

export const activityLogs = pgTable("activity_logs", {
  id: text("id").primaryKey(),
  companyId: text("company_id")
    .notNull()
    .references(() => companies.id, { onDelete: "cascade" }),
  issueId: text("issue_id").references(() => issues.id, { onDelete: "set null" }),
  actorType: text("actor_type").notNull(),
  actorId: text("actor_id"),
  eventType: text("event_type").notNull(),
  payloadJson: text("payload_json").notNull().default("{}"),
  createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull()
});

export const heartbeatRuns = pgTable("heartbeat_runs", {
  id: text("id").primaryKey(),
  companyId: text("company_id")
    .notNull()
    .references(() => companies.id, { onDelete: "cascade" }),
  agentId: text("agent_id")
    .notNull()
    .references(() => agents.id, { onDelete: "cascade" }),
  status: text("status").notNull().default("started"),
  startedAt: timestamp("started_at", { mode: "date" }).defaultNow().notNull(),
  finishedAt: timestamp("finished_at", { mode: "date" }),
  message: text("message")
});

export const heartbeatRunMessages = pgTable("heartbeat_run_messages", {
  id: text("id").primaryKey(),
  companyId: text("company_id")
    .notNull()
    .references(() => companies.id, { onDelete: "cascade" }),
  runId: text("run_id")
    .notNull()
    .references(() => heartbeatRuns.id, { onDelete: "cascade" }),
  sequence: integer("sequence").notNull(),
  kind: text("kind").notNull(),
  label: text("label"),
  text: text("text"),
  payloadJson: text("payload_json"),
  signalLevel: text("signal_level"),
  groupKey: text("group_key"),
  source: text("source"),
  createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull()
});

export const approvalRequests = pgTable("approval_requests", {
  id: text("id").primaryKey(),
  companyId: text("company_id")
    .notNull()
    .references(() => companies.id, { onDelete: "cascade" }),
  requestedByAgentId: text("requested_by_agent_id"),
  action: text("action").notNull(),
  payloadJson: text("payload_json").notNull().default("{}"),
  status: text("status").notNull().default("pending"),
  createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
  resolvedAt: timestamp("resolved_at", { mode: "date" })
});

export const approvalInboxStates = pgTable(
  "approval_inbox_states",
  {
    companyId: text("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    actorId: text("actor_id").notNull(),
    approvalId: text("approval_id")
      .notNull()
      .references(() => approvalRequests.id, { onDelete: "cascade" }),
    seenAt: timestamp("seen_at", { mode: "date" }),
    dismissedAt: timestamp("dismissed_at", { mode: "date" }),
    createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { mode: "date" }).defaultNow().notNull()
  },
  (table) => [primaryKey({ columns: [table.companyId, table.actorId, table.approvalId] })]
);

export const costLedger = pgTable("cost_ledger", {
  id: text("id").primaryKey(),
  companyId: text("company_id")
    .notNull()
    .references(() => companies.id, { onDelete: "cascade" }),
  projectId: text("project_id").references(() => projects.id, { onDelete: "set null" }),
  issueId: text("issue_id").references(() => issues.id, { onDelete: "set null" }),
  agentId: text("agent_id").references(() => agents.id, { onDelete: "set null" }),
  providerType: text("provider_type").notNull(),
  runtimeModelId: text("runtime_model_id"),
  pricingProviderType: text("pricing_provider_type"),
  pricingModelId: text("pricing_model_id"),
  pricingSource: text("pricing_source"),
  tokenInput: integer("token_input").notNull().default(0),
  tokenOutput: integer("token_output").notNull().default(0),
  usdCost: numeric("usd_cost", { precision: 12, scale: 6 }).notNull().default("0"),
  createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull()
});

export const auditEvents = pgTable("audit_events", {
  id: text("id").primaryKey(),
  companyId: text("company_id")
    .notNull()
    .references(() => companies.id, { onDelete: "cascade" }),
  actorType: text("actor_type").notNull(),
  actorId: text("actor_id"),
  eventType: text("event_type").notNull(),
  entityType: text("entity_type").notNull(),
  entityId: text("entity_id").notNull(),
  correlationId: text("correlation_id"),
  payloadJson: text("payload_json").notNull().default("{}"),
  createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull()
});

export const plugins = pgTable("plugins", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  version: text("version").notNull(),
  kind: text("kind").notNull(),
  runtimeType: text("runtime_type").notNull(),
  runtimeEntrypoint: text("runtime_entrypoint").notNull(),
  hooksJson: text("hooks_json").notNull().default("[]"),
  capabilitiesJson: text("capabilities_json").notNull().default("[]"),
  manifestJson: text("manifest_json").notNull().default("{}"),
  createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { mode: "date" }).defaultNow().notNull()
});

export const templates = pgTable("templates", {
  id: text("id").primaryKey(),
  companyId: text("company_id")
    .notNull()
    .references(() => companies.id, { onDelete: "cascade" }),
  slug: text("slug").notNull(),
  name: text("name").notNull(),
  description: text("description"),
  currentVersion: text("current_version").notNull().default("1.0.0"),
  status: text("status").notNull().default("draft"),
  visibility: text("visibility").notNull().default("company"),
  variablesJson: text("variables_json").notNull().default("[]"),
  createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { mode: "date" }).defaultNow().notNull()
});

export const templateVersions = pgTable("template_versions", {
  id: text("id").primaryKey(),
  companyId: text("company_id")
    .notNull()
    .references(() => companies.id, { onDelete: "cascade" }),
  templateId: text("template_id")
    .notNull()
    .references(() => templates.id, { onDelete: "cascade" }),
  version: text("version").notNull(),
  manifestJson: text("manifest_json").notNull().default("{}"),
  createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull()
});

export const templateInstalls = pgTable("template_installs", {
  id: text("id").primaryKey(),
  companyId: text("company_id")
    .notNull()
    .references(() => companies.id, { onDelete: "cascade" }),
  templateId: text("template_id").references(() => templates.id, { onDelete: "set null" }),
  templateVersionId: text("template_version_id").references(() => templateVersions.id, { onDelete: "set null" }),
  status: text("status").notNull().default("applied"),
  summaryJson: text("summary_json").notNull().default("{}"),
  variablesJson: text("variables_json").notNull().default("{}"),
  createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull()
});

export const modelPricing = pgTable(
  "model_pricing",
  {
    companyId: text("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    providerType: text("provider_type").notNull(),
    modelId: text("model_id").notNull(),
    displayName: text("display_name"),
    inputUsdPer1M: numeric("input_usd_per_1m", { precision: 12, scale: 6 }).notNull().default("0"),
    outputUsdPer1M: numeric("output_usd_per_1m", { precision: 12, scale: 6 }).notNull().default("0"),
    currency: text("currency").notNull().default("USD"),
    updatedAt: timestamp("updated_at", { mode: "date" }).defaultNow().notNull(),
    updatedBy: text("updated_by")
  },
  (table) => [primaryKey({ columns: [table.companyId, table.providerType, table.modelId] })]
);

export const pluginConfigs = pgTable(
  "plugin_configs",
  {
    companyId: text("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    pluginId: text("plugin_id")
      .notNull()
      .references(() => plugins.id, { onDelete: "cascade" }),
    enabled: boolean("enabled").notNull().default(false),
    priority: integer("priority").notNull().default(100),
    configJson: text("config_json").notNull().default("{}"),
    grantedCapabilitiesJson: text("granted_capabilities_json").notNull().default("[]"),
    createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { mode: "date" }).defaultNow().notNull()
  },
  (table) => [primaryKey({ columns: [table.companyId, table.pluginId] })]
);

export const pluginRuns = pgTable("plugin_runs", {
  id: text("id").primaryKey(),
  companyId: text("company_id")
    .notNull()
    .references(() => companies.id, { onDelete: "cascade" }),
  runId: text("run_id").references(() => heartbeatRuns.id, { onDelete: "cascade" }),
  pluginId: text("plugin_id")
    .notNull()
    .references(() => plugins.id, { onDelete: "cascade" }),
  hook: text("hook").notNull(),
  status: text("status").notNull(),
  durationMs: integer("duration_ms").notNull().default(0),
  error: text("error"),
  diagnosticsJson: text("diagnostics_json").notNull().default("{}"),
  createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull()
});

export const agentIssueLabels = pgTable(
  "agent_issue_labels",
  {
    companyId: text("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    issueId: text("issue_id")
      .notNull()
      .references(() => issues.id, { onDelete: "cascade" }),
    label: text("label").notNull()
  },
  (table) => [primaryKey({ columns: [table.companyId, table.issueId, table.label] })]
);

export const schema = {
  companies,
  projects,
  goals,
  agents,
  issues,
  issueComments,
  issueAttachments,
  activityLogs,
  heartbeatRuns,
  heartbeatRunMessages,
  approvalRequests,
  approvalInboxStates,
  costLedger,
  auditEvents,
  plugins,
  pluginConfigs,
  pluginRuns,
  templates,
  templateVersions,
  templateInstalls,
  modelPricing,
  agentIssueLabels,
  projectWorkspaces
};

export const touchUpdatedAtSql = sql`CURRENT_TIMESTAMP`;
