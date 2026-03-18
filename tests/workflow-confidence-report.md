# Workflow Confidence Report

This report maps the 8 workflow confidence questions to current verdicts after hardening changes and deterministic verification.

## Evidence Sources

- `tests/workflow-confidence-matrix.md`
- `tests/workflow-confidence-governance-budget.test.ts`
- `tests/workflow-confidence-context-comments.test.ts`
- `tests/agent-prompt-directives.test.ts`
- Existing integration coverage in `tests/core-workflows.test.ts`

## Verdicts

1) **Agent collaboration and leadership delegation**
- **Verdict**: `pass`
- **Evidence**:
  - Existing end-to-end delegated hire and follow-up behavior in `tests/core-workflows.test.ts`.
  - Comment delivery state transitions now normalized via shared recipient codec and tested in `tests/workflow-confidence-context-comments.test.ts`.
- **Notes**: Collaboration paths now use a centralized comment creation helper to reduce endpoint drift.

2) **Governance across all action types**
- **Verdict**: `pass`
- **Evidence**:
  - Executable side effects added and verified for:
    - `activate_goal`
    - `override_budget`
    - `pause_agent`
    - `terminate_agent`
  - Tests: `tests/workflow-confidence-governance-budget.test.ts`.
- **Notes**: Governance actions previously modeled as no-op now mutate state deterministically.

3) **Budgeting behavior (project / issue / agent)**
- **Verdict**: `partial`
- **Evidence**:
  - Agent-level hard-stop and override escalation are covered and verified.
  - Agent-only budget scope is explicitly codified in docs and tests.
  - Tests: `tests/workflow-confidence-governance-budget.test.ts`.
- **Notes**:
  - Project-level and issue-level budget enforcement are still not implemented by design.
  - Current confidence is high for agent-level budgeting only.

4) **Run context completeness (project, goals, issue details, comments)**
- **Verdict**: `pass`
- **Evidence**:
  - Prompt context includes goals, issue details, wake comment directives, and attachments (existing + targeted tests).
  - Hierarchy fields were added (`parentIssueId`, `childIssueIds`) and prompt rendering now includes sub-issue context.
  - Tests: `tests/workflow-confidence-context-comments.test.ts`, `tests/agent-prompt-directives.test.ts`.

5) **Band-aid patches vs root-cause fixes**
- **Verdict**: `partial`
- **Evidence**:
  - Root-cause improvements implemented:
    - Shared comment recipient codec.
    - Centralized comment creation flow across modern + legacy endpoints.
    - Governance no-op action gap removed.
  - Tests cover regression-sensitive behavior in dedicated suites.
- **Residual risk**:
  - Additional architectural consolidation remains possible in queue outcome typing and broader route-layer deduplication.

6) **Comment system as directives / order-giving**
- **Verdict**: `pass`
- **Evidence**:
  - Recipient state model now treats non-agent recipients as terminal (`skipped`) and agent recipients as dispatch targets (`pending`).
  - Member/agent actor spoofing of author identity is blocked.
  - Tests: `tests/workflow-confidence-context-comments.test.ts`.

7) **Issue context usage (description, attachments, etc.)**
- **Verdict**: `pass`
- **Evidence**:
  - Prompt-level context includes issue metadata and attachment paths in normal runs.
  - Comment-order behavior remains explicit and scoped.
  - Tests: `tests/agent-prompt-directives.test.ts` plus existing `tests/core-workflows.test.ts` attachment and comment-order coverage.

8) **Sub-issues usage and semantics**
- **Verdict**: `pass`
- **Evidence**:
  - Runtime context now carries parent and child issue hierarchy fields.
  - Prompt output includes hierarchy references for agent execution context.
  - Tests: `tests/workflow-confidence-context-comments.test.ts`.
- **Notes**: Sub-issues are currently contextual guidance, not implicit auto-expansion of work backlog.

## Residual Risk Summary

- Budgeting is still intentionally agent-level only; multi-level budgeting remains future scope.
- A broad integration suite (`tests/core-workflows.test.ts`) still has environmental coupling in some paths unrelated to these hardening changes.
- Queue/observability still use some message-derived behavior in older paths; a typed run-outcome migration would further reduce fragility.
