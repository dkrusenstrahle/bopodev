# Daily Workflows

This page describes the default operator loop for running Bopo daily.

## Purpose

Provide an end-to-end operating sequence for projects, issues, and goals.

## Intended Audience

- Team leads and operators managing execution queues.

## Prerequisites

- Bopo instance running locally.
- At least one company exists.
- At least one active agent exists.

## Daily Operating Loop

1. **Optional: ask in Chat**
   - Use **Chat** (`ask`) for quick questions about the selected company—priorities, blockers, spend, agents, approvals—when you want a natural-language answer instead of drilling through lists. Pick the **brain** (CLI adapter) that matches how you run agents locally; start a **New** thread when you want a clean context. See [`owner-assistant.md`](./owner-assistant.md).
2. **Triage issues**
   - Review `issues` view by status and priority.
   - Ensure each issue is linked to the right project and has clear acceptance criteria.
   - Optionally link issues to one or more **planning goals** so heartbeats include a goal chain (root → leaf) per linked goal.
   - On an issue’s **Routines** tab, see routines tied to that issue (parent or opened-by-routine) and jump to the full **Routines** section when needed.
3. **Routines** (when you use recurring automation)
   - In `routines`, confirm triggers are **Active**, review **Runs** and **Activity**, and use **Run now** for a one-off test when appropriate.
   - See [`routines.md`](./routines.md) for how routines differ from an agent’s heartbeat schedule.
4. **Align goals**
   - Check active company/project goals in `goals`.
   - For agent-level goals, set **owner agent** when a goal applies to one worker only.
   - Update goal status to avoid stale planning context.
5. **Prepare execution**
   - Verify issue assignees and dependencies.
   - Confirm agent budget and heartbeat cadence for critical queues.
   - From an agent’s detail page, open **Documents** (header ⋯ menu) to adjust operating markdown or memory `.md` files that shape behavior on the next runs.
6. **Run execution**
   - Trigger targeted heartbeats for urgent issues.
   - Run sweeps for broader progress.
7. **Review outcomes**
   - Inspect `runs` and `trace-logs`.
   - Download/inspect run artifacts from run details when output quality needs verification.
   - Move successful issues to review/done, and unblock failures.
8. **Close governance actions**
   - Resolve pending approvals in `governance`/`inbox`.
   - Confirm side effects were applied (or intentionally blocked).
9. **Clear attention queue**
   - Review `inbox` attention items, acknowledge what is understood, dismiss intentional deferrals, and resolve completed board actions.

## Recommended Project Structure

- Keep one project per coherent initiative.
- Keep issues small enough for one or a few heartbeat runs.
- Use issue comments for operator decisions and handoffs.
- Attach relevant artifacts to issues to avoid context drift.

## Failure Handling

- If runs fail repeatedly, check:
  - agent runtime command/model configuration,
  - working directory and environment variables,
  - governance blocks (pending approval),
  - budget or timeout constraints.
- If artifacts are missing from run detail:
  - verify the run finished and produced artifacts,
  - confirm artifact paths remain inside company workspace roots.
- Escalate using operations docs:
  - [`../operations/troubleshooting.md`](../operations/troubleshooting.md)
  - [`../operations/runbooks-index.md`](../operations/runbooks-index.md)

## Related Pages

- Product overview: [`overview.md`](./overview.md)
- Owner assistant **Chat**: [`owner-assistant.md`](./owner-assistant.md)
- Agents, runs, and **Documents**: [`agents-and-runs.md`](./agents-and-runs.md)
- Routines: [`routines.md`](./routines.md)
- Governance: [`governance-and-approvals.md`](./governance-and-approvals.md)

