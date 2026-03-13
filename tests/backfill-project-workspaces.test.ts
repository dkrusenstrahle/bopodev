import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bootstrapDatabase, createCompany, createProject, listProjects, updateProject } from "../packages/db/src/index";
import { backfillProjectWorkspaces } from "../apps/api/src/scripts/backfill-project-workspaces";

describe("project workspace backfill", () => {
  const cleanupPaths: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanupPaths.map((path) => rm(path, { recursive: true, force: true })));
    cleanupPaths.length = 0;
  });

  it("backfills missing and relative project workspace paths", { timeout: 20_000 }, async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "bopodev-backfill-test-"));
    cleanupPaths.push(tempRoot);
    const dbPath = join(tempRoot, "test.db");

    const boot = await bootstrapDatabase(dbPath);
    const close = (boot.client as { close?: () => Promise<void> }).close;
    let companyId = "";
    let missingWorkspaceProjectId = "";
    let relativeWorkspaceProjectId = "";
    try {
      const company = await createCompany(boot.db, { name: "Backfill Co" });
      companyId = company.id;
      const missingWorkspaceProject = await createProject(boot.db, {
        companyId: company.id,
        name: "Missing workspace path"
      });
      missingWorkspaceProjectId = missingWorkspaceProject.id;
      const relativeWorkspaceProject = await createProject(boot.db, {
        companyId: company.id,
        name: "Relative workspace path",
        workspaceLocalPath: "relative/path"
      });
      relativeWorkspaceProjectId = relativeWorkspaceProject.id;
      await updateProject(boot.db, {
        companyId: company.id,
        id: relativeWorkspaceProject.id,
        workspaceLocalPath: "relative/path"
      });
    } finally {
      if (close) {
        await close.call(boot.client);
      }
    }

    const backfillDryRunSummary = await backfillProjectWorkspaces({ dbPath, dryRun: true });
    expect(backfillDryRunSummary.scannedProjects).toBeGreaterThanOrEqual(2);
    expect(backfillDryRunSummary.missingWorkspaceLocalPath).toBeGreaterThanOrEqual(1);
    expect(backfillDryRunSummary.relativeWorkspaceLocalPath).toBeGreaterThanOrEqual(1);
    expect(backfillDryRunSummary.updatedProjects).toBe(0);

    const backfillApplySummary = await backfillProjectWorkspaces({ dbPath, dryRun: false });
    expect(backfillApplySummary.updatedProjects).toBeGreaterThanOrEqual(2);
    expect(backfillApplySummary.writableInstanceRoot).toBe(true);
    expect(backfillApplySummary.writableStorageRoot).toBe(true);

    const verifyBoot = await bootstrapDatabase(dbPath);
    const verifyClose = (verifyBoot.client as { close?: () => Promise<void> }).close;
    try {
      const projects = await listProjects(verifyBoot.db, companyId);
      const missingWorkspaceAfter = projects.find((project) => project.id === missingWorkspaceProjectId);
      const relativeWorkspaceAfter = projects.find((project) => project.id === relativeWorkspaceProjectId);

      expect(missingWorkspaceAfter).toBeDefined();
      expect(relativeWorkspaceAfter).toBeDefined();
      expect(missingWorkspaceAfter?.workspaceLocalPath).toBeTruthy();
      expect(relativeWorkspaceAfter?.workspaceLocalPath).toBeTruthy();
      expect(missingWorkspaceAfter?.workspaceLocalPath ?? "").toContain(`/workspaces/${companyId}/projects/`);
      expect(relativeWorkspaceAfter?.workspaceLocalPath ?? "").toContain(`/workspaces/${companyId}/relative/path`);
      expect(isAbsolute(missingWorkspaceAfter?.workspaceLocalPath ?? "")).toBe(true);
      expect(isAbsolute(relativeWorkspaceAfter?.workspaceLocalPath ?? "")).toBe(true);
    } finally {
      if (verifyClose) {
        await verifyClose.call(verifyBoot.client);
      }
    }
  });
});
