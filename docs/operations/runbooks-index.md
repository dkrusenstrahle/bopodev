# Runbooks Index

This page is the entry point for incident and debugging runbooks.

## Purpose

Provide fast routing from symptom to runbook.

## Intended Audience

- On-call contributors and operators responding to failures.

## By Incident Type

- **Codex runtime failures**
  - [`../codex-connection-debugging.md`](../codex-connection-debugging.md)
- **General API, scheduler, or realtime failures**
  - [`troubleshooting.md`](./troubleshooting.md)
- **Plugin workflow failures**
  - [`plugin-runbook.md`](./plugin-runbook.md)
- **Release blockers**
  - [`../release-gate-checklist.md`](../release-gate-checklist.md)

## By Functional Area

- **Agents and heartbeats**
  - [`../product/agents-and-runs.md`](../product/agents-and-runs.md)
  - [`../developer/api-reference.md`](../developer/api-reference.md)
- **Plugins and integrations**
  - [`plugin-runbook.md`](./plugin-runbook.md)
  - [`../product/plugins-and-integrations.md`](../product/plugins-and-integrations.md)
  - [`../developer/plugin-system.md`](../developer/plugin-system.md)
- **Governance and inbox**
  - [`../product/governance-and-approvals.md`](../product/governance-and-approvals.md)
- **Realtime office-space and notifications**
  - [`../product/office-space-and-realtime.md`](../product/office-space-and-realtime.md)

## Escalation Checklist

1. Capture `x-request-id` and affected run/approval IDs.
2. Check `/health` and current runtime command health.
3. Confirm company scope and actor headers.
4. Review run details and recent audit/log events.
5. Apply targeted runbook and document remediation.
