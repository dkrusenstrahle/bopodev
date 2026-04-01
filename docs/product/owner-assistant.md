# Owner assistant (Chat)

Company-scoped conversational **Chat** in the web app (nav **Chat**, route `ask`). The operator asks natural-language questions; replies are produced by an LLM using **read-only** access to that company’s planning data, costs, governance state, and file-backed memory.

This page is the product guide. For environment variables, see [`../developer/configuration-reference.md`](../developer/configuration-reference.md). For HTTP contracts, see [`../developer/api-reference.md`](../developer/api-reference.md).

## What it is for

- **Fast answers** about the active company: projects, issues, goals, agents, approvals, recent runs, spend, and memory notes—without clicking through every screen.
- **One thread per company** by default in the UI, with optional **new conversations** when you want a clean slate (server still stores older threads).
- **Same adapter families as hired agents** for the answering runtime (Codex, Cursor, Claude Code, OpenCode, Gemini CLI, etc.), so local toolchains and models stay aligned with how you run workers.

## What it is not

- **Not a mutating control plane** in v1: chat does not create or edit issues, projects, or goals from the assistant UI.
- **Not cross-company**: every turn is scoped to the company selected in the shell (`x-company-id` on the API).
- **Not a replacement for heartbeats**: agents still execute assigned work on their schedules; Chat is for the human operator’s Q&A.

## UI walkthrough

1. **Select a company** in the app shell. Chat is disabled until a company is active.
2. **Brain** (dropdown): chooses which **CLI-backed adapter** answers the next message (`GET /assistant/brains`). Labels and `requiresRuntimeCwd` come from the same adapter metadata used when hiring agents. The choice is remembered per company in the browser (`localStorage` key prefix `bopo-chat-brain:`).
3. **Thread**: Opening Chat loads messages for the **last-used thread** for that company (stored under `bopo-chat-thread:<companyId>`). If none is stored, the API uses **latest-or-create** for the company.
4. **New**: starts a **new server thread** and clears the on-screen history for a fresh conversation (previous threads remain on the server).
5. **Composer**: plain text; **Enter** sends, **Shift+Enter** inserts a newline. While a turn is in flight, the composer is disabled.

Welcome copy and avatars use a **CEO persona** derived from the company’s agent roster (see below).

## CEO persona

The assistant is framed as talking to the company **CEO**:

- If an agent has `roleKey` `ceo` (or legacy `role` `CEO`), that agent’s **name**, **title**, and **avatar seed** drive the label and portrait in the thread.
- If no CEO agent exists, the UI falls back to a generic **CEO** label.

Persona affects presentation and prompt tone; it does not grant extra data access beyond the company boundary.

## How a turn runs

### CLI brains (default product path)

For brains such as `codex`, `cursor`, `claude_code`, `opencode`, and `gemini_cli`:

1. The API persists the user message on the assistant thread.
2. The server builds a **bounded JSON snapshot** of the company (`buildCompanyAssistantContextSnapshot` in `apps/api/src/services/company-assistant-context-snapshot.ts`): projects, issues, goals, agents, approvals, runs, cost summaries, and **memory context** (see below).
3. A **local CLI/runtime** run (same stack as agent execution) produces one assistant reply from that snapshot plus operator instructions (`company-assistant-cli.ts`).
4. The assistant message is stored; **cost ledger** rows may be written for metered usage when the runtime reports tokens or USD (see [Cost accounting](#cost-accounting)).

The CLI path is **not** the same as heartbeat tool-rounds: the model does not call Bopo HTTP tools per message; it answers from the injected snapshot (subject to the CLI’s own behavior).

### Direct API path (service implementation)

`company-assistant-service` also implements an **Anthropic / OpenAI direct API** path with **server-side tools** (`runAssistantWithTools` in `company-assistant-llm.ts`): multi-step tool calls, capped by `BOPO_ASSISTANT_MAX_TOOL_ROUNDS`. That path is selected when the resolved `brain` is a direct API provider type.

The **public** `POST /assistant/messages` schema today accepts only **CLI** `brain` values matching `GET /assistant/brains`. Operators should assume **CLI** execution unless you extend the API. When the direct API path *is* used, configure it with `BOPO_ASSISTANT_PROVIDER`, `BOPO_ASSISTANT_MODEL`, and the usual `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` (or `BOPO_*` variants)—see configuration reference.

## Memory in context

The JSON snapshot includes a `memoryContext` block built via `loadAgentMemoryContext` (same file-backed memory system as heartbeats):

- **Anchor agent**: the first **non-terminated** agent when sorted by name (see `resolveMemoryAnchorAgentId` in the snapshot builder). If there are no agents, memory fields are empty.
- **Content**: tacit notes, durable facts, daily notes, and memory root hints—same semantics as [`agent-memory-workflow.md`](./agent-memory-workflow.md).

Implication: to give Chat richer memory, maintain **company / project / agent memory files** and keep at least one active agent if you want a stable anchor (or accept empty memory until agents exist).

## Read-only surface (contract)

**In scope:** company profile, projects, issues (including bounded comments), goals, routines, agents (directory fields—no runtime secrets), pending approvals, audit events, heartbeat runs, cost ledger summaries and recent rows, path-sandboxed memory and operating markdown (same path and size limits as observability).

**Out of scope:** other companies, arbitrary filesystem paths, raw credentials, external git/PR bodies. Full-text search / embeddings across all markdown are **not** in v1; answers rely on structured snapshot fields and bounded file reads.

## Tool catalog (direct API mode only)

When the direct API path runs, tools are defined in `apps/api/src/services/company-assistant-service.ts` (names match `tool.name` sent to the model), including for example:

`get_company`, `list_projects`, `get_project`, `list_issues`, `get_issue`, `list_issue_comments`, `list_goals`, `get_goal`, `list_routines`, `get_routine`, `list_agents`, `get_agent`, `list_pending_approvals`, `list_recent_heartbeat_runs`, `list_cost_entries`, `get_cost_usage_summary`, `list_audit_events`, `memory_context_preview`, `list_company_memory_files`, `read_company_memory_file`, `list_project_memory_files`, `read_project_memory_file`, `list_agent_memory_files`, `read_agent_memory_file`, `list_agent_operating_files`, `read_agent_operating_file`.

CLI turns do not expose this tool surface to the model as separate round-trips; they rely on the snapshot payload instead.

## Cost accounting

Each completed assistant turn can append a **cost ledger** row with `cost_category` = `company_assistant`, linking `assistant_thread_id` and `assistant_message_id` so **Costs** views can attribute spend to chat.

- **Direct API**: tokens from provider usage roll up; USD uses the same pricing path as heartbeats when catalog pricing exists.
- **CLI**: a row is still recorded when the runtime reports tokens or USD; otherwise you may see attribution with zero tokens/USD.

See glossary: **Cost ledger entry** in [`../glossary.md`](../glossary.md).

## API summary

All routes live under `/assistant`, are **company-scoped**, and require the normal actor headers (see API reference).

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/assistant/brains` | List selectable CLI brains (`providerType`, `label`, `requiresRuntimeCwd`). |
| `GET` | `/assistant/messages` | Load history; optional `threadId`, `limit` (default 100, max 200). Omit `threadId` for latest-or-create. Returns `ceoPersona` + `messages[]`. |
| `POST` | `/assistant/messages` | Run one turn: body `{ message, brain?, threadId? }`. `message` trimmed, 1–16000 chars. |
| `POST` | `/assistant/threads` | Create a new empty thread; returns `threadId`. |

**Default brain** when the client omits `brain`: `BOPO_CHAT_DEFAULT_BRAIN` if set to a valid CLI id, otherwise **`codex`**.

Observability: `GET /observability/assistant-chat-threads` supports cost UIs with thread stats over a time window (`from` + `toExclusive` ISO, or `monthKey`).

Integration tests without LLM calls: `tests/assistant-chat-routes.test.ts`.

## Troubleshooting

- **“Missing API key” / 503** on turns that use direct API: configure provider keys per [`configuration-reference.md`](../developer/configuration-reference.md).
- **CLI brain errors** (timeout, command not found): same fixes as agent runtimes—install the CLI, check `BOPO_*_COMMAND` overrides, and ensure **runtime cwd** is valid when `requiresRuntimeCwd` is true.
- **Empty memory in answers**: confirm agents exist and memory files are populated under the company workspace; see [`agent-memory-workflow.md`](./agent-memory-workflow.md).
- **Wrong thread after switching devices**: thread id is stored in **browser localStorage** per company, not synced across browsers.

## Related pages

- Product map: [`overview.md`](./overview.md) (`ask` section)
- Daily operations: [`daily-workflows.md`](./daily-workflows.md)
- Agents, runtimes, Documents: [`agents-and-runs.md`](./agents-and-runs.md)
- Memory lifecycle: [`agent-memory-workflow.md`](./agent-memory-workflow.md)
- Configuration: [`../developer/configuration-reference.md`](../developer/configuration-reference.md)
- API routes: [`../developer/api-reference.md`](../developer/api-reference.md)
