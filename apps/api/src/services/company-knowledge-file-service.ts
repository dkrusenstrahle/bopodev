import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { isInsidePath, resolveCompanyKnowledgePath, resolveCompanyProjectsWorkspacePath } from "../lib/instance-paths";

const MAX_OBSERVABILITY_FILES = 200;
const MAX_OBSERVABILITY_FILE_BYTES = 512 * 1024;
const MAX_PATH_SEGMENTS = 32;
const TEXT_EXT = new Set([".md", ".yaml", ".yml", ".txt", ".json"]);

/** Default file body when POST create omits `content`. Markdown/text start empty (no frontmatter boilerplate). */
function defaultContentForNewKnowledgeFile(relativePath: string): string {
  const lower = relativePath.toLowerCase();
  if (lower.endsWith(".json")) {
    return "{}\n";
  }
  return "";
}

export function assertKnowledgeRelativePath(relativePath: string): string {
  const normalized = relativePath.trim().replace(/\\/g, "/");
  if (!normalized || normalized.startsWith("/") || normalized.includes("..")) {
    throw new Error("Invalid relative path.");
  }
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length === 0 || parts.length > MAX_PATH_SEGMENTS) {
    throw new Error("Invalid relative path.");
  }
  for (const p of parts) {
    if (p === "." || p === ".." || p.startsWith(".")) {
      throw new Error("Invalid relative path.");
    }
  }
  const base = parts[parts.length - 1]!;
  const lower = base.toLowerCase();
  const ext = lower.includes(".") ? lower.slice(lower.lastIndexOf(".")) : "";
  if (!TEXT_EXT.has(ext)) {
    throw new Error("Only text knowledge files (.md, .yaml, .yml, .txt, .json) are allowed.");
  }
  return normalized;
}

async function knowledgeRoot(companyId: string) {
  const root = resolveCompanyKnowledgePath(companyId);
  const companyWorkspace = resolveCompanyProjectsWorkspacePath(companyId);
  if (!isInsidePath(companyWorkspace, root)) {
    throw new Error("Invalid knowledge root.");
  }
  return { root };
}

export async function listKnowledgeFiles(input: { companyId: string; maxFiles?: number }) {
  const { root } = await knowledgeRoot(input.companyId);
  await mkdir(root, { recursive: true });
  const maxFiles = Math.max(1, Math.min(MAX_OBSERVABILITY_FILES, input.maxFiles ?? MAX_OBSERVABILITY_FILES));
  const relativePaths = await walkKnowledgeTextFiles(root, maxFiles);
  return { root, files: relativePaths.map((relativePath) => ({ relativePath })) };
}

export type KnowledgeTreeNode =
  | { type: "file"; name: string; relativePath: string }
  | { type: "dir"; name: string; children: KnowledgeTreeNode[] };

/** Nested tree from flat relative paths (trie). */
export function buildKnowledgeTreeFromPaths(files: { relativePath: string }[]): KnowledgeTreeNode[] {
  type Trie = { dirs: Map<string, Trie>; files: KnowledgeTreeNode[] };
  const root: Trie = { dirs: new Map(), files: [] };

  for (const { relativePath } of [...files].sort((a, b) => a.relativePath.localeCompare(b.relativePath))) {
    const parts = relativePath.split("/").filter(Boolean);
    if (parts.length === 0) {
      continue;
    }
    const fileName = parts.pop()!;
    let node = root;
    for (const segment of parts) {
      if (!node.dirs.has(segment)) {
        node.dirs.set(segment, { dirs: new Map(), files: [] });
      }
      node = node.dirs.get(segment)!;
    }
    node.files.push({ type: "file", name: fileName, relativePath });
  }

  function trieToNodes(trie: Trie): KnowledgeTreeNode[] {
    const dirNodes: KnowledgeTreeNode[] = [];
    for (const [name, child] of [...trie.dirs.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const children = trieToNodes(child);
      dirNodes.push({ type: "dir", name, children });
    }
    const sortedFiles = [...trie.files].sort((a, b) => a.name.localeCompare(b.name));
    return [...dirNodes, ...sortedFiles];
  }

  return trieToNodes(root);
}

async function walkKnowledgeTextFiles(knowledgeDir: string, maxFiles: number): Promise<string[]> {
  const collected: string[] = [];
  const queue = [knowledgeDir];
  while (queue.length > 0 && collected.length < maxFiles) {
    const current = queue.shift();
    if (!current) {
      continue;
    }
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (collected.length >= maxFiles) {
        break;
      }
      const absolutePath = join(current, entry.name);
      if (entry.isDirectory()) {
        if (!entry.name.startsWith(".")) {
          queue.push(absolutePath);
        }
        continue;
      }
      if (entry.name.startsWith(".")) {
        continue;
      }
      const lower = entry.name.toLowerCase();
      const ext = lower.includes(".") ? lower.slice(lower.lastIndexOf(".")) : "";
      if (TEXT_EXT.has(ext)) {
        collected.push(relative(knowledgeDir, absolutePath).replace(/\\/g, "/"));
      }
    }
  }
  return collected.sort((a, b) => a.localeCompare(b));
}

export async function readKnowledgeFile(input: { companyId: string; relativePath: string }) {
  const { root } = await knowledgeRoot(input.companyId);
  const rel = assertKnowledgeRelativePath(input.relativePath);
  const candidate = resolve(root, rel);
  if (!isInsidePath(root, candidate)) {
    throw new Error("Requested path is outside of knowledge directory.");
  }
  const info = await stat(candidate);
  if (!info.isFile()) {
    throw new Error("Requested path is not a file.");
  }
  if (info.size > MAX_OBSERVABILITY_FILE_BYTES) {
    throw new Error("File exceeds size limit.");
  }
  const content = await readFile(candidate, "utf8");
  return {
    relativePath: rel,
    content,
    sizeBytes: info.size
  };
}

export async function writeKnowledgeFile(input: {
  companyId: string;
  relativePath: string;
  content: string;
}) {
  const { root } = await knowledgeRoot(input.companyId);
  const rel = assertKnowledgeRelativePath(input.relativePath);
  const candidate = resolve(root, rel);
  if (!isInsidePath(root, candidate)) {
    throw new Error("Requested path is outside of knowledge directory.");
  }
  const bytes = Buffer.byteLength(input.content, "utf8");
  if (bytes > MAX_OBSERVABILITY_FILE_BYTES) {
    throw new Error("Content exceeds size limit.");
  }
  const parent = dirname(candidate);
  if (!isInsidePath(root, parent)) {
    throw new Error("Invalid parent directory.");
  }
  await mkdir(parent, { recursive: true });
  await writeFile(candidate, input.content, { encoding: "utf8" });
  const info = await stat(candidate);
  return {
    relativePath: rel,
    sizeBytes: info.size
  };
}

/** Create a new file; fails if it already exists. */
export async function createKnowledgeFile(input: {
  companyId: string;
  relativePath: string;
  content?: string;
}) {
  const { root } = await knowledgeRoot(input.companyId);
  const rel = assertKnowledgeRelativePath(input.relativePath);
  const candidate = resolve(root, rel);
  if (!isInsidePath(root, candidate)) {
    throw new Error("Requested path is outside of knowledge directory.");
  }
  try {
    await stat(candidate);
    throw new Error("A file already exists at this path.");
  } catch (error) {
    if (error instanceof Error && error.message === "A file already exists at this path.") {
      throw error;
    }
    const code = error && typeof error === "object" && "code" in error ? (error as NodeJS.ErrnoException).code : undefined;
    if (code !== "ENOENT") {
      throw error;
    }
  }
  const body = input.content ?? defaultContentForNewKnowledgeFile(rel);
  const bytes = Buffer.byteLength(body, "utf8");
  if (bytes > MAX_OBSERVABILITY_FILE_BYTES) {
    throw new Error("Content exceeds size limit.");
  }
  const parent = dirname(candidate);
  if (!isInsidePath(root, parent)) {
    throw new Error("Invalid parent directory.");
  }
  await mkdir(parent, { recursive: true });
  await writeFile(candidate, body, { encoding: "utf8" });
  const info = await stat(candidate);
  return {
    relativePath: rel,
    sizeBytes: info.size
  };
}

/** Rename/move a knowledge file within the knowledge root. */
export async function renameKnowledgeFile(input: {
  companyId: string;
  fromRelativePath: string;
  toRelativePath: string;
}) {
  const fromRel = assertKnowledgeRelativePath(input.fromRelativePath.trim());
  const toRel = assertKnowledgeRelativePath(input.toRelativePath.trim());
  if (fromRel === toRel) {
    return { relativePath: toRel };
  }
  const { root } = await knowledgeRoot(input.companyId);
  const fromAbs = resolve(root, fromRel);
  const toAbs = resolve(root, toRel);
  if (!isInsidePath(root, fromAbs) || !isInsidePath(root, toAbs)) {
    throw new Error("Requested path is outside of knowledge directory.");
  }
  const fromInfo = await stat(fromAbs);
  if (!fromInfo.isFile()) {
    throw new Error("Source path is not a file.");
  }
  try {
    await stat(toAbs);
    throw new Error("A file already exists at the destination path.");
  } catch (error) {
    if (error instanceof Error && error.message === "A file already exists at the destination path.") {
      throw error;
    }
    const code = error && typeof error === "object" && "code" in error ? (error as NodeJS.ErrnoException).code : undefined;
    if (code !== "ENOENT") {
      throw error;
    }
  }
  const parent = dirname(toAbs);
  if (!isInsidePath(root, parent)) {
    throw new Error("Invalid parent directory.");
  }
  await mkdir(parent, { recursive: true });
  await rename(fromAbs, toAbs);
  return { relativePath: toRel };
}

/** Folder path prefix (no trailing slash), e.g. `guides/onboarding`. */
export function assertKnowledgeFolderPrefix(prefix: string): string {
  const normalized = prefix.trim().replace(/\\/g, "/").replace(/\/+$/g, "");
  if (!normalized) {
    throw new Error("Invalid folder path.");
  }
  if (normalized.startsWith("/") || normalized.includes("..")) {
    throw new Error("Invalid folder path.");
  }
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length === 0 || parts.length > MAX_PATH_SEGMENTS - 1) {
    throw new Error("Invalid folder path.");
  }
  for (const p of parts) {
    if (p === "." || p === ".." || p.startsWith(".")) {
      throw new Error("Invalid folder path.");
    }
  }
  return parts.join("/");
}

/**
 * Rename a knowledge folder by moving every file under `fromPrefix/` to the same relative paths under `toPrefix`.
 */
export async function renameKnowledgeFolderPrefix(input: {
  companyId: string;
  fromPrefix: string;
  toPrefix: string;
}) {
  const fromP = assertKnowledgeFolderPrefix(input.fromPrefix);
  const toP = assertKnowledgeFolderPrefix(input.toPrefix);
  if (fromP === toP) {
    return { moved: 0, fromPrefix: fromP, toPrefix: toP };
  }
  if (toP.startsWith(`${fromP}/`) || fromP.startsWith(`${toP}/`)) {
    throw new Error("Invalid folder rename: one folder sits inside the other.");
  }
  const { files } = await listKnowledgeFiles({ companyId: input.companyId, maxFiles: MAX_OBSERVABILITY_FILES });
  const paths = files.map((f) => f.relativePath);
  const filePathsToMove = paths.filter((p) => p.startsWith(`${fromP}/`));
  if (filePathsToMove.length === 0) {
    throw new Error("No files found under that folder.");
  }
  const existing = new Set(paths);
  for (const p of filePathsToMove) {
    const np = `${toP}${p.slice(fromP.length)}`;
    if (existing.has(np) && !filePathsToMove.includes(np)) {
      throw new Error(`A file already exists at ${np}.`);
    }
  }
  const sorted = [...filePathsToMove].sort((a, b) => b.length - a.length);
  for (const p of sorted) {
    const np = `${toP}${p.slice(fromP.length)}`;
    await renameKnowledgeFile({
      companyId: input.companyId,
      fromRelativePath: p,
      toRelativePath: np
    });
    existing.delete(p);
    existing.add(np);
  }
  return { moved: sorted.length, fromPrefix: fromP, toPrefix: toP };
}

export async function deleteKnowledgeFile(input: { companyId: string; relativePath: string }) {
  const { root } = await knowledgeRoot(input.companyId);
  const rel = assertKnowledgeRelativePath(input.relativePath);
  const candidate = resolve(root, rel);
  if (!isInsidePath(root, candidate)) {
    throw new Error("Requested path is outside of knowledge directory.");
  }
  const info = await stat(candidate);
  if (!info.isFile()) {
    throw new Error("Requested path is not a file.");
  }
  await rm(candidate, { force: true });
  return { relativePath: rel };
}

export async function knowledgeFileExists(input: { companyId: string; relativePath: string }): Promise<boolean> {
  try {
    const rel = assertKnowledgeRelativePath(input.relativePath);
    const { root } = await knowledgeRoot(input.companyId);
    const candidate = resolve(root, rel);
    if (!isInsidePath(root, candidate)) {
      return false;
    }
    const info = await stat(candidate);
    return info.isFile();
  } catch {
    return false;
  }
}
