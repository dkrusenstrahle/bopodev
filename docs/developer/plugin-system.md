# Plugin System

This page documents Bopo's plugin system for extending heartbeat execution with
governed, observable hooks.

## Purpose

Enable teams to add integrations and runtime extensions (memory enrichment,
tracing, queue publishing, etc.) without editing core heartbeat orchestration.

## Intended Audience

- Engineers building plugin-backed features in `apps/api` and `apps/web`.
- Operators enabling or governing plugin capabilities per company.

## Current Model (MVP)

- Plugins are cataloged with a manifest and runtime metadata.
- Companies install/configure plugins independently.
- Heartbeat lifecycle points call plugin hooks.
- Plugin runs are persisted and exposed in observability APIs/UI.
- High-risk capabilities are approval-gated.

## Core Contracts

Shared schemas live in `packages/contracts/src/index.ts`.

- `PluginManifestSchema`
  - identity: `id`, `version`, `displayName`
  - classification: `kind` (`lifecycle` | `tool` | `integration`)
  - routing: `hooks` (heartbeat hook list)
  - security: `capabilities`
  - runtime: `runtime.type` (`builtin` | `stdio` | `http`), `entrypoint`, `timeoutMs`, `retryCount`
- `PluginInvocationResultSchema`
  - `status`: `ok` | `skipped` | `failed` | `blocked`
  - `summary`
  - `diagnostics`
  - `blockers` (structured blocker metadata)
  - optional `metadataPatch`

## Lifecycle Hook Points

Heartbeats invoke plugin hooks from `apps/api/src/services/heartbeat-service.ts`:

- `beforeClaim`
- `afterClaim`
- `beforeAdapterExecute`
- `afterAdapterExecute`
- `beforePersist`
- `afterPersist`
- `onError`

Each invocation calls `runPluginHook(...)` in `apps/api/src/services/plugin-runtime.ts`.

## Runtime and Safety

`pluginSystemEnabled()` is default-on and can be disabled via env:

- `BOPO_PLUGIN_SYSTEM_DISABLED=true` or `1` disables plugin execution globally.
- Legacy override is still honored: `BOPO_PLUGIN_SYSTEM_ENABLED=false` or `0` disables execution.

When enabled:

1. Company plugin configs are loaded and filtered by hook + enabled state.
2. High-risk capabilities are checked against granted capabilities.
3. Plugin executes (built-in executors in MVP).
4. Result is validated against `PluginInvocationResultSchema`.
5. A plugin run row is written (`ok`, `skipped`, `failed`, or `blocked`).
6. Failures are aggregated into audit events (`plugin.hook.failures`).

`runPluginHook` supports `failClosed`; if true, failures can block the calling flow.

## Capability Governance

High-risk capabilities:

- `network`
- `queue_publish`
- `issue_write`
- `write_memory`

`PUT /plugins/:pluginId` can request approval when risky capabilities are granted:

- action: `grant_plugin_capabilities`
- payload includes plugin config + requested grants
- approval resolution applies config via governance service

See also: `docs/product/governance-and-approvals.md`.

## Built-in Plugins (Reference)

MVP built-ins are registered on API startup:

- `trace-exporter` (enabled by default)
- `memory-enricher` (enabled by default)
- `queue-publisher` (installed, disabled by default)
- `heartbeat-tagger` (installed, disabled by default)

Defaults are ensured per company at creation/startup.

## Data Model

Plugin state is stored in `packages/db`:

- `plugins`: catalog + manifest metadata
- `plugin_configs`: company-scoped install/config + granted capabilities
- `plugin_runs`: per-hook execution records and diagnostics

## API Surface

Company-scoped plugin routes (`x-company-id` required):

- `GET /plugins`
  - list catalog rows plus `companyConfig` state
- `POST /plugins/:pluginId/install`
  - install plugin for company with default disabled config
- `PUT /plugins/:pluginId`
  - update enabled/priority/config/grants
  - may return pending approval for risky grants
- `GET /plugins/runs`
  - list plugin runs (`pluginId`, `runId`, `limit` supported)

Observability alias:

- `GET /observability/plugins/runs`

## Quick Start (curl)

Install plugin:

```bash
curl -X POST "http://localhost:4020/plugins/heartbeat-tagger/install" \
  -H "x-company-id: <company-id>"
```

Enable plugin with safe capability:

```bash
curl -X PUT "http://localhost:4020/plugins/heartbeat-tagger" \
  -H "content-type: application/json" \
  -H "x-company-id: <company-id>" \
  -d '{
    "enabled": true,
    "priority": 90,
    "grantedCapabilities": ["emit_audit"],
    "config": {},
    "requestApproval": false
  }'
```

Read recent runs:

```bash
curl "http://localhost:4020/observability/plugins/runs?pluginId=heartbeat-tagger&limit=50" \
  -H "x-company-id: <company-id>"
```

## UI

The first-class Plugins workspace page lives in `apps/web` and supports:

- install/activate/deactivate actions
- plugin catalog filtering
- plugin run preview for selected plugin

## Known Limits (Current Implementation)

- Runtime execution is built-in only in MVP (manifest allows `stdio`/`http` for future expansion).
- Timeout/retry fields are declared in manifests; extended runtime isolation is roadmap work.
- Capability model is deny-by-default for high-risk grants.

## Related Pages

- Architecture: [`architecture.md`](./architecture.md)
- API reference: [`api-reference.md`](./api-reference.md)
- Configuration: [`configuration-reference.md`](./configuration-reference.md)
- Governance workflows: [`../product/governance-and-approvals.md`](../product/governance-and-approvals.md)
