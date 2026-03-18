# Workflow Confidence Verification Matrix

This matrix is the source of truth for confidence checks across collaboration, governance, budgeting, run context, comments, and sub-issues.

## Verdict Scale

- `pass`: deterministic test(s) verify behavior and expected side effects.
- `partial`: behavior exists but has known limitations or missing side effects.
- `fail`: behavior is missing, insecure, or no-op.

## Q1: Delegation + Follow-up (CEO/CTO collaboration)

- **Scenario `Q1-S1`**: Delegated hiring request from leadership issue to approval to hired agent.
  - **Expected**: approval resolves with concrete side effects and lineage metadata.
  - **Evidence**: `hire_agent` resolution result, created agent, startup issue, audit log.
  - **Tests**: `tests/core-workflows.test.ts`.
- **Scenario `Q1-S2`**: Follow-up comments trigger assignee run dispatch and completion.
  - **Expected**: comment recipients move through delivery state and run is linked.
  - **Evidence**: recipients transition, queue job completion, linked run id.
  - **Tests**: `tests/core-workflows.test.ts`, `tests/workflow-confidence-governance-budget.test.ts`.

## Q2: Governance beyond hiring

- **Scenario `Q2-S1`**: `activate_goal` approval resolves and goal becomes active.
  - **Expected**: goal exists and status is active after approval resolve.
  - **Evidence**: resolve payload + persisted goal state.
  - **Tests**: `tests/workflow-confidence-governance-budget.test.ts`.
- **Scenario `Q2-S2`**: `override_budget` approval resolves and agent monthly budget changes.
  - **Expected**: agent budget increases and approval execution is applied.
  - **Evidence**: resolve payload, agent row before/after.
  - **Tests**: `tests/workflow-confidence-governance-budget.test.ts`.
- **Scenario `Q2-S3`**: `pause_agent` and `terminate_agent` approvals are executable.
  - **Expected**: agent status transitions to `paused` / `terminated`.
  - **Evidence**: resolve payload, persisted status update.
  - **Tests**: `tests/workflow-confidence-governance-budget.test.ts`.

## Q3: Budgeting behavior and scope

- **Scenario `Q3-S1`**: hard-stop when agent budget exhausted.
  - **Expected**: run is skipped and hard-stop audit is emitted.
  - **Evidence**: run status/message + audit event.
  - **Tests**: `tests/core-workflows.test.ts`.
- **Scenario `Q3-S2`**: hard-stop auto-requests governance budget override.
  - **Expected**: pending `override_budget` approval is created once per agent while pending.
  - **Evidence**: approval row action/payload/status.
  - **Tests**: `tests/workflow-confidence-governance-budget.test.ts`.
- **Scenario `Q3-S3`**: budget policy is explicitly agent-level only.
  - **Expected**: contracts/docs/tests clearly codify agent-level scope.
  - **Evidence**: budget service tests and policy docs.
  - **Tests**: `tests/workflow-confidence-governance-budget.test.ts`.

## Q4: Run context completeness

- **Scenario `Q4-S1`**: normal run prompt includes goals, issue details, labels/tags, and attachment paths.
  - **Expected**: prompt includes full assigned issue context.
  - **Evidence**: prompt snapshot/assertions from adapter execution.
  - **Tests**: `tests/agent-prompt-directives.test.ts`, `tests/core-workflows.test.ts`.
- **Scenario `Q4-S2`**: comment-order wake mode includes order intent and limits issue-body execution scope.
  - **Expected**: wake context and directives are present, body/attachments intentionally suppressed for comment-order linked items.
  - **Evidence**: prompt assertions.
  - **Tests**: `tests/workflow-confidence-context-comments.test.ts`.

## Q5: Root-cause vs band-aid resilience

- **Scenario `Q5-S1`**: comment creation logic is centralized across legacy and modern endpoints.
  - **Expected**: same policy for author attribution, recipients, activity/audit, and dispatch.
  - **Evidence**: shared helper usage + endpoint parity tests.
  - **Tests**: `tests/workflow-confidence-context-comments.test.ts`.
- **Scenario `Q5-S2`**: recipient parsing/state semantics use one shared codec.
  - **Expected**: consistent transitions and no endpoint/service drift.
  - **Evidence**: shared module and cross-surface assertions.
  - **Tests**: `tests/workflow-confidence-context-comments.test.ts`.

## Q6: Comment system as directives/orders

- **Scenario `Q6-S1`**: comment recipients are dispatchable and tracked.
  - **Expected**: agent recipients go `pending -> dispatched/failed`; non-agent recipients are terminal (`skipped`).
  - **Evidence**: recipients state in persisted comment record.
  - **Tests**: `tests/workflow-confidence-context-comments.test.ts`.
- **Scenario `Q6-S2`**: author identity cannot be spoofed by request payload.
  - **Expected**: actor headers control `authorType`/`authorId`.
  - **Evidence**: attempt to spoof is ignored/rejected.
  - **Tests**: `tests/workflow-confidence-context-comments.test.ts`.

## Q7: Issue context usage (description + attachments)

- **Scenario `Q7-S1`**: issue body and attachment metadata are available in non-comment-order runs.
  - **Expected**: prompt includes issue body + attachment absolute/relative paths.
  - **Evidence**: adapter prompt assertions and e2e heartbeat test.
  - **Tests**: `tests/core-workflows.test.ts`, `tests/agent-prompt-directives.test.ts`.

## Q8: Sub-issues usage and semantics

- **Scenario `Q8-S1`**: runtime context includes issue hierarchy references.
  - **Expected**: work items expose parent issue id and known child issue ids.
  - **Evidence**: prompt assertions on hierarchy fields.
  - **Tests**: `tests/workflow-confidence-context-comments.test.ts`, `tests/agent-prompt-directives.test.ts`.
- **Scenario `Q8-S2`**: sub-issues are treated as contextual subtasks, not implicit backlog expansion.
  - **Expected**: linked hierarchy is visible; execution scope remains explicit.
  - **Evidence**: prompt directives + wake-mode behavior.
  - **Tests**: `tests/workflow-confidence-context-comments.test.ts`.
