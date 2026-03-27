import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import type { AgentMemoryContext } from "bopodev-agent-sdk";
import {
  isInsidePath,
  resolveCompanyMemoryRootPath,
  resolveAgentDailyMemoryPath,
  resolveAgentDurableMemoryPath,
  resolveAgentMemoryRootPath,
  resolveProjectMemoryRootPath
} from "../lib/instance-paths";

const MAX_DAILY_LINES = 12;
const MAX_DURABLE_FACTS = 12;
const MAX_TACIT_NOTES_CHARS = 1_500;
const MAX_OBSERVABILITY_FILES = 200;
const MAX_OBSERVABILITY_FILE_BYTES = 512 * 1024;
const MAX_CANDIDATE_FACTS = 3;

export type PersistedHeartbeatMemory = {
  memoryRoot: string;
  dailyNotePath: string;
  dailyEntry: string;
  candidateFacts: MemoryCandidateFact[];
};

export type MemoryScope = "company" | "project" | "agent";

export type MemoryCandidateFact = {
  fact: string;
  confidence: number;
  impactTags: string[];
  scope: MemoryScope;
};

type DurableFactRecord = {
  fact: string;
  sourceRunId: string | null;
  scope: MemoryScope;
  confidence: number | null;
  createdAt: string | null;
  supersedes: string | null;
  status: "active" | "superseded";
  impactTags: string[];
};

type ScopedMemorySource = {
  scope: MemoryScope;
  root: string;
  label: string;
};

export async function loadAgentMemoryContext(input: {
  companyId: string;
  agentId: string;
  projectIds?: string[];
  queryText?: string;
}): Promise<AgentMemoryContext> {
  const projectIds = Array.from(new Set((input.projectIds ?? []).map((entry) => entry.trim()).filter(Boolean)));
  const scopedRoots: ScopedMemorySource[] = [
    {
      scope: "company",
      root: resolveCompanyMemoryRootPath(input.companyId),
      label: "company"
    },
    ...projectIds.map((projectId) => ({
      scope: "project" as const,
      root: resolveProjectMemoryRootPath(input.companyId, projectId),
      label: `project:${projectId}`
    })),
    {
      scope: "agent",
      root: resolveAgentMemoryRootPath(input.companyId, input.agentId),
      label: "agent"
    }
  ];
  const tacitBlocks = await Promise.all(
    scopedRoots.map(async (source) => {
      const tacit = await readTacitNotes(source.root);
      if (!tacit) {
        return null;
      }
      return `### ${source.label}\n${tacit}`;
    })
  );
  const tacitNotes = tacitBlocks.filter(Boolean).join("\n\n").trim() || undefined;
  const durableFacts = await readScopedDurableFacts(scopedRoots, MAX_DURABLE_FACTS, input.queryText);
  const dailyNotes = await readScopedDailyNotes(scopedRoots, MAX_DAILY_LINES, input.queryText);
  const memoryRoot = resolveAgentMemoryRootPath(input.companyId, input.agentId);
  return {
    memoryRoot,
    tacitNotes,
    durableFacts,
    dailyNotes
  };
}

export async function persistHeartbeatMemory(input: {
  companyId: string;
  agentId: string;
  runId: string;
  status: string;
  summary: string;
  outcomeKind?: string | null;
  mission?: string | null;
  goalContext?: {
    companyGoals?: string[];
    projectGoals?: string[];
    agentGoals?: string[];
  };
}): Promise<PersistedHeartbeatMemory> {
  const memoryRoot = resolveAgentMemoryRootPath(input.companyId, input.agentId);
  const durableRoot = resolveAgentDurableMemoryPath(input.companyId, input.agentId);
  const dailyRoot = resolveAgentDailyMemoryPath(input.companyId, input.agentId);
  await ensureMemoryDirs(memoryRoot, durableRoot, dailyRoot);
  const now = new Date();
  const dailyFileName = `${now.toISOString().slice(0, 10)}.md`;
  const dailyNotePath = join(dailyRoot, dailyFileName);
  const summary = collapseWhitespace(input.summary);
  const dailyEntry = [
    `## ${now.toISOString()}`,
    `- run: ${input.runId}`,
    `- status: ${input.status}`,
    `- outcome: ${input.outcomeKind ?? "unknown"}`,
    `- missionAlignment: ${computeMissionAlignmentScore(input.summary, input.mission ?? null, input.goalContext).toFixed(2)}`,
    `- summary: ${summary || "No summary provided."}`,
    ""
  ].join("\n");
  await writeFile(dailyNotePath, dailyEntry, { encoding: "utf8", flag: "a" });
  const candidateFacts = deriveCandidateFacts(summary, {
    mission: input.mission ?? null,
    goalContext: input.goalContext
  });
  return {
    memoryRoot,
    dailyNotePath,
    dailyEntry,
    candidateFacts
  };
}

export async function appendDurableFact(input: {
  companyId: string;
  agentId: string;
  fact: string | MemoryCandidateFact;
  sourceRunId?: string | null;
  scope?: MemoryScope;
  confidence?: number | null;
  impactTags?: string[];
  supersedes?: string | null;
  status?: "active" | "superseded";
}) {
  const durableRoot = resolveAgentDurableMemoryPath(input.companyId, input.agentId);
  await mkdir(durableRoot, { recursive: true });
  const targetFile = join(durableRoot, "items.yaml");
  const typedFact = typeof input.fact === "string" ? null : input.fact;
  const rawFact = typeof input.fact === "string" ? input.fact : input.fact.fact;
  const normalizedFact = collapseWhitespace(rawFact);
  if (!normalizedFact) {
    return null;
  }
  const existingRecords = await readDurableFactRecords(durableRoot);
  const duplicate = existingRecords.some((record) => areFactsEquivalent(record.fact, normalizedFact));
  if (duplicate) {
    return null;
  }
  const confidence = clampConfidence(typedFact?.confidence ?? input.confidence ?? null);
  const impactTags = dedupeStrings(typedFact?.impactTags ?? input.impactTags ?? []);
  const scope = typedFact?.scope ?? input.scope ?? "agent";
  const createdAt = new Date().toISOString();
  const status = input.status ?? "active";
  const row = [
    `- fact: "${escapeYamlString(normalizedFact)}"`,
    `  sourceRunId: "${escapeYamlString(input.sourceRunId ?? "")}"`,
    `  scope: "${escapeYamlString(scope)}"`,
    `  confidence: "${confidence !== null ? confidence.toFixed(2) : ""}"`,
    `  createdAt: "${escapeYamlString(createdAt)}"`,
    `  supersedes: "${escapeYamlString(input.supersedes ?? "")}"`,
    `  status: "${escapeYamlString(status)}"`,
    `  impactTags: "${escapeYamlString(impactTags.join(","))}"`,
    ""
  ].join("\n");
  await writeFile(targetFile, row, { encoding: "utf8", flag: "a" });
  return targetFile;
}

export async function listCompanyMemoryFiles(input: { companyId: string; maxFiles?: number }) {
  const root = resolveCompanyMemoryRootPath(input.companyId);
  await mkdir(root, { recursive: true });
  const maxFiles = Math.max(1, Math.min(MAX_OBSERVABILITY_FILES, input.maxFiles ?? 100));
  const files = await walkFiles(root, maxFiles);
  return files.map((filePath) => ({
    path: filePath,
    relativePath: relative(root, filePath),
    memoryRoot: root
  }));
}

export async function readCompanyMemoryFile(input: { companyId: string; relativePath: string }) {
  const root = resolveCompanyMemoryRootPath(input.companyId);
  await mkdir(root, { recursive: true });
  const candidate = resolve(root, input.relativePath);
  if (!isInsidePath(root, candidate)) {
    throw new Error("Requested memory path is outside of memory root.");
  }
  const info = await stat(candidate);
  if (!info.isFile()) {
    throw new Error("Requested memory path is not a file.");
  }
  if (info.size > MAX_OBSERVABILITY_FILE_BYTES) {
    throw new Error("Requested memory file exceeds size limit.");
  }
  const content = await readFile(candidate, "utf8");
  return {
    path: candidate,
    relativePath: relative(root, candidate),
    content,
    sizeBytes: info.size
  };
}

export async function listProjectMemoryFiles(input: { companyId: string; projectId: string; maxFiles?: number }) {
  const root = resolveProjectMemoryRootPath(input.companyId, input.projectId);
  await mkdir(root, { recursive: true });
  const maxFiles = Math.max(1, Math.min(MAX_OBSERVABILITY_FILES, input.maxFiles ?? 100));
  const files = await walkFiles(root, maxFiles);
  return files.map((filePath) => ({
    path: filePath,
    relativePath: relative(root, filePath),
    memoryRoot: root
  }));
}

export async function readProjectMemoryFile(input: { companyId: string; projectId: string; relativePath: string }) {
  const root = resolveProjectMemoryRootPath(input.companyId, input.projectId);
  await mkdir(root, { recursive: true });
  const candidate = resolve(root, input.relativePath);
  if (!isInsidePath(root, candidate)) {
    throw new Error("Requested memory path is outside of memory root.");
  }
  const info = await stat(candidate);
  if (!info.isFile()) {
    throw new Error("Requested memory path is not a file.");
  }
  if (info.size > MAX_OBSERVABILITY_FILE_BYTES) {
    throw new Error("Requested memory file exceeds size limit.");
  }
  const content = await readFile(candidate, "utf8");
  return {
    path: candidate,
    relativePath: relative(root, candidate),
    content,
    sizeBytes: info.size
  };
}

export async function listAgentMemoryFiles(input: {
  companyId: string;
  agentId: string;
  maxFiles?: number;
}) {
  const root = resolveAgentMemoryRootPath(input.companyId, input.agentId);
  await mkdir(root, { recursive: true });
  const maxFiles = Math.max(1, Math.min(MAX_OBSERVABILITY_FILES, input.maxFiles ?? 100));
  const files = await walkFiles(root, maxFiles);
  return files.map((filePath) => ({
    path: filePath,
    relativePath: relative(root, filePath),
    memoryRoot: root
  }));
}

export async function readAgentMemoryFile(input: {
  companyId: string;
  agentId: string;
  relativePath: string;
}) {
  const root = resolveAgentMemoryRootPath(input.companyId, input.agentId);
  await mkdir(root, { recursive: true });
  const candidate = resolve(root, input.relativePath);
  if (!isInsidePath(root, candidate)) {
    throw new Error("Requested memory path is outside of memory root.");
  }
  const info = await stat(candidate);
  if (!info.isFile()) {
    throw new Error("Requested memory path is not a file.");
  }
  if (info.size > MAX_OBSERVABILITY_FILE_BYTES) {
    throw new Error("Requested memory file exceeds size limit.");
  }
  const content = await readFile(candidate, "utf8");
  return {
    path: candidate,
    relativePath: relative(root, candidate),
    content,
    sizeBytes: info.size
  };
}

export async function writeAgentMemoryFile(input: {
  companyId: string;
  agentId: string;
  relativePath: string;
  content: string;
}) {
  const root = resolveAgentMemoryRootPath(input.companyId, input.agentId);
  await mkdir(root, { recursive: true });
  const normalizedRel = input.relativePath.trim();
  if (!normalizedRel || normalizedRel.includes("..")) {
    throw new Error("Invalid relative path.");
  }
  const candidate = resolve(root, normalizedRel);
  if (!isInsidePath(root, candidate)) {
    throw new Error("Requested memory path is outside of memory root.");
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
    path: candidate,
    relativePath: relative(root, candidate),
    sizeBytes: info.size
  };
}

function collapseWhitespace(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function deriveCandidateFacts(
  summary: string,
  context?: {
    mission?: string | null;
    goalContext?: {
      companyGoals?: string[];
      projectGoals?: string[];
      agentGoals?: string[];
    };
  }
): MemoryCandidateFact[] {
  const normalized = collapseWhitespace(summary);
  if (!normalized || normalized.length < 18) {
    return [];
  }
  const segments = normalized
    .split(/(?<=[.!?])\s+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  const selected: MemoryCandidateFact[] = [];
  for (const segment of segments) {
    if (selected.length >= MAX_CANDIDATE_FACTS) {
      break;
    }
    if (segment.length < 40 || segment.length > 320) {
      continue;
    }
    const lowered = segment.toLowerCase();
    if (
      lowered.includes("no summary provided") ||
      lowered.includes("heartbeat failed") ||
      lowered.includes("unknown") ||
      lowered.startsWith("status:")
    ) {
      continue;
    }
    const cleaned = segment.replace(/^(-\s*)?summary:\s*/i, "").trim();
    const missionAlignment = computeMissionAlignmentScore(cleaned, context?.mission ?? null, context?.goalContext);
    const confidence = Math.min(0.95, Math.max(0.5, 0.55 + missionAlignment * 0.4));
    const impactTags = deriveImpactTags(cleaned, context?.mission ?? null, context?.goalContext);
    const duplicate = selected.some((entry) => areFactsEquivalent(entry.fact, cleaned));
    if (!duplicate) {
      selected.push({
        fact: cleaned.slice(0, 400),
        confidence,
        impactTags,
        scope: "agent"
      });
    }
  }
  if (selected.length > 0) {
    return selected;
  }
  const fallback = normalized.slice(0, 280);
  return [
    {
      fact: fallback,
      confidence: 0.55,
      impactTags: deriveImpactTags(fallback, context?.mission ?? null, context?.goalContext),
      scope: "agent"
    }
  ];
}

async function ensureMemoryDirs(memoryRoot: string, durableRoot: string, dailyRoot: string) {
  await mkdir(memoryRoot, { recursive: true });
  await mkdir(durableRoot, { recursive: true });
  await mkdir(dailyRoot, { recursive: true });
}

async function readTacitNotes(memoryRoot: string) {
  const tacitPath = join(memoryRoot, "MEMORY.md");
  try {
    const text = await readFile(tacitPath, "utf8");
    const trimmed = text.trim();
    if (!trimmed) {
      return undefined;
    }
    return trimmed.slice(0, MAX_TACIT_NOTES_CHARS);
  } catch {
    return undefined;
  }
}

async function readDurableFacts(durableRoot: string, limit: number) {
  const records = await readDurableFactRecords(durableRoot);
  const activeRecords = filterSupersededFacts(records);
  return activeRecords.slice(0, limit).map((record) => record.fact.slice(0, 300));
}

async function readRecentDailyNotes(dailyRoot: string, limit: number) {
  try {
    const entries = await readdir(dailyRoot, { withFileTypes: true });
    const files = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map((entry) => entry.name)
      .sort()
      .reverse()
      .slice(0, 3);
    const notes: string[] = [];
    for (const fileName of files) {
      const content = await readFile(join(dailyRoot, fileName), "utf8");
      const lines = content
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      for (const line of lines.reverse()) {
        if (notes.length >= limit) {
          return notes;
        }
        notes.push(line.slice(0, 300));
      }
    }
    return notes;
  } catch {
    return [];
  }
}

async function readScopedDurableFacts(scopedRoots: ScopedMemorySource[], limit: number, queryText?: string) {
  const queryTokens = tokenize(queryText ?? "");
  const records: Array<DurableFactRecord & { scopeLabel: string }> = [];
  for (const source of scopedRoots) {
    const durableRoot = join(source.root, "life");
    const scopedRecords = await readDurableFactRecords(durableRoot);
    for (const record of scopedRecords) {
      records.push({
        ...record,
        scope: source.scope,
        scopeLabel: source.label
      });
    }
  }
  const activeRecords = filterSupersededFacts(records);
  const scored = activeRecords
    .map((record) => ({
      record,
      score: scoreFact(record, queryTokens)
    }))
    .sort((left, right) => right.score - left.score)
    .slice(0, limit);
  return scored.map(({ record }) => {
    const tags = record.impactTags.length > 0 ? ` [${record.impactTags.join(", ")}]` : "";
    return `[${record.scopeLabel}] ${record.fact}${tags}`.slice(0, 300);
  });
}

async function readScopedDailyNotes(scopedRoots: ScopedMemorySource[], limit: number, queryText?: string) {
  const queryTokens = tokenize(queryText ?? "");
  const notes: Array<{ line: string; scopeLabel: string; score: number }> = [];
  for (const source of scopedRoots) {
    const dailyRoot = join(source.root, "memory");
    const scopedNotes = await readRecentDailyNotes(dailyRoot, limit);
    for (const line of scopedNotes) {
      const score = scoreTextMatch(line, queryTokens);
      notes.push({
        line,
        scopeLabel: source.label,
        score: score + (source.scope === "agent" ? 0.15 : source.scope === "project" ? 0.1 : 0.05)
      });
    }
  }
  return notes
    .sort((left, right) => right.score - left.score)
    .slice(0, limit)
    .map((entry) => `[${entry.scopeLabel}] ${entry.line}`.slice(0, 300));
}

async function readDurableFactRecords(durableRoot: string): Promise<DurableFactRecord[]> {
  const records: DurableFactRecord[] = [];
  const summaryPath = join(durableRoot, "summary.md");
  const itemsPath = join(durableRoot, "items.yaml");
  try {
    const summary = await readFile(summaryPath, "utf8");
    const summaryLines = summary
      .split(/\r?\n/)
      .map((line) => collapseWhitespace(line))
      .filter((line) => line.length > 0 && !line.startsWith("#"));
    for (const line of summaryLines) {
      records.push({
        fact: line.slice(0, 400),
        sourceRunId: null,
        scope: "agent",
        confidence: null,
        createdAt: null,
        supersedes: null,
        status: "active",
        impactTags: []
      });
    }
  } catch {
    // best effort
  }
  try {
    const yaml = await readFile(itemsPath, "utf8");
    const parsed = parseItemsYamlRecords(yaml);
    for (const record of parsed) {
      records.push(record);
    }
  } catch {
    // best effort
  }
  return dedupeDurableRecords(records);
}

function parseItemsYamlRecords(content: string): DurableFactRecord[] {
  const lines = content.split(/\r?\n/);
  const rows: Array<Record<string, string>> = [];
  let current: Record<string, string> | null = null;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    if (trimmed.startsWith("- ")) {
      if (current) {
        rows.push(current);
      }
      current = {};
      const [key, rawValue] = splitKeyValue(trimmed.slice(2));
      if (key) {
        current[key] = rawValue;
      }
      continue;
    }
    if (!current) {
      continue;
    }
    const [key, rawValue] = splitKeyValue(trimmed);
    if (key) {
      current[key] = rawValue;
    }
  }
  if (current) {
    rows.push(current);
  }
  const mapped: DurableFactRecord[] = [];
  for (const row of rows) {
    const fact = collapseWhitespace(unquoteYamlString(row.fact ?? ""));
    if (!fact) {
      continue;
    }
    const sourceRunId = normalizeNullableString(unquoteYamlString(row.sourceRunId ?? ""));
    const scope = parseScope(unquoteYamlString(row.scope ?? ""));
    const confidence = parseConfidence(unquoteYamlString(row.confidence ?? ""));
    const createdAt = normalizeNullableString(unquoteYamlString(row.createdAt ?? ""));
    const supersedes = normalizeNullableString(unquoteYamlString(row.supersedes ?? ""));
    const status = parseStatus(unquoteYamlString(row.status ?? ""));
    const impactTags = splitCsv(unquoteYamlString(row.impactTags ?? ""));
    mapped.push({
      fact,
      sourceRunId,
      scope,
      confidence,
      createdAt,
      supersedes,
      status,
      impactTags
    });
  }
  return mapped;
}

function splitKeyValue(line: string): [string, string] {
  const idx = line.indexOf(":");
  if (idx < 0) {
    return ["", ""];
  }
  const key = line.slice(0, idx).trim();
  const value = line.slice(idx + 1).trim();
  return [key, value];
}

function unquoteYamlString(value: string) {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    const inner = trimmed.slice(1, -1);
    return inner.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  return trimmed;
}

function parseScope(value: string): MemoryScope {
  if (value === "company" || value === "project" || value === "agent") {
    return value;
  }
  return "agent";
}

function parseStatus(value: string): "active" | "superseded" {
  return value === "superseded" ? "superseded" : "active";
}

function parseConfidence(value: string) {
  if (!value) {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return clampConfidence(parsed);
}

function normalizeNullableString(value: string) {
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function splitCsv(value: string) {
  return dedupeStrings(
    value
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
  );
}

function dedupeDurableRecords(records: DurableFactRecord[]) {
  const result: DurableFactRecord[] = [];
  for (const record of records) {
    if (result.some((entry) => areFactsEquivalent(entry.fact, record.fact))) {
      continue;
    }
    result.push(record);
  }
  return result;
}

function filterSupersededFacts<T extends DurableFactRecord>(records: T[]) {
  const supersededFacts = new Set(
    records
      .filter((record) => record.supersedes && record.supersedes.trim().length > 0)
      .map((record) => canonicalizeFact(record.supersedes!))
  );
  return records.filter(
    (record) => record.status !== "superseded" && !supersededFacts.has(canonicalizeFact(record.fact))
  );
}

function deriveImpactTags(
  fact: string,
  mission?: string | null,
  goalContext?: {
    companyGoals?: string[];
    projectGoals?: string[];
    agentGoals?: string[];
  }
) {
  const tags = new Set<string>();
  const lowered = fact.toLowerCase();
  if (/\b(test|qa|validation|verify)\b/.test(lowered)) {
    tags.add("quality");
  }
  if (/\b(budget|cost|token|latency|performance)\b/.test(lowered)) {
    tags.add("efficiency");
  }
  if (/\b(fix|bug|error|incident|failure)\b/.test(lowered)) {
    tags.add("reliability");
  }
  if (/\b(customer|user|ux|onboarding)\b/.test(lowered)) {
    tags.add("customer");
  }
  const missionTokens = tokenize(mission ?? "");
  if (scoreTextMatch(fact, missionTokens) > 0) {
    tags.add("mission");
  }
  const goalTokens = tokenize(
    [...(goalContext?.companyGoals ?? []), ...(goalContext?.projectGoals ?? []), ...(goalContext?.agentGoals ?? [])].join(" ")
  );
  if (scoreTextMatch(fact, goalTokens) > 0) {
    tags.add("goal");
  }
  return Array.from(tags);
}

function computeMissionAlignmentScore(
  summary: string,
  mission?: string | null,
  goalContext?: {
    companyGoals?: string[];
    projectGoals?: string[];
    agentGoals?: string[];
  }
) {
  const missionTokens = tokenize(mission ?? "");
  const goalTokens = tokenize(
    [...(goalContext?.companyGoals ?? []), ...(goalContext?.projectGoals ?? []), ...(goalContext?.agentGoals ?? [])].join(" ")
  );
  const missionScore = scoreTextMatch(summary, missionTokens);
  const goalScore = scoreTextMatch(summary, goalTokens);
  return Math.min(1, missionScore * 0.55 + goalScore * 0.45);
}

function scoreFact(record: DurableFactRecord, queryTokens: string[]) {
  const textMatch = scoreTextMatch(record.fact, queryTokens);
  const scopeBoost = record.scope === "agent" ? 0.2 : record.scope === "project" ? 0.14 : 0.08;
  const confidenceBoost = (record.confidence ?? 0.5) * 0.2;
  const recencyBoost = scoreRecency(record.createdAt) * 0.2;
  return textMatch * 0.4 + scopeBoost + confidenceBoost + recencyBoost;
}

function scoreRecency(iso: string | null) {
  if (!iso) {
    return 0.25;
  }
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) {
    return 0.25;
  }
  const ageDays = Math.max(0, (Date.now() - ts) / (1000 * 60 * 60 * 24));
  if (ageDays <= 3) {
    return 1;
  }
  if (ageDays <= 14) {
    return 0.8;
  }
  if (ageDays <= 60) {
    return 0.55;
  }
  return 0.3;
}

function scoreTextMatch(text: string, queryTokens: string[]) {
  if (queryTokens.length === 0) {
    return 0;
  }
  const textTokens = new Set(tokenize(text));
  let overlap = 0;
  for (const token of queryTokens) {
    if (textTokens.has(token)) {
      overlap += 1;
    }
  }
  return overlap / Math.max(queryTokens.length, 1);
}

function tokenize(value: string) {
  return dedupeStrings(
    value
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .map((entry) => entry.trim())
      .filter((entry) => entry.length >= 3)
  );
}

function dedupeStrings(values: string[]) {
  return Array.from(new Set(values));
}

function canonicalizeFact(value: string) {
  return collapseWhitespace(value)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .trim();
}

function areFactsEquivalent(left: string, right: string) {
  return canonicalizeFact(left) === canonicalizeFact(right);
}

function clampConfidence(value: number | null) {
  if (value === null) {
    return null;
  }
  return Math.min(1, Math.max(0, value));
}

async function walkFiles(root: string, maxFiles: number) {
  const collected: string[] = [];
  const queue = [root];
  while (queue.length > 0 && collected.length < maxFiles) {
    const current = queue.shift();
    if (!current) {
      continue;
    }
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(absolutePath);
        continue;
      }
      if (entry.isFile()) {
        collected.push(absolutePath);
        if (collected.length >= maxFiles) {
          break;
        }
      }
    }
  }
  return collected.sort();
}

function escapeYamlString(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
