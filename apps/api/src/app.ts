import cors from "cors";
import express from "express";
import type { NextFunction, Request, Response } from "express";
import { sql } from "drizzle-orm";
import { RepositoryValidationError } from "bopodev-db";
import { nanoid } from "nanoid";
import type { AppContext } from "./context";
import { createAgentsRouter } from "./routes/agents";
import { createCompaniesRouter } from "./routes/companies";
import { createGoalsRouter } from "./routes/goals";
import { createGovernanceRouter } from "./routes/governance";
import { createHeartbeatRouter } from "./routes/heartbeats";
import { createIssuesRouter } from "./routes/issues";
import { createObservabilityRouter } from "./routes/observability";
import { createProjectsRouter } from "./routes/projects";
import { createPluginsRouter } from "./routes/plugins";
import { sendError } from "./http";
import { attachRequestActor } from "./middleware/request-actor";

export function createApp(ctx: AppContext) {
  const app = express();
  app.use(cors());
  app.use(express.json());
  app.use(attachRequestActor);

  app.use((req, res, next) => {
    const requestId = req.header("x-request-id")?.trim() || nanoid(14);
    req.requestId = requestId;
    res.setHeader("x-request-id", requestId);
    next();
  });

  app.get("/health", async (_req, res) => {
    let dbReady = false;
    let dbError: string | undefined;
    try {
      await ctx.db.execute(sql`SELECT 1`);
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

  app.use("/companies", createCompaniesRouter(ctx));
  app.use("/projects", createProjectsRouter(ctx));
  app.use("/issues", createIssuesRouter(ctx));
  app.use("/goals", createGoalsRouter(ctx));
  app.use("/agents", createAgentsRouter(ctx));
  app.use("/governance", createGovernanceRouter(ctx));
  app.use("/heartbeats", createHeartbeatRouter(ctx));
  app.use("/observability", createObservabilityRouter(ctx));
  app.use("/plugins", createPluginsRouter(ctx));

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof RepositoryValidationError) {
      return sendError(res, error.message, 422);
    }
    // eslint-disable-next-line no-console
    console.error(error);
    return sendError(res, "Internal server error", 500);
  });

  return app;
}
