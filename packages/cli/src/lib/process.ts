import { spawn } from "node:child_process";
import { access, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface CommandResult {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
}

export async function commandExists(command: string): Promise<boolean> {
  const result = await runCommandCapture(command, ["--version"]);
  return result.ok;
}

export async function runCommandCapture(
  command: string,
  args: string[],
  options?: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number }
): Promise<CommandResult> {
  return new Promise((resolvePromise) => {
    const supportsProcessGroups = process.platform !== "win32";
    const child = spawn(command, args, {
      cwd: options?.cwd ?? process.cwd(),
      env: options?.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      detached: supportsProcessGroups
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    const timeoutMs = Math.max(0, Math.floor(options?.timeoutMs ?? 10_000));
    let killHandle: NodeJS.Timeout | null = null;
    const terminate = (signal: NodeJS.Signals) => {
      if (child.killed || child.exitCode !== null) {
        return;
      }
      try {
        if (supportsProcessGroups && child.pid) {
          process.kill(-child.pid, signal);
        } else {
          child.kill(signal);
        }
      } catch {
        // Best effort termination only.
      }
    };
    const timeoutHandle =
      timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            stderr = `${stderr}\nCommand '${command}' timed out after ${timeoutMs}ms.`.trim();
            terminate("SIGTERM");
            killHandle = setTimeout(() => {
              terminate("SIGKILL");
            }, 5_000);
          }, timeoutMs)
        : null;

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      if (killHandle) {
        clearTimeout(killHandle);
      }
      resolvePromise({
        ok: false,
        code: null,
        stdout,
        stderr: `${stderr}\n${String(error)}`.trim()
      });
    });

    child.on("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      if (killHandle) {
        clearTimeout(killHandle);
      }
      resolvePromise({
        ok: code === 0 && !timedOut,
        code,
        stdout,
        stderr
      });
    });
  });
}

export async function runCommandStreaming(
  command: string,
  args: string[],
  options?: { cwd?: string; env?: NodeJS.ProcessEnv }
): Promise<number | null> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options?.cwd ?? process.cwd(),
      env: options?.env ?? process.env,
      stdio: "inherit",
      shell: false
    });

    child.on("error", reject);
    child.on("close", (code) => resolvePromise(code));
  });
}

export async function resolveWorkspaceRoot(startDir: string): Promise<string | null> {
  let cursor = resolve(startDir);
  while (true) {
    const workspaceFile = join(cursor, "pnpm-workspace.yaml");
    const packageFile = join(cursor, "package.json");
    if ((await fileExists(workspaceFile)) && (await fileExists(packageFile))) {
      return cursor;
    }

    const parent = resolve(cursor, "..");
    if (parent === cursor) {
      return null;
    }
    cursor = parent;
  }
}

export interface ResolveManagedWorkspaceOptions {
  bootstrapIfMissing?: boolean;
}

export async function resolveWorkspaceRootOrManaged(
  startDir: string,
  options?: ResolveManagedWorkspaceOptions
): Promise<string | null> {
  const directWorkspace = await resolveWorkspaceRoot(startDir);
  if (directWorkspace) {
    return directWorkspace;
  }

  const managedWorkspace = resolveManagedWorkspacePath();
  const managedResolved = await resolveWorkspaceRoot(managedWorkspace);
  if (managedResolved) {
    return managedResolved;
  }

  if (!options?.bootstrapIfMissing) {
    return null;
  }

  await bootstrapManagedWorkspace(managedWorkspace);
  return await resolveWorkspaceRoot(managedWorkspace);
}

export function resolveManagedWorkspacePath(): string {
  if (process.env.BOPO_CLI_WORKSPACE_ROOT?.trim()) {
    return resolve(expandHomePrefix(process.env.BOPO_CLI_WORKSPACE_ROOT.trim()));
  }
  const instanceRoot = resolveInstanceRoot();
  return join(instanceRoot, "workspace", "bopodev");
}

async function bootstrapManagedWorkspace(workspacePath: string): Promise<void> {
  const parent = resolve(workspacePath, "..");
  await mkdir(parent, { recursive: true });

  if (await fileExists(workspacePath)) {
    const managedResolved = await resolveWorkspaceRoot(workspacePath);
    if (managedResolved) {
      return;
    }
    throw new Error(
      `Managed workspace path exists but is not a valid Bopodev workspace: ${workspacePath}\n` +
        "Set BOPO_CLI_WORKSPACE_ROOT to another empty path or remove the existing directory and rerun onboarding."
    );
  }

  const repository = process.env.BOPO_REPO_URL?.trim() || "https://github.com/dkrusenstrahle/bopodev.git";
  const requestedRef = process.env.BOPO_REPO_REF?.trim();
  const cloneArgs = requestedRef
    ? ["clone", "--depth", "1", "--branch", requestedRef, repository, workspacePath]
    : ["clone", "--depth", "1", repository, workspacePath];
  const cloneResult = await runCommandCapture("git", cloneArgs, { timeoutMs: 180_000 });
  if (!cloneResult.ok) {
    const details = [cloneResult.stderr, cloneResult.stdout].filter((value) => value.trim().length > 0).join("\n").trim();
    throw new Error(
      details.length > 0
        ? details
        : `Failed to bootstrap managed workspace from ${repository} (exit code: ${String(cloneResult.code)}).`
    );
  }
}

function resolveInstanceRoot(): string {
  if (process.env.BOPO_INSTANCE_ROOT?.trim()) {
    return resolve(expandHomePrefix(process.env.BOPO_INSTANCE_ROOT.trim()));
  }
  const bopoHome = process.env.BOPO_HOME?.trim() ? expandHomePrefix(process.env.BOPO_HOME.trim()) : join(homedir(), ".bopodev");
  const instanceId = process.env.BOPO_INSTANCE_ID?.trim() || "default";
  return resolve(bopoHome, "instances", instanceId);
}

function expandHomePrefix(value: string): string {
  if (value === "~") {
    return homedir();
  }
  if (value.startsWith("~/")) {
    return resolve(homedir(), value.slice(2));
  }
  return value;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
