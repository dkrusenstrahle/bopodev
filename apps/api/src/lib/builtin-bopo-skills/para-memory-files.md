---
name: para-memory-files
description: >
  File-backed memory using PARA (Projects, Areas, Resources, Archives). Use for
  persistent recall across sessions: durable facts, daily notes, and user habits.
---

# PARA Memory Files

Use this skill whenever context must survive beyond the current runtime session.

## Memory layers

1. Knowledge graph (`life/`)
   - entity folders with `summary.md` and `items.yaml`
   - durable, queryable facts
2. Daily notes (`memory/YYYY-MM-DD.md`)
   - chronological event log
   - temporary observations before curation
3. Tacit memory (`MEMORY.md`)
   - user preferences, work style, collaboration patterns

## PARA organization

- `projects/`: active efforts with goals/deadlines
- `areas/`: ongoing responsibilities
- `resources/`: reusable reference knowledge
- `archives/`: inactive entities moved from other buckets

## Operating rules

- Write durable facts immediately to `items.yaml`.
- Keep `summary.md` short and regenerate from active facts.
- Never delete facts; supersede with status and replacement reference.
- Move inactive entities to `archives` rather than removing them.
- Prefer writing to disk over relying on transient model context.

## Recall workflow

1. Capture raw event in daily note.
2. Promote durable facts into entity files.
3. Update entity summary from durable facts.
4. Update tacit memory when user operating patterns become clear.

## Planning notes

- Store shared plans in project `plans/` where collaborators can access them.
- Mark superseded plans to prevent stale guidance drift.
