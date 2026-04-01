# Plugin Migration to Manifest v2

This guide explains how to move plugin implementations to the current v2-only model.

## Current State

- Legacy v1 runtime compatibility has been removed.
- Only `apiVersion: "2"` manifests are supported.
- Install flow is package-first (`POST /plugins/install`) with filesystem discovery for local development.

## Mapping

- `id`, `version`, `displayName`, `description`, `kind`, `hooks`, and core runtime fields remain required.
- Add `apiVersion: "2"`.
- Add `entrypoints.worker` and optionally `entrypoints.ui`.
- Add `capabilityNamespaces` for policy-grade capability enforcement.
- Optional `ui.slots[]` declares host mount points.
- Optional `install` captures artifact source metadata.

## Suggested migration steps

1. Implement a worker handler for all required surfaces (`hooks`, `actions`, `data`, `webhooks`, `jobs`, `health` as needed).
2. Build and package plugin artifacts (worker output and optional UI output).
3. Author a v2 manifest with correct entrypoints and namespaces.
4. Install plugin disabled with `POST /plugins/install`.
5. Run health/action/data smoke tests.
6. Trigger heartbeat and verify `/plugins/runs` diagnostics.
7. Enable for controlled rollout, then expand.
8. Keep rollback target install IDs from `/plugins/:pluginId/installs`.

## Validation Checklist

- Manifest passes schema validation and appears in `/plugins`.
- Worker process starts and responds to `plugin.health`.
- Action/data endpoints return expected payloads.
- Hook runs are recorded with expected status in plugin runs.
- Namespace grants are enforced as expected (`ok` when granted, `blocked` when not).
