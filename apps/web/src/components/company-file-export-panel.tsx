"use client";

import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { ApiError, apiDownloadExportZip, apiFetchExportPreview, apiGet, apiPostFormData } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

type ManifestFile = { path: string; bytes: number; source: string };

const EXPORT_GROUP_ROOT = "__root__";

/** Directory-style bucket for export manifest paths (e.g. agents/ceo, projects/foo). */
function exportPathGroupKey(path: string): string {
  const normalized = path.trim().replace(/^\/+/, "");
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length <= 1) {
    return EXPORT_GROUP_ROOT;
  }
  const [top, second] = parts;
  if (top === "agents" && second) {
    return `agents/${second}`;
  }
  if (top === "projects" && second) {
    return `projects/${second}`;
  }
  if (top === "tasks" && second) {
    return `tasks/${second}`;
  }
  if (top === "skills") {
    return "skills";
  }
  return top ?? EXPORT_GROUP_ROOT;
}

function exportGroupSortRank(key: string): number {
  if (key === EXPORT_GROUP_ROOT) {
    return 0;
  }
  if (key.startsWith("agents/")) {
    return 1;
  }
  if (key.startsWith("projects/")) {
    return 2;
  }
  if (key.startsWith("tasks/")) {
    return 3;
  }
  if (key === "skills") {
    return 4;
  }
  return 5;
}

function compareExportGroupKeys(a: string, b: string): number {
  const ra = exportGroupSortRank(a);
  const rb = exportGroupSortRank(b);
  if (ra !== rb) {
    return ra - rb;
  }
  return a.localeCompare(b);
}

function exportGroupTitle(key: string): string {
  return key === EXPORT_GROUP_ROOT ? "Root" : key;
}

export function CompanyFileExportCard({ companyId, companyName }: { companyId: string; companyName: string }) {
  const searchId = useId();
  const [files, setFiles] = useState<ManifestFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [activePath, setActivePath] = useState<string | null>(null);
  const [preview, setPreview] = useState<string>("");
  const [previewLoading, setPreviewLoading] = useState(false);
  const [exporting, setExporting] = useState(false);

  const loadManifest = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { data } = await apiGet<{ files: ManifestFile[] }>(
        `/companies/${encodeURIComponent(companyId)}/export/files/manifest?includeAgentMemory=1`,
        companyId
      );
      setFiles(data.files);
      setSelected(new Set(data.files.map((f) => f.path)));
      setActivePath(null);
      setPreview("");
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
      setFiles([]);
      setSelected(new Set());
    } finally {
      setLoading(false);
    }
  }, [companyId]);

  useEffect(() => {
    void loadManifest();
  }, [loadManifest]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) {
      return files;
    }
    return files.filter((f) => f.path.toLowerCase().includes(q));
  }, [files, search]);

  const filteredAllSelected = useMemo(() => {
    if (filtered.length === 0) {
      return false;
    }
    return filtered.every((f) => selected.has(f.path));
  }, [filtered, selected]);

  const filteredGrouped = useMemo(() => {
    const byKey = new Map<string, ManifestFile[]>();
    for (const f of filtered) {
      const key = exportPathGroupKey(f.path);
      const bucket = byKey.get(key);
      if (bucket) {
        bucket.push(f);
      } else {
        byKey.set(key, [f]);
      }
    }
    for (const list of byKey.values()) {
      list.sort((a, b) => a.path.localeCompare(b.path));
    }
    const keys = [...byKey.keys()].sort(compareExportGroupKeys);
    return keys.map((key) => ({
      key,
      title: exportGroupTitle(key),
      files: byKey.get(key)!
    }));
  }, [filtered]);

  const selectedCount = selected.size;
  const totalCount = files.length;

  const togglePath = (path: string, checked: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) {
        next.add(path);
      } else {
        next.delete(path);
      }
      return next;
    });
  };

  const toggleFilteredSelection = () => {
    if (filtered.length === 0) {
      return;
    }
    if (filteredAllSelected) {
      setSelected((prev) => {
        const next = new Set(prev);
        for (const f of filtered) {
          next.delete(f.path);
        }
        return next;
      });
    } else {
      setSelected((prev) => {
        const next = new Set(prev);
        for (const f of filtered) {
          next.add(f.path);
        }
        return next;
      });
    }
  };

  const openPreview = async (path: string) => {
    setActivePath(path);
    setPreviewLoading(true);
    setPreview("");
    try {
      const text = await apiFetchExportPreview(companyId, path, true);
      setPreview(text);
    } catch (e) {
      setPreview(e instanceof ApiError ? e.message : String(e));
    } finally {
      setPreviewLoading(false);
    }
  };

  const onExportZip = async () => {
    if (selectedCount === 0) {
      return;
    }
    setExporting(true);
    setError(null);
    try {
      const paths = selectedCount === totalCount ? null : [...selected];
      const blob = await apiDownloadExportZip(companyId, { paths, includeAgentMemory: true });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `company-${companyId}-export.zip`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setExporting(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{companyName}</CardTitle>
        <CardDescription>
          Download your company as a zip archive.
        </CardDescription>
      </CardHeader>
      <CardContent className="ui-company-file-export-content">
        <div className="ui-company-file-export-pane ui-company-file-export-pane--files">
          <Field className="ui-company-file-export-search-field">
            <Input id={searchId} value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Filter by path…" />
          </Field>
          {error ? <p className="ui-company-file-export-error">{error}</p> : null}
          <ScrollArea className="ui-company-file-export-file-scroll">
            <ul className="ui-company-file-export-file-list">
              {filteredGrouped.map((group) => (
                <li key={group.key} className="ui-company-file-export-file-group">
                  <div className="ui-company-file-export-file-group-title">{group.title}</div>
                  <ul className="ui-company-file-export-file-group-items" aria-label={`Files: ${group.title}`}>
                    {group.files.map((f) => (
                      <li key={f.path}>
                        <label
                          className={cn(
                            "ui-company-file-export-file-row",
                            activePath === f.path && "ui-company-file-export-file-row--active"
                          )}
                        >
                          <Checkbox
                            checked={selected.has(f.path)}
                            onCheckedChange={(v) => togglePath(f.path, v === true)}
                            className="ui-company-file-export-file-checkbox"
                          />
                          <button
                            type="button"
                            className="ui-company-file-export-file-path"
                            onClick={() => void openPreview(f.path)}
                          >
                            {f.path}
                            <span className="ui-company-file-export-file-meta">({f.bytes} B)</span>
                          </button>
                        </label>
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          </ScrollArea>
        </div>
        <div className="ui-company-file-export-pane ui-company-file-export-pane--preview">
          <ScrollArea className="ui-company-file-export-preview-scroll">
            <pre className="ui-company-file-export-preview-pre">
              {previewLoading ? "Loading…" : preview || "Select a file to preview."}
            </pre>
          </ScrollArea>
        </div>
      </CardContent>
      <CardFooter className="ui-company-file-export-footer">
        <p className="ui-company-file-export-footer-summary">
          {loading ? "Preparing export…" : `${selectedCount} of ${totalCount} file${totalCount === 1 ? "" : "s"} will be included in the zip.`}
        </p>
        <div className="ui-company-file-export-footer-actions">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={loading || filtered.length === 0}
            aria-pressed={filteredAllSelected}
            onClick={toggleFilteredSelection}
          >
            {filtered.length === 0
              ? "No matching files"
              : filteredAllSelected
                ? "Clear filtered"
                : "Select filtered"}
          </Button>
          <Button type="button" size="sm" disabled={exporting || selectedCount === 0 || loading} onClick={() => void onExportZip()}>
            {exporting ? "Building zip…" : `Export ${selectedCount} file${selectedCount === 1 ? "" : "s"}`}
          </Button>
        </div>
      </CardFooter>
    </Card>
  );
}

type ImportPreviewPayload = {
  ok: boolean;
  companyName: string;
  counts: {
    projects: number;
    agents: number;
    goals: number;
    routines: number;
    skillFiles: number;
    knowledgeFiles: number;
  };
  hasCeo: boolean;
  errors: string[];
  warnings: string[];
};

export function CompanyFileImportCard() {
  const importInputId = useId();
  const [importBusy, setImportBusy] = useState(false);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [stagedFile, setStagedFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<ImportPreviewPayload | null>(null);
  const [importMessage, setImportMessage] = useState<string | null>(null);

  const onFileChosen = async (list: FileList | null) => {
    const file = list?.[0];
    setImportMessage(null);
    setPreview(null);
    setStagedFile(file ?? null);
    if (!file) {
      return;
    }
    setPreviewBusy(true);
    try {
      const fd = new FormData();
      fd.append("archive", file);
      const { data } = await apiPostFormData<ImportPreviewPayload>("/companies/import/files/preview", null, fd);
      setPreview(data);
    } catch (e) {
      setImportMessage(e instanceof ApiError ? e.message : String(e));
    } finally {
      setPreviewBusy(false);
    }
  };

  const onConfirmImport = async () => {
    if (!stagedFile) {
      return;
    }
    setImportBusy(true);
    setImportMessage(null);
    try {
      const fd = new FormData();
      fd.append("archive", stagedFile);
      const { data } = await apiPostFormData<{ companyId: string; name: string }>("/companies/import/files", null, fd);
      setImportMessage(`Imported new company “${data.name}” (${data.companyId}). Refresh the company list to open it.`);
      setStagedFile(null);
      setPreview(null);
    } catch (e) {
      setImportMessage(e instanceof ApiError ? e.message : String(e));
    } finally {
      setImportBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Import company from zip</CardTitle>
        <CardDescription>
          Only members with the board role can import.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Field>
          <FieldLabel htmlFor={importInputId}>Zip archive</FieldLabel>
          <div className="ui-company-file-import-field-row">
            <Input
              id={importInputId}
              type="file"
              accept=".zip,application/zip"
              disabled={importBusy || previewBusy}
              onChange={(e) => void onFileChosen(e.target.files)}
            />
            {previewBusy ? <span className="ui-company-file-import-busy">Reading archive…</span> : null}
            {importBusy ? <span className="ui-company-file-import-busy">Importing…</span> : null}
          </div>
          {preview && !importBusy ? (
            <div className="ui-company-file-import-preview">
              {preview.ok ? (
                <>
                  <p className="ui-company-file-import-preview-summary">
                    <strong>{preview.companyName}</strong> — {preview.counts.projects} projects, {preview.counts.agents}{" "}
                    agents, {preview.counts.goals} goals, {preview.counts.routines} scheduled routines, {preview.counts.skillFiles}{" "}
                    skill files, {preview.counts.knowledgeFiles} knowledge files.
                  </p>
                  {!preview.hasCeo ? (
                    <p className="ui-company-file-import-preview-warn">Warning: no CEO agent (roleKey ceo) in manifest.</p>
                  ) : null}
                  {preview.warnings.map((w) => (
                    <p key={w} className="ui-company-file-import-preview-warn">
                      {w}
                    </p>
                  ))}
                  <Button type="button" size="sm" className="ui-button-mt-2" disabled={!preview.ok} onClick={() => void onConfirmImport()}>
                    Import this company
                  </Button>
                </>
              ) : (
                <ul className="ui-company-file-import-preview-errors">
                  {preview.errors.map((err) => (
                    <li key={err}>{err}</li>
                  ))}
                </ul>
              )}
            </div>
          ) : null}
          {importMessage ? <p className="ui-company-file-import-message">{importMessage}</p> : null}
        </Field>
      </CardContent>
    </Card>
  );
}
