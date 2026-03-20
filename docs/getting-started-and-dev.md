# Getting Started and Developer Guide

This page contains developer-focused details that are intentionally kept out of the top-level `README.md`.

For the full docs map, start at [`docs/index.md`](./index.md).

## Architecture

### Monorepo Layout

- `apps/web`: Next.js 16 web client ([`apps/web/README.md`](../apps/web/README.md)).
- `apps/api`: Express API and realtime websocket hub ([`apps/api/README.md`](../apps/api/README.md)).
- `packages/contracts`: shared schemas and realtime contracts ([`packages/contracts/README.md`](../packages/contracts/README.md)).
- `packages/db`: PGlite/Drizzle schema and repositories ([`packages/db/README.md`](../packages/db/README.md)).
- `packages/agent-sdk`: runtime adapters and execution plumbing ([`packages/agent-sdk/README.md`](../packages/agent-sdk/README.md)).
- `packages/adapters`: provider implementations ([`packages/adapters/README.md`](../packages/adapters/README.md)).
- `packages/ui` and `packages/config`: shared UI/config.

### Runtime Flow

1. The web app requests data/actions over HTTP from the API.
2. The API persists state via `bopodev-db`.
3. Heartbeat and governance workflows publish realtime updates.
4. The web app subscribes to `/realtime` channels for live status.

### Workspace and Path Model

Use [`docs/developer/workspace-resolution-reference.md`](./developer/workspace-resolution-reference.md) as the canonical source for workspace root derivation, runtime cwd selection precedence, and path boundary invariants.

## Tech Stack

- Monorepo: pnpm workspaces and Turbo
- API: Express and TypeScript
- Web: Next.js 16 and Turbopack with shadcn/ui patterns
- Database: embedded Postgres via PGlite and Drizzle ORM
- Tests: Vitest, Supertest, and Playwright

## Setup Paths

### One-Command Onboarding

```bash
npx bopodev onboard --yes
```

First-run behavior:

- You are prompted for a required default company name, even with `--yes`.
- You choose a required primary agent framework (for example `codex`, `openai_api`, or `anthropic_api`) used for the bootstrapped `CEO` agent.
- Onboarding persists the company name for future runs.
- Onboarding creates the first agent automatically: `CEO` with `role: "CEO"` and hiring enabled.
- Onboarding seeds a CEO startup issue under the `Leadership Setup` project.
- If an older demo/bootstrap CEO (`echo` runtime) is detected, onboarding migrates that agent to your selected framework.

### Local Workspace Shortcut

```bash
pnpm onboard
```

### Manual Fallback

1. Copy env template:
   - `cp .env.example .env`
2. Install dependencies:
   - `pnpm install`
3. Start all apps:
   - `pnpm start`

### VPS/Container Shortcut

```bash
export BOPO_AUTH_TOKEN_SECRET="$(openssl rand -hex 32)"
docker compose -f docker-compose.quickstart.yml up --build
```

For full VPS guidance, see [`operations/deployment.md`](./operations/deployment.md).

### Default Local Ports

- Web: `http://localhost:4010`
- API: `http://localhost:4020`

## Environment and Runtime Details

- The web app reads API URL from `NEXT_PUBLIC_API_URL`.
- Deployment profile is controlled by `BOPO_DEPLOYMENT_MODE` (`local`, `authenticated_private`, `authenticated_public`).
- Agent runtime working directories are resolved from each project's primary workspace `cwd` when available.
- `NEXT_PUBLIC_DEFAULT_RUNTIME_CWD` is an optional fallback.
- Embedded DB defaults to `~/.bopodev/instances/default/db/bopodev.db`; set `BOPO_DB_PATH` only to override.
- Projects can hold multiple workspaces; exactly one workspace should be marked primary for deterministic runtime path selection.
- If no primary workspace `cwd` exists, runtime falls back to the agent runtime cwd or an agent fallback workspace path.
- If a primary workspace defines `repoUrl`, heartbeat bootstraps the local repo path (clone/fetch/checkout) before adapter execution.
- `isolated + git_worktree` policy mode is available behind `BOPO_ENABLE_GIT_WORKTREE_ISOLATION`.
- Override workspace root with `BOPO_INSTANCE_ROOT`.
- Agent fallback workspaces are created under `~/.bopodev/instances/default/workspaces/<companyId>/agents/<agentId>` when project paths are unavailable.
- Full path sink inventory and guardrail mapping: [`docs/operations/workspace-path-surface.md`](./operations/workspace-path-surface.md).

## Command Reference

- `pnpm dev` - run workspace dev tasks using `scripts/dev-runner.mjs`
- `pnpm dev:full` - run raw `turbo dev` without the dev wrapper
- `pnpm start` - run workspace apps in production mode using `scripts/start-runner.mjs`
- `pnpm start:quiet` - run production apps with quieter Turbo log output
- `pnpm onboard` - run local onboarding flow with defaults plus required company naming on first run
- `pnpm doctor` - run local environment checks
- `pnpm typecheck` - run TypeScript checks
- `pnpm lint` - run lint/type lint tasks
- `pnpm test` - run unit/integration suite
- `pnpm test:coverage` - run tests with coverage thresholds
- `pnpm test:e2e` - run Playwright smoke tests
- `pnpm build` - build all packages/apps
- `pnpm unstick` - stop stray dev/API processes and free `WEB_PORT` / `API_PORT` without deleting data (works from any package dir; resolves monorepo root via `pnpm-workspace.yaml`)
- `pnpm clear` - stop local Bopo runtime processes, reset instance storage, clear onboarding env keys, and reinitialize API DB
- `pnpm smoke:vps` - run post-deploy smoke checks against configured VPS endpoints
- `pnpm publish:all` - build and publish public packages
- `pnpm publish:all:dry` - dry-run publish sequence for release verification

## Core Routes

- `/issues`
- `/dashboard`
- `/projects`
- `/goals`
- `/agents`
- `/org-chart`
- `/office-space`
- `/governance`
- `/inbox`
- `/runs`
- `/plugins`
- `/templates`
- `/models`
- `/trace-logs`
- `/costs`
- `/settings`
- `/settings/templates`
- `/settings/plugins`
- `/settings/models`

`/` redirects to `/issues`.

## Back up your local instance (onboarding costs time and API spend)

Your companies, agents, and issues live in PGlite under the instance **`db`** directory (default: `~/.bopodev/instances/default/db/bopodev.db`). If that store is deleted or corrupted, you must **onboard again**.

After a successful `pnpm onboard`, keep a copy you can restore without paying again:

```bash
# Example: timestamped backup of the whole db folder
cp -R ~/.bopodev/instances/default/db ~/Desktop/bopodev-db-backup-$(date +%Y%m%d)
```

To restore: stop the API (`Ctrl+C`), replace `db/` with your backup, start the API again. For a broken store, recovery steps are in [`docs/operations/troubleshooting.md`](./operations/troubleshooting.md) (PGlite).

## First-Run Notes

Issue creation requires a real project in the selected company:

1. Create a project via `New Project`.
2. Create issues and assign that project in the issue modal.

## Wrapper Script Behavior

- `pnpm dev` (`scripts/dev-runner.mjs`):
  - finds open ports near `WEB_PORT` (`4010`) and `API_PORT` (`4020`),
  - injects `NEXT_PUBLIC_API_URL=http://127.0.0.1:<apiPort>`,
  - sets `BOPO_SKIP_CODEX_PREFLIGHT=1` for local dev startup ergonomics.
- `pnpm start` (`scripts/start-runner.mjs`):
  - also auto-selects open ports near `WEB_PORT`/`API_PORT`,
  - injects `NEXT_PUBLIC_API_URL` for web runtime,
  - optionally auto-opens browser unless disabled (`BOPO_OPEN_BROWSER=0`).
- `pnpm unstick` (`scripts/unstick.mjs` + `unstickBopoRuntime` in `scripts/clear.mjs`):
  - walks up to the directory that contains `pnpm-workspace.yaml`, loads that root’s `.env`, then applies the same port + process scan as the first phase of `pnpm clear` (no file or DB deletion).
- `pnpm clear` (`scripts/clear.mjs`):
  - detects and stops local Bopo processes bound to runtime ports,
  - removes the active instance root and optional external DB path,
  - clears onboarding defaults from `.env`,
  - runs `pnpm --filter bopodev-api db:init`.

## Testing and Release Gates

Open-source beta release requires all of:

- `pnpm typecheck`
- `pnpm lint`
- `pnpm test:coverage`
- `pnpm test:e2e`
- `pnpm build`

See [`docs/release-gate-checklist.md`](./release-gate-checklist.md) for details and critical workflow matrix.
Release/tag workflow is documented in [`docs/release-process.md`](./release-process.md).

## Additional References

- Product docs: [`docs/product/index.md`](./product/index.md)
- Developer docs: [`docs/developer/index.md`](./developer/index.md)
- Operations docs: [`docs/operations/index.md`](./operations/index.md)
- Release docs: [`docs/release/index.md`](./release/index.md)

## Troubleshooting

- **`pnpm start` then `pnpm dev` “loses” the DB or data:** The API uses embedded PGlite on disk (`~/.bopodev/instances/default/db/…` by default). If the API process is **force-killed** (IDE stop, closing the terminal tab without Ctrl+C, etc.), the DB file can stay **locked** or corrupted and the next run may abort on startup or look empty. **Use Ctrl+C** to stop `pnpm start` or `pnpm dev` so the API can close PGlite cleanly. If it still breaks, run `pnpm unstick` to stop stray Node processes, then retry. Worst case, follow PGlite recovery in [`docs/operations/troubleshooting.md`](./operations/troubleshooting.md).
- **Production `pnpm start` UI can’t reach the API:** `next build` **bakes** `NEXT_PUBLIC_API_URL` at build time (often `http://localhost:4020`). If `start-runner` shifts the API to another port because `4020` is busy, the **built** web app still calls `4020` until you rebuild with the matching URL or free `4020`. The `pnpm start` banner warns when the API port is non-default.
- **Dev saves do not appear in the browser:** `pnpm dev` prints the exact **Web** and **API** URLs at startup. If default ports `4010` / `4020` are already in use, the dev runner binds the next free ports (`4011`, etc.). An old tab on `:4010` will show a stale or different server—open the URL from the terminal banner instead. Run `pnpm unstick` from the monorepo root and restart `pnpm dev` if ports or stray processes are confused.
- API health endpoint: `GET /health` includes DB readiness and runtime command readiness.
- Codex troubleshooting runbook: `docs/codex-connection-debugging.md`.
- Agent runtime execution supports local CLI commands for Claude Code and Codex.
- Direct API execution is also supported via `openai_api` and `anthropic_api` when local CLIs are not installed.
