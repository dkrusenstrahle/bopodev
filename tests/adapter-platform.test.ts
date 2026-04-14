import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ExecutionOutcomeSchema } from "../packages/contracts/src/index";
import {
  getAdapterMetadata,
  getAdapterModels,
  resolveAdapter,
  runAdapterEnvironmentTest
} from "../packages/agent-sdk/src/registry";
import { classifyProviderFailure, resolveRuntimeFailureDetail } from "../packages/agent-sdk/src/adapters";

describe("adapter platform contracts", () => {
  it("exposes cursor and opencode in adapter metadata", () => {
    const metadata = getAdapterMetadata();
    expect(metadata.some((entry) => entry.providerType === "cursor")).toBe(true);
    expect(metadata.some((entry) => entry.providerType === "opencode")).toBe(true);
    expect(metadata.some((entry) => entry.providerType === "openai_api")).toBe(true);
    expect(metadata.some((entry) => entry.providerType === "anthropic_api")).toBe(true);
    expect(metadata.some((entry) => entry.providerType === "hermes_local")).toBe(true);
    expect(metadata.some((entry) => entry.providerType === "openclaw_gateway")).toBe(true);
  });

  it("lists no catalog models for OpenClaw Gateway adapter", async () => {
    const models = await getAdapterModels("openclaw_gateway");
    expect(models).toEqual([]);
  });

  it("lists Hermes catalog model options", async () => {
    const models = await getAdapterModels("hermes_local");
    expect(models).toEqual([{ id: "auto", label: "Auto" }]);
  });

  it("surfaces missing-key preflight checks for direct API adapters", async () => {
    const openai = await runAdapterEnvironmentTest("openai_api", {
      env: {}
    });
    expect(openai.status).toBe("fail");
    expect(openai.checks.some((check) => check.code === "api_key_missing")).toBe(true);

    const anthropic = await runAdapterEnvironmentTest("anthropic_api", {
      env: {}
    });
    expect(anthropic.status).toBe("fail");
    expect(anthropic.checks.some((check) => check.code === "api_key_missing")).toBe(true);
  });

  it("executes OpenAI direct adapter and parses structured usage", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          output_text: "openai-direct-ok",
          usage: {
            input_tokens: 12,
            output_tokens: 4
          }
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );
    const originalFetch = globalThis.fetch;
    vi.stubGlobal("fetch", fetchMock);
    try {
      const adapter = resolveAdapter("openai_api");
      const result = await adapter.execute({
        companyId: "demo-company",
        agentId: "agent-1",
        providerType: "openai_api",
        heartbeatRunId: "run-1",
        company: { name: "Demo Co", mission: null },
        agent: { name: "Demo Agent", role: "Engineer", managerAgentId: null },
        workItems: [{ issueId: "issue-1", projectId: "project-1", title: "Do work" }],
        state: {},
        runtime: {
          env: { OPENAI_API_KEY: "sk-test" },
          model: "gpt-5"
        }
      });
      expect(result.status).toBe("ok");
      expect(result.summary).toContain("openai-direct-ok");
      expect(result.tokenInput).toBe(12);
      expect(result.tokenOutput).toBe(4);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.stubGlobal("fetch", originalFetch);
    }
  });

  it("retries transient direct API failures before succeeding", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { message: "rate limited" } }), {
          status: 429,
          headers: { "content-type": "application/json" }
        })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            output_text: "retry-ok",
            usage: { input_tokens: 2, output_tokens: 1 }
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      );
    const originalFetch = globalThis.fetch;
    vi.stubGlobal("fetch", fetchMock);
    try {
      const adapter = resolveAdapter("openai_api");
      const result = await adapter.execute({
        companyId: "demo-company",
        agentId: "agent-1",
        providerType: "openai_api",
        heartbeatRunId: "run-1",
        company: { name: "Demo Co", mission: null },
        agent: { name: "Demo Agent", role: "Engineer", managerAgentId: null },
        workItems: [{ issueId: "issue-1", projectId: "project-1", title: "Do work" }],
        state: {},
        runtime: {
          env: { OPENAI_API_KEY: "sk-test" },
          retryCount: 1,
          retryBackoffMs: 1
        }
      });
      expect(result.status).toBe("ok");
      expect(result.summary).toContain("retry-ok");
      expect(result.trace?.attemptCount).toBe(2);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.stubGlobal("fetch", originalFetch);
    }
  });

  it("retries transient anthropic direct API failures before succeeding", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { message: "rate limited" } }), {
          status: 429,
          headers: { "content-type": "application/json" }
        })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            content: [{ type: "text", text: "anthropic-retry-ok" }],
            usage: { input_tokens: 7, output_tokens: 3 }
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      );
    const originalFetch = globalThis.fetch;
    vi.stubGlobal("fetch", fetchMock);
    try {
      const adapter = resolveAdapter("anthropic_api");
      const result = await adapter.execute({
        companyId: "demo-company",
        agentId: "agent-1",
        providerType: "anthropic_api",
        heartbeatRunId: "run-1",
        company: { name: "Demo Co", mission: null },
        agent: { name: "Demo Agent", role: "Engineer", managerAgentId: null },
        workItems: [{ issueId: "issue-1", projectId: "project-1", title: "Do work" }],
        state: {},
        runtime: {
          env: { ANTHROPIC_API_KEY: "sk-ant-test" },
          model: "claude-3-5-sonnet-latest",
          retryCount: 1,
          retryBackoffMs: 1
        }
      });
      expect(result.status).toBe("ok");
      expect(result.summary).toContain("anthropic-retry-ok");
      expect(result.trace?.attemptCount).toBe(2);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.stubGlobal("fetch", originalFetch);
    }
  });

  it("returns fallback cursor model options when discovery is unavailable", async () => {
    const models = await getAdapterModels("cursor", {
      command: process.execPath,
      args: ["-e", "process.exit(1)"]
    });
    expect(models.length).toBeGreaterThan(0);
    expect(models.some((entry) => entry.id === "auto")).toBe(true);
  });

  it("runs codex environment test with actionable status", async () => {
    const result = await runAdapterEnvironmentTest("codex", {
      command: process.execPath,
      args: [
        "-e",
        "console.log('{\"summary\":\"hello\",\"tokenInput\":1,\"tokenOutput\":1,\"usdCost\":0.000001}')"
      ],
      cwd: process.cwd()
    });
    expect(["pass", "warn"]).toContain(result.status);
    expect(result.checks.length).toBeGreaterThan(0);
  });

  it("runs cursor environment probe with launch args aligned to execution", async () => {
    const captureDir = await mkdtemp(join(tmpdir(), "bopodev-cursor-probe-"));
    const capturePath = join(captureDir, "capture.json");
    const { command, cleanup } = await createCliShim(
      "cursor",
      [
        "const fs = require('node:fs');",
        "const argv = process.argv.slice(2);",
        "if (argv.includes('--version')) {",
        "  console.log('cursor 1.0.0');",
        "  process.exit(0);",
        "}",
        "if (process.env.CURSOR_CAPTURE_PATH) {",
        "  fs.writeFileSync(process.env.CURSOR_CAPTURE_PATH, JSON.stringify({ argv, prompt: fs.readFileSync(0, 'utf8') }), 'utf8');",
        "}",
        "console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'output_text', text: 'probe-ok' }] } }));",
        "console.log(JSON.stringify({ type: 'result', subtype: 'success', session_id: 'probe-session', usage: { input_tokens: 1, output_tokens: 1 } }));"
      ].join("\n")
    );
    const result = await runAdapterEnvironmentTest("cursor", {
      command,
      cwd: process.cwd(),
      env: { CURSOR_CAPTURE_PATH: capturePath }
    });
    const capture = JSON.parse(await readFile(capturePath, "utf8")) as { argv: string[]; prompt: string };
    await cleanup();
    await rm(captureDir, { recursive: true, force: true });
    expect(result.status).toBe("pass");
    expect(capture.argv).toContain("agent");
    expect(capture.argv).toContain("--output-format");
    expect(capture.argv).toContain("stream-json");
    expect(capture.argv).toContain("--workspace");
    expect(capture.prompt).toContain("Respond with hello.");
  });

  it("emits execution outcomes that conform to schema", async () => {
    const adapter = resolveAdapter("shell");
    const result = await adapter.execute({
      companyId: "demo-company",
      agentId: "agent-1",
      providerType: "shell",
      heartbeatRunId: "run-1",
      company: { name: "Demo Co", mission: null },
      agent: { name: "Demo Agent", role: "Engineer", managerAgentId: null },
      workItems: [{ issueId: "issue-1", projectId: "project-1", title: "Do work" }],
      state: {},
      runtime: {}
    });
    const parsed = ExecutionOutcomeSchema.safeParse(result.outcome);
    expect(parsed.success).toBe(true);
  });

  it("returns actionable spawn error detail instead of unknown error", async () => {
    const adapter = resolveAdapter("claude_code");
    const result = await adapter.execute({
      companyId: "demo-company",
      agentId: "agent-1",
      providerType: "claude_code",
      heartbeatRunId: "run-1",
      company: { name: "Demo Co", mission: null },
      agent: { name: "Demo Agent", role: "Engineer", managerAgentId: null },
      workItems: [{ issueId: "issue-1", projectId: "project-1", title: "Do work" }],
      state: {},
      runtime: {
        command: "definitely-not-real-claude-command"
      }
    });
    expect(result.status).toBe("failed");
    expect(result.summary.toLowerCase()).toContain("spawn");
    expect(result.summary).not.toContain("unknown error");
  });

  it("extracts concise detail from JSON stderr system errors", () => {
    const detail = resolveRuntimeFailureDetail({
      stderr: `{"detail":"The 'claude-haiku-4-5' model is not supported when using Codex with a ChatGPT account."}`,
      stdout: "",
      code: 1,
      failureType: "nonzero_exit",
      attempts: [{ spawnErrorCode: undefined }]
    });
    expect(detail).toBe("The 'claude-haiku-4-5' model is not supported when using Codex with a ChatGPT account.");
  });

  it("extracts nested JSON error message when stderr contains an error object", () => {
    const detail = resolveRuntimeFailureDetail({
      stderr: `{"error":{"message":"Model unavailable for this account tier."}}`,
      stdout: "",
      code: 1,
      failureType: "nonzero_exit",
      attempts: [{ spawnErrorCode: undefined }]
    });
    expect(detail).toBe("Model unavailable for this account tier.");
  });

  it("normalizes codex model support errors into actionable guidance", () => {
    const detail = resolveRuntimeFailureDetail(
      {
        stderr: `{"detail":"The 'claude-haiku-4-5' model is not supported when using Codex with a ChatGPT account."}`,
        stdout: "",
        code: 1,
        failureType: "nonzero_exit",
        attempts: [{ spawnErrorCode: undefined }]
      },
      "codex"
    );
    expect(detail).toBe("Codex model not supported for this ChatGPT account. Select a supported Codex model.");
  });

  it("classifies codex unsupported model as non-retryable", () => {
    const failure = classifyProviderFailure("codex", {
      detail: "The 'claude-haiku-4-5' model is not supported when using Codex with a ChatGPT account.",
      failureType: "nonzero_exit"
    });
    expect(failure.blockerCode).toBe("model_not_supported");
    expect(failure.retryable).toBe(false);
  });

  it("classifies claude login-required errors as auth_required", () => {
    const failure = classifyProviderFailure("claude_code", {
      detail: "Not logged in. Please run `claude login`.",
      failureType: "nonzero_exit"
    });
    expect(failure.blockerCode).toBe("auth_required");
    expect(failure.retryable).toBe(false);
  });

  it("keeps transient rate limits retryable when no hard quota lockout", () => {
    const failure = classifyProviderFailure("openai_api", {
      detail: "Rate limit exceeded, please retry shortly.",
      failureType: "rate_limit"
    });
    expect(failure.retryable).toBe(true);
    expect(failure.providerUsageLimited).toBe(false);
  });

  it("fails successful runtimes that do not emit structured heartbeat output", async () => {
    const adapter = resolveAdapter("codex");
    const result = await adapter.execute({
      companyId: "demo-company",
      agentId: "agent-1",
      providerType: "codex",
      heartbeatRunId: "run-1",
      company: { name: "Demo Co", mission: null },
      agent: { name: "Demo Agent", role: "Engineer", managerAgentId: null },
      workItems: [{ issueId: "issue-1", projectId: "project-1", title: "Do work" }],
      state: {},
      runtime: {
        command: process.execPath,
        args: ["-e", ""]
      }
    });
    expect(result.status).toBe("failed");
    expect(result.summary).toContain("without structured heartbeat JSON output");
  });

  it("parses multiline JSON usage payloads from runtime output", async () => {
    const adapter = resolveAdapter("codex");
    const result = await adapter.execute({
      companyId: "demo-company",
      agentId: "agent-1",
      providerType: "codex",
      heartbeatRunId: "run-1",
      company: { name: "Demo Co", mission: null },
      agent: { name: "Demo Agent", role: "Engineer", managerAgentId: null },
      workItems: [{ issueId: "issue-1", projectId: "project-1", title: "Do work" }],
      state: {},
      runtime: {
        command: process.execPath,
        args: [
          "-e",
          "console.log(JSON.stringify({ summary: 'multiline-ok', tokenInput: 3, tokenOutput: 2, usdCost: 0.00001 }, null, 2));"
        ]
      }
    });
    expect(result.status).toBe("ok");
    expect(result.summary).toContain("multiline-ok");
  });

  it("parses claude structured output when logs surround final JSON", async () => {
    const { command, cleanup } = await createCliShim(
      "claude",
      "console.log('progress'); console.log('{\"summary\":\"claude-mixed-ok\",\"tokenInput\":4,\"tokenOutput\":6,\"usdCost\":0.0002}'); console.log('done');"
    );
    const adapter = resolveAdapter("claude_code");
    const result = await adapter.execute({
      companyId: "demo-company",
      agentId: "agent-1",
      providerType: "claude_code",
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
    expect(result.summary).toContain("claude-mixed-ok");
  });

  it("fails claude success responses that only emit malformed JSON", async () => {
    const { command, cleanup } = await createCliShim("claude", "console.log('{\"summary\":\"broken\"')");
    const adapter = resolveAdapter("claude_code");
    const result = await adapter.execute({
      companyId: "demo-company",
      agentId: "agent-1",
      providerType: "claude_code",
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
    expect(result.status).toBe("failed");
    expect(result.summary).toContain("without structured heartbeat output");
  });

  it("includes Claude command diagnostics when runtime override bypasses Claude CLI flags", async () => {
    const { command, cleanup } = await createCliShim("wrapper", "console.log('no-json')");
    const adapter = resolveAdapter("claude_code");
    const result = await adapter.execute({
      companyId: "demo-company",
      agentId: "agent-1",
      providerType: "claude_code",
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
    expect(result.status).toBe("failed");
    expect(result.summary).toContain("runtimeCommand override does not look like Claude CLI");
    expect(result.summary).toContain("missing Claude structured-output args");
  });

  it("marks claude max-turns stream results as incomplete", async () => {
    const { command, cleanup } = await createCliShim(
      "claude",
      "console.log('{\"type\":\"result\",\"result\":\"Now let me create the operating files:\",\"stop_reason\":\"max_turns\",\"usage\":{\"input_tokens\":10,\"output_tokens\":5},\"total_cost_usd\":0.0001}')"
    );
    const adapter = resolveAdapter("claude_code");
    const result = await adapter.execute({
      companyId: "demo-company",
      agentId: "agent-1",
      providerType: "claude_code",
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
    expect(result.status).toBe("failed");
    expect(result.summary).toContain("Now let me create the operating files:");
  });

  it("parses cursor stream-json output and records session details", async () => {
    const { command, cleanup } = await createCliShim(
      "cursor",
      [
        "const argv = process.argv.slice(2);",
        "if (argv.includes('--version')) {",
        "  console.log('cursor 1.0.0');",
        "  process.exit(0);",
        "}",
        "console.log('stdout' + JSON.stringify({ type: 'system', subtype: 'init', session_id: 'chat_prefixed', model: 'auto' }));",
        "console.log('stdout' + JSON.stringify({ type: 'assistant', message: { content: [{ type: 'output_text', text: 'cursor-ok' }] } }));",
        "console.log('stdout' + JSON.stringify({ type: 'result', subtype: 'success', usage: { input_tokens: 3, cached_input_tokens: 1, output_tokens: 2 }, total_cost_usd: 0.0001 }));"
      ].join("\n")
    );
    const adapter = resolveAdapter("cursor");
    const result = await adapter.execute({
      companyId: "demo-company",
      agentId: "agent-1",
      providerType: "cursor",
      heartbeatRunId: "run-1",
      company: { name: "Demo Co", mission: null },
      agent: { name: "Demo Agent", role: "Engineer", managerAgentId: null },
      workItems: [{ issueId: "issue-1", projectId: "project-1", title: "Do work" }],
      state: {},
      runtime: {
        command,
        cwd: process.cwd()
      }
    });
    await cleanup();
    expect(result.status).toBe("ok");
    expect(result.summary).toContain("cursor-ok");
    expect(result.tokenInput).toBe(4);
    expect(result.trace?.session?.currentSessionId).toBe("chat_prefixed");
    expect(result.nextState?.cursorSession?.sessionId).toBe("chat_prefixed");
  });

  it("skips cursor resume when saved session cwd does not match", async () => {
    const captureDir = await mkdtemp(join(tmpdir(), "bopodev-cursor-resume-skip-"));
    const capturePath = join(captureDir, "capture.json");
    const { command, cleanup } = await createCliShim(
      "cursor",
      [
        "const fs = require('node:fs');",
        "const argv = process.argv.slice(2);",
        "if (argv.includes('--version')) {",
        "  console.log('cursor 1.0.0');",
        "  process.exit(0);",
        "}",
        "if (process.env.CURSOR_CAPTURE_PATH) {",
        "  fs.writeFileSync(process.env.CURSOR_CAPTURE_PATH, JSON.stringify({ argv }), 'utf8');",
        "}",
        "console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'output_text', text: 'fresh-session' }] } }));",
        "console.log(JSON.stringify({ type: 'result', subtype: 'success', session_id: 'fresh-session-id', usage: { input_tokens: 1, output_tokens: 1 } }));"
      ].join("\n")
    );
    const adapter = resolveAdapter("cursor");
    const result = await adapter.execute({
      companyId: "demo-company",
      agentId: "agent-1",
      providerType: "cursor",
      heartbeatRunId: "run-1",
      company: { name: "Demo Co", mission: null },
      agent: { name: "Demo Agent", role: "Engineer", managerAgentId: null },
      workItems: [{ issueId: "issue-1", projectId: "project-1", title: "Do work" }],
      state: {
        sessionId: "stale-session",
        cursorSession: {
          sessionId: "stale-session",
          cwd: "/tmp/other-workspace"
        }
      },
      runtime: {
        command,
        cwd: process.cwd(),
        env: { CURSOR_CAPTURE_PATH: capturePath }
      }
    });
    const capture = JSON.parse(await readFile(capturePath, "utf8")) as { argv: string[] };
    await cleanup();
    await rm(captureDir, { recursive: true, force: true });
    expect(result.status).toBe("ok");
    expect(capture.argv).not.toContain("--resume");
    expect(result.trace?.session?.resumeSkippedReason).toBe("cwd_mismatch");
    expect(result.nextState?.cursorSession?.sessionId).toBe("fresh-session-id");
  });

  it("clears stale cursor session after unknown-session retry without a fresh session id", async () => {
    const { command, cleanup } = await createCliShim(
      "cursor",
      [
        "const argv = process.argv.slice(2);",
        "if (argv.includes('--version')) {",
        "  console.log('cursor 1.0.0');",
        "  process.exit(0);",
        "}",
        "const resumeIndex = argv.indexOf('--resume');",
        "if (resumeIndex >= 0) {",
        "  process.stderr.write(`unknown session id ${argv[resumeIndex + 1]}`);",
        "  process.exit(1);",
        "}",
        "console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'output_text', text: 'fresh-run-no-session' }] } }));",
        "console.log(JSON.stringify({ type: 'result', subtype: 'success', usage: { input_tokens: 2, output_tokens: 1 } }));"
      ].join("\n")
    );
    const adapter = resolveAdapter("cursor");
    const result = await adapter.execute({
      companyId: "demo-company",
      agentId: "agent-1",
      providerType: "cursor",
      heartbeatRunId: "run-1",
      company: { name: "Demo Co", mission: null },
      agent: { name: "Demo Agent", role: "Engineer", managerAgentId: null },
      workItems: [{ issueId: "issue-1", projectId: "project-1", title: "Do work" }],
      state: {
        sessionId: "stale-session",
        cursorSession: {
          sessionId: "stale-session",
          cwd: process.cwd()
        }
      },
      runtime: {
        command,
        cwd: process.cwd()
      }
    });
    await cleanup();
    expect(result.status).toBe("ok");
    expect(result.trace?.session?.resumeAttempted).toBe(true);
    expect(result.trace?.session?.clearedStaleSession).toBe(true);
    expect(result.nextState?.sessionId).toBeUndefined();
    expect(result.nextState?.cursorSession).toBeUndefined();
  });

  it("retries gemini without resume when saved session is unknown", async () => {
    const captureDir = await mkdtemp(join(tmpdir(), "bopodev-gemini-retry-"));
    const capturePath = join(captureDir, "capture.json");
    const { command, cleanup } = await createCliShim(
      "gemini",
      [
        "const fs = require('node:fs');",
        "const argv = process.argv.slice(2);",
        "const capturePath = process.env.GEMINI_CAPTURE_PATH;",
        "const existing = capturePath && fs.existsSync(capturePath) ? JSON.parse(fs.readFileSync(capturePath, 'utf8')) : { calls: [] };",
        "existing.calls.push(argv);",
        "if (capturePath) { fs.writeFileSync(capturePath, JSON.stringify(existing), 'utf8'); }",
        "if (argv.includes('--resume')) {",
        "  process.stderr.write('unknown session id stale-session');",
        "  process.exit(1);",
        "}",
        "console.log(JSON.stringify({ type: 'assistant', content: [{ type: 'text', text: 'gemini-retry-ok' }] }));",
        "console.log(JSON.stringify({ type: 'final', usage: { input_tokens: 2, output_tokens: 1 } }));"
      ].join("\n")
    );
    const adapter = resolveAdapter("gemini_cli");
    const result = await adapter.execute({
      companyId: "demo-company",
      agentId: "agent-1",
      providerType: "gemini_cli",
      heartbeatRunId: "run-1",
      company: { name: "Demo Co", mission: null },
      agent: { name: "Demo Agent", role: "Engineer", managerAgentId: null },
      workItems: [{ issueId: "issue-1", projectId: "project-1", title: "Do work" }],
      state: {
        sessionId: "stale-session",
        cwd: process.cwd()
      },
      runtime: {
        command,
        cwd: process.cwd(),
        env: { GEMINI_CAPTURE_PATH: capturePath },
        model: "gemini-2.5-pro"
      }
    });
    const capture = JSON.parse(await readFile(capturePath, "utf8")) as { calls: string[][] };
    await cleanup();
    await rm(captureDir, { recursive: true, force: true });
    expect(result.status).toBe("ok");
    expect(result.trace?.session?.resumeAttempted).toBe(true);
    expect(result.trace?.session?.clearedStaleSession).toBe(true);
    expect(capture.calls.length).toBe(2);
    expect(capture.calls[0]).toContain("--resume");
    expect(capture.calls[1]).not.toContain("--resume");
    expect(result.pricingProviderType).toBe("gemini_api");
    expect(result.pricingModelId).toBe("gemini-2.5-pro");
  });

  it("retries codex without stale resume args after unknown-session failure", async () => {
    const captureDir = await mkdtemp(join(tmpdir(), "bopodev-codex-retry-"));
    const capturePath = join(captureDir, "capture.json");
    const { command, cleanup } = await createCliShim(
      "codex",
      [
        "const fs = require('node:fs');",
        "const argv = process.argv.slice(2);",
        "const capturePath = process.env.CODEX_CAPTURE_PATH;",
        "const existing = capturePath && fs.existsSync(capturePath) ? JSON.parse(fs.readFileSync(capturePath, 'utf8')) : { calls: [] };",
        "existing.calls.push(argv);",
        "if (capturePath) { fs.writeFileSync(capturePath, JSON.stringify(existing), 'utf8'); }",
        "if (argv.includes('--resume')) {",
        "  process.stderr.write('unknown session id stale-session');",
        "  process.exit(1);",
        "}",
        "console.log(JSON.stringify({ summary: 'codex-retry-ok', tokenInput: 2, tokenOutput: 1, usdCost: 0.00001 }));"
      ].join("\n")
    );
    const adapter = resolveAdapter("codex");
    const result = await adapter.execute({
      companyId: "demo-company",
      agentId: "agent-1",
      providerType: "codex",
      heartbeatRunId: "run-1",
      company: { name: "Demo Co", mission: null },
      agent: { name: "Demo Agent", role: "Engineer", managerAgentId: null },
      workItems: [{ issueId: "issue-1", projectId: "project-1", title: "Do work" }],
      state: {},
      runtime: {
        command,
        env: { CODEX_CAPTURE_PATH: capturePath },
        args: ["--resume", "stale-session"]
      }
    });
    const capture = JSON.parse(await readFile(capturePath, "utf8")) as { calls: string[][] };
    await cleanup();
    await rm(captureDir, { recursive: true, force: true });
    expect(capture.calls.length).toBe(2);
    expect(capture.calls[0]).toContain("--resume");
    expect(capture.calls[1]).not.toContain("--resume");
    expect(result.status).toBe("ok");
  });

  it("includes opencode session argument and maps upstream pricing identity", async () => {
    const captureDir = await mkdtemp(join(tmpdir(), "bopodev-opencode-retry-"));
    const capturePath = join(captureDir, "capture.json");
    const { command, cleanup } = await createCliShim(
      "opencode",
      [
        "const fs = require('node:fs');",
        "const argv = process.argv.slice(2);",
        "if (argv.includes('models')) {",
        "  console.log(JSON.stringify(['openai/gpt-5']));",
        "  process.exit(0);",
        "}",
        "const capturePath = process.env.OPENCODE_CAPTURE_PATH;",
        "const existing = capturePath && fs.existsSync(capturePath) ? JSON.parse(fs.readFileSync(capturePath, 'utf8')) : { calls: [] };",
        "existing.calls.push(argv);",
        "if (capturePath) { fs.writeFileSync(capturePath, JSON.stringify(existing), 'utf8'); }",
        "console.log(JSON.stringify({ summary: 'opencode-retry-ok', tokenInput: 2, tokenOutput: 2, usdCost: 0.00001, sessionId: 'fresh-opencode-session' }));"
      ].join("\n")
    );
    const adapter = resolveAdapter("opencode");
    const result = await adapter.execute({
      companyId: "demo-company",
      agentId: "agent-1",
      providerType: "opencode",
      heartbeatRunId: "run-1",
      company: { name: "Demo Co", mission: null },
      agent: { name: "Demo Agent", role: "Engineer", managerAgentId: null },
      workItems: [{ issueId: "issue-1", projectId: "project-1", title: "Do work" }],
      state: {
        sessionId: "stale-session"
      },
      runtime: {
        command,
        env: { OPENCODE_CAPTURE_PATH: capturePath },
        model: "openai/gpt-5"
      }
    });
    const capture = JSON.parse(await readFile(capturePath, "utf8")) as { calls: string[][] };
    await cleanup();
    await rm(captureDir, { recursive: true, force: true });
    expect(result.status).toBe("ok");
    expect(capture.calls.length).toBe(1);
    expect(capture.calls[0]).toContain("--session");
    expect(result.pricingProviderType).toBe("openai_api");
    expect(result.pricingModelId).toBe("gpt-5");
  });
});

async function createCliShim(binaryName: string, scriptBody: string) {
  const tempDir = await mkdtemp(join(tmpdir(), "bopodev-adapter-shim-"));
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
