# Agent heartbeat protocol (lean prompts + API hydration)

This guide describes how heartbeat runs expose context to agents and how to load full issue data without inflating every prompt.

## Identify the run

Each heartbeat prompt includes:

- **Agent identity** and **heartbeat run id** (`BOPODEV_RUN_ID` is also injected into the runtime environment).
- **Assigned issues** (or linked issue ids for comment-order wakes).

Optional **prompt profile** line:

- **Compact** (opt-in): issue bodies are not inlined; use the control plane to hydrate.

## Default: full (inlined bodies)

By default, prompts are **full** (`BOPO_HEARTBEAT_PROMPT_MODE` unset or any value other than `compact`). Issue descriptions are inlined in the heartbeat. Set `BOPO_HEARTBEAT_PROMPT_MODE=compact` for thin prompts + API hydration. `BOPODEV_HEARTBEAT_PROMPT_MODE` mirrors the resolved value in the runtime env.

## When the prompt is compact

When `BOPO_HEARTBEAT_PROMPT_MODE=compact`:

1. Read issue titles, status, and pointers from the heartbeat text.
2. Before substantive work on an issue, fetch full details with:

   `GET {BOPODEV_API_BASE_URL}/issues/{issueId}`

3. Use the same **actor headers** as for other API calls (`x-company-id`, `x-actor-type`, `x-actor-id`, `x-actor-companies`, `x-actor-permissions`). The prompt includes a curl template; prefer the env vars already injected for your shell.

The issue detail response includes **`goalIds`** (linked planning goals), **`knowledgePaths`** (relative paths under the company `knowledge/` tree), **attachments** metadata, and each attachment’s **`downloadPath`** (API-relative path to the download route). Prefer HTTP when the runtime is remote from the API host; local runs may still use filesystem paths printed in the prompt.

To load linked knowledge file text, use:

`GET {BOPODEV_API_BASE_URL}/observability/company-knowledge/file?path=<url-encoded relative path>`

(same company actor headers as other observability reads).

In **full** prompt mode, assigned work items may also include one **“Linked goal N (root → leaf): …”** line per linked goal (compact mode still expects you to hydrate issue detail for full goal lists when needed).

## Attachments

- **List / metadata**: included on `GET /issues/:issueId` (and existing list routes).
- **Download**: `GET /issues/:issueId/attachments/:attachmentId/download` (or the full URL formed from `BOPODEV_API_BASE_URL` + `downloadPath`).

## Checkout and updates

Assigned issues should still be **checked out** and progressed per your usual workflow (skills, CLI, or API). Compact mode does not change write semantics—it only reduces what is inlined in the initial prompt.

## Cost: full vs compact (what to expect)

**Compact** shrinks the **first** heartbeat message (no inlined issue bodies; optional memory caps). **Provider billing** for CLI agents (e.g. Codex) is usually driven by **total input over the whole run**—system prompt, conversation history, tool results, and file reads—not only that first blob.

So:

- **Full** can be cheaper for some workloads if the agent would otherwise **re-fetch** the same issue text in later turns (paying again against a growing context window).
- **Compact** can still win when issue bodies are **huge**, you care about **context window headroom**, or you want a **stable, short** heartbeat template.

**Do not assume** compact always lowers `$`. Compare **input vs output** and **run shape** for the same issues; treat mode as an empirical knob.

## Memory

Large memory sections may be truncated in compact mode (see `BOPO_HEARTBEAT_PROMPT_MEMORY_MAX_CHARS` in the [configuration reference](../developer/configuration-reference.md)). Treat file-backed memory as source of truth when the prompt shows a truncation marker.

## Idle heartbeats (optional)

When there are **no assigned work items** (and the run is not a comment-order wake), operators can set **`BOPO_HEARTBEAT_IDLE_POLICY`**:

- `skip_adapter` — skip invoking the LLM adapter; the run completes with a short summary.
- `micro_prompt` — use a minimal prompt and still require the standard final JSON object.

For **idle** heartbeats with **no assigned issues** (excluding comment-order wakes), completed runs that are classified as **no assigned work**—including the `skip_adapter` path—are **removed from `heartbeat_runs` after completion** (and their `heartbeat_run` audit rows), so schedulers do not fill the database with empty runs. Cost rows keep their numeric totals with `run_id` cleared.

**Default:** `full` — same as today’s normal behavior (always invoke the adapter with the standard prompt shape). This is **idle policy**, not prompt mode. See the [configuration reference](../developer/configuration-reference.md) for `BOPODEV_HEARTBEAT_IDLE_POLICY`.

## Final output contract

Regardless of mode, the runtime still expects the **single-line JSON** footer schema documented in the heartbeat prompt (`employee_comment`, `results`, `errors`, `artifacts`).

## See also

- [API reference](../developer/api-reference.md) — `GET /issues/:issueId`
- [Configuration reference](../developer/configuration-reference.md) — `BOPO_HEARTBEAT_*` variables
