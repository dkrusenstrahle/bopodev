import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectSuspiciousWorkspaceDirectories, runDoctorChecks } from "../packages/cli/src/lib/checks";

describe("doctor checks", () => {
  const cleanupPaths: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanupPaths.map((path) => rm(path, { recursive: true, force: true })));
    cleanupPaths.length = 0;
  });

  it("includes both codex and opencode runtime checks", { timeout: 15_000 }, async () => {
    const checks = await runDoctorChecks();
    const labels = checks.map((check) => check.label);
    expect(labels).toContain("Codex runtime");
    expect(labels).toContain("OpenCode runtime");
  });

  it("reports invalid BOPO_INSTANCE_ID as a failed path configuration check", { timeout: 15_000 }, async () => {
    const previous = process.env.BOPO_INSTANCE_ID;
    process.env.BOPO_INSTANCE_ID = "invalid/path";
    try {
      const checks = await runDoctorChecks();
      const configCheck = checks.find((check) => check.label === "Instance path configuration");
      expect(configCheck).toBeDefined();
      expect(configCheck?.ok).toBe(false);
      expect(configCheck?.details).toContain("Invalid BOPO_INSTANCE_ID");
    } finally {
      if (previous === undefined) {
        delete process.env.BOPO_INSTANCE_ID;
      } else {
        process.env.BOPO_INSTANCE_ID = previous;
      }
    }
  });

  it("detects suspicious workspace-like directories outside managed root", async () => {
    const testRoot = await mkdtemp(join(tmpdir(), "bopodev-doctor-checks-"));
    cleanupPaths.push(testRoot);
    await mkdir(join(testRoot, "relative", "path"), { recursive: true });
    const suspicious = await detectSuspiciousWorkspaceDirectories(testRoot);
    expect(suspicious.some((entry) => entry.endsWith("/relative"))).toBe(true);
  });
});
