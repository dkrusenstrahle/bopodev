import { access } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  getAdapterMetadata,
  getRegisteredAdapterModules,
  runAdapterEnvironmentTest
} from "../packages/agent-sdk/src/registry";
import { parseStructuredUsage } from "../packages/agent-sdk/src/runtime-parsers";

describe("adapter module contracts", () => {
  it("registers a module for every metadata provider type", () => {
    const modules = getRegisteredAdapterModules();
    const metadata = getAdapterMetadata();
    for (const entry of metadata) {
      const module = modules[entry.providerType];
      expect(module).toBeDefined();
      expect(module.type).toBe(entry.providerType);
      expect(module.server.type).toBe(entry.providerType);
      expect(module.metadata.providerType).toBe(entry.providerType);
      expect(typeof module.server.execute).toBe("function");
      if (entry.supportsModelSelection) {
        expect(typeof module.server.listModels).toBe("function");
      }
      if (entry.supportsEnvironmentTest) {
        expect(typeof module.server.testEnvironment).toBe("function");
      }
    }
  });

  it("keeps the package-local adapter file structure in place", async () => {
    const adapterDirs = [
      "codex",
      "claude-code",
      "cursor",
      "gemini-cli",
      "opencode",
      "openai-api",
      "anthropic-api",
      "http",
      "shell"
    ];
    const requiredFiles = [
      "src/index.ts",
      "src/server/index.ts",
      "src/server/execute.ts",
      "src/server/parse.ts",
      "src/server/test.ts",
      "src/ui/index.ts",
      "src/ui/parse-stdout.ts",
      "src/ui/build-config.ts",
      "src/cli/index.ts",
      "src/cli/format-event.ts"
    ];
    for (const adapterDir of adapterDirs) {
      for (const requiredFile of requiredFiles) {
        await expect(
          access(join(process.cwd(), "packages", "adapters", adapterDir, requiredFile))
        ).resolves.toBeUndefined();
      }
    }
  });

  it("keeps environment test contract stable for providers", async () => {
    const metadata = getAdapterMetadata();
    const modules = getRegisteredAdapterModules();
    for (const entry of metadata) {
      if (!entry.supportsEnvironmentTest) {
        continue;
      }
      const module = modules[entry.providerType];
      expect(typeof module.server.testEnvironment).toBe("function");
      const result = await runAdapterEnvironmentTest(entry.providerType, {
        command: process.execPath,
        args: ["-e", "console.log('ok')"],
        cwd: process.cwd(),
        timeoutMs: 2_000
      });
      expect(result.providerType).toBe(entry.providerType);
      expect(["pass", "warn", "fail"]).toContain(result.status);
      expect(Array.isArray(result.checks)).toBe(true);
      expect(result.checks.every((check) => ["info", "warn", "error"].includes(check.level))).toBe(true);
    }
  });

  it("keeps listModels contract stable for providers with model selection", async () => {
    const metadata = getAdapterMetadata();
    const modules = getRegisteredAdapterModules();
    for (const entry of metadata) {
      if (!entry.supportsModelSelection) {
        continue;
      }
      const listModels = modules[entry.providerType].server.listModels;
      expect(typeof listModels).toBe("function");
      const models = await listModels?.({
        command: process.execPath,
        args: ["-e", "console.log('ok')"],
        cwd: process.cwd(),
        timeoutMs: 2_000
      });
      expect(Array.isArray(models)).toBe(true);
      if (models && models.length > 0) {
        expect(models.every((model) => Boolean(model.id) && Boolean(model.label))).toBe(true);
      }
    }
  });

  it("parses structured usage fixtures from multiline payloads", () => {
    const usage = parseStructuredUsage(
      [
        "log noise",
        "{",
        '  "summary": "fixture-ok",',
        '  "tokenInput": 8,',
        '  "tokenOutput": 3,',
        '  "usdCost": 0.00002',
        "}"
      ].join("\n")
    );
    expect(usage?.summary).toBe("fixture-ok");
    expect(usage?.tokenInput).toBe(8);
    expect(usage?.tokenOutput).toBe(3);
  });
});
