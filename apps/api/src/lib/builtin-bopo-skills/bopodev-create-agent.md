---
name: bopodev-create-agent
description: >
  Hire agents through governance-aware control-plane flow: inspect adapter
  options, draft configuration, and submit approval-backed hire requests.
---

# BopoDev Create Agent Skill

Use this skill when creating or revising agent hires in the control plane.

## Preconditions

One of the following must be true:

- caller has board access, or
- caller has agent creation permission.

If permission is missing, escalate to a manager/board actor.

## Standard workflow

1. Confirm identity and active company context.
2. Compare existing agent configurations from `GET /agents` for reusable patterns.
3. Choose role, provider, reporting line, and runtime heartbeat profile.
4. Draft agent prompt/instructions with role-scoped responsibilities.
5. Set `capabilities` (required for every hire): a short plain-language line for the org chart and heartbeat team roster—what this agent does for delegation. If the request came from a delegated hiring issue, prefer `delegationIntent.requestedCapabilities` or the issue metadata `delegatedHiringIntent.requestedCapabilities` when present; otherwise write one from the role and brief.
6. Submit hire request and capture approval linkage.
7. Track approval state and post follow-up comments with links.
8. On approval wake, close or update linked issues accordingly.

## Payload checklist

Before submission, ensure payload includes:

- `name`
- `role`
- `providerType`
- `heartbeatCron`
- `monthlyBudgetUsd`
- optional `managerAgentId`
- optional `canHireAgents`
- `capabilities` (short description for org chart and team roster; include on every hire)
- optional `bootstrapPrompt` (extra standing instructions only; operating docs are injected via heartbeat env) or supported `runtimeConfig`
- `requestApproval` (defaults to `true`; keep `true` for routine hires)

Do not use unsupported fields such as:

- `adapterType`
- `adapterConfig`
- `reportsTo`
- arbitrary nested `runtimeConfig` keys outside the supported runtime contract

## Minimal approved shape

For a Codex hire, prefer this shape:

```json
{
  "name": "Founding Engineer",
  "role": "Founding Engineer",
  "capabilities": "Ships product changes with tests, clear handoffs, and accurate issue updates.",
  "providerType": "codex",
  "managerAgentId": "<manager-agent-id>",
  "heartbeatCron": "*/5 * * * *",
  "monthlyBudgetUsd": 100,
  "bootstrapPrompt": "Optional: prefer small PRs and note blockers in employee_comment.",
  "requestApproval": true
}
```

If you need multiline prompt text, write the JSON to a temp file or heredoc and submit with
`curl --data @file` instead of shell-escaping the body inline.
The runtime shell is `zsh` on macOS, so keep helper scripts POSIX/zsh-compatible and avoid
Bash-only features like `local -n`, `declare -n`, `mapfile`, and `readarray`.

## Governance rules

- Use approval-backed hiring by default.
- Do not bypass governance for routine hires (only board-level operators should bypass intentionally).
- If board feedback requests revisions, resubmit with explicit deltas.
- Keep approval threads updated with issue/agent/approval links.

## Quality bar

- Prefer proven adapter/runtime templates over one-off configs.
- Keep prompts operational and bounded to the role.
- Do not store plaintext secrets unless strictly required.
- Validate reporting chain and company ownership before submission.
- Use deterministic, auditable language in approval comments.
