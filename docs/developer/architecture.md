# Architecture

This page describes the Bopo system layout and runtime flow.

## Purpose

Provide a practical architecture map for contributors extending the platform.

## Intended Audience

- Engineers working in `apps/web`, `apps/api`, or shared packages.

## Monorepo Components

- `apps/web`: Next.js client and workspace UI.
- `apps/api`: Express API, realtime hub, scheduler, and domain orchestration.
- `packages/contracts`: shared Zod schemas and event contracts.
- `packages/db`: Drizzle schema, repositories, and instance path defaults.
- `packages/agent-sdk`: adapter registry, shared types, provider-agnostic runtime primitives, and common result/trace shaping.
- `packages/cli`: onboarding and doctor commands.
- `packages/adapters/*`: provider-owned execution, parsing, session/retry policy, model listing, and environment diagnostics.

## Request and Execution Flow

1. Web client sends HTTP requests to API routes.
2. API validates, authorizes via company + actor headers, and persists through repositories.
3. For heartbeats, API resolves runtime config and invokes agent SDK adapters.
4. Run outcomes update issues/governance/costs/audit records.
5. Realtime hub publishes snapshot and incremental events to subscribers.

## Realtime Architecture

- API mounts websocket channels at `/realtime`.
- Channel loaders provide bootstrap snapshots (governance, office-space).
- Events are company-scoped to keep tenant boundaries explicit.

## Scheduler Architecture

- Scheduler runs in API process.
- Sweep cadence is controlled by `BOPO_HEARTBEAT_SWEEP_MS`.
- Sweep picks eligible idle agents and records skipped/failed/completed run states.

## Key Design Constraints

- Local-first persistence (embedded DB by default).
- Explicit governance for high-impact side effects.
- Structured execution outcomes (actions/blockers/artifacts) over free-form logs.
- Provider-agnostic runtime via adapter contract.

## Adapter Ownership Model

- Provider-specific behavior belongs in adapter packages under `packages/adapters/*`.
- Adapter `server/execute.ts` owns launch policy, retry/resume decisions, and provider runtime semantics.
- Adapter `server/parse.ts` owns provider-native usage/session parsing.
- Adapter `server/test.ts` owns provider preflight/environment diagnostics.
- `packages/agent-sdk` should not be the place for provider switchboards; it should expose reusable runtime/process primitives and normalized result helpers.

## Related Pages

- Domain model: [`domain-model.md`](./domain-model.md)
- API reference: [`api-reference.md`](./api-reference.md)
- Configuration reference: [`configuration-reference.md`](./configuration-reference.md)
- Adapter overview: [`../adapters/overview.md`](../adapters/overview.md)

