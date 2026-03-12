# Adapters Overview

Adapters connect heartbeat orchestration to a specific runtime provider.

## Architecture

Adapters are package-based modules that implement a shared contract.

```txt
packages/adapters/<name>/
  package.json
  tsconfig.json
  src/
    index.ts                # root metadata + assembled AdapterModule
    server/
      index.ts              # server exports
      execute.ts            # runtime execution entrypoint
      parse.ts              # provider-specific output parsing helpers
      test.ts               # environment diagnostics
    ui/
      index.ts              # UI exports
      parse-stdout.ts       # transcript parsing for run viewer
      build-config.ts       # adapter config builder
    cli/
      index.ts              # CLI exports
      format-event.ts       # terminal formatting
```

Registry and orchestration live in:

- `packages/agent-sdk/src/registry.ts` (module resolution + compatibility wrappers)
- `apps/api/src/services/heartbeat-service.ts` (heartbeat orchestration)
- `apps/api/src/routes/agents.ts` (metadata/models/preflight endpoints)

Each adapter package owns its own runtime-specific behavior. The registry and heartbeat service should know how to resolve and call an adapter, but they should not be the place where provider-specific parsing, probing, or launch behavior is implemented.

## Package responsibilities

### Root module

`src/index.ts` is the adapter identity layer. It should define:

- `type`
- `label`
- `metadata`
- optional static `models`
- `agentConfigurationDoc`
- assembled `AdapterModule`

This file should stay lightweight and mostly declarative.

### Server module

The `server/` directory is the required execution surface for an adapter.

Each package should provide:

- `execute(context) -> AdapterExecutionResult`
- optional `listModels(runtime)`
- optional `testEnvironment(runtime)`

Provider-specific execution logic belongs in `server/execute.ts`.
Provider-specific stdout/stderr parsing belongs in `server/parse.ts`.
Provider-specific preflight checks belong in `server/test.ts`.
Provider-specific pricing identity mapping (`pricingProviderType`, `pricingModelId`) should be resolved by the adapter execute path rather than central SDK switch logic.

### UI module

The `ui/` directory owns adapter-specific presentation helpers:

- transcript line parsing for the run viewer
- adapter-specific config serialization

### CLI module

The `cli/` directory owns adapter-specific terminal formatting for command-line usage.

## Built-in adapter types

- `claude_code`
- `codex`
- `cursor`
- `opencode`
- `openai_api`
- `anthropic_api`
- `http`
- `shell`

`openai_api` and `anthropic_api` are first-class direct API adapters for server environments where local Codex/Claude CLIs are unavailable.

## Provider selection quick guide

- Use `codex` / `claude_code` when you want CLI-native behavior on hosts where those CLIs are installed.
- Use `opencode` when you want OpenCode CLI execution; configure `runtimeModel` in `provider/model` format.
- Use `openai_api` / `anthropic_api` for direct provider API execution with API keys only.
- Use `http` / `shell` for custom worker commands or bespoke runtime wrappers.

## Runtime contract

Each adapter module should provide:

- root metadata describing capabilities and selection behavior
- execution (`server.execute(context) -> AdapterExecutionResult`)
- model listing (`server.listModels`) when model selection is relevant
- environment diagnostics (`server.testEnvironment`) with `info|warn|error` checks
- optional UI helpers (`ui.parseStdoutLine`, `ui.buildAdapterConfig`)
- optional CLI helpers (`cli.formatStdoutEvent`)

`server.execute` should also preserve structured outcome semantics:

- return blocked outcomes (`kind: "blocked"`) for validation/config failures that do not represent completed work
- preserve adapter-specific observability fields (session, structured source, retries) in traces

## Design rule

When adding or changing an adapter:

- put adapter-specific code in that adapter's package
- keep central registry/orchestration code generic
- use shared runtime helpers only for cross-adapter primitives such as process spawning, retries, transcript normalization, or common environment handling
- prefer adapter-local `listModels` and `testEnvironment`; registry fallback behavior is compatibility-only, not the primary extension point

If a new behavior only applies to one runtime, it should live in that runtime's package, not in a central switch statement.

## Registration checklist

When adding a new adapter:

1. Add provider type to shared contracts.
2. Create package at `packages/adapters/<name>/`.
3. Add the full `root/server/ui/cli` file structure.
4. Export `AdapterModule` in `src/index.ts`.
5. Register the module in `packages/agent-sdk/src/registry.ts`.
6. Add/extend tests in `tests/adapter-platform.test.ts` and `tests/adapter-module-contract.test.ts`.
7. Verify metadata/models/preflight endpoints in API.

## Reliability expectations

- run in configured `cwd` and surface command health failures clearly
- produce structured usage and summary when possible
- preserve stable retry and timeout behavior
- keep adapter output bounded in traces for observability

## API endpoints

- `GET /agents/adapter-metadata`
- `GET /agents/adapter-models/:providerType`
- `POST /agents/runtime-preflight`

## Related docs

- Runtime and architecture context: [`docs/developer/architecture.md`](../developer/architecture.md)
- API route details: [`docs/developer/api-reference.md`](../developer/api-reference.md)
- Config and environment variables: [`docs/developer/configuration-reference.md`](../developer/configuration-reference.md)
- Adapter implementation steps: [`docs/adapter-authoring.md`](../adapter-authoring.md)
