# Codex Connection Debugging Runbook

This runbook is for debugging the full Codex execution path:
web trigger -> API heartbeat -> adapter runtime -> Codex CLI -> observability UI.

## Preflight

1. Confirm API health:
   - `GET /health`
   - Expect `ok: true`, `db.ready: true`, and `runtime.codex.available: true`.
2. Confirm Codex CLI visibility in the API runtime environment:
   - Ensure `BOPO_CODEX_COMMAND` points to a valid executable when default `codex` is not in PATH.
3. Confirm company scope:
   - All API requests must include `x-company-id`.
4. Confirm communication preflight behavior:
   - Set `BOPODEV_COMMUNICATION_PREFLIGHT=true` to enable heartbeat connectivity checks before Codex execution.
   - Optional timeout override: `BOPODEV_COMMUNICATION_PREFLIGHT_TIMEOUT_MS` (default 1500).

## Quick triage checklist

1. Open Trace Logs -> Heartbeat Runs and locate the failing run.
2. Open Run Details and check:
   - `requestId`
   - `trigger`
   - `failureType`
   - `attemptCount` and `attempts`
   - `stderrPreview`
3. Match the run ID with audit events:
   - `heartbeat.completed`
   - `heartbeat.failed`
   - `heartbeat.release_failed` (cleanup issue)
   - `heartbeat.sweep.completed`

## Common failure signatures

- `failureType: spawn_error` with `ENOENT`
  - Runtime command is missing.
  - Fix by installing Codex CLI or setting `BOPO_CODEX_COMMAND`.

- `failureType: timeout` and `timedOut: true`
  - Runtime exceeded `timeoutMs`.
  - Increase timeout in agent runtime state or investigate runtime hangs.

- `unexpected argument '--reasoning-effort'` (Codex CLI stderr)
  - Your `codex` build does not accept that flag. Bopo does **not** pass it unless **`BOPO_CODEX_PASS_REASONING_EFFORT=1`** on the API (default off). Upgrade Codex if you need the flag, or leave the env unset.

- `stateParseError` present
  - Agent `stateBlob` is malformed JSON.
  - Reset state in agent config and rerun heartbeat.

- Run stuck as `started` (unexpected)
  - Check scheduler errors and overlapping triggers.
  - Stale started runs are auto-recovered after `BOPO_HEARTBEAT_STALE_RUN_MS` (default 10 minutes).

## Reproduce failure injection tests locally

- Runtime reliability tests:
  - `pnpm vitest tests/runtime-reliability.test.ts`
- Skill injection + runtime failure tests:
  - `pnpm vitest tests/runtime-skill-injection.test.ts`
- End-to-end heartbeat failure handling:
  - `pnpm vitest tests/core-workflows.test.ts`

## Expected healthy behavior

- Every heartbeat transitions to `completed`, `failed`, or `skipped`.
- Claimed issues are always released even when runtime execution fails.
- `/health` reports DB and Codex runtime readiness.
- Run details provide enough diagnostics to root-cause failures without reproducing blindly.
- Run traces and summaries expose runtime and execution diagnostics for fast triage.
- Control-plane base URL resolves through one normalized path (`BOPODEV_API_BASE_URL` -> `NEXT_PUBLIC_API_URL` -> `http://127.0.0.1:4020`).
- When preflight is enabled and control-plane connectivity is broken, heartbeat fails fast with a specific preflight error before token spend.
