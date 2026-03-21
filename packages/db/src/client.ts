import { existsSync, readFileSync, rmSync } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
/** Default export is `lock()` — see proper-lockfile `index.js`. */
const acquireProperLockfile = require("proper-lockfile") as (
  path: string,
  options?: Record<string, unknown>
) => Promise<() => Promise<void>>;
import detectPort from "detect-port";
import EmbeddedPostgresModule from "embedded-postgres";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import * as dbSchema from "./schema";
import { resolveDefaultDbPath } from "./default-paths";

export type BopoDb = PostgresJsDatabase<typeof dbSchema>;
export type BopoDatabaseClient = {
  close: () => Promise<void>;
};

const defaultDbPath = resolveDefaultDbPath();
const MIGRATIONS_FOLDER = fileURLToPath(new URL("./migrations", import.meta.url));
const DEFAULT_DB_NAME = "bopodev";
const DEFAULT_DB_USER = "bopodev";
const DEFAULT_DB_PASSWORD = "bopodev";
const DEFAULT_DB_PORT = Number(process.env.BOPO_DB_PORT ?? "55432");
const EMBEDDED_DB_START_TIMEOUT_MS = Number(process.env.BOPO_DB_START_TIMEOUT_MS ?? "120000");
const EMBEDDED_DB_LOCK_STALE_MS = Math.max(
  5000,
  Number(process.env.BOPO_DB_LOCK_STALE_MS ?? "60000")
);
const LOCAL_DB_STATE_VERSION = 1;
type EmbeddedPostgresInstance = {
  initialise(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
};

type EmbeddedPostgresCtor = new (options: {
  databaseDir: string;
  user: string;
  password: string;
  port: number;
  persistent: boolean;
  initdbFlags?: string[];
  onLog?: (message: unknown) => void;
  onError?: (message: unknown) => void;
}) => EmbeddedPostgresInstance;

type DatabaseTarget = {
  connectionString: string;
  dataPath: string | null;
  stop: () => Promise<void>;
  source: "external-postgres" | "embedded-postgres";
};

type LocalDbPhase = "initializing" | "starting" | "migrating" | "running" | "stopping" | "stopped" | "failed";

type LocalDbState = {
  version: number;
  source: "embedded-postgres";
  phase: LocalDbPhase;
  pid: number;
  port: number;
  dataPath: string;
  updatedAt: string;
  expectedMigrationCount: number;
  lastError: string | null;
};

type LocalDbLock = {
  release: () => Promise<void>;
};

type MigrationVersion = {
  count: number;
  latestTag: string | null;
};

const EmbeddedPostgres = EmbeddedPostgresModule as unknown as EmbeddedPostgresCtor;
const EXPECTED_MIGRATION_VERSION = readExpectedMigrationVersion();

export async function createDb(dbPath = defaultDbPath) {
  const target = await ensureDatabaseTarget(dbPath);
  const sqlClient = postgres(target.connectionString, {
    onnotice: () => {}
  });
  const db = drizzle(sqlClient, { schema: dbSchema });
  let closed = false;
  const client: BopoDatabaseClient = {
    close: async () => {
      if (closed) {
        return;
      }
      closed = true;
      try {
        await sqlClient.end();
      } finally {
        await target.stop();
      }
    }
  };
  return {
    db,
    client,
    connectionString: target.connectionString,
    dataPath: target.dataPath,
    source: target.source
  };
}

export async function applyDatabaseMigrations(connectionString: string, options?: { dataPath?: string | null }) {
  const statePath = options?.dataPath ? resolveLocalDbStatePath(options.dataPath) : null;
  if (statePath) {
    await updateLocalDbState(statePath, {
      phase: "migrating",
      expectedMigrationCount: EXPECTED_MIGRATION_VERSION.count,
      lastError: null
    });
  }
  const sqlClient = postgres(connectionString, {
    max: 1,
    onnotice: () => {}
  });
  try {
    const migrationDb = drizzle({ client: sqlClient });
    await migrate(migrationDb, { migrationsFolder: MIGRATIONS_FOLDER });
    await verifyDatabaseSchema(connectionString);
    if (statePath) {
      await updateLocalDbState(statePath, {
        phase: "running",
        expectedMigrationCount: EXPECTED_MIGRATION_VERSION.count,
        lastError: null
      });
    }
  } catch (error) {
    if (statePath) {
      await updateLocalDbState(statePath, {
        phase: "failed",
        expectedMigrationCount: EXPECTED_MIGRATION_VERSION.count,
        lastError: error instanceof Error ? error.message : String(error)
      }).catch(() => {});
    }
    throw error;
  } finally {
    await sqlClient.end();
  }
}

export function getExpectedDatabaseSchemaVersion() {
  return EXPECTED_MIGRATION_VERSION;
}

export async function verifyDatabaseSchema(connectionString: string) {
  const appliedCount = await readAppliedMigrationCount(connectionString);
  if (appliedCount !== EXPECTED_MIGRATION_VERSION.count) {
    const suffix = EXPECTED_MIGRATION_VERSION.latestTag ? ` (${EXPECTED_MIGRATION_VERSION.latestTag})` : "";
    throw new Error(
      `Database schema version mismatch: expected ${EXPECTED_MIGRATION_VERSION.count}${suffix} migrations, ` +
        `but found ${appliedCount}. Run 'pnpm db:migrate' or 'pnpm upgrade:local' before starting this release.`
    );
  }
  return {
    appliedCount,
    expectedCount: EXPECTED_MIGRATION_VERSION.count,
    latestTag: EXPECTED_MIGRATION_VERSION.latestTag
  };
}

export async function readAppliedMigrationCount(connectionString: string) {
  const sqlClient = postgres(connectionString, {
    max: 1,
    onnotice: () => {}
  });
  try {
    const rows = await sqlClient<{ count: string }[]>`
      SELECT COUNT(*)::text AS count
      FROM drizzle."__drizzle_migrations"
    `;
    return Number(rows[0]?.count ?? "0");
  } catch (error) {
    const message = String(error).toLowerCase();
    if (message.includes("__drizzle_migrations") || message.includes("schema \"drizzle\"")) {
      return 0;
    }
    throw error;
  } finally {
    await sqlClient.end();
  }
}

export async function ensureDatabaseTarget(dbPath: string = defaultDbPath): Promise<DatabaseTarget> {
  const externalUrl = normalizeOptionalEnvValue(process.env.DATABASE_URL);
  if (externalUrl) {
    return {
      connectionString: externalUrl,
      dataPath: null,
      stop: async () => {},
      source: "external-postgres"
    };
  }
  return ensureEmbeddedPostgresTarget(resolve(dbPath));
}

async function ensureEmbeddedPostgresTarget(dataPath: string): Promise<DatabaseTarget> {
  await mkdir(dataPath, { recursive: true });
  const statePath = resolveLocalDbStatePath(dataPath);
  const configuredPort = DEFAULT_DB_PORT;
  const resolvedDataPath = resolve(dataPath);

  const reused = await tryReuseEmbeddedPostgres(resolvedDataPath, statePath, configuredPort);
  if (reused) {
    return reused;
  }

  const lock = await acquireLocalDbLock(dataPath, EMBEDDED_DB_START_TIMEOUT_MS);
  let lockReleased = false;
  try {
    const reusedAfterLock = await tryReuseEmbeddedPostgres(resolvedDataPath, statePath, configuredPort);
    if (reusedAfterLock) {
      await releaseLocalDbLock(lock);
      lockReleased = true;
      return reusedAfterLock;
    }

    const postmasterPidFile = resolve(resolvedDataPath, "postmaster.pid");
    if (existsSync(postmasterPidFile)) {
      const pm = readPostmasterPidFile(postmasterPidFile);
      if (!pm || !isPidAlive(pm.pid)) {
        // eslint-disable-next-line no-console
        console.warn("[bopodev-db] Removing stale embedded Postgres postmaster.pid");
        rmSync(postmasterPidFile, { force: true });
      }
    }

    const selectedPort = await detectPort(configuredPort);
    if (selectedPort !== configuredPort) {
      // eslint-disable-next-line no-console
      console.warn(
        `[bopodev-db] Embedded Postgres port ${configuredPort} is in use; using ${selectedPort}. Set BOPO_DB_PORT to pin a port.`
      );
    }

    await writeLocalDbState(statePath, {
      version: LOCAL_DB_STATE_VERSION,
      source: "embedded-postgres",
      phase: "initializing",
      pid: process.pid,
      port: selectedPort,
      dataPath: resolvedDataPath,
      updatedAt: new Date().toISOString(),
      expectedMigrationCount: EXPECTED_MIGRATION_VERSION.count,
      lastError: null
    });

    const instance = new EmbeddedPostgres({
      databaseDir: resolvedDataPath,
      user: DEFAULT_DB_USER,
      password: DEFAULT_DB_PASSWORD,
      port: selectedPort,
      persistent: true,
      initdbFlags: ["--encoding=UTF8", "--locale=C"],
      onLog: () => {},
      onError: () => {}
    });

    if (!existsSync(resolve(resolvedDataPath, "PG_VERSION"))) {
      await instance.initialise();
    }

    await updateLocalDbState(statePath, {
      phase: "starting",
      expectedMigrationCount: EXPECTED_MIGRATION_VERSION.count,
      lastError: null
    });
    await instance.start();

    try {
      await ensurePostgresDatabase(connectionStringFor(selectedPort, "postgres"), DEFAULT_DB_NAME);
    } catch (error) {
      await instance.stop().catch(() => {});
      throw error;
    }

    await updateLocalDbState(statePath, {
      phase: "running",
      expectedMigrationCount: EXPECTED_MIGRATION_VERSION.count,
      lastError: null
    });

    await releaseLocalDbLock(lock);
    lockReleased = true;

    let stopped = false;
    return {
      connectionString: connectionStringFor(selectedPort, DEFAULT_DB_NAME),
      dataPath: resolvedDataPath,
      source: "embedded-postgres",
      stop: async () => {
        if (stopped) {
          return;
        }
        stopped = true;
        await updateLocalDbState(statePath, {
          phase: "stopping",
          expectedMigrationCount: EXPECTED_MIGRATION_VERSION.count,
          lastError: null
        }).catch(() => {});
        try {
          await instance.stop();
          await updateLocalDbState(statePath, {
            phase: "stopped",
            expectedMigrationCount: EXPECTED_MIGRATION_VERSION.count,
            lastError: null
          }).catch(() => {});
        } catch {
          // Best-effort shutdown; process may already be stopping.
        }
      }
    };
  } catch (error) {
    await updateLocalDbState(statePath, {
      phase: "failed",
      expectedMigrationCount: EXPECTED_MIGRATION_VERSION.count,
      lastError: error instanceof Error ? error.message : String(error)
    }).catch(() => {});
    if (!lockReleased) {
      await releaseLocalDbLock(lock).catch(() => {});
    }
    throw error;
  }
}

async function tryReuseEmbeddedPostgres(
  resolvedDataPath: string,
  statePath: string,
  configuredPort: number
): Promise<DatabaseTarget | null> {
  const postmasterPidFile = resolve(resolvedDataPath, "postmaster.pid");
  const pm = readPostmasterPidFile(postmasterPidFile);
  if (pm && isPidAlive(pm.pid)) {
    const port = pm.port ?? configuredPort;
    const adminUrl = connectionStringFor(port, "postgres");
    let dir: string | null;
    try {
      dir = await getPostgresDataDirectory(adminUrl);
    } catch (error) {
      throw new Error(
        `Embedded Postgres data path '${resolvedDataPath}' has postmaster pid ${pm.pid}, but connecting on port ${port} failed: ` +
          (error instanceof Error ? error.message : String(error))
      );
    }
    if (!dir || resolve(dir) !== resolvedDataPath) {
      throw new Error(
        `Embedded Postgres data path '${resolvedDataPath}' has a live postmaster (pid ${pm.pid}), but the server reachable on port ${port} does not use this data directory.`
      );
    }
    // eslint-disable-next-line no-console
    console.warn(`[bopodev-db] Embedded Postgres already running; reusing (pid=${pm.pid}, port=${port}).`);
    await writeLocalDbState(statePath, {
      version: LOCAL_DB_STATE_VERSION,
      source: "embedded-postgres",
      phase: "running",
      pid: process.pid,
      port,
      dataPath: resolvedDataPath,
      updatedAt: new Date().toISOString(),
      expectedMigrationCount: EXPECTED_MIGRATION_VERSION.count,
      lastError: null
    });
    await ensurePostgresDatabase(adminUrl, DEFAULT_DB_NAME);
    return {
      connectionString: connectionStringFor(port, DEFAULT_DB_NAME),
      dataPath: resolvedDataPath,
      source: "embedded-postgres",
      stop: async () => {}
    };
  }

  try {
    const adminUrl = connectionStringFor(configuredPort, "postgres");
    const dir = await getPostgresDataDirectory(adminUrl);
    if (dir && resolve(dir) === resolvedDataPath) {
      // eslint-disable-next-line no-console
      console.warn(
        `[bopodev-db] Embedded Postgres reachable without a postmaster.pid; reusing server on port ${configuredPort}.`
      );
      await writeLocalDbState(statePath, {
        version: LOCAL_DB_STATE_VERSION,
        source: "embedded-postgres",
        phase: "running",
        pid: process.pid,
        port: configuredPort,
        dataPath: resolvedDataPath,
        updatedAt: new Date().toISOString(),
        expectedMigrationCount: EXPECTED_MIGRATION_VERSION.count,
        lastError: null
      });
      await ensurePostgresDatabase(adminUrl, DEFAULT_DB_NAME);
      return {
        connectionString: connectionStringFor(configuredPort, DEFAULT_DB_NAME),
        dataPath: resolvedDataPath,
        source: "embedded-postgres",
        stop: async () => {}
      };
    }
  } catch {
    return null;
  }
  return null;
}

async function getPostgresDataDirectory(connectionString: string): Promise<string | null> {
  const sqlClient = postgres(connectionString, {
    max: 1,
    onnotice: () => {}
  });
  try {
    const rows = await sqlClient<{ data_directory: string | null }[]>`
      SELECT current_setting('data_directory', true) AS data_directory
    `;
    const actual = rows[0]?.data_directory;
    return typeof actual === "string" && actual.length > 0 ? actual : null;
  } finally {
    await sqlClient.end();
  }
}

function readPostmasterPidFile(postmasterPidFile: string): { pid: number; port: number | null } | null {
  if (!existsSync(postmasterPidFile)) {
    return null;
  }
  try {
    const raw = readFileSync(postmasterPidFile, "utf8");
    const lines = raw.split(/\r?\n/);
    const pid = Number(lines[0]?.trim());
    if (!Number.isInteger(pid) || pid <= 0) {
      return null;
    }
    let port: number | null = null;
    if (lines.length >= 4) {
      const parsedPort = Number(lines[3]?.trim());
      if (Number.isInteger(parsedPort) && parsedPort > 0) {
        port = parsedPort;
      }
    }
    return { pid, port };
  } catch {
    return null;
  }
}

async function ensurePostgresDatabase(adminConnectionString: string, databaseName: string) {
  const sqlClient = postgres(adminConnectionString, {
    max: 1,
    onnotice: () => {}
  });
  try {
    const rows = await sqlClient<{ exists: boolean }[]>`
      SELECT EXISTS (
        SELECT 1
        FROM pg_database
        WHERE datname = ${databaseName}
      ) AS exists
    `;
    if (!rows[0]?.exists) {
      await sqlClient.unsafe(`CREATE DATABASE "${databaseName.replaceAll("\"", "\"\"")}"`);
    }
  } finally {
    await sqlClient.end();
  }
}

function connectionStringFor(port: number, databaseName: string) {
  return `postgres://${DEFAULT_DB_USER}:${DEFAULT_DB_PASSWORD}@127.0.0.1:${port}/${databaseName}`;
}

function normalizeOptionalEnvValue(value: string | undefined) {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : null;
}

async function acquireLocalDbLock(dataPath: string, timeoutMs: number): Promise<LocalDbLock> {
  const deadline = Date.now() + timeoutMs;
  await waitForLegacyLockFileReleased(dataPath, deadline);
  const lockDirPath = resolveEmbeddedPostgresLockDirPath(dataPath);
  let lastError: Error | null = null;
  while (Date.now() < deadline) {
    try {
      const release = await acquireProperLockfile(dataPath, {
        lockfilePath: lockDirPath,
        stale: EMBEDDED_DB_LOCK_STALE_MS,
        realpath: true
      });
      return { release };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
      if (code === "ELOCKED" || lastError.message.includes("already being held")) {
        await sleep(200);
        continue;
      }
      throw lastError;
    }
  }
  throw new Error(
    `Timed out waiting for embedded Postgres lock at '${lockDirPath}' (${timeoutMs}ms). ` +
      `Stop other API processes using this data path, or wait for them to finish. ` +
      `If a process crashed, the lock becomes stale after ${EMBEDDED_DB_LOCK_STALE_MS}ms without updates; ` +
      `you can lower BOPO_DB_LOCK_STALE_MS temporarily or remove '${lockDirPath}' if it is orphaned. ` +
      (lastError ? `Last error: ${lastError.message}` : "")
  );
}

async function releaseLocalDbLock(lock: LocalDbLock) {
  await lock.release().catch(() => {});
}

/**
 * Older builds used a JSON file lock; wait until it is gone or clearly stale so we never
 * run two embedded Postgres instances against the same data path during version skew.
 */
async function waitForLegacyLockFileReleased(dataPath: string, deadline: number) {
  const legacyPath = resolveLegacyLocalDbLockFilePath(dataPath);
  while (Date.now() < deadline) {
    let st;
    try {
      st = await stat(legacyPath);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        return;
      }
      throw error;
    }
    if (!st.isFile()) {
      return;
    }
    const owner = await readLegacyLockOwner(legacyPath);
    if (!owner || !isPidAlive(owner.pid)) {
      await rm(legacyPath, { force: true }).catch(() => {});
      return;
    }
    await sleep(200);
  }
  const owner = await readLegacyLockOwner(legacyPath);
  throw new Error(
    `Timed out waiting for legacy embedded Postgres lock at '${legacyPath}'.` +
      (owner ? ` Another process (pid ${owner.pid}) is using the old lock format; stop it or upgrade it.` : "")
  );
}

async function readLegacyLockOwner(lockPath: string) {
  try {
    const raw = await readFile(lockPath, "utf8");
    const parsed = JSON.parse(raw) as { pid?: unknown };
    return typeof parsed.pid === "number" ? { pid: parsed.pid } : null;
  } catch {
    return null;
  }
}

async function writeLocalDbState(statePath: string, state: LocalDbState) {
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

async function updateLocalDbState(
  statePath: string,
  patch: Partial<Pick<LocalDbState, "phase" | "expectedMigrationCount" | "lastError">>
) {
  const current = await readLocalDbState(statePath);
  if (!current) {
    return;
  }
  await writeLocalDbState(statePath, {
    ...current,
    ...patch,
    updatedAt: new Date().toISOString()
  });
}

async function readLocalDbState(statePath: string): Promise<LocalDbState | null> {
  try {
    const raw = await readFile(statePath, "utf8");
    const parsed = JSON.parse(raw) as LocalDbState;
    return parsed?.version === LOCAL_DB_STATE_VERSION ? parsed : null;
  } catch {
    return null;
  }
}

function readExpectedMigrationVersion(): MigrationVersion {
  try {
    const journalPath = fileURLToPath(new URL("./migrations/meta/_journal.json", import.meta.url));
    const raw = readFileSync(journalPath, "utf8");
    const parsed = JSON.parse(raw) as { entries?: Array<{ tag?: unknown }> };
    const entries = Array.isArray(parsed.entries) ? parsed.entries : [];
    const lastTag = entries.length > 0 && typeof entries[entries.length - 1]?.tag === "string"
      ? String(entries[entries.length - 1]?.tag)
      : null;
    return {
      count: entries.length,
      latestTag: lastTag
    };
  } catch {
    return {
      count: 0,
      latestTag: null
    };
  }
}

function isPidAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Directory lock used by proper-lockfile (mkdir + mtime heartbeat; stale locks self-heal). */
function resolveEmbeddedPostgresLockDirPath(dataPath: string) {
  return `${join(dirname(dataPath), basename(dataPath))}.embed.lock`;
}

/** Legacy JSON file lock path (pre proper-lockfile). */
function resolveLegacyLocalDbLockFilePath(dataPath: string) {
  return `${join(dirname(dataPath), basename(dataPath))}.lock`;
}

function resolveLocalDbStatePath(dataPath: string) {
  return `${join(dirname(dataPath), basename(dataPath))}.state.json`;
}

function sleep(ms: number) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}
