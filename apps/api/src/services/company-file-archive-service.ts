import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import type { Readable } from "node:stream";
import archiver from "archiver";
import { stringify as yamlStringify } from "yaml";
import type { BopoDb } from "bopodev-db";
import { getCompany, listAgents, listProjects } from "bopodev-db";
import {
  resolveAgentMemoryRootPath,
  resolveAgentOperatingPath,
  resolveCompanyProjectsWorkspacePath
} from "../lib/instance-paths";
import { SKILL_LINK_BASENAME } from "./company-skill-file-service";
import { listWorkLoopTriggers, listWorkLoops } from "./work-loop-service/work-loop-service";

const EXPORT_SCHEMA = "bopo/company-export/v1";
const MAX_TEXT_FILE_BYTES = 512_000;
const MAX_WALK_FILES = 400;
const TEXT_EXT = new Set([".md", ".yaml", ".yml", ".txt", ".json"]);

export class CompanyFileArchiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CompanyFileArchiveError";
  }
}

export type CompanyExportFileEntry = {
  path: string;
  bytes: number;
  source: "generated" | "workspace";
};

function slugify(base: string, used: Set<string>): string {
  const raw = base
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  let s = raw.length > 0 ? raw : "item";
  let n = 2;
  while (used.has(s)) {
    s = `${raw}-${n}`;
    n += 1;
  }
  used.add(s);
  return s;
}

function companySlug(name: string, companyId: string) {
  const fromName = slugify(name, new Set());
  return fromName.length >= 2 ? fromName : `company-${companyId.slice(0, 8)}`;
}

async function walkTextFilesUnder(rootAbs: string, budget: { n: number }): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  async function walk(dir: string) {
    if (budget.n >= MAX_WALK_FILES) {
      return;
    }
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (budget.n >= MAX_WALK_FILES) {
        return;
      }
      const name = ent.name;
      if (name.startsWith(".") && name !== SKILL_LINK_BASENAME) {
        continue;
      }
      const full = join(dir, name);
      if (ent.isDirectory()) {
        await walk(full);
        continue;
      }
      const lower = name.toLowerCase();
      const ext = lower.includes(".") ? lower.slice(lower.lastIndexOf(".")) : "";
      if (!TEXT_EXT.has(ext)) {
        continue;
      }
      try {
        const st = await stat(full);
        if (!st.isFile() || st.size > MAX_TEXT_FILE_BYTES) {
          continue;
        }
        const body = await readFile(full, "utf8");
        const rel = relative(rootAbs, full).replace(/\\/g, "/");
        out[rel] = body;
        budget.n += 1;
      } catch {
        /* skip */
      }
    }
  }
  await walk(rootAbs);
  return out;
}

async function walkSkillsDir(companyId: string, budget: { n: number }): Promise<Record<string, string>> {
  const root = join(resolveCompanyProjectsWorkspacePath(companyId), "skills");
  const files = await walkTextFilesUnder(root, budget);
  const out: Record<string, string> = {};
  for (const [rel, content] of Object.entries(files)) {
    out[`skills/${rel}`] = content;
  }
  return out;
}

function buildReadmeMarkdown(input: {
  companyName: string;
  slug: string;
  agentRows: { slug: string; name: string; role: string; managerSlug: string | null }[];
  projectRows: { slug: string; name: string; description: string | null }[];
  skillFileCount: number;
  taskCount: number;
  exportedAt: string;
}): string {
  const lines = [
    `# ${input.companyName}`,
    "",
    "## What's inside",
    "",
    "| Content | Count |",
    "|---------|-------|",
    `| Agents | ${input.agentRows.length} |`,
    `| Projects | ${input.projectRows.length} |`,
    `| Skills (files under skills/) | ${input.skillFileCount} |`,
    `| Scheduled tasks | ${input.taskCount} |`,
    "",
    "### Agents",
    "",
    "| Agent | Role | Reports to |",
    "|-------|------|------------|"
  ];
  for (const a of input.agentRows) {
    lines.push(`| ${a.name} | ${a.role} | ${a.managerSlug ?? "—"} |`);
  }
  lines.push("", "### Projects", "");
  for (const p of input.projectRows) {
    const d = p.description?.trim() || "";
    lines.push(`- **${p.name}**${d ? ` — ${d}` : ""}`);
  }
  lines.push(
    "",
    "## Import",
    "",
    "Upload the `.zip` from the Bopo workspace (Company export), or use the API `POST /companies/import/files` with `multipart/form-data` field `archive`.",
    "",
    "---",
    `Exported from Bopo on ${input.exportedAt.slice(0, 10)} (package slug: \`${input.slug}\`).`,
    ""
  );
  return lines.join("\n");
}

export async function buildCompanyExportFileMap(
  db: BopoDb,
  companyId: string,
  options: { includeAgentMemory: boolean }
): Promise<{ files: Record<string, string>; manifestPaths: string[] }> {
  const company = await getCompany(db, companyId);
  if (!company) {
    throw new CompanyFileArchiveError("Company not found.");
  }

  const [projects, agents] = await Promise.all([listProjects(db, companyId), listAgents(db, companyId)]);
  const loops = await listWorkLoops(db, companyId);

  const usedSlugs = new Set<string>();
  const companySlugValue = companySlug(company.name, company.id);

  const projectSlugById = new Map<string, string>();
  const projectEntries: { id: string; slug: string; name: string; description: string | null; status: string }[] = [];
  for (const p of projects) {
    const slug = slugify(p.name, usedSlugs);
    projectSlugById.set(p.id, slug);
    projectEntries.push({
      id: p.id,
      slug,
      name: p.name,
      description: p.description ?? null,
      status: p.status
    });
  }

  const agentSlugById = new Map<string, string>();
  const agentManifest: Record<
    string,
    {
      bopoAgentId: string;
      name: string;
      role: string;
      roleKey: string | null;
      title: string | null;
      capabilities: string | null;
      managerSlug: string | null;
      providerType: string;
      heartbeatCron: string;
      canHireAgents: boolean;
    }
  > = {};

  const orderedAgents = [...agents].sort((a, b) => a.name.localeCompare(b.name));
  for (const a of orderedAgents) {
    agentSlugById.set(a.id, slugify(a.name, usedSlugs));
  }
  for (const a of orderedAgents) {
    const slug = agentSlugById.get(a.id)!;
    const mgrSlug = a.managerAgentId ? agentSlugById.get(a.managerAgentId) ?? null : null;
    agentManifest[slug] = {
      bopoAgentId: a.id,
      name: a.name,
      role: a.role,
      roleKey: a.roleKey ?? null,
      title: a.title ?? null,
      capabilities: a.capabilities ?? null,
      managerSlug: mgrSlug,
      providerType: a.providerType,
      heartbeatCron: a.heartbeatCron,
      canHireAgents: Boolean(a.canHireAgents)
    };
  }

  const routineManifest: Record<
    string,
    {
      bopoLoopId: string;
      title: string;
      description: string | null;
      projectSlug: string;
      assigneeAgentSlug: string;
      triggers: { cronExpression: string; timezone: string; label: string | null }[];
    }
  > = {};

  const usedTaskSlugs = new Set<string>(usedSlugs);
  for (const loop of loops) {
    const triggers = await listWorkLoopTriggers(db, companyId, loop.id);
    const scheduleTriggers = triggers.filter((t) => t.kind === "schedule" && t.enabled !== false);
    if (scheduleTriggers.length === 0) {
      continue;
    }
    const projectSlug = projectSlugById.get(loop.projectId);
    const assigneeSlug = agentSlugById.get(loop.assigneeAgentId);
    if (!projectSlug || !assigneeSlug) {
      continue;
    }
    const taskSlug = slugify(loop.title, usedTaskSlugs);
    routineManifest[taskSlug] = {
      bopoLoopId: loop.id,
      title: loop.title,
      description: loop.description ?? null,
      projectSlug,
      assigneeAgentSlug: assigneeSlug,
      triggers: scheduleTriggers.map((t) => ({
        cronExpression: t.cronExpression,
        timezone: t.timezone ?? "UTC",
        label: t.label ?? null
      }))
    };
  }

  const yamlDoc = {
    schema: EXPORT_SCHEMA,
    exportedAt: new Date().toISOString(),
    company: {
      bopoCompanyId: company.id,
      name: company.name,
      mission: company.mission ?? null,
      slug: companySlugValue
    },
    projects: Object.fromEntries(projectEntries.map((p) => [p.slug, { bopoProjectId: p.id, name: p.name, description: p.description, status: p.status }])),
    agents: agentManifest,
    routines: routineManifest
  };

  const files: Record<string, string> = {};
  files[".bopo.yaml"] = yamlStringify(yamlDoc);

  const mission = company.mission?.trim() ?? "";
  files["COMPANY.md"] = ["---", `name: "${company.name.replace(/"/g, '\\"')}"`, `schema: bopo/company-md/v1`, `slug: "${companySlugValue}"`, "---", "", mission, ""].join("\n");

  const agentRowsForReadme = orderedAgents.map((a) => ({
    slug: agentSlugById.get(a.id)!,
    name: a.name,
    role: a.role,
    managerSlug: a.managerAgentId ? agentSlugById.get(a.managerAgentId) ?? null : null
  }));

  const skillBudget = { n: 0 };
  const skillFiles = await walkSkillsDir(companyId, skillBudget);
  const skillFileCount = Object.keys(skillFiles).length;
  for (const [p, c] of Object.entries(skillFiles)) {
    files[p] = c;
  }

  const taskCount = Object.keys(routineManifest).length;

  files["README.md"] = buildReadmeMarkdown({
    companyName: company.name,
    slug: companySlugValue,
    agentRows: agentRowsForReadme,
    projectRows: projectEntries.map((p) => ({ slug: p.slug, name: p.name, description: p.description })),
    skillFileCount,
    taskCount,
    exportedAt: yamlDoc.exportedAt
  });

  for (const p of projectEntries) {
    const desc = p.description?.trim() ?? "";
    const body = ["---", `name: "${p.name.replace(/"/g, '\\"')}"`, desc ? `description: "${desc.replace(/"/g, '\\"')}"` : `description: ""`, `status: "${p.status}"`, "---", "", desc || p.name, ""].join("\n");
    files[`projects/${p.slug}/PROJECT.md`] = body;
  }

  const walkBudget = { n: 0 };
  for (const a of orderedAgents) {
    const slug = agentSlugById.get(a.id)!;
    const opRoot = resolveAgentOperatingPath(companyId, a.id);
    const opFiles = await walkTextFilesUnder(opRoot, walkBudget);
    for (const [rel, content] of Object.entries(opFiles)) {
      files[`agents/${slug}/${rel}`] = content;
    }
    if (options.includeAgentMemory) {
      const memRoot = resolveAgentMemoryRootPath(companyId, a.id);
      const memFiles = await walkTextFilesUnder(memRoot, walkBudget);
      for (const [rel, content] of Object.entries(memFiles)) {
        files[`agents/${slug}/memory/${rel}`] = content;
      }
    }
  }

  for (const [taskSlug, r] of Object.entries(routineManifest)) {
    const primary = r.triggers[0]!;
    const front = [
      "---",
      `name: "${r.title.replace(/"/g, '\\"')}"`,
      `assignee: "${r.assigneeAgentSlug}"`,
      `project: "${r.projectSlug}"`,
      `recurring: true`,
      `cronExpression: "${primary.cronExpression}"`,
      `timezone: "${primary.timezone}"`,
      primary.label ? `label: "${String(primary.label).replace(/"/g, '\\"')}"` : "",
      "---",
      "",
      r.description?.trim() || r.title,
      ""
    ]
      .filter(Boolean)
      .join("\n");
    files[`tasks/${taskSlug}/TASK.md`] = front;
  }

  const manifestPaths = Object.keys(files).sort();
  return { files, manifestPaths };
}

export async function listCompanyExportManifest(
  db: BopoDb,
  companyId: string,
  options: { includeAgentMemory: boolean }
): Promise<CompanyExportFileEntry[]> {
  const { files } = await buildCompanyExportFileMap(db, companyId, options);
  return Object.entries(files)
    .map(([path, content]): CompanyExportFileEntry => {
      const source: "generated" | "workspace" =
        path.startsWith("agents/") || path.startsWith("skills/") ? "workspace" : "generated";
      return {
        path,
        bytes: Buffer.byteLength(content, "utf8"),
        source
      };
    })
    .sort((a, b) => a.path.localeCompare(b.path));
}

export function normalizeExportPath(p: string): string | null {
  const t = p.trim().replace(/\\/g, "/").replace(/^\/+/, "");
  if (!t || t.includes("..") || t.startsWith("/")) {
    return null;
  }
  if (!/^[a-zA-Z0-9._ /-]+$/.test(t)) {
    return null;
  }
  return t;
}

export async function pipeCompanyExportZip(
  db: BopoDb,
  companyId: string,
  input: { paths: string[] | null; includeAgentMemory: boolean }
): Promise<Readable> {
  const { files, manifestPaths } = await buildCompanyExportFileMap(db, companyId, {
    includeAgentMemory: input.includeAgentMemory
  });
  const allow = new Set(manifestPaths);
  const selected =
    input.paths && input.paths.length > 0
      ? input.paths.flatMap((raw) => {
          const p = normalizeExportPath(raw);
          return p && allow.has(p) ? [p] : [];
        })
      : manifestPaths;

  if (selected.length === 0) {
    throw new CompanyFileArchiveError("No files selected for export.");
  }

  const archive = archiver("zip", { zlib: { level: 9 } });
  for (const path of selected) {
    const content = files[path];
    if (content === undefined) {
      continue;
    }
    archive.append(content, { name: path });
  }
  void archive.finalize();
  return archive;
}

/** Stream a single workspace file for preview (path must be under generated export set). */
export async function readCompanyExportFileText(
  db: BopoDb,
  companyId: string,
  path: string,
  options: { includeAgentMemory: boolean }
): Promise<{ content: string; truncated: boolean } | null> {
  const normalized = normalizeExportPath(path);
  if (!normalized) {
    return null;
  }
  const { files } = await buildCompanyExportFileMap(db, companyId, options);
  const content = files[normalized];
  if (content === undefined) {
    return null;
  }
  const max = 120_000;
  if (content.length <= max) {
    return { content, truncated: false };
  }
  return { content: `${content.slice(0, max)}\n\n…(truncated for preview)`, truncated: true };
}
