/**
 * Whether the web UI should show the "Thinking effort" runtime control.
 *
 * - Claude Code: Bopo passes `--effort` to the CLI when not `auto`.
 * - Codex: `--reasoning-effort` is only forwarded when the API sets
 *   `BOPO_CODEX_PASS_REASONING_EFFORT=1`; otherwise the control misleads operators.
 * - Other providers: field is not wired in the local runtime layer.
 */
export function showThinkingEffortControlForProvider(providerType: string): boolean {
  return providerType === "claude_code";
}
