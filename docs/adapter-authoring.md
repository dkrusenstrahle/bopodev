# Adapter Authoring Guide

This guide describes how to add or modify a runtime adapter using the package-local adapter structure.

## Required package layout

Create a package under `packages/adapters/<adapter-name>/`:

```txt
packages/adapters/<adapter-name>/
  package.json
  tsconfig.json
  src/
    index.ts
    server/
      index.ts
      execute.ts
      parse.ts
      test.ts
    ui/
      index.ts
      parse-stdout.ts
      build-config.ts
    cli/
      index.ts
      format-event.ts
```

## Ownership rules

- Adapter-specific runtime behavior belongs inside that adapter package.
- Central SDK files should stay generic: registry glue, shared types, and reusable runtime primitives.
- If a behavior only applies to one runtime, it should live in that runtime's `server/`, `ui/`, or `cli/` directory.
- `src/index.ts` should stay lightweight and declarative.

## Root module responsibilities

`src/index.ts` should export:

- `type`
- `label`
- `metadata`
- optional `models`
- `agentConfigurationDoc`
- assembled `<adapterName>AdapterModule: AdapterModule`

The root file should describe the adapter, not contain its execution logic.

## Server module responsibilities

The `server/` directory is the required execution surface.

- `execute.ts`: launch/runtime flow for that adapter
- `parse.ts`: adapter-specific parsing helpers and unknown-session detection
- `test.ts`: adapter-specific environment diagnostics
- `index.ts`: re-export server entrypoints and optional `listModels(runtime)`

Examples of logic that belongs here:

- provider-specific command resolution
- provider-specific prompt/argument shaping
- provider-specific session resume behavior
- provider-specific output parsing
- provider-specific preflight checks
- provider-specific pricing identity (`pricingProviderType`, `pricingModelId`)
- provider-specific blocked outcome semantics for precondition/config failures

## UI module responsibilities

The `ui/` directory owns adapter-specific UI helpers.

- `parse-stdout.ts`: convert stdout lines into viewer-friendly transcript entries
- `build-config.ts`: convert UI values into adapter config
- `index.ts`: re-export UI helpers

## CLI module responsibilities

The `cli/` directory owns adapter-specific terminal formatting.

- `format-event.ts`: format stdout events for command-line use
- `index.ts`: re-export CLI helpers

## Shared helpers

Use shared helpers only for cross-adapter primitives:

- `packages/agent-sdk/src/runtime-core.ts`
- `packages/agent-sdk/src/runtime-http.ts`
- `packages/agent-sdk/src/runtime-parsers.ts`

Shared helpers are for common mechanics such as process spawning, retries, timeouts, and generic parsing utilities. They should not become a second home for adapter-specific branches.

## 1. Register provider contract

- Add the provider to `ProviderTypeSchema` in `packages/contracts/src/index.ts`.
- Ensure DB repository/provider unions include the new type in `packages/db/src/repositories.ts`.

## 2. Implement the adapter package

Build the full package layout and export an `AdapterModule` from `src/index.ts`.

At minimum, implement:

- `server.execute(context)`
- optional `server.listModels(runtime)`
- optional `server.testEnvironment(runtime)`
- `metadata` and `agentConfigurationDoc`

Authoring guidance:

- `server.execute` should keep provider policy local (args, retry/resume, parsing, pricing identity).
- `server.testEnvironment` should return stable contract envelopes with provider-matching `providerType` and `info|warn|error` checks.
- use shared helpers for mechanics only; keep provider decision logic in adapter package files.

## 3. Register in adapter registry

Wire the package module into `packages/agent-sdk/src/registry.ts`:

- add import for the package root module
- add entry in `adapterModules`

The compatibility API remains stable:

- `resolveAdapter(providerType)`
- `getAdapterModels(providerType, runtime?)`
- `runAdapterEnvironmentTest(providerType, runtime?)`
- `getAdapterMetadata()`

## 4. API and UI integration

- API route surfaces metadata/models/preflight via `apps/api/src/routes/agents.ts`
- UI provider options and forms live in:
  - `apps/web/src/components/modals/create-agent-modal.tsx`
  - `apps/web/src/components/agent-runtime-defaults-card.tsx`
  - `apps/web/src/lib/agent-runtime-options.ts`

## 5. Validation checklist

- `pnpm typecheck` passes
- `pnpm test` passes
- runtime preflight returns actionable checks
- adapter appears in metadata and create/edit agent flow
- model list endpoint returns stable options
- adapter module contract tests pass
- adapter package contains every required `root/server/ui/cli` file
- no new adapter-specific logic is introduced in central registry/orchestration files unless it is truly shared

## Related docs

- Domain entities and terminology: [`docs/developer/domain-model.md`](./developer/domain-model.md)
- Route-level API details: [`docs/developer/api-reference.md`](./developer/api-reference.md)
- Runtime config/env variables: [`docs/developer/configuration-reference.md`](./developer/configuration-reference.md)
