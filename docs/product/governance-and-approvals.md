# Governance and Approvals

This page explains how Bopo controls high-impact actions with explicit approvals.

## Purpose

Document the governance queue, inbox behavior, and decision outcomes.

## Intended Audience

- Board/member operators responsible for policy decisions.
- Engineers implementing or debugging approval side effects.

## Prerequisites

- Requests are scoped to a company context.
- Actors use control-plane identity headers.

## Approval Model

Each approval request includes:

- action type,
- payload,
- requester,
- status (`pending`, `approved`, `rejected`, `overridden`),
- timestamps for creation and resolution.

Current action types:

- `hire_agent`
- `activate_goal`
- `override_budget`
- `pause_agent`
- `terminate_agent`
- `promote_memory_fact`
- `grant_plugin_capabilities`
- `apply_template`

Plugin capability governance (v2 rollout):

- Capability namespaces are evaluated at grant time (for example `issues.write`, `tools.register`, `network.http`).
- Risk bands:
  - `safe`: can be granted directly
  - `elevated`: can require approval based on company policy
  - `restricted`: always requires explicit approval in governed mode
- Suggested trust tiers for package plugins:
  - `dev_local`: local-only development installs, permissive defaults
  - `verified`: reviewed package source/integrity, balanced defaults
  - `restricted`: unverified sources, deny-by-default on elevated/restricted capabilities

Delegated hiring traceability:

- Delegated hiring requests can include typed intent and source issue linkage.
- Hire approvals preserve requester/source metadata so operators can trace issue -> approval -> hired agent.
- Approval comments can be persisted as part of resolution context, so operators should provide concise rationale on high-impact decisions.

## Governance Surfaces

- **Governance queue**: full list and action detail context.
- **Inbox**: actor-centric queue with `seen`/`dismissed` controls.
- **Realtime notifications**: approval created/resolved updates.

## Resolve Outcomes

- **Approve**: applies queued side effect and marks resolved.
- **Reject**: resolves without applying requested effect.
- **Override**: resolves with explicit manual override semantics.

Always verify post-resolution state in related views:

- agent roster and status,
- goal activation state,
- run behavior for budget-related requests,
- audit trail in observability.

Budget override behavior:

- When an agent hard-stops on budget, the system can queue a pending `override_budget` approval for governance review.
- When a project hard-stops on budget, the system queues one pending `override_budget` approval per project while pending.
- Approved budget overrides update the target agent or project monthly budget.
- Project budget hard-stop also blocks new work starts for that project until approval is resolved.

Project budget governance flow:

- Run request gathers target projects.
- If any project is exhausted, run is skipped before claim/execution.
- System emits `project_budget.hard_stop` and `project_budget.override_requested` audit events.
- Governance approval applies the new project monthly budget and emits `project_budget.override_applied`.

## Operating Recommendations

- Resolve stale pending approvals daily.
- Use `dismiss` only for intentional triage, not permanent hiding.
- Keep governance actions auditable with consistent operator comments.

## Related Pages

- Product overview: [`overview.md`](./overview.md)
- Daily workflows: [`daily-workflows.md`](./daily-workflows.md)
- API details: [`../developer/api-reference.md`](../developer/api-reference.md)
- Agent memory workflow: [`agent-memory-workflow.md`](./agent-memory-workflow.md)
- Domain terms: [`../developer/domain-model.md`](../developer/domain-model.md)
