import { access, constants, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { commandExists, runCommandCapture } from "./process";

const SAFE_PATH_SEGMENT_RE = /^[a-zA-Z0-9_-]+$/;

export interface DoctorCheck {
  label: string;
  ok: boolean;
  details: string;
}

export async function runDoctorChecks(options?: { workspaceRoot?: string }): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const nodeMajor = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
  checks.push({
    label: "Node.js",
    ok: nodeMajor >= 20,
    details: `Detected ${process.versions.node}; requires >= 20`
  });

  const pnpmAvailable = await commandExists("pnpm");
  checks.push({
    label: "pnpm",
    ok: pnpmAvailable,
    details: pnpmAvailable ? "pnpm is available" : "pnpm is not installed or not in PATH"
  });

  const codexCommand = process.env.BOPO_CODEX_COMMAND?.trim() || "codex";
  const gitRuntime = await checkRuntimeCommandHealth("git", options?.workspaceRoot);
  checks.push({
    label: "Git runtime",
    ok: gitRuntime.available && gitRuntime.exitCode === 0,
    details:
      gitRuntime.available && gitRuntime.exitCode === 0
        ? "Command 'git' is available (required for repo bootstrap/worktree execution)"
        : gitRuntime.error ?? "Command 'git' is not available"
  });

  const codex = await checkRuntimeCommandHealth(codexCommand, options?.workspaceRoot);
  checks.push({
    label: "Codex runtime",
    ok: codex.available && codex.exitCode === 0,
    details:
      codex.available && codex.exitCode === 0
        ? `Command '${codexCommand}' is available`
        : codex.error ?? `Command '${codexCommand}' exited with ${String(codex.exitCode)}`
  });

  const openCodeCommand = process.env.BOPO_OPENCODE_COMMAND?.trim() || "opencode";
  const openCode = await checkRuntimeCommandHealth(openCodeCommand, options?.workspaceRoot);
  checks.push({
    label: "OpenCode runtime",
    ok: openCode.available && openCode.exitCode === 0,
    details:
      openCode.available && openCode.exitCode === 0
        ? `Command '${openCodeCommand}' is available`
        : openCode.error ?? `Command '${openCodeCommand}' exited with ${String(openCode.exitCode)}`
  });

  const claudeCommand = process.env.BOPO_CLAUDE_COMMAND?.trim() || "claude";
  const claude = await checkRuntimeCommandHealth(claudeCommand, options?.workspaceRoot);
  checks.push({
    label: "Claude Code runtime",
    ok: claude.available && claude.exitCode === 0,
    details:
      claude.available && claude.exitCode === 0
        ? `Command '${claudeCommand}' is available`
        : claude.error ?? `Command '${claudeCommand}' exited with ${String(claude.exitCode)}`
  });

  const geminiCommand = process.env.BOPO_GEMINI_COMMAND?.trim() || "gemini";
  const gemini = await checkRuntimeCommandHealth(geminiCommand, options?.workspaceRoot);
  checks.push({
    label: "Gemini runtime",
    ok: gemini.available && gemini.exitCode === 0,
    details:
      gemini.available && gemini.exitCode === 0
        ? `Command '${geminiCommand}' is available`
        : gemini.error ?? `Command '${geminiCommand}' exited with ${String(gemini.exitCode)}`
  });

  try {
    const instanceRoot = resolveInstanceRoot();
    const storageRoot = join(instanceRoot, "data", "storage");
    const workspaceRoot = join(instanceRoot, "workspaces");
    checks.push({
      label: "Instance root writable",
      ok: await ensureWritableDirectory(instanceRoot),
      details: instanceRoot
    });
    checks.push({
      label: "Workspace root writable",
      ok: await ensureWritableDirectory(workspaceRoot),
      details: workspaceRoot
    });
    checks.push({
      label: "Storage root writable",
      ok: await ensureWritableDirectory(storageRoot),
      details: storageRoot
    });
  } catch (error) {
    checks.push({
      label: "Instance path configuration",
      ok: false,
      details: String(error)
    });
  }

  if (options?.workspaceRoot) {
    const driftCheck = await runWorkspacePathDriftCheck(options.workspaceRoot);
    checks.push(driftCheck);
    const backfillCheck = await runWorkspaceBackfillDryRunCheck(options.workspaceRoot);
    checks.push(backfillCheck);
  }

  return checks;
}

async function checkRuntimeCommandHealth(command: string, cwd?: string) {
  const result = await runCommandCapture(command, ["--version"], { cwd, timeoutMs: 2_500 });
  return {
    available: result.code !== null,
    exitCode: result.code,
    error: result.ok ? undefined : result.stderr || `Command '${command}' is not available`
  };
}

export async function detectPnpmVersion(): Promise<string | null> {
  const result = await runCommandCapture("pnpm", ["--version"]);
  if (!result.ok) {
    return null;
  }
  return result.stdout.trim() || null;
}

async function ensureWritableDirectory(path: string) {
  try {
    await access(path, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveInstanceRoot() {
  const explicit = process.env.BOPO_INSTANCE_ROOT?.trim();
  if (explicit) {
    return resolve(expandHomePrefix(explicit));
  }
  const home = process.env.BOPO_HOME?.trim() ? expandHomePrefix(process.env.BOPO_HOME.trim()) : join(homedir(), ".bopodev");
  const instanceId = process.env.BOPO_INSTANCE_ID?.trim() || "default";
  if (!SAFE_PATH_SEGMENT_RE.test(instanceId)) {
    throw new Error(`Invalid BOPO_INSTANCE_ID '${instanceId}'.`);
  }
  return resolve(home, "instances", instanceId);
}

function expandHomePrefix(value: string) {
  if (value === "~") {
    return homedir();
  }
  if (value.startsWith("~/")) {
    return resolve(homedir(), value.slice(2));
  }
  return value;
}

async function runWorkspaceBackfillDryRunCheck(workspaceRoot: string): Promise<DoctorCheck> {
  const result = await runCommandCapture("pnpm", ["--filter", "bopodev-api", "workspaces:backfill"], {
    cwd: workspaceRoot,
    env: {
      ...process.env,
      BOPO_BACKFILL_DRY_RUN: "1"
    }
  });
  if (!result.ok) {
    return {
      label: "Project workspace coverage",
      ok: false,
      details: result.stderr.trim() || "Failed to run workspace coverage check."
    };
  }
  const lines = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const lastLine = lines[lines.length - 1];
  if (!lastLine) {
    return {
      label: "Project workspace coverage",
      ok: false,
      details: "Workspace coverage check produced no output."
    };
  }
  try {
    const parsed = JSON.parse(lastLine) as {
      missingWorkspaceLocalPath?: number;
      relativeWorkspaceLocalPath?: number;
      scannedProjects?: number;
    };
    const missing = Number(parsed.missingWorkspaceLocalPath ?? 0);
    const relative = Number(parsed.relativeWorkspaceLocalPath ?? 0);
    const scanned = Number(parsed.scannedProjects ?? 0);
    const ok = missing === 0 && relative === 0;
    return {
      label: "Project workspace coverage",
      ok,
      details: ok
        ? `${scanned} projects scanned; all have absolute workspace paths`
        : `${scanned} projects scanned; ${missing} missing and ${relative} relative workspace path(s)`
    };
  } catch {
    return {
      label: "Project workspace coverage",
      ok: false,
      details: "Workspace coverage check returned invalid JSON."
    };
  }
}

async function runWorkspacePathDriftCheck(workspaceRoot: string): Promise<DoctorCheck> {
  const instanceRoot = resolveInstanceRoot();
  const suspiciousEntries = await detectSuspiciousWorkspaceDirectories(workspaceRoot);
  if (suspiciousEntries.length === 0) {
    return {
      label: "Workspace path drift",
      ok: true,
      details: "No suspicious workspace-like directories found outside managed root."
    };
  }
  return {
    label: "Workspace path drift",
    ok: false,
    details: `Found suspicious directories outside '${instanceRoot}': ${suspiciousEntries.join(", ")}`
  };
}

export async function detectSuspiciousWorkspaceDirectories(workspaceRoot: string) {
  const candidates = [
    join(workspaceRoot, "relative"),
    join(workspaceRoot, "workspaces"),
    join(workspaceRoot, "workspace")
  ];
  const hits: string[] = [];
  for (const candidate of candidates) {
    if (await isDirectory(candidate)) {
      hits.push(candidate);
    }
  }
  return hits;
}

async function isDirectory(path: string) {
  try {
    const entry = await stat(path);
    return entry.isDirectory();
  } catch {
    return false;
  }
}
