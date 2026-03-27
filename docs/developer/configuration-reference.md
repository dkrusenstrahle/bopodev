# Configuration Reference

This page centralizes environment/runtime configuration used by Bopo.

## Purpose

Give contributors and operators one reference for key environment variables and defaults.

## Intended Audience

- Developers running local instances.
- Operators tuning runtime behavior and reliability.

## App and API Base Configuration

| Variable | Scope | Default | Notes |
| --- | --- | --- | --- |
| `NEXT_PUBLIC_API_URL` | Web | `http://localhost:4020` | Base URL used by web client. |
| `PORT` | API | `4020` | API server port. |
| `API_PORT` | Dev/start wrappers | `4020` | Preferred API port for `pnpm dev` and `pnpm start`; wrapper falls forward to next free port if occupied. |
| `WEB_PORT` | Dev/start wrappers | `4010` | Preferred web port for `pnpm dev` and `pnpm start`; wrapper falls forward to next free port if occupied. |
| `NEXT_PUBLIC_DEFAULT_COMPANY_ID` | Web | `demo-company` fallback in code | Preferred company for initial client load. |
| `BOPO_DEFAULT_COMPANY_ID` | API/CLI | unset | Default company for scheduler or startup behavior. |
| `BOPO_DEFAULT_COMPANY_NAME` | CLI seed | unset | Written during onboarding seed. |
| `BOPO_DEFAULT_AGENT_PROVIDER` | CLI seed | unset | Initial provider for bootstrapped CEO agent. |
| `BOPO_DEPLOYMENT_MODE` | API | `local` | Deployment profile: `local`, `authenticated_private`, or `authenticated_public`. |
| `BOPO_PUBLIC_BASE_URL` | API/Web | unset | Required in `authenticated_public`; canonical external API URL. |
| `BOPO_ALLOWED_ORIGINS` | API | unset in auth modes | Comma-separated CORS allowlist; required in authenticated modes. |
| `BOPO_ALLOWED_HOSTNAMES` | API | unset in auth modes | Comma-separated hostname allowlist for runtime and realtime host validation. |

## Persistence and Instance Paths

| Variable | Default | Notes |
| --- | --- | --- |
| `BOPO_DB_PATH` | `~/.bopodev/instances/default/db/postgres` | Explicit embedded Postgres data-directory override. |
| `BOPO_HOME` | `~/.bopodev` | Root home for instance defaults. |
| `BOPO_INSTANCE_ID` | `default` | Instance namespace in local paths. |
| `BOPO_INSTANCE_ROOT` | derived from `BOPO_HOME` + `BOPO_INSTANCE_ID` | Root for auto-created workspaces/storage. |

## Runtime Command and Adapter Settings

| Variable | Default | Notes |
| --- | --- | --- |
| `NEXT_PUBLIC_DEFAULT_RUNTIME_CWD` | empty | UI fallback working directory for new agents. |
| `BOPO_CODEX_COMMAND` | `codex` | Codex command override. |
| `BOPO_CODEX_PASS_REASONING_EFFORT` | unset (off) | When `1`/`true`/`yes`, heartbeat passes `--reasoning-effort` to `codex exec` if the agent’s stored thinking effort is not `auto`. Leave unset on CLI versions that error with `unexpected argument '--reasoning-effort'`. The web UI hides **Thinking effort** for Codex while this is off, since the value would not be forwarded. |
| `BOPO_OPENCODE_COMMAND` | `opencode` | OpenCode command override. |
| `BOPO_SKIP_CODEX_PREFLIGHT` | `0` | Skip startup codex command health checks when `1`. |
| `BOPO_SKIP_OPENCODE_PREFLIGHT` | `0` | Skip startup OpenCode command health checks when `1`. |
| `BOPO_REQUIRE_CODEX_HEALTH` | `0` unless codex agents exist | Force codex health checks at startup when `1`. |
| `BOPO_REQUIRE_OPENCODE_HEALTH` | `0` unless opencode agents exist | Force OpenCode health checks at startup when `1`. |
| `BOPO_VERBOSE_STARTUP_WARNINGS` | `0` | Adds detailed startup warning payloads when `1`. |
| `BOPO_CODEX_HOME_ROOT` | unset | Managed Codex home root override in runtime behavior. |
| `BOPO_CODEX_ALLOW_HOME_SEED` | `false` | Controls managed Codex home initialization behavior. |
| `BOPO_OPENCODE_MODEL` | unset | Optional OpenCode model for onboarding seed. If unset, onboarding attempts to auto-select from `opencode models`. |

## Owner assistant (Ask / company chat)

Uses the same direct API credentials as `openai_api` / `anthropic_api` agent runtimes (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, or `BOPO_*` variants). Read-only tools over the active company.

| Variable | Default | Notes |
| --- | --- | --- |
| `BOPO_CHAT_DEFAULT_BRAIN` | unset → `codex` | Default CLI `brain` on `POST /assistant/messages` when the client omits `brain`. Must be one of the ids returned by `GET /assistant/brains` (e.g. `codex`, `cursor`, `claude_code`). |
| `BOPO_ASSISTANT_PROVIDER` | `anthropic_api` | `anthropic_api` or `openai_api`. Used by the **direct API** assistant implementation (`runAssistantWithTools`); the standard web Chat sends CLI brains only unless the API schema is extended. |
| `BOPO_ASSISTANT_MODEL` | provider default | Override model id for direct API assistant turns. |
| `BOPO_ASSISTANT_MAX_TOOL_ROUNDS` | `8` | Max tool round-trips per user message for direct API mode (capped at 20). |
| `BOPO_ASSISTANT_TIMEOUT_MS` | `120000` | HTTP timeout per provider request in direct API mode (capped at 300000). |

## OpenClaw Gateway adapter (per-agent runtime)

Configure on the **agent** (runtime command + runtime environment), not as API process defaults. OpenClaw itself is documented at [docs.openclaw.ai](https://docs.openclaw.ai/) (see [Gateway](https://docs.openclaw.ai/gateway) and [Gateway protocol](https://docs.openclaw.ai/gateway/protocol)). For behavior (session keys, usage/cost, limitations), see [`../adapters/openclaw-gateway.md`](../adapters/openclaw-gateway.md).

| Key | Required | Notes |
| --- | --- | --- |
| Command or `OPENCLAW_GATEWAY_URL` | yes | WebSocket URL (`ws://` / `wss://`), e.g. local default port `18789`. |
| `OPENCLAW_GATEWAY_TOKEN` or `OPENCLAW_GATEWAY_PASSWORD` | yes | Matches gateway auth configuration. |
| `OPENCLAW_AGENT_ID` | no | Target agent id on the gateway. |
| `OPENCLAW_SESSION_KEY` | no | Fixed session key when using `OPENCLAW_SESSION_KEY_STRATEGY=fixed`. |
| `OPENCLAW_SESSION_KEY_STRATEGY` | no | `issue` (default), `run`, or `fixed` — Bopo derives a session key for OpenClaw where applicable. |
| `OPENCLAW_AGENT_WAIT_MS` | no | `agent.wait` timeout in milliseconds (defaults to at least the runtime timeout or 15 minutes). |
| `OPENCLAW_DEVICE_PRIVATE_KEY_PEM` | no | Stable Ed25519 private key (PEM); use `\\n` for newlines in env text. Without it, a new ephemeral identity is used each run (pairing may be required). |
| `BOPO_OPENCLAW_DISABLE_DEVICE_AUTH` | no | When `1`/`true`/`yes`, omit device identity on `connect` (only if the gateway is configured to allow that mode; see OpenClaw security docs). |

## Heartbeat and Scheduler Controls

| Variable | Default | Notes |
| --- | --- | --- |
| `BOPO_HEARTBEAT_SWEEP_MS` | `60000` | Scheduler interval for heartbeat sweeps. |
| `BOPO_HEARTBEAT_STALE_RUN_MS` | `600000` | Recovery threshold for stale `started` runs. |
| `BOPO_HEARTBEAT_EXECUTION_TIMEOUT_MS` | computed by service | Execution timeout fallback when runtime config omits explicit timeout. |
| `BOPO_HEARTBEAT_PROMPT_MODE` | `full` | Heartbeat prompt size: `full` (default; inline issue bodies) or `compact` (omit bodies; hydrate via `GET /issues/:id`). |
| `BOPO_HEARTBEAT_PROMPT_MEMORY_MAX_CHARS` | unset (`8000` per section when mode is `compact`) | Max characters per memory block (tacit notes, durable facts, daily notes) before truncation with an explicit marker. |
| `BOPO_HEARTBEAT_IDLE_POLICY` | `full` | When no work items are assigned (non–comment-order runs): `full` = normal adapter prompt; `micro_prompt` = minimal prompt; `skip_adapter` = do not invoke the LLM adapter. |
| `BOPO_ENABLE_GIT_WORKTREE_ISOLATION` | `0` | Enables `isolated + git_worktree` runtime resolution in heartbeat service. |
| `BOPO_GIT_WORKTREE_TTL_MINUTES` | `240` | TTL for stale isolated worktree cleanup under strategy root dir. |
| `BOPO_SCHEDULER_ROLE` | `auto` | Scheduler ownership: `auto`, `leader`, `follower`, `off`. |
| `BOPO_PLUGIN_SYSTEM_DISABLED` | `0` (plugin system enabled) | Global emergency kill switch for plugin hook execution when `1`/`true`. |
| `BOPO_PLUGIN_SYSTEM_ENABLED` | legacy compatibility | If explicitly set to `0`/`false`, plugin hooks are disabled. |
| `BOPO_PLUGIN_MANIFESTS_DIR` | `<repo>/plugins` | Filesystem directory scanned at API startup for `*/plugin.json` manifests. |
| `BOPO_PLUGIN_WEBHOOK_ALLOWLIST` | unset (allow all) | Optional comma-separated webhook host allowlist for prompt plugin webhook execution. |

## Communication Preflight Controls

| Variable | Default | Notes |
| --- | --- | --- |
| `BOPODEV_COMMUNICATION_PREFLIGHT` | `false` | Enables connectivity checks before runtime invocation. |
| `BOPODEV_COMMUNICATION_PREFLIGHT_TIMEOUT_MS` | `1500` | Timeout for preflight communication probe. |
| `BOPODEV_API_BASE_URL` | fallback to `NEXT_PUBLIC_API_URL` then local default | Control-plane API URL injected into runtime env. |

## Runtime Identity and Actor Injection (`BOPODEV_*`)

Injected per run by heartbeat services:

- `BOPODEV_AGENT_ID`
- `BOPODEV_COMPANY_ID`
- `BOPODEV_RUN_ID`
- `BOPODEV_API_BASE_URL`
- `BOPODEV_ACTOR_TYPE`
- `BOPODEV_ACTOR_ID`
- `BOPODEV_ACTOR_COMPANIES`
- `BOPODEV_ACTOR_PERMISSIONS`
- `BOPODEV_REQUEST_HEADERS_JSON`
- `BOPODEV_REQUEST_APPROVAL_DEFAULT`
- `BOPODEV_CAN_HIRE_AGENTS`
- `BOPODEV_HEARTBEAT_PROMPT_MODE` (echo of `BOPO_HEARTBEAT_PROMPT_MODE` for branching in scripts)
- `BOPODEV_HEARTBEAT_IDLE_POLICY` (echo of `BOPO_HEARTBEAT_IDLE_POLICY`)

These variables are required for control-plane aware skill execution and approval-safe delegation.

## Auth Identity and Actor Token Settings

| Variable | Default | Notes |
| --- | --- | --- |
| `BOPO_AUTH_TOKEN_SECRET` | unset | HMAC secret used to validate signed actor tokens for API + realtime auth. |
| `BOPO_TRUST_ACTOR_HEADERS` | `0` in authenticated modes | Set to `1` only when a trusted proxy injects validated `x-actor-*` headers. |
| `BOPO_AUTH_BOOTSTRAP_SECRET` | unset | Optional secret required by `POST /auth/actor-token` in authenticated modes. |
| `NEXT_PUBLIC_BOPO_ACTOR_TOKEN` | unset | Optional browser-side actor token for API and websocket authentication. |

## Provider Credential Variables

| Variable | Notes |
| --- | --- |
| `BOPO_OPENAI_API_KEY` / `OPENAI_API_KEY` | OpenAI-compatible runtime credentials. |
| `BOPO_ANTHROPIC_API_KEY` / `ANTHROPIC_API_KEY` | Anthropic-compatible runtime credentials. |
| `OPENCODE_MODEL` | Optional fallback default model for onboarding seed when provider is `opencode` (`provider/model` format). |
| `BOPO_OPENAI_BASE_URL` | Optional OpenAI API base URL override for direct API adapters. |
| `BOPO_ANTHROPIC_BASE_URL` | Optional Anthropic API base URL override for direct API adapters. |
| `BOPO_OPENAI_INPUT_USD_PER_1M` / `BOPO_OPENAI_OUTPUT_USD_PER_1M` | Optional direct-adapter cost fallback rates when provider response omits cost fields. |
| `BOPO_ANTHROPIC_INPUT_USD_PER_1M` / `BOPO_ANTHROPIC_OUTPUT_USD_PER_1M` | Optional direct-adapter cost fallback rates when provider response omits cost fields. |

## Project Workspace Git Policy

- `projects.executionWorkspacePolicy.credentials.mode`
  - `host` (default): rely on host git credentials (`ssh-agent`, `gh auth`, or credential helper).
  - `env_token`: resolve token from `credentials.tokenEnvVar` in runtime env/process env.
- `projects.executionWorkspacePolicy.allowRemotes`: optional remote allowlist guard.
- `projects.executionWorkspacePolicy.allowBranchPrefixes`: optional guard for isolated worktree branch naming.
- `projects.executionWorkspacePolicy.strategy.type=git_worktree`: enables isolated worktree strategy when global flag allows it.

## Attachments Limits

| Variable | Default | Notes |
| --- | --- | --- |
| `BOPO_ISSUE_ATTACHMENTS_MAX_FILES` | `10` | Maximum files per upload request. |
| `BOPO_ISSUE_ATTACHMENTS_MAX_BYTES` | `20971520` | Per-file byte limit (20 MB). |
| `BOPO_ISSUE_ATTACHMENTS_ALLOWED_MIME_TYPES` | built-in allow list | Optional MIME override list. |
| `BOPO_ISSUE_ATTACHMENTS_ALLOWED_EXTENSIONS` | built-in allow list | Optional extension override list. |

## Local Development Helpers

| Variable | Default | Notes |
| --- | --- | --- |
| `BOPO_OPEN_BROWSER` | `1` | Start runner browser open behavior; set `0` to disable. |
| `BOPO_OPEN_BROWSER_MAX_WAIT_MS` | `45000` | Max time `start-runner` waits for web readiness before skipping browser auto-open. |
| `BOPO_OPEN_BROWSER_RETRY_MS` | `500` | Poll interval used by `start-runner` while waiting for web readiness. |
| `BOPO_ALLOW_LOCAL_BOARD_FALLBACK` | enabled outside production | Controls request actor fallback behavior for local dev flows. |
| `BOPO_BACKFILL_DRY_RUN` | `1` in check scripts | Used by project workspace path backfill tooling. |

## Related Pages

- Getting started: [`../getting-started-and-dev.md`](../getting-started-and-dev.md)
- Deployment guidance: [`../operations/deployment.md`](../operations/deployment.md)
