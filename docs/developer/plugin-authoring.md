# Plugin Authoring

This page is the practical guide for creating and rolling out plugins in Bopo.

## Purpose

Provide a reliable path from manifest design to production-safe rollout.

## Intended Audience

- Engineers building new plugin behavior.
- Engineers maintaining plugin manifests and company rollout policies.

## Authoring Model

A plugin is defined by a manifest validated by `PluginManifestSchema` in `packages/contracts/src/index.ts`.

Core manifest fields:

- `id`, `version`, `displayName`
- `kind` (`lifecycle` | `tool` | `integration`)
- `hooks` (heartbeat lifecycle hook list)
- `capabilities`
- `runtime` (`type`, `entrypoint`, `timeoutMs`, `retryCount`, optional prompt fields)

## Runtime Types

Supported by schema:

- `builtin`
- `stdio`
- `http`
- `prompt`

Implemented in runtime today:

- `builtin`: in-process executors (`plugin-runtime.ts`).
- `prompt`: prompt-template patching, optional trace events, optional webhooks.

Reserved for future expansion:

- `stdio`
- `http`

## Step-By-Step Authoring

### 1) Draft a manifest

```json
{
  "id": "knowledge-context-plugin",
  "version": "0.1.0",
  "displayName": "Knowledge Context Plugin",
  "description": "Inject external context before adapter execution.",
  "kind": "lifecycle",
  "hooks": ["beforeAdapterExecute"],
  "capabilities": ["emit_audit"],
  "runtime": {
    "type": "prompt",
    "entrypoint": "prompt:inline",
    "timeoutMs": 5000,
    "retryCount": 0,
    "promptTemplate": "Knowledge context for run {{runId}} (agent {{agentId}})."
  }
}
```

### 2) Register plugin

Option A (filesystem discovery):

1. Create `plugins/<plugin-id>/plugin.json`.
2. Restart API.
3. Runtime registers valid manifests at startup.

Option B (API install from JSON):

```bash
curl -X POST "http://localhost:4020/plugins/install-from-json" \
  -H "content-type: application/json" \
  -H "x-company-id: <company-id>" \
  -d '{
    "manifestJson": "{...}",
    "install": true
  }'
```

### 3) Configure company install

Install + configure via:

- `POST /plugins/:pluginId/install`
- `PUT /plugins/:pluginId`

### 4) Handle risky capabilities

For high-risk grants (`network`, `queue_publish`, `issue_write`, `write_memory`), use `requestApproval: true` unless your rollout policy explicitly allows direct grant.

### 5) Verify in observability

Inspect:

- `GET /plugins/runs`
- `GET /observability/plugins/runs`

Validate status, diagnostics, and side effects before broad rollout.

## Prompt Plugin Notes

Prompt runtime supports template variables:

- `{{pluginId}}`, `{{companyId}}`, `{{agentId}}`, `{{runId}}`, `{{hook}}`, `{{summary}}`, `{{providerType}}`
- `{{pluginConfig}}`, `{{webhookUrl}}`, `{{webhookRequests}}`, `{{traceEvents}}`

Prompt plugin config supports:

- `webhookRequests` (requires `network` or `queue_publish` capability + grant)
- `traceEvents` (requires `emit_audit`)

If webhook execution fails or times out, plugin execution is marked failed.

## Rollout Guidance

Use this sequence:

1. Register plugin manifest.
2. Install disabled.
3. Request/approve risky grants.
4. Enable for one company or low-risk agent cohort.
5. Monitor run outcomes and audit events.
6. Expand rollout.

## Related Pages

- Architecture overview: [`plugin-system.md`](./plugin-system.md)
- Hook semantics: [`plugin-hook-reference.md`](./plugin-hook-reference.md)
- Sample manifests: [`plugin-samples.md`](./plugin-samples.md)
- API endpoints: [`api-reference.md`](./api-reference.md)
- Configuration knobs: [`configuration-reference.md`](./configuration-reference.md)
- Operator workflow: [`../product/plugins-and-integrations.md`](../product/plugins-and-integrations.md)
