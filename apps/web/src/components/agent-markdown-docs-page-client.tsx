"use client";

import Link from "next/link";
import type { Route } from "next";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { LazyMarkdownMdxEditor } from "@/components/modals/lazy-markdown-mdx-editor";
import { Button } from "@/components/ui/button";
import { ApiError, apiGet, apiPut } from "@/lib/api";
import { cn } from "@/lib/utils";
import { SectionHeading } from "@/components/workspace/shared";

type DocSource = "operating" | "memory";

interface OperatingFilesResponse {
  items: Array<{ relativePath: string }>;
}

interface MemoryListResponse {
  items: Array<{ agentId: string; relativePath: string }>;
}

interface FileBodyResponse {
  content: string;
}

function isMdPath(p: string) {
  return p.toLowerCase().endsWith(".md");
}

function pickOpenFileFromUrl(
  urlSource: DocSource | null,
  urlPath: string,
  operatingPaths: string[],
  memoryPaths: string[]
): { source: DocSource; path: string } | null {
  if (urlSource === "operating" && urlPath && operatingPaths.includes(urlPath)) {
    return { source: "operating", path: urlPath };
  }
  if (urlSource === "memory" && urlPath && memoryPaths.includes(urlPath)) {
    return { source: "memory", path: urlPath };
  }
  if (operatingPaths[0]) {
    return { source: "operating", path: operatingPaths[0] };
  }
  if (memoryPaths[0]) {
    return { source: "memory", path: memoryPaths[0] };
  }
  return null;
}

function cacheFullKey(agentId: string, companyId: string, loadKey: string) {
  return `${agentId}\0${companyId}\0${loadKey}`;
}

export function AgentMarkdownDocsPageClient({
  companyId,
  companies,
  agent,
}: {
  companyId: string;
  companies: Array<{ id: string; name: string }>;
  agent: { id: string; name: string; role: string };
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [editorOverlayRoot, setEditorOverlayRoot] = useState<HTMLDivElement | null>(null);

  const bodyCacheRef = useRef<Map<string, string>>(new Map());

  const [listsLoading, setListsLoading] = useState(true);
  const [listsError, setListsError] = useState<string | null>(null);
  const [operatingPaths, setOperatingPaths] = useState<string[]>([]);
  const [memoryPaths, setMemoryPaths] = useState<string[]>([]);

  const [baselineContent, setBaselineContent] = useState("");
  const [draftContent, setDraftContent] = useState("");
  const [fileError, setFileError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  /** Last `loadKey` for which server content was applied (GET or cache hit). */
  const [settledKey, setSettledKey] = useState("");
  /** Open document — local state is authoritative; URL is updated for sharing only (no sync loop). */
  const [openFile, setOpenFile] = useState<{ source: DocSource; path: string } | null>(null);

  const urlSource = searchParams.get("source") as DocSource | null;
  const urlPath = searchParams.get("path") ?? "";

  const searchParamsRef = useRef(searchParams);
  searchParamsRef.current = searchParams;

  const syncSelectionToUrl = useCallback(
    (source: DocSource, path: string) => {
      const next = new URLSearchParams(searchParamsRef.current.toString());
      next.set("companyId", companyId);
      next.set("source", source);
      next.set("path", path);
      router.replace(`${pathname}?${next.toString()}` as Route);
    },
    [companyId, pathname, router]
  );

  useEffect(() => {
    let mounted = true;
    bodyCacheRef.current.clear();
    setListsLoading(true);
    setListsError(null);
    setOpenFile(null);
    const urlSourceAtFetch = urlSource;
    const urlPathAtFetch = urlPath;
    void (async () => {
      try {
        const [opRes, memRes] = await Promise.all([
          apiGet<OperatingFilesResponse>(
            `/observability/agent-operating/${encodeURIComponent(agent.id)}/files?limit=200`,
            companyId
          ),
          apiGet<MemoryListResponse>(
            `/observability/memory?agentId=${encodeURIComponent(agent.id)}&limit=200`,
            companyId
          )
        ]);
        if (!mounted) {
          return;
        }
        const opPaths = opRes.data.items.map((row) => row.relativePath).sort((a, b) => a.localeCompare(b));
        const memPaths = memRes.data.items
          .filter((row) => row.agentId === agent.id && isMdPath(row.relativePath))
          .map((row) => row.relativePath)
          .sort((a, b) => a.localeCompare(b));
        setOperatingPaths(opPaths);
        setMemoryPaths(memPaths);
        setOpenFile(pickOpenFileFromUrl(urlSourceAtFetch, urlPathAtFetch, opPaths, memPaths));
      } catch (error) {
        if (!mounted) {
          return;
        }
        setListsError(error instanceof ApiError ? error.message : "Failed to load file lists.");
      } finally {
        if (mounted) {
          setListsLoading(false);
        }
      }
    })();
    return () => {
      mounted = false;
    };
  }, [agent.id, companyId]);

  const loadKey = openFile ? `${openFile.source}\0${openFile.path}` : "";
  const loadKeyRef = useRef(loadKey);
  loadKeyRef.current = loadKey;

  const onEditorMarkdownChange = useCallback(
    (next: string, initialMarkdownNormalize?: boolean) => {
      if (initialMarkdownNormalize) {
        setBaselineContent(next);
        setDraftContent(next);
        const key = loadKeyRef.current;
        if (key) {
          bodyCacheRef.current.set(cacheFullKey(agent.id, companyId, key), next);
        }
        return;
      }
      setDraftContent(next);
    },
    [agent.id, companyId]
  );

  const dirtyRef = useRef(false);
  dirtyRef.current = openFile !== null && draftContent !== baselineContent;

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
    const i = loadKey.indexOf("\0");
    if (i <= 0) {
      return;
    }
    const source = loadKey.slice(0, i) as DocSource;
    const path = loadKey.slice(i + 1);
    if (source !== "operating" && source !== "memory") {
      return;
    }
    if (!path) {
      return;
    }

    const snapshot = loadKey;
    const fullKey = cacheFullKey(agent.id, companyId, snapshot);
    const cached = bodyCacheRef.current.get(fullKey);

    const base =
      source === "operating"
        ? `/observability/agent-operating/${encodeURIComponent(agent.id)}/file?path=${encodeURIComponent(path)}`
        : `/observability/memory/${encodeURIComponent(agent.id)}/file?path=${encodeURIComponent(path)}`;

    const applyFromNetwork = (text: string) => {
      if (loadKeyRef.current !== snapshot) {
        return;
      }
      bodyCacheRef.current.set(fullKey, text);
      setBaselineContent(text);
      setDraftContent(text);
      setFileError(null);
      setSettledKey(snapshot);
    };

    const revalidate = () => {
      void (async () => {
        try {
          const res = await apiGet<FileBodyResponse>(base, companyId);
          if (loadKeyRef.current !== snapshot) {
            return;
          }
          const text = res.data.content ?? "";
          bodyCacheRef.current.set(fullKey, text);
          if (!dirtyRef.current) {
            setBaselineContent(text);
            setDraftContent(text);
          }
        } catch {
          /* keep cached / current UI */
        }
      })();
    };

    if (cached !== undefined) {
      applyFromNetwork(cached);
      revalidate();
      return;
    }

    let cancelled = false;
    void (async () => {
      try {
        const res = await apiGet<FileBodyResponse>(base, companyId);
        if (cancelled || loadKeyRef.current !== snapshot) {
          return;
        }
        const text = res.data.content ?? "";
        applyFromNetwork(text);
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
  }, [agent.id, companyId, loadKey]);

  useEffect(() => {
    const onPopState = () => {
      const params = new URLSearchParams(window.location.search);
      const s = params.get("source") as DocSource | null;
      const p = params.get("path") ?? "";
      const next = pickOpenFileFromUrl(s, p, operatingPaths, memoryPaths);
      if (next) {
        setOpenFile(next);
      }
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [operatingPaths, memoryPaths]);

  const dirty = openFile !== null && draftContent !== baselineContent;
  const editorReady = Boolean(loadKey && settledKey === loadKey && !fileError);
  const editorLoading = Boolean(loadKey && settledKey !== loadKey && !fileError);

  async function save() {
    if (!openFile || !dirty) {
      return;
    }
    const keyAtStart = loadKeyRef.current;
    const fileAtStart = openFile;
    const contentAtStart = draftContent;
    setSaveError(null);
    setSaving(true);
    try {
      const q = `?path=${encodeURIComponent(fileAtStart.path)}`;
      const path =
        fileAtStart.source === "operating"
          ? `/observability/agent-operating/${encodeURIComponent(agent.id)}/file${q}`
          : `/observability/memory/${encodeURIComponent(agent.id)}/file${q}`;
      await apiPut(path, companyId, { content: contentAtStart });
      if (loadKeyRef.current !== keyAtStart) {
        return;
      }
      setBaselineContent(contentAtStart);
      const fk = cacheFullKey(agent.id, companyId, keyAtStart);
      bodyCacheRef.current.set(fk, contentAtStart);
    } catch (error) {
      if (loadKeyRef.current === keyAtStart) {
        setSaveError(error instanceof ApiError ? error.message : "Save failed.");
      }
    } finally {
      setSaving(false);
    }
  }

  function selectFile(source: DocSource, path: string) {
    setOpenFile({ source, path });
    syncSelectionToUrl(source, path);
  }

  const mobileSample = useMemo(() => {
    const rows: Array<{ source: DocSource; path: string }> = [];
    for (const p of operatingPaths.slice(0, 8)) {
      rows.push({ source: "operating", path: p });
    }
    for (const p of memoryPaths.slice(0, 8)) {
      if (rows.length >= 12) {
        break;
      }
      rows.push({ source: "memory", path: p });
    }
    return rows;
  }, [memoryPaths, operatingPaths]);

  const secondaryPane = (
    <div className="run-sidebar-pane">
      {listsLoading ? null : listsError ? (
        <p className="ui-agent-docs-sidebar-error">{listsError}</p>
      ) : (
        <div className="run-sidebar-list">
          <div className="ui-agent-docs-sidebar-section-label">Operating</div>
          {operatingPaths.length === 0 ? (
            <p className="ui-agent-docs-sidebar-empty">No .md files yet.</p>
          ) : (
            operatingPaths.map((p) => {
              const active = openFile?.source === "operating" && openFile.path === p;
              return (
                <button
                  key={`op-${p}`}
                  type="button"
                  className={cn(
                    "run-sidebar-item",
                    "ui-agent-docs-sidebar-item",
                    active && "run-sidebar-item--active"
                  )}
                  onClick={() => selectFile("operating", p)}
                >
                  <div className="run-sidebar-item-header">
                    <span className="run-sidebar-item-id" title={p}>
                      {p}
                    </span>
                  </div>
                </button>
              );
            })
          )}
          <div className="ui-agent-docs-sidebar-section-label ui-agent-docs-sidebar-section-label--spaced">
            Memory
          </div>
          {memoryPaths.length === 0 ? (
            <p className="ui-agent-docs-sidebar-empty">No .md files yet.</p>
          ) : (
            memoryPaths.map((p) => {
              const active = openFile?.source === "memory" && openFile.path === p;
              return (
                <button
                  key={`mem-${p}`}
                  type="button"
                  className={cn(
                    "run-sidebar-item",
                    "ui-agent-docs-sidebar-item",
                    active && "run-sidebar-item--active"
                  )}
                  onClick={() => selectFile("memory", p)}
                >
                  <div className="run-sidebar-item-header">
                    <span className="run-sidebar-item-id" title={p}>
                      {p}
                    </span>
                  </div>
                </button>
              );
            })
          )}
        </div>
      )}
    </div>
  );

  const backHref = { pathname: `/agents/${agent.id}`, query: { companyId } } as const;

  return (
    <AppShell
      activeNav="Agents"
      companies={companies}
      activeCompanyId={companyId}
      leftPaneScrollable={false}
      secondaryPane={secondaryPane}
      leftPane={
        <div className="run-detail-pane" ref={setEditorOverlayRoot}>
          <div className="ui-agent-docs-mobile-panel">
            <div className="ui-agent-docs-mobile-panel-title">Files</div>
            <div className="ui-agent-docs-mobile-panel-list">
              {mobileSample.map((row) => {
                const active = openFile?.source === row.source && openFile.path === row.path;
                return (
                  <button
                    key={`m-${row.source}-${row.path}`}
                    type="button"
                    className={cn(
                      "run-sidebar-item",
                      "ui-agent-docs-sidebar-item",
                      active && "run-sidebar-item--active"
                    )}
                    onClick={() => selectFile(row.source, row.path)}
                  >
                    <div className="run-sidebar-item-header">
                      <span className="run-sidebar-item-message">
                        <span className="ui-agent-docs-mobile-source">[{row.source}]</span> {row.path}
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          <SectionHeading
            title={`${agent.name}`}
            description={`${agent.role} · ${
              openFile ? `${openFile.source} / ${openFile.path}` : "Pick a file"
            }`}
            actions={
              <div className="ui-agent-docs-header-actions">
                <Button asChild variant="outline" size="sm">
                  <Link href={backHref}>Back to agent</Link>
                </Button>
                <Button
                  size="sm"
                  onClick={() => void save()}
                  disabled={!dirty || saving || !editorReady || !openFile}
                >
                  {saving ? "Saving…" : dirty ? "Save" : "Saved"}
                </Button>
              </div>
            }
          />

          {fileError ? <p className="ui-agent-docs-error">{fileError}</p> : null}
          {saveError ? <p className="ui-agent-docs-error">{saveError}</p> : null}

          {!listsLoading && !openFile ? (
            <p className="ui-agent-docs-empty-state">No markdown files found for this agent.</p>
          ) : openFile ? (
            <div className="ui-agent-docs-editor-shell">
              {editorLoading ? (
                <div className="ui-agent-docs-editor-loading">Loading file…</div>
              ) : editorReady ? (
                <LazyMarkdownMdxEditor
                  key={loadKey}
                  editorKey={loadKey}
                  markdown={draftContent}
                  onChange={onEditorMarkdownChange}
                  compact={false}
                  className="ui-agent-docs-editor"
                  overlayContainer={editorOverlayRoot ?? undefined}
                />
              ) : fileError ? (
                <div className="ui-agent-docs-editor-loading">Could not load this file.</div>
              ) : null}
            </div>
          ) : null}
        </div>
      }
    />
  );
}
