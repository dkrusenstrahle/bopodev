import { access, constants, mkdir } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import {
  bootstrapDatabase,
  createProjectWorkspace,
  listCompanies,
  listProjects,
  listProjectWorkspaces,
  updateProjectWorkspace
} from "bopodev-db";
import {
  normalizeCompanyWorkspacePath,
  resolveBopoInstanceRoot,
  resolveProjectWorkspacePath,
  resolveStorageRoot
} from "../lib/instance-paths";

export interface ProjectWorkspaceBackfillSummary {
  scannedProjects: number;
  createdWorkspaces: number;
  normalizedWorkspaceCwds: number;
  updatedWorkspaces: number;
  missingWorkspaceLocalPath: number;
  relativeWorkspaceLocalPath: number;
  updatedProjects: number;
  createdDirectories: number;
  writableInstanceRoot: boolean;
  writableStorageRoot: boolean;
  dryRun: boolean;
}

export async function backfillProjectWorkspaces(input: { dbPath?: string; dryRun: boolean }) {
  const { db, client } = await bootstrapDatabase(input.dbPath);
  const instanceRoot = resolveBopoInstanceRoot();
  const storageRoot = resolveStorageRoot();
  let scannedProjects = 0;
  let createdWorkspaces = 0;
  let normalizedWorkspaceCwds = 0;
  let updatedWorkspaces = 0;
  let missingWorkspaceCount = 0;
  let relativeWorkspaceCount = 0;
  let createdDirectories = 0;

  try {
    const companies = await listCompanies(db);
    for (const company of companies) {
      const projects = await listProjects(db, company.id);
      for (const project of projects) {
        scannedProjects += 1;
        const workspaces = await listProjectWorkspaces(db, company.id, project.id);
        if (workspaces.length === 0) {
          missingWorkspaceCount += 1;
          const nextPath = resolveProjectWorkspacePath(company.id, project.id);
          if (!input.dryRun) {
            await mkdir(nextPath, { recursive: true });
            createdDirectories += 1;
            const created = await createProjectWorkspace(db, {
              companyId: company.id,
              projectId: project.id,
              name: project.name,
              cwd: nextPath,
              isPrimary: true
            });
            if (created) {
              createdWorkspaces += 1;
            }
          }
          continue;
        }

        for (const workspace of workspaces) {
          const cwd = workspace.cwd?.trim() ?? "";
          if (!cwd) {
            continue;
          }
          if (isAbsolute(cwd)) {
            continue;
          }
          relativeWorkspaceCount += 1;
          normalizedWorkspaceCwds += 1;
          const nextPath = normalizeCompanyWorkspacePath(company.id, cwd);
          if (!input.dryRun) {
            await mkdir(nextPath, { recursive: true });
            createdDirectories += 1;
            const updated = await updateProjectWorkspace(db, {
              companyId: company.id,
              projectId: project.id,
              id: workspace.id,
              cwd: nextPath
            });
            if (updated) {
              updatedWorkspaces += 1;
            }
          }
        }
      }
    }

    if (!input.dryRun) {
      await mkdir(instanceRoot, { recursive: true });
      await mkdir(storageRoot, { recursive: true });
    }
    const writableInstanceRoot = await isDirectoryWritable(instanceRoot);
    const writableStorageRoot = await isDirectoryWritable(storageRoot);

    return {
      scannedProjects,
      createdWorkspaces,
      normalizedWorkspaceCwds,
      updatedWorkspaces,
      missingWorkspaceLocalPath: missingWorkspaceCount,
      relativeWorkspaceLocalPath: relativeWorkspaceCount,
      updatedProjects: updatedWorkspaces + createdWorkspaces,
      createdDirectories,
      writableInstanceRoot,
      writableStorageRoot,
      dryRun: input.dryRun
    } satisfies ProjectWorkspaceBackfillSummary;
  } finally {
    const maybeClose = (client as { close?: () => Promise<void> }).close;
    if (maybeClose) {
      await maybeClose.call(client);
    }
  }
}

async function isDirectoryWritable(path: string) {
  try {
    await mkdir(path, { recursive: true });
    await access(path, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const dbPath = normalizeOptionalDbPath(process.env.BOPO_DB_PATH);
  const summary = await backfillProjectWorkspaces({
    dbPath,
    dryRun: process.env.BOPO_BACKFILL_DRY_RUN !== "0"
  });
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(summary));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}

function normalizeOptionalDbPath(value: string | undefined) {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : undefined;
}
