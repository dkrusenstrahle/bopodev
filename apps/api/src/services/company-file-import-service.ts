import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { unzipSync } from "fflate";
import { parse as yamlParse } from "yaml";
import { z } from "zod";
import type { BopoDb } from "bopodev-db";
import { createAgent, createCompany, createGoal, createProject, updateAgent, updateGoal } from "bopodev-db";
import { normalizeRuntimeConfig, runtimeConfigToDb, runtimeConfigToStateBlobPatch } from "../lib/agent-config";
import {
  resolveAgentMemoryRootPath,
  resolveAgentOperatingPath,
  resolveCompanyProjectsWorkspacePath
} from "../lib/instance-paths";
import { resolveDefaultRuntimeCwdForCompany } from "../lib/workspace-policy";
import { ensureBuiltinPluginsRegistered } from "./plugin-runtime";
import { ensureCompanyBuiltinTemplateDefaults } from "./template-catalog";
import { addWorkLoopTrigger, createWorkLoop } from "./work-loop-service/work-loop-service";

export const EXPORT_SCHEMA = "bopo/company-export/v1";

const goalLevelSchema = z.enum(["company", "project", "agent"]);
const goalStatusSchema = z.enum(["draft", "active", "completed", "archived"]);

export const BopoExportYamlSchema = z.object({
  schema: z.string(),
  company: z.object({
    name: z.string().min(1),
    mission: z.string().nullable().optional(),
    slug: z.string().optional()
  }),
  projects: z.record(
    z.string(),
    z.object({ name: z.string().min(1), description: z.string().nullable().optional(), status: z.string().optional() })
  ),
  agents: z.record(
    z.string(),
    z.object({
      name: z.string().min(1),
      role: z.string().min(1),
      roleKey: z.string().nullable().optional(),
      title: z.string().nullable().optional(),
      capabilities: z.string().nullable().optional(),
      managerSlug: z.string().nullable().optional(),
      providerType: z.string().min(1),
      heartbeatCron: z.string().min(1),
      canHireAgents: z.boolean().optional(),
      canAssignAgents: z.boolean().optional(),
      canCreateIssues: z.boolean().optional(),
      bootstrapPrompt: z.string().nullable().optional(),
      monthlyBudgetUsd: z.union([z.string(), z.number()]).optional()
    })
  ),
  goals: z
    .record(
      z.string(),
      z.object({
        level: goalLevelSchema,
        title: z.string().min(1),
        description: z.string().nullable().optional(),
        status: goalStatusSchema.optional(),
        projectSlug: z.string().nullable().optional(),
        parentGoalSlug: z.string().nullable().optional(),
        ownerAgentSlug: z.string().nullable().optional()
      })
    )
    .optional(),
  routines: z
    .record(
      z.string(),
      z.object({
        title: z.string().min(1),
        description: z.string().nullable().optional(),
        projectSlug: z.string().min(1),
        assigneeAgentSlug: z.string().min(1),
        triggers: z
          .array(
            z.object({
              cronExpression: z.string().min(1),
              timezone: z.string().optional(),
              label: z.string().nullable().optional()
            })
          )
          .min(1)
      })
    )
    .optional()
});

export type BopoExportDoc = z.infer<typeof BopoExportYamlSchema>;

export type ParsedCompanyPackage = {
  doc: BopoExportDoc;
  entries: Record<string, string>;
};

export class CompanyFileImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CompanyFileImportError";
  }
}

function normalizeZipPath(key: string): string | null {
  const t = key.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!t || t.includes("..")) {
    return null;
  }
  return t;
}

export function decodeZipEntries(buffer: Buffer): Record<string, string> {
  let raw: Record<string, Uint8Array>;
  try {
    raw = unzipSync(new Uint8Array(buffer));
  } catch {
    throw new CompanyFileImportError("Archive is not a valid zip file.");
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    const path = normalizeZipPath(k);
    if (!path || path.endsWith("/")) {
      continue;
    }
    try {
      out[path] = new TextDecoder("utf8", { fatal: false }).decode(v);
    } catch {
      /* skip binary */
    }
  }
  return out;
}

/** Parse and validate a company zip; throws CompanyFileImportError on failure. */
export function parseCompanyZipBuffer(buffer: Buffer): ParsedCompanyPackage {
  const entries = decodeZipEntries(buffer);
  const yamlText = entries[".bopo.yaml"] ?? entries["bopo.yaml"];
  if (!yamlText?.trim()) {
    throw new CompanyFileImportError('Zip must contain a ".bopo.yaml" manifest at the archive root.');
  }
  let parsedYaml: unknown;
  try {
    parsedYaml = yamlParse(yamlText);
  } catch {
    throw new CompanyFileImportError(".bopo.yaml is not valid YAML.");
  }
  const parsed = BopoExportYamlSchema.safeParse(parsedYaml);
  if (!parsed.success) {
    throw new CompanyFileImportError(`Invalid export manifest: ${parsed.error.message}`);
  }
  const doc = parsed.data;
  if (doc.schema !== EXPORT_SCHEMA) {
    throw new CompanyFileImportError(`Unsupported export schema '${doc.schema}' (expected ${EXPORT_SCHEMA}).`);
  }
  return { doc, entries };
}

const PROVIDER_TYPES = new Set([
  "claude_code",
  "codex",
  "cursor",
  "opencode",
  "gemini_cli",
  "openai_api",
  "anthropic_api",
  "openclaw_gateway",
  "http",
  "shell"
]);

type AgentProvider = NonNullable<Parameters<typeof createAgent>[1]["providerType"]>;

function coerceProviderType(raw: string): AgentProvider {
  return PROVIDER_TYPES.has(raw) ? (raw as AgentProvider) : "shell";
}

function formatMonthlyBudgetUsdFromManifest(raw: string | number | undefined): string {
  if (raw === undefined) {
    return "100.0000";
  }
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return raw.toFixed(4);
  }
  const s = String(raw).trim();
  if (!s) {
    return "100.0000";
  }
  const n = Number(s);
  return Number.isFinite(n) ? n.toFixed(4) : "100.0000";
}

function sortGoalSlugsForImport(
  goals: Record<string, { parentGoalSlug?: string | null | undefined }>
): string[] {
  const slugs = Object.keys(goals);
  const slugSet = new Set(slugs);
  const remaining = new Set(slugs);
  const order: string[] = [];
  while (remaining.size > 0) {
    const ready = [...remaining].filter((slug) => {
      const p = goals[slug]?.parentGoalSlug?.trim();
      if (!p) {
        return true;
      }
      if (!slugSet.has(p)) {
        throw new CompanyFileImportError(`Goal '${slug}' references unknown parent goal slug '${p}'.`);
      }
      return !remaining.has(p);
    });
    if (ready.length === 0) {
      throw new CompanyFileImportError("Circular goal parent chain in manifest.");
    }
    ready.sort((a, b) => a.localeCompare(b));
    for (const s of ready) {
      order.push(s);
      remaining.delete(s);
    }
  }
  return order;
}

/**
 * Seeds projects, agents, workspace files, goals, and routines for an existing company.
 * Does not create the company row or call ensureCompanyBuiltinTemplateDefaults.
 */
export async function seedOperationalDataFromPackage(db: BopoDb, companyId: string, parsed: ParsedCompanyPackage): Promise<void> {
  const { doc, entries } = parsed;
  const cwd = await resolveDefaultRuntimeCwdForCompany(db, companyId);
  await mkdir(cwd, { recursive: true });
  await ensureBuiltinPluginsRegistered(db, [companyId]);

  const projectSlugToId = new Map<string, string>();
  const projectStatuses = new Set(["planned", "active", "paused", "blocked", "completed", "archived"]);
  for (const [projectSlug, p] of Object.entries(doc.projects)) {
    const st = p.status?.trim();
    const status = st && projectStatuses.has(st) ? (st as "planned") : "planned";
    const row = await createProject(db, {
      companyId,
      name: p.name,
      description: p.description ?? null,
      status
    });
    if (row) {
      projectSlugToId.set(projectSlug, row.id);
    }
  }

  const agentSlugToId = new Map<string, string>();
  const agentEntries = Object.entries(doc.agents);
  const pending = new Map(agentEntries);
  let guard = 0;
  while (pending.size > 0 && guard < 500) {
    guard += 1;
    let progressed = false;
    for (const [slug, a] of [...pending.entries()]) {
      const mgrSlug = a.managerSlug?.trim() || null;
      let managerId: string | null = null;
      if (mgrSlug) {
        managerId = agentSlugToId.get(mgrSlug) ?? null;
        if (!managerId) {
          continue;
        }
      }
      const defaultRt = normalizeRuntimeConfig({
        defaultRuntimeCwd: cwd,
        runtimeConfig: {
          runtimeModel: undefined,
          runtimeEnv: {},
          bootstrapPrompt: a.bootstrapPrompt?.trim() || undefined
        }
      });
      const createdAgent = await createAgent(db, {
        companyId,
        managerAgentId: managerId,
        role: a.role,
        roleKey: a.roleKey?.trim() || null,
        title: a.title?.trim() || null,
        capabilities: a.capabilities?.trim() || null,
        name: a.name,
        providerType: coerceProviderType(a.providerType),
        heartbeatCron: a.heartbeatCron,
        monthlyBudgetUsd: formatMonthlyBudgetUsdFromManifest(a.monthlyBudgetUsd),
        canHireAgents: a.canHireAgents ?? false,
        canAssignAgents: a.canAssignAgents ?? true,
        canCreateIssues: a.canCreateIssues ?? true,
        ...runtimeConfigToDb(defaultRt),
        initialState: runtimeConfigToStateBlobPatch(defaultRt)
      });
      agentSlugToId.set(slug, createdAgent.id);
      pending.delete(slug);
      progressed = true;
    }
    if (!progressed) {
      throw new CompanyFileImportError("Could not resolve agent manager chain (circular or missing manager slug).");
    }
  }

  const companyRoot = resolveCompanyProjectsWorkspacePath(companyId);
  for (const [path, text] of Object.entries(entries)) {
    if (path === ".bopo.yaml" || path === "bopo.yaml" || path === "COMPANY.md" || path === "README.md") {
      continue;
    }
    if (path.startsWith("projects/") && path.endsWith("/PROJECT.md")) {
      continue;
    }
    if (path.startsWith("tasks/") && path.endsWith("/TASK.md")) {
      continue;
    }
    if (path.startsWith("agents/")) {
      const parts = path.split("/").filter(Boolean);
      if (parts.length < 3) {
        continue;
      }
      const agentSlug = parts[1]!;
      const agentId = agentSlugToId.get(agentSlug);
      if (!agentId) {
        continue;
      }
      const rest = parts.slice(2).join("/");
      const isMemory = rest.startsWith("memory/");
      const relativePath = isMemory ? rest.slice("memory/".length) : rest;
      const base = isMemory ? resolveAgentMemoryRootPath(companyId, agentId) : resolveAgentOperatingPath(companyId, agentId);
      const dest = join(base, relativePath);
      await mkdir(dirname(dest), { recursive: true });
      await writeFile(dest, text, "utf8");
      continue;
    }
    if (path.startsWith("skills/")) {
      const dest = join(companyRoot, path);
      await mkdir(dirname(dest), { recursive: true });
      await writeFile(dest, text, "utf8");
    }
  }

  const goalsManifest = doc.goals ?? {};
  const goalSlugToId = new Map<string, string>();
  for (const slug of sortGoalSlugsForImport(goalsManifest)) {
    const g = goalsManifest[slug]!;
    const level = g.level;
    const projectSlug = g.projectSlug?.trim() || null;
    const projectId = projectSlug ? projectSlugToId.get(projectSlug) ?? null : null;
    if (level === "project" && !projectId) {
      throw new CompanyFileImportError(`Goal '${slug}' (project level) references unknown project slug '${projectSlug ?? ""}'.`);
    }
    if (level === "company" && projectId) {
      throw new CompanyFileImportError(`Goal '${slug}' is company-level but specifies a project.`);
    }
    const parentSlug = g.parentGoalSlug?.trim() || null;
    const parentGoalId = parentSlug ? goalSlugToId.get(parentSlug) ?? null : null;
    if (parentSlug && !parentGoalId) {
      throw new CompanyFileImportError(`Goal '${slug}' references unknown parent goal slug '${parentSlug}'.`);
    }
    const ownerSlug = g.ownerAgentSlug?.trim() || null;
    const ownerAgentId = ownerSlug ? agentSlugToId.get(ownerSlug) ?? null : null;
    if (ownerSlug && !ownerAgentId) {
      throw new CompanyFileImportError(`Goal '${slug}' references unknown owner agent slug '${ownerSlug}'.`);
    }
    const agentLevelProjectId = level === "agent" ? projectId : null;
    if (level === "agent" && g.projectSlug?.trim() && !projectId) {
      throw new CompanyFileImportError(`Goal '${slug}' (agent level) references unknown project slug '${g.projectSlug.trim()}'.`);
    }

    const created = await createGoal(db, {
      companyId,
      projectId: level === "project" ? projectId : agentLevelProjectId,
      parentGoalId,
      ownerAgentId,
      level,
      title: g.title,
      description: g.description?.trim() || undefined
    });
    goalSlugToId.set(slug, created.id);
    const st = g.status?.trim();
    if (st && st !== "draft") {
      await updateGoal(db, {
        companyId,
        id: created.id,
        status: st
      });
    }
  }

  const routines = doc.routines ?? {};
  for (const [, r] of Object.entries(routines)) {
    const projectId = projectSlugToId.get(r.projectSlug);
    const assigneeId = agentSlugToId.get(r.assigneeAgentSlug);
    if (!projectId || !assigneeId) {
      continue;
    }
    const loop = await createWorkLoop(db, {
      companyId,
      projectId,
      title: r.title,
      description: r.description?.trim() || null,
      assigneeAgentId: assigneeId
    });
    if (!loop) {
      continue;
    }
    for (const t of r.triggers) {
      await addWorkLoopTrigger(db, {
        companyId,
        routineId: loop.id,
        cronExpression: t.cronExpression,
        timezone: t.timezone?.trim() || "UTC",
        label: t.label ?? null,
        enabled: true
      });
    }
  }
}

export function assertManifestHasCeoAgent(doc: BopoExportDoc): void {
  const hasCeo = Object.values(doc.agents).some((a) => (a.roleKey ?? "").trim().toLowerCase() === "ceo");
  if (!hasCeo) {
    throw new CompanyFileImportError("Company package must include an agent with roleKey 'ceo'.");
  }
}

export function summarizeCompanyPackageForPreview(parsed: ParsedCompanyPackage): {
  companyName: string;
  counts: {
    projects: number;
    agents: number;
    goals: number;
    routines: number;
    skillFiles: number;
  };
  hasCeo: boolean;
} {
  const doc = parsed.doc;
  const skillFiles = Object.keys(parsed.entries).filter((k) => k.startsWith("skills/") && !k.endsWith("/")).length;
  const hasCeo = Object.values(doc.agents).some((a) => (a.roleKey ?? "").trim().toLowerCase() === "ceo");
  return {
    companyName: doc.company.name,
    counts: {
      projects: Object.keys(doc.projects).length,
      agents: Object.keys(doc.agents).length,
      goals: Object.keys(doc.goals ?? {}).length,
      routines: Object.keys(doc.routines ?? {}).length,
      skillFiles
    },
    hasCeo
  };
}

export async function importCompanyFromZipBuffer(db: BopoDb, buffer: Buffer): Promise<{ companyId: string; name: string }> {
  const parsed = parseCompanyZipBuffer(buffer);
  const doc = parsed.doc;

  const created = await createCompany(db, {
    name: doc.company.name,
    mission: doc.company.mission ?? null
  });
  const companyId = created.id;
  await ensureCompanyBuiltinTemplateDefaults(db, companyId);
  await seedOperationalDataFromPackage(db, companyId, parsed);
  return { companyId, name: doc.company.name };
}
