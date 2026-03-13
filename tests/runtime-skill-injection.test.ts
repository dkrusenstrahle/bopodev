import { access, chmod, lstat, mkdir, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { checkRuntimeCommandHealth, executeAgentRuntime, executePromptRuntime } from "../packages/agent-sdk/src/runtime";

describe("agent runtime skill injection", () => {
  it("injects skills into CODEX_HOME/skills without overwriting existing entries", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "bopodev-codex-home-"));
    const existingSkillDir = join(codexHome, "skills", "bopodev-control-plane");
    await mkdir(existingSkillDir, { recursive: true });
    await writeFile(join(existingSkillDir, "custom.txt"), "keep-me", "utf8");

    const run = await executeAgentRuntime("codex", "test prompt", {
      command: process.execPath,
      args: ["-e", "console.log('ok')"],
      env: { CODEX_HOME: codexHome }
    });

    expect(run.ok).toBe(true);

    const expectedSkills = ["bopodev-control-plane", "bopodev-create-agent", "para-memory-files"];
    for (const skillName of expectedSkills) {
      const skillPath = join(codexHome, "skills", skillName);
      await expect(access(skillPath)).resolves.toBeUndefined();
    }

    // Existing custom skill folder should remain untouched and not be replaced.
    const bopodevStats = await lstat(existingSkillDir);
    expect(bopodevStats.isSymbolicLink()).toBe(false);
    await expect(access(join(existingSkillDir, "custom.txt"))).resolves.toBeUndefined();

    const createdLink = join(codexHome, "skills", "bopodev-create-agent");
    const linkStats = await lstat(createdLink);
    expect(linkStats.isSymbolicLink()).toBe(true);
    const linkTarget = await readlink(createdLink);
    expect(linkTarget.length).toBeGreaterThan(0);

    await rm(codexHome, { recursive: true, force: true });
  });

  it("adds a temporary --add-dir for claude_code and removes it after execution", async () => {
    const run = await executeAgentRuntime("claude_code", "prompt payload", {
      command: process.execPath,
      args: ["-e", "console.log(JSON.stringify(process.argv))", "--"]
    });

    expect(run.ok).toBe(true);
    const argv = JSON.parse(run.stdout.trim()) as string[];
    const addDirIndex = argv.indexOf("--add-dir");
    expect(addDirIndex).toBeGreaterThan(-1);
    const tempSkillsRoot = argv[addDirIndex + 1];
    expect(tempSkillsRoot).toBeTruthy();
    if (!tempSkillsRoot) {
      throw new Error("Missing temporary skills directory argument.");
    }
    expect(tempSkillsRoot).toContain("bopodev-skills-");

    // Runtime should clean temporary mount after command exits.
    await expect(access(tempSkillsRoot)).rejects.toBeTruthy();
  });

  it("keeps Claude structured-output args when command override still points to claude", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "bopodev-claude-bin-"));
    const claudeShim = join(tempDir, "claude");
    await writeFile(
      claudeShim,
      "#!/usr/bin/env node\nconsole.log(JSON.stringify(process.argv.slice(2)))\n",
      "utf8"
    );
    await chmod(claudeShim, 0o755);

    const run = await executeAgentRuntime("claude_code", "shim prompt", {
      command: claudeShim
    });

    expect(run.ok).toBe(true);
    const argv = JSON.parse(run.stdout.trim()) as string[];
    expect(argv).toContain("--print");
    expect(argv).toContain("-");
    expect(argv).toContain("--output-format");
    expect(argv).toContain("stream-json");
    expect(argv).toContain("--verbose");
    expect(argv).toContain("--max-turns");
    expect(argv).toContain("8");
    expect(run.structuredOutputDiagnostics?.claudeContract?.missingRequiredArgs).toEqual([]);

    await rm(tempDir, { recursive: true, force: true });
  });

  it("captures claude contract diagnostics when runtime command override is not Claude CLI", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "bopodev-claude-wrapper-bin-"));
    const wrapper = join(tempDir, "wrapper");
    await writeFile(
      wrapper,
      "#!/usr/bin/env node\nconsole.log('plain-text-output')\n",
      "utf8"
    );
    await chmod(wrapper, 0o755);

    const run = await executeAgentRuntime("claude_code", "shim prompt", {
      command: wrapper
    });

    expect(run.ok).toBe(true);
    expect(run.parsedUsage).toBeUndefined();
    expect(run.structuredOutputDiagnostics?.claudeContract?.commandLooksClaude).toBe(false);
    expect(run.structuredOutputDiagnostics?.claudeContract?.missingRequiredArgs).toContain("--print -");
    expect(run.structuredOutputDiagnostics?.claudeContract?.missingRequiredArgs).toContain("--output-format stream-json");

    await rm(tempDir, { recursive: true, force: true });
  });

  it("normalizes runtime command alias claude_code to claude binary", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "bopodev-claude-alias-bin-"));
    const claudeShim = join(tempDir, "claude");
    await writeFile(
      claudeShim,
      "#!/usr/bin/env node\nconsole.log('{\"summary\":\"alias-ok\",\"tokenInput\":1,\"tokenOutput\":1,\"usdCost\":0.00001}')\n",
      "utf8"
    );
    await chmod(claudeShim, 0o755);

    const run = await executeAgentRuntime("claude_code", "shim prompt", {
      command: "claude_code",
      env: {
        PATH: `${tempDir}:${process.env.PATH ?? ""}`
      }
    });

    expect(run.ok).toBe(true);
    expect(run.parsedUsage?.summary).toBe("alias-ok");
    expect(run.structuredOutputDiagnostics?.claudeContract?.commandLooksClaude).toBe(true);

    await rm(tempDir, { recursive: true, force: true });
  });

  it("resolves default claude command from HOME .local/bin when PATH is missing", async () => {
    const fakeHome = await mkdtemp(join(tmpdir(), "bopodev-claude-home-"));
    const localBin = join(fakeHome, ".local", "bin");
    await mkdir(localBin, { recursive: true });
    const claudeShim = join(localBin, "claude");
    await writeFile(
      claudeShim,
      `#!/bin/sh\nexec "${process.execPath}" -e "console.log('{\\"summary\\":\\"home-bin-ok\\",\\"tokenInput\\":1,\\"tokenOutput\\":1,\\"usdCost\\":0.00001}')" "$@"\n`,
      "utf8"
    );
    await chmod(claudeShim, 0o755);

    const run = await executeAgentRuntime("claude_code", "shim prompt", {
      env: {
        HOME: fakeHome,
        PATH: ""
      }
    });

    expect(run.ok).toBe(true);
    expect(run.parsedUsage?.summary).toBe("home-bin-ok");
    expect(run.commandUsed).toBe(claudeShim);

    await rm(fakeHome, { recursive: true, force: true });
  });

  it("resolves claude health checks from HOME .local/bin when PATH is missing", async () => {
    const fakeHome = await mkdtemp(join(tmpdir(), "bopodev-claude-health-home-"));
    const localBin = join(fakeHome, ".local", "bin");
    await mkdir(localBin, { recursive: true });
    const claudeShim = join(localBin, "claude");
    await writeFile(claudeShim, "#!/bin/sh\necho 'claude 9.9.9'\n", "utf8");
    await chmod(claudeShim, 0o755);

    const health = await checkRuntimeCommandHealth("claude", {
      timeoutMs: 2_000,
      env: {
        HOME: fakeHome,
        PATH: ""
      }
    });

    expect(health.available).toBe(true);
    expect(health.command).toBe(claudeShim);

    await rm(fakeHome, { recursive: true, force: true });
  });

  it("does not inject skills when provider-specific execution is not used", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "bopodev-no-provider-"));

    const run = await executePromptRuntime(process.execPath, "prompt payload", {
      args: ["-e", "console.log('ok')"],
      env: { CODEX_HOME: codexHome }
    });

    expect(run.ok).toBe(true);
    await expect(access(join(codexHome, "skills"))).rejects.toBeTruthy();

    await rm(codexHome, { recursive: true, force: true });
  });

  it("marks timeout failures and captures forced termination metadata", async () => {
    const run = await executePromptRuntime(process.execPath, "timeout payload", {
      args: ["-e", "setInterval(() => {}, 1000)"],
      timeoutMs: 50
    });

    expect(run.ok).toBe(false);
    expect(run.timedOut).toBe(true);
    expect(run.failureType).toBe("timeout");
    expect(run.attemptCount).toBe(1);
    expect(run.attempts[0]?.timedOut).toBe(true);
  });

  it("classifies missing binaries as spawn errors without retry loops", async () => {
    const run = await executePromptRuntime("definitely-not-a-real-command-bopodev", "prompt payload");
    expect(run.ok).toBe(false);
    expect(run.failureType).toBe("spawn_error");
    expect(run.attemptCount).toBe(1);
    expect(run.attempts[0]?.spawnErrorCode).toBe("ENOENT");
  });

  it("falls back to token estimation when usage JSON is malformed", async () => {
    const run = await executeAgentRuntime("codex", "payload", {
      command: process.execPath,
      args: ["-e", "console.log('not-json')"]
    });
    expect(run.ok).toBe(true);
    expect(run.parsedUsage).toBeUndefined();
  });

  it("uses full-auto defaults including git trust bypass for codex provider execution", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "bopodev-codex-bin-"));
    const codexShim = join(tempDir, "codex");
    await writeFile(
      codexShim,
      "#!/usr/bin/env node\nconsole.log(JSON.stringify(process.argv.slice(2)))\n",
      "utf8"
    );
    await chmod(codexShim, 0o755);

    const run = await executeAgentRuntime("codex", "shim prompt", {
      env: {
        PATH: `${tempDir}:${process.env.PATH ?? ""}`
      }
    });
    expect(run.ok).toBe(true);
    const argv = JSON.parse(run.stdout.trim()) as string[];
    expect(argv).toContain("exec");
    expect(argv).toContain("--full-auto");
    expect(argv).toContain("--skip-git-repo-check");
    expect(argv).toContain("--json");
    expect(argv.at(-1)).toBe("shim prompt");

    await rm(tempDir, { recursive: true, force: true });
  });

  it("bypasses codex sandbox when control-plane env is injected", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "bopodev-codex-control-plane-"));
    const codexShim = join(tempDir, "codex");
    await writeFile(
      codexShim,
      "#!/usr/bin/env node\nconsole.log(JSON.stringify(process.argv.slice(2)))\n",
      "utf8"
    );
    await chmod(codexShim, 0o755);

    const run = await executeAgentRuntime("codex", "shim prompt", {
      env: {
        PATH: `${tempDir}:${process.env.PATH ?? ""}`,
        BOPODEV_API_BASE_URL: "http://127.0.0.1:4020",
        BOPODEV_REQUEST_HEADERS_JSON: "{\"x-company-id\":\"demo\"}"
      }
    });
    expect(run.ok).toBe(true);
    const argv = JSON.parse(run.stdout.trim()) as string[];
    expect(argv).not.toContain("--full-auto");
    expect(argv).toContain("--skip-git-repo-check");
    expect(argv).toContain("--dangerously-bypass-approvals-and-sandbox");

    await rm(tempDir, { recursive: true, force: true });
  });

  it("supports forcing codex sandbox even with control-plane env", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "bopodev-codex-control-plane-enforced-"));
    const codexShim = join(tempDir, "codex");
    await writeFile(
      codexShim,
      "#!/usr/bin/env node\nconsole.log(JSON.stringify(process.argv.slice(2)))\n",
      "utf8"
    );
    await chmod(codexShim, 0o755);

    const run = await executeAgentRuntime("codex", "shim prompt", {
      env: {
        PATH: `${tempDir}:${process.env.PATH ?? ""}`,
        BOPODEV_API_BASE_URL: "http://127.0.0.1:4020",
        BOPODEV_REQUEST_HEADERS_JSON: "{\"x-company-id\":\"demo\"}",
        BOPODEV_ENFORCE_SANDBOX: "true"
      }
    });
    expect(run.ok).toBe(true);
    const argv = JSON.parse(run.stdout.trim()) as string[];
    expect(argv).toContain("--full-auto");
    expect(argv).toContain("--skip-git-repo-check");
    expect(argv).not.toContain("--dangerously-bypass-approvals-and-sandbox");

    await rm(tempDir, { recursive: true, force: true });
  });

  it("keeps codex sandboxed when control-plane headers context is missing", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "bopodev-codex-missing-headers-"));
    const codexShim = join(tempDir, "codex");
    await writeFile(
      codexShim,
      "#!/usr/bin/env node\nconsole.log(JSON.stringify(process.argv.slice(2)))\n",
      "utf8"
    );
    await chmod(codexShim, 0o755);

    const run = await executeAgentRuntime("codex", "shim prompt", {
      env: {
        PATH: `${tempDir}:${process.env.PATH ?? ""}`,
        BOPODEV_API_BASE_URL: "http://127.0.0.1:4020"
      }
    });
    expect(run.ok).toBe(true);
    const argv = JSON.parse(run.stdout.trim()) as string[];
    expect(argv).toContain("--full-auto");
    expect(argv).toContain("--skip-git-repo-check");
    expect(argv).not.toContain("--dangerously-bypass-approvals-and-sandbox");

    await rm(tempDir, { recursive: true, force: true });
  });

  it("retries codex execution once by default when first attempt fails", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "bopodev-codex-retry-"));
    const codexShim = join(tempDir, "codex");
    const marker = join(tempDir, "attempt.marker");
    await writeFile(
      codexShim,
      [
        "#!/usr/bin/env node",
        "const fs = require('node:fs');",
        "const markerPath = process.env.BOPO_RETRY_MARKER;",
        "if (!markerPath) { process.exit(2); }",
        "if (!fs.existsSync(markerPath)) {",
        "  fs.writeFileSync(markerPath, 'first', 'utf8');",
        "  process.stderr.write('first attempt failed\\n');",
        "  process.exit(1);",
        "}",
        "console.log('{\"summary\":\"retry-success\",\"tokenInput\":1,\"tokenOutput\":1,\"usdCost\":0.000001}');"
      ].join("\n"),
      "utf8"
    );
    await chmod(codexShim, 0o755);

    const run = await executeAgentRuntime("codex", "retry prompt", {
      env: {
        PATH: `${tempDir}:${process.env.PATH ?? ""}`,
        BOPO_RETRY_MARKER: marker
      }
    });

    expect(run.ok).toBe(true);
    expect(run.attemptCount).toBe(2);
    expect(run.parsedUsage?.summary).toBe("retry-success");

    await rm(tempDir, { recursive: true, force: true });
  });

  it("parses usage diagnostics from structured JSON footer", async () => {
    const run = await executePromptRuntime(process.execPath, "prompt payload", {
      args: [
        "-e",
        "console.log('{\"summary\":\"ok\",\"tokenInput\":2,\"tokenOutput\":3,\"usdCost\":0.00002}')"
      ]
    });
    expect(run.ok).toBe(true);
    expect(run.parsedUsage?.summary).toBe("ok");
    expect(run.parsedUsage?.tokenInput).toBe(2);
    expect(run.parsedUsage?.tokenOutput).toBe(3);
    expect(run.parsedUsage?.usdCost).toBe(0.00002);
  });

  it("parses summary-only JSON footer for successful runs", async () => {
    const run = await executePromptRuntime(process.execPath, "prompt payload", {
      args: [
        "-e",
        "console.log('{\"summary\":\"completed onboarding and queued hire approval\"}')"
      ]
    });
    expect(run.ok).toBe(true);
    expect(run.parsedUsage?.summary).toBe("completed onboarding and queued hire approval");
    expect(run.parsedUsage?.tokenInput).toBeUndefined();
    expect(run.parsedUsage?.tokenOutput).toBeUndefined();
    expect(run.parsedUsage?.usdCost).toBeUndefined();
  });

  it("prefers stderr metrics when stdout is summary-only", async () => {
    const run = await executePromptRuntime(
      process.execPath,
      "prompt payload",
      {
        args: [
          "-e",
          [
            "console.log('{\"summary\":\"completed work\"}');",
            "console.error('{\"tokenInput\":1234,\"tokenOutput\":567,\"usdCost\":0.00987}');"
          ].join("")
        ]
      },
      { provider: "codex" }
    );

    expect(run.ok).toBe(true);
    expect(run.parsedUsage?.summary).toBe("completed work");
    expect(run.parsedUsage?.tokenInput).toBe(1234);
    expect(run.parsedUsage?.tokenOutput).toBe(567);
    expect(run.parsedUsage?.usdCost).toBe(0.00987);
    expect(run.structuredOutputSource).toBe("stderr");
  });

  it("parses provider-style usage keys from stderr and merges with stdout summary", async () => {
    const run = await executePromptRuntime(
      process.execPath,
      "prompt payload",
      {
        args: [
          "-e",
          [
            "console.log('{\"summary\":\"completed work\"}');",
            "console.error('{\"type\":\"result\",\"usage\":{\"input_tokens\":900,\"cache_read_input_tokens\":100,\"output_tokens\":250},\"total_cost_usd\":0.0042}');"
          ].join("")
        ]
      },
      { provider: "codex" }
    );

    expect(run.ok).toBe(true);
    expect(run.parsedUsage?.summary).toBe("completed work");
    expect(run.parsedUsage?.tokenInput).toBe(1000);
    expect(run.parsedUsage?.tokenOutput).toBe(250);
    expect(run.parsedUsage?.usdCost).toBe(0.0042);
    expect(run.structuredOutputSource).toBe("stderr");
  });

  it("parses structured usage from stderr when stdout has no usage JSON", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "bopodev-claude-stderr-bin-"));
    const wrapper = join(tempDir, "wrapper");
    await writeFile(
      wrapper,
      "#!/usr/bin/env node\nprocess.stderr.write('{\"summary\":\"stderr-usage\",\"tokenInput\":5,\"tokenOutput\":7,\"usdCost\":0.00012}\\n')\n",
      "utf8"
    );
    await chmod(wrapper, 0o755);

    const run = await executeAgentRuntime("claude_code", "prompt payload", {
      command: wrapper
    });
    expect(run.ok).toBe(true);
    expect(run.parsedUsage?.summary).toBe("stderr-usage");
    expect(run.structuredOutputSource).toBe("stderr");
    expect(run.structuredOutputDiagnostics?.stderrStructuredUsageDetected).toBe(true);

    await rm(tempDir, { recursive: true, force: true });
  });

  it("parses Claude stream-json result payloads", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "bopodev-claude-stream-json-"));
    const claudeShim = join(tempDir, "claude");
    await writeFile(
      claudeShim,
      [
        "#!/usr/bin/env node",
        "console.log('{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"Working\"}]}}');",
        "console.log('{\"type\":\"result\",\"result\":\"done\",\"usage\":{\"input_tokens\":12,\"cache_read_input_tokens\":3,\"output_tokens\":7},\"total_cost_usd\":0.00033}');",
      ].join("\n"),
      "utf8"
    );
    await chmod(claudeShim, 0o755);

    const run = await executeAgentRuntime("claude_code", "prompt payload", {
      command: claudeShim,
      args: ["--print", "-", "--output-format", "stream-json"]
    });

    expect(run.ok).toBe(true);
    expect(run.parsedUsage?.summary).toBe("done");
    expect(run.parsedUsage?.tokenInput).toBe(15);
    expect(run.parsedUsage?.tokenOutput).toBe(7);
    expect(run.parsedUsage?.usdCost).toBe(0.00033);

    await rm(tempDir, { recursive: true, force: true });
  });

  it("continues Claude run with --resume when max-turns is reached", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "bopodev-claude-resume-"));
    const claudeShim = join(tempDir, "claude");
    const marker = join(tempDir, "resume.marker");
    await writeFile(
      claudeShim,
      [
        "#!/usr/bin/env node",
        "const fs = require('node:fs');",
        "const args = process.argv.slice(2);",
        "const markerPath = process.env.BOPO_CLAUDE_RESUME_MARKER;",
        "const hasResume = args.includes('--resume');",
        "if (!markerPath) process.exit(2);",
        "if (!hasResume && !fs.existsSync(markerPath)) {",
        "  fs.writeFileSync(markerPath, 'first', 'utf8');",
        "  console.log('{\"type\":\"result\",\"subtype\":\"error_max_turns\",\"stop_reason\":\"max_turns\",\"session_id\":\"sess-1\",\"usage\":{\"input_tokens\":3,\"output_tokens\":2},\"total_cost_usd\":0.00001,\"result\":\"Need more turns\"}');",
        "  process.exit(0);",
        "}",
        "console.log('{\"type\":\"result\",\"session_id\":\"sess-1\",\"usage\":{\"input_tokens\":7,\"output_tokens\":4},\"total_cost_usd\":0.00002,\"result\":\"Completed after resume\"}');",
      ].join("\n"),
      "utf8"
    );
    await chmod(claudeShim, 0o755);

    const run = await executeAgentRuntime("claude_code", "prompt payload", {
      command: claudeShim,
      env: {
        BOPO_CLAUDE_RESUME_MARKER: marker
      }
    });

    expect(run.ok).toBe(true);
    expect(run.parsedUsage?.summary).toBe("Completed after resume");
    expect(run.argsUsed).toContain("--resume");

    await rm(tempDir, { recursive: true, force: true });
  });

  it("treats empty OPENAI_API_KEY as unset for codex execution", async () => {
    const run = await executeAgentRuntime("codex", "probe", {
      command: process.execPath,
      args: ["-e", "console.log(process.env.OPENAI_API_KEY ?? '__missing__')"],
      env: {
        OPENAI_API_KEY: "   "
      }
    });
    expect(run.ok).toBe(true);
    expect(run.stdout.trim()).toBe("__missing__");
  });

  it("uses run-scoped CODEX_HOME for api-key codex runs", async () => {
    const run = await executeAgentRuntime("codex", "probe", {
      command: process.execPath,
      args: ["-e", "console.log(process.env.CODEX_HOME ?? '__missing__')"],
      env: {
        OPENAI_API_KEY: "sk-test-managed",
        BOPODEV_COMPANY_ID: "company-abc",
        BOPODEV_AGENT_ID: "agent-xyz"
      }
    });
    expect(run.ok).toBe(true);
    const runScopedHome = run.stdout.trim();
    expect(runScopedHome).toContain("bopodev-codex-home-run-");
    await expect(access(runScopedHome)).rejects.toBeTruthy();
  });

  it("uses explicit/default CODEX_HOME for session-auth codex runs", async () => {
    const sessionHome = await mkdtemp(join(tmpdir(), "bopodev-codex-session-home-"));
    const run = await executeAgentRuntime("codex", "probe", {
      command: process.execPath,
      args: ["-e", "console.log(process.env.CODEX_HOME ?? '__missing__')"],
      env: {
        CODEX_HOME: sessionHome,
        BOPODEV_COMPANY_ID: "company-sess",
        BOPODEV_AGENT_ID: "agent-sess"
      }
    });
    expect(run.ok).toBe(true);
    expect(run.stdout.trim()).toBe(sessionHome);
    await rm(sessionHome, { recursive: true, force: true });
  });

  it("forces managed CODEX_HOME when heartbeat override is enabled", async () => {
    const explicitHome = await mkdtemp(join(tmpdir(), "bopodev-explicit-codex-home-"));
    const run = await executeAgentRuntime("codex", "probe", {
      command: process.execPath,
      args: ["-e", "console.log(process.env.CODEX_HOME ?? '__missing__')"],
      env: {
        CODEX_HOME: explicitHome,
        BOPODEV_FORCE_MANAGED_CODEX_HOME: "true",
        BOPODEV_COMPANY_ID: "company-force",
        BOPODEV_AGENT_ID: "agent-force"
      }
    });
    expect(run.ok).toBe(true);
    expect(run.stdout.trim()).toContain("bopodev-codex-home/company-force/agent-force");
    expect(run.stdout.trim()).not.toBe(explicitHome);
    await rm(explicitHome, { recursive: true, force: true });
  });
});
