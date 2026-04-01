# Plugin Authoring

This guide explains exactly how to build, register, and ship plugins on the current v2 system.

## Before You Start

- Plugin manifests must be `apiVersion: "2"`.
- Runtime is worker-based (`stdio` or `http` runtime definitions).
- Legacy prompt/builtin authoring flows are removed.
- If you need a starting point, use `packages/plugin-sdk-sample` and `plugins/runtime-demo`.

## Plugin Surfaces You Can Implement

Your worker can register handlers for:

- `hooks`
- `actions`
- `data`
- `jobs`
- `webhooks`
- `health`

Use `packages/plugin-sdk` helpers in your plugin worker to register each surface.

## Minimal Manifest (v2)

```json
{
  "apiVersion": "2",
  "id": "my-runtime-plugin",
  "version": "0.1.0",
  "displayName": "My Runtime Plugin",
  "description": "Example plugin using worker runtime.",
  "kind": "integration",
  "hooks": ["afterPersist"],
  "runtime": {
    "type": "stdio",
    "entrypoint": "dist/worker.js",
    "timeoutMs": 5000,
    "retryCount": 0
  },
  "entrypoints": {
    "worker": "dist/worker.js",
    "ui": "ui"
  },
  "capabilityNamespaces": ["actions.execute", "data.read"],
  "ui": {
    "slots": [{ "slot": "workspacePage", "routePath": "/plugins/my-runtime-plugin" }]
  }
}
```

## Worker Contract

Your worker process receives JSON-RPC messages and returns plugin invocation results.

At minimum, each handler should return a valid invocation shape:

- `status` (`ok`, `skipped`, `failed`, `blocked`)
- `summary`
- optional `diagnostics`

### Practical pattern

1. Use `runWorker(...)` from `plugin-sdk`.
2. In setup, register handlers (`hooks.register`, `actions.register`, etc.).
3. Keep handler outputs small and deterministic.
4. Emit structured errors so operators can debug from plugin runs.

## UI Contract

If you expose UI:

- put UI assets in the plugin package (for example `ui/index.html`)
- declare `entrypoints.ui`
- declare `ui.slots[]` in manifest
- host loads UI from `GET /plugins/:pluginId/ui`

## Installation Paths

### Path A: Package install (recommended)

Use the API route:

```bash
curl -X POST "http://localhost:4020/plugins/install" \
  -H "content-type: application/json" \
  -H "x-company-id: <company-id>" \
  -d '{
    "packageName": "@your-scope/your-plugin",
    "version": "0.1.0"
  }'
```

This stores install metadata and revision history in `plugin_installs`.

### Path B: Filesystem discovery (local development)

1. Create `plugins/<plugin-id>/plugin.json`.
2. Place worker/ui files relative to that plugin folder.
3. Restart API.
4. Activate plugin from UI or `PUT /plugins/:pluginId`.

## Activation And Configuration

Enable plugin for a company:

```bash
curl -X PUT "http://localhost:4020/plugins/my-runtime-plugin" \
  -H "content-type: application/json" \
  -H "x-company-id: <company-id>" \
  -d '{
    "enabled": true,
    "priority": 100,
    "config": {},
    "requestApproval": false
  }'
```

## Capability Grants And Approvals

Capability namespaces are enforced per surface. If your plugin needs elevated/restricted namespaces:

1. Include them in manifest `capabilityNamespaces`.
2. Request grants through config update (`PUT /plugins/:pluginId`).
3. Use `requestApproval: true` when governance review is required.

If not granted, invocation returns `blocked` with diagnostic detail.

## Test Checklist For Plugin Authors

Before publishing:

1. **Manifest validation**: plugin appears in `/plugins`.
2. **Health check**: `GET /plugins/:pluginId/health` returns success.
3. **Action test**: call at least one action route.
4. **Data test**: call at least one data route.
5. **Hook test**: run a heartbeat and verify `/plugins/runs`.
6. **UI test**: open target slot and verify iframe rendering.
7. **Capability test**: verify both granted and blocked behavior paths.

## Common Mistakes

- Wrong worker path in manifest (most common).
- Using repo-relative instead of plugin-relative `entrypoint` in filesystem manifests.
- Declaring namespaces but never granting them in company config.
- Returning non-schema invocation payloads from worker handlers.

## Related

- System architecture: [`plugin-system.md`](./plugin-system.md)
- Samples: [`plugin-samples.md`](./plugin-samples.md)
- Hook reference: [`plugin-hook-reference.md`](./plugin-hook-reference.md)
- Operator guide: [`../product/plugins-and-integrations.md`](../product/plugins-and-integrations.md)
