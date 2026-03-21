import { isAbsolute, resolve } from "node:path";
import { isInsidePath, resolveCompanyWorkspaceRootPath } from "./instance-paths";

/**
 * Resolves a run-report artifact to an absolute path under the company workspace, or null if invalid.
 * Shared by observability download and heartbeat artifact verification.
 */
export function resolveRunArtifactAbsolutePath(companyId: string, artifact: Record<string, unknown>) {
  const companyWorkspaceRoot = resolveCompanyWorkspaceRootPath(companyId);
  const absolutePathRaw = normalizeAbsoluteArtifactPath(
    typeof artifact.absolutePath === "string" ? artifact.absolutePath.trim() : ""
  );
  const relativePathRaw = normalizeWorkspaceRelativeArtifactPath(
    typeof artifact.relativePath === "string"
      ? artifact.relativePath.trim()
      : typeof artifact.path === "string"
        ? artifact.path.trim()
        : ""
  );
  const candidate = relativePathRaw
    ? resolve(companyWorkspaceRoot, relativePathRaw)
    : absolutePathRaw
      ? absolutePathRaw
      : "";
  if (!candidate) {
    return null;
  }
  const resolved = isAbsolute(candidate) ? resolve(candidate) : resolve(companyWorkspaceRoot, candidate);
  if (!isInsidePath(companyWorkspaceRoot, resolved)) {
    return null;
  }
  return resolved;
}

function normalizeAbsoluteArtifactPath(value: string) {
  const trimmed = value.trim();
  if (!trimmed || !isAbsolute(trimmed)) {
    return "";
  }
  return resolve(trimmed);
}

function normalizeWorkspaceRelativeArtifactPath(value: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  const unixSeparated = trimmed.replace(/\\/g, "/");
  if (isAbsolute(unixSeparated)) {
    return "";
  }
  const parts: string[] = [];
  for (const part of unixSeparated.split("/")) {
    if (!part || part === ".") {
      continue;
    }
    if (part === "..") {
      if (parts.length > 0 && parts[parts.length - 1] !== "..") {
        parts.pop();
      } else {
        parts.push(part);
      }
      continue;
    }
    parts.push(part);
  }
  const normalized = parts.join("/");
  if (!normalized) {
    return "";
  }
  const workspaceScopedMatch = normalized.match(/(?:^|\/)workspace\/([^/]+)\/(.+)$/);
  if (!workspaceScopedMatch) {
    const projectAgentsMatch = normalized.match(/(?:^|\/)projects\/agents\/([^/]+)\/operating\/(.+)$/);
    if (projectAgentsMatch) {
      const [, agentId, suffix] = projectAgentsMatch;
      if (!agentId || !suffix) {
        return "";
      }
      return `agents/${agentId}/operating/${suffix}`;
    }
    return normalized;
  }
  const scopedRelativePath = workspaceScopedMatch[2];
  if (!scopedRelativePath) {
    return "";
  }
  return scopedRelativePath;
}
