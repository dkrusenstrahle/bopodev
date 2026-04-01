import { createServer } from "node:http";
import { listCompanies } from "bopodev-db";
import { createApp } from "./app";
import { loadGovernanceRealtimeSnapshot } from "./realtime/governance";
import { loadOfficeSpaceRealtimeSnapshot } from "./realtime/office-space";
import { loadHeartbeatRunsRealtimeSnapshot } from "./realtime/heartbeat-runs";
import { loadAttentionRealtimeSnapshot } from "./realtime/attention";
import { attachRealtimeHub } from "./realtime/hub";
import {
  resolveAllowedHostnames,
  resolveAllowedOrigins,
  resolveDeploymentMode,
  resolvePublicBaseUrl
} from "./security/deployment-mode";
import { ensureBuiltinPluginsRegistered } from "./services/plugin-runtime";
import { pluginWorkerHost } from "./services/plugin-worker-host";
import { ensureBuiltinTemplatesRegistered } from "./services/template-catalog";
import { createHeartbeatScheduler } from "./worker/scheduler";
import { bootstrapDatabaseWithStartupLogging } from "./startup/database";
import { validateDeploymentConfiguration } from "./startup/deployment-validation";
import { loadApiEnv, normalizeOptionalDbPath } from "./startup/env";
import {
  buildGetRuntimeHealth,
  hasCodexAgentsConfigured,
  hasOpenCodeAgentsConfigured,
  runStartupRuntimePreflights
} from "./startup/runtime-health";
import { resolveSchedulerCompanyId, shouldStartScheduler } from "./startup/scheduler-config";
import { attachGracefulShutdownHandlers } from "./shutdown/graceful-shutdown";

loadApiEnv();

async function main() {
  const deploymentMode = resolveDeploymentMode();
  const allowedOrigins = resolveAllowedOrigins(deploymentMode);
  const allowedHostnames = resolveAllowedHostnames(deploymentMode);
  const publicBaseUrl = resolvePublicBaseUrl();
  validateDeploymentConfiguration(deploymentMode, allowedOrigins, allowedHostnames, publicBaseUrl);
  const dbPath = normalizeOptionalDbPath(process.env.BOPO_DB_PATH);
  const port = Number(process.env.PORT ?? 4020);
  const { db, client: dbClient } = await bootstrapDatabaseWithStartupLogging(dbPath);
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
  const getRuntimeHealth = buildGetRuntimeHealth({
    codexCommand,
    openCodeCommand,
    skipCodexPreflight,
    skipOpenCodePreflight,
    codexHealthRequired,
    openCodeHealthRequired
  });
  await runStartupRuntimePreflights({
    codexHealthRequired,
    openCodeHealthRequired,
    codexCommand,
    openCodeCommand
  });

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
  let scheduler: ReturnType<typeof createHeartbeatScheduler> | undefined;
  if (schedulerCompanyId && shouldStartScheduler()) {
    scheduler = createHeartbeatScheduler(db, schedulerCompanyId, realtimeHub);
  } else if (schedulerCompanyId) {
    // eslint-disable-next-line no-console
    console.log("[startup] Scheduler disabled for this instance (BOPO_SCHEDULER_ROLE is follower/off).");
  }

  attachGracefulShutdownHandlers({
    server,
    realtimeHub,
    dbClient,
    scheduler,
    pluginWorkers: pluginWorkerHost
  });
}

void main();
