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

## Companies

- `GET /companies`
- `POST /companies`
- `PUT /companies/:companyId`
- `DELETE /companies/:companyId`

## Projects

- `GET /projects`
- `POST /projects`
- `PUT /projects/:projectId`
- `DELETE /projects/:projectId`

## Issues

- `GET /issues`
- `GET /issues/:issueId` — full issue row (same shape as list items), including `goalIds`, plus `attachments[]` with metadata and `downloadPath` for each file. Used by agents for **compact** heartbeat hydration; see [`../guides/agent-heartbeat-protocol.md`](../guides/agent-heartbeat-protocol.md).
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

Issue ↔ goals:

- `POST /issues` accepts optional `goalIds` (array, default `[]`). `PUT /issues/:issueId` accepts optional `goalIds` to replace the full set (use `[]` to clear). Each goal must belong to the same company; if a goal has a `projectId`, it must match the issue’s project.
- `GET /issues` and `GET /issues/:issueId` include `goalIds` on each issue.
- Issues created from a **work loop** include optional `loopId` and `loopRunId` (nullable).

## Work loops (scheduled)

Company-scoped (`x-company-id`). Permissions: `loops:read`, `loops:write`, `loops:run` (manual run).

- `GET /loops` — list work loops.
- `POST /loops` — create (body: `projectId`, `title`, `assigneeAgentId`, optional `description`, `priority`, `status`, `concurrencyPolicy`, `catchUpPolicy`, `parentIssueId`, `goalIds`).
- `GET /loops/:loopId` — detail with `triggers[]` and `recentRuns[]`.
- `PATCH /loops/:loopId` — partial update.
- `POST /loops/:loopId/run` — manual dispatch (`loops:run`).
- `GET /loops/:loopId/runs` — run history (`?limit=`).
- `GET /loops/:loopId/activity` — audit rows for this loop.
- `POST /loops/:loopId/triggers` — add trigger; body is a discriminated union: `{ mode: "cron", cronExpression, timezone?, label?, enabled? }` or `{ mode: "preset", preset: "daily"|"weekly", hour24, minute, dayOfWeek?, timezone?, label?, enabled? }`.
- `PATCH /loops/:loopId/triggers/:triggerId` — update trigger fields.
- `DELETE /loops/:loopId/triggers/:triggerId` — remove a trigger (`loops:write`).

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
- `GET /observability/memory/:agentId/context-preview` (supports `projectIds`, `query`)

For memory semantics, see [`../product/agent-memory-workflow.md`](../product/agent-memory-workflow.md).
For artifact storage/path guardrails, see [`../operations/workspace-path-surface.md`](../operations/workspace-path-surface.md).

## Plugins

- `GET /plugins`
- `POST /plugins/:pluginId/install`
- `POST /plugins/install-from-json`
- `PUT /plugins/:pluginId`
- `GET /plugins/runs`

Mutation permission:

- Plugin install/config mutation routes require `plugins:write`.

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
- Troubleshooting: [`../operations/troubleshooting.md`](../operations/troubleshooting.md)
