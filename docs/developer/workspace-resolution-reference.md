# Workspace Resolution Reference

This page is the canonical model for workspace and path behavior in Bopo.

## Scope

It defines:

- how instance and workspace roots are derived
- where project and agent files are allowed to exist
- runtime cwd resolution precedence
- git bootstrap/worktree behavior
- attachment materialization rules

## Root Derivation

Base instance root is resolved from:

1. `BOPO_INSTANCE_ROOT` (if set)
2. otherwise `BOPO_HOME/instances/<BOPO_INSTANCE_ID>`
3. otherwise `~/.bopodev/instances/<BOPO_INSTANCE_ID>`

`BOPO_INSTANCE_ID` must match the safe segment pattern `[a-zA-Z0-9_-]+`.

Managed workspace root:

- `<instanceRoot>/workspaces`

Managed company root:

- `<instanceRoot>/workspaces/<companyId>`

## Canonical Filesystem Layout

```text
<instanceRoot>/
  workspaces/
    <companyId>/
      projects/
        <projectId>/
          issues/
            <issueId>/
              ...
          .bopo/
            issues/
              <issueId>/
                attachments/
      agents/
        <agentId>/
          operating/
          tmp/
          memory/
            life/
            memory/
          worktrees/
            <projectId>/
              <worktreeDir>/
  data/
    storage/
```

## Boundary Invariants

All mutable workspace paths must stay inside the managed company root:

- project workspace `cwd`
- agent runtime `runtimeCwd`
- git worktree `strategy.rootDir`
- attachment absolute paths after materialization

API ingress paths use strict validation and reject invalid/out-of-root values.

## Runtime Cwd Resolution Precedence

Heartbeat runtime resolution follows this model:

1. Load assigned work items and project workspace context.
2. If policy mode is `agent_default` and runtime cwd exists, use bounded agent runtime cwd.
3. Otherwise use project primary workspace cwd.
4. If project has `repoUrl`, bootstrap repo in selected project workspace.
5. If mode is `isolated` with `git_worktree` and isolation flag enabled, switch to isolated worktree cwd.
6. If no project workspace is available, fall back to bounded agent runtime cwd.
7. If agent runtime cwd is missing, use deterministic agent fallback workspace path.

Notes:

- In mixed-project work item sets, current selection is first eligible project context.
- Warning events are emitted when fallback or override occurs.

Before each heartbeat execution, the API ensures `agents/<agentId>/operating/` exists under the company workspace (empty directory is fine).

Heartbeat runtimes receive canonical absolute paths in env (in addition to `BOPODEV_COMPANY_ID`):

- `BOPODEV_COMPANY_WORKSPACE_ROOT` — `<instanceRoot>/workspaces/<companyId>`
- `BOPODEV_AGENT_HOME` — `<instanceRoot>/workspaces/<companyId>/agents/<agentId>`
- `BOPODEV_AGENT_OPERATING_DIR` — `.../agents/<agentId>/operating`

Agents should write operating files using `$BOPODEV_AGENT_OPERATING_DIR` (or an absolute path under `BOPODEV_COMPANY_WORKSPACE_ROOT`) instead of guessing `workspace/...` segments from project cwd.

## Git Workspace Behavior

`git-runtime` enforces:

- target `cwd` for bootstrap inside company root
- optional `strategy.rootDir` inside company root
- stale worktree cleanup only inside the normalized worktree root
- remote allowlist using strict host/path semantics
- optional branch-prefix allowlist enforcement

## Attachments

Attachments are stored under:

- `<projectWorkspace>/.bopo/issues/<issueId>/attachments/...`

Read/download/delete paths are resolved and validated with inside-root checks to prevent traversal.

Issue runtime execution folders are separate from attachment storage and are resolved under:

- `<projectWorkspace>/issues/<issueId>/...`

## Run Artifact Paths In Issue Comments

Run summary comments keep artifact download links in the same route shape:

- `/observability/heartbeats/:runId/artifacts/:artifactIndex/download?companyId=...`

Artifact link labels are rendered as normalized workspace-relative paths (relative to `<instanceRoot>/workspaces/<companyId>`), not absolute host filesystem paths.

After a run completes, the API checks each reported artifact path on disk. Issue comments only include download links for artifacts that were present as files at that moment; missing paths are shown as monospace text with a short note instead of a broken link.

## Migration and Backfill

Backfill script behavior:

- creates missing project workspaces under deterministic managed paths
- converts legacy relative `cwd` entries to normalized company-rooted absolute paths
- supports dry-run reporting before apply mode

See operator details in:

- [`../operations/workspace-migration-and-backfill-runbook.md`](../operations/workspace-migration-and-backfill-runbook.md)

## Related Source Files

- [`../../apps/api/src/lib/instance-paths.ts`](../../apps/api/src/lib/instance-paths.ts)
- [`../../apps/api/src/lib/run-artifact-paths.ts`](../../apps/api/src/lib/run-artifact-paths.ts)
- [`../../apps/api/src/lib/workspace-policy.ts`](../../apps/api/src/lib/workspace-policy.ts)
- [`../../apps/api/src/lib/git-runtime.ts`](../../apps/api/src/lib/git-runtime.ts)
- [`../../apps/api/src/services/heartbeat-service/heartbeat-run.ts`](../../apps/api/src/services/heartbeat-service/heartbeat-run.ts)
- [`../operations/workspace-path-surface.md`](../operations/workspace-path-surface.md)
