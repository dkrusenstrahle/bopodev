# Domain Model

This page defines the main entities and lifecycle relationships in Bopo.

## Purpose

Create one canonical reference for schema-level terminology and behavior.

## Intended Audience

- API and data model contributors.
- Operators needing precise semantics for lifecycle transitions.

## Planning Graph

- **Company**
  - top-level tenant and policy scope.
- **Project**
  - belongs to company; groups issues and optional local workspace metadata.
- **Issue**
  - belongs to project and company; can reference `parentIssueId` for hierarchy.
  - status: `todo`, `in_progress`, `blocked`, `in_review`, `done`, `canceled`.
- **Goal**
  - belongs to company; optional project parentage.
  - level: `company`, `project`, `agent`.
  - status: `draft`, `active`, `completed`, `archived`.

## Execution Graph

- **Agent**
  - role + provider + runtime config + budget + cadence.
  - status: `idle`, `running`, `paused`, `terminated`.
  - leadership behavior is capability-driven (`canHireAgents`) with policy-based delegate resolution.
- **Provider type**
  - `claude_code`, `codex`, `cursor`, `opencode`, `http`, `shell`.
- **Heartbeat run**
  - single execution record tied to agent and trigger.
  - run status includes `started`, `completed`, `failed`, `skipped`.
- **Execution outcome**
  - structured result envelope (`kind`, `actions`, `artifacts`, `blockers`, `nextSuggestedState`).

## Governance Graph

- **Approval request**
  - action + payload + requester + status lifecycle.
  - action types: `hire_agent`, `activate_goal`, `override_budget`, `pause_agent`, `terminate_agent`, `promote_memory_fact`, `grant_plugin_capabilities`, `apply_template`.
  - statuses: `pending`, `approved`, `rejected`, `overridden`.
  - hire payloads may include delegated hiring lineage (`sourceIssueIds`, `delegationIntent`).
- **Governance inbox item**
  - approval plus actor-scoped `seenAt` and `dismissedAt`.

## Observability Graph

- **Audit event**: immutable system action log.
- **Trace log**: run-level diagnostics.
- **Cost ledger entry**: usage and USD accounting for execution.

## Realtime Graph

- **Governance events**: snapshot/create/resolve notifications.
- **Office space occupancy**
  - rooms: `waiting_room`, `work_space`, `security`.
  - occupant kind: `agent`, `hire_candidate`.
  - occupant status: `idle`, `working`, `waiting_for_approval`, `paused`.

## Control-Plane Runtime Identity

Runtime integrations rely on injected `BOPODEV_*` context:

- execution identity (`AGENT_ID`, `COMPANY_ID`, `RUN_ID`, `API_BASE_URL`)
- actor identity (`ACTOR_*`) or fallback `REQUEST_HEADERS_JSON`.

This contract enforces company scope and actor permission propagation in delegated runs.

## Source of Truth

Primary schema references:

- `packages/contracts/src/index.ts`
- `packages/db/src/schema.ts`

## Related Pages

- Glossary: [`../glossary.md`](../glossary.md)
- API contracts: [`api-reference.md`](./api-reference.md)

