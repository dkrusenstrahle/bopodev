# Changelog

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog and this project follows Semantic Versioning for tagged releases.

## [Unreleased]

### Added (0.1.0)

- Open source beta release gates and workflow verification checklist.
- Coverage thresholds and expanded integration tests for authz and realtime workflows.
- Playwright smoke tests for issues, projects, and governance journeys.
- OSS governance artifacts: license, contributing guide, code of conduct, security policy, issue templates, and PR template.

### Changed

- Heartbeat prompts default to **`full`** (inlined issue bodies). Set `BOPO_HEARTBEAT_PROMPT_MODE=compact` for thin prompts + `GET /issues/:id` hydration.
- Codex: `--reasoning-effort` is no longer passed unless **`BOPO_CODEX_PASS_REASONING_EFFORT=1`** (or `true`/`yes`), avoiding `unexpected argument '--reasoning-effort'` on CLI builds that omit the flag.
- Docs: [agent heartbeat protocol](docs/guides/agent-heartbeat-protocol.md) adds **cost expectations** (full vs compact) and clarifies **idle policy** vs prompt mode; [agents and runs](docs/product/agents-and-runs.md) documents **Thinking effort** UI (Claude vs Codex); [Codex runbook](docs/codex-connection-debugging.md) covers the `--reasoning-effort` CLI error.
- Tests: `tests/heartbeat-prompt-mode-defaults.test.ts` (default **full** prompt), `tests/provider-runtime-ui.test.ts` (Thinking effort shown only for Claude Code).
- Added CI-oriented scripts for `test:coverage` and `test:e2e`.
- Refreshed documentation coverage matrix and synced API, realtime, onboarding, product workflow, and release docs to current system behavior.
- Added app/package local README guides for `apps/web`, `apps/api`, and core shared packages (`contracts`, `db`, `agent-sdk`, `adapters`).

## [0.1.0] - 2026-03-08

### Added

- Initial local-first BopoDev platform release candidate.
