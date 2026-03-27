# Owner assistant (“Ask the team”)

Company-scoped chat where the operator asks natural-language questions; answers are **LLM-synthesized** from **read-only tools** over this company’s data and file-backed memory.

## Persona and policy

- **Persona:** Answers as a single **team assistant** (not per-agent @mentions).
- **Default:** **Read-only.** No issue/project mutations from chat in v1.
- **Scope:** **One company** per thread (`companyId`). Never mix tenants.

## Askable surface (contract)

**Structured (database / APIs):** company profile, projects, issues (incl. bounded comments), goals, work loops, agents (directory fields only—no `stateBlob` or runtime secrets), pending approvals, recent audit events, heartbeat runs, cost ledger entries.

**Files:** company memory root, project memory roots, agent memory files, agent operating markdown—path-sandboxed, size-capped (same limits as observability).

**Out of scope (v1):** other companies, raw credentials, arbitrary filesystem paths, external git/PR bodies.

## Tool catalog (implementation)

Tools are implemented server-side in `apps/api/src/services/company-assistant-service.ts` (names match `tool.name` sent to the model). The model may call multiple tools per user message; rounds are capped (`BOPO_ASSISTANT_MAX_TOOL_ROUNDS`, default 8).

## Provider configuration

- **Provider:** `BOPO_ASSISTANT_PROVIDER` — `anthropic_api` (default) or `openai_api`.
- **Model:** `BOPO_ASSISTANT_MODEL` — optional override; otherwise provider defaults.
- **Credentials:** Same env keys as direct API runtimes (`ANTHROPIC_API_KEY` / `OPENAI_API_KEY` or `BOPO_*` variants).

If no API key is configured, the assistant endpoint returns a clear error.

## Retrieval (phase 2)

Full-text search and embeddings across long markdown are **not** in v1; the assistant relies on structured tools and bounded file reads. Revisit when fuzzy cross-corpus questions justify the operational cost.
