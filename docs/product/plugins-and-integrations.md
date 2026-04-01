# Plugins And Integrations

This page explains the operator workflow for managing plugins in Bopo.

## Purpose

Help operators safely extend heartbeat behavior without editing core API code.

## Intended Audience

- Founders, engineering managers, and operators configuring company workflows.
- Contributors who need a UI/API runbook for plugin rollout and rollback.

## Plugin Lifecycle

1. Discover plugins in the catalog (`/plugins`).
2. Install plugin package (or use discovered filesystem plugin).
3. Configure enabled state, priority, and config payload.
4. Request approvals for risky capability grants when needed.
5. Validate health/action/data/webhook behavior.
6. Monitor plugin runs and diagnose blocked/failed outcomes.
7. Rollback to prior install revision if a release regresses.
8. Disable or delete plugin definition when it is no longer needed.

## Where Operators Work

- **Workspace Plugins page**
  - Primary interface for browsing plugins, install/activate/deactivate, and run preview.
- **Settings Plugins page**
  - Secondary plugin management entry point.
- **Governance Inbox**
  - Review and resolve approvals created by risky grants.
- **Observability**
  - Inspect plugin run history and per-run diagnostics.

## Install And Enable

Install by npm package:

```bash
curl -X POST "http://localhost:4020/plugins/install" \
  -H "content-type: application/json" \
  -H "x-company-id: <company-id>" \
  -d '{
    "packageName": "@your-scope/your-plugin",
    "version": "0.1.0"
  }'
```

Enable/configure plugin:

```bash
curl -X PUT "http://localhost:4020/plugins/<plugin-id>" \
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

Validate plugin behavior:

```bash
curl "http://localhost:4020/plugins/<plugin-id>/health" \
  -H "x-company-id: <company-id>"
```

## Capability Governance

Plugin permissions are namespace-based and risk-scored by policy.

When requesting elevated/restricted capability grants, use `requestApproval: true` so governance creates an approval record before applying.

Approval action type:

- `grant_plugin_capabilities`

Recommended rollout sequence:

1. Install plugin with `enabled: false`.
2. Request capability grants (approval-backed where required).
3. Resolve governance approval.
4. Enable plugin for a small cohort.
5. Run health checks and action/data smoke tests.
6. Monitor first runs before wider rollout.

## Monitor Plugin Runs

Read recent runs:

```bash
curl "http://localhost:4020/observability/plugins/runs?pluginId=<plugin-id>&limit=50" \
  -H "x-company-id: <company-id>"
```

Interpretation:

- `ok`: plugin executed successfully.
- `skipped`: no executable handler was available.
- `failed`: plugin execution attempted but failed.
- `blocked`: capability policy blocked execution.

## Upgrade And Rollback

List install revisions:

```bash
curl "http://localhost:4020/plugins/<plugin-id>/installs" \
  -H "x-company-id: <company-id>"
```

Rollback:

```bash
curl -X POST "http://localhost:4020/plugins/<plugin-id>/rollback" \
  -H "content-type: application/json" \
  -H "x-company-id: <company-id>" \
  -d '{"installId":"<prior-install-id>"}'
```

## Disable And Delete

- Disable plugin with `PUT /plugins/:pluginId` and `"enabled": false`.
- Delete plugin definition with `DELETE /plugins/:pluginId` (custom/discovered entries).

## Common Operator Decisions

- **Should we approve this namespace grant?**
  - Approve only if the plugin's declared behavior actually requires it.
- **When should we rollback?**
  - Rollback after new version regressions (health, action/data, or run errors).
- **How do we verify post-rollout safety?**
  - Check health + action/data smoke + run stream for `failed/blocked` spikes.

## Related Pages

- Plugin architecture: [`../developer/plugin-system.md`](../developer/plugin-system.md)
- Plugin authoring: [`../developer/plugin-authoring.md`](../developer/plugin-authoring.md)
- Hook semantics: [`../developer/plugin-hook-reference.md`](../developer/plugin-hook-reference.md)
- Governance: [`governance-and-approvals.md`](./governance-and-approvals.md)
- Plugin runbook: [`../operations/plugin-runbook.md`](../operations/plugin-runbook.md)
