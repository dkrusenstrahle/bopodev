import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { config as loadDotenv } from "dotenv";
import { bootstrapDatabase, listCompanies } from "bopodev-db";
import { checkRuntimeCommandHealth } from "bopodev-agent-sdk";
import type { RuntimeCommandHealth } from "bopodev-agent-sdk";
import { createApp } from "./app";
import { loadGovernanceRealtimeSnapshot } from "./realtime/governance";
import { loadOfficeSpaceRealtimeSnapshot } from "./realtime/office-space";
import { loadHeartbeatRunsRealtimeSnapshot } from "./realtime/heartbeat-runs";
import { attachRealtimeHub } from "./realtime/hub";
import { ensureBuiltinPluginsRegistered } from "./services/plugin-runtime";
import { createHeartbeatScheduler } from "./worker/scheduler";

loadApiEnv();

async function main() {
  const dbPath = process.env.BOPO_DB_PATH;
  const port = Number(process.env.PORT ?? 4020);
  const { db } = await bootstrapDatabase(dbPath);
  const existingCompanies = await listCompanies(db);
  await ensureBuiltinPluginsRegistered(
    db,
    existingCompanies.map((company) => company.id)
  );
  const codexCommand = process.env.BOPO_CODEX_COMMAND ?? "codex";
  const openCodeCommand = process.env.BOPO_OPENCODE_COMMAND ?? "opencode";
  const skipCodexPreflight = process.env.BOPO_SKIP_CODEX_PREFLIGHT === "1";
  const skipOpenCodePreflight = process.env.BOPO_SKIP_OPENCODE_PREFLIGHT === "1";
  const codexHealthRequired =
    !skipCodexPreflight &&
    (process.env.BOPO_REQUIRE_CODEX_HEALTH === "1" || (await hasCodexAgentsConfigured(db)));
  const openCodeHealthRequired =
    !skipOpenCodePreflight &&
    (process.env.BOPO_REQUIRE_OPENCODE_HEALTH === "1" || (await hasOpenCodeAgentsConfigured(db)));
  const getRuntimeHealth = async () => {
    const codex = codexHealthRequired
      ? await checkRuntimeCommandHealth(codexCommand, {
          timeoutMs: 5_000
        })
      : {
          command: codexCommand,
          available: skipCodexPreflight ? false : true,
          exitCode: null,
          elapsedMs: 0,
          error: skipCodexPreflight
            ? "Skipped by configuration: BOPO_SKIP_CODEX_PREFLIGHT=1."
            : "Skipped: no Codex agents configured."
        };
    const opencode = openCodeHealthRequired
      ? await checkRuntimeCommandHealth(openCodeCommand, {
          timeoutMs: 5_000
        })
      : {
          command: openCodeCommand,
          available: skipOpenCodePreflight ? false : true,
          exitCode: null,
          elapsedMs: 0,
          error: skipOpenCodePreflight
            ? "Skipped by configuration: BOPO_SKIP_OPENCODE_PREFLIGHT=1."
            : "Skipped: no OpenCode agents configured."
        };
    return {
      codex,
      opencode
    };
  };
  if (codexHealthRequired) {
    const startupCodexHealth = await checkRuntimeCommandHealth(codexCommand, {
      timeoutMs: 5_000
    });
    if (!startupCodexHealth.available) {
      emitCodexPreflightWarning(startupCodexHealth);
    }
  }
  if (openCodeHealthRequired) {
    const startupOpenCodeHealth = await checkRuntimeCommandHealth(openCodeCommand, {
      timeoutMs: 5_000
    });
    if (!startupOpenCodeHealth.available) {
      emitOpenCodePreflightWarning(startupOpenCodeHealth);
    }
  }

  const server = createServer();
  const realtimeHub = attachRealtimeHub(server, {
    bootstrapLoaders: {
      governance: (companyId) => loadGovernanceRealtimeSnapshot(db, companyId),
      "office-space": (companyId) => loadOfficeSpaceRealtimeSnapshot(db, companyId),
      "heartbeat-runs": (companyId) => loadHeartbeatRunsRealtimeSnapshot(db, companyId)
    }
  });
  const app = createApp({ db, getRuntimeHealth, realtimeHub });
  server.on("request", app);
  server.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`BopoDev API running on http://localhost:${port}`);
  });

  const defaultCompanyId = process.env.BOPO_DEFAULT_COMPANY_ID;
  const schedulerCompanyId = await resolveSchedulerCompanyId(db, defaultCompanyId ?? null);
  if (schedulerCompanyId) {
    createHeartbeatScheduler(db, schedulerCompanyId, realtimeHub);
  }
}

void main();

async function hasCodexAgentsConfigured(db: Awaited<ReturnType<typeof bootstrapDatabase>>["db"]) {
  const result = await db.execute(sql`
    SELECT id
    FROM agents
    WHERE provider_type = 'codex'
    LIMIT 1
  `);
  return (result.rows ?? []).length > 0;
}

async function hasOpenCodeAgentsConfigured(db: Awaited<ReturnType<typeof bootstrapDatabase>>["db"]) {
  const result = await db.execute(sql`
    SELECT id
    FROM agents
    WHERE provider_type = 'opencode'
    LIMIT 1
  `);
  return (result.rows ?? []).length > 0;
}

async function resolveSchedulerCompanyId(
  db: Awaited<ReturnType<typeof bootstrapDatabase>>["db"],
  configuredCompanyId: string | null
) {
  if (configuredCompanyId) {
    const configured = await db.execute(sql`
      SELECT id
      FROM companies
      WHERE id = ${configuredCompanyId}
      LIMIT 1
    `);
    if ((configured.rows ?? []).length > 0) {
      return configuredCompanyId;
    }
    // eslint-disable-next-line no-console
    console.warn(`[startup] BOPO_DEFAULT_COMPANY_ID='${configuredCompanyId}' was not found; using first available company.`);
  }

  const fallback = await db.execute(sql`
    SELECT id
    FROM companies
    ORDER BY created_at ASC
    LIMIT 1
  `);
  const id = fallback.rows?.[0]?.id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

function emitCodexPreflightWarning(health: RuntimeCommandHealth) {
  const red = process.stderr.isTTY ? "\x1b[31m" : "";
  const yellow = process.stderr.isTTY ? "\x1b[33m" : "";
  const reset = process.stderr.isTTY ? "\x1b[0m" : "";
  const symbol = `${red}✖${reset}`;
  process.stderr.write(
    `${symbol} ${yellow}Codex preflight failed${reset}: command '${health.command}' is unavailable.\n`
  );
  process.stderr.write(`  Install Codex CLI or set BOPO_SKIP_CODEX_PREFLIGHT=1 for local dev.\n`);
  if (process.env.BOPO_VERBOSE_STARTUP_WARNINGS === "1") {
    process.stderr.write(`  Details: ${JSON.stringify(health)}\n`);
  }
}

function emitOpenCodePreflightWarning(health: RuntimeCommandHealth) {
  const red = process.stderr.isTTY ? "\x1b[31m" : "";
  const yellow = process.stderr.isTTY ? "\x1b[33m" : "";
  const reset = process.stderr.isTTY ? "\x1b[0m" : "";
  const symbol = `${red}✖${reset}`;
  process.stderr.write(
    `${symbol} ${yellow}OpenCode preflight failed${reset}: command '${health.command}' is unavailable.\n`
  );
  process.stderr.write(`  Install OpenCode CLI or set BOPO_SKIP_OPENCODE_PREFLIGHT=1 for local dev.\n`);
  if (process.env.BOPO_VERBOSE_STARTUP_WARNINGS === "1") {
    process.stderr.write(`  Details: ${JSON.stringify(health)}\n`);
  }
}

function loadApiEnv() {
  const sourceDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(sourceDir, "../../../");
  const candidates = [resolve(repoRoot, ".env.local"), resolve(repoRoot, ".env")];
  for (const path of candidates) {
    loadDotenv({ path, override: false, quiet: true });
  }
}
