# Bopo

![Bopo - run your AI company from one control plane](./assets/readme-header.png)

Bopo is a local-first orchestration platform for running AI teams as a company.

If an coding agent is an employee, Bopo is the operating system for the company around that employee.

Manage goals, projects, issues, agents, approvals, runs, and costs from one place.

## Supported CLIs

| CLI | Icon |
| --- | --- |
| Claude Code | <img src="./assets/icon_claude.svg" alt="Claude Code icon" width="28" /> |
| Codex | <img src="./assets/icon_codex.svg" alt="Codex icon" width="28" /> |
| OpenCode | <img src="./assets/icon_opencode.png" alt="OpenCode icon" width="28" /> |
| Bash | <img src="./assets/icon_bash.svg" alt="Bash icon" width="28" /> |


## Built For This Workflow

1. Define business goals and break them into projects and issues.
2. Hire and configure agents with clear roles and runtime permissions.
3. Approve, run, and monitor execution from a single dashboard.

## Key Features

| Capability | What it does |
| --- | --- |
| Company onboarding | Bootstraps a company with a seeded CEO, starter project, and first issue. |
| Agent lifecycle controls | Lets you create, configure, pause, resume, and terminate agents. |
| Project and issue operations | Manages assignment, comments, activity history, and attachments. |
| Heartbeat execution | Runs agents on demand or in sweeps with stop/resume/redo controls. |
| Governance approvals | Routes high-impact decisions through explicit approval workflows. |
| Operational visibility | Exposes runs, trace logs, and cost signals in one place. |
| Realtime coordination | Streams governance and office-space updates while work executes. |
| Local-first runtime | Runs locally with embedded persistence and workspace-aware execution. |

## Why Teams Choose Bopo

| Without Bopo | With Bopo |
| --- | --- |
| Agent work is scattered across terminals and chats. | Work is centralized by company, project, and issue. |
| Ownership, approvals, and execution state are hard to track. | Agent lifecycle and governance decisions are explicit and auditable. |
| Cost and operational history are difficult to audit. | Runs, trace logs, and cost signals are visible from one control plane. |

## What Bopo Is Not

- **Not a chat wrapper**: it is built for structured execution, not ad hoc conversations.
- **Not a single-agent toy**: it is designed for multi-agent orgs with roles and accountability.
- **Not a generic workflow builder**: it focuses on company orchestration for AI teams.
- **Not a replacement for your coding agent**: it coordinates agents; it does not replace them.

## Documentation

- Docs home: `docs/index.md`
- Getting started: `docs/getting-started-and-dev.md`
- Product guides: `docs/product/index.md`
- Developer references: `docs/developer/index.md`
- Operations runbooks: `docs/operations/index.md`
- Release docs: `docs/release/index.md`

## Quickstart

```bash
npx bopodev onboard
```

Then open the app at `http://localhost:4010`, create a project, assign an issue, and run a heartbeat.
