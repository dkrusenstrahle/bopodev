import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request, { type Response, type Test } from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../apps/api/src/app";
import { createWorkLoop } from "../apps/api/src/services/work-loop-service/work-loop-service";
import type { BopoDb } from "../packages/db/src/client";
import {
  bootstrapDatabase,
  createAgent,
  createApprovalRequest,
  createCompany,
  createGoal,
  createIssue,
  createProject
} from "../packages/db/src/index";
import { issueActorToken } from "../apps/api/src/security/actor-token";

type RouteCase = {
  name: string;
  permission: string;
  method: "post" | "put" | "delete";
  path: (ids: SeedIds) => string;
  body?: (ids: SeedIds) => Record<string, unknown>;
};

type SeedIds = {
  projectId: string;
  issueId: string;
  goalId: string;
  agentId: string;
  approvalId: string;
  routineId: string;
};

describe("authorization route matrix", { timeout: 30_000, retry: 1 }, () => {
  let db: BopoDb;
  let app: ReturnType<typeof createApp>;
  let tempDir: string;
  let companyId: string;
  let secondaryCompanyId: string;
  let client: { close?: () => Promise<void> };
  let ids: SeedIds;

  const permissionCases: RouteCase[] = [
    {
      name: "projects:create",
      permission: "projects:write",
      method: "post",
      path: () => "/projects",
      body: () => ({ name: "Authz Matrix Project" })
    },
    {
      name: "goals:create",
      permission: "goals:write",
      method: "post",
      path: () => "/goals",
      body: () => ({ level: "company", title: "Authz Matrix Goal" })
    },
    {
      name: "issues:create",
      permission: "issues:write",
      method: "post",
      path: ({ projectId }) => "/issues",
      body: ({ projectId }) => ({ projectId, title: "Authz Matrix Issue", priority: "medium" })
    },
    {
      name: "agents:create",
      permission: "agents:write",
      method: "post",
      path: () => "/agents",
      body: () => ({
        role: "Engineer",
        name: "Authz Matrix Agent",
        providerType: "shell",
        heartbeatCron: "*/5 * * * *",
        monthlyBudgetUsd: 20,
        canHireAgents: false,
        requestApproval: false,
        runtimeCommand: "echo",
        runtimeCwd: "/tmp",
        runtimeArgs: ['{"summary":"noop","tokenInput":0,"tokenOutput":0,"usdCost":0}']
      })
    },
    {
      name: "agents:lifecycle:pause",
      permission: "agents:lifecycle",
      method: "post",
      path: ({ agentId }) => `/agents/${agentId}/pause`,
      body: () => ({})
    },
    {
      name: "templates:create",
      permission: "templates:write",
      method: "post",
      path: () => "/templates",
      body: () => ({
        slug: "starter-template",
        name: "Starter Template",
        currentVersion: "1.0.0",
        manifest: {}
      })
    },
    {
      name: "governance:resolve",
      permission: "governance:resolve",
      method: "post",
      path: () => "/governance/resolve",
      body: ({ approvalId }) => ({ approvalId, status: "rejected" })
    },
    {
      name: "heartbeats:run",
      permission: "heartbeats:run",
      method: "post",
      path: () => "/heartbeats/run-agent",
      body: ({ agentId }) => ({ agentId })
    },
    {
      name: "heartbeats:sweep",
      permission: "heartbeats:sweep",
      method: "post",
      path: () => "/heartbeats/sweep",
      body: () => ({})
    },
    {
      name: "routines:create",
      permission: "routines:write",
      method: "post",
      path: () => "/routines",
      body: ({ projectId, agentId }) => ({
        projectId,
        title: "Authz Matrix Loop",
        assigneeAgentId: agentId
      })
    },
    {
      name: "routines:run",
      permission: "routines:run",
      method: "post",
      path: ({ routineId }) => `/routines/${routineId}/run`,
      body: () => ({})
    }
  ];

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "bopodev-authz-matrix-test-"));
    const boot = await bootstrapDatabase(join(tempDir, "test.db"));
    db = boot.db;
    client = boot.client as { close?: () => Promise<void> };
    app = createApp({ db });
    const primaryCompany = await createCompany(db, { name: "Authz Matrix Primary", mission: "Matrix testing." });
    const secondaryCompany = await createCompany(db, { name: "Authz Matrix Secondary", mission: "Scope testing." });
    companyId = primaryCompany.id;
    secondaryCompanyId = secondaryCompany.id;

    const project = await createProject(db, { companyId, name: "Seed Project" });
    if (!project) {
      throw new Error("Failed to seed project for authz matrix.");
    }
    const issue = await createIssue(db, { companyId, projectId: project.id, title: "Seed Issue" });
    const goal = await createGoal(db, { companyId, level: "company", title: "Seed Goal" });
    const agent = await createAgent(db, {
      companyId,
      role: "Engineer",
      name: "Seed Agent",
      providerType: "shell",
      heartbeatCron: "*/5 * * * *",
      monthlyBudgetUsd: "25.0000",
      canHireAgents: false,
      runtimeCommand: "echo",
      runtimeArgsJson: JSON.stringify(['{"summary":"seed","tokenInput":0,"tokenOutput":0,"usdCost":0}']),
      runtimeCwd: tempDir
    });
    const approvalId = await createApprovalRequest(db, {
      companyId,
      action: "activate_goal",
      payload: {
        level: "company",
        title: "Pending activation"
      }
    });
    const loop = await createWorkLoop(db, {
      companyId,
      projectId: project.id,
      title: "Authz Seed Loop",
      assigneeAgentId: agent.id
    });
    if (!loop) {
      throw new Error("Failed to seed routine for authz matrix.");
    }
    ids = { projectId: project.id, issueId: issue.id, goalId: goal.id, agentId: agent.id, approvalId, routineId: loop.id };
  }, 30_000);

  afterEach(async () => {
    await client?.close?.();
    await rm(tempDir, { recursive: true, force: true });
  }, 30_000);

  it("enforces permission and company scope checks for protected write routes", async () => {
    for (const routeCase of permissionCases) {
      const missingPermissionResponse = await send(routeCase, {
        companyId,
        actorType: "member",
        actorId: `member-no-${routeCase.permission.replace(":", "-")}`,
        actorCompanies: companyId
      });
      expect(missingPermissionResponse.status, `${routeCase.name} should require ${routeCase.permission}`).toBe(403);

      const wrongCompanyResponse = await send(routeCase, {
        companyId,
        actorType: "member",
        actorId: `member-cross-${routeCase.permission.replace(":", "-")}`,
        actorCompanies: secondaryCompanyId,
        actorPermissions: routeCase.permission
      });
      expect(wrongCompanyResponse.status, `${routeCase.name} should deny cross-company actors`).toBe(403);

      const allowedResponse = await send(routeCase, {
        companyId,
        actorType: "member",
        actorId: `member-allow-${routeCase.permission.replace(":", "-")}`,
        actorCompanies: companyId,
        actorPermissions: routeCase.permission
      });
      expect(allowedResponse.status, `${routeCase.name} should allow correctly scoped permissioned actors`).not.toBe(403);
    }
  });

  it("enforces board role for terminate and delete routes", async () => {
    const terminateForbidden = await request(app)
      .post(`/agents/${ids.agentId}/terminate`)
      .set("x-company-id", companyId)
      .set("x-actor-type", "member")
      .set("x-actor-id", "member-not-board")
      .set("x-actor-companies", companyId)
      .send({});
    expect(terminateForbidden.status).toBe(403);

    const deleteForbidden = await request(app)
      .delete(`/agents/${ids.agentId}`)
      .set("x-company-id", companyId)
      .set("x-actor-type", "member")
      .set("x-actor-id", "member-not-board")
      .set("x-actor-companies", companyId);
    expect(deleteForbidden.status).toBe(403);

    const terminateAllowed = await request(app).post(`/agents/${ids.agentId}/terminate`).set("x-company-id", companyId).send({});
    expect(terminateAllowed.status).toBe(200);
    expect(terminateAllowed.body.data.status).toBe("terminated");
  });

  it("enforces company scope for observability memory read routes", async () => {
    const crossCompany = await request(app)
      .get(`/observability/memory?agentId=${encodeURIComponent(ids.agentId)}`)
      .set("x-company-id", companyId)
      .set("x-actor-type", "member")
      .set("x-actor-id", "member-observability-cross")
      .set("x-actor-companies", secondaryCompanyId);
    expect(crossCompany.status).toBe(403);

    const allowed = await request(app)
      .get(`/observability/memory?agentId=${encodeURIComponent(ids.agentId)}`)
      .set("x-company-id", companyId)
      .set("x-actor-type", "member")
      .set("x-actor-id", "member-observability-allowed")
      .set("x-actor-companies", companyId);
    expect(allowed.status).toBe(200);
  });

  it("enforces company scope for observability artifact download route", async () => {
    const runId = "missing-run";
    const artifactIndex = "0";
    const routePath = `/observability/heartbeats/${encodeURIComponent(runId)}/artifacts/${artifactIndex}/download`;

    const crossCompany = await request(app)
      .get(routePath)
      .set("x-company-id", companyId)
      .set("x-actor-type", "member")
      .set("x-actor-id", "member-observability-artifact-cross")
      .set("x-actor-companies", secondaryCompanyId);
    expect(crossCompany.status).toBe(403);

    const allowed = await request(app)
      .get(routePath)
      .set("x-company-id", companyId)
      .set("x-actor-type", "member")
      .set("x-actor-id", "member-observability-artifact-allowed")
      .set("x-actor-companies", companyId);
    expect(allowed.status).toBe(404);
    expect(allowed.body.error).toContain("Run not found");
  });

  it("requires actor identity in authenticated mode and accepts bearer actor token", async () => {
    const previousMode = process.env.BOPO_DEPLOYMENT_MODE;
    const previousSecret = process.env.BOPO_AUTH_TOKEN_SECRET;
    process.env.BOPO_DEPLOYMENT_MODE = "authenticated_private";
    process.env.BOPO_AUTH_TOKEN_SECRET = "authz-test-secret";
    try {
      const missingIdentity = await request(app).get("/companies").set("x-company-id", companyId);
      expect(missingIdentity.status).toBe(401);

      const token = issueActorToken(
        {
          actorType: "member",
          actorId: "member-token",
          actorCompanies: [companyId],
          actorPermissions: []
        },
        process.env.BOPO_AUTH_TOKEN_SECRET
      );
      const tokenRequest = await request(app)
        .get("/companies")
        .set("x-company-id", companyId)
        .set("authorization", `Bearer ${token}`);
      expect(tokenRequest.status).toBe(200);
      expect(tokenRequest.body.ok).toBe(true);
    } finally {
      if (previousMode === undefined) {
        delete process.env.BOPO_DEPLOYMENT_MODE;
      } else {
        process.env.BOPO_DEPLOYMENT_MODE = previousMode;
      }
      if (previousSecret === undefined) {
        delete process.env.BOPO_AUTH_TOKEN_SECRET;
      } else {
        process.env.BOPO_AUTH_TOKEN_SECRET = previousSecret;
      }
    }
  });

  async function send(
    routeCase: RouteCase,
    actor: {
      companyId: string;
      actorType: "member";
      actorId: string;
      actorCompanies: string;
      actorPermissions?: string;
    }
  ): Promise<Response> {
    const path = routeCase.path(ids);
    const req = request(app)[routeCase.method](path)
      .set("x-company-id", actor.companyId)
      .set("x-actor-type", actor.actorType)
      .set("x-actor-id", actor.actorId)
      .set("x-actor-companies", actor.actorCompanies);
    if (actor.actorPermissions) {
      req.set("x-actor-permissions", actor.actorPermissions);
    }
    return maybeSend(req, routeCase.body?.(ids));
  }
});

function maybeSend(req: Test, body?: Record<string, unknown>) {
  return body ? req.send(body) : req.send({});
}
