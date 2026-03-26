# Agents and Runs

This page covers agent lifecycle management and heartbeat execution behavior.

For **heartbeat prompt modes** (`full` vs `compact`), **cost expectations**, and **API hydration** (`GET /issues/:id`), see [`../guides/agent-heartbeat-protocol.md`](../guides/agent-heartbeat-protocol.md).

For **scheduled recurring work** that opens dedicated issues (separate from the agent’s periodic heartbeat cadence), see [`loops.md`](./loops.md).

### Web UI: “Thinking effort” and Codex

- **Claude Code** agents show a **Thinking effort** control; Bopo forwards it to the CLI as `--effort` when not `auto`.
- **OpenAI Codex** agents **do not** show that control by default: many `codex` builds reject `--reasoning-effort`, so Bopo only passes it when the API sets **`BOPO_CODEX_PASS_REASONING_EFFORT=1`** (see [configuration reference](../developer/configuration-reference.md)). Stored values are normalized to `auto` when switching a Codex agent in the UI so the database matches runtime behavior.

## Purpose

Explain how to configure agents safely and interpret run outcomes.

## Intended Audience

- Operators hiring and managing agents.
- Engineers investigating runtime behavior.

## Prerequisites

- Company and project/issue graph created.
- Runtime provider CLI/API dependencies installed where needed.

## Agent Lifecycle

From `agents` and related modals, you can:

- open an agent **detail** page to see metrics, bootstrap prompt, **issues** (done / in-review), **work loops** that assign this agent, and **heartbeat runs**,
- browse the agent directory in **table** or **cards** layout (toolbar toggle next to column view options),
- create an agent (`role`, `name`, provider type),
- configure heartbeat cadence and budget,
- configure runtime command/args/model/cwd/env,
- set run policy (`workspace_write` or `full_access`, optional web search),
- pause, resume, or terminate agents.

Budget scope:

- Agent budgets are enforced (`monthlyBudgetUsd` vs `usedBudgetUsd`).
- Project budgets are also enforced monthly (`projects.monthlyBudgetUsd`, `projects.usedBudgetUsd`, `projects.budgetWindowStartAt`).
- Issue entities do not enforce independent budget caps.
- If any targeted project is exhausted, the run is hard-stopped before work starts.
- Hard-stopped project runs auto-request `override_budget` governance approval and remain blocked until approved.

Leadership delegation:

- Agent hiring delegation resolves through policy (hiring-capable leadership) rather than only a `CEO` name/role string match.
- Delegated “create agent” requests can carry typed intent metadata for downstream governance and audit linkage.

## Provider Types

Built-in adapters:

- `claude_code`
- `codex`
- `cursor`
- `opencode`
- `gemini_cli`
- `openai_api`
- `anthropic_api`
- `openclaw_gateway`
- `http`
- `shell`

For adapter internals, see [`../adapters/overview.md`](../adapters/overview.md). For the OpenClaw WebSocket gateway adapter, see [`../adapters/openclaw-gateway.md`](../adapters/openclaw-gateway.md).

## Heartbeat Runs

Run paths:

- **Run agent**: targeted execution for a specific assignee/context.
- **Sweep**: scheduler or manual run across eligible idle agents.
- **Run controls**: stop, resume, and redo supported for run lifecycle management.

Run status values include `started`, `completed`, `failed`, and `skipped`.

Budget-blocked run behavior:

- Project budget checks happen before issue claiming and execution.
- Manual run endpoints return a blocked response when pending project budget approvals exist for the agent's assigned work.
- Queue workers treat project budget hard-stops as terminal blocked outcomes to avoid retry/dead-letter churn loops.

Runtime permission model:

- Heartbeats always run with issue-write capability.
- Agent-write capability is injected only when the running agent can hire agents.

## File Memory

Agents use file-backed memory that is loaded before each heartbeat and updated after execution.

This includes tacit notes, daily episodic notes, and promoted durable facts.

For the full lifecycle, file layout, and observability flow, see
[`agent-memory-workflow.md`](./agent-memory-workflow.md).

## Interpreting Results

Check `runs` and `trace-logs` for:

- request and run IDs,
- trigger type (manual, scheduled, sweep),
- failure type and stderr preview,
- usage/cost summaries,
- execution outcome actions and blockers.

Expected behavior:

- every run exits with a terminal status,
- claimed issues are released even on failure paths,
- diagnostics are available without re-running blindly.

Troubleshooting budget-blocked runs:

- Check pending approvals for action `override_budget` with `projectId`.
- Confirm project budget values (`monthlyBudgetUsd`, `usedBudgetUsd`, `budgetWindowStartAt`) on the project record.
- Approve the override to unblock future runs, then re-trigger manual run or wait for sweep.

## Operational Guardrails

- Keep runtime working directories project-scoped when possible.
- Treat `full_access` sandbox mode as privileged.
- Use preflight checks before high-frequency run schedules.
- Set realistic timeout and interrupt grace values.

## Related Pages

- Daily operations: [`daily-workflows.md`](./daily-workflows.md)
- Governance: [`governance-and-approvals.md`](./governance-and-approvals.md)
- Troubleshooting: [`../operations/troubleshooting.md`](../operations/troubleshooting.md)
- Codex runbook: [`../codex-connection-debugging.md`](../codex-connection-debugging.md)
