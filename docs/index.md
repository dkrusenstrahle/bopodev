# Bopo Documentation

This documentation set covers Bopo from two angles:

- **Operator path**: how to run day-to-day work in the control plane.
- **Developer path**: how to build, extend, and operate the platform.

## Start Here

- New contributor setup: [`getting-started-and-dev.md`](./getting-started-and-dev.md)
- Product overview: [`product/overview.md`](./product/overview.md)
- Glossary: [`glossary.md`](./glossary.md)
- Coverage matrix: [`docs-coverage-matrix.md`](./docs-coverage-matrix.md)

Treat [`docs-coverage-matrix.md`](./docs-coverage-matrix.md) as the canonical source for documentation completeness status, and update it in the same PR when adding or changing major system behavior.

## Product Docs

- [`product/index.md`](./product/index.md)
- [`product/daily-workflows.md`](./product/daily-workflows.md)
- [`product/agents-and-runs.md`](./product/agents-and-runs.md)
- [`product/plugins-and-integrations.md`](./product/plugins-and-integrations.md)
- [`product/agent-memory-workflow.md`](./product/agent-memory-workflow.md)
- [`product/governance-and-approvals.md`](./product/governance-and-approvals.md)
- [`product/office-space-and-realtime.md`](./product/office-space-and-realtime.md)

## Guides

- [`guides/agent-heartbeat-protocol.md`](./guides/agent-heartbeat-protocol.md): full vs compact heartbeat prompts, cost expectations, and `GET /issues/:id` hydration.

## Developer Docs

- [`developer/index.md`](./developer/index.md)
- [`developer/architecture.md`](./developer/architecture.md)
- [`developer/domain-model.md`](./developer/domain-model.md)
- [`developer/api-reference.md`](./developer/api-reference.md)
- [`developer/configuration-reference.md`](./developer/configuration-reference.md)
- [`developer/workspace-resolution-reference.md`](./developer/workspace-resolution-reference.md)
- [`developer/plugin-system.md`](./developer/plugin-system.md)
- [`developer/plugin-authoring.md`](./developer/plugin-authoring.md)
- [`developer/plugin-hook-reference.md`](./developer/plugin-hook-reference.md)
- [`developer/plugin-samples.md`](./developer/plugin-samples.md)
- [`developer/contributing.md`](./developer/contributing.md)
- Adapter docs:
  - [`adapters/overview.md`](./adapters/overview.md)
  - [`adapter-authoring.md`](./adapter-authoring.md)

## Operations Docs

- [`operations/index.md`](./operations/index.md)
- [`operations/deployment.md`](./operations/deployment.md)
- [`operations/runbooks-index.md`](./operations/runbooks-index.md)
- [`operations/troubleshooting.md`](./operations/troubleshooting.md)
- [`operations/plugin-runbook.md`](./operations/plugin-runbook.md)
- [`operations/workspace-path-surface.md`](./operations/workspace-path-surface.md)
- [`operations/workspace-migration-and-backfill-runbook.md`](./operations/workspace-migration-and-backfill-runbook.md)
- [`operations/attachments-storage-runbook.md`](./operations/attachments-storage-runbook.md)
- Codex-specific runbook: [`codex-connection-debugging.md`](./codex-connection-debugging.md)

## Release Docs

- [`release/index.md`](./release/index.md)
- [`release-process.md`](./release-process.md)
- [`release-gate-checklist.md`](./release-gate-checklist.md)
- [`release/versioning-and-changelog.md`](./release/versioning-and-changelog.md)
