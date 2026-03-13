import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import {
  normalizeAbsolutePath,
  resolveAgentProjectWorktreeRootPath,
  resolveProjectWorkspacePath
} from "./instance-paths";
import type { ProjectExecutionWorkspacePolicy } from "./workspace-policy";

const DEFAULT_GIT_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_CHARS = 4_096;

export class GitRuntimeError extends Error {
  readonly code:
    | "git_unavailable"
    | "git_failed"
    | "auth_missing"
    | "policy_violation"
    | "invalid_repo_url"
    | "timeout";
  readonly details: Record<string, unknown>;

  constructor(
    code:
      | "git_unavailable"
      | "git_failed"
      | "auth_missing"
      | "policy_violation"
      | "invalid_repo_url"
      | "timeout",
    message: string,
    details: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = "GitRuntimeError";
    this.code = code;
    this.details = details;
  }
}

type GitAuthResolution = {
  mode: "host" | "env_token";
  extraArgs: string[];
};

type GitCommandResult = {
  stdout: string;
  stderr: string;
};

export async function bootstrapRepositoryWorkspace(input: {
  companyId: string;
  projectId: string;
  cwd: string | null | undefined;
  repoUrl: string;
  repoRef?: string | null;
  policy?: ProjectExecutionWorkspacePolicy | null;
  runtimeEnv?: Record<string, string>;
  timeoutMs?: number;
}) {
  const repoUrl = input.repoUrl.trim();
  if (!repoUrl) {
    throw new GitRuntimeError("invalid_repo_url", "Project workspace repoUrl is empty.");
  }
  enforceRemoteAllowlist(repoUrl, input.policy);
  const targetCwd = normalizeAbsolutePath(
    input.cwd?.trim() || resolveProjectWorkspacePath(input.companyId, input.projectId)
  );
  await mkdir(targetCwd, { recursive: true });
  const auth = resolveGitAuth({
    policy: input.policy,
    runtimeEnv: input.runtimeEnv ?? {},
    repoUrl
  });
  const timeoutMs = sanitizeTimeoutMs(input.timeoutMs);
  const gitDirPath = join(targetCwd, ".git");
  const hasGitDir = await pathExists(gitDirPath);
  const actions: string[] = [];
  if (!hasGitDir) {
    await runGit(["clone", repoUrl, targetCwd], {
      extraArgs: auth.extraArgs,
      timeoutMs
    });
    actions.push("clone");
  } else {
    actions.push("reuse");
  }
  await runGit(["remote", "set-url", "origin", repoUrl], {
    cwd: targetCwd,
    extraArgs: auth.extraArgs,
    timeoutMs
  });
  await runGit(["fetch", "origin", "--prune"], {
    cwd: targetCwd,
    extraArgs: auth.extraArgs,
    timeoutMs
  });
  actions.push("fetch");
  const targetRef = (input.repoRef ?? "").trim() || (await resolveDefaultRemoteHead(targetCwd, auth.extraArgs, timeoutMs));
  if (targetRef) {
    await checkoutRef(targetCwd, targetRef, auth.extraArgs, timeoutMs);
    actions.push(`checkout:${targetRef}`);
  }
  return {
    cwd: targetCwd,
    authMode: auth.mode,
    resolvedRef: targetRef || null,
    actions
  };
}

export async function ensureIsolatedGitWorktree(input: {
  companyId: string;
  repoCwd: string;
  projectId: string;
  agentId: string;
  issueId?: string | null;
  repoRef?: string | null;
  policy?: ProjectExecutionWorkspacePolicy | null;
  timeoutMs?: number;
}) {
  const timeoutMs = sanitizeTimeoutMs(input.timeoutMs);
  const strategy = input.policy?.strategy;
  const branchPrefix = (strategy?.branchPrefix?.trim() || "bopo").replace(/[^a-zA-Z0-9/_-]/g, "-");
  enforceBranchPrefixAllowlist(branchPrefix, input.policy);
  const issuePart = (input.issueId?.trim() || "run").replace(/[^a-zA-Z0-9_-]/g, "-");
  const agentPart = input.agentId.replace(/[^a-zA-Z0-9_-]/g, "-");
  const projectPart = input.projectId.replace(/[^a-zA-Z0-9_-]/g, "-");
  const branch = `${branchPrefix}/${projectPart}/${agentPart}/${issuePart}`;
  const rootDir = strategy?.rootDir?.trim()
    ? normalizeAbsolutePath(strategy.rootDir)
    : resolveAgentProjectWorktreeRootPath(input.companyId, input.agentId, input.projectId);
  await mkdir(rootDir, { recursive: true });
  await cleanupStaleWorktrees({ rootDir, ttlMs: resolveWorktreeTtlMs() });
  const targetPath = join(rootDir, `${projectPart}-${agentPart}-${issuePart}`);
  const hasWorktree = await pathExists(targetPath);
  if (!hasWorktree) {
    const baseRef = (input.repoRef ?? "").trim() || "HEAD";
    await runGit(["worktree", "add", "-B", branch, targetPath, baseRef], {
      cwd: input.repoCwd,
      timeoutMs
    });
  } else {
    await runGit(["-C", targetPath, "checkout", branch], { timeoutMs });
  }
  return {
    cwd: targetPath,
    branch,
    rootDir
  };
}

export async function cleanupStaleWorktrees(input: { rootDir: string; ttlMs: number }) {
  if (input.ttlMs <= 0) {
    return { removed: 0 };
  }
  const now = Date.now();
  let removed = 0;
  let entries: string[] = [];
  try {
    entries = await readdir(input.rootDir);
  } catch {
    return { removed: 0 };
  }
  for (const entry of entries) {
    const absolute = join(input.rootDir, entry);
    try {
      const entryStat = await stat(absolute);
      if (!entryStat.isDirectory()) {
        continue;
      }
      if (now - entryStat.mtimeMs < input.ttlMs) {
        continue;
      }
      await rm(absolute, { recursive: true, force: true });
      removed += 1;
    } catch {
      // Best effort cleanup only.
    }
  }
  return { removed };
}

function resolveGitAuth(input: {
  policy?: ProjectExecutionWorkspacePolicy | null;
  runtimeEnv: Record<string, string>;
  repoUrl: string;
}): GitAuthResolution {
  const configured = input.policy?.credentials;
  const mode = configured?.mode ?? "host";
  if (mode === "host") {
    return { mode: "host", extraArgs: [] };
  }
  const tokenEnvVar = configured?.tokenEnvVar?.trim();
  if (!tokenEnvVar) {
    throw new GitRuntimeError("auth_missing", "Workspace git auth policy requires credentials.tokenEnvVar.");
  }
  const token = input.runtimeEnv[tokenEnvVar] ?? process.env[tokenEnvVar];
  const normalizedToken = token?.trim();
  if (!normalizedToken) {
    throw new GitRuntimeError("auth_missing", `Git token env var '${tokenEnvVar}' is missing for repository access.`);
  }
  const username = configured?.username?.trim() || "x-access-token";
  if (!isHttpsRepoUrl(input.repoUrl)) {
    return { mode: "env_token", extraArgs: [] };
  }
  const basicHeader = Buffer.from(`${username}:${normalizedToken}`, "utf8").toString("base64");
  return {
    mode: "env_token",
    extraArgs: ["-c", `http.extraHeader=Authorization: Basic ${basicHeader}`]
  };
}

function enforceRemoteAllowlist(repoUrl: string, policy?: ProjectExecutionWorkspacePolicy | null) {
  const allowRemotes = policy?.allowRemotes ?? null;
  if (!allowRemotes || allowRemotes.length === 0) {
    return;
  }
  const normalizedUrl = repoUrl.toLowerCase();
  const allowed = allowRemotes.some((candidate) => {
    const normalizedCandidate = candidate.trim().toLowerCase();
    if (!normalizedCandidate) {
      return false;
    }
    return normalizedUrl.includes(normalizedCandidate);
  });
  if (!allowed) {
    throw new GitRuntimeError("policy_violation", `Repository '${repoUrl}' is not in execution allowRemotes policy.`);
  }
}

function enforceBranchPrefixAllowlist(prefix: string, policy?: ProjectExecutionWorkspacePolicy | null) {
  const allowBranchPrefixes = policy?.allowBranchPrefixes ?? null;
  if (!allowBranchPrefixes || allowBranchPrefixes.length === 0) {
    return;
  }
  const allowed = allowBranchPrefixes.some((candidate) => prefix.startsWith(candidate.trim()));
  if (!allowed) {
    throw new GitRuntimeError(
      "policy_violation",
      `Branch prefix '${prefix}' is not allowed by execution policy allowBranchPrefixes.`
    );
  }
}

async function checkoutRef(cwd: string, ref: string, extraArgs: string[], timeoutMs: number) {
  await runGit(["checkout", ref], { cwd, extraArgs, timeoutMs });
}

async function resolveDefaultRemoteHead(cwd: string, extraArgs: string[], timeoutMs: number) {
  const symbolic = await runGit(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], {
    cwd,
    extraArgs,
    timeoutMs,
    allowFailure: true
  });
  const symbolicRef = symbolic.stdout.trim();
  if (symbolicRef.startsWith("origin/")) {
    return symbolicRef.slice("origin/".length);
  }
  for (const fallbackRef of ["main", "master"]) {
    const probe = await runGit(["rev-parse", "--verify", `origin/${fallbackRef}`], {
      cwd,
      extraArgs,
      timeoutMs,
      allowFailure: true
    });
    if (probe.exitCode === 0) {
      return fallbackRef;
    }
  }
  return "";
}

async function runGit(
  args: string[],
  options?: {
    cwd?: string;
    extraArgs?: string[];
    timeoutMs?: number;
    allowFailure?: boolean;
  }
): Promise<GitCommandResult & { exitCode: number }> {
  const timeoutMs = sanitizeTimeoutMs(options?.timeoutMs);
  const fullArgs = [...(options?.extraArgs ?? []), ...args];
  return new Promise((resolve, reject) => {
    const child = spawn("git", fullArgs, {
      cwd: options?.cwd,
      env: process.env
    });
    let stdout = "";
    let stderr = "";
    let timeout: NodeJS.Timeout | null = setTimeout(() => {
      child.kill("SIGTERM");
      timeout = null;
      reject(new GitRuntimeError("timeout", `git command timed out after ${timeoutMs}ms`, { args: redactArgs(fullArgs) }));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout = truncateOutput(stdout + String(chunk));
    });
    child.stderr.on("data", (chunk) => {
      stderr = truncateOutput(stderr + String(chunk));
    });
    child.on("error", (error) => {
      if (timeout) {
        clearTimeout(timeout);
      }
      const message = String(error);
      reject(new GitRuntimeError("git_unavailable", "Unable to execute git binary.", { message }));
    });
    child.on("close", (code) => {
      if (timeout) {
        clearTimeout(timeout);
      }
      const exitCode = code ?? 1;
      if (exitCode !== 0 && !options?.allowFailure) {
        reject(
          new GitRuntimeError("git_failed", "git command failed.", {
            exitCode,
            args: redactArgs(fullArgs),
            stderr: redactSensitive(stderr)
          })
        );
        return;
      }
      resolve({ stdout, stderr, exitCode });
    });
  });
}

function sanitizeTimeoutMs(timeoutMs: number | undefined) {
  const parsed = Number(timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS);
  if (!Number.isFinite(parsed) || parsed < 1_000) {
    return DEFAULT_GIT_TIMEOUT_MS;
  }
  return Math.floor(parsed);
}

function resolveWorktreeTtlMs() {
  const parsedMinutes = Number(process.env.BOPO_GIT_WORKTREE_TTL_MINUTES ?? "240");
  if (!Number.isFinite(parsedMinutes) || parsedMinutes < 5) {
    return 240 * 60_000;
  }
  return Math.floor(parsedMinutes * 60_000);
}

function truncateOutput(value: string) {
  return value.length > MAX_OUTPUT_CHARS ? value.slice(value.length - MAX_OUTPUT_CHARS) : value;
}

function redactArgs(args: string[]) {
  return args.map((value) => redactSensitive(value));
}

function redactSensitive(value: string) {
  return value
    .replace(/(authorization:\s*basic\s+)[a-z0-9+/=]+/gi, "$1[REDACTED]")
    .replace(/(authorization:\s*bearer\s+)[^\s]+/gi, "$1[REDACTED]");
}

function isHttpsRepoUrl(value: string) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:";
  } catch {
    return false;
  }
}

async function pathExists(path: string) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
