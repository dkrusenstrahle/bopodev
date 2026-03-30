import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import TurndownService from "turndown";
import { isInsidePath, resolveCompanySkillsPath } from "../lib/instance-paths";

const MAX_OBSERVABILITY_FILES = 200;
const MAX_OBSERVABILITY_FILE_BYTES = 512 * 1024;
const SKILL_MD = "SKILL.md";
export const SKILL_LINK_BASENAME = ".bopo-skill-link.json";
const SKILL_ID_RE = /^[a-zA-Z0-9_-]+$/;
const TEXT_EXT = new Set([".md", ".yaml", ".yml", ".txt", ".json"]);

const STARTER_SKILL_MD = `---
name: new-skill
description: >
  One-line description of when to use this skill.
---

# New skill

Add guidance for the agent here.

`;

export type CompanySkillPackageListItem = {
  skillId: string;
  linkedUrl: string | null;
  linkLastFetchedAt: string | null;
};

export function assertCompanySkillId(skillId: string): string {
  const trimmed = skillId.trim();
  if (trimmed !== skillId || !SKILL_ID_RE.test(trimmed)) {
    throw new Error("Invalid skill id: use letters, digits, underscores, and hyphens only.");
  }
  return trimmed;
}

function assertSkillRelativePath(relativePath: string): string {
  const normalized = relativePath.trim().replace(/\\/g, "/");
  if (!normalized || normalized.includes("..") || normalized.startsWith("/")) {
    throw new Error("Invalid relative path.");
  }
  const base = normalized.split("/").pop() ?? "";
  const lower = base.toLowerCase();
  const ext = lower.includes(".") ? lower.slice(lower.lastIndexOf(".")) : "";
  if (!TEXT_EXT.has(ext)) {
    throw new Error("Only text skill files (.md, .yaml, .yml, .txt, .json) are allowed.");
  }
  return normalized;
}

async function skillRoot(companyId: string, skillId: string) {
  const id = assertCompanySkillId(skillId);
  const skillsRoot = resolveCompanySkillsPath(companyId);
  const root = join(skillsRoot, id);
  if (!isInsidePath(skillsRoot, root)) {
    throw new Error("Invalid skill path.");
  }
  return { skillsRoot, root, id };
}

async function skillDirHasSkillMd(root: string): Promise<boolean> {
  try {
    const s = await stat(join(root, SKILL_MD));
    return s.isFile();
  } catch {
    return false;
  }
}

export type CompanySkillLinkRecord = {
  url: string;
  lastFetchedAt: string | null;
};

export async function readOptionalSkillLinkRecord(root: string): Promise<CompanySkillLinkRecord | null> {
  try {
    const raw = await readFile(join(root, SKILL_LINK_BASENAME), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || !("url" in parsed)) {
      return null;
    }
    const urlRaw = (parsed as { url: unknown }).url;
    if (typeof urlRaw !== "string" || !urlRaw.trim()) {
      return null;
    }
    const url = assertImportUrl(urlRaw.trim()).toString();
    const lastRaw = (parsed as { lastFetchedAt?: unknown }).lastFetchedAt;
    const lastFetchedAt =
      typeof lastRaw === "string" && lastRaw.trim() ? lastRaw.trim() : null;
    return { url, lastFetchedAt };
  } catch {
    return null;
  }
}

export async function readOptionalSkillLinkUrl(root: string): Promise<string | null> {
  const rec = await readOptionalSkillLinkRecord(root);
  return rec?.url ?? null;
}

async function writeSkillLinkMetadata(root: string, url: string): Promise<{ lastFetchedAt: string }> {
  const lastFetchedAt = new Date().toISOString();
  await writeFile(
    join(root, SKILL_LINK_BASENAME),
    JSON.stringify({ url, lastFetchedAt }, null, 2),
    "utf8"
  );
  return { lastFetchedAt };
}

export async function listCompanySkillPackages(input: { companyId: string; maxSkills?: number }) {
  const skillsRoot = resolveCompanySkillsPath(input.companyId);
  await mkdir(skillsRoot, { recursive: true });
  const maxSkills = Math.max(1, Math.min(100, input.maxSkills ?? 50));
  const entries = await readdir(skillsRoot, { withFileTypes: true });
  const items: CompanySkillPackageListItem[] = [];
  for (const ent of entries) {
    if (!ent.isDirectory() || ent.name.startsWith(".")) {
      continue;
    }
    if (!SKILL_ID_RE.test(ent.name)) {
      continue;
    }
    const skillDir = join(skillsRoot, ent.name);
    const hasMd = await skillDirHasSkillMd(skillDir);
    const linkRec = await readOptionalSkillLinkRecord(skillDir);
    const linkedUrl = linkRec?.url ?? null;
    if (!hasMd && !linkedUrl) {
      continue;
    }
    items.push({
      skillId: ent.name,
      linkedUrl,
      linkLastFetchedAt: linkRec?.lastFetchedAt ?? null
    });
    if (items.length >= maxSkills) {
      break;
    }
  }
  items.sort((a, b) => a.skillId.localeCompare(b.skillId));
  return { skillsRoot, items };
}

async function walkSkillTextFiles(skillDir: string, maxFiles: number): Promise<string[]> {
  const collected: string[] = [];
  const queue = [skillDir];
  while (queue.length > 0 && collected.length < maxFiles) {
    const current = queue.shift();
    if (!current) {
      continue;
    }
    const entries = await readdir(current, { withFileTypes: true });
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
        collected.push(relative(skillDir, absolutePath).replace(/\\/g, "/"));
      }
    }
  }
  return collected.sort((a, b) => a.localeCompare(b));
}

export async function listCompanySkillFiles(input: { companyId: string; skillId: string; maxFiles?: number }) {
  const { root } = await skillRoot(input.companyId, input.skillId);
  await mkdir(root, { recursive: true });
  const hasMd = await skillDirHasSkillMd(root);
  const linkedUrl = await readOptionalSkillLinkUrl(root);
  if (!hasMd && !linkedUrl) {
    throw new Error("Skill not found.");
  }
  const maxFiles = Math.max(1, Math.min(MAX_OBSERVABILITY_FILES, input.maxFiles ?? 100));
  const relativePaths = hasMd ? await walkSkillTextFiles(root, maxFiles) : [SKILL_MD];
  return { root, relativePaths, hasLocalSkillMd: hasMd };
}

export async function readCompanySkillFile(input: {
  companyId: string;
  skillId: string;
  relativePath: string;
}) {
  const { root } = await skillRoot(input.companyId, input.skillId);
  const rel = assertSkillRelativePath(input.relativePath);
  const candidate = resolve(root, rel);
  if (!isInsidePath(root, candidate)) {
    throw new Error("Requested path is outside of skill directory.");
  }
  const hasMd = await skillDirHasSkillMd(root);
  const linkedUrl = await readOptionalSkillLinkUrl(root);
  if (rel === SKILL_MD && linkedUrl && !hasMd) {
    const content = await fetchSkillMarkdownFromUrl(new URL(linkedUrl));
    const sizeBytes = Buffer.byteLength(content, "utf8");
    return {
      relativePath: rel,
      content,
      sizeBytes
    };
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

export async function writeCompanySkillFile(input: {
  companyId: string;
  skillId: string;
  relativePath: string;
  content: string;
}) {
  const { root } = await skillRoot(input.companyId, input.skillId);
  const rel = assertSkillRelativePath(input.relativePath);
  const candidate = resolve(root, rel);
  if (!isInsidePath(root, candidate)) {
    throw new Error("Requested path is outside of skill directory.");
  }
  const hasMd = await skillDirHasSkillMd(root);
  const linkedUrl = await readOptionalSkillLinkUrl(root);
  if (linkedUrl && !hasMd && rel !== SKILL_MD) {
    throw new Error(
      "This skill is linked from a URL. Save SKILL.md to your workspace first, then you can add other files."
    );
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

/** Remove `skills/<id>/` entirely (local files and linked-skill pointer). */
export async function deleteCompanySkillPackage(input: { companyId: string; skillId: string }) {
  const { root, id } = await skillRoot(input.companyId, input.skillId);
  let exists = false;
  try {
    const st = await stat(root);
    exists = st.isDirectory();
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? (error as NodeJS.ErrnoException).code : undefined;
    if (code === "ENOENT") {
      throw new Error("Skill not found.");
    }
    throw error;
  }
  if (!exists) {
    throw new Error("Skill not found.");
  }
  const hasMd = await skillDirHasSkillMd(root);
  const linkedUrl = await readOptionalSkillLinkUrl(root);
  if (!hasMd && !linkedUrl) {
    throw new Error("Skill not found.");
  }
  await rm(root, { recursive: true, force: true });
  return { skillId: id };
}

/** Create `skills/<id>/SKILL.md` if the package does not exist yet. */
export async function createCompanySkillPackage(input: { companyId: string; skillId: string }) {
  const { root, id } = await skillRoot(input.companyId, input.skillId);
  await mkdir(root, { recursive: true });
  const manifest = join(root, SKILL_MD);
  try {
    await stat(manifest);
    throw new Error("A skill with this id already exists.");
  } catch (error) {
    if (error instanceof Error && error.message === "A skill with this id already exists.") {
      throw error;
    }
  }
  await writeFile(manifest, STARTER_SKILL_MD, { encoding: "utf8" });
  return { skillId: id, relativePath: SKILL_MD };
}

const IMPORT_MAX_BYTES = MAX_OBSERVABILITY_FILE_BYTES;
const IMPORT_TIMEOUT_MS = 20_000;
const ALLOWED_IMPORT_HOSTS = new Set([
  "raw.githubusercontent.com",
  "gist.githubusercontent.com",
  "skills.sh",
  "www.skills.sh"
]);

/** skills.sh renders the skill as HTML; we scrape the embedded prose block and convert to markdown. */
const SKILLS_SH_PROSE_RE =
  /SKILL\.md<\/span><\/div><div class="prose[^"]*">([\s\S]*?)<\/div><\/div><\/div><div class="\s*lg:col-span-3">/;

let turndownSingleton: TurndownService | null = null;

function getTurndown(): TurndownService {
  if (!turndownSingleton) {
    turndownSingleton = new TurndownService({
      headingStyle: "atx",
      codeBlockStyle: "fenced",
      bulletListMarker: "-"
    });
  }
  return turndownSingleton;
}

function isSkillsShHost(hostname: string): boolean {
  return hostname === "skills.sh" || hostname === "www.skills.sh";
}

function looksLikeHtmlDocument(text: string): boolean {
  const head = text.slice(0, 8000).trimStart();
  return head.startsWith("<!DOCTYPE") || head.startsWith("<html");
}

export function extractSkillsShProseHtml(pageHtml: string): string | null {
  const m = pageHtml.match(SKILLS_SH_PROSE_RE);
  return m?.[1]?.trim() ? m[1] : null;
}

export function htmlProseFragmentToMarkdown(htmlFragment: string): string {
  return getTurndown().turndown(htmlFragment).trim();
}

export function assertImportUrl(urlString: string): URL {
  let url: URL;
  try {
    url = new URL(urlString.trim());
  } catch {
    throw new Error("Invalid URL.");
  }
  if (url.protocol !== "https:") {
    throw new Error("Only https URLs are allowed.");
  }
  if (!ALLOWED_IMPORT_HOSTS.has(url.hostname)) {
    throw new Error(`Host not allowed. Use one of: ${[...ALLOWED_IMPORT_HOSTS].join(", ")}`);
  }
  return url;
}

function parseYamlNameFromSkillFrontmatter(markdown: string): string | null {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) {
    return null;
  }
  const block = match[1] ?? "";
  const lineMatch = block.match(/^\s*name:\s*(.+)$/m);
  if (!lineMatch) {
    return null;
  }
  let v = (lineMatch[1] ?? "").trim();
  if (
    (v.startsWith('"') && v.endsWith('"')) ||
    (v.startsWith("'") && v.endsWith("'"))
  ) {
    v = v.slice(1, -1).trim();
  }
  return v.length > 0 ? v : null;
}

function inferSkillIdFromUrlPath(url: URL): string {
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length === 0) {
    return "linked-skill";
  }
  const last = parts[parts.length - 1] ?? "";
  const base =
    last.toLowerCase() === "skill.md" && parts.length >= 2 ? (parts[parts.length - 2] ?? last) : last;
  return base.length > 0 ? base : "linked-skill";
}

/** Maps a title or path segment to a valid company skill folder id. */
function slugifyForCompanySkillId(raw: string): string {
  const s = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-");
  return s.length > 0 ? s : "linked-skill";
}

/** Single fetch; used when linking from URL so SKILL.md and link metadata stay in sync. */
async function resolveIdAndMarkdownForUrlLink(input: {
  url: URL;
  explicitSkillId?: string;
}): Promise<{ id: string; markdown: string }> {
  const markdown = await fetchSkillMarkdownFromUrl(input.url);
  if (input.explicitSkillId !== undefined && input.explicitSkillId.trim()) {
    return { id: assertCompanySkillId(input.explicitSkillId), markdown };
  }
  const fromFrontmatter = parseYamlNameFromSkillFrontmatter(markdown);
  const candidate = fromFrontmatter ?? inferSkillIdFromUrlPath(input.url);
  const id = slugifyForCompanySkillId(candidate);
  try {
    return { id: assertCompanySkillId(id), markdown };
  } catch {
    return {
      id: assertCompanySkillId(slugifyForCompanySkillId(inferSkillIdFromUrlPath(input.url))),
      markdown
    };
  }
}

export async function fetchSkillMarkdownFromUrl(url: URL): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), IMPORT_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: { Accept: "text/html,text/plain,text/markdown,application/xhtml+xml,*/*" }
    });
    if (!res.ok) {
      throw new Error(`Fetch failed with status ${res.status}.`);
    }
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength > IMPORT_MAX_BYTES) {
      throw new Error("Downloaded file exceeds size limit.");
    }
    const text = new TextDecoder("utf8", { fatal: false }).decode(buf);
    if (!text.trim()) {
      throw new Error("Downloaded file is empty.");
    }
    if (isSkillsShHost(url.hostname) && looksLikeHtmlDocument(text)) {
      const fragment = extractSkillsShProseHtml(text);
      if (!fragment) {
        throw new Error(
          "Could not read skill text from this skills.sh page (layout changed or not a skill detail page). Try a raw GitHub URL to SKILL.md."
        );
      }
      const md = htmlProseFragmentToMarkdown(fragment);
      if (!md.trim()) {
        throw new Error("Converted skills.sh content was empty.");
      }
      return `${md}\n`;
    }
    if (looksLikeHtmlDocument(text)) {
      throw new Error(
        "URL returned HTML, not markdown. Use skills.sh skill pages, or raw.githubusercontent.com / gist.githubusercontent.com links to SKILL.md."
      );
    }
    return text;
  } finally {
    clearTimeout(timer);
  }
}

/** Download SKILL.md, write `.bopo-skill-link.json` with url and lastFetchedAt (legacy link-only dirs still fetch on read until refreshed). */
export async function linkCompanySkillFromUrl(input: {
  companyId: string;
  url: string;
  /** When omitted, id is taken from the skill frontmatter `name` or the URL path. */
  skillId?: string;
}) {
  const url = assertImportUrl(input.url);
  const { id, markdown } = await resolveIdAndMarkdownForUrlLink({
    url,
    explicitSkillId: input.skillId
  });
  const { root } = await skillRoot(input.companyId, id);
  await mkdir(root, { recursive: true });
  await writeFile(join(root, SKILL_MD), markdown, { encoding: "utf8" });
  const { lastFetchedAt } = await writeSkillLinkMetadata(root, url.toString());
  return { skillId: id, url: url.toString(), lastFetchedAt };
}

/** Re-fetch from the URL stored in `.bopo-skill-link.json` and overwrite local SKILL.md. */
export async function refreshCompanySkillFromUrl(input: { companyId: string; skillId: string }) {
  const { root, id } = await skillRoot(input.companyId, input.skillId);
  const record = await readOptionalSkillLinkRecord(root);
  if (!record?.url) {
    throw new Error("Skill is not linked from a URL.");
  }
  const markdown = await fetchSkillMarkdownFromUrl(new URL(record.url));
  await writeFile(join(root, SKILL_MD), markdown, { encoding: "utf8" });
  const { lastFetchedAt } = await writeSkillLinkMetadata(root, record.url);
  return { skillId: id, url: record.url, lastFetchedAt };
}

export async function materializeLinkedSkillsForRuntime(
  companyId: string,
  options?: { enabledSkillIds?: string[] }
): Promise<{
  root: string | null;
  cleanup: () => Promise<void>;
}> {
  const { skillsRoot, items } = await listCompanySkillPackages({ companyId, maxSkills: 100 });
  const tmpRoot = await mkdtemp(join(tmpdir(), "bopodev-linked-skills-"));
  const allow = options?.enabledSkillIds;
  let written = 0;
  try {
    for (const item of items) {
      if (allow !== undefined && !allow.includes(item.skillId)) {
        continue;
      }
      if (!item.linkedUrl) {
        continue;
      }
      const dir = join(skillsRoot, item.skillId);
      if (await skillDirHasSkillMd(dir)) {
        continue;
      }
      try {
        const body = await fetchSkillMarkdownFromUrl(new URL(item.linkedUrl));
        const dest = join(tmpRoot, item.skillId);
        await mkdir(dest, { recursive: true });
        await writeFile(join(dest, SKILL_MD), body, "utf8");
        written += 1;
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error("[linked-skills] materialize fetch failed", item.skillId, error);
      }
    }
    if (written === 0) {
      await rm(tmpRoot, { recursive: true, force: true });
      return { root: null, cleanup: async () => {} };
    }
    return {
      root: tmpRoot,
      cleanup: async () => {
        await rm(tmpRoot, { recursive: true, force: true }).catch(() => undefined);
      }
    };
  } catch (error) {
    await rm(tmpRoot, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}
