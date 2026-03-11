# Plugin Runbook

This runbook is for diagnosing plugin workflow incidents.

## Purpose

Reduce time to isolate and remediate plugin failures, policy blocks, and rollout regressions.

## Intended Audience

- On-call contributors and operators responding to plugin-related incidents.

## First Response Checklist

1. Capture identifiers: `x-request-id`, `runId`, `pluginId`, `companyId`.
2. Confirm plugin system is enabled (`BOPO_PLUGIN_SYSTEM_DISABLED` and legacy enabled flag).
3. Inspect plugin runs:
   - `GET /observability/plugins/runs?runId=<run-id>`
   - `GET /plugins/runs?pluginId=<plugin-id>&limit=50`
4. Verify plugin company config:
   - installed/enabled state
   - granted capabilities
   - plugin config JSON
5. Check governance inbox for pending capability approvals.

## Symptom -> Likely Cause

- **`blocked` plugin runs**
  - Missing granted high-risk capability (`network`, `queue_publish`, `issue_write`, `write_memory`).
- **`failed` runs on prompt webhook plugins**
  - webhook timeout, DNS/connectivity failure, or allowlist rejection.
- **Plugin not visible in catalog**
  - invalid manifest schema, duplicate plugin ID, or manifests directory mismatch.
- **Plugin appears installed but does not run**
  - plugin disabled for company or hook mismatch.
- **Cannot delete plugin**
  - plugin is built-in (`runtimeEntrypoint` starts with `builtin:`).

## Capability And Governance Triage

1. Compare plugin manifest `capabilities` vs config `grantedCapabilities`.
2. If high-risk capability missing:
   - submit update with `requestApproval: true`
   - resolve approval in governance
3. Re-run heartbeat and confirm status transitions from `blocked` to expected status.

## Webhook Triage

Checks:

- Confirm plugin has capability/grant for `network` or `queue_publish`.
- Validate `BOPO_PLUGIN_WEBHOOK_ALLOWLIST` host list.
- Validate webhook URL hostname exactly matches allowlist entry.
- Check timeout (`timeoutMs`) and destination service health.

Typical failure string:

- `Webhook URL not allowed by BOPO_PLUGIN_WEBHOOK_ALLOWLIST.`

## Manifest Triage

Filesystem manifests:

1. Confirm file location: `plugins/<plugin-id>/plugin.json` (or custom `BOPO_PLUGIN_MANIFESTS_DIR`).
2. Validate required fields and runtime schema.
3. Restart API to reload manifests.
4. Check startup warnings for invalid manifest parsing.

## Recovery Actions

- Disable plugin quickly with `PUT /plugins/:pluginId` and `"enabled": false`.
- Uninstall company plugin: `DELETE /plugins/:pluginId/install`.
- Delete custom plugin definition: `DELETE /plugins/:pluginId`.
- Roll forward with corrected manifest/config and re-enable in stages.

## Escalation Criteria

Escalate if:

- multiple plugins fail across hooks after deploy
- governance approvals apply but grants still appear ineffective
- plugin runs are missing despite confirmed heartbeat completion

Include:

- failing `runId` + `pluginId`
- request/response snippets for plugin route operations
- env flags affecting plugin runtime

## Related Pages

- Runbooks index: [`runbooks-index.md`](./runbooks-index.md)
- Plugin architecture: [`../developer/plugin-system.md`](../developer/plugin-system.md)
- Plugin hook reference: [`../developer/plugin-hook-reference.md`](../developer/plugin-hook-reference.md)
- Operator plugin workflow: [`../product/plugins-and-integrations.md`](../product/plugins-and-integrations.md)
