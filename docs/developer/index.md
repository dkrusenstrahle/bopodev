# Developer Documentation

Use this section to understand internals, APIs, and extension points.

## Audience

- Engineers building features in Bopo apps/packages.
- Engineers integrating custom runtimes or operating self-hosted instances.

## Pages

- [`architecture.md`](./architecture.md): system layout and runtime data flow.
- [`domain-model.md`](./domain-model.md): canonical entities and lifecycle semantics.
- [`api-reference.md`](./api-reference.md): route groups, headers, and behavior contracts.
- [`configuration-reference.md`](./configuration-reference.md): environment variables and defaults.
- [`workspace-resolution-reference.md`](./workspace-resolution-reference.md): canonical workspace/path model and runtime resolution precedence.
- [`plugin-system.md`](./plugin-system.md): plugin architecture, hooks, governance, and APIs.
- [`plugin-authoring.md`](./plugin-authoring.md): author manifests and safely roll out plugin behavior.
- [`plugin-hook-reference.md`](./plugin-hook-reference.md): hook-by-hook execution and failure semantics.
- [`plugin-samples.md`](./plugin-samples.md): reference sample manifests used for plugin validation.
- [`contributing.md`](./contributing.md): workflow and quality standards.

## Related

- Agent heartbeat protocol (full vs compact prompts, cost notes, `GET /issues/:id` hydration): [`../guides/agent-heartbeat-protocol.md`](../guides/agent-heartbeat-protocol.md)
- Setup guide: [`../getting-started-and-dev.md`](../getting-started-and-dev.md)
- Adapter overview: [`../adapters/overview.md`](../adapters/overview.md)
- Adapter authoring: [`../adapter-authoring.md`](../adapter-authoring.md)
- Adapter package structure: adapters now follow a package-local `root/server/ui/cli` layout documented in the overview and authoring guides.
