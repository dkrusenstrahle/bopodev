# API Reference

This page summarizes public API routes in `apps/api`.

## Purpose

Provide a practical route map and request contract guide for Bopo clients and integrations.

## Intended Audience

- Web and SDK contributors.
- External integrators automating Bopo flows.

## Base URL and Format

- Default local base URL: `http://localhost:4020`
- JSON request/response format.
- Routes are rooted directly (`/companies`, `/issues`, etc.), with no `/api` prefix.

## Required Headers

Most mutating and company-scoped routes require:

- `x-company-id`
- `x-actor-type`
- `x-actor-id`
- `x-actor-companies`
- `x-actor-permissions`

`x-request-id` is accepted and echoed; otherwise API generates one.

## Health

- `GET /health`
  - Returns API health, DB readiness, and runtime command health.

## Authentication

- `POST /auth/actor-token`
  - Issues signed actor tokens when token auth is configured.
  - Requires `BOPO_AUTH_TOKEN_SECRET`.
  - In authenticated modes, requires matching `x-bopo-bootstrap-secret` when `BOPO_AUTH_BOOTSTRAP_SECRET` is configured.

## Attention

- `GET /attention`
- `POST /attention/:itemKey/seen`
- `POST /attention/:itemKey/acknowledge`
- `POST /attention/:itemKey/dismiss`
- `POST /attention/:itemKey/undismiss`
- `POST /attention/:itemKey/resolve`

All attention routes are company-scoped and publish realtime updates.

## Assistant (owner Chat)

Company-scoped (`x-company-id`). Product guide: [`../product/owner-assistant.md`](../product/owner-assistant.md).

- `GET /assistant/brains` — `{ brains: [{ providerType, label, requiresRuntimeCwd }] }` (CLI-backed adapters available for Chat).
- `GET /assistant/messages` — query `threadId` (optional; omit for latest-or-create), `limit` (optional, 1–200). Response: `threadId`, `ceoPersona`, `messages[]` (`id`, `role`, `body`, `createdAt`, `metadata`).
- `POST /assistant/messages` — body `{ message: string, brain?: <cli id>, threadId?: string }`. Runs one assistant turn; response includes `userMessageId`, `assistantMessageId`, `assistantBody`, `toolRoundCount`, `mode` (`api` \| `cli`), `brain`, `threadId`, and optional `cliElapsedMs`.
- `POST /assistant/threads` — create a new empty thread; `{ threadId }`.

Default `brain` when omitted is `BOPO_CHAT_DEFAULT_BRAIN` or `codex` (see configuration reference). `422` on validation errors; `503` when a direct-API turn fails for missing provider credentials.

Observability helper for costs UI:

- `GET /observability/assistant-chat-threads` — query `from` + `toExclusive` (ISO 8601) **or** `monthKey=YYYY-MM`; returns thread stats in that created-at window.

## Companies

- `GET /companies`
- `POST /companies` — body `{ name, mission?, providerType?, runtimeModel?, starterPackId? }`. Board role. Without `starterPackId`, creates a blank company with a default CEO. With `starterPackId`, applies a **builtin company template** (same catalog as Templates) or, if registered, an optional **zip-only** starter; maps `name` / `mission` into template variables (`brandName`, `productName`, `targetAudience`, `primaryChannel`, etc.) and applies the dialog’s provider/model to the lead agent (`ceo`, else `cmo`, else first hiring-capable agent).
- `PUT /companies/:companyId`
- `DELETE /companies/:companyId`
- `GET /companies/starter-packs` — board role; `{ starterPacks: [{ id, label, description }] }` for the create-company UI.

File-oriented company pack (zip folder tree, editable in git):

- `GET /companies/:companyId/export/files/manifest` — JSON `{ files: [{ path, bytes, source }] }`. Query `includeAgentMemory=true` to list agent memory markdown in the manifest.
- `GET /companies/:companyId/export/files/preview?path=...` — UTF-8 text preview for one manifest path (same `includeAgentMemory` query as manifest).
- `POST /companies/:companyId/export/files/zip` — body `{ paths?: string[] | null, includeAgentMemory?: boolean }`. When `paths` is omitted or null, all manifest paths are zipped. Response is `application/zip` with entries such as `.bopo.yaml`, `README.md`, `COMPANY.md`, `projects/.../PROJECT.md`, `agents/<slug>/...`, `tasks/<slug>/TASK.md`, `skills/...`, and optional `goals` in `.bopo.yaml`.
- `POST /companies/import/files/preview` — board role; `multipart/form-data` field `archive` (zip). Parse-only summary: `{ ok, companyName, counts, hasCeo, errors[], warnings[] }` (no database writes).
- `POST /companies/import/files` — board role; `multipart/form-data` field `archive` (zip). Creates a **new** company from a Bopo export (schema `bopo/company-export/v1` in `.bopo.yaml`). Omit `x-company-id` or use board scope.

`GET /companies/:companyId/export` (legacy JSON snapshot) returns **410**; use `POST /companies/:companyId/export/files/zip` instead.

## Projects

- `GET /projects`
- `POST /projects`
- `PUT /projects/:projectId`
- `DELETE /projects/:projectId`

## Issues

- `GET /issues`
- `GET /issues/:issueId` — full issue row (same shape as list items), including `goalIds` and `knowledgePaths` (string paths relative to company `knowledge/`), plus `attachments[]` with metadata and `downloadPath` for each file. Used by agents for **compact** heartbeat hydration; see [`../guides/agent-heartbeat-protocol.md`](../guides/agent-heartbeat-protocol.md).
- `POST /issues`
- `PUT /issues/:issueId`
- `DELETE /issues/:issueId`
- `GET /issues/:issueId/comments`
- `POST /issues/:issueId/comments`
- `PUT /issues/:issueId/comments/:commentId`
- `DELETE /issues/:issueId/comments/:commentId`
- `GET /issues/:issueId/activity`
- `POST /issues/comment` (comment helper flow)

Attachments:

- `POST /issues/:issueId/attachments`
- `GET /issues/:issueId/attachments`
- `GET /issues/:issueId/attachments/:attachmentId/download`
- `DELETE /issues/:issueId/attachments/:attachmentId`

Delegated hiring metadata:

- `POST /issues` accepts optional `metadata.delegatedHiringIntent` for typed hiring delegation context (e.g. `requestedRoleKey`, `requestedTitle`, `requestedCapabilities`—nullable string, max 4000—so the hiring manager can pass suggested org-chart text for the new hire).

Issue ↔ knowledge:

- `POST /issues` accepts optional `knowledgePaths` (array of relative paths under company `knowledge/`, max 20). `PUT /issues/:issueId` accepts optional `knowledgePaths` to replace the full set. Each path must refer to an existing knowledge file.

Issue ↔ goals:

- `POST /issues` accepts optional `goalIds` (array, default `[]`). `PUT /issues/:issueId` accepts optional `goalIds` to replace the full set (use `[]` to clear). Each goal must belong to the same company; if a goal has a `projectId`, it must match the issue’s project.
- `GET /issues` and `GET /issues/:issueId` include `goalIds` on each issue.
- Issues created from a **routine** include optional `routineId` and `routineRunId` (nullable).

## Routines (scheduled)

Company-scoped (`x-company-id`). Permissions: `routines:read`, `routines:write`, `routines:run` (manual run).

Canonical paths use `/routines`; the same router is also mounted at `/loops` for backward compatibility.

- `GET /routines` — list routines.
- `POST /routines` — create (body: `projectId`, `title`, `assigneeAgentId`, optional `description`, `priority`, `status`, `concurrencyPolicy`, `catchUpPolicy`, `parentIssueId`, `goalIds`).
- `GET /routines/:routineId` — detail with `triggers[]` and `recentRuns[]` (trigger/run rows use `routineId`).
- `PATCH /routines/:routineId` — partial update.
- `POST /routines/:routineId/run` — manual dispatch (`routines:run`).
- `GET /routines/:routineId/runs` — run history (`?limit=`).
- `GET /routines/:routineId/activity` — audit rows for this routine.
- `POST /routines/:routineId/triggers` — add trigger; body is a discriminated union: `{ mode: "cron", cronExpression, timezone?, label?, enabled? }` or `{ mode: "preset", preset: "daily"|"weekly", hour24, minute, dayOfWeek?, timezone?, label?, enabled? }`.
- `PATCH /routines/:routineId/triggers/:triggerId` — update trigger fields.
- `DELETE /routines/:routineId/triggers/:triggerId` — remove a trigger (`routines:write`).

Scheduler env: `BOPO_LOOP_SWEEP_MS`, `BOPO_LOOP_SWEEP_ENABLED` (see [`../../DEVELOPING.md`](../../DEVELOPING.md)).

## Goals

- `GET /goals`
- `POST /goals`
- `PUT /goals/:goalId`
- `DELETE /goals/:goalId`

Agent-scoped agent goals:

- `POST /goals` / `PUT /goals/:goalId` accept optional `ownerAgentId` for `level: "agent"`. When set, only that agent receives the goal in heartbeat context; omit or set `null` for all agents.

## Agents

- Agent resources include optional `capabilities` (nullable string, max 4000 characters): human-readable description of what the agent can do, returned on `GET /agents` and accepted on `POST /agents` and `PUT /agents/:agentId` (empty string normalizes to `null`).

- `GET /agents`
- `GET /agents/hiring-delegate`
- `GET /agents/leadership-diagnostics`
- `POST /agents`
- `PUT /agents/:agentId`
- `DELETE /agents/:agentId`
- `POST /agents/:agentId/pause`
- `POST /agents/:agentId/resume`
- `POST /agents/:agentId/terminate`

Adapter and runtime support:

- `GET /agents/runtime-default-cwd`
- `GET /agents/adapter-metadata`
- `GET /agents/adapter-models/:providerType` — resolves models using the company’s default runtime cwd only (request bodies are not applied on GET).
- `POST /agents/adapter-models/:providerType` — same response shape as GET; body matches runtime preflight extras (`runtimeConfig` plus optional top-level `runtimeCommand`, `runtimeCwd`, `runtimeEnv`, etc.) so CLI-backed adapters can discover models for the configured cwd/command/env.
- `POST /agents/runtime-preflight`

Hiring request lineage:

- `POST /agents` supports optional `sourceIssueId`, `sourceIssueIds`, and `delegationIntent`.
- Agent-originated hire requests are forced through approval flow when approval is required.

## Governance

- `GET /governance/approvals`
- `GET /governance/inbox`
- `POST /governance/inbox/:approvalId/seen`
- `POST /governance/inbox/:approvalId/dismiss`
- `POST /governance/inbox/:approvalId/undismiss`
- `POST /governance/resolve`

## Heartbeats

- `POST /heartbeats/run-agent`
- `POST /heartbeats/:runId/stop`
- `POST /heartbeats/:runId/resume`
- `POST /heartbeats/:runId/redo`
- `POST /heartbeats/sweep`
- `GET /heartbeats/queue`

Queue route supports filters: `status`, `agentId`, `jobType`, `limit`.

## Observability

- `GET /observability/logs`
- `GET /observability/costs`
- `GET /observability/heartbeats`
- `GET /observability/heartbeats/:runId`
- `GET /observability/heartbeats/:runId/messages`
- `GET /observability/heartbeats/:runId/artifacts/:artifactIndex/download`
- `GET /observability/plugins/runs` (supports `pluginId`, `runId`, `limit`)
- `GET /observability/memory` (supports `agentId` and `limit`)
- `GET /observability/memory/:agentId/file?path=...`
- `PUT /observability/memory/:agentId/file?path=...` — JSON body `{ "content": "<utf-8 string>" }`; requires `agents:write`
- `GET /observability/memory/:agentId/context-preview` (supports `projectIds`, `query`)
- `GET /observability/assistant-chat-threads` (supports `from` + `toExclusive` or `monthKey`; assistant thread stats for costs)
- `GET /observability/agent-operating/:agentId/files` (supports `limit`; lists `*.md` under the agent operating directory)
- `GET /observability/agent-operating/:agentId/file?path=...`
- `PUT /observability/agent-operating/:agentId/file?path=...` — JSON body `{ "content": "<utf-8 string>" }`; requires `agents:write` (only `.md` paths)
- `GET /observability/company-knowledge` — `{ items: { relativePath }[], tree }` for files under the company `knowledge/` directory (`.md`, `.yaml`, `.yml`, `.txt`, `.json`).
- `GET /observability/company-knowledge/file?path=...` — `{ content }` (UTF-8 text).
- `PUT /observability/company-knowledge/file?path=...` — JSON body `{ "content": "<utf-8 string>" }`; requires `agents:write`.
- `POST /observability/company-knowledge/file` — JSON body `{ "path": "<relative path>", "content"?: "<utf-8 string>" }`; creates a new file (empty body for markdown/text/yaml if `content` omitted, `{}` for `.json`); requires `agents:write`.
- `PATCH /observability/company-knowledge/file` — JSON body `{ "from": "<current relative path>", "to": "<new relative path>" }`; renames/moves a file within knowledge; requires `agents:write`.
- `DELETE /observability/company-knowledge/file?path=...` — remove a knowledge file; requires `agents:write`.

For memory semantics, see [`../product/agent-memory-workflow.md`](../product/agent-memory-workflow.md).
For artifact storage/path guardrails, see [`../operations/workspace-path-surface.md`](../operations/workspace-path-surface.md).

## Plugins

- `GET /plugins`
- `PUT /plugins/:pluginId`
- `POST /plugins/install`
- `GET /plugins/runs`
- `GET /plugins/:pluginId/health`
- `GET /plugins/:pluginId/installs`
- `POST /plugins/:pluginId/upgrade`
- `POST /plugins/:pluginId/rollback`
- `POST /plugins/:pluginId/actions/:actionKey`
- `POST /plugins/:pluginId/data/:dataKey`
- `POST /plugins/:pluginId/webhooks/:endpointKey`
- `GET /plugins/:pluginId/ui`
- `DELETE /plugins/:pluginId`

Mutation permission:

- Plugin install/config/action/data/webhook mutation routes require `plugins:write`.

## Templates

- `GET /templates`
- `POST /templates`
- `PUT /templates/:templateId`
- `DELETE /templates/:templateId`
- `POST /templates/:templateId/preview`
- `POST /templates/:templateId/apply`
- `POST /templates/import`
- `GET /templates/:templateId/export`

Mutation permission:

- Template create/update/delete/import/apply routes require `templates:write`.

## Realtime

- Websocket endpoint: `/realtime`
- Bootstrap channel families:
  - `governance`
  - `office-space`
  - `heartbeat-runs`
  - `attention`

Operational notes:

- Realtime payloads are company-scoped.
- Clients should apply snapshot first, then incremental updates.
- For troubleshooting reconnect/scope issues, use [`../operations/troubleshooting.md`](../operations/troubleshooting.md).

## Error Handling

- `422` for repository/schema validation failures.
- `500` for unhandled server errors.
- `x-request-id` can be used to correlate client failures to logs.

## Related Pages

- Domain model: [`domain-model.md`](./domain-model.md)
- Product workflows: [`../product/daily-workflows.md`](../product/daily-workflows.md)
- Owner Chat: [`../product/owner-assistant.md`](../product/owner-assistant.md)
- Troubleshooting: [`../operations/troubleshooting.md`](../operations/troubleshooting.md)
