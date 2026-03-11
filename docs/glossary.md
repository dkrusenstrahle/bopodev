# Bopo Glossary

This glossary defines canonical terms used across product, API, and operations docs.

## Core Planning Terms

- **Company**: top-level tenant and governance boundary.
- **Project**: scoped initiative inside a company, with optional local workspace hints.
- **Issue**: execution unit within a project; may have comments, attachments, and an assignee.
- **Goal**: desired outcome at `company`, `project`, or `agent` level.

## Agent and Execution Terms

- **Agent**: an AI worker with role, provider, budget, schedule, and runtime configuration.
- **Provider type**: adapter/runtime family (`claude_code`, `codex`, `cursor`, `opencode`, `http`, `shell`).
- **Heartbeat run**: one execution attempt for an agent or sweep, ending as `completed`, `failed`, or `skipped`.
- **Sweep**: scheduler/manual action that evaluates multiple agents and runs eligible ones.
- **Tacit memory**: stable guidance stored in `MEMORY.md` and loaded into future runs.
- **Episodic note**: chronological run note written to `memory/YYYY-MM-DD.md`.
- **Durable fact**: promoted reusable memory entry stored in `life/items.yaml`.
- **Memory promotion**: conversion of candidate run insight into a durable fact for reuse.

## Governance Terms

- **Approval request**: queued high-impact action requiring explicit decision.
- **Governance inbox**: actor-centric queue showing pending and recently resolved approvals.
- **Resolve action**: approval decision (`approved`, `rejected`, `overridden`) applied to a request.

## Observability Terms

- **Audit event**: immutable log of important control-plane actions.
- **Trace log**: detailed run diagnostics and execution metadata.
- **Cost ledger entry**: normalized token/cost accounting record for runtime execution.

## Realtime Terms

- **Realtime channel**: websocket stream namespace (for example governance and office-space).
- **Office room**: logical state bucket (`waiting_room`, `work_space`, `security`) for occupancy views.
- **Snapshot event**: initial channel state sent on connect before incremental updates.
