import cors from "cors";
import express from "express";
import type { NextFunction, Request, Response } from "express";
import { sql } from "drizzle-orm";
import { RepositoryValidationError } from "bopodev-db";
import { nanoid } from "nanoid";
import type { AppContext } from "./context";
import { createAgentsRouter } from "./routes/agents";
import { createAuthRouter } from "./routes/auth";
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
import { resolveAllowedOrigins, resolveDeploymentMode } from "./security/deployment-mode";

export function createApp(ctx: AppContext) {
  const app = express();
  const deploymentMode = ctx.deploymentMode ?? resolveDeploymentMode();
  const allowedOrigins = ctx.allowedOrigins ?? resolveAllowedOrigins(deploymentMode);
  app.use(
    cors({
      origin(origin, callback) {
        if (!origin) {
          callback(null, true);
          return;
        }
        if (
          deploymentMode === "local" &&
          (origin.startsWith("http://localhost:") || origin.startsWith("http://127.0.0.1:"))
        ) {
          callback(null, true);
          return;
        }
        if (allowedOrigins.includes(origin)) {
          callback(null, true);
          return;
        }
        callback(new Error(`CORS origin denied: ${origin}`));
      },
      credentials: true,
      methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
      allowedHeaders: ["content-type", "x-company-id", "authorization", "x-client-trace-id", "x-bopo-actor-token"]
    })
  );
  app.use(express.json());
  app.use(attachRequestActor);

  app.use((req, res, next) => {
    const requestId = req.header("x-request-id")?.trim() || nanoid(14);
    req.requestId = requestId;
    res.setHeader("x-request-id", requestId);
    next();
  });
  const logApiRequests = process.env.BOPO_LOG_API_REQUESTS !== "0";
  if (logApiRequests) {
    app.use((req, res, next) => {
      if (req.path === "/health") {
        next();
        return;
      }
      const method = req.method.toUpperCase();
      if (!isCrudMethod(method)) {
        next();
        return;
      }
      const startedAt = Date.now();
      res.on("finish", () => {
        const elapsedMs = Date.now() - startedAt;
        const timestamp = new Date().toTimeString().slice(0, 8);
        process.stderr.write(`[${timestamp}] INFO: ${method} ${req.originalUrl} ${res.statusCode} ${elapsedMs}ms\n`);
      });
      next();
    });
  }

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

  app.use("/auth", createAuthRouter(ctx));
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

function isCrudMethod(method: string) {
  return method === "GET" || method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE";
}
