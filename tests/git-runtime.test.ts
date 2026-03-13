import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bootstrapRepositoryWorkspace, ensureIsolatedGitWorktree, GitRuntimeError } from "../apps/api/src/lib/git-runtime";

describe("git runtime path and allowlist policy", () => {
  const cleanupPaths: string[] = [];
  const originalInstanceRoot = process.env.BOPO_INSTANCE_ROOT;
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(async () => {
    process.env.BOPO_INSTANCE_ROOT = originalInstanceRoot;
    process.env.NODE_ENV = originalNodeEnv;
    await Promise.all(cleanupPaths.map((path) => rm(path, { recursive: true, force: true })));
    cleanupPaths.length = 0;
  });

  it("rejects strategy rootDir outside managed company workspace root", async () => {
    const root = await mkdtemp(join(tmpdir(), "bopodev-git-runtime-"));
    cleanupPaths.push(root);
    process.env.BOPO_INSTANCE_ROOT = root;
    process.env.NODE_ENV = "development";

    await expect(
      ensureIsolatedGitWorktree({
        companyId: "acme",
        projectId: "proj",
        agentId: "agent1",
        repoCwd: join(root, "workspaces", "acme", "projects", "proj"),
        policy: {
          strategy: {
            type: "git_worktree",
            rootDir: join(tmpdir(), "outside-worktrees")
          }
        }
      })
    ).rejects.toThrow("must be inside");
  });

  it("rejects project workspace cwd outside managed root before git operations", async () => {
    const root = await mkdtemp(join(tmpdir(), "bopodev-git-runtime-"));
    cleanupPaths.push(root);
    process.env.BOPO_INSTANCE_ROOT = root;
    process.env.NODE_ENV = "development";

    await expect(
      bootstrapRepositoryWorkspace({
        companyId: "acme",
        projectId: "proj",
        cwd: join(tmpdir(), "external-workspace"),
        repoUrl: "https://github.com/acme/project.git"
      })
    ).rejects.toThrow("must be inside");
  });

  it("uses strict host/path matching for allowRemotes", async () => {
    const root = await mkdtemp(join(tmpdir(), "bopodev-git-runtime-"));
    cleanupPaths.push(root);
    process.env.BOPO_INSTANCE_ROOT = root;
    process.env.NODE_ENV = "development";

    try {
      await bootstrapRepositoryWorkspace({
        companyId: "acme",
        projectId: "proj",
        cwd: join(root, "workspaces", "acme", "projects", "proj"),
        repoUrl: "https://github.com/acme/project.git",
        policy: {
          allowRemotes: ["hub.com/acme"]
        }
      });
      throw new Error("expected policy_violation");
    } catch (error) {
      expect(error).toBeInstanceOf(GitRuntimeError);
      expect((error as GitRuntimeError).code).toBe("policy_violation");
    }
  });
});
