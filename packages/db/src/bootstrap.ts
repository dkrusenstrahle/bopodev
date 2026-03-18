import { sql } from "drizzle-orm";
import { createDb } from "./client";

export async function bootstrapDatabase(dbPath?: string) {
  const { db, client } = await createDb(dbPath);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS companies (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      mission TEXT,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'planned',
      planned_start_at TIMESTAMP,
      monthly_budget_usd NUMERIC(12, 4) NOT NULL DEFAULT 100,
      used_budget_usd NUMERIC(12, 4) NOT NULL DEFAULT 0,
      budget_window_start_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      execution_workspace_policy TEXT,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  await db.execute(sql`
    ALTER TABLE projects
    ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'planned';
  `);
  await db.execute(sql`
    ALTER TABLE projects
    ADD COLUMN IF NOT EXISTS planned_start_at TIMESTAMP;
  `);
  await db.execute(sql`
    ALTER TABLE projects
    ADD COLUMN IF NOT EXISTS execution_workspace_policy TEXT;
  `);
  await db.execute(sql`
    ALTER TABLE projects
    ADD COLUMN IF NOT EXISTS monthly_budget_usd NUMERIC(12, 4) NOT NULL DEFAULT 100;
  `);
  await db.execute(sql`
    ALTER TABLE projects
    ADD COLUMN IF NOT EXISTS used_budget_usd NUMERIC(12, 4) NOT NULL DEFAULT 0;
  `);
  await db.execute(sql`
    ALTER TABLE projects
    ADD COLUMN IF NOT EXISTS budget_window_start_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP;
  `);
  await db.execute(sql`
    ALTER TABLE projects
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP;
  `);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS project_workspaces (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      cwd TEXT,
      repo_url TEXT,
      repo_ref TEXT,
      is_primary BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_project_workspaces_company_project
      ON project_workspaces (company_id, project_id, is_primary DESC, created_at ASC);
  `);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS goals (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
      parent_goal_id TEXT,
      level TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'draft',
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      manager_agent_id TEXT,
      role TEXT NOT NULL,
      name TEXT NOT NULL,
      provider_type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'idle',
      heartbeat_cron TEXT NOT NULL,
      monthly_budget_usd NUMERIC(12, 4) NOT NULL DEFAULT 0,
      used_budget_usd NUMERIC(12, 4) NOT NULL DEFAULT 0,
      token_usage INTEGER NOT NULL DEFAULT 0,
      can_hire_agents BOOLEAN NOT NULL DEFAULT false,
      avatar_seed TEXT NOT NULL DEFAULT '',
      runtime_command TEXT,
      runtime_args_json TEXT NOT NULL DEFAULT '[]',
      runtime_cwd TEXT,
      runtime_env_json TEXT NOT NULL DEFAULT '{}',
      runtime_model TEXT,
      runtime_thinking_effort TEXT NOT NULL DEFAULT 'auto',
      bootstrap_prompt TEXT,
      runtime_timeout_sec INTEGER NOT NULL DEFAULT 0,
      interrupt_grace_sec INTEGER NOT NULL DEFAULT 15,
      run_policy_json TEXT NOT NULL DEFAULT '{}',
      state_blob TEXT NOT NULL DEFAULT '{}',
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  await db.execute(sql`
    ALTER TABLE agents
    ADD COLUMN IF NOT EXISTS avatar_seed TEXT NOT NULL DEFAULT '';
  `);
  await db.execute(sql`
    ALTER TABLE agents
    ADD COLUMN IF NOT EXISTS runtime_command TEXT;
  `);
  await db.execute(sql`
    ALTER TABLE agents
    ADD COLUMN IF NOT EXISTS runtime_args_json TEXT NOT NULL DEFAULT '[]';
  `);
  await db.execute(sql`
    ALTER TABLE agents
    ADD COLUMN IF NOT EXISTS runtime_cwd TEXT;
  `);
  await db.execute(sql`
    ALTER TABLE agents
    ADD COLUMN IF NOT EXISTS runtime_env_json TEXT NOT NULL DEFAULT '{}';
  `);
  await db.execute(sql`
    ALTER TABLE agents
    ADD COLUMN IF NOT EXISTS runtime_model TEXT;
  `);
  await db.execute(sql`
    ALTER TABLE agents
    ADD COLUMN IF NOT EXISTS runtime_thinking_effort TEXT NOT NULL DEFAULT 'auto';
  `);
  await db.execute(sql`
    ALTER TABLE agents
    ADD COLUMN IF NOT EXISTS bootstrap_prompt TEXT;
  `);
  await db.execute(sql`
    ALTER TABLE agents
    ADD COLUMN IF NOT EXISTS runtime_timeout_sec INTEGER NOT NULL DEFAULT 0;
  `);
  await db.execute(sql`
    ALTER TABLE agents
    ADD COLUMN IF NOT EXISTS interrupt_grace_sec INTEGER NOT NULL DEFAULT 15;
  `);
  await db.execute(sql`
    ALTER TABLE agents
    ADD COLUMN IF NOT EXISTS run_policy_json TEXT NOT NULL DEFAULT '{}';
  `);
  await db.execute(sql`
    UPDATE agents
    SET
      runtime_command = COALESCE(runtime_command, state_blob::jsonb->'runtime'->>'command'),
      runtime_args_json = CASE
        WHEN runtime_args_json IS NULL OR btrim(runtime_args_json) = '' OR runtime_args_json = '[]'
          THEN COALESCE((state_blob::jsonb->'runtime'->'args')::text, '[]')
        ELSE runtime_args_json
      END,
      runtime_cwd = COALESCE(runtime_cwd, state_blob::jsonb->'runtime'->>'cwd'),
      runtime_env_json = CASE
        WHEN runtime_env_json IS NULL OR btrim(runtime_env_json) = '' OR runtime_env_json = '{}'
          THEN COALESCE((state_blob::jsonb->'runtime'->'env')::text, '{}')
        ELSE runtime_env_json
      END,
      runtime_timeout_sec = CASE
        WHEN runtime_timeout_sec IS NULL OR runtime_timeout_sec = 0
          THEN COALESCE(((state_blob::jsonb->'runtime'->>'timeoutMs')::int / 1000), 0)
        ELSE runtime_timeout_sec
      END
    WHERE state_blob IS NOT NULL AND btrim(state_blob) <> '';
  `);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS issues (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      parent_issue_id TEXT,
      title TEXT NOT NULL,
      body TEXT,
      status TEXT NOT NULL DEFAULT 'todo',
      priority TEXT NOT NULL DEFAULT 'none',
      assignee_agent_id TEXT,
      labels_json TEXT NOT NULL DEFAULT '[]',
      tags_json TEXT NOT NULL DEFAULT '[]',
      is_claimed BOOLEAN NOT NULL DEFAULT false,
      claimed_by_heartbeat_run_id TEXT,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS issue_comments (
      id TEXT PRIMARY KEY,
      issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      author_type TEXT NOT NULL,
      author_id TEXT,
      recipients_json TEXT NOT NULL DEFAULT '[]',
      run_id TEXT,
      body TEXT NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  await db.execute(sql`
    ALTER TABLE issue_comments
    ADD COLUMN IF NOT EXISTS recipients_json TEXT NOT NULL DEFAULT '[]';
  `);
  await db.execute(sql`
    ALTER TABLE issue_comments
    ADD COLUMN IF NOT EXISTS run_id TEXT;
  `);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS issue_attachments (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      file_name TEXT NOT NULL,
      mime_type TEXT,
      file_size_bytes INTEGER NOT NULL,
      relative_path TEXT NOT NULL,
      uploaded_by_actor_type TEXT NOT NULL DEFAULT 'human',
      uploaded_by_actor_id TEXT,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS activity_logs (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      issue_id TEXT REFERENCES issues(id) ON DELETE SET NULL,
      actor_type TEXT NOT NULL,
      actor_id TEXT,
      event_type TEXT NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}',
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS heartbeat_runs (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'started',
      started_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      finished_at TIMESTAMP,
      message TEXT
    );
  `);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS heartbeat_run_queue (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      job_type TEXT NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'pending',
      priority INTEGER NOT NULL DEFAULT 100,
      idempotency_key TEXT,
      available_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 10,
      last_error TEXT,
      started_at TIMESTAMP,
      finished_at TIMESTAMP,
      heartbeat_run_id TEXT REFERENCES heartbeat_runs(id) ON DELETE SET NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  await db.execute(sql`
    ALTER TABLE heartbeat_run_queue
    ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
  `);
  await db.execute(sql`
    ALTER TABLE heartbeat_run_queue
    ADD COLUMN IF NOT EXISTS heartbeat_run_id TEXT REFERENCES heartbeat_runs(id) ON DELETE SET NULL;
  `);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS heartbeat_run_messages (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      run_id TEXT NOT NULL REFERENCES heartbeat_runs(id) ON DELETE CASCADE,
      sequence INTEGER NOT NULL,
      kind TEXT NOT NULL,
      label TEXT,
      text TEXT,
      payload_json TEXT,
      signal_level TEXT,
      group_key TEXT,
      source TEXT,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  await db.execute(sql`
    ALTER TABLE heartbeat_run_messages
    ADD COLUMN IF NOT EXISTS signal_level TEXT;
  `);
  await db.execute(sql`
    ALTER TABLE heartbeat_run_messages
    ADD COLUMN IF NOT EXISTS group_key TEXT;
  `);
  await db.execute(sql`
    ALTER TABLE heartbeat_run_messages
    ADD COLUMN IF NOT EXISTS source TEXT;
  `);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS approval_requests (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      requested_by_agent_id TEXT,
      action TEXT NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      resolved_at TIMESTAMP
    );
  `);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS approval_inbox_states (
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      actor_id TEXT NOT NULL,
      approval_id TEXT NOT NULL REFERENCES approval_requests(id) ON DELETE CASCADE,
      seen_at TIMESTAMP,
      dismissed_at TIMESTAMP,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (company_id, actor_id, approval_id)
    );
  `);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS cost_ledger (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
      issue_id TEXT REFERENCES issues(id) ON DELETE SET NULL,
      agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
      provider_type TEXT NOT NULL,
      runtime_model_id TEXT,
      pricing_provider_type TEXT,
      pricing_model_id TEXT,
      pricing_source TEXT,
      token_input INTEGER NOT NULL DEFAULT 0,
      token_output INTEGER NOT NULL DEFAULT 0,
      usd_cost NUMERIC(12, 6) NOT NULL DEFAULT 0,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  await db.execute(sql`
    ALTER TABLE cost_ledger
    ADD COLUMN IF NOT EXISTS runtime_model_id TEXT;
  `);
  await db.execute(sql`
    ALTER TABLE cost_ledger
    ADD COLUMN IF NOT EXISTS pricing_provider_type TEXT;
  `);
  await db.execute(sql`
    ALTER TABLE cost_ledger
    ADD COLUMN IF NOT EXISTS pricing_model_id TEXT;
  `);
  await db.execute(sql`
    ALTER TABLE cost_ledger
    ADD COLUMN IF NOT EXISTS pricing_source TEXT;
  `);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS model_pricing (
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      provider_type TEXT NOT NULL,
      model_id TEXT NOT NULL,
      display_name TEXT,
      input_usd_per_1m NUMERIC(12, 6) NOT NULL DEFAULT 0,
      output_usd_per_1m NUMERIC(12, 6) NOT NULL DEFAULT 0,
      currency TEXT NOT NULL DEFAULT 'USD',
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_by TEXT,
      PRIMARY KEY (company_id, provider_type, model_id)
    );
  `);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS audit_events (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      actor_type TEXT NOT NULL,
      actor_id TEXT,
      event_type TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      correlation_id TEXT,
      payload_json TEXT NOT NULL DEFAULT '{}',
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS plugins (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      version TEXT NOT NULL,
      kind TEXT NOT NULL,
      runtime_type TEXT NOT NULL,
      runtime_entrypoint TEXT NOT NULL,
      hooks_json TEXT NOT NULL DEFAULT '[]',
      capabilities_json TEXT NOT NULL DEFAULT '[]',
      manifest_json TEXT NOT NULL DEFAULT '{}',
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS templates (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      slug TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      current_version TEXT NOT NULL DEFAULT '1.0.0',
      status TEXT NOT NULL DEFAULT 'draft',
      visibility TEXT NOT NULL DEFAULT 'company',
      variables_json TEXT NOT NULL DEFAULT '[]',
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS template_versions (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      template_id TEXT NOT NULL REFERENCES templates(id) ON DELETE CASCADE,
      version TEXT NOT NULL,
      manifest_json TEXT NOT NULL DEFAULT '{}',
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS template_installs (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      template_id TEXT REFERENCES templates(id) ON DELETE SET NULL,
      template_version_id TEXT REFERENCES template_versions(id) ON DELETE SET NULL,
      status TEXT NOT NULL DEFAULT 'applied',
      summary_json TEXT NOT NULL DEFAULT '{}',
      variables_json TEXT NOT NULL DEFAULT '{}',
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS plugin_configs (
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      plugin_id TEXT NOT NULL REFERENCES plugins(id) ON DELETE CASCADE,
      enabled BOOLEAN NOT NULL DEFAULT false,
      priority INTEGER NOT NULL DEFAULT 100,
      config_json TEXT NOT NULL DEFAULT '{}',
      granted_capabilities_json TEXT NOT NULL DEFAULT '[]',
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (company_id, plugin_id)
    );
  `);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS plugin_runs (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      run_id TEXT REFERENCES heartbeat_runs(id) ON DELETE CASCADE,
      plugin_id TEXT NOT NULL REFERENCES plugins(id) ON DELETE CASCADE,
      hook TEXT NOT NULL,
      status TEXT NOT NULL,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      diagnostics_json TEXT NOT NULL DEFAULT '{}',
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS agent_issue_labels (
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
      label TEXT NOT NULL,
      PRIMARY KEY (company_id, issue_id, label)
    );
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_issues_company_status
      ON issues (company_id, status, updated_at);
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_issue_attachments_company_issue
      ON issue_attachments (company_id, issue_id, created_at DESC);
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_issue_attachments_company_project
      ON issue_attachments (company_id, project_id, created_at DESC);
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_audit_events_company_created
      ON audit_events (company_id, created_at DESC);
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_cost_ledger_company_created
      ON cost_ledger (company_id, created_at DESC);
  `);
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_heartbeat_runs_single_started
      ON heartbeat_runs (company_id, agent_id)
      WHERE status = 'started';
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_heartbeat_run_queue_status_available_priority
      ON heartbeat_run_queue (company_id, status, available_at ASC, priority ASC, created_at ASC);
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_heartbeat_run_queue_agent_status
      ON heartbeat_run_queue (company_id, agent_id, status, available_at ASC, created_at ASC);
  `);
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_heartbeat_run_queue_idempotency
      ON heartbeat_run_queue (company_id, agent_id, idempotency_key)
      WHERE idempotency_key IS NOT NULL AND btrim(idempotency_key) <> '';
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_heartbeat_run_messages_company_run_sequence
      ON heartbeat_run_messages (company_id, run_id, sequence ASC);
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_heartbeat_run_messages_company_created
      ON heartbeat_run_messages (company_id, created_at DESC);
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_approval_inbox_states_company_actor_updated
      ON approval_inbox_states (company_id, actor_id, updated_at DESC);
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_plugin_configs_company_enabled_priority
      ON plugin_configs (company_id, enabled, priority ASC, plugin_id ASC);
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_plugin_runs_company_created
      ON plugin_runs (company_id, created_at DESC);
  `);
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_templates_company_slug
      ON templates (company_id, slug);
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_template_versions_company_template_created
      ON template_versions (company_id, template_id, created_at DESC);
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_template_installs_company_created
      ON template_installs (company_id, created_at DESC);
  `);

  return { db, client };
}
