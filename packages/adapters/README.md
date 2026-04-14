# `packages/adapters`

Built-in adapter implementations for supported runtime providers.

## Responsibilities

- Keep provider-specific execution logic inside adapter packages.
- Export per-adapter `root/server/ui/cli` surfaces expected by the SDK registry.
- Provide provider-specific parsing, health checks, and model integration behavior.

## Built-in Adapter Packages

- `claude-code`
- `codex`
- `cursor`
- `opencode`
- `openai-api`
- `anthropic-api`
- `hermes-local`
- `http`
- `shell`
- `gemini-cli`

## Design Rule

Adapter-specific behavior belongs in the adapter package, not in central switch logic.

## Related Docs

- `docs/adapters/overview.md`
- `docs/adapter-authoring.md`
- `docs/developer/configuration-reference.md`
