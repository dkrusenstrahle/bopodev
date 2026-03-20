# Documentation Coverage Matrix

This matrix tracks how Bopo functionality maps to documentation today.

Status values:

- `covered`: has dedicated docs and active cross-links.
- `partial`: documented, but key details are split or too thin.
- `needs-refresh`: docs exist, but drift risk is elevated after recent changes.
- `missing`: no effective documentation.

## Product Surface Coverage

| Functional area | Primary UI sections | Current docs | Coverage status | Notes |
| --- | --- | --- | --- | --- |
| Company, project, and issue planning | `dashboard`, `projects`, `issues` | `README.md`, `docs/product/overview.md`, `docs/product/daily-workflows.md` | covered | Keep route map aligned with app sections. |
| Goal alignment | `goals` | `docs/product/daily-workflows.md`, `docs/developer/domain-model.md` | covered | Product + data model coverage exists. |
| Agent lifecycle and runs | `agents`, `runs`, `settings` | `docs/product/agents-and-runs.md`, `docs/guides/agent-heartbeat-protocol.md`, `docs/developer/configuration-reference.md` | covered | Runtime/provider details; lean prompt + hydration guide. |
| Governance and inbox operations | `governance`, `inbox` | `docs/product/governance-and-approvals.md`, `docs/developer/api-reference.md` | covered | Includes approval action catalog and outcomes. |
| Office-space and realtime behavior | `office-space`, `inbox` | `docs/product/office-space-and-realtime.md` | needs-refresh | Realtime channel list changed recently; keep synced with server bootstrap channels. |
| Observability, logs, costs, and artifacts | `runs`, `trace-logs`, `costs` | `docs/product/agents-and-runs.md`, `docs/developer/api-reference.md`, `docs/operations/troubleshooting.md` | needs-refresh | Ensure artifact download and memory endpoints stay current. |
| Templates and plugin workflows | `templates`, `plugins`, `settings/templates`, `settings/plugins` | `docs/product/plugins-and-integrations.md`, `docs/developer/plugin-system.md`, `docs/developer/plugin-authoring.md` | partial | Product-level template workflow depth is still light. |
| Model management | `models`, `settings/models` | `docs/developer/configuration-reference.md`, `docs/developer/api-reference.md` | partial | Add richer operator guidance over time if UX expands. |

## Developer and Platform Coverage

| Platform area | Current docs | Coverage status | Notes |
| --- | --- | --- | --- |
| Local onboarding and command flow | `docs/getting-started-and-dev.md`, `CONTRIBUTING.md` | needs-refresh | Keep command list in sync with root scripts and wrappers. |
| Architecture and runtime boundaries | `docs/developer/architecture.md`, `docs/getting-started-and-dev.md` | covered | Includes API/web/shared package boundaries. |
| Domain model and glossary | `docs/developer/domain-model.md`, `docs/glossary.md` | covered | Canonical vocabulary exists. |
| API route and contract map | `docs/developer/api-reference.md` | needs-refresh | Must stay aligned with mounted routers and new endpoints. |
| Realtime and websocket channels | `docs/product/office-space-and-realtime.md`, `docs/developer/api-reference.md` | needs-refresh | Keep channel families aligned with `apps/api/src/server.ts`. |
| Environment/configuration reference | `docs/developer/configuration-reference.md` | covered | Good baseline with scheduler/runtime/auth settings. |
| Workspace resolution/path policy | `docs/developer/workspace-resolution-reference.md`, `docs/operations/workspace-path-surface.md`, `docs/operations/workspace-migration-and-backfill-runbook.md` | covered | Strong policy + runbook coverage. |
| Contribution process | `CONTRIBUTING.md`, `docs/developer/contributing.md` | covered | Root and developer docs both present. |
| App/package local entrypoint docs | none under `apps/*` or `packages/*` | missing | Add focused `README.md` files in key app/package roots. |

## Operations and Release Coverage

| Operations area | Current docs | Coverage status | Notes |
| --- | --- | --- | --- |
| General troubleshooting and incident triage | `docs/operations/troubleshooting.md`, `docs/operations/runbooks-index.md` | covered | Includes first-response checklist and symptom map. |
| Deployment and scaling | `docs/operations/deployment.md` | covered | Includes scheduler role and topology guidance. |
| Workspace/path and attachment safety runbooks | `docs/operations/workspace-path-surface.md`, `docs/operations/workspace-migration-and-backfill-runbook.md`, `docs/operations/attachments-storage-runbook.md` | covered | Centralized path hardening coverage. |
| Codex-specific runtime debugging | `docs/codex-connection-debugging.md` | covered | Narrow, intentionally specific runbook. |
| Release workflow and gates | `docs/release-process.md`, `docs/release-gate-checklist.md`, `docs/release/versioning-and-changelog.md` | covered | Keep changelog entries synchronized with releases. |
| Release notes/changelog completeness | `CHANGELOG.md` | needs-refresh | Verify latest release entries are represented consistently. |

