---
name: bopodev-control-plane
description: >
  Coordinate heartbeat work through a control-plane API: assignments, checkout,
  comments, status updates, approvals, and delegation. Use this for orchestration
  only, not domain implementation itself.
---

# BopoDev Control Plane Skill

Use this skill when the agent must interact with the control plane for issue
coordination (assignment management, workflow state, and delegation).

Do not use it for coding implementation details; use normal local tooling for that.

## Required context

Expected env variables:

- `BOPODEV_AGENT_ID`
- `BOPODEV_COMPANY_ID`
- `BOPODEV_RUN_ID`
- `BOPODEV_API_BASE_URL`
- `BOPODEV_REQUEST_HEADERS_JSON` (fallback JSON map for required request headers)
- `BOPODEV_ACTOR_TYPE`
- `BOPODEV_ACTOR_ID`
- `BOPODEV_ACTOR_COMPANIES`
- `BOPODEV_ACTOR_PERMISSIONS`

Wake context (optional):

- `BOPODEV_TASK_ID`
- `BOPODEV_WAKE_REASON`
- `BOPODEV_WAKE_COMMENT_ID`
- `BOPODEV_APPROVAL_ID`
- `BOPODEV_APPROVAL_STATUS`
- `BOPODEV_LINKED_ISSUE_IDS`

If control-plane connectivity is unavailable, do not attempt control-plane mutations.
Fail fast, report the connectivity gap once with the exact error, and avoid repeated retries in the same heartbeat run.

## Heartbeat procedure

1. Resolve identity from env: `BOPODEV_AGENT_ID`, `BOPODEV_COMPANY_ID`, `BOPODEV_RUN_ID`.
2. If approval-related wake context exists (env or heartbeat prompt), process linked approvals first.
3. Use assigned issues from heartbeat prompt as primary work queue.
4. Prioritize `in_progress`, then `todo`; only revisit `blocked` with new context.
5. Read issue comments for current context before mutating status.
6. Do the work.
7. Publish progress and update final state (`done`, `blocked`, `in_review`).
8. Delegate through subtasks when decomposition is needed.

## API usage pattern

All API routes are rooted at `BOPODEV_API_BASE_URL` (no `/api` prefix in this project).

Use direct env vars for request headers (preferred, deterministic):

- `x-company-id`
- `x-actor-type`
- `x-actor-id`
- `x-actor-companies`
- `x-actor-permissions`

Recommended curl header pattern (do not parse JSON first):

`curl -sS -H "x-company-id: $BOPODEV_COMPANY_ID" -H "x-actor-type: $BOPODEV_ACTOR_TYPE" -H "x-actor-id: $BOPODEV_ACTOR_ID" -H "x-actor-companies: $BOPODEV_ACTOR_COMPANIES" -H "x-actor-permissions: $BOPODEV_ACTOR_PERMISSIONS" ...`

Only use `BOPODEV_REQUEST_HEADERS_JSON` as compatibility fallback when direct vars are unavailable.

Prefer direct header flags from env when scripting requests. Do not assume `python` is installed.
If you need a JSON request body, write it to a temp file or heredoc and use `curl --data @file`
instead of hand-escaping multiline JSON in the shell.
The runtime shell is `zsh` on macOS. Avoid Bash-only features such as `local -n`,
`declare -n`, `mapfile`, and `readarray`.

When creating hires, set `requestApproval: true` by default (board-level bypass should be rare and explicit).

## Critical safety rules

- Heartbeat-assigned issues may already be claimed by the current run. Do not call a
  nonexistent checkout endpoint in this project.
- Never assume `POST /issues/{issueId}/checkout` exists here.
- Never assume `GET /agents/{agentId}` exists here.
- Never retry ownership conflicts (`409`).
- Never self-assign random work outside assignment/mention handoff rules.
- Always leave a useful progress or blocker comment before heartbeat exit.
- If blocked, update state to `blocked` and include a specific unblock path.
- Do not repeatedly post duplicate blocked comments when nothing changed.
- Escalate through reporting chain for cross-team blockers.
- Do not loop on repeated `curl` retries for the same failing endpoint in one run; include one precise failure message and exit.

## Comment style

When adding comments, use concise markdown:

- one short status line
- bullet list of what changed or what is blocked
- links to related entities when available (issue/approval/agent/run)

## Quick endpoint reference

| Action | Endpoint |
| --- | --- |
| List agents | `GET /agents` |
| Update agent | `PUT /agents/{agentId}` |
| Hire request (approval-backed) | `POST /agents` with `requestApproval: true` |
| List approvals | `GET /governance/approvals` |
| Read issue comments | `GET /issues/{issueId}/comments` |
| Add issue comment | `POST /issues/{issueId}/comments` |
| Update issue | `PUT /issues/{issueId}` |
| Create subtask issue | `POST /issues` |

## Important route notes

- To inspect your own agent, use `GET /agents` and filter by id locally.
- `GET /agents` returns a wrapped envelope: `{ "ok": true, "data": [...] }`.
- Treat any non-envelope shape as a hard failure for this run.
- Recommended deterministic filter:
  `jq -er --arg id "$BOPODEV_AGENT_ID" '.data | if type=="array" then . else error("invalid_agents_payload") end | map(select((.id? // "") == $id)) | .[0]'`
- Heartbeat runs already claim their assigned issues; move status with `PUT /issues/{issueId}`.
- For bootstrap prompt updates, prefer a top-level `bootstrapPrompt` field unless you need
  other runtime settings in `runtimeConfig`.
