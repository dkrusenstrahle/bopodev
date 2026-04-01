# Plugin System

This is the canonical, current-state reference for Bopo plugins.

## Current Architecture (Hard Cut)

The plugin system is now **v2-only** and **worker-first**:

- No legacy built-in plugin runtime path.
- No legacy JSON-install API path.
- No prompt-runtime compatibility mode.
- Plugins are loaded from:
  - package installs (`POST /plugins/install`), or
  - filesystem manifests (`plugins/*/plugin.json`), then executed as worker plugins.

## What A Plugin Can Do

A plugin can expose one or more of the following:

- **Hook execution** during heartbeat lifecycle (`plugin.hook`)
- **Actions** (`plugin.action`)
- **Data providers** (`plugin.data`)
- **Jobs** (`plugin.job`)
- **Webhooks** (`plugin.webhook`)
- **Health checks** (`plugin.health`)
- **UI slots** rendered from plugin UI entrypoints

## Manifest Contract

Plugin manifests are validated by `PluginManifestV2Schema` in `packages/contracts/src/index.ts`.

Required/important fields:

- `apiVersion: "2"`
- `id`, `version`, `displayName`, `kind`
- `hooks`
- `runtime` (for worker plugins, typically `type: "stdio"`)
- `entrypoints.worker` (required)

Optional but common:

- `entrypoints.ui`
- `jobs[]`
- `webhooks[]`
- `ui.slots[]`
- `capabilityNamespaces[]`
- `install` metadata (`sourceType`, `sourceRef`, `integrity`, `buildHash`, `artifactPath`, `installedAt`)

## Capability Model

Permissions are namespace-based (`capabilityNamespaces`), with risk levels:

- **safe**
- **elevated**
- **restricted**

Execution checks are now surface-specific:

- Hooks require relevant hook/event namespaces.
- Actions require action namespaces.
- Data endpoints require data namespaces.
- Webhooks require webhook namespace grants.
- Health checks do not require unrelated namespaces.

If required elevated/restricted namespaces are not granted, execution is blocked with a clear error.

## Storage Model

Plugin state is persisted in DB tables:

- `plugins` – catalog and manifest JSON
- `plugin_configs` – company-level enabled/config/grants
- `plugin_runs` – runtime records and diagnostics
- `plugin_installs` – revision history (used by rollback/version lifecycle)

## Runtime Flow

At API startup:

1. Filesystem manifests are discovered and validated.
2. Legacy builtin catalog rows are purged.
3. Valid plugin manifests are upserted into catalog.
4. Company plugin config defaults are ensured for discovered manifests.

During execution:

1. Plugin is selected by enabled state and hook/surface.
2. Capability namespace checks are applied for that specific surface.
3. Request is dispatched to worker host via JSON-RPC.
4. Response is validated and plugin run diagnostics are persisted.

## API Surface (Current)

All routes are company-scoped (`x-company-id`).

- `GET /plugins`
- `PUT /plugins/:pluginId`
- `POST /plugins/install` (install by package name/version)
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

Removed legacy routes:

- `POST /plugins/install-package`
- `POST /plugins/install-from-json`
- `POST /plugins/:pluginId/install`
- `DELETE /plugins/:pluginId/install`

## Filesystem Discovery Rules

Default scan path behavior:

1. `BOPO_PLUGIN_MANIFESTS_DIR` (if set)
2. `./plugins` if it contains plugin manifests
3. `../../plugins` if it contains plugin manifests
4. fallback to `./plugins`

Manifests must be at:

- `plugins/<plugin-id>/plugin.json`

Entrypoints in filesystem manifests should be relative to the plugin directory, for example:

- `runtime.entrypoint: "dist/worker.js"`
- `entrypoints.worker: "dist/worker.js"`
- `entrypoints.ui: "ui"`

## Quick Start

1. Put a valid v2 manifest in `plugins/<id>/plugin.json` (or install by package name).
2. Restart API.
3. Open Plugins page and activate plugin for company.
4. Run health/action/data tests.
5. Verify runs via `GET /plugins/runs`.

## Troubleshooting

- Plugin missing from UI:
  - invalid manifest, wrong manifests directory, or stale API process.
- Health/action/data fails with capability error:
  - required namespace not granted for that surface.
- Rollback/internal error:
  - `plugin_installs` table missing in active DB; run migrations against the DB your API process actually uses.
- Worker exited:
  - wrong worker entrypoint path or runtime error in worker process.

## Related

- Authoring guide: [`plugin-authoring.md`](./plugin-authoring.md)
- Hook reference: [`plugin-hook-reference.md`](./plugin-hook-reference.md)
- Samples: [`plugin-samples.md`](./plugin-samples.md)
- Operator guide: [`../product/plugins-and-integrations.md`](../product/plugins-and-integrations.md)
- Incident runbook: [`../operations/plugin-runbook.md`](../operations/plugin-runbook.md)
