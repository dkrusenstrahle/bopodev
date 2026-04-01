# Routines (scheduled recurring work)

**Routines** are named, recurring definitions that **create an issue** for an assignee agent and **wake a heartbeat** focused on that issue. They complement the agent’s own **heartbeat schedule** (`heartbeatCron`), which is a general “poll and work the queue” cadence.

## When to use a routine

- You want a **calendar-style** job (“every weekday at 9:00 in `Europe/Stockholm`”) with an auditable **run history**.
- You need **delivery rules** when a previous run is still open: **coalesce**, **skip**, or **always enqueue** another issue.
- You need **catch-up** behavior after downtime: **skip missed** windows vs **enqueue missed** up to a **cap**.

## How it runs

1. A **schedule trigger** (cron + timezone, or a daily/weekly preset) becomes due.
2. The system applies **concurrency** and **catch-up** policies.
3. When it creates work, it opens an issue (tagged `work-loop`, with `routineId` / `routineRunId` on the issue row) and enqueues a **manual** heartbeat job with `wakeContext.issueIds` so the assignee focuses on that issue.

## UI

Web routes: `/routines` (list), `/routines/[routineId]` (detail). Legacy `/loops` URLs redirect to `/routines`. See also `apps/web/README.md` for the full route map.

Under **Routines** in the sidebar: list, create, toggle **Active**, **Run now**, and a detail page with **Triggers**, **Runs**, and **Activity** (audit events for that routine). On a trigger, **Edit** opens a dialog to change schedule, pause, or **Delete** the trigger. The routine detail layout includes a **right-hand summary** with metadata: title, linked **agent** and **project**, **last run** time and outcome, and created/updated timestamps.

On an **issue** detail page, the **Routines** tab lists routines that either use this issue as **parent issue** or **opened this issue** on a run (`routineId` on the issue row), with a shortcut to the full Routines page.

## API and permissions

See [`../developer/api-reference.md`](../developer/api-reference.md) — routes under `/routines` require `routines:read`, `routines:write`, and `routines:run` (manual run) as documented. The API also mounts the same router at `/loops` for backward compatibility.

## Templates

When applying a company template, entries in `manifest.recurrence` with `targetType: "agent"` create a routine plus a cron trigger for the resolved agent, using the first project in the manifest as scope.
