# Plugins And Integrations

This page explains the operator workflow for managing plugins in Bopo.

## Purpose

Help operators safely extend heartbeat behavior without editing core API code.

## Intended Audience

- Founders, engineering managers, and operators configuring company workflows.
- Contributors who need a UI/API runbook for plugin rollout and rollback.

## Plugin Lifecycle

1. Discover plugins in the catalog (`/plugins`).
2. Install a plugin for your company.
3. Configure enabled state, priority, and config payload.
4. Request approvals for risky capability grants when needed.
5. Monitor plugin runs and diagnose blocked/failed outcomes.
6. Disable or uninstall if behavior is not desired.
7. Delete custom plugins when they are no longer needed.

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

Install a plugin:

```bash
curl -X POST "http://localhost:4020/plugins/heartbeat-tagger/install" \
  -H "x-company-id: <company-id>"
```

Enable/configure plugin:

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

## Capability Governance

The following capabilities are treated as high risk:

- `network`
- `queue_publish`
- `issue_write`
- `write_memory`

If you include any high-risk capability in `grantedCapabilities` with `requestApproval: true`, Bopo creates a governance approval (`grant_plugin_capabilities`) instead of applying immediately.

Recommended rollout pattern:

1. Install plugin with `enabled: false`.
2. Request capability grants.
3. Resolve governance approval.
4. Enable plugin and monitor first runs.

## Monitor Plugin Runs

Read recent runs:

```bash
curl "http://localhost:4020/observability/plugins/runs?pluginId=heartbeat-tagger&limit=50" \
  -H "x-company-id: <company-id>"
```

Interpretation:

- `ok`: plugin executed successfully.
- `skipped`: no executable handler was available.
- `failed`: plugin execution attempted but failed.
- `blocked`: capability policy blocked execution.

## Disable, Uninstall, And Delete

- Disable plugin via `PUT /plugins/:pluginId` with `"enabled": false`.
- Uninstall for company via `DELETE /plugins/:pluginId/install`.
- Delete plugin definition via `DELETE /plugins/:pluginId` (custom plugins only; built-ins cannot be deleted).

## Common Operator Decisions

- **Should we approve network access?**
  - Approve only for plugins that need external webhooks/integrations.
- **Should this plugin fail closed?**
  - For critical compliance or policy workflows, fail-closed behavior can be appropriate.
- **Can we remove a built-in plugin?**
  - Built-ins can be disabled/uninstalled per company but not deleted globally.

## Related Pages

- Plugin architecture: [`../developer/plugin-system.md`](../developer/plugin-system.md)
- Plugin authoring: [`../developer/plugin-authoring.md`](../developer/plugin-authoring.md)
- Hook semantics: [`../developer/plugin-hook-reference.md`](../developer/plugin-hook-reference.md)
- Governance: [`governance-and-approvals.md`](./governance-and-approvals.md)
- Plugin runbook: [`../operations/plugin-runbook.md`](../operations/plugin-runbook.md)
