import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../apps/api/src/app";
import type { BopoDb } from "../packages/db/src/client";
import {
  bootstrapDatabase,
  createApprovalRequest,
  createCompany,
  createIssue,
  createProject
} from "../packages/db/src/index";

describe("governance and company scope authorization", { timeout: 90_000 }, () => {
  let db: BopoDb;
  let app: ReturnType<typeof createApp>;
  let tempDir: string;
  let companyId: string;
  let secondaryCompanyId: string;
  let client: { close?: () => Promise<void> };

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "bopodev-authz-test-"));
    const boot = await bootstrapDatabase(join(tempDir, "test.db"));
    db = boot.db;
    client = boot.client as { close?: () => Promise<void> };
    app = createApp({ db });
    const primaryCompany = await createCompany(db, { name: "Acme Primary", mission: "Primary test company." });
    const secondaryCompany = await createCompany(db, { name: "Acme Secondary", mission: "Secondary test company." });
    companyId = primaryCompany.id;
    secondaryCompanyId = secondaryCompany.id;
  });

  afterEach(async () => {
    await client?.close?.();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("requires company scope for protected routes", async () => {
    const response = await request(app).get("/projects");
    expect(response.status).toBe(422);
    expect(String(response.body.error ?? "")).toContain("Missing company scope");
  });

  it("denies access when member actor is scoped to another company", async () => {
    const response = await request(app)
      .get("/projects")
      .set("x-company-id", companyId)
      .set("x-actor-type", "member")
      .set("x-actor-id", "member-locked")
      .set("x-actor-companies", secondaryCompanyId);

    expect(response.status).toBe(403);
    expect(String(response.body.error ?? "")).toContain("does not have access");
  });

  it("allows scoped member with explicit permission to create a project", async () => {
    const response = await request(app)
      .post("/projects")
      .set("x-company-id", companyId)
      .set("x-actor-type", "member")
      .set("x-actor-id", "member-writer")
      .set("x-actor-companies", companyId)
      .set("x-actor-permissions", "projects:write")
      .send({ name: "Public OSS Milestone" });

    expect(response.status).toBe(200);
    expect(response.body.data.name).toBe("Public OSS Milestone");
    expect(response.body.data.primaryWorkspace?.isPrimary).toBe(true);
    expect(typeof response.body.data.primaryWorkspace?.cwd).toBe("string");
    expect(Array.isArray(response.body.data.workspaces)).toBe(true);
    expect(response.body.data.workspaces.length).toBeGreaterThanOrEqual(1);
  });

  it("enforces governance resolve permission and emits inbox updates", async () => {
    const approvalId = await createApprovalRequest(db, {
      companyId,
      action: "hire_agent",
      payload: {
        name: "Candidate Worker",
        role: "Engineer",
        providerType: "shell",
        heartbeatCron: "*/5 * * * *",
        monthlyBudgetUsd: 20,
        canHireAgents: false,
        runtimeCwd: join(tmpdir(), "bopodev-instances", "default", "workspaces", companyId, "agents", "gov-ok")
      }
    });

    const forbidden = await request(app)
      .post("/governance/resolve")
      .set("x-company-id", companyId)
      .set("x-actor-type", "member")
      .set("x-actor-id", "member-no-gov")
      .set("x-actor-companies", companyId)
      .set("x-actor-permissions", "projects:write")
      .send({ approvalId, status: "approved" });

    expect(forbidden.status).toBe(403);

    const allowed = await request(app)
      .post("/governance/resolve")
      .set("x-company-id", companyId)
      .set("x-actor-type", "member")
      .set("x-actor-id", "member-gov")
      .set("x-actor-companies", companyId)
      .set("x-actor-permissions", "governance:resolve")
      .send({ approvalId, status: "approved" });

    expect(allowed.status).toBe(200);
    expect(allowed.body.data.execution.applied).toBe(true);

    const inbox = await request(app)
      .get("/governance/inbox")
      .set("x-company-id", companyId)
      .set("x-actor-type", "member")
      .set("x-actor-id", "member-gov")
      .set("x-actor-companies", companyId);

    expect(inbox.status).toBe(200);
    expect(Array.isArray(inbox.body.data.items)).toBe(true);
    expect(inbox.body.data.items.some((item: { approval: { id: string } }) => item.approval.id === approvalId)).toBe(true);

    const attention = await request(app)
      .get("/attention")
      .set("x-company-id", companyId)
      .set("x-actor-type", "member")
      .set("x-actor-id", "member-gov")
      .set("x-actor-companies", companyId);
    expect(attention.status).toBe(200);
    const approvalAttention = (attention.body.data.items as Array<{
      category: string;
      state: string;
      evidence?: { approvalId?: string };
    }>).find((item) => item.category === "approval_required" && item.evidence?.approvalId === approvalId);
    if (approvalAttention) {
      expect(approvalAttention.state).toBe("resolved");
    }
  });

  it("rejects approval resolve when hire payload runtimeCwd is outside managed root", async () => {
    const approvalId = await createApprovalRequest(db, {
      companyId,
      action: "hire_agent",
      payload: {
        name: "Unsafe Runtime Candidate",
        role: "Engineer",
        providerType: "shell",
        heartbeatCron: "*/5 * * * *",
        monthlyBudgetUsd: 20,
        canHireAgents: false,
        runtimeCwd: join(tmpdir(), "outside-governance-runtime")
      }
    });

    const response = await request(app)
      .post("/governance/resolve")
      .set("x-company-id", companyId)
      .set("x-actor-type", "member")
      .set("x-actor-id", "member-gov")
      .set("x-actor-companies", companyId)
      .set("x-actor-permissions", "governance:resolve")
      .send({ approvalId, status: "approved" });

    expect(response.status).toBe(422);
    expect(String(response.body.error ?? "")).toContain("must be inside");
  });

  it("enforces issues:write on issue mutations", async () => {
    const project = await createProject(db, { companyId, name: "Authz Project" });
    const issue = await createIssue(db, { companyId, projectId: project.id, title: "Guard write endpoints" });

    const forbidden = await request(app)
      .put(`/issues/${issue.id}`)
      .set("x-company-id", companyId)
      .set("x-actor-type", "member")
      .set("x-actor-id", "member-read-only")
      .set("x-actor-companies", companyId)
      .send({ status: "in_progress" });

    expect(forbidden.status).toBe(403);

    const allowed = await request(app)
      .put(`/issues/${issue.id}`)
      .set("x-company-id", companyId)
      .set("x-actor-type", "member")
      .set("x-actor-id", "member-issue-writer")
      .set("x-actor-companies", companyId)
      .set("x-actor-permissions", "issues:write")
      .send({ status: "in_progress" });

    expect(allowed.status).toBe(200);
    expect(allowed.body.data.status).toBe("in_progress");
  });
});
