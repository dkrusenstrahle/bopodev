import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertPathInsideCompanyWorkspaceRoot,
  isInsidePath,
  normalizeAbsolutePath,
  normalizeCompanyWorkspacePath,
  resolveCompanyWorkspaceRootPath,
  resolveProjectWorkspacePath
} from "../apps/api/src/lib/instance-paths";

describe("instance path guards", () => {
  const cleanupPaths: string[] = [];
  const originalInstanceRoot = process.env.BOPO_INSTANCE_ROOT;
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(async () => {
    process.env.BOPO_INSTANCE_ROOT = originalInstanceRoot;
    process.env.NODE_ENV = originalNodeEnv;
    await Promise.all(cleanupPaths.map((path) => rm(path, { recursive: true, force: true })));
    cleanupPaths.length = 0;
  });

  it("rejects non-absolute input when absolute paths are required", () => {
    expect(() => normalizeAbsolutePath("relative/path", { requireAbsoluteInput: true })).toThrow(
      "Expected absolute path input"
    );
  });

  it("anchors relative workspace paths to deterministic company root", async () => {
    const root = await mkdtemp(join(tmpdir(), "bopodev-instance-paths-"));
    cleanupPaths.push(root);
    process.env.BOPO_INSTANCE_ROOT = root;
    process.env.NODE_ENV = "development";

    const companyId = "acme";
    const normalized = normalizeCompanyWorkspacePath(companyId, "legacy/relative");
    expect(normalized).toBe(join(resolveCompanyWorkspaceRootPath(companyId), "legacy", "relative"));
  });

  it("rejects workspace paths outside the company root", async () => {
    const root = await mkdtemp(join(tmpdir(), "bopodev-instance-paths-"));
    cleanupPaths.push(root);
    process.env.BOPO_INSTANCE_ROOT = root;
    process.env.NODE_ENV = "development";

    expect(() => assertPathInsideCompanyWorkspaceRoot("acme", join(tmpdir(), "outside"), "workspace")).toThrow(
      "must be inside"
    );
  });

  it("rejects path segments with surrounding whitespace", () => {
    expect(() => resolveProjectWorkspacePath("acme ", "project-1")).toThrow("Invalid companyId");
  });

  it("checks lexical path containment safely", () => {
    expect(isInsidePath("/tmp/workspace", "/tmp/workspace/nested/file.txt")).toBe(true);
    expect(isInsidePath("/tmp/workspace", "/tmp/workspace-evil/file.txt")).toBe(false);
  });
});
