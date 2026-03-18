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
import { loadAttentionRealtimeSnapshot } from "./realtime/attention";
import { attachRealtimeHub } from "./realtime/hub";
import {
  isAuthenticatedMode,
  resolveAllowedHostnames,
  resolveAllowedOrigins,
  resolveDeploymentMode,
  resolvePublicBaseUrl
} from "./security/deployment-mode";
import { ensureBuiltinPluginsRegistered } from "./services/plugin-runtime";
import { ensureBuiltinTemplatesRegistered } from "./services/template-catalog";
import { createHeartbeatScheduler } from "./worker/scheduler";

loadApiEnv();

async function main() {
  const deploymentMode = resolveDeploymentMode();
  const allowedOrigins = resolveAllowedOrigins(deploymentMode);
  const allowedHostnames = resolveAllowedHostnames(deploymentMode);
  const publicBaseUrl = resolvePublicBaseUrl();
  validateDeploymentConfiguration(deploymentMode, allowedOrigins, allowedHostnames, publicBaseUrl);
  const dbPath = normalizeOptionalDbPath(process.env.BOPO_DB_PATH);
  const port = Number(process.env.PORT ?? 4020);
  const { db } = await bootstrapDatabase(dbPath);
  const existingCompanies = await listCompanies(db);
  await ensureBuiltinPluginsRegistered(
    db,
    existingCompanies.map((company) => company.id)
  );
  await ensureBuiltinTemplatesRegistered(
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
      "heartbeat-runs": (companyId) => loadHeartbeatRunsRealtimeSnapshot(db, companyId),
      attention: (companyId) => loadAttentionRealtimeSnapshot(db, companyId)
    }
  });
  const app = createApp({ db, deploymentMode, allowedOrigins, getRuntimeHealth, realtimeHub });
  server.on("request", app);
  server.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`BopoDev API running in ${deploymentMode} mode on port ${port}`);
  });

  const defaultCompanyId = process.env.BOPO_DEFAULT_COMPANY_ID;
  const schedulerCompanyId = await resolveSchedulerCompanyId(db, defaultCompanyId ?? null);
  if (schedulerCompanyId && shouldStartScheduler()) {
    createHeartbeatScheduler(db, schedulerCompanyId, realtimeHub);
  } else if (schedulerCompanyId) {
    // eslint-disable-next-line no-console
    console.log("[startup] Scheduler disabled for this instance (BOPO_SCHEDULER_ROLE is follower/off).");
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

function validateDeploymentConfiguration(
  deploymentMode: ReturnType<typeof resolveDeploymentMode>,
  allowedOrigins: string[],
  allowedHostnames: string[],
  publicBaseUrl: URL | null
) {
  if (deploymentMode === "authenticated_public" && !publicBaseUrl) {
    throw new Error("BOPO_PUBLIC_BASE_URL is required in authenticated_public mode.");
  }
  if (isAuthenticatedMode(deploymentMode) && process.env.BOPO_AUTH_TOKEN_SECRET?.trim() === "") {
    throw new Error("BOPO_AUTH_TOKEN_SECRET must not be empty when set.");
  }
  if (isAuthenticatedMode(deploymentMode) && !process.env.BOPO_AUTH_TOKEN_SECRET?.trim()) {
    // eslint-disable-next-line no-console
    console.warn(
      "[startup] BOPO_AUTH_TOKEN_SECRET is not set. Authenticated modes will require BOPO_TRUST_ACTOR_HEADERS=1 behind a trusted proxy."
    );
  }
  if (isAuthenticatedMode(deploymentMode) && process.env.BOPO_TRUST_ACTOR_HEADERS !== "1" && !process.env.BOPO_AUTH_TOKEN_SECRET?.trim()) {
    throw new Error(
      "Authenticated mode requires either BOPO_AUTH_TOKEN_SECRET (token identity) or BOPO_TRUST_ACTOR_HEADERS=1 (trusted proxy headers)."
    );
  }
  if (isAuthenticatedMode(deploymentMode) && process.env.BOPO_ALLOW_LOCAL_BOARD_FALLBACK === "1") {
    throw new Error("BOPO_ALLOW_LOCAL_BOARD_FALLBACK cannot be enabled in authenticated modes.");
  }
  // eslint-disable-next-line no-console
  console.log(
    `[startup] Deployment config: mode=${deploymentMode} origins=${allowedOrigins.join(",")} hosts=${allowedHostnames.join(",")}`
  );
}

function shouldStartScheduler() {
  const rawRole = (process.env.BOPO_SCHEDULER_ROLE ?? "auto").trim().toLowerCase();
  if (rawRole === "off" || rawRole === "follower") {
    return false;
  }
  if (rawRole === "leader" || rawRole === "auto") {
    return true;
  }
  throw new Error(`Invalid BOPO_SCHEDULER_ROLE '${rawRole}'. Expected one of: auto, leader, follower, off.`);
}

function loadApiEnv() {
  const sourceDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(sourceDir, "../../../");
  const candidates = [resolve(repoRoot, ".env.local"), resolve(repoRoot, ".env")];
  for (const path of candidates) {
    loadDotenv({ path, override: false, quiet: true });
  }
}

function normalizeOptionalDbPath(value: string | undefined) {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : undefined;
}
