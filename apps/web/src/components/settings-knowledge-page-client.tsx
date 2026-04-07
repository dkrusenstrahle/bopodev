"use client";

import type { Route } from "next";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { KnowledgeTiptapEditor } from "@/components/knowledge-tiptap-editor";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ChevronDown, ChevronRight, FileText, Folder, Plus } from "lucide-react";
import { ApiError, apiDelete, apiGet, apiPatch, apiPost, apiPut } from "@/lib/api";
import { cn } from "@/lib/utils";
import { SectionHeading } from "@/components/workspace/shared";

type KnowledgeTreeNode =
  | { type: "file"; name: string; relativePath: string }
  | { type: "dir"; name: string; children: KnowledgeTreeNode[] };

interface CompanyKnowledgeListResponse {
  items: Array<{ relativePath: string }>;
  tree: KnowledgeTreeNode[];
}

interface FileBodyResponse {
  content: string;
}

const KNOWLEDGE_MAX_PATH_SEGMENTS = 32;

const KNOWLEDGE_TEXT_EXT = new Set([".md", ".yaml", ".yml", ".txt", ".json"]);

/** Longer suffixes first when stripping an extension from a title field. */
const KNOWLEDGE_EXT_STRIP_ORDER = [".yaml", ".yml", ".json", ".txt", ".md"] as const;

/** Full relative file path under knowledge root (same rules as the API). */
function parseKnowledgeRelativePathInput(
  input: string
): { ok: true; path: string } | { ok: false; message: string } {
  const normalized = input.trim().replace(/\\/g, "/");
  if (!normalized) {
    return { ok: false, message: "Enter a path." };
  }
  if (normalized.startsWith("/") || normalized.includes("..")) {
    return { ok: false, message: "Invalid path." };
  }
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length === 0 || parts.length > KNOWLEDGE_MAX_PATH_SEGMENTS) {
    return { ok: false, message: "Too many path segments." };
  }
  for (const p of parts) {
    if (p === "." || p === ".." || p.startsWith(".")) {
      return { ok: false, message: "Path segments cannot start with a dot." };
    }
  }
  const base = parts[parts.length - 1]!;
  const lower = base.toLowerCase();
  const ext = lower.includes(".") ? lower.slice(lower.lastIndexOf(".")) : "";
  if (!KNOWLEDGE_TEXT_EXT.has(ext)) {
    return { ok: false, message: "Allowed extensions: .md, .yaml, .yml, .txt, .json." };
  }
  return { ok: true, path: normalized };
}

function knowledgeBasenameFromRelativePath(relativePath: string): string {
  const i = relativePath.lastIndexOf("/");
  return i === -1 ? relativePath : relativePath.slice(i + 1);
}

/** Split `page.md` → stem `page`, ext `.md` (ext preserved on rename). */
function knowledgeStemAndExtFromBasename(basename: string): { stem: string; ext: string } {
  const lower = basename.toLowerCase();
  const dot = basename.lastIndexOf(".");
  if (dot > 0) {
    const ext = lower.slice(dot);
    if (KNOWLEDGE_TEXT_EXT.has(ext)) {
      return { stem: basename.slice(0, dot), ext };
    }
  }
  return { stem: basename, ext: ".md" };
}

/** Title without extension; accidental `.md` etc. in the field is stripped. */
function parseKnowledgeTitleStemInput(
  input: string
): { ok: true; stem: string } | { ok: false; message: string } {
  let s = input.trim().replace(/\\/g, "/");
  if (!s) {
    return { ok: false, message: "Enter a title." };
  }
  if (s.includes("/") || s.includes("..")) {
    return { ok: false, message: "Enter a title only (no path separators or ..)." };
  }
  if (s.startsWith(".")) {
    return { ok: false, message: "Title cannot start with a dot." };
  }
  const lower = s.toLowerCase();
  for (const ext of KNOWLEDGE_EXT_STRIP_ORDER) {
    if (lower.endsWith(ext)) {
      s = s.slice(0, -ext.length);
      break;
    }
  }
  s = s.trim();
  if (!s) {
    return { ok: false, message: "Enter a title." };
  }
  if (s.startsWith(".")) {
    return { ok: false, message: "Title cannot start with a dot." };
  }
  return { ok: true, stem: s };
}

function knowledgeParentPrefixFromRelativePath(relativePath: string): string {
  const i = relativePath.lastIndexOf("/");
  return i === -1 ? "" : relativePath.slice(0, i);
}

function knowledgeRelativePathFromParentAndFilename(parentPrefix: string, filename: string): string {
  const p = parentPrefix.trim();
  return p ? `${p}/${filename}` : filename;
}

/** Folder path under knowledge root (no leading/trailing slashes). */
function parseKnowledgeFolderInput(
  input: string
): { ok: true; prefix: string } | { ok: false; message: string } {
  const normalized = input.trim().replace(/\\/g, "/").replace(/\/+$/g, "");
  if (!normalized) {
    return { ok: false, message: "Enter a folder path." };
  }
  if (normalized.startsWith("/") || normalized.includes("..")) {
    return { ok: false, message: "Invalid folder path." };
  }
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length === 0 || parts.length > KNOWLEDGE_MAX_PATH_SEGMENTS - 1) {
    return { ok: false, message: "Too many nested folders." };
  }
  for (const p of parts) {
    if (p === "." || p === ".." || p.startsWith(".")) {
      return { ok: false, message: "Folder names cannot start with a dot." };
    }
  }
  return { ok: true, prefix: parts.join("/") };
}

/** Single path segment for renaming a folder in the tree (no slashes). */
function parseKnowledgeFolderSegmentInput(
  input: string
): { ok: true; segment: string } | { ok: false; message: string } {
  const s = input.trim();
  if (!s) {
    return { ok: false, message: "Enter a folder name." };
  }
  if (s.includes("/") || s.includes("..")) {
    return { ok: false, message: "Use a single folder name (no slashes)." };
  }
  if (s.startsWith(".")) {
    return { ok: false, message: "Folder name cannot start with a dot." };
  }
  if (s.length > 200) {
    return { ok: false, message: "Folder name is too long." };
  }
  return { ok: true, segment: s };
}

function collectAllDirectoryKeys(nodes: KnowledgeTreeNode[], prefix: string): string[] {
  const keys: string[] = [];
  for (const node of nodes) {
    if (node.type === "dir") {
      const key = prefix ? `${prefix}/${node.name}` : node.name;
      keys.push(key, ...collectAllDirectoryKeys(node.children, key));
    }
  }
  return keys;
}

function KnowledgeTreeNav({
  nodes,
  depth,
  dirPrefix,
  expandedDirs,
  toggleDir,
  selectedPath,
  onSelectFile,
  onRequestNewInFolder,
  onFileDoubleClick,
  onFolderDoubleClick
}: {
  nodes: KnowledgeTreeNode[];
  depth: number;
  dirPrefix: string;
  expandedDirs: Set<string>;
  toggleDir: (dirKey: string) => void;
  selectedPath: string | null;
  onSelectFile: (path: string) => void;
  onRequestNewInFolder: (folderPathPrefix: string) => void;
  onFileDoubleClick?: (relativePath: string) => void;
  onFolderDoubleClick?: (dirKey: string) => void;
}) {
  return (
    <div className="ui-knowledge-tree-children">
      {nodes.map((node) => {
        if (node.type === "file") {
          const active = selectedPath === node.relativePath;
          return (
            <div
              key={node.relativePath}
              className={cn(
                "ui-knowledge-tree-row",
                "ui-knowledge-tree-row--file",
                active && "ui-knowledge-tree-row--active"
              )}
              style={{ paddingLeft: `calc(0.25rem + ${depth} * 0.75rem)` }}
            >
              <span className="ui-knowledge-tree-chevron-spacer" aria-hidden />
              <FileText className="ui-knowledge-tree-icon" aria-hidden />
              <button
                type="button"
                className={cn("ui-knowledge-tree-label", active && "font-medium")}
                title={`${node.relativePath} · double-click to rename file`}
                onClick={() => onSelectFile(node.relativePath)}
                onDoubleClick={(e) => {
                  e.preventDefault();
                  onFileDoubleClick?.(node.relativePath);
                }}
              >
                {node.name}
              </button>
            </div>
          );
        }
        const dirKey = dirPrefix ? `${dirPrefix}/${node.name}` : node.name;
        const expanded = expandedDirs.has(dirKey);
        return (
          <div key={dirKey}>
            <div
              className={cn("ui-knowledge-tree-row", "ui-knowledge-tree-row--dir")}
              style={{ paddingLeft: `calc(0.25rem + ${depth} * 0.75rem)` }}
            >
              <button
                type="button"
                className="ui-knowledge-tree-chevron"
                aria-expanded={expanded}
                aria-label={expanded ? `Collapse ${node.name}` : `Expand ${node.name}`}
                onClick={() => toggleDir(dirKey)}
              >
                {expanded ? <ChevronDown className="ui-icon-sm" /> : <ChevronRight className="ui-icon-sm" />}
              </button>
              <div className="ui-knowledge-tree-dir-row-body">
                <button
                  type="button"
                  className="ui-knowledge-tree-dir-toggle"
                  title="Use the arrow to expand or collapse. Double-click the name to rename this folder."
                  onDoubleClick={(e) => {
                    e.preventDefault();
                    onFolderDoubleClick?.(dirKey);
                  }}
                >
                  <Folder className="ui-knowledge-tree-icon" aria-hidden />
                  <span className="ui-knowledge-tree-dir-name">{node.name}</span>
                </button>
                <button
                  type="button"
                  className="ui-knowledge-tree-add-file"
                  aria-label={`New document in ${node.name}`}
                  title="New document in this folder"
                  onClick={(e) => {
                    e.stopPropagation();
                    onRequestNewInFolder(dirKey);
                  }}
                >
                  <Plus className="ui-icon-sm" aria-hidden />
                </button>
              </div>
            </div>
            {expanded ? (
              <KnowledgeTreeNav
                nodes={node.children}
                depth={depth + 1}
                dirPrefix={dirKey}
                expandedDirs={expandedDirs}
                toggleDir={toggleDir}
                selectedPath={selectedPath}
                onSelectFile={onSelectFile}
                onRequestNewInFolder={onRequestNewInFolder}
                onFileDoubleClick={onFileDoubleClick}
                onFolderDoubleClick={onFolderDoubleClick}
              />
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

export function SettingsKnowledgePageClient({
  companyId,
  companies
}: {
  companyId: string | null;
  companies: Array<{ id: string; name: string }>;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [tree, setTree] = useState<KnowledgeTreeNode[]>([]);
  const [flatPaths, setFlatPaths] = useState<string[]>([]);
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    setExpandedDirs(new Set(collectAllDirectoryKeys(tree, "")));
  }, [tree]);

  const toggleDir = useCallback((dirKey: string) => {
    setExpandedDirs((prev) => {
      const next = new Set(prev);
      if (next.has(dirKey)) {
        next.delete(dirKey);
      } else {
        next.add(dirKey);
      }
      return next;
    });
  }, []);

  const urlPath = searchParams.get("path") ?? "";
  const [selectedPath, setSelectedPath] = useState<string | null>(null);

  const searchParamsRef = useRef(searchParams);
  searchParamsRef.current = searchParams;

  const syncPathToUrl = useCallback(
    (path: string | null) => {
      if (!companyId) {
        return;
      }
      const next = new URLSearchParams(searchParamsRef.current.toString());
      next.set("companyId", companyId);
      if (path) {
        next.set("path", path);
      } else {
        next.delete("path");
      }
      router.replace(`${pathname}?${next.toString()}` as Route);
    },
    [companyId, pathname, router]
  );

  const refreshList = useCallback(async () => {
    if (!companyId) {
      return;
    }
    const res = await apiGet<CompanyKnowledgeListResponse>("/observability/company-knowledge", companyId);
    setTree(res.data.tree ?? []);
    setFlatPaths(res.data.items.map((i) => i.relativePath));
  }, [companyId]);

  useEffect(() => {
    if (!companyId) {
      setListLoading(false);
      setTree([]);
      setFlatPaths([]);
      return;
    }
    let cancelled = false;
    setListLoading(true);
    setListError(null);
    void (async () => {
      try {
        await refreshList();
      } catch (error) {
        if (!cancelled) {
          setListError(error instanceof ApiError ? error.message : "Failed to load knowledge.");
        }
      } finally {
        if (!cancelled) {
          setListLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [companyId, refreshList]);

  const [baselineContent, setBaselineContent] = useState("");
  const [draftContent, setDraftContent] = useState("");
  const [fileError, setFileError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [settledKey, setSettledKey] = useState("");
  const [hydrateVersion, setHydrateVersion] = useState(0);
  const [addOpen, setAddOpen] = useState(false);
  const [newFileParentPrefix, setNewFileParentPrefix] = useState("");
  const [newFileName, setNewFileName] = useState("new-page.md");
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [folderDialogOpen, setFolderDialogOpen] = useState(false);
  const [newFolderPathInput, setNewFolderPathInput] = useState("");
  const [folderCreateBusy, setFolderCreateBusy] = useState(false);
  const [folderCreateError, setFolderCreateError] = useState<string | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  type KnowledgeEditDialog =
    | { kind: "closed" }
    | { kind: "renameFile"; relativePath: string }
    | { kind: "renameFolder"; dirKey: string };
  const [knowledgeEditDialog, setKnowledgeEditDialog] = useState<KnowledgeEditDialog>({ kind: "closed" });
  const [editTitleDraft, setEditTitleDraft] = useState("");
  const [folderNameDraft, setFolderNameDraft] = useState("");
  const [editDialogError, setEditDialogError] = useState<string | null>(null);
  const [renameBusy, setRenameBusy] = useState(false);

  const draftContentRef = useRef(draftContent);
  const baselineContentRef = useRef(baselineContent);
  const selectedPathRef = useRef(selectedPath);
  const companyIdRef = useRef(companyId);
  draftContentRef.current = draftContent;
  baselineContentRef.current = baselineContent;
  selectedPathRef.current = selectedPath;
  companyIdRef.current = companyId;

  const autosaveDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flushKnowledgeAutosave = useCallback(async () => {
    if (autosaveDebounceRef.current) {
      clearTimeout(autosaveDebounceRef.current);
      autosaveDebounceRef.current = null;
    }
    const path = selectedPathRef.current;
    const cid = companyIdRef.current;
    if (!path || !cid) {
      return;
    }
    const content = draftContentRef.current;
    const baseline = baselineContentRef.current;
    if (content === baseline) {
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      const q = `/observability/company-knowledge/file?path=${encodeURIComponent(path)}`;
      await apiPut(q, cid, { content });
      if (selectedPathRef.current === path) {
        setBaselineContent(content);
        baselineContentRef.current = content;
      }
    } catch (error) {
      if (selectedPathRef.current === path) {
        setSaveError(error instanceof ApiError ? error.message : "Save failed.");
      }
    } finally {
      setSaving(false);
    }
  }, []);

  useEffect(() => {
    if (listLoading || !companyId) {
      return;
    }
    let next: string | null | undefined;
    if (urlPath && flatPaths.includes(urlPath)) {
      next = urlPath;
    } else if (!urlPath) {
      next = null;
    } else {
      return;
    }
    if (next === selectedPathRef.current) {
      return;
    }
    let cancelled = false;
    void (async () => {
      await flushKnowledgeAutosave();
      if (cancelled || listLoading || !companyId) {
        return;
      }
      const u = searchParamsRef.current.get("path") ?? "";
      let resolved: string | null;
      if (u && flatPaths.includes(u)) {
        resolved = u;
      } else if (!u) {
        resolved = null;
      } else {
        return;
      }
      setSelectedPath(resolved);
    })();
    return () => {
      cancelled = true;
    };
  }, [listLoading, companyId, urlPath, flatPaths, flushKnowledgeAutosave]);

  const loadKey = selectedPath ?? "";
  const loadKeyRef = useRef(loadKey);
  loadKeyRef.current = loadKey;

  const isMarkdown = selectedPath?.toLowerCase().endsWith(".md") ?? false;

  const dirty = selectedPath !== null && draftContent !== baselineContent;
  const editorReady = Boolean(loadKey && settledKey === loadKey && !fileError);
  const editorLoading = Boolean(loadKey && settledKey !== loadKey && !fileError);

  useEffect(() => {
    if (knowledgeEditDialog.kind === "renameFile" && !listLoading && companyId) {
      if (!flatPaths.includes(knowledgeEditDialog.relativePath)) {
        setKnowledgeEditDialog({ kind: "closed" });
        setEditDialogError(null);
      }
    }
  }, [knowledgeEditDialog, flatPaths, listLoading, companyId]);

  useEffect(() => {
    if (knowledgeEditDialog.kind === "renameFile") {
      const { stem } = knowledgeStemAndExtFromBasename(
        knowledgeBasenameFromRelativePath(knowledgeEditDialog.relativePath)
      );
      setEditTitleDraft(stem);
      setEditDialogError(null);
    } else if (knowledgeEditDialog.kind === "renameFolder") {
      const dk = knowledgeEditDialog.dirKey;
      const seg = dk.includes("/") ? dk.slice(dk.lastIndexOf("/") + 1) : dk;
      setFolderNameDraft(seg);
      setEditDialogError(null);
    }
  }, [knowledgeEditDialog]);

  useLayoutEffect(() => {
    setFileError(null);
    if (!loadKey) {
      setBaselineContent("");
      setDraftContent("");
      setSettledKey("");
      return;
    }
    setBaselineContent("");
    setDraftContent("");
    setSettledKey("");
  }, [loadKey]);

  useEffect(() => {
    if (!companyId || !loadKey) {
      return;
    }
    const snapshot = loadKey;
    const q = `/observability/company-knowledge/file?path=${encodeURIComponent(snapshot)}`;
    let cancelled = false;
    void (async () => {
      try {
        const res = await apiGet<FileBodyResponse>(q, companyId);
        if (cancelled || loadKeyRef.current !== snapshot) {
          return;
        }
        const text = res.data.content ?? "";
        setBaselineContent(text);
        setDraftContent(text);
        setFileError(null);
        setSettledKey(snapshot);
        setHydrateVersion((v) => v + 1);
      } catch (error) {
        if (!cancelled && loadKeyRef.current === snapshot) {
          setFileError(error instanceof ApiError ? error.message : "Failed to load file.");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [companyId, loadKey]);

  useEffect(() => {
    if (!companyId || !selectedPath || !editorReady) {
      if (autosaveDebounceRef.current) {
        clearTimeout(autosaveDebounceRef.current);
        autosaveDebounceRef.current = null;
      }
      return;
    }
    if (draftContent === baselineContent) {
      if (autosaveDebounceRef.current) {
        clearTimeout(autosaveDebounceRef.current);
        autosaveDebounceRef.current = null;
      }
      return;
    }
    if (autosaveDebounceRef.current) {
      clearTimeout(autosaveDebounceRef.current);
    }
    autosaveDebounceRef.current = setTimeout(() => {
      autosaveDebounceRef.current = null;
      void flushKnowledgeAutosave();
    }, 900);
    return () => {
      if (autosaveDebounceRef.current) {
        clearTimeout(autosaveDebounceRef.current);
        autosaveDebounceRef.current = null;
      }
    };
  }, [
    companyId,
    selectedPath,
    editorReady,
    draftContent,
    baselineContent,
    flushKnowledgeAutosave
  ]);

  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (!selectedPathRef.current) {
        return;
      }
      if (draftContentRef.current === baselineContentRef.current) {
        return;
      }
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, []);

  async function createFile() {
    if (!companyId || !newFileParentPrefix) {
      return;
    }
    const name = newFileName.trim().replace(/\\/g, "/");
    if (!name) {
      return;
    }
    if (name.includes("/") || name.includes("..")) {
      setCreateError("Enter a filename only (no path separators or ..).");
      return;
    }
    if (name.startsWith(".")) {
      setCreateError("Filename cannot start with a dot.");
      return;
    }
    const lower = name.toLowerCase();
    const ext = lower.includes(".") ? lower.slice(lower.lastIndexOf(".")) : "";
    const allowed = new Set([".md", ".yaml", ".yml", ".txt", ".json"]);
    if (!allowed.has(ext)) {
      setCreateError("Allowed extensions: .md, .yaml, .yml, .txt, .json.");
      return;
    }
    const trimmed = `${newFileParentPrefix}/${name}`;
    setCreateError(null);
    setCreateBusy(true);
    try {
      await flushKnowledgeAutosave();
      await apiPost("/observability/company-knowledge/file", companyId, { path: trimmed });
      handleAddDialogOpenChange(false);
      await refreshList();
      setSelectedPath(trimmed);
      syncPathToUrl(trimmed);
    } catch (error) {
      setCreateError(error instanceof ApiError ? error.message : "Could not create file.");
    } finally {
      setCreateBusy(false);
    }
  }

  async function createFolderWithStarterFile() {
    if (!companyId) {
      return;
    }
    const parsed = parseKnowledgeFolderInput(newFolderPathInput);
    if (!parsed.ok) {
      setFolderCreateError(parsed.message);
      return;
    }
    const trimmed = `${parsed.prefix}/new-page.md`;
    setFolderCreateError(null);
    setFolderCreateBusy(true);
    try {
      await flushKnowledgeAutosave();
      await apiPost("/observability/company-knowledge/file", companyId, { path: trimmed });
      handleFolderDialogOpenChange(false);
      await refreshList();
      setExpandedDirs((prev) => {
        const next = new Set(prev);
        let acc = "";
        for (const seg of parsed.prefix.split("/")) {
          acc = acc ? `${acc}/${seg}` : seg;
          next.add(acc);
        }
        return next;
      });
      setSelectedPath(trimmed);
      syncPathToUrl(trimmed);
    } catch (error) {
      setFolderCreateError(error instanceof ApiError ? error.message : "Could not create folder.");
    } finally {
      setFolderCreateBusy(false);
    }
  }

  async function performDeleteKnowledgeFile() {
    if (!companyId || knowledgeEditDialog.kind !== "renameFile") {
      return;
    }
    const path = knowledgeEditDialog.relativePath;
    setEditDialogError(null);
    setDeleteBusy(true);
    try {
      await flushKnowledgeAutosave();
      if (draftContentRef.current !== baselineContentRef.current) {
        setEditDialogError("Finish saving before deleting.");
        return;
      }
      const q = `/observability/company-knowledge/file?path=${encodeURIComponent(path)}`;
      await apiDelete(q, companyId);
      setKnowledgeEditDialog({ kind: "closed" });
      if (selectedPathRef.current === path) {
        setSelectedPath(null);
        syncPathToUrl(null);
        setBaselineContent("");
        setDraftContent("");
      }
      await refreshList();
    } catch (error) {
      setEditDialogError(error instanceof ApiError ? error.message : "Delete failed.");
    } finally {
      setDeleteBusy(false);
    }
  }

  async function applyKnowledgeFileRenameSave() {
    if (!companyId || knowledgeEditDialog.kind !== "renameFile") {
      return;
    }
    const filePath = knowledgeEditDialog.relativePath;
    const parsedStem = parseKnowledgeTitleStemInput(editTitleDraft);
    if (!parsedStem.ok) {
      setEditDialogError(parsedStem.message);
      return;
    }
    const { ext } = knowledgeStemAndExtFromBasename(knowledgeBasenameFromRelativePath(filePath));
    const filename = `${parsedStem.stem}${ext}`;
    const parent = knowledgeParentPrefixFromRelativePath(filePath);
    const nextPath = knowledgeRelativePathFromParentAndFilename(parent, filename);
    const segmentCount = nextPath.split("/").filter(Boolean).length;
    if (segmentCount > KNOWLEDGE_MAX_PATH_SEGMENTS) {
      setEditDialogError("Too many path segments.");
      return;
    }
    const fullParse = parseKnowledgeRelativePathInput(nextPath);
    if (!fullParse.ok) {
      setEditDialogError(fullParse.message);
      return;
    }
    setEditDialogError(null);
    if (fullParse.path === filePath) {
      setKnowledgeEditDialog({ kind: "closed" });
      return;
    }
    setRenameBusy(true);
    try {
      await flushKnowledgeAutosave();
      if (draftContentRef.current !== baselineContentRef.current) {
        setEditDialogError("Finish saving before renaming.");
        return;
      }
      await apiPatch("/observability/company-knowledge/file", companyId, {
        from: filePath,
        to: fullParse.path
      });
      const next = fullParse.path;
      setExpandedDirs((prev) => {
        const nextSet = new Set(prev);
        const segs = next.split("/");
        let acc = "";
        for (let i = 0; i < segs.length - 1; i++) {
          acc = acc ? `${acc}/${segs[i]}` : segs[i]!;
          nextSet.add(acc);
        }
        return nextSet;
      });
      setKnowledgeEditDialog({ kind: "closed" });
      if (selectedPathRef.current === filePath) {
        setSelectedPath(next);
        syncPathToUrl(next);
      }
      await refreshList();
    } catch (e) {
      setEditDialogError(e instanceof ApiError ? e.message : "Rename failed.");
    } finally {
      setRenameBusy(false);
    }
  }

  async function applyKnowledgeFolderRenameSave() {
    if (!companyId || knowledgeEditDialog.kind !== "renameFolder") {
      return;
    }
    const dirKey = knowledgeEditDialog.dirKey;
    const parsedSeg = parseKnowledgeFolderSegmentInput(folderNameDraft);
    if (!parsedSeg.ok) {
      setEditDialogError(parsedSeg.message);
      return;
    }
    const currentSeg = dirKey.includes("/") ? dirKey.slice(dirKey.lastIndexOf("/") + 1) : dirKey;
    if (parsedSeg.segment === currentSeg) {
      setKnowledgeEditDialog({ kind: "closed" });
      return;
    }
    const parent = dirKey.includes("/") ? dirKey.slice(0, dirKey.lastIndexOf("/")) : "";
    const toPrefix = parent ? `${parent}/${parsedSeg.segment}` : parsedSeg.segment;
    const fullParse = parseKnowledgeFolderInput(toPrefix);
    if (!fullParse.ok) {
      setEditDialogError(fullParse.message);
      return;
    }
    setEditDialogError(null);
    setRenameBusy(true);
    try {
      await flushKnowledgeAutosave();
      if (draftContentRef.current !== baselineContentRef.current) {
        setEditDialogError("Finish saving before renaming.");
        return;
      }
      const fromP = dirKey;
      const toP = fullParse.prefix;
      await apiPatch("/observability/company-knowledge/folder", companyId, {
        from: fromP,
        to: toP
      });
      setKnowledgeEditDialog({ kind: "closed" });
      setExpandedDirs((prev) => {
        const next = new Set<string>();
        for (const k of prev) {
          if (k === fromP || k.startsWith(`${fromP}/`)) {
            next.add(k === fromP ? toP : `${toP}${k.slice(fromP.length)}`);
          } else {
            next.add(k);
          }
        }
        return next;
      });
      const sp = selectedPathRef.current;
      if (sp && sp.startsWith(`${fromP}/`)) {
        const np = `${toP}${sp.slice(fromP.length)}`;
        setSelectedPath(np);
        syncPathToUrl(np);
      }
      await refreshList();
    } catch (e) {
      setEditDialogError(e instanceof ApiError ? e.message : "Rename folder failed.");
    } finally {
      setRenameBusy(false);
    }
  }

  const handleKnowledgeEditDialogOpenChange = useCallback((open: boolean) => {
    if (!open) {
      setKnowledgeEditDialog({ kind: "closed" });
      setEditDialogError(null);
    }
  }, []);

  const fileRenameStemParsed =
    knowledgeEditDialog.kind === "renameFile"
      ? parseKnowledgeTitleStemInput(editTitleDraft)
      : { ok: false as const, message: "" };
  const fileRenameTitleUnchanged =
    knowledgeEditDialog.kind === "renameFile" &&
    fileRenameStemParsed.ok &&
    knowledgeRelativePathFromParentAndFilename(
      knowledgeParentPrefixFromRelativePath(knowledgeEditDialog.relativePath),
      `${fileRenameStemParsed.stem}${knowledgeStemAndExtFromBasename(knowledgeBasenameFromRelativePath(knowledgeEditDialog.relativePath)).ext}`
    ) === knowledgeEditDialog.relativePath;
  const fileRenameSaveDisabled =
    knowledgeEditDialog.kind !== "renameFile" ||
    !companyId ||
    !fileRenameStemParsed.ok ||
    renameBusy ||
    deleteBusy ||
    (!fileRenameTitleUnchanged && saving);

  const folderSegParsed =
    knowledgeEditDialog.kind === "renameFolder"
      ? parseKnowledgeFolderSegmentInput(folderNameDraft)
      : { ok: false as const, message: "" };
  const folderRenameUnchanged =
    knowledgeEditDialog.kind === "renameFolder" &&
    folderSegParsed.ok &&
    folderSegParsed.segment ===
      (knowledgeEditDialog.dirKey.includes("/")
        ? knowledgeEditDialog.dirKey.slice(knowledgeEditDialog.dirKey.lastIndexOf("/") + 1)
        : knowledgeEditDialog.dirKey);
  const folderRenameSaveDisabled =
    knowledgeEditDialog.kind !== "renameFolder" ||
    !companyId ||
    !folderSegParsed.ok ||
    folderRenameUnchanged ||
    renameBusy ||
    deleteBusy ||
    (!folderRenameUnchanged && saving);

  const knowledgeEditSaveDisabled =
    knowledgeEditDialog.kind === "closed" ||
    (knowledgeEditDialog.kind === "renameFile" ? fileRenameSaveDisabled : folderRenameSaveDisabled);

  const onKnowledgeFileDoubleClick = useCallback((relativePath: string) => {
    setKnowledgeEditDialog({ kind: "renameFile", relativePath });
  }, []);

  const onKnowledgeFolderDoubleClick = useCallback((dirKey: string) => {
    setKnowledgeEditDialog({ kind: "renameFolder", dirKey });
  }, []);

  const openCreateDocumentDialog = useCallback((folderPathPrefix: string) => {
    setCreateError(null);
    setNewFileParentPrefix(folderPathPrefix);
    setNewFileName("new-page.md");
    setExpandedDirs((prev) => {
      const next = new Set(prev);
      next.add(folderPathPrefix);
      return next;
    });
    setAddOpen(true);
  }, []);

  const handleAddDialogOpenChange = useCallback((open: boolean) => {
    setAddOpen(open);
    if (!open) {
      setCreateError(null);
      setNewFileParentPrefix("");
      setNewFileName("new-page.md");
    }
  }, []);

  const handleFolderDialogOpenChange = useCallback((open: boolean) => {
    setFolderDialogOpen(open);
    if (!open) {
      setFolderCreateError(null);
      setNewFolderPathInput("");
    }
  }, []);

  const openFolderDialog = useCallback(() => {
    setFolderCreateError(null);
    setNewFolderPathInput("");
    setFolderDialogOpen(true);
  }, []);

  const secondaryPane = (
    <div className="run-sidebar-pane">
      {listLoading ? null : listError ? (
        <Alert variant="destructive" className="ui-settings-skills-sidebar-alert">
          <AlertDescription>{listError}</AlertDescription>
        </Alert>
      ) : (
        <div className="run-sidebar-list">
          <div className="ui-knowledge-files-header">
            <div className="ui-agent-docs-sidebar-section-label ui-knowledge-files-header-label">Files</div>
            <button
              type="button"
              className="ui-knowledge-files-header-add-folder"
              aria-label="New folder"
              title="New folder"
              disabled={!companyId}
              onClick={openFolderDialog}
            >
              <Plus className="ui-icon-sm" aria-hidden />
            </button>
          </div>
          {tree.length === 0 ? (
            <p className="ui-agent-docs-sidebar-empty">No knowledge files yet.</p>
          ) : (
            <div className="ui-knowledge-tree">
              <KnowledgeTreeNav
                nodes={tree}
                depth={0}
                dirPrefix=""
                expandedDirs={expandedDirs}
                toggleDir={toggleDir}
                selectedPath={selectedPath}
                onSelectFile={(p) => {
                  void (async () => {
                    await flushKnowledgeAutosave();
                    setSelectedPath(p);
                    syncPathToUrl(p);
                  })();
                }}
                onRequestNewInFolder={(folderPrefix) => openCreateDocumentDialog(folderPrefix)}
                onFileDoubleClick={onKnowledgeFileDoubleClick}
                onFolderDoubleClick={onKnowledgeFolderDoubleClick}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );

  const headerDescription = selectedPath ? `knowledge / ${selectedPath}` : "Pick a file or create one";

  return (
    <>
      <AppShell
        activeNav="Knowledge"
        companies={companies}
        activeCompanyId={companyId}
        leftPaneScrollable={false}
        secondaryPane={companyId ? secondaryPane : null}
        leftPane={
          <div className="run-detail-pane">
            <SectionHeading
              title="Knowledge"
              description={headerDescription}
              actions={
                <div className="ui-agent-docs-header-actions">
                  {companyId && selectedPath ? (
                    <>
                      {editorReady ? (
                        <span className="ui-knowledge-autosave-status">
                          {saving ? "Saving…" : dirty ? null : "Saved"}
                        </span>
                      ) : null}
                      <Button
                        size="sm"
                        variant="outline"
                        type="button"
                        onClick={() => {
                          if (selectedPath) {
                            setKnowledgeEditDialog({ kind: "renameFile", relativePath: selectedPath });
                          }
                        }}
                        disabled={saving}
                      >
                        Edit
                      </Button>
                    </>
                  ) : null}
                </div>
              }
            />
            {saveError ? (
              <Alert variant="destructive" className="ui-alert--mb-section">
                <AlertDescription>{saveError}</AlertDescription>
              </Alert>
            ) : null}
            {!selectedPath ? (
              <p className="ui-issue-muted-text">
                Select a file from the list, use + beside Files to add a folder, or + beside a folder to add a file.
              </p>
            ) : fileError ? (
              <Alert variant="destructive">
                <AlertDescription>{fileError}</AlertDescription>
              </Alert>
            ) : isMarkdown ? (
              <div className="ui-agent-docs-editor-shell">
                {editorLoading ? (
                  <div className="ui-agent-docs-editor-loading">Loading…</div>
                ) : editorReady ? (
                  <KnowledgeTiptapEditor
                    hydrateVersion={hydrateVersion}
                    markdown={draftContent}
                    onMarkdownChange={setDraftContent}
                    placeholder="Write markdown…"
                  />
                ) : fileError ? (
                  <div className="ui-agent-docs-editor-loading">Could not load this file.</div>
                ) : null}
              </div>
            ) : (
              <Textarea
                className="ui-knowledge-plain-editor"
                value={draftContent}
                onChange={(e) => setDraftContent(e.target.value)}
              />
            )}
          </div>
        }
      />
      <Dialog
        open={knowledgeEditDialog.kind !== "closed"}
        onOpenChange={handleKnowledgeEditDialogOpenChange}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {knowledgeEditDialog.kind === "renameFolder" ? "Rename folder" : "Rename knowledge file"}
            </DialogTitle>
            <DialogDescription>
              {knowledgeEditDialog.kind === "renameFolder" ? (
                <>
                  Renames this folder for every file inside it.
                </>
              ) : (
                <>Change the file name.</>
              )}
            </DialogDescription>
          </DialogHeader>
          {knowledgeEditDialog.kind === "renameFile" ? (
            <Field>
              <FieldLabel>Title</FieldLabel>
              <Input
                value={editTitleDraft}
                onChange={(e) => setEditTitleDraft(e.target.value)}
                placeholder={
                  knowledgeStemAndExtFromBasename(
                    knowledgeBasenameFromRelativePath(knowledgeEditDialog.relativePath)
                  ).stem || "Untitled"
                }
                autoComplete="off"
                spellCheck={false}
              />
            </Field>
          ) : null}
          {knowledgeEditDialog.kind === "renameFolder" ? (
            <>
              <Field>
                <FieldLabel>Folder name</FieldLabel>
                <Input
                  value={folderNameDraft}
                  onChange={(e) => setFolderNameDraft(e.target.value)}
                  placeholder={
                    knowledgeEditDialog.dirKey.includes("/")
                      ? knowledgeEditDialog.dirKey.slice(knowledgeEditDialog.dirKey.lastIndexOf("/") + 1)
                      : knowledgeEditDialog.dirKey
                  }
                  autoComplete="off"
                  spellCheck={false}
                />
              </Field>
              {knowledgeEditDialog.dirKey.includes("/") ? (
                <p className="ui-issue-muted-text ui-knowledge-edit-folder-hint">
                  Parent:{" "}
                  <code className="ui-dialog-description-inline-code">
                    {knowledgeEditDialog.dirKey.slice(0, knowledgeEditDialog.dirKey.lastIndexOf("/"))}/
                  </code>
                </p>
              ) : null}
            </>
          ) : null}
          {editDialogError ? (
            <Alert variant="destructive">
              <AlertDescription>{editDialogError}</AlertDescription>
            </Alert>
          ) : null}
          <DialogFooter>
            {knowledgeEditDialog.kind === "renameFile" ? (
              <Button
                type="button"
                variant="ghost"
                onClick={() => void performDeleteKnowledgeFile()}
                disabled={deleteBusy || renameBusy || saving}
              >
                {deleteBusy ? "Deleting…" : "Delete"}
              </Button>
            ) : null}
            <Button
              type="button"
              onClick={() =>
                void (knowledgeEditDialog.kind === "renameFolder"
                  ? applyKnowledgeFolderRenameSave()
                  : applyKnowledgeFileRenameSave())
              }
              disabled={knowledgeEditSaveDisabled}
            >
              {renameBusy ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={addOpen} onOpenChange={handleAddDialogOpenChange}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New knowledge file</DialogTitle>
            <DialogDescription>
              File will be created in{" "}
              <code className="ui-dialog-description-inline-code">
                {newFileParentPrefix ? `${newFileParentPrefix}/` : "…"}
              </code>
            </DialogDescription>
          </DialogHeader>
          <Field>
            <FieldLabel>Filename</FieldLabel>
            <Input
              value={newFileName}
              onChange={(e) => setNewFileName(e.target.value)}
              placeholder="new-page.md"
              autoFocus
            />
          </Field>
          {createError ? (
            <Alert variant="destructive">
              <AlertDescription>{createError}</AlertDescription>
            </Alert>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => handleAddDialogOpenChange(false)}>
              Cancel
            </Button>
            <Button type="button" onClick={() => void createFile()} disabled={createBusy}>
              {createBusy ? "Creating…" : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={folderDialogOpen} onOpenChange={handleFolderDialogOpenChange}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New folder</DialogTitle>
            <DialogDescription>
              Path under company knowledge (e.g. <code className="ui-dialog-description-inline-code">playbooks</code> or{" "}
              <code className="ui-dialog-description-inline-code">guides/onboarding</code>). An empty{" "}
              <code className="ui-dialog-description-inline-code">new-page.md</code> is created so the folder appears in the tree.
            </DialogDescription>
          </DialogHeader>
          <Field>
            <FieldLabel>Folder path</FieldLabel>
            <Input
              value={newFolderPathInput}
              onChange={(e) => setNewFolderPathInput(e.target.value)}
              placeholder="playbooks"
              autoFocus
            />
          </Field>
          {folderCreateError ? (
            <Alert variant="destructive">
              <AlertDescription>{folderCreateError}</AlertDescription>
            </Alert>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => handleFolderDialogOpenChange(false)}>
              Cancel
            </Button>
            <Button type="button" onClick={() => void createFolderWithStarterFile()} disabled={folderCreateBusy}>
              {folderCreateBusy ? "Creating…" : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
