# Troubleshooting

This page provides a general triage framework for Bopo incidents.

## Purpose

Reduce mean time to diagnose failures across API, runtime, and UI surfaces.

## Intended Audience

- Contributors and operators debugging broken workflows.

## First Response Checklist

1. Verify API health: `GET /health`.
2. Verify deployment mode/env baseline:
   - `BOPO_DEPLOYMENT_MODE`
   - `BOPO_ALLOWED_ORIGINS`
   - `BOPO_ALLOWED_HOSTNAMES`
   - `BOPO_AUTH_TOKEN_SECRET` or trusted proxy header mode
2. Confirm request scoping:
   - `x-company-id`
   - actor headers (`x-actor-*`)
3. Capture identifiers:
   - `x-request-id`
   - `runId` / `approvalId` / `issueId`
4. Inspect latest `runs`, `trace-logs`, and governance inbox.
5. Verify environment config did not regress.

## API fails on startup: `RuntimeError: Aborted()` (PGlite / Drizzle)

**Symptom:** Node crashes while running `CREATE TABLE` during `bootstrapDatabase`, with `cause: RuntimeError: Aborted()` from `@electric-sql/pglite` (WASM).

**Likely cause:** Corrupted or locked PGlite data on disk, another process still holding the DB, incompatible Node/WASM edge case, or a bad `BOPO_DB_PATH`. **This is not caused by Codex CLI flags or heartbeat prompt mode** (those run only after the API has a working database).

**Recovery (local dev):**

1. Stop every `pnpm dev` / API / test process that might use the same instance.
2. Note your data path: default is `~/.bopodev/instances/default/db/bopodev.db` unless `BOPO_DB_PATH` / `BOPO_INSTANCE_*` overrides it.
3. **Back up** that path (file or directory, depending on PGlite version), then **delete** it so bootstrap can recreate an empty database.
4. Restart the API. You will need to re-seed or onboard if you had no external backup.
5. If it still aborts, try **Node 20 LTS** (some WASM builds are sensitive to very new Node versions) and run `pnpm install` cleanly.

## Symptom -> Likely Cause

- **Heartbeat fails before execution**
  - runtime preflight, command availability, or control-plane communication settings.
- **Run stuck in `started`**
  - scheduler overlap, worker interruption, or stale-run recovery threshold too high.
- **Governance action appears unresolved**
  - inbox state (`dismissed`/`seen`) vs actual approval status mismatch.
- **Missing realtime updates**
  - websocket reconnect gaps, snapshot application ordering, company scope mismatch, or missing `authToken` in authenticated modes.
- **Attachment upload errors**
  - file count/size/mime/extension limits exceeded.

## Focused Checks

- Runtime configuration:
  - provider type, command, args, cwd, env, timeout.
- Deployment mode:
  - in authenticated modes, verify actor identity source (Bearer actor token or trusted proxy-injected actor headers).
- Realtime auth:
  - verify websocket URL includes `authToken` when using token mode.
- CORS/hosts:
  - verify browser origin appears in `BOPO_ALLOWED_ORIGINS` and host appears in `BOPO_ALLOWED_HOSTNAMES`.
- Policy and security:
  - sandbox mode, web-search allowance, approval defaults.
- Data integrity:
  - invalid runtime state blobs, malformed JSON payloads.
- Startup warnings:
  - codex preflight warnings and default-company resolution warnings.
- Observability artifact access:
  - verify `GET /observability/heartbeats/:runId/artifacts/:artifactIndex/download` returns a file and the artifact path stays inside company workspace roots.
- Memory observability:
  - verify `GET /observability/memory` and `GET /observability/memory/:agentId/context-preview` responses match expected company and project scope.

## Recovery Patterns

- Re-run heartbeat with corrected runtime config.
- Clear malformed state env values and retry.
- Resolve pending approvals blocking expected side effects.
- Use `redo` only after root cause is understood.
- If running multiple API instances, verify scheduler ownership (`BOPO_SCHEDULER_ROLE`) and keep only one leader.

## Related Runbooks

- Codex-specific: [`../codex-connection-debugging.md`](../codex-connection-debugging.md)
- Index: [`runbooks-index.md`](./runbooks-index.md)
- Workspace path surface: [`workspace-path-surface.md`](./workspace-path-surface.md)
- Attachment storage: [`attachments-storage-runbook.md`](./attachments-storage-runbook.md)

