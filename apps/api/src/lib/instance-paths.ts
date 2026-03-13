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
  assertPathSegment(companyId, "companyId");
  assertPathSegment(projectId, "projectId");
  return join(resolveBopoInstanceRoot(), "workspaces", companyId, "projects", projectId);
}

export function resolveCompanyProjectsWorkspacePath(companyId: string) {
  assertPathSegment(companyId, "companyId");
  return join(resolveBopoInstanceRoot(), "workspaces", companyId);
}

export function resolveAgentFallbackWorkspacePath(companyId: string, agentId: string) {
  assertPathSegment(companyId, "companyId");
  assertPathSegment(agentId, "agentId");
  return join(resolveBopoInstanceRoot(), "workspaces", companyId, "agents", agentId);
}

export function resolveAgentProjectWorktreeRootPath(companyId: string, agentId: string, projectId: string) {
  assertPathSegment(companyId, "companyId");
  assertPathSegment(agentId, "agentId");
  assertPathSegment(projectId, "projectId");
  return join(resolveBopoInstanceRoot(), "workspaces", companyId, "agents", agentId, "worktrees", projectId);
}

export function resolveAgentMemoryRootPath(companyId: string, agentId: string) {
  return join(resolveAgentFallbackWorkspacePath(companyId, agentId), "memory");
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

export function normalizeAbsolutePath(value: string) {
  return normalizePath(value);
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

function assertPathSegment(value: string, label: string) {
  const trimmed = value.trim();
  if (!SAFE_PATH_SEGMENT_RE.test(trimmed)) {
    throw new Error(`Invalid ${label} for workspace path '${value}'.`);
  }
}
