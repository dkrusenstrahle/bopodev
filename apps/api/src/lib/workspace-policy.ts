import { and, eq, inArray } from "drizzle-orm";
import type { BopoDb } from "bopodev-db";
import { projectWorkspaces, projects } from "bopodev-db";
import {
  assertPathInsideCompanyWorkspaceRoot,
  isInsidePath,
  normalizeCompanyWorkspacePath,
  normalizeAbsolutePath,
  resolveAgentFallbackWorkspacePath,
  resolveAgentMemoryRootPath,
  resolveCompanyProjectsWorkspacePath
} from "./instance-paths";

export function hasText(value: string | null | undefined) {
  return Boolean(value && value.trim().length > 0);
}

export type ExecutionWorkspaceMode = "project_primary" | "isolated" | "agent_default";
export type ExecutionWorkspaceStrategyType = "git_worktree";
export interface ProjectExecutionWorkspacePolicy {
  mode?: ExecutionWorkspaceMode;
  strategy?: {
    type?: ExecutionWorkspaceStrategyType;
    rootDir?: string | null;
    branchPrefix?: string | null;
  } | null;
  credentials?: {
    mode?: "host" | "env_token";
    tokenEnvVar?: string | null;
    username?: string | null;
  } | null;
  allowRemotes?: string[] | null;
  allowBranchPrefixes?: string[] | null;
}

export function parseRuntimeCwd(stateBlob: string | null | undefined) {
  if (!stateBlob) {
    return null;
  }
  try {
    const parsed = JSON.parse(stateBlob) as { runtime?: { cwd?: unknown } };
    const cwd = parsed.runtime?.cwd;
    return typeof cwd === "string" ? cwd : null;
  } catch {
    return null;
  }
}

export async function inferSingleWorkspaceLocalPath(db: BopoDb, companyId: string) {
  const rows = await db
    .select({ cwd: projectWorkspaces.cwd })
    .from(projectWorkspaces)
    .where(and(eq(projectWorkspaces.companyId, companyId), eq(projectWorkspaces.isPrimary, true)));
  const paths = Array.from(
    new Set(
      rows
        .map((row) => row.cwd?.trim() ?? "")
        .filter((value) => value.length > 0)
    )
  );
  const singlePath = paths.length === 1 ? paths[0] : null;
  return singlePath ? normalizeCompanyWorkspacePath(companyId, singlePath) : null;
}

export async function resolveDefaultRuntimeCwdForCompany(db: BopoDb, companyId: string) {
  const inferredSingleWorkspace = await inferSingleWorkspaceLocalPath(db, companyId);
  if (inferredSingleWorkspace) {
    return inferredSingleWorkspace;
  }
  return resolveCompanyProjectsWorkspacePath(companyId);
}

export async function getProjectWorkspaceMap(db: BopoDb, companyId: string, projectIds: string[]) {
  const context = await getProjectWorkspaceContextMap(db, companyId, projectIds);
  return new Map(Array.from(context.entries()).map(([projectId, value]) => [projectId, value.cwd]));
}

export async function getProjectWorkspaceContextMap(db: BopoDb, companyId: string, projectIds: string[]) {
  if (projectIds.length === 0) {
    return new Map<
      string,
      {
        workspaceId: string | null;
        workspaceName: string | null;
        cwd: string | null;
        repoUrl: string | null;
        repoRef: string | null;
        policy: ProjectExecutionWorkspacePolicy | null;
      }
    >();
  }
  const workspaceRows = await db
    .select({
      id: projectWorkspaces.id,
      projectId: projectWorkspaces.projectId,
      name: projectWorkspaces.name,
      cwd: projectWorkspaces.cwd,
      repoUrl: projectWorkspaces.repoUrl,
      repoRef: projectWorkspaces.repoRef
    })
    .from(projectWorkspaces)
    .where(
      and(
        eq(projectWorkspaces.companyId, companyId),
        inArray(projectWorkspaces.projectId, projectIds),
        eq(projectWorkspaces.isPrimary, true)
      )
    );
  const projectRows = await db
    .select({ id: projects.id, executionWorkspacePolicy: projects.executionWorkspacePolicy })
    .from(projects)
    .where(and(eq(projects.companyId, companyId), inArray(projects.id, projectIds)));

  const workspaceMap = new Map(
    workspaceRows.map((row) => [row.projectId, row.cwd ? normalizeCompanyWorkspacePath(companyId, row.cwd) : null])
  );
  const workspaceByProject = new Map(workspaceRows.map((row) => [row.projectId, row]));
  const policyMap = new Map(projectRows.map((row) => [row.id, parseProjectExecutionWorkspacePolicy(row.executionWorkspacePolicy)]));
  const result = new Map<
    string,
    {
      workspaceId: string | null;
      workspaceName: string | null;
      cwd: string | null;
      repoUrl: string | null;
      repoRef: string | null;
      policy: ProjectExecutionWorkspacePolicy | null;
    }
  >();
  for (const projectId of projectIds) {
    const workspace = workspaceByProject.get(projectId);
    result.set(projectId, {
      workspaceId: workspace?.id ?? null,
      workspaceName: workspace?.name ?? null,
      cwd: workspaceMap.get(projectId) ?? null,
      repoUrl: workspace?.repoUrl?.trim() ? workspace.repoUrl.trim() : null,
      repoRef: workspace?.repoRef?.trim() ? workspace.repoRef.trim() : null,
      policy: policyMap.get(projectId) ?? null
    });
  }
  return result;
}

export function ensureRuntimeInsideWorkspace(projectWorkspacePath: string, runtimeCwd: string) {
  return isInsidePath(normalizeAbsolutePath(projectWorkspacePath), normalizeAbsolutePath(runtimeCwd));
}

export function ensureRuntimeWorkspaceCompatible(projectWorkspacePath: string, runtimeCwd: string) {
  const projectPath = normalizeAbsolutePath(projectWorkspacePath);
  const runtimePath = normalizeAbsolutePath(runtimeCwd);
  return isInsidePath(projectPath, runtimePath) || isInsidePath(runtimePath, projectPath);
}

export function resolveAgentFallbackWorkspace(companyId: string, agentId: string) {
  return resolveAgentFallbackWorkspacePath(companyId, agentId);
}

export function resolveAgentMemoryRoot(companyId: string, agentId: string) {
  return resolveAgentMemoryRootPath(companyId, agentId);
}

export function parseProjectExecutionWorkspacePolicy(
  value: string | Record<string, unknown> | null | undefined
): ProjectExecutionWorkspacePolicy | null {
  if (!value) {
    return null;
  }
  const parsedValue =
    typeof value === "string"
      ? (() => {
          try {
            return JSON.parse(value) as Record<string, unknown>;
          } catch {
            return null;
          }
        })()
      : value;
  if (!parsedValue || typeof parsedValue !== "object") {
    return null;
  }
  const mode = parsedValue.mode;
  const strategy = parsedValue.strategy as Record<string, unknown> | undefined;
  const normalizedMode: ExecutionWorkspaceMode | undefined =
    mode === "project_primary" || mode === "isolated" || mode === "agent_default" ? mode : undefined;
  const normalizedStrategy =
    strategy && typeof strategy === "object"
      ? {
          type: strategy.type === "git_worktree" ? ("git_worktree" as const) : undefined,
          rootDir: typeof strategy.rootDir === "string" ? strategy.rootDir : null,
          branchPrefix: typeof strategy.branchPrefix === "string" ? strategy.branchPrefix : null
        }
      : null;
  const credentials = parsedValue.credentials as Record<string, unknown> | undefined;
  const normalizedCredentials =
    credentials && typeof credentials === "object"
      ? {
          mode:
            credentials.mode === "host" || credentials.mode === "env_token"
              ? (credentials.mode as "host" | "env_token")
              : undefined,
          tokenEnvVar: typeof credentials.tokenEnvVar === "string" ? credentials.tokenEnvVar : null,
          username: typeof credentials.username === "string" ? credentials.username : null
        }
      : null;
  const allowRemotes = Array.isArray(parsedValue.allowRemotes)
    ? parsedValue.allowRemotes.map((entry) => String(entry).trim()).filter((entry) => entry.length > 0)
    : null;
  const allowBranchPrefixes = Array.isArray(parsedValue.allowBranchPrefixes)
    ? parsedValue.allowBranchPrefixes.map((entry) => String(entry).trim()).filter((entry) => entry.length > 0)
    : null;
  return {
    mode: normalizedMode,
    strategy: normalizedStrategy,
    credentials: normalizedCredentials,
    allowRemotes,
    allowBranchPrefixes
  };
}

export function assertRuntimeCwdForCompany(companyId: string, runtimeCwd: string, label = "runtimeCwd") {
  const normalized = normalizeAbsolutePath(runtimeCwd, { requireAbsoluteInput: true });
  return assertPathInsideCompanyWorkspaceRoot(companyId, normalized, label);
}
