import { describe, expect, it } from "vitest";
import { createPrompt } from "../packages/agent-sdk/src/adapters";
import type { HeartbeatContext } from "../packages/agent-sdk/src/types";

/**
 * Default prompt shape: `promptMode` omitted or anything other than `compact` → full (inlined bodies).
 * Server sets `promptMode` from `BOPO_HEARTBEAT_PROMPT_MODE` (default `full`).
 */
describe("heartbeat prompt mode defaults (full)", () => {
  const base: HeartbeatContext = {
    companyId: "c1",
    agentId: "a1",
    providerType: "codex",
    heartbeatRunId: "run-1",
    company: { name: "Co", mission: null },
    agent: { name: "Agent", role: "Engineer" },
    workItems: [
      {
        issueId: "i1",
        projectId: "p1",
        title: "Task",
        body: "FULL_MODE_BODY_INLINE_MARKER",
        status: "todo"
      }
    ],
    state: {},
    runtime: {
      env: {
        BOPODEV_API_BASE_URL: "http://localhost:4020",
        BOPODEV_COMPANY_ID: "c1",
        BOPODEV_ACTOR_TYPE: "agent",
        BOPODEV_ACTOR_ID: "a1",
        BOPODEV_ACTOR_COMPANIES: "c1",
        BOPODEV_ACTOR_PERMISSIONS: "issues:write"
      }
    }
  };

  it("omitting promptMode inlines issue body and does not emit compact profile", () => {
    const prompt = createPrompt(base);
    expect(prompt).toContain("Body: FULL_MODE_BODY_INLINE_MARKER");
    expect(prompt).not.toContain("Prompt profile: compact");
    expect(prompt).not.toContain("Context hydration (compact prompt mode)");
  });

  it("promptMode full matches omitted behavior for body", () => {
    const prompt = createPrompt({ ...base, promptMode: "full" });
    expect(prompt).toContain("Body: FULL_MODE_BODY_INLINE_MARKER");
    expect(prompt).not.toContain("Prompt profile: compact");
  });
});
