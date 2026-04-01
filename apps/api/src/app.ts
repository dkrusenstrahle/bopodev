import express from "express";
import type { NextFunction, Request, Response } from "express";
import { pingDatabase, RepositoryValidationError } from "bopodev-db";
import type { AppContext } from "./context";
import { createAssistantRouter } from "./routes/assistant";
import { createAgentsRouter } from "./routes/agents";
import { createAuthRouter } from "./routes/auth";
import { createAttentionRouter } from "./routes/attention";
import { createCompaniesRouter } from "./routes/companies";
import { createGoalsRouter } from "./routes/goals";
import { createGovernanceRouter } from "./routes/governance";
import { createHeartbeatRouter } from "./routes/heartbeats";
import { createIssuesRouter } from "./routes/issues";
import { createRoutinesRouter } from "./routes/routines";
import { createObservabilityRouter } from "./routes/observability";
import { createProjectsRouter } from "./routes/projects";
import { createPluginsRouter } from "./routes/plugins";
import { createTemplatesRouter } from "./routes/templates";
import { sendError } from "./http";
import { createCorsMiddleware } from "./middleware/cors-config";
import { attachCrudRequestLogging } from "./middleware/request-logging";
import { attachRequestId } from "./middleware/request-id";
import { attachRequestActor } from "./middleware/request-actor";
import { resolveAllowedOrigins, resolveDeploymentMode } from "./security/deployment-mode";

export function createApp(ctx: AppContext) {
  const app = express();
  const deploymentMode = ctx.deploymentMode ?? resolveDeploymentMode();
  const allowedOrigins = ctx.allowedOrigins ?? resolveAllowedOrigins(deploymentMode);
  app.use(createCorsMiddleware(deploymentMode, allowedOrigins));
  app.use(express.json());
  app.use(attachRequestActor);
  app.use(attachRequestId);
  const logApiRequests = process.env.BOPO_LOG_API_REQUESTS !== "0";
  if (logApiRequests) {
    app.use(attachCrudRequestLogging);
  }

  app.get("/health", async (_req, res) => {
    let dbReady = false;
    let dbError: string | undefined;
    try {
      await pingDatabase(ctx.db);
      dbReady = true;
    } catch (error) {
      dbError = String(error);
    }

    let runtime = {};
    try {
      runtime = (await ctx.getRuntimeHealth?.()) ?? {};
    } catch (error) {
      runtime = { error: String(error) };
    }

    const ok = dbReady;
    res.status(ok ? 200 : 503).json({
      ok,
      db: dbReady ? { ready: true } : { ready: false, error: dbError },
      runtime
    });
  });

  app.use("/auth", createAuthRouter(ctx));
  app.use("/attention", createAttentionRouter(ctx));
  app.use("/assistant", createAssistantRouter(ctx));
  app.use("/companies", createCompaniesRouter(ctx));
  app.use("/projects", createProjectsRouter(ctx));
  app.use("/issues", createIssuesRouter(ctx));
  const routinesRouter = createRoutinesRouter(ctx);
  app.use("/routines", routinesRouter);
  app.use("/loops", routinesRouter);
  app.use("/goals", createGoalsRouter(ctx));
  app.use("/agents", createAgentsRouter(ctx));
  app.use("/governance", createGovernanceRouter(ctx));
  app.use("/heartbeats", createHeartbeatRouter(ctx));
  app.use("/observability", createObservabilityRouter(ctx));
  app.use("/plugins", createPluginsRouter(ctx));
  app.use("/templates", createTemplatesRouter(ctx));

  app.use((error: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof RepositoryValidationError) {
      return sendError(res, error.message, 422);
    }
    const requestId = req.requestId;
    if (requestId) {
      // eslint-disable-next-line no-console
      console.error(`[request ${requestId}]`, error);
    } else {
      // eslint-disable-next-line no-console
      console.error(error);
    }
    return sendError(res, "Internal server error", 500);
  });

  return app;
}
