# bopodev-plugin-sdk

SDK for authoring worker-based plugins on the v2 plugin platform.

## What this package is for

Use this package to:

- define a plugin with typed metadata and handlers
- run a JSON-RPC worker process that serves plugin surfaces
- implement hooks, actions, data endpoints, jobs, webhooks, and health checks

## Main exports

- `definePlugin(definition)`
- `runWorker(definition, context)`
- `PluginSetupContext`
- `PluginInvocationResult`
- `BopoPluginContext`
- `BopoPluginDefinition`

## Basic worker pattern

1. Build a plugin definition with `definePlugin(...)`.
2. Register handlers in setup (`hooks`, `actions`, `data`, `jobs`, `webhooks`).
3. Start the worker with `runWorker(...)`.
4. Return consistent invocation results (`status`, `summary`, optional `diagnostics`).

## See also

- Authoring guide: `docs/developer/plugin-authoring.md`
- Sample package: `packages/plugin-sdk-sample`
- Local demo plugin: `plugins/runtime-demo`
