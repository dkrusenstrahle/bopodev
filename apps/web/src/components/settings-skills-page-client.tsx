"use client";

import type { Route } from "next";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { FilePenLine, Link2 } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import createAgentModalStyles from "@/components/modals/create-agent-modal.module.scss";
import { LazyMarkdownMdxEditor } from "@/components/modals/lazy-markdown-mdx-editor";
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
import { ApiError, apiDelete, apiGet, apiPost, apiPut } from "@/lib/api";
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
  const [editorOverlayRoot, setEditorOverlayRoot] = useState<HTMLDivElement | null>(null);

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

  const refreshCompanySkills = useCallback(async () => {
    if (!companyId) {
      return;
    }
    const res = await apiGet<CompanySkillsListResponse>("/observability/company-skills", companyId);
    setCompanyItems(res.data.items);
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

  const skillIsUrlLinkedOnly = Boolean(
    selectedCompanyPack?.linkedUrl && !selectedCompanyPack?.hasLocalSkillMd
  );
  const skillHasLinkedUrl = Boolean(selectedCompanyPack?.linkedUrl);

  const syncDataRef = useRef({ builtinIds, companyItems });
  syncDataRef.current = { builtinIds, companyItems };

  useEffect(() => {
    const onPopState = () => {
      const params = new URLSearchParams(window.location.search);
      const k = params.get("kind") as DocKind | null;
      const sid = params.get("skillId") ?? "";
      const p = params.get("path") ?? "";
      const { builtinIds: bi, companyItems: ci } = syncDataRef.current;
      setOpen(parseOpenFromUrl(k, sid, p, bi, ci));
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const loadKey = open ? `${open.kind}\0${open.skillId}\0${open.relativePath}` : "";
  const loadKeyRef = useRef(loadKey);
  loadKeyRef.current = loadKey;

  const onEditorMarkdownChange = useCallback(
    (next: string, initialMarkdownNormalize?: boolean) => {
      if (initialMarkdownNormalize) {
        setBaselineContent(next);
        setDraftContent(next);
        return;
      }
      setDraftContent(next);
    },
    []
  );

  const dirtyRef = useRef(false);
  const readOnly = open?.kind === "builtin" || skillIsUrlLinkedOnly;
  dirtyRef.current = open !== null && !readOnly && draftContent !== baselineContent;

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

  async function save() {
    if (!companyId || !open || open.kind !== "company" || !dirty) {
      return;
    }
    const keyAtStart = loadKeyRef.current;
    setSaveError(null);
    setSaving(true);
    try {
      const q = `?skillId=${encodeURIComponent(open.skillId)}&path=${encodeURIComponent(open.relativePath)}`;
      await apiPut(`/observability/company-skills/file${q}`, companyId, { content: draftContent });
      if (loadKeyRef.current !== keyAtStart) {
        return;
      }
      setBaselineContent(draftContent);
    } catch (error) {
      if (loadKeyRef.current === keyAtStart) {
        setSaveError(error instanceof ApiError ? error.message : "Save failed.");
      }
    } finally {
      setSaving(false);
    }
  }

  function selectBuiltin(skillId: string) {
    const next = { kind: "builtin" as const, skillId, relativePath: "" };
    setOpen(next);
    syncSelectionToUrl(next);
  }

  function selectCompanyFile(skillId: string, relativePath: string) {
    const next = { kind: "company" as const, skillId, relativePath };
    setOpen(next);
    syncSelectionToUrl(next);
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

  const secondaryPane = (
    <div className="run-sidebar-pane">
      {listsLoading ? null : listsError ? (
        <Alert variant="destructive" className="ui-settings-skills-sidebar-alert">
          <AlertDescription>{listsError}</AlertDescription>
        </Alert>
      ) : (
        <div className="run-sidebar-list">
          <div className="ui-agent-docs-sidebar-section-label">Defaults</div>
          {builtinSkills.map((b) => {
            const active = open?.kind === "builtin" && open.skillId === b.id;
            return (
              <button
                key={`bi-${b.id}`}
                type="button"
                className={cn(
                  "run-sidebar-item",
                  "ui-agent-docs-sidebar-item",
                  active && "run-sidebar-item--active"
                )}
                onClick={() => selectBuiltin(b.id)}
              >
                <div className="run-sidebar-item-header">
                  <span className="run-sidebar-item-id" title={b.id}>
                    {b.id}
                  </span>
                </div>
              </button>
            );
          })}
          <div className="ui-agent-docs-sidebar-section-label ui-agent-docs-sidebar-section-label--spaced">
            Custom
          </div>
          {companyItems.length === 0 ? (
            <p className="ui-agent-docs-sidebar-empty">No company skills yet.</p>
          ) : (
            companyItems.map((pack) => (
              <div key={pack.skillId}>
                {pack.files.map((f) => {
                  const active =
                    open?.kind === "company" && open.skillId === pack.skillId && open.relativePath === f.relativePath;
                  const multiFile = pack.files.length > 1;
                  return (
                    <button
                      key={`${pack.skillId}-${f.relativePath}`}
                      type="button"
                      className={cn(
                        "run-sidebar-item",
                        "ui-agent-docs-sidebar-item",
                        active && "run-sidebar-item--active"
                      )}
                      onClick={() => selectCompanyFile(pack.skillId, f.relativePath)}
                    >
                      <div className="run-sidebar-item-header">
                        <span className="run-sidebar-item-id" title={`${pack.skillId} · ${f.relativePath}`}>
                          {pack.skillId}
                        </span>
                        {pack.linkedUrl ? (
                          <span
                            className="ui-settings-skills-linked-pill"
                            title={
                              pack.linkLastFetchedAt
                                ? `Linked · last fetched ${pack.linkLastFetchedAt}`
                                : "Linked from URL"
                            }
                          >
                            Linked
                          </span>
                        ) : null}
                      </div>
                      {multiFile ? (
                        <p className="run-sidebar-item-message">{f.relativePath}</p>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            ))
          )}
          <div className="ui-settings-skills-sidebar-actions">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                setSkillAddStep("intro");
                setCreateError(null);
                setLinkError(null);
                setAddSkillOpen(true);
              }}
              disabled={!companyId}
            >
              Add skill
            </Button>
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
        activeNav="Settings"
        companies={companies}
        activeCompanyId={companyId}
        leftPaneScrollable={false}
        secondaryPane={companyId ? secondaryPane : null}
        leftPane={
          <div className="run-detail-pane" ref={setEditorOverlayRoot}>
            <SectionHeading
              title="Skills"
              description={headerDescription}
              actions={
                <div className="ui-agent-docs-header-actions">
                  {companyId && open?.kind === "company" && skillIsUrlLinkedOnly ? (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => void forkLinkedSkillToWorkspace()}
                      disabled={forkBusy || !editorReady}
                    >
                      {forkBusy ? "Saving copy…" : "Save copy"}
                    </Button>
                  ) : null}
                  {companyId && open?.kind === "company" && skillHasLinkedUrl ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => void refreshLinkedSkillFromUrl()}
                      disabled={refreshBusy || !editorReady}
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
                      disabled={deleteBusy}
                    >
                      Delete
                    </Button>
                  ) : null}
                  <Button
                    size="sm"
                    onClick={() => void save()}
                    disabled={readOnly || !dirty || saving || !editorReady || !open}
                  >
                    {readOnly ? "Read-only" : saving ? "Saving…" : dirty ? "Save" : "Saved"}
                  </Button>
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
              <div className="ui-agent-docs-editor-shell">
                {editorLoading ? (
                  <div className="ui-agent-docs-editor-loading">Loading…</div>
                ) : editorReady ? (
                  <LazyMarkdownMdxEditor
                    key={loadKey}
                    editorKey={loadKey}
                    markdown={draftContent}
                    onChange={onEditorMarkdownChange}
                    compact={false}
                    className="ui-agent-docs-editor"
                    overlayContainer={editorOverlayRoot ?? undefined}
                    readOnly={readOnly}
                  />
                ) : fileError ? (
                  <div className="ui-agent-docs-editor-loading">Could not load this file.</div>
                ) : null}
              </div>
            ) : null}
          </div>
        }
      />

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
