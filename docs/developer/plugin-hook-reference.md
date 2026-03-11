# Plugin Hook Reference

This page defines plugin hook semantics used by heartbeat execution.

## Purpose

Clarify when each hook runs, what context is available, and how failures are handled.

## Execution Model

- Hooks execute through `runPluginHook(...)` in `apps/api/src/services/plugin-runtime.ts`.
- Enabled company plugins matching the requested hook are evaluated.
- High-risk capabilities are enforced before plugin execution.
- Each execution attempt records a `plugin_runs` row.
- Hook-level failures are aggregated into `plugin.hook.failures` audit events.

## Hook Catalog

### `beforeClaim`

Runs before heartbeat claims work for the agent.

Use for:

- pre-claim validation
- external scheduling checks

### `afterClaim`

Runs after work is claimed and heartbeat context is established.

Use for:

- claim metadata enrichment
- early trace annotations

### `beforeAdapterExecute`

Runs before adapter command execution.

Use for:

- prompt/runtime context augmentation
- pre-execution outbound webhook calls

### `afterAdapterExecute`

Runs after adapter returns output and run summary is available.

Use for:

- post-execution trace export
- memory candidate derivation

### `beforePersist`

Runs before final run state is persisted.

Use for:

- final validations and transformation checks

### `afterPersist`

Runs after run persistence and side-effect writes complete.

Use for:

- post-commit side effects
- integrations that should only fire after durable write

### `onError`

Runs in failure paths when heartbeat processing encounters an error.

Use for:

- failure trace export
- failure notifications and escalation events

## Failure And Status Semantics

Plugin run status values:

- `ok`: plugin completed successfully.
- `skipped`: no executable handler was found.
- `failed`: plugin execution attempted and failed.
- `blocked`: policy block (typically missing granted high-risk capability).

Behavior notes:

- Plugin failure does not always block overall heartbeat flow.
- Blocking behavior is controlled by `failClosed` when calling `runPluginHook(...)`.
- When `failClosed` is true, any hook failure can block caller flow.

## Prompt Runtime Hook Behavior

For `runtime.type: "prompt"`:

- Prompt template is rendered with hook context variables.
- `promptAppend` can be returned to augment adapter input.
- Optional `traceEvents` and `webhookRequests` are evaluated.

Capability requirements:

- `traceEvents` require `emit_audit`.
- `webhookRequests` require `network` or `queue_publish` and corresponding granted capability.

## Ordering And Priority

- Hook execution currently iterates enabled matching plugins from company config rows.
- Priority is stored on plugin config and should be used as an operator signal, but ordering guarantees should be treated as implementation-defined unless explicitly documented in runtime code/tests.

## Related Pages

- Plugin system architecture: [`plugin-system.md`](./plugin-system.md)
- Plugin authoring workflow: [`plugin-authoring.md`](./plugin-authoring.md)
- Operations runbook: [`../operations/plugin-runbook.md`](../operations/plugin-runbook.md)
