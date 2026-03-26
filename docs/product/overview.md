# Product Overview

Bopo is a local-first control plane for operating AI teams as a structured company.

## Purpose

Provide one place to define goals, organize work, run agents, manage approvals, and observe outcomes.

## Intended Audience

- Operators running day-to-day execution.
- Managers coordinating projects and approvals.
- Engineers supervising runtime quality and cost.

## Core Product Areas

- **Planning**: companies, projects, issues (each can link to multiple goals), and goals.
- **Execution**: agent lifecycle, runtime configuration, and heartbeat runs.
- **Governance**: explicit approvals for sensitive actions.
- **Observability**: run diagnostics, logs, and cost signals.
- **Templates and plugins**: reusable operating patterns and extensibility.
- **Realtime coordination**: governance, office-space, heartbeat-runs, and attention state streamed to clients.

## Long text fields (Markdown)

Several rich description fields use an **MDXEditor**-based markdown surface in forms (formatted preview as you type, same as issue document attachments), and the app renders stored Markdown with GitHub-flavored Markdown where applicable on detail pages: **project description**, **issue description**, **issue comments** (composer on the issue detail page), **work loop instructions** (also copied into new issues the loop creates), **agent bootstrap prompt**, and **goal details**. Plain text still works; structure with headings, lists, links, and tables when it helps readers.

## UI Section Map

Primary sections in the app:

- `dashboard`
- `projects`
- `issues`
- `goals`
- `agents`
- `org-chart`
- `office-space`
- `inbox`
- `governance`
- `runs`
- `trace-logs`
- `costs`
- `settings`
- `settings/templates`
- `settings/plugins`
- `settings/models`

## High-Level Workflow

1. Create or select a company.
2. Add projects and issues under that company.
3. Define active goals at company/project/agent levels.
4. Hire/configure agents with provider and runtime policy.
5. Run heartbeats manually or via sweeps.
6. Resolve approvals and inspect outcomes in logs/runs/costs.
7. Promote reusable patterns through templates/plugins and monitor attention cues in inbox flows.

## Related Pages

- Daily operating flow: [`daily-workflows.md`](./daily-workflows.md)
- Agent and run details: [`agents-and-runs.md`](./agents-and-runs.md)
- Governance model: [`governance-and-approvals.md`](./governance-and-approvals.md)
- Realtime model: [`office-space-and-realtime.md`](./office-space-and-realtime.md)
- Canonical terms: [`../glossary.md`](../glossary.md)

