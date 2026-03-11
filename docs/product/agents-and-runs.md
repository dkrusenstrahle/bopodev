# Agents and Runs

This page covers agent lifecycle management and heartbeat execution behavior.

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

- create an agent (`role`, `name`, provider type),
- configure heartbeat cadence and budget,
- configure runtime command/args/model/cwd/env,
- set run policy (`workspace_write` or `full_access`, optional web search),
- pause, resume, or terminate agents.

## Provider Types

Built-in adapters:

- `claude_code`
- `codex`
- `cursor`
- `opencode`
- `http`
- `shell`

For adapter internals, see [`../adapters/overview.md`](../adapters/overview.md).

## Heartbeat Runs

Run paths:

- **Run agent**: targeted execution for a specific assignee/context.
- **Sweep**: scheduler or manual run across eligible idle agents.
- **Run controls**: stop, resume, and redo supported for run lifecycle management.

Run status values include `started`, `completed`, `failed`, and `skipped`.

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
