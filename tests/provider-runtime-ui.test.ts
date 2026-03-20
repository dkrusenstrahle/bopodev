import { describe, expect, it } from "vitest";
import { showThinkingEffortControlForProvider } from "../apps/web/src/lib/provider-runtime-ui";

describe("provider-runtime-ui", () => {
  it("shows thinking effort only for Claude Code", () => {
    expect(showThinkingEffortControlForProvider("claude_code")).toBe(true);
    expect(showThinkingEffortControlForProvider("codex")).toBe(false);
    expect(showThinkingEffortControlForProvider("opencode")).toBe(false);
    expect(showThinkingEffortControlForProvider("gemini_cli")).toBe(false);
    expect(showThinkingEffortControlForProvider("cursor")).toBe(false);
    expect(showThinkingEffortControlForProvider("http")).toBe(false);
    expect(showThinkingEffortControlForProvider("shell")).toBe(false);
  });
});
