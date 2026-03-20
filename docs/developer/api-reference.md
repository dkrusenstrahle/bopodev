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
- `GET /issues/:issueId` — full issue row (same shape as list items) plus `attachments[]` with metadata and `downloadPath` for each file. Used by agents for **compact** heartbeat hydration; see [`../guides/agent-heartbeat-protocol.md`](../guides/agent-heartbeat-protocol.md).
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

- `POST /issues` accepts optional `metadata.delegatedHiringIntent` for typed hiring delegation context.

## Goals

- `GET /goals`
- `POST /goals`
- `PUT /goals/:goalId`
- `DELETE /goals/:goalId`

## Agents

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
- `GET /agents/adapter-models/:providerType`
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
