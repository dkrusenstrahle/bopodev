# Workspace Path Surface Inventory

This inventory documents write/delete/runtime path sinks involved in workspace resolution so path hardening can be reviewed in one place.

## Managed Root Policy

- Managed workspace root: `resolveBopoInstanceRoot()/workspaces`
- Managed company root: `resolveBopoInstanceRoot()/workspaces/<companyId>`
- Rule: runtime cwd, workspace cwd, git worktree roots, and attachment materialization must stay inside the company root.

## Path Sinks and Enforcement

| Area | Sink | Path Source | Current Guard |
| --- | --- | --- | --- |
| `apps/api/src/routes/projects.ts` | `mkdir(workspace.cwd)` | API payload `workspace.cwd` | `normalizeCompanyWorkspacePath(..., { requireAbsoluteInput: true })` |
| `apps/api/src/routes/agents.ts` | `mkdir(runtimeCwd)` and runtime preflight cwd | API payload `runtimeCwd`/`runtimeConfig.runtimeCwd` | `assertRuntimeCwdForCompany()` |
| `apps/api/src/services/governance-service.ts` | `mkdir(runtimeCwd)` and startup workspace provisioning | approval payload + DB workspace rows | `assertRuntimeCwdForCompany()` + `normalizeCompanyWorkspacePath()` |
| `apps/api/src/services/heartbeat-service/heartbeat-run.ts` | runtime cwd selection + `mkdir(base/fallback)` | project workspace context + agent runtime | company-root normalization before use |
| `apps/api/src/routes/issues.ts` | attachment write/read/delete paths | project workspace cwd + `relativePath` | workspace resolved via company-root normalization + `isInsidePath` checks |
| `apps/api/src/routes/observability.ts` | run artifact download path resolution | run report artifact `absolutePath` / `relativePath` | `apps/api/src/lib/run-artifact-paths.ts` `resolveRunArtifactAbsolutePath()` + `isInsidePath` against company workspace root |
| `apps/api/src/lib/git-runtime.ts` | clone/worktree target dir creation and stale cleanup `rm -r` | project workspace policy + git strategy root | company-root assertions + per-candidate inside-root checks |
| `apps/api/src/scripts/backfill-project-workspaces.ts` | normalization and `mkdir` for legacy relative cwd | DB workspace rows | deterministic company-root anchoring |
| `apps/api/src/scripts/onboard-seed.ts` | startup workspace/runtime provisioning | DB defaults + fallback workspaces | company-root normalization before `mkdir` |
| `packages/cli/src/lib/checks.ts` | writability checks | env-derived instance root | check mode no longer auto-creates directories |

## Remaining Risk Notes

- Existing DB rows that point outside managed roots are now rejected at runtime paths and should be fixed by migration/backfill.
- Git remote allowlist now matches host/path semantics, but policy values should still be reviewed for overly broad host-only entries.
- Heartbeat artifact payloads may include legacy path shapes; keep observability route normalization aligned with heartbeat report output formats.
