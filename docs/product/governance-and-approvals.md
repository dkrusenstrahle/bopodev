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

Delegated hiring traceability:

- Delegated hiring requests can include typed intent and source issue linkage.
- Hire approvals preserve requester/source metadata so operators can trace issue -> approval -> hired agent.

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
