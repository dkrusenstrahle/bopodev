"use client";

import type { Route } from "next";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, FilePenLine, FileText, Folder, Link2, Plus } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import createAgentModalStyles from "@/components/modals/create-agent-modal.module.scss";
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
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ApiError, apiDelete, apiGet, apiPatch, apiPost, apiPut } from "@/lib/api";
import { cn } from "@/lib/utils";
import { SectionHeading } from "@/components/workspace/shared";

type DocKind = "builtin" | "company";

interface BuiltinSkillRow {
  id: string;
  title: string;
  content: string;
}

interface CompanySkillsListResponse {
  items: Array<{
    skillId: string;
    linkedUrl: string | null;
    linkLastFetchedAt: string | null;
    hasLocalSkillMd: boolean;
    sidebarTitle: string | null;
    files: Array<{ relativePath: string }>;
  }>;
}

interface FileBodyResponse {
  content: string;
}

function pickDefaultCompanyFile(paths: string[]) {
  const skillMd = paths.find((p) => p === "SKILL.md" || p.toLowerCase().endsWith("/skill.md"));
  if (skillMd) {
    return skillMd;
  }
  return paths[0] ?? "";
}

function parseOpenFromUrl(
  kind: DocKind | null,
  skillId: string,
  path: string,
  builtinIds: string[],
  companyItems: CompanySkillsListResponse["items"]
): { kind: DocKind; skillId: string; relativePath: string } | null {
  if (kind === "builtin" && skillId && builtinIds.includes(skillId)) {
    return { kind: "builtin", skillId, relativePath: "" };
  }
  if (kind === "company" && skillId) {
    const pack = companyItems.find((row) => row.skillId === skillId);
    if (!pack) {
      return null;
    }
    const paths = pack.files.map((f) => f.relativePath);
    const rel = path && paths.includes(path) ? path : pickDefaultCompanyFile(paths);
    if (!rel) {
      return null;
    }
    return { kind: "company", skillId, relativePath: rel };
  }
  return null;
}

const SKILL_SIDEBAR_FILE_EXTS = new Set([".md", ".yaml", ".yml", ".txt", ".json"]);

function skillSidebarFileDisplayName(relativePath: string): string {
  const base = relativePath.includes("/")
    ? relativePath.slice(relativePath.lastIndexOf("/") + 1)
    : relativePath;
  const lower = base.toLowerCase();
  const dot = base.lastIndexOf(".");
  if (dot > 0) {
    const ext = lower.slice(dot);
    if (SKILL_SIDEBAR_FILE_EXTS.has(ext)) {
      return base.slice(0, dot);
    }
  }
  return base;
}

function parseSkillSidebarTitleInput(
  input: string,
  skillId: string
): { ok: true; apiTitle: string } | { ok: false; message: string } {
  const s = input.trim();
  if (!s) {
    return { ok: true, apiTitle: "" };
  }
  if (s.length > 200) {
    return { ok: false, message: "Title must be at most 200 characters." };
  }
  if (/[\r\n]/.test(s)) {
    return { ok: false, message: "Title cannot contain line breaks." };
  }
  if (s === skillId) {
    return { ok: true, apiTitle: "" };
  }
  return { ok: true, apiTitle: s };
}

function companySkillSidebarLabel(
  pack: CompanySkillsListResponse["items"][number]
): string {
  return pack.sidebarTitle?.trim() || pack.skillId;
}

const SKILL_PACK_MAX_SEGMENTS = 32;
const SKILL_PACK_EXT_STRIP_ORDER = [".yaml", ".yml", ".json", ".txt", ".md"] as const;

function skillPackBasenameFromRelativePath(relativePath: string): string {
  const i = relativePath.lastIndexOf("/");
  return i === -1 ? relativePath : relativePath.slice(i + 1);
}

function skillPackStemAndExtFromBasename(basename: string): { stem: string; ext: string } {
  const lower = basename.toLowerCase();
  const dot = basename.lastIndexOf(".");
  if (dot > 0) {
    const ext = lower.slice(dot);
    if (SKILL_SIDEBAR_FILE_EXTS.has(ext)) {
      return { stem: basename.slice(0, dot), ext };
    }
  }
  return { stem: basename, ext: ".md" };
}

function parseSkillPackTitleStemInput(
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
  for (const ext of SKILL_PACK_EXT_STRIP_ORDER) {
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

function skillPackParentPrefixFromRelativePath(relativePath: string): string {
  const i = relativePath.lastIndexOf("/");
  return i === -1 ? "" : relativePath.slice(0, i);
}

function skillPackPathFromParentAndFilename(parentPrefix: string, filename: string): string {
  const p = parentPrefix.trim();
  return p ? `${p}/${filename}` : filename;
}

function parseSkillPackRelativePathInput(
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
  if (parts.length === 0 || parts.length > SKILL_PACK_MAX_SEGMENTS) {
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
  if (!SKILL_SIDEBAR_FILE_EXTS.has(ext)) {
    return { ok: false, message: "Allowed extensions: .md, .yaml, .yml, .txt, .json." };
  }
  return { ok: true, path: normalized };
}

type SkillsTreeNavNode =
  | { kind: "builtinFile"; skillId: string; label: string }
  | {
      kind: "companyFile";
      skillId: string;
      relativePath: string;
      label: string;
      linked?: boolean;
      linkTitle?: string;
      /** Double-click opens sidebar title (single-file pack row) or file rename (multi-file child). */
      doubleClickTarget: "sidebarTitle" | "renameFile";
    }
  | {
      kind: "folder";
      name: string;
      /** Stable path segment for expand/collapse state (defaults to `name`). */
      treeSegment?: string;
      /** When set: expand/collapse only via chevron; double-click folder name edits sidebar title. */
      sidebarDoubleClickSkillId?: string;
      showAdd?: boolean;
      linked?: boolean;
      linkTitle?: string;
      emptyMessage?: string;
      children: SkillsTreeNavNode[];
    };

type OpenSelection = { kind: DocKind; skillId: string; relativePath: string };

function SkillsTreeNav({
  nodes,
  depth,
  dirPrefix,
  expandedDirs,
  toggleDir,
  open,
  onSelectBuiltin,
  onSelectCompanyFile,
  onAddSkillInCustom,
  onCompanyFolderSidebarDoubleClick,
  onCompanyFileDoubleClick
}: {
  nodes: SkillsTreeNavNode[];
  depth: number;
  dirPrefix: string;
  expandedDirs: Set<string>;
  toggleDir: (dirKey: string) => void;
  open: OpenSelection | null;
  onSelectBuiltin: (skillId: string) => void;
  onSelectCompanyFile: (skillId: string, relativePath: string) => void;
  onAddSkillInCustom: () => void;
  onCompanyFolderSidebarDoubleClick?: (skillId: string) => void;
  onCompanyFileDoubleClick?: (
    skillId: string,
    relativePath: string,
    target: "sidebarTitle" | "renameFile"
  ) => void;
}) {
  return (
    <div className="ui-knowledge-tree-children">
      {nodes.map((node) => {
        if (node.kind === "builtinFile") {
          const active = open?.kind === "builtin" && open.skillId === node.skillId;
          return (
            <div
              key={`builtin-${node.skillId}`}
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
                title={node.skillId}
                onClick={() => onSelectBuiltin(node.skillId)}
              >
                {node.label}
              </button>
            </div>
          );
        }
        if (node.kind === "companyFile") {
          const active =
            open?.kind === "company" &&
            open.skillId === node.skillId &&
            open.relativePath === node.relativePath;
          return (
            <div
              key={`company-${node.skillId}-${node.relativePath}`}
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
                title={
                  node.doubleClickTarget === "renameFile"
                    ? `${node.skillId} · ${node.relativePath} · double-click to rename file`
                    : `${node.skillId} · ${node.relativePath} · double-click to edit sidebar title`
                }
                onClick={() => onSelectCompanyFile(node.skillId, node.relativePath)}
                onDoubleClick={(e) => {
                  e.preventDefault();
                  onCompanyFileDoubleClick?.(node.skillId, node.relativePath, node.doubleClickTarget);
                }}
              >
                {node.label}
              </button>
              {node.linked ? (
                <span className="ui-settings-skills-linked-pill" title={node.linkTitle ?? "Linked from URL"}>
                  Linked
                </span>
              ) : null}
            </div>
          );
        }
        const segment = node.treeSegment ?? node.name;
        const dirKey = dirPrefix ? `${dirPrefix}/${segment}` : segment;
        const expanded = expandedDirs.has(dirKey);
        const chevronOnlyExpand = Boolean(node.sidebarDoubleClickSkillId);
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
                  title={
                    chevronOnlyExpand
                      ? "Use the arrow to expand or collapse. Double-click the name to rename this skill in the sidebar."
                      : undefined
                  }
                  onClick={chevronOnlyExpand ? undefined : () => toggleDir(dirKey)}
                  onDoubleClick={
                    node.sidebarDoubleClickSkillId
                      ? (e) => {
                          e.preventDefault();
                          onCompanyFolderSidebarDoubleClick?.(node.sidebarDoubleClickSkillId!);
                        }
                      : undefined
                  }
                >
                  <Folder className="ui-knowledge-tree-icon" aria-hidden />
                  <span className="ui-knowledge-tree-dir-name">{node.name}</span>
                </button>
                {node.linked ? (
                  <span className="ui-settings-skills-linked-pill" title={node.linkTitle ?? "Linked from URL"}>
                    Linked
                  </span>
                ) : null}
                {node.showAdd ? (
                  <button
                    type="button"
                    className="ui-knowledge-tree-add-file"
                    aria-label="Add skill"
                    title="Add skill"
                    onClick={(e) => {
                      e.stopPropagation();
                      onAddSkillInCustom();
                    }}
                  >
                    <Plus className="ui-icon-sm" aria-hidden />
                  </button>
                ) : null}
              </div>
            </div>
            {expanded ? (
              <>
                {node.emptyMessage && node.children.length === 0 ? (
                  <p
                    className="ui-agent-docs-sidebar-empty"
                    style={{ paddingLeft: `calc(0.25rem + ${(depth + 1) * 0.75}rem)` }}
                  >
                    {node.emptyMessage}
                  </p>
                ) : null}
                {node.children.length > 0 ? (
                  <SkillsTreeNav
                    nodes={node.children}
                    depth={depth + 1}
                    dirPrefix={dirKey}
                    expandedDirs={expandedDirs}
                    toggleDir={toggleDir}
                    open={open}
                    onSelectBuiltin={onSelectBuiltin}
                    onSelectCompanyFile={onSelectCompanyFile}
                    onAddSkillInCustom={onAddSkillInCustom}
                    onCompanyFolderSidebarDoubleClick={onCompanyFolderSidebarDoubleClick}
                    onCompanyFileDoubleClick={onCompanyFileDoubleClick}
                  />
                ) : null}
              </>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

export function SettingsSkillsPageClient({
  companyId,
  companies
}: {
  companyId: string | null;
  companies: Array<{ id: string; name: string }>;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [listsLoading, setListsLoading] = useState(true);
  const [listsError, setListsError] = useState<string | null>(null);
  const [builtinSkills, setBuiltinSkills] = useState<BuiltinSkillRow[]>([]);
  const [companyItems, setCompanyItems] = useState<CompanySkillsListResponse["items"]>([]);

  const [open, setOpen] = useState<{ kind: DocKind; skillId: string; relativePath: string } | null>(null);

  const [baselineContent, setBaselineContent] = useState("");
  const [draftContent, setDraftContent] = useState("");
  const [fileError, setFileError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [settledKey, setSettledKey] = useState("");
  const [hydrateVersion, setHydrateVersion] = useState(0);
  type SkillTreeEditDialog =
    | { kind: "closed" }
    | { kind: "sidebarTitle"; skillId: string }
    | { kind: "renameFile"; skillId: string; relativePath: string };
  const [skillTreeEditDialog, setSkillTreeEditDialog] = useState<SkillTreeEditDialog>({ kind: "closed" });
  const [editTitleDraft, setEditTitleDraft] = useState("");
  const [renameFileStemDraft, setRenameFileStemDraft] = useState("");
  const [editSkillDialogError, setEditSkillDialogError] = useState<string | null>(null);
  const [skillSidebarTitleBusy, setSkillSidebarTitleBusy] = useState(false);
  const [skillFileRenameBusy, setSkillFileRenameBusy] = useState(false);
  const [skillFileDeleteBusy, setSkillFileDeleteBusy] = useState(false);

  type SkillAddStep = "intro" | "create" | "link";
  const [addSkillOpen, setAddSkillOpen] = useState(false);
  const [skillAddStep, setSkillAddStep] = useState<SkillAddStep>("intro");
  const [createSkillId, setCreateSkillId] = useState("");
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const [linkUrl, setLinkUrl] = useState("");
  const [linkBusy, setLinkBusy] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [forkBusy, setForkBusy] = useState(false);
  const [refreshBusy, setRefreshBusy] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [pendingDeleteSkillId, setPendingDeleteSkillId] = useState<string | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteDialogError, setDeleteDialogError] = useState<string | null>(null);

  const [skillsExpandedDirs, setSkillsExpandedDirs] = useState(() => new Set<string>(["default", "custom"]));

  const toggleSkillsDir = useCallback((dirKey: string) => {
    setSkillsExpandedDirs((prev) => {
      const next = new Set(prev);
      if (next.has(dirKey)) {
        next.delete(dirKey);
      } else {
        next.add(dirKey);
      }
      return next;
    });
  }, []);

  const openAddSkillDialog = useCallback(() => {
    setSkillAddStep("intro");
    setCreateError(null);
    setLinkError(null);
    setAddSkillOpen(true);
  }, []);

  const urlKind = searchParams.get("kind") as DocKind | null;
  const urlSkillId = searchParams.get("skillId") ?? "";
  const urlPath = searchParams.get("path") ?? "";

  const searchParamsRef = useRef(searchParams);
  searchParamsRef.current = searchParams;

  const syncSelectionToUrl = useCallback(
    (nextOpen: { kind: DocKind; skillId: string; relativePath: string }) => {
      if (!companyId) {
        return;
      }
      const next = new URLSearchParams(searchParamsRef.current.toString());
      next.set("companyId", companyId);
      next.set("kind", nextOpen.kind);
      next.set("skillId", nextOpen.skillId);
      if (nextOpen.kind === "company") {
        next.set("path", nextOpen.relativePath);
      } else {
        next.delete("path");
      }
      router.replace(`${pathname}?${next.toString()}` as Route);
    },
    [companyId, pathname, router]
  );

  const clearSkillSelectionFromUrl = useCallback(() => {
    if (!companyId) {
      return;
    }
    const next = new URLSearchParams(searchParamsRef.current.toString());
    next.set("companyId", companyId);
    next.delete("kind");
    next.delete("skillId");
    next.delete("path");
    router.replace(`${pathname}?${next.toString()}` as Route);
  }, [companyId, pathname, router]);

  const refreshCompanySkills = useCallback(async (): Promise<CompanySkillsListResponse["items"] | undefined> => {
    if (!companyId) {
      return undefined;
    }
    const res = await apiGet<CompanySkillsListResponse>("/observability/company-skills", companyId);
    setCompanyItems(res.data.items);
    return res.data.items;
  }, [companyId]);

  useEffect(() => {
    if (!companyId) {
      setListsLoading(false);
      setBuiltinSkills([]);
      setCompanyItems([]);
      setOpen(null);
      return;
    }
    let mounted = true;
    setListsLoading(true);
    setListsError(null);
    void (async () => {
      try {
        const [built, co] = await Promise.all([
          apiGet<BuiltinSkillRow[]>("/observability/builtin-skills", companyId),
          apiGet<CompanySkillsListResponse>("/observability/company-skills", companyId)
        ]);
        if (!mounted) {
          return;
        }
        setBuiltinSkills(built.data);
        setCompanyItems(co.data.items);
      } catch (error) {
        if (!mounted) {
          return;
        }
        setListsError(error instanceof ApiError ? error.message : "Failed to load skills.");
      } finally {
        if (mounted) {
          setListsLoading(false);
        }
      }
    })();
    return () => {
      mounted = false;
    };
  }, [companyId]);

  const builtinIds = useMemo(() => builtinSkills.map((b) => b.id), [builtinSkills]);

  const skillsSidebarTree = useMemo((): SkillsTreeNavNode[] => {
    const linkTitle = (pack: CompanySkillsListResponse["items"][number]) =>
      pack.linkLastFetchedAt
        ? `Linked · last fetched ${pack.linkLastFetchedAt}`
        : pack.linkedUrl
          ? "Linked from URL"
          : undefined;

    const defaultChildren: SkillsTreeNavNode[] = builtinSkills.map((b) => ({
      kind: "builtinFile",
      skillId: b.id,
      label: b.title?.trim() || b.id
    }));

    const customChildren: SkillsTreeNavNode[] = [];
    for (const pack of companyItems) {
      if (pack.files.length === 0) {
        continue;
      }
      if (pack.files.length === 1) {
        const f = pack.files[0]!;
        customChildren.push({
          kind: "companyFile",
          skillId: pack.skillId,
          relativePath: f.relativePath,
          label: companySkillSidebarLabel(pack),
          linked: Boolean(pack.linkedUrl),
          linkTitle: linkTitle(pack),
          doubleClickTarget: "sidebarTitle"
        });
      } else {
        customChildren.push({
          kind: "folder",
          name: companySkillSidebarLabel(pack),
          treeSegment: pack.skillId,
          sidebarDoubleClickSkillId: pack.skillId,
          linked: Boolean(pack.linkedUrl),
          linkTitle: linkTitle(pack),
          children: pack.files.map((f) => ({
            kind: "companyFile" as const,
            skillId: pack.skillId,
            relativePath: f.relativePath,
            label: skillSidebarFileDisplayName(f.relativePath),
            doubleClickTarget: "renameFile" as const
          }))
        });
      }
    }

    return [
      { kind: "folder", name: "default", children: defaultChildren },
      {
        kind: "folder",
        name: "custom",
        showAdd: true,
        emptyMessage: companyItems.length === 0 ? "No company skills yet." : undefined,
        children: customChildren
      }
    ];
  }, [builtinSkills, companyItems]);

  useEffect(() => {
    if (listsLoading || !companyId) {
      return;
    }
    setOpen(parseOpenFromUrl(urlKind, urlSkillId, urlPath, builtinIds, companyItems));
  }, [listsLoading, companyId, urlKind, urlSkillId, urlPath, builtinIds, companyItems]);

  const selectedCompanyPack = useMemo(() => {
    if (!open || open.kind !== "company") {
      return null;
    }
    return companyItems.find((p) => p.skillId === open.skillId) ?? null;
  }, [open, companyItems]);

  const skillEditDialogPack = useMemo(() => {
    if (skillTreeEditDialog.kind === "closed") {
      return null;
    }
    return companyItems.find((p) => p.skillId === skillTreeEditDialog.skillId) ?? null;
  }, [skillTreeEditDialog, companyItems]);

  useEffect(() => {
    if (skillTreeEditDialog.kind === "closed" || listsLoading || !companyId) {
      return;
    }
    if (!skillEditDialogPack) {
      setSkillTreeEditDialog({ kind: "closed" });
      setEditSkillDialogError(null);
    }
  }, [skillTreeEditDialog.kind, skillEditDialogPack, listsLoading, companyId]);

  const skillIsUrlLinkedOnly = Boolean(
    selectedCompanyPack?.linkedUrl && !selectedCompanyPack?.hasLocalSkillMd
  );
  const skillHasLinkedUrl = Boolean(selectedCompanyPack?.linkedUrl);

  const syncDataRef = useRef({ builtinIds, companyItems });
  syncDataRef.current = { builtinIds, companyItems };

  const loadKey = open ? `${open.kind}\0${open.skillId}\0${open.relativePath}` : "";
  const loadKeyRef = useRef(loadKey);
  loadKeyRef.current = loadKey;

  const dirtyRef = useRef(false);
  const readOnly = open?.kind === "builtin" || skillIsUrlLinkedOnly;
  dirtyRef.current = open !== null && !readOnly && draftContent !== baselineContent;

  const draftContentRef = useRef(draftContent);
  const baselineContentRef = useRef(baselineContent);
  const companyIdRef = useRef(companyId);
  const openRef = useRef(open);
  const readOnlyRef = useRef(readOnly);
  draftContentRef.current = draftContent;
  baselineContentRef.current = baselineContent;
  companyIdRef.current = companyId;
  openRef.current = open;
  readOnlyRef.current = readOnly;

  const autosaveDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flushSkillsAutosaveRef = useRef<() => Promise<void>>(async () => {});

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
    if (!companyId || !loadKey || !open) {
      return;
    }
    const parts = loadKey.split("\0");
    if (parts.length < 3) {
      return;
    }
    const kind = parts[0] as DocKind;
    const skillId = parts[1] ?? "";
    const relativePath = parts[2] ?? "";
    const snapshot = loadKey;

    if (kind === "builtin") {
      const row = builtinSkills.find((b) => b.id === skillId);
      const text = row?.content ?? "";
      setBaselineContent(text);
      setDraftContent(text);
      setFileError(null);
      setSettledKey(snapshot);
      setHydrateVersion((v) => v + 1);
      return;
    }

    if (kind !== "company" || !relativePath) {
      return;
    }

    const base = `/observability/company-skills/file?skillId=${encodeURIComponent(skillId)}&path=${encodeURIComponent(relativePath)}`;
    let cancelled = false;
    void (async () => {
      try {
        const res = await apiGet<FileBodyResponse>(base, companyId);
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
        if (cancelled || loadKeyRef.current !== snapshot) {
          return;
        }
        setFileError(error instanceof ApiError ? error.message : "Failed to load file.");
        setBaselineContent("");
        setDraftContent("");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [companyId, loadKey, open, builtinSkills]);

  const dirty = open !== null && !readOnly && draftContent !== baselineContent;
  const editorReady = Boolean(loadKey && settledKey === loadKey && !fileError);
  const editorLoading = Boolean(loadKey && settledKey !== loadKey && !fileError);
  const isSkillMarkdown =
    open != null && (open.kind === "builtin" || open.relativePath.toLowerCase().endsWith(".md"));

  useEffect(() => {
    if (skillTreeEditDialog.kind === "sidebarTitle" && skillEditDialogPack) {
      setEditTitleDraft(companySkillSidebarLabel(skillEditDialogPack));
      setEditSkillDialogError(null);
    } else if (skillTreeEditDialog.kind === "renameFile") {
      const { stem } = skillPackStemAndExtFromBasename(
        skillPackBasenameFromRelativePath(skillTreeEditDialog.relativePath)
      );
      setRenameFileStemDraft(stem);
      setEditSkillDialogError(null);
    }
  }, [skillTreeEditDialog, skillEditDialogPack]);

  const flushSkillsAutosave = useCallback(async () => {
    if (autosaveDebounceRef.current) {
      clearTimeout(autosaveDebounceRef.current);
      autosaveDebounceRef.current = null;
    }
    const cid = companyIdRef.current;
    const o = openRef.current;
    if (!cid || !o || o.kind !== "company" || readOnlyRef.current) {
      return;
    }
    const content = draftContentRef.current;
    const baseline = baselineContentRef.current;
    if (content === baseline) {
      return;
    }
    const keyAtStart = loadKeyRef.current;
    setSaving(true);
    setSaveError(null);
    try {
      const q = `?skillId=${encodeURIComponent(o.skillId)}&path=${encodeURIComponent(o.relativePath)}`;
      await apiPut(`/observability/company-skills/file${q}`, cid, { content });
      if (loadKeyRef.current !== keyAtStart) {
        return;
      }
      setBaselineContent(content);
      baselineContentRef.current = content;
    } catch (error) {
      if (loadKeyRef.current === keyAtStart) {
        setSaveError(error instanceof ApiError ? error.message : "Save failed.");
      }
    } finally {
      setSaving(false);
    }
  }, []);

  flushSkillsAutosaveRef.current = flushSkillsAutosave;

  useEffect(() => {
    if (!companyId || !loadKey || !editorReady || readOnly || open?.kind !== "company") {
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
      void flushSkillsAutosave();
    }, 900);
    return () => {
      if (autosaveDebounceRef.current) {
        clearTimeout(autosaveDebounceRef.current);
        autosaveDebounceRef.current = null;
      }
    };
  }, [companyId, loadKey, editorReady, readOnly, open?.kind, draftContent, baselineContent, flushSkillsAutosave]);

  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (!dirtyRef.current) {
        return;
      }
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, []);

  useEffect(() => {
    const onPopState = () => {
      void (async () => {
        await flushSkillsAutosaveRef.current();
        const params = new URLSearchParams(window.location.search);
        const k = params.get("kind") as DocKind | null;
        const sid = params.get("skillId") ?? "";
        const p = params.get("path") ?? "";
        const { builtinIds: bi, companyItems: ci } = syncDataRef.current;
        setOpen(parseOpenFromUrl(k, sid, p, bi, ci));
      })();
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  function selectBuiltin(skillId: string) {
    void (async () => {
      await flushSkillsAutosave();
      const next = { kind: "builtin" as const, skillId, relativePath: "" };
      setOpen(next);
      syncSelectionToUrl(next);
    })();
  }

  function selectCompanyFile(skillId: string, relativePath: string) {
    void (async () => {
      await flushSkillsAutosave();
      const next = { kind: "company" as const, skillId, relativePath };
      setOpen(next);
      syncSelectionToUrl(next);
    })();
  }

  const handleSkillTreeEditDialogOpenChange = useCallback((isOpen: boolean) => {
    if (!isOpen) {
      setSkillTreeEditDialog({ kind: "closed" });
      setEditSkillDialogError(null);
    }
  }, []);

  const onCompanyFolderSidebarDoubleClick = useCallback((skillId: string) => {
    setSkillTreeEditDialog({ kind: "sidebarTitle", skillId });
  }, []);

  const onCompanyFileDoubleClick = useCallback(
    (skillId: string, relativePath: string, target: "sidebarTitle" | "renameFile") => {
      if (target === "sidebarTitle") {
        setSkillTreeEditDialog({ kind: "sidebarTitle", skillId });
        return;
      }
      const pack = companyItems.find((p) => p.skillId === skillId);
      const urlLinkedOnly = Boolean(pack?.linkedUrl && !pack?.hasLocalSkillMd);
      if (urlLinkedOnly) {
        return;
      }
      setSkillTreeEditDialog({ kind: "renameFile", skillId, relativePath });
    },
    [companyItems]
  );

  async function applySkillTreeEditDialogSave() {
    if (!companyId) {
      return;
    }
    if (skillTreeEditDialog.kind === "sidebarTitle") {
      const pack = skillEditDialogPack;
      if (!pack) {
        return;
      }
      const sid = skillTreeEditDialog.skillId;
      const parsed = parseSkillSidebarTitleInput(editTitleDraft, sid);
      if (!parsed.ok) {
        setEditSkillDialogError(parsed.message);
        return;
      }
      const prevStored = pack.sidebarTitle?.trim() ?? "";
      setEditSkillDialogError(null);
      if (parsed.apiTitle === prevStored) {
        setSkillTreeEditDialog({ kind: "closed" });
        return;
      }
      setSkillSidebarTitleBusy(true);
      try {
        await apiPatch(`/observability/company-skills/sidebar-title`, companyId, {
          skillId: sid,
          title: parsed.apiTitle
        });
        setSkillTreeEditDialog({ kind: "closed" });
        setSkillsExpandedDirs((prev) => {
          const nextSet = new Set(prev);
          nextSet.add("custom");
          nextSet.add(`custom/${sid}`);
          return nextSet;
        });
        await refreshCompanySkills();
      } catch (e) {
        setEditSkillDialogError(e instanceof ApiError ? e.message : "Could not update title.");
      } finally {
        setSkillSidebarTitleBusy(false);
      }
      return;
    }
    if (skillTreeEditDialog.kind === "renameFile") {
      const parsedStem = parseSkillPackTitleStemInput(renameFileStemDraft);
      if (!parsedStem.ok) {
        setEditSkillDialogError(parsedStem.message);
        return;
      }
      const { ext } = skillPackStemAndExtFromBasename(
        skillPackBasenameFromRelativePath(skillTreeEditDialog.relativePath)
      );
      const filename = `${parsedStem.stem}${ext}`;
      const parent = skillPackParentPrefixFromRelativePath(skillTreeEditDialog.relativePath);
      const nextPath = skillPackPathFromParentAndFilename(parent, filename);
      if (nextPath.split("/").filter(Boolean).length > SKILL_PACK_MAX_SEGMENTS) {
        setEditSkillDialogError("Too many path segments.");
        return;
      }
      const fullParse = parseSkillPackRelativePathInput(nextPath);
      if (!fullParse.ok) {
        setEditSkillDialogError(fullParse.message);
        return;
      }
      setEditSkillDialogError(null);
      if (fullParse.path === skillTreeEditDialog.relativePath) {
        setSkillTreeEditDialog({ kind: "closed" });
        return;
      }
      setSkillFileRenameBusy(true);
      try {
        await flushSkillsAutosave();
        if (draftContentRef.current !== baselineContentRef.current) {
          setEditSkillDialogError("Finish saving before renaming.");
          return;
        }
        const sid = skillTreeEditDialog.skillId;
        const from = skillTreeEditDialog.relativePath;
        await apiPatch(`/observability/company-skills/file?skillId=${encodeURIComponent(sid)}`, companyId, {
          from,
          to: fullParse.path
        });
        setSkillTreeEditDialog({ kind: "closed" });
        setSkillsExpandedDirs((prev) => {
          const nextSet = new Set(prev);
          nextSet.add("custom");
          nextSet.add(`custom/${sid}`);
          return nextSet;
        });
        if (openRef.current?.kind === "company" && openRef.current.skillId === sid && openRef.current.relativePath === from) {
          const next = { kind: "company" as const, skillId: sid, relativePath: fullParse.path };
          setOpen(next);
          syncSelectionToUrl(next);
        }
        await refreshCompanySkills();
        setHydrateVersion((v) => v + 1);
      } catch (e) {
        setEditSkillDialogError(e instanceof ApiError ? e.message : "Rename failed.");
      } finally {
        setSkillFileRenameBusy(false);
      }
    }
  }

  async function performDeleteSkillTreeFile() {
    if (!companyId || skillTreeEditDialog.kind !== "renameFile") {
      return;
    }
    const skillId = skillTreeEditDialog.skillId;
    const path = skillTreeEditDialog.relativePath;
    setEditSkillDialogError(null);
    setSkillFileDeleteBusy(true);
    try {
      await flushSkillsAutosave();
      if (draftContentRef.current !== baselineContentRef.current) {
        setEditSkillDialogError("Finish saving before deleting.");
        return;
      }
      await apiDelete(
        `/observability/company-skills/file?skillId=${encodeURIComponent(skillId)}&path=${encodeURIComponent(path)}`,
        companyId
      );
      setSkillTreeEditDialog({ kind: "closed" });
      const items = await refreshCompanySkills();
      const pack = items?.find((p) => p.skillId === skillId);
      const o = openRef.current;
      const deletedWasOpen = o?.kind === "company" && o.skillId === skillId && o.relativePath === path;
      if (!deletedWasOpen) {
        return;
      }
      if (!pack || pack.files.length === 0) {
        clearSkillSelectionFromUrl();
        setBaselineContent("");
        setDraftContent("");
        setSettledKey("");
      } else {
        const nextPath = pickDefaultCompanyFile(pack.files.map((f) => f.relativePath));
        setOpen({ kind: "company", skillId, relativePath: nextPath });
        syncSelectionToUrl({ kind: "company", skillId, relativePath: nextPath });
        setHydrateVersion((v) => v + 1);
      }
    } catch (e) {
      setEditSkillDialogError(e instanceof ApiError ? e.message : "Delete failed.");
    } finally {
      setSkillFileDeleteBusy(false);
    }
  }

  async function submitCreate() {
    if (!companyId) {
      return;
    }
    const id = createSkillId.trim();
    setCreateError(null);
    setCreateBusy(true);
    try {
      await apiPost("/observability/company-skills/create", companyId, { skillId: id });
      await refreshCompanySkills();
      setAddSkillOpen(false);
      setSkillAddStep("intro");
      setCreateSkillId("");
      selectCompanyFile(id, "SKILL.md");
    } catch (error) {
      setCreateError(error instanceof ApiError ? error.message : "Create failed.");
    } finally {
      setCreateBusy(false);
    }
  }

  async function submitLinkSkillUrl() {
    if (!companyId) {
      return;
    }
    setLinkError(null);
    setLinkBusy(true);
    try {
      const result = await apiPost<{ skillId: string; url: string }>(
        "/observability/company-skills/link-url",
        companyId,
        { url: linkUrl.trim() }
      );
      await refreshCompanySkills();
      setAddSkillOpen(false);
      setSkillAddStep("intro");
      setLinkUrl("");
      selectCompanyFile(result.data.skillId, "SKILL.md");
    } catch (error) {
      setLinkError(error instanceof ApiError ? error.message : "Link failed.");
    } finally {
      setLinkBusy(false);
    }
  }

  async function forkLinkedSkillToWorkspace() {
    if (!companyId || !open || open.kind !== "company" || !skillIsUrlLinkedOnly) {
      return;
    }
    setSaveError(null);
    setForkBusy(true);
    try {
      const q = `?skillId=${encodeURIComponent(open.skillId)}&path=${encodeURIComponent("SKILL.md")}`;
      await apiPut(`/observability/company-skills/file${q}`, companyId, { content: baselineContent });
      await refreshCompanySkills();
    } catch (error) {
      setSaveError(error instanceof ApiError ? error.message : "Could not save a local copy.");
    } finally {
      setForkBusy(false);
    }
  }

  async function refreshLinkedSkillFromUrl() {
    if (!companyId || !open || open.kind !== "company" || !skillHasLinkedUrl) {
      return;
    }
    if (dirty) {
      const ok = window.confirm(
        "Discard unsaved edits and replace the open file from the linked URL?"
      );
      if (!ok) {
        return;
      }
    }
    setSaveError(null);
    setRefreshBusy(true);
    const keyAtStart = loadKeyRef.current;
    try {
      await apiPost("/observability/company-skills/refresh-from-url", companyId, {
        skillId: open.skillId
      });
      await refreshCompanySkills();
      const base = `/observability/company-skills/file?skillId=${encodeURIComponent(open.skillId)}&path=${encodeURIComponent(open.relativePath)}`;
      const res = await apiGet<FileBodyResponse>(base, companyId);
      if (loadKeyRef.current === keyAtStart) {
        const text = res.data.content ?? "";
        setBaselineContent(text);
        setDraftContent(text);
      }
    } catch (error) {
      if (loadKeyRef.current === keyAtStart) {
        setSaveError(error instanceof ApiError ? error.message : "Refresh from URL failed.");
      }
    } finally {
      setRefreshBusy(false);
    }
  }

  async function submitDeleteSkill() {
    if (!companyId || !pendingDeleteSkillId) {
      return;
    }
    const skillId = pendingDeleteSkillId;
    setDeleteDialogError(null);
    setDeleteBusy(true);
    try {
      await flushSkillsAutosave();
      await apiDelete(`/observability/company-skills?skillId=${encodeURIComponent(skillId)}`, companyId);
      setDeleteDialogOpen(false);
      setPendingDeleteSkillId(null);
      clearSkillSelectionFromUrl();
      await refreshCompanySkills();
    } catch (error) {
      setDeleteDialogError(error instanceof ApiError ? error.message : "Could not remove skill.");
    } finally {
      setDeleteBusy(false);
    }
  }

  const sidebarTitleParsed =
    skillTreeEditDialog.kind === "sidebarTitle" && skillEditDialogPack
      ? parseSkillSidebarTitleInput(editTitleDraft, skillTreeEditDialog.skillId)
      : { ok: false as const, message: "" };
  const sidebarTitleUnchanged =
    skillTreeEditDialog.kind === "sidebarTitle" &&
    skillEditDialogPack &&
    sidebarTitleParsed.ok &&
    sidebarTitleParsed.apiTitle === (skillEditDialogPack.sidebarTitle?.trim() ?? "");
  const sidebarSaveDisabled =
    skillTreeEditDialog.kind !== "sidebarTitle" ||
    !companyId ||
    !skillEditDialogPack ||
    !sidebarTitleParsed.ok ||
    skillSidebarTitleBusy ||
    skillFileRenameBusy ||
    skillFileDeleteBusy ||
    (!sidebarTitleUnchanged && saving);

  const renameStemParsed =
    skillTreeEditDialog.kind === "renameFile"
      ? parseSkillPackTitleStemInput(renameFileStemDraft)
      : { ok: false as const, message: "" };
  const renameNextPathComputed =
    skillTreeEditDialog.kind === "renameFile" && renameStemParsed.ok
      ? skillPackPathFromParentAndFilename(
          skillPackParentPrefixFromRelativePath(skillTreeEditDialog.relativePath),
          `${renameStemParsed.stem}${skillPackStemAndExtFromBasename(skillPackBasenameFromRelativePath(skillTreeEditDialog.relativePath)).ext}`
        )
      : "";
  const renameUnchangedComputed =
    skillTreeEditDialog.kind === "renameFile" &&
    Boolean(renameNextPathComputed) &&
    renameNextPathComputed === skillTreeEditDialog.relativePath;
  const renameSaveDisabled =
    skillTreeEditDialog.kind !== "renameFile" ||
    !companyId ||
    !renameStemParsed.ok ||
    renameUnchangedComputed ||
    skillSidebarTitleBusy ||
    skillFileRenameBusy ||
    skillFileDeleteBusy ||
    (!renameUnchangedComputed && saving);

  const skillTreeEditSaveDisabled =
    skillTreeEditDialog.kind === "closed" ||
    (skillTreeEditDialog.kind === "sidebarTitle" ? sidebarSaveDisabled : renameSaveDisabled);

  const secondaryPane = (
    <div className="run-sidebar-pane">
      {listsLoading ? null : listsError ? (
        <Alert variant="destructive" className="ui-settings-skills-sidebar-alert">
          <AlertDescription>{listsError}</AlertDescription>
        </Alert>
      ) : (
        <div className="run-sidebar-list">
          <div className="ui-knowledge-files-header">
            <div className="ui-agent-docs-sidebar-section-label ui-knowledge-files-header-label">Files</div>
            <button
              type="button"
              className="ui-knowledge-files-header-add-folder"
              aria-label="Add skill"
              title="Add skill"
              disabled={!companyId}
              onClick={() => openAddSkillDialog()}
            >
              <Plus className="ui-icon-sm" aria-hidden />
            </button>
          </div>
          <div className="ui-knowledge-tree">
            <SkillsTreeNav
              nodes={skillsSidebarTree}
              depth={0}
              dirPrefix=""
              expandedDirs={skillsExpandedDirs}
              toggleDir={toggleSkillsDir}
              open={open}
              onSelectBuiltin={selectBuiltin}
              onSelectCompanyFile={selectCompanyFile}
              onAddSkillInCustom={openAddSkillDialog}
              onCompanyFolderSidebarDoubleClick={onCompanyFolderSidebarDoubleClick}
              onCompanyFileDoubleClick={onCompanyFileDoubleClick}
            />
          </div>
        </div>
      )}
    </div>
  );

  const headerDescription =
    open == null
      ? "Pick a built-in or company skill"
      : open.kind === "builtin"
        ? `Built-in · ${open.skillId}`
        : skillIsUrlLinkedOnly
          ? `Company · ${open.skillId} / ${open.relativePath} (live from URL)`
          : skillHasLinkedUrl
            ? `Company · ${open.skillId} / ${open.relativePath} · linked (local copy)`
            : `Company · ${open.skillId} / ${open.relativePath}`;

  return (
    <>
      <AppShell
        activeNav="Skills"
        companies={companies}
        activeCompanyId={companyId}
        leftPaneScrollable={false}
        secondaryPane={companyId ? secondaryPane : null}
        leftPane={
          <div className="run-detail-pane">
            <SectionHeading
              title="Skills"
              description={headerDescription}
              actions={
                <div className="ui-agent-docs-header-actions">
                  {companyId && open && editorReady ? (
                    <span className="ui-knowledge-autosave-status">
                      {readOnly ? "Read-only" : saving ? "Saving…" : dirty ? null : "Saved"}
                    </span>
                  ) : null}
                  {companyId &&
                  open?.kind === "company" &&
                  !skillHasLinkedUrl &&
                  open.relativePath &&
                  editorReady ? (
                    <Button
                      size="sm"
                      variant="outline"
                      type="button"
                      onClick={() => setSkillTreeEditDialog({ kind: "sidebarTitle", skillId: open.skillId })}
                      disabled={saving}
                    >
                      Edit
                    </Button>
                  ) : null}
                  {companyId && open?.kind === "company" && skillIsUrlLinkedOnly ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => void forkLinkedSkillToWorkspace()}
                      disabled={forkBusy || !editorReady || saving}
                    >
                      {forkBusy ? "Saving copy…" : "Save copy"}
                    </Button>
                  ) : null}
                  {companyId && open?.kind === "company" && skillHasLinkedUrl ? (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => void refreshLinkedSkillFromUrl()}
                      disabled={refreshBusy || !editorReady || saving}
                    >
                      {refreshBusy ? "Refreshing…" : "Refresh"}
                    </Button>
                  ) : null}
                  {companyId && open?.kind === "company" ? (
                    <Button
                      size="sm"
                      variant="destructive"
                      onClick={() => {
                        if (open?.kind !== "company") {
                          return;
                        }
                        setDeleteDialogError(null);
                        setPendingDeleteSkillId(open.skillId);
                        setDeleteDialogOpen(true);
                      }}
                      disabled={deleteBusy || saving}
                    >
                      Delete
                    </Button>
                  ) : null}
                </div>
              }
            />

            {!companyId ? (
              <p className="ui-agent-docs-empty-state">Select a company to manage skills.</p>
            ) : null}

            {companyId && fileError ? (
              <Alert variant="destructive" className="ui-settings-skills-alert">
                <AlertDescription>{fileError}</AlertDescription>
              </Alert>
            ) : null}
            {saveError ? (
              <Alert variant="destructive" className="ui-settings-skills-alert">
                <AlertDescription>{saveError}</AlertDescription>
              </Alert>
            ) : null}


            {companyId && !listsLoading && !open ? (
              <p className="ui-agent-docs-empty-state">Select a skill from the list.</p>
            ) : null}

            {companyId && open ? (
              isSkillMarkdown ? (
                <div className="ui-agent-docs-editor-shell">
                  {editorLoading ? (
                    <div className="ui-agent-docs-editor-loading">Loading…</div>
                  ) : editorReady ? (
                    <KnowledgeTiptapEditor
                      hydrateVersion={hydrateVersion}
                      markdown={draftContent}
                      onMarkdownChange={setDraftContent}
                      placeholder="Write skill markdown…"
                      readOnly={readOnly}
                    />
                  ) : fileError ? (
                    <div className="ui-agent-docs-editor-loading">Could not load this file.</div>
                  ) : null}
                </div>
              ) : editorLoading ? (
                <div className="ui-agent-docs-editor-shell">
                  <div className="ui-agent-docs-editor-loading">Loading…</div>
                </div>
              ) : (
                <Textarea
                  className="ui-knowledge-plain-editor"
                  value={draftContent}
                  readOnly={readOnly}
                  onChange={(e) => setDraftContent(e.target.value)}
                />
              )
            ) : null}
          </div>
        }
      />

      <Dialog
        open={skillTreeEditDialog.kind !== "closed"}
        onOpenChange={handleSkillTreeEditDialogOpenChange}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {skillTreeEditDialog.kind === "renameFile" ? "Rename file" : "Edit skill"}
            </DialogTitle>
            <DialogDescription>
              {skillTreeEditDialog.kind === "renameFile" ? (
                <>
                  Change the file name (extension stays the same). The path on disk updates; skill id is unchanged.
                </>
              ) : (
                <>
                  Change how this skill appears in the sidebar. File names on disk stay the same. Document edits
                  still save automatically.
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          {skillTreeEditDialog.kind === "sidebarTitle" && skillEditDialogPack ? (
            <Field>
              <FieldLabel>Sidebar title</FieldLabel>
              <Input
                value={editTitleDraft}
                onChange={(e) => setEditTitleDraft(e.target.value)}
                placeholder={skillTreeEditDialog.skillId}
                autoComplete="off"
                spellCheck={false}
              />
            </Field>
          ) : null}
          {skillTreeEditDialog.kind === "renameFile" ? (
            <>
              <Field>
                <FieldLabel>File name</FieldLabel>
                <Input
                  value={renameFileStemDraft}
                  onChange={(e) => setRenameFileStemDraft(e.target.value)}
                  placeholder={
                    skillPackStemAndExtFromBasename(
                      skillPackBasenameFromRelativePath(skillTreeEditDialog.relativePath)
                    ).stem || "Untitled"
                  }
                  autoComplete="off"
                  spellCheck={false}
                />
              </Field>
              {skillTreeEditDialog.relativePath.includes("/") ? (
                <p className="ui-issue-muted-text ui-knowledge-edit-folder-hint">
                  Folder:{" "}
                  <code className="ui-dialog-description-inline-code">
                    {skillPackParentPrefixFromRelativePath(skillTreeEditDialog.relativePath)}/
                  </code>
                </p>
              ) : null}
            </>
          ) : null}
          {editSkillDialogError ? (
            <Alert variant="destructive">
              <AlertDescription>{editSkillDialogError}</AlertDescription>
            </Alert>
          ) : null}
          <DialogFooter>
            {skillTreeEditDialog.kind === "renameFile" ? (
              <Button
                type="button"
                variant="ghost"
                onClick={() => void performDeleteSkillTreeFile()}
                disabled={
                  skillFileDeleteBusy || skillSidebarTitleBusy || skillFileRenameBusy || saving
                }
              >
                {skillFileDeleteBusy ? "Deleting…" : "Delete"}
              </Button>
            ) : null}
            <Button
              type="button"
              onClick={() => void applySkillTreeEditDialogSave()}
              disabled={skillTreeEditSaveDisabled}
            >
              {skillSidebarTitleBusy || skillFileRenameBusy ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={addSkillOpen}
        onOpenChange={(open) => {
          setAddSkillOpen(open);
          if (!open) {
            setSkillAddStep("intro");
            setCreateSkillId("");
            setCreateError(null);
            setLinkUrl("");
            setLinkError(null);
          }
        }}
      >
        <DialogContent className={createAgentModalStyles.createAgentModalDialogContent}>
          <DialogHeader>
            <DialogTitle>
              {skillAddStep === "intro"
                ? "Create skill"
                : skillAddStep === "create"
                  ? "Create skill"
                  : "Link skill from URL"}
            </DialogTitle>
            {skillAddStep === "intro" ? (
              <DialogDescription>Create a new skill in the workspace or link one from a URL.</DialogDescription>
            ) : null}
            {skillAddStep === "create" ? (
              <DialogDescription>
                Creates <code className="ui-settings-skills-dialog-code">skills/&lt;id&gt;/SKILL.md</code>.
              </DialogDescription>
            ) : null}
            {skillAddStep === "link" ? (
              <DialogDescription>
                Paste the skill URL. The folder name comes from the skill</DialogDescription>
            ) : null}
          </DialogHeader>
          {skillAddStep === "intro" ? (
            <section className={createAgentModalStyles.createAgentModalIntroSection}>
              <div className={createAgentModalStyles.createAgentModalIntroChoices}>
                <button
                  type="button"
                  className={createAgentModalStyles.createAgentModalIntroChoice}
                  onClick={() => {
                    setSkillAddStep("create");
                    setCreateError(null);
                  }}
                >
                  <span className={createAgentModalStyles.createAgentModalIntroChoiceIcon} aria-hidden>
                    <FilePenLine className="size-5" strokeWidth={1.75} />
                  </span>
                  <span className={createAgentModalStyles.createAgentModalIntroChoiceTitle}>Create new skill</span>
                  <span className={createAgentModalStyles.createAgentModalIntroChoiceDescription}>
                    {`Add SKILL.md under skills/<id> in your company workspace.`}
                  </span>
                </button>
                <button
                  type="button"
                  className={createAgentModalStyles.createAgentModalIntroChoice}
                  onClick={() => {
                    setSkillAddStep("link");
                    setLinkError(null);
                  }}
                >
                  <span className={createAgentModalStyles.createAgentModalIntroChoiceIcon} aria-hidden>
                    <Link2 className="size-5" strokeWidth={1.75} />
                  </span>
                  <span className={createAgentModalStyles.createAgentModalIntroChoiceTitle}>Link from URL</span>
                  <span className={createAgentModalStyles.createAgentModalIntroChoiceDescription}>
                    Point at a remote skill; content loads when you open it
                  </span>
                </button>
              </div>
            </section>
          ) : null}
          {skillAddStep === "create" ? (
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="settings-skills-create-id">Skill id</FieldLabel>
                <Input
                  id="settings-skills-create-id"
                  placeholder="e.g. my-workflow"
                  value={createSkillId}
                  onChange={(e) => setCreateSkillId(e.target.value)}
                />
              </Field>
              {createError ? <FieldError>{createError}</FieldError> : null}
            </FieldGroup>
          ) : null}
          {skillAddStep === "link" ? (
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="settings-skills-link-url">URL</FieldLabel>
                <Input
                  id="settings-skills-link-url"
                  placeholder="https://skills.sh"
                  value={linkUrl}
                  onChange={(e) => setLinkUrl(e.target.value)}
                />
              </Field>
              {linkError ? <FieldError>{linkError}</FieldError> : null}
            </FieldGroup>
          ) : null}
          <DialogFooter showCloseButton={skillAddStep === "intro"}>
            {skillAddStep !== "intro" ? (
              <>
                <Button type="button" variant="ghost" onClick={() => setAddSkillOpen(false)}>
                  Cancel
                </Button>
                {skillAddStep === "create" ? (
                  <Button
                    type="button"
                    onClick={() => void submitCreate()}
                    disabled={createBusy || !createSkillId.trim()}
                  >
                    {createBusy ? "Creating…" : "Create"}
                  </Button>
                ) : (
                  <Button
                    type="button"
                    onClick={() => void submitLinkSkillUrl()}
                    disabled={linkBusy || !linkUrl.trim()}
                  >
                    {linkBusy ? "Linking…" : "Link"}
                  </Button>
                )}
              </>
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={deleteDialogOpen}
        onOpenChange={(nextOpen) => {
          setDeleteDialogOpen(nextOpen);
          if (!nextOpen) {
            setDeleteDialogError(null);
            setPendingDeleteSkillId(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove company skill?</DialogTitle>
            <DialogDescription>
              This permanently deletes{" "}
              <code className="ui-settings-skills-dialog-code">
                skills/{pendingDeleteSkillId ?? "…"}/
              </code>{" "}
              from the workspace, including any linked URL pointer and all files in that folder. Agents that referenced
              this skill will no longer see it.
            </DialogDescription>
          </DialogHeader>
          {deleteDialogError ? (
            <Alert variant="destructive" className="ui-settings-skills-alert">
              <AlertDescription>{deleteDialogError}</AlertDescription>
            </Alert>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setDeleteDialogOpen(false)} disabled={deleteBusy}>
              Cancel
            </Button>
            <Button type="button" variant="destructive" onClick={() => void submitDeleteSkill()} disabled={deleteBusy}>
              {deleteBusy ? "Removing…" : "Remove skill"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
