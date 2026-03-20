import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const DEFAULT_INSTANCE_ID = "default";
const DEFAULT_BOPO_HOME_DIR = resolve(homedir(), ".bopodev");
const ONBOARDING_ENV_KEYS_TO_CLEAR = [
  "BOPO_DEFAULT_COMPANY_NAME",
  "BOPO_DEFAULT_COMPANY_ID",
  "NEXT_PUBLIC_DEFAULT_COMPANY_ID",
  "BOPO_DEFAULT_AGENT_PROVIDER",
  "BOPO_DEFAULT_AGENT_MODEL",
  "BOPO_DEFAULT_TEMPLATE_ID"
];
const WORKSPACE_RUNTIME_MARKERS = [
  "scripts/dev-runner.mjs",
  "scripts/start-runner.mjs",
  "apps/api/src/server.ts",
  "pnpm --filter bopodev-api dev",
  "pnpm --filter bopodev-api start",
  "next dev --turbopack",
  "next start --port",
  "turbo --no-update-notifier start --filter=bopodev-api",
  "turbo --no-update-notifier dev"
];

function resolveMonorepoRoot(startDir) {
  let current = resolve(startDir);
  for (;;) {
    if (existsSync(join(current, "pnpm-workspace.yaml"))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      return resolve(startDir);
    }
    current = parent;
  }
}

async function main() {
  const workspaceRoot = resolveMonorepoRoot(process.cwd());
  const envFromFile = await loadDotEnv(join(workspaceRoot, ".env"));
  applyEnvDefaults(envFromFile);
  await stopOrphanBopoProcesses(workspaceRoot, process.env, logClearStep);

  const instanceRoot = resolveInstanceRoot(process.env);
  const dbPath = normalizeOptionalPath(process.env.BOPO_DB_PATH);

  logClearStep(`Removing instance folder: ${instanceRoot}`);
  await rm(instanceRoot, { recursive: true, force: true });

  if (dbPath && !isPathInside(instanceRoot, dbPath)) {
    logClearStep(`Removing explicit DB path: ${dbPath}`);
    await rm(dbPath, { recursive: true, force: true });
  }

  const envPath = join(workspaceRoot, ".env");
  await clearOnboardingEnvKeys(envPath, ONBOARDING_ENV_KEYS_TO_CLEAR);
  for (const key of ONBOARDING_ENV_KEYS_TO_CLEAR) {
    delete process.env[key];
  }

  runPnpm(["--filter", "bopodev-api", "db:init"], workspaceRoot);

  logClearStep("Clear complete: instance reset and empty DB initialized.");
  logClearStep("Next: run `pnpm onboard` to choose a new company, provider, and model.");
}

function runPnpm(args, cwd = process.cwd()) {
  const command = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    env: process.env
  });
  if (result.status !== 0) {
    throw new Error(`Command failed: pnpm ${args.join(" ")}`);
  }
}

async function stopOrphanBopoProcesses(workspaceRoot, env, log = logClearStep) {
  const ports = resolveRuntimePorts(env);
  const processTable = readProcessTable();
  const candidatePids = new Set();

  for (const port of ports) {
    for (const pid of readListeningPidsForPort(port)) {
      candidatePids.add(pid);
    }
  }

  for (const pid of collectWorkspaceRuntimePids(workspaceRoot, processTable)) {
    candidatePids.add(pid);
  }

  const withDescendants = collectDescendantPids(processTable, candidatePids);
  withDescendants.delete(process.pid);
  if (withDescendants.size === 0) {
    log("No active Bopo runtime processes detected.");
    return;
  }

  const sorted = Array.from(withDescendants).sort((a, b) => a - b);
  log(`Stopping ${sorted.length} runtime process${sorted.length === 1 ? "" : "es"}: ${sorted.join(", ")}`);
  terminatePids(sorted, "SIGTERM");
  await wait(1200);
  const stillRunning = sorted.filter((pid) => isPidAlive(pid));
  if (stillRunning.length > 0) {
    log(`Force-stopping stubborn process${stillRunning.length === 1 ? "" : "es"}: ${stillRunning.join(", ")}`);
    terminatePids(stillRunning, "SIGKILL");
    await wait(400);
  }
}

function resolveRuntimePorts(env) {
  const webPort = parseIntegerPort(env.WEB_PORT) ?? 4010;
  const apiPort = parseIntegerPort(env.API_PORT) ?? parseIntegerPort(env.PORT) ?? 4020;
  return Array.from(new Set([webPort, apiPort]));
}

function parseIntegerPort(value) {
  const parsed = Number(value?.trim());
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return null;
  }
  return parsed;
}

function readListeningPidsForPort(port) {
  const result = spawnSync("lsof", ["-t", "-nP", `-iTCP:${port}`, "-sTCP:LISTEN"], {
    encoding: "utf8"
  });
  if (result.status !== 0) {
    return [];
  }
  return parseListeningPidsOutput(result.stdout);
}

function readProcessTable() {
  const result = spawnSync("ps", ["-Ao", "pid=,ppid=,command="], {
    encoding: "utf8"
  });
  if (result.status !== 0) {
    return [];
  }
  return parseProcessTableOutput(result.stdout);
}

function collectWorkspaceRuntimePids(workspaceRoot, processTable, markers = WORKSPACE_RUNTIME_MARKERS) {
  const pids = new Set();
  for (const entry of processTable) {
    if (!entry.command.includes(workspaceRoot)) {
      continue;
    }
    if (markers.some((marker) => entry.command.includes(marker))) {
      pids.add(entry.pid);
    }
  }
  return pids;
}

function parseListeningPidsOutput(stdout) {
  if (!stdout.trim()) {
    return [];
  }
  return stdout
    .split(/\r?\n/)
    .map((line) => Number(line.trim()))
    .filter((value) => Number.isInteger(value) && value > 0);
}

function parseProcessTableOutput(stdout) {
  if (!stdout.trim()) {
    return [];
  }
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const firstSpace = line.indexOf(" ");
      if (firstSpace < 0) {
        return null;
      }
      const pid = Number(line.slice(0, firstSpace).trim());
      const rest = line.slice(firstSpace).trim();
      const secondSpace = rest.indexOf(" ");
      if (secondSpace < 0) {
        return null;
      }
      const ppid = Number(rest.slice(0, secondSpace).trim());
      const command = rest.slice(secondSpace).trim();
      if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(ppid) || ppid < 0 || command.length === 0) {
        return null;
      }
      return { pid, ppid, command };
    })
    .filter((entry) => entry !== null);
}

function collectDescendantPids(processTable, rootPids) {
  const result = new Set(rootPids);
  const childrenByParent = new Map();
  for (const entry of processTable) {
    const existing = childrenByParent.get(entry.ppid);
    if (existing) {
      existing.push(entry.pid);
    } else {
      childrenByParent.set(entry.ppid, [entry.pid]);
    }
  }
  const queue = Array.from(rootPids);
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) {
      continue;
    }
    const children = childrenByParent.get(current) ?? [];
    for (const child of children) {
      if (result.has(child)) {
        continue;
      }
      result.add(child);
      queue.push(child);
    }
  }
  return result;
}

function terminatePids(pids, signal) {
  for (const pid of pids) {
    try {
      process.kill(pid, signal);
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
      if (code === "ESRCH") {
        continue;
      }
      throw error;
    }
  }
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function wait(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function resolveInstanceRoot(env) {
  const configuredRoot = normalizeOptionalPath(env.BOPO_INSTANCE_ROOT);
  if (configuredRoot) {
    return configuredRoot;
  }
  const instanceId = env.BOPO_INSTANCE_ID?.trim() || DEFAULT_INSTANCE_ID;
  const homeDir = normalizeOptionalPath(env.BOPO_HOME) || DEFAULT_BOPO_HOME_DIR;
  return resolve(homeDir, "instances", instanceId);
}

function applyEnvDefaults(fileEnv) {
  for (const [key, value] of Object.entries(fileEnv)) {
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

async function clearOnboardingEnvKeys(path, keys) {
  if (!existsSync(path)) {
    return;
  }
  const content = await readFile(path, "utf8");
  const nextLines = content
    .split(/\r?\n/)
    .filter((line) => !keys.some((key) => line.trimStart().startsWith(`${key}=`)));
  const nextContent = nextLines.join("\n");
  await writeFile(path, nextContent.endsWith("\n") ? nextContent : `${nextContent}\n`, "utf8");
}

async function loadDotEnv(path) {
  if (!existsSync(path)) {
    return {};
  }
  const content = await readFile(path, "utf8");
  const entries = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const equalIndex = line.indexOf("=");
    if (equalIndex <= 0) {
      continue;
    }
    const key = line.slice(0, equalIndex).trim();
    if (!key) {
      continue;
    }
    const value = stripWrappingQuotes(line.slice(equalIndex + 1).trim());
    entries[key] = value;
  }
  return entries;
}

function stripWrappingQuotes(value) {
  if (
    (value.startsWith("\"") && value.endsWith("\"")) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function normalizeOptionalPath(value) {
  const normalized = value?.trim();
  if (!normalized) {
    return null;
  }
  if (normalized === "~") {
    return homedir();
  }
  if (normalized.startsWith("~/")) {
    return resolve(homedir(), normalized.slice(2));
  }
  return resolve(normalized);
}

function isPathInside(parent, target) {
  const relative = target.slice(parent.length);
  return target === parent || (target.startsWith(parent) && (relative.startsWith("/") || relative.startsWith("\\")));
}

function logClearStep(message) {
  // eslint-disable-next-line no-console
  console.log(`[clear] ${message}`);
}

function logUnstickStep(message) {
  // eslint-disable-next-line no-console
  console.log(`[unstick] ${message}`);
}

/** Stop dev/api listeners and matching runtime processes without deleting data (safe before `pnpm dev`). */
export async function unstickBopoRuntime(options = {}) {
  const workspaceRoot = options.workspaceRoot ?? resolveMonorepoRoot(process.cwd());
  const envFromFile = await loadDotEnv(join(workspaceRoot, ".env"));
  applyEnvDefaults(envFromFile);
  await stopOrphanBopoProcesses(workspaceRoot, process.env, logUnstickStep);
}

const isDirectExecution = process.argv[1] ? resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false;

if (isDirectExecution) {
  void main().catch((error) => {
    // eslint-disable-next-line no-console
    console.error(`[clear] failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}

export {
  collectDescendantPids,
  collectWorkspaceRuntimePids,
  isPathInside,
  normalizeOptionalPath,
  parseIntegerPort,
  parseListeningPidsOutput,
  parseProcessTableOutput,
  resolveMonorepoRoot,
  resolveRuntimePorts,
  stripWrappingQuotes
};
