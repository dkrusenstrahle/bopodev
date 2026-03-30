# Bopo

![Bopo - run your AI company from one control plane](./assets/readme-header.png)

**Run your AI company without the chaos.** [Bopo](https://bopo.dev/) is **open source and self-hosted**. It helps developer-led teams run agent work like a real company: **clear goals, assigned roles, budgets, approvals, and full task history**—so you are not babysitting agents across tabs, scripts, and lost context.

If a coding agent is an employee, Bopo is the company around that employee.

---

### Set the goal, then define the team

Start with what you are trying to achieve, then assign clear roles so everyone knows their job: **one mission, clear tasks**, an **org chart with reporting lines**, and **clear ownership**.

### Heartbeats keep work moving

Agents wake up on a schedule, pick up assignments, and continue where they left off: **scheduled execution**, **automatic delegation**, and **persistent context** so restarts do not erase the thread.

### You stay in control

**Approval gates**, **board-level overrides**, and **safe rollbacks** when you need them—plus **budget limits**, **alerts**, and **auto-pause** so spend does not spike quietly in the background.

---

**Bopo is not a replacement for your coding agent.** It is the layer that coordinates Claude Code, Codex, Cursor, OpenCode, and the rest. Connect the tools you already use; Bopo carries **mission, project goals, and role context** into every ticket so agents know *what* to do and *why*.

## Who Bopo is for

- Builders who juggle **multiple agents and repos** and want work to stay structured.
- Teams that care about **ownership, approvals, and an audit trail** of what ran and what it cost.
- Operators who want **disciplined heartbeats**: right folder, clear task context, optional compact prompts for heavy issues (see [agent heartbeat protocol](docs/guides/agent-heartbeat-protocol.md)).

## Supported agents and runtimes

Bopo connects to the tools you already use. Examples include:

| Runtime | Notes |
| --- | --- |
| Claude Code | |
| Codex | |
| Cursor | Agent CLI with session-oriented execution |
| OpenCode | |
| Gemini CLI | |
| OpenAI API / Anthropic API | Direct API agents |
| HTTP | Generic HTTP heartbeat targets |
| Shell | Scripts and bootstrap flows |

Supported

| CLI | Brand |
| --- | --- |
| Claude Code | <img src="./assets/icon_claude.svg" alt="Claude Code icon" width="28" /> |
| Codex | <img src="./assets/icon_codex.svg" alt="Codex icon" width="28" /> |
| OpenCode | <img src="./assets/icon_opencode.png" alt="OpenCode icon" width="28" /> |
| Gemini | <img src="./assets/icon_gemini.png" alt="Gemini icon" width="28" /> |
| OpenClaw Gateway | <img src="./assets/icon_openclaw.png" alt="OpenClaw Gateway icon" width="28" /> |
| Bash | <img src="./assets/icon_bash.svg" alt="Bash icon" width="28" /> |

## How teams use Bopo

1. Turn goals into **projects** and **issues** (optional **PR / external link** on each issue).
2. Hire and configure **agents** with clear roles, budgets, and runtime; open **Documents** on an agent to edit operating and memory markdown in the UI.
3. Use **work loops** for calendar-style recurring jobs that open issues and wake the assignee’s heartbeat ([work loops](docs/product/loops.md))—separate from each agent’s general heartbeat schedule.
4. **Review approvals**, run **heartbeats**, and watch **runs, traces, and costs** in one place.
5. Use **`bopodev issue shell-env`** to jump from an issue to the right folder and `BOPODEV_*` env in your terminal ([DEVELOPING.md](./DEVELOPING.md)).
6. **Export** a redacted company snapshot via the API for backup or templates (`GET /companies/:id/export` — see [DEVELOPING.md](./DEVELOPING.md)).

## What you get

| Capability | What it does |
| --- | --- |
| Company onboarding | Seeded CEO, starter project, and first issue. |
| Agent lifecycle | Create, configure, pause, resume, terminate. |
| Agent documents | In-app editor for operating markdown and memory `.md` per agent (`/agents/:id/docs`). |
| Work loops | Scheduled recurring work that creates issues and wakes the assignee; list and detail under **Loops**. |
| Projects and issues | Assign work, comments, attachments; optional external (e.g. PR) link. |
| Heartbeats | Manual or sweep runs with stop/resume; compact prompt mode for large issues. |
| Governance | Approvals for high-impact actions. |
| Observability | Runs, trace logs, cost signals. |
| Realtime | Governance, office-space, heartbeat status streams. |
| Plugins | Extend heartbeats with capability-governed plugins. |
| Local-first | Embedded Postgres and instance-local workspaces by default. |
| Multi-company | Separate data, team, and workflow per company when you run more than one venture. |

## What Bopo is not

- **Not a chat wrapper** — structured execution, not ad hoc prompting.
- **Not a single-agent toy** — built for multi-agent accountability.
- **Not a generic workflow builder** — opinionated “company” model for agent ops.
- **Not a replacement for your coding agent** — Bopo coordinates; agents still do the work.

## Quickstart

```bash
npx bopodev onboard
```

Then open `http://localhost:4010`, create a project, assign an issue, and run your first heartbeat.

**Learn more:** [bopo.dev](https://bopo.dev/) · **Star us on GitHub** if Bopo helps your team.

## Contributing / development

- **[DEVELOPING.md](./DEVELOPING.md)** — install, dev servers, tests, DB, CLI, export API.
- **AI / Cursor** — optional root `AGENTS.md` for local contributor context; the name is in `.gitignore` and is not shipped on GitHub.

## Documentation

- Docs home: [`docs/index.md`](./docs/index.md)
- Getting started: [`docs/getting-started-and-dev.md`](./docs/getting-started-and-dev.md)
- Product guides: [`docs/product/index.md`](./docs/product/index.md)
- Developer references: [`docs/developer/index.md`](./docs/developer/index.md)
- Operations runbooks: [`docs/operations/index.md`](./docs/operations/index.md)
- Release docs: [`docs/release/index.md`](./docs/release/index.md)
- Workspace/path canonical model: [`docs/developer/workspace-resolution-reference.md`](./docs/developer/workspace-resolution-reference.md)
- Workspace migration/backfill runbook: [`docs/operations/workspace-migration-and-backfill-runbook.md`](./docs/operations/workspace-migration-and-backfill-runbook.md)
