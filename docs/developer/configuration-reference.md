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
| `NEXT_PUBLIC_DEFAULT_COMPANY_ID` | Web | `demo-company` fallback in code | Preferred company for initial client load. |
| `BOPO_DEFAULT_COMPANY_ID` | API/CLI | unset | Default company for scheduler or startup behavior. |
| `BOPO_DEFAULT_COMPANY_NAME` | CLI seed | unset | Written during onboarding seed. |
| `BOPO_DEFAULT_AGENT_PROVIDER` | CLI seed | unset | Initial provider for bootstrapped CEO agent. |

## Persistence and Instance Paths

| Variable | Default | Notes |
| --- | --- | --- |
| `BOPO_DB_PATH` | `~/.bopodev/instances/default/db/bopodev.db` | Explicit DB file override. |
| `BOPO_HOME` | `~/.bopodev` | Root home for instance defaults. |
| `BOPO_INSTANCE_ID` | `default` | Instance namespace in local paths. |
| `BOPO_INSTANCE_ROOT` | derived from `BOPO_HOME` + `BOPO_INSTANCE_ID` | Root for auto-created workspaces/storage. |

## Runtime Command and Adapter Settings

| Variable | Default | Notes |
| --- | --- | --- |
| `NEXT_PUBLIC_DEFAULT_RUNTIME_CWD` | empty | UI fallback working directory for new agents. |
| `BOPO_CODEX_COMMAND` | `codex` | Codex command override. |
| `BOPO_OPENCODE_COMMAND` | `opencode` | OpenCode command override. |
| `BOPO_SKIP_CODEX_PREFLIGHT` | `0` | Skip startup codex command health checks when `1`. |
| `BOPO_SKIP_OPENCODE_PREFLIGHT` | `0` | Skip startup OpenCode command health checks when `1`. |
| `BOPO_REQUIRE_CODEX_HEALTH` | `0` unless codex agents exist | Force codex health checks at startup when `1`. |
| `BOPO_REQUIRE_OPENCODE_HEALTH` | `0` unless opencode agents exist | Force OpenCode health checks at startup when `1`. |
| `BOPO_VERBOSE_STARTUP_WARNINGS` | `0` | Adds detailed startup warning payloads when `1`. |
| `BOPO_CODEX_HOME_ROOT` | unset | Managed Codex home root override in runtime behavior. |
| `BOPO_CODEX_ALLOW_HOME_SEED` | `false` | Controls managed Codex home initialization behavior. |
| `BOPO_OPENCODE_MODEL` | unset | Optional OpenCode model for onboarding seed. If unset, onboarding attempts to auto-select from `opencode models`. |

## Heartbeat and Scheduler Controls

| Variable | Default | Notes |
| --- | --- | --- |
| `BOPO_HEARTBEAT_SWEEP_MS` | `60000` | Scheduler interval for heartbeat sweeps. |
| `BOPO_HEARTBEAT_STALE_RUN_MS` | `600000` | Recovery threshold for stale `started` runs. |
| `BOPO_HEARTBEAT_EXECUTION_TIMEOUT_MS` | computed by service | Execution timeout fallback when runtime config omits explicit timeout. |
| `BOPO_PLUGIN_SYSTEM_DISABLED` | `0` (plugin system enabled) | Global emergency kill switch for plugin hook execution when `1`/`true`. |
| `BOPO_PLUGIN_SYSTEM_ENABLED` | legacy compatibility | If explicitly set to `0`/`false`, plugin hooks are disabled. |

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

These variables are required for control-plane aware skill execution and approval-safe delegation.

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
| `BOPO_ALLOW_LOCAL_BOARD_FALLBACK` | enabled outside production | Controls request actor fallback behavior for local dev flows. |
| `BOPO_BACKFILL_DRY_RUN` | `1` in check scripts | Used by project workspace path backfill tooling. |

## Related Pages

- Getting started: [`../getting-started-and-dev.md`](../getting-started-and-dev.md)
- Deployment guidance: [`../operations/deployment.md`](../operations/deployment.md)
