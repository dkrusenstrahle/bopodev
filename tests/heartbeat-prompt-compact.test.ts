import { describe, expect, it, afterEach } from "vitest";
import { createPrompt } from "../packages/agent-sdk/src/adapters";
import type { HeartbeatContext } from "../packages/agent-sdk/src/types";

const baseRuntime = {
  env: {
    BOPODEV_API_BASE_URL: "http://localhost:4020",
    BOPODEV_COMPANY_ID: "company-1",
    BOPODEV_ACTOR_TYPE: "agent",
    BOPODEV_ACTOR_ID: "agent-1",
    BOPODEV_ACTOR_COMPANIES: "company-1",
    BOPODEV_ACTOR_PERMISSIONS: "issues:write"
  }
};

function minimalContext(overrides: Partial<HeartbeatContext> = {}): HeartbeatContext {
  return {
    companyId: "company-1",
    agentId: "agent-1",
    providerType: "gemini_cli",
    heartbeatRunId: "run-1",
    company: { name: "Demo Co", mission: "Ship safely." },
    agent: { name: "Worker", role: "Engineer" },
    workItems: [
      {
        issueId: "issue-secret-body",
        projectId: "project-1",
        title: "Do work",
        body: "SECRET_INLINE_BODY_SHOULD_NOT_APPEAR_IN_COMPACT",
        status: "in_progress",
        attachments: [
          {
            id: "att-1",
            fileName: "notes.txt",
            mimeType: "text/plain",
            fileSizeBytes: 12,
            relativePath: "agents/agent-1/notes.txt",
            absolutePath: "/tmp/agents/agent-1/notes.txt",
            downloadPath: "/issues/issue-secret-body/attachments/att-1/download"
          }
        ]
      }
    ],
    state: {},
    runtime: baseRuntime,
    ...overrides
  };
}

describe("heartbeat prompt compact mode", () => {
  afterEach(() => {
    delete process.env.BOPO_HEARTBEAT_PROMPT_MEMORY_MAX_CHARS;
  });

  it("omits inlined issue body and adds hydration + GET issue instruction", () => {
    const prompt = createPrompt(
      minimalContext({
        promptMode: "compact"
      })
    );
    expect(prompt).not.toContain("SECRET_INLINE_BODY_SHOULD_NOT_APPEAR_IN_COMPACT");
    expect(prompt).toContain("Prompt profile: compact");
    expect(prompt).toContain("Context hydration (compact prompt mode)");
    expect(prompt).toContain("GET `$BOPODEV_API_BASE_URL`/issues/{issueId}");
    expect(prompt).toContain("http://localhost:4020/issues/<issueId>");
    expect(prompt).toContain("GET http://localhost:4020/issues/issue-secret-body");
    expect(prompt).toContain("api: http://localhost:4020/issues/issue-secret-body/attachments/att-1/download");
    expect(prompt).toContain('"employee_comment":"markdown update to the manager"');
  });

  it("truncates tacit notes when BOPO_HEARTBEAT_PROMPT_MEMORY_MAX_CHARS is set", () => {
    process.env.BOPO_HEARTBEAT_PROMPT_MEMORY_MAX_CHARS = "80";
    const longNotes = "x".repeat(200);
    const prompt = createPrompt(
      minimalContext({
        promptMode: "compact",
        memoryContext: {
          memoryRoot: "/mem",
          tacitNotes: longNotes,
          durableFacts: [],
          dailyNotes: []
        }
      })
    );
    expect(prompt).toContain("…(truncated for prompt size)");
    expect(prompt).not.toContain(longNotes);
  });

  it("idle micro prompt is minimal and keeps JSON footer", () => {
    const prompt = createPrompt(
      minimalContext({
        idleMicroPrompt: true,
        workItems: []
      })
    );
    expect(prompt).toContain("Idle heartbeat (micro prompt)");
    expect(prompt).not.toContain("Memory context:");
    expect(prompt).toContain('"employee_comment":"markdown update to the manager"');
  });
});
