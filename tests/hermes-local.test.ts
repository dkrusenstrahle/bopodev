import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveAdapter } from "../packages/agent-sdk/src/registry";
import { resolveHermesRuntimeUsage, resolveHermesSessionId } from "../packages/adapters/hermes-local/src/server/parse";

describe("hermes local adapter", () => {
  it("prefers stdout structured usage when available", () => {
    const usage = resolveHermesRuntimeUsage({
      stdout: JSON.stringify({ summary: "ok", tokenInput: 7, tokenOutput: 3, usdCost: 0.0001 }),
      stderr: "",
      parsedUsage: undefined,
      structuredOutputSource: undefined
    });
    expect(usage.structuredOutputSource).toBe("stdout");
    expect(usage.parsedUsage?.summary).toBe("ok");
    expect(usage.parsedUsage?.tokenInput).toBe(7);
    expect(usage.parsedUsage?.tokenOutput).toBe(3);
  });

  it("extracts session ids from runtime output", () => {
    const sessionId = resolveHermesSessionId(
      "session_id: 20260414_120000_abc123",
      "runtime note"
    );
    expect(sessionId).toBe("20260414_120000_abc123");
  });

  it("executes hermes adapter and persists session state", async () => {
    const { command, cleanup } = await createCliShim(
      "hermes",
      [
        "console.log(JSON.stringify({ summary: 'hermes-ok', tokenInput: 5, tokenOutput: 2, usdCost: 0.00002 }));",
        "console.log('session_id: 20260414_120000_abc123');"
      ].join("\n")
    );
    const adapter = resolveAdapter("hermes_local");
    const result = await adapter.execute({
      companyId: "demo-company",
      agentId: "agent-1",
      providerType: "hermes_local",
      heartbeatRunId: "run-1",
      company: { name: "Demo Co", mission: null },
      agent: { name: "Demo Agent", role: "Engineer", managerAgentId: null },
      workItems: [{ issueId: "issue-1", projectId: "project-1", title: "Do work" }],
      state: {},
      runtime: {
        command
      }
    });
    await cleanup();
    expect(result.status).toBe("ok");
    expect(result.summary).toContain("hermes-ok");
    expect(result.tokenInput).toBe(5);
    expect(result.tokenOutput).toBe(2);
    expect(result.nextState?.sessionId).toBe("20260414_120000_abc123");
  });
});

async function createCliShim(binaryName: string, scriptBody: string) {
  const tempDir = await mkdtemp(join(tmpdir(), "bopodev-hermes-shim-"));
  const command = join(tempDir, binaryName);
  const script = `#!/usr/bin/env node\n${scriptBody}\n`;
  await writeFile(command, script, "utf8");
  await chmod(command, 0o755);
  return {
    command,
    cleanup: async () => {
      await rm(tempDir, { recursive: true, force: true });
    }
  };
}
