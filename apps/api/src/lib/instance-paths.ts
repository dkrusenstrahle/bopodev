import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

const DEFAULT_INSTANCE_ID = "default";
const SAFE_PATH_SEGMENT_RE = /^[a-zA-Z0-9_-]+$/;

function expandHomePrefix(value: string) {
  if (value === "~") {
    return homedir();
  }
  if (value.startsWith("~/")) {
    return resolve(homedir(), value.slice(2));
  }
  return value;
}

function normalizePath(raw: string) {
  return resolve(expandHomePrefix(raw.trim()));
}

type NormalizeAbsolutePathOptions = {
  requireAbsoluteInput?: boolean;
  baseDir?: string;
};

export function resolveBopoHomeDir() {
  const configured = process.env.BOPO_HOME?.trim();
  if (configured) {
    return normalizePath(configured);
  }
  return resolve(homedir(), ".bopodev");
}

export function resolveBopoInstanceId() {
  const configured = process.env.BOPO_INSTANCE_ID?.trim() || DEFAULT_INSTANCE_ID;
  if (!SAFE_PATH_SEGMENT_RE.test(configured)) {
    throw new Error(`Invalid BOPO_INSTANCE_ID '${configured}'.`);
  }
  return configured;
}

export function resolveBopoInstanceRoot() {
  const configuredRoot = process.env.BOPO_INSTANCE_ROOT?.trim();
  if (configuredRoot) {
    return normalizePath(configuredRoot);
  }
  if (process.env.NODE_ENV === "test") {
    return join(tmpdir(), "bopodev-instances", resolveBopoInstanceId());
  }
  return join(resolveBopoHomeDir(), "instances", resolveBopoInstanceId());
}

export function resolveProjectWorkspacePath(companyId: string, projectId: string) {
  const safeCompanyId = assertPathSegment(companyId, "companyId");
  const safeProjectId = assertPathSegment(projectId, "projectId");
  return join(resolveBopoInstanceRoot(), "workspaces", safeCompanyId, "projects", safeProjectId);
}

export function resolveCompanyProjectsWorkspacePath(companyId: string) {
  const safeCompanyId = assertPathSegment(companyId, "companyId");
  return join(resolveBopoInstanceRoot(), "workspaces", safeCompanyId);
}

/** Company-managed runtime skills (`skills/<id>/SKILL.md`), exportable with company zip. */
export function resolveCompanySkillsPath(companyId: string) {
  return join(resolveCompanyProjectsWorkspacePath(companyId), "skills");
}

/** Company knowledge base (`knowledge/**`), markdown and text files on disk; exportable with company zip. */
export function resolveCompanyKnowledgePath(companyId: string) {
  return join(resolveCompanyProjectsWorkspacePath(companyId), "knowledge");
}

export function resolveAgentFallbackWorkspacePath(companyId: string, agentId: string) {
  const safeCompanyId = assertPathSegment(companyId, "companyId");
  const safeAgentId = assertPathSegment(agentId, "agentId");
  return join(resolveBopoInstanceRoot(), "workspaces", safeCompanyId, "agents", safeAgentId);
}

export function resolveAgentProjectWorktreeRootPath(companyId: string, agentId: string, projectId: string) {
  const safeCompanyId = assertPathSegment(companyId, "companyId");
  const safeAgentId = assertPathSegment(agentId, "agentId");
  const safeProjectId = assertPathSegment(projectId, "projectId");
  return join(resolveBopoInstanceRoot(), "workspaces", safeCompanyId, "agents", safeAgentId, "worktrees", safeProjectId);
}

export function resolveAgentMemoryRootPath(companyId: string, agentId: string) {
  return join(resolveAgentFallbackWorkspacePath(companyId, agentId), "memory");
}

/** Agent operating docs (AGENTS.md, HEARTBEAT.md, etc.) — matches `BOPODEV_AGENT_OPERATING_DIR` at runtime. */
export function resolveAgentOperatingPath(companyId: string, agentId: string) {
  return join(resolveAgentFallbackWorkspacePath(companyId, agentId), "operating");
}

export function resolveCompanyMemoryRootPath(companyId: string) {
  const safeCompanyId = assertPathSegment(companyId, "companyId");
  return join(resolveBopoInstanceRoot(), "workspaces", safeCompanyId, "memory");
}

export function resolveProjectMemoryRootPath(companyId: string, projectId: string) {
  const safeCompanyId = assertPathSegment(companyId, "companyId");
  const safeProjectId = assertPathSegment(projectId, "projectId");
  return join(resolveBopoInstanceRoot(), "workspaces", safeCompanyId, "projects", safeProjectId, "memory");
}

export function resolveAgentDurableMemoryPath(companyId: string, agentId: string) {
  return join(resolveAgentMemoryRootPath(companyId, agentId), "life");
}

export function resolveAgentDailyMemoryPath(companyId: string, agentId: string) {
  return join(resolveAgentMemoryRootPath(companyId, agentId), "memory");
}

export function resolveStorageRoot() {
  return join(resolveBopoInstanceRoot(), "data", "storage");
}

export function normalizeAbsolutePath(value: string, options?: NormalizeAbsolutePathOptions) {
  const trimmed = value.trim();
  const expanded = expandHomePrefix(trimmed);
  if (options?.requireAbsoluteInput && !isAbsolute(expanded)) {
    throw new Error(`Expected absolute path input, received '${value}'.`);
  }
  if (isAbsolute(expanded)) {
    return resolve(expanded);
  }
  if (options?.baseDir) {
    return resolve(options.baseDir, expanded);
  }
  return resolve(expanded);
}

export function isInsidePath(parent: string, child: string) {
  const parentResolved = resolve(parent);
  const childResolved = resolve(child);
  if (!isAbsolute(parentResolved) || !isAbsolute(childResolved)) {
    return false;
  }
  const rel = relative(parentResolved, childResolved);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function resolveWorkspaceRootPath() {
  return join(resolveBopoInstanceRoot(), "workspaces");
}

export function resolveCompanyWorkspaceRootPath(companyId: string) {
  return resolveCompanyProjectsWorkspacePath(companyId);
}

export function assertPathInsidePath(parent: string, candidate: string, label = "path") {
  const normalizedParent = normalizeAbsolutePath(parent, { requireAbsoluteInput: true });
  const normalizedCandidate = normalizeAbsolutePath(candidate, { requireAbsoluteInput: true });
  if (!isInsidePath(normalizedParent, normalizedCandidate)) {
    throw new Error(`Invalid ${label} '${candidate}': must be inside '${normalizedParent}'.`);
  }
  return normalizedCandidate;
}

export function assertPathInsideWorkspaceRoot(candidate: string, label = "path") {
  return assertPathInsidePath(resolveWorkspaceRootPath(), candidate, label);
}

export function assertPathInsideCompanyWorkspaceRoot(companyId: string, candidate: string, label = "path") {
  return assertPathInsidePath(resolveCompanyWorkspaceRootPath(companyId), candidate, label);
}

export function normalizeCompanyWorkspacePath(
  companyId: string,
  value: string,
  options?: { requireAbsoluteInput?: boolean }
) {
  const companyWorkspaceRoot = resolveCompanyWorkspaceRootPath(companyId);
  const normalized = normalizeAbsolutePath(value, {
    requireAbsoluteInput: options?.requireAbsoluteInput ?? false,
    baseDir: companyWorkspaceRoot
  });
  return assertPathInsideCompanyWorkspaceRoot(companyId, normalized, "workspace path");
}

function assertPathSegment(value: string, label: string) {
  const trimmed = value.trim();
  if (trimmed !== value) {
    throw new Error(`Invalid ${label} for workspace path '${value}'.`);
  }
  if (!SAFE_PATH_SEGMENT_RE.test(trimmed)) {
    throw new Error(`Invalid ${label} for workspace path '${value}'.`);
  }
  return trimmed;
}
