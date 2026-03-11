# Agent Memory Workflow

This page explains how agent memory is captured, promoted, and reused across heartbeat runs.

## Purpose

Provide operators a practical model for memory behavior so run outcomes are easier to interpret and debug.

## Intended Audience

- Operators managing agent quality over time.
- Engineers validating runtime behavior and memory persistence.

## Memory Layers

Agent memory is file-backed and company-scoped. Each layer has a different role:

- **Tacit memory** (`MEMORY.md`): stable guidance about operating patterns and preferences.
- **Daily episodic notes** (`memory/YYYY-MM-DD.md`): chronological run-by-run capture of outcomes.
- **Durable facts** (`life/items.yaml`, optional `life/summary.md`): promoted facts intended for reuse in future runs.

## Directory Model

Each agent writes under a deterministic company and agent path:

`<instance-root>/workspaces/<companyId>/agents/<agentId>/memory`

Common files and folders:

- `MEMORY.md`
- `memory/YYYY-MM-DD.md`
- `life/items.yaml`
- `life/summary.md` (optional helper summary)

## End-to-End Workflow

### 1) Pre-run context load

Before a heartbeat starts, runtime context is assembled from:

- tacit notes (`MEMORY.md`),
- durable facts (`life/summary.md` and `life/items.yaml`),
- recent daily notes (`memory/*.md`).

This compact context is injected into the run so the agent can act with continuity.

### 2) Post-run episodic capture

After the run, the system appends a daily entry to `memory/YYYY-MM-DD.md` with relevant execution context (for example status, summary, and run identifiers).

### 3) Candidate fact promotion

When a run completes successfully, candidate facts can be promoted into `life/items.yaml`. This supports low-friction learning between runs.

### 4) Governance-driven promotion

Approvals can also promote facts by resolving an approval that carries the `promote_memory_fact` action. Approved actions append the target fact into durable memory.

## Observability and Debugging

Use observability memory routes to inspect generated files without shell access:

- `GET /observability/memory`
- `GET /observability/memory/:agentId/file?path=...`

Recommended debugging flow:

1. Inspect recent heartbeat status and summary.
2. Open the latest `memory/YYYY-MM-DD.md` entry for episodic capture.
3. Check `life/items.yaml` for newly promoted durable facts.
4. Verify tacit memory in `MEMORY.md` when behavior appears consistently misaligned.

## Operational Guardrails

- Do not store secrets or sensitive personal data in memory files.
- Keep durable facts concise, stable, and reusable across tasks.
- Prefer superseding stale facts over deleting historical context.
- Keep promotions intentional; avoid noisy or duplicate fact entries.

## Related Pages

- Agents and runs: [`agents-and-runs.md`](./agents-and-runs.md)
- Governance and approvals: [`governance-and-approvals.md`](./governance-and-approvals.md)
- API reference: [`../developer/api-reference.md`](../developer/api-reference.md)
- Glossary: [`../glossary.md`](../glossary.md)
