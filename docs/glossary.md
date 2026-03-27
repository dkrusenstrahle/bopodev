# Bopo Glossary

This glossary defines canonical terms used across product, API, and operations docs.

## Core Planning Terms

- **Company**: top-level tenant and governance boundary.
- **Project**: scoped initiative inside a company, with one or more attached project workspaces.
- **Project workspace**: named workspace context containing `cwd`, optional `repoUrl`/`repoRef`, and primary designation.
- **Execution workspace policy**: project-level policy for workspace resolution mode (`project_primary`, `isolated`, or `agent_default`) plus git strategy/credential controls.
- **Repo bootstrap**: heartbeat-time preparation step that clones/fetches/checks out workspace repositories before agent execution.
- **Git credential broker**: runtime resolver that selects host credentials by default, or token-based auth from configured env var policy.
- **Isolated worktree**: per-run/per-agent git worktree path derived from policy strategy and used as runtime cwd when enabled.
- **Issue**: execution unit within a project; may have comments, attachments, an assignee, optional linked **goals** (zero or more) for planning alignment, and optional linkage to **work loops** (e.g. opened by a loop run; see **Loops** tab on the issue).
- **Goal**: desired outcome at `company`, `project`, or `agent` level; may form a hierarchy via parent goals. **Agent-level** goals may be scoped to a single agent (`ownerAgentId`) or shared across agents.

## Agent and Execution Terms

- **Agent**: an AI worker with role, provider, budget, schedule, and runtime configuration.
- **Provider type**: adapter/runtime family (`claude_code`, `codex`, `cursor`, `opencode`, `http`, `shell`).
- **Heartbeat run**: one execution attempt for an agent or sweep, ending as `completed`, `failed`, or `skipped`.
- **Sweep**: scheduler/manual action that evaluates multiple agents and runs eligible ones.
- **Loop**: named, scheduled definition that creates an issue for an assignee agent and enqueues a heartbeat focused on that issue; complements the agent’s general **heartbeat** cadence (`heartbeatCron`). UI: **Loops** (`/loops`, `/loops/:id`). See [`product/loops.md`](./product/loops.md).
- **Agent documents** (UI: **Documents**): in-app editor at `/agents/:agentId/docs` for **operating** markdown files (e.g. repo guidance such as `AGENTS.md`) and **memory** `.md` notes for that agent; saving requires `agents:write`. See [`product/agents-and-runs.md`](./product/agents-and-runs.md).
- **Tacit memory**: stable guidance stored in `MEMORY.md` and loaded into future runs.
- **Episodic note**: chronological run note written to `memory/YYYY-MM-DD.md`.
- **Durable fact**: promoted reusable memory entry stored in `life/items.yaml`.
- **Memory promotion**: conversion of candidate run insight into a durable fact for reuse.

## Governance Terms

- **Approval request**: queued high-impact action requiring explicit decision.
- **Governance inbox**: actor-centric queue showing pending and recently resolved approvals.
- **Resolve action**: approval decision (`approved`, `rejected`, `overridden`) applied to a request.

## Owner Chat Terms

- **Owner assistant (Chat)**: company-scoped conversational UI (`ask`) backed by `GET/POST /assistant/*`. Replies use a bounded company snapshot (CLI brains) or, when wired, direct API tool rounds. See [`product/owner-assistant.md`](./product/owner-assistant.md).

## Observability Terms

- **Audit event**: immutable log of important control-plane actions.
- **Trace log**: detailed run diagnostics and execution metadata.
- **Cost ledger entry**: normalized token/cost accounting record for runtime execution (heartbeats via `run_id`; owner-assistant chat via `cost_category` = `company_assistant` plus optional `assistant_thread_id` / `assistant_message_id`).

## Realtime Terms

- **Realtime channel**: websocket stream namespace (for example governance and office-space).
- **Office room**: logical state bucket (`waiting_room`, `work_space`, `security`) for occupancy views.
- **Snapshot event**: initial channel state sent on connect before incremental updates.
