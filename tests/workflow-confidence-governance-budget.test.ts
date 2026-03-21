import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../apps/api/src/app";
import { runHeartbeatForAgent } from "../apps/api/src/services/heartbeat-service";
import { enqueueHeartbeatQueueJob, runHeartbeatQueueSweep } from "../apps/api/src/services/heartbeat-queue-service";
import type { BopoDb } from "../packages/db/src/client";
import {
  agents,
  bootstrapDatabase,
  createAgent,
  createApprovalRequest,
  createCompany,
  createIssue,
  createProject,
  issues,
  listApprovalRequests,
  listHeartbeatQueueJobs,
  projects
} from "../packages/db/src/index";

describe("workflow confidence: governance + budget", { retry: 1 }, () => {
  let db: BopoDb;
  let app: ReturnType<typeof createApp>;
  let tempDir: string;
  let companyId: string;
  let client: { close?: () => Promise<void> };

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "bopodev-workflow-confidence-gov-budget-"));
    const boot = await bootstrapDatabase(join(tempDir, "test.db"));
    db = boot.db;
    client = boot.client as { close?: () => Promise<void> };
    app = createApp({ db });
    const company = await createCompany(db, { name: "Confidence Co", mission: "Prove workflow behavior deterministically." });
    companyId = company.id;
  });

  afterEach(async () => {
    await client?.close?.();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("resolves activate_goal approvals with concrete side effects", async () => {
    const approvalId = await createApprovalRequest(db, {
      companyId,
      action: "activate_goal",
      payload: {
        level: "company",
        title: "Ship trustworthy automation",
        description: "Harden reliability workflows."
      }
    });

    const response = await request(app).post("/governance/resolve").set("x-company-id", companyId).send({
      approvalId,
      status: "approved"
    });

    expect(response.status).toBe(200);
    expect(response.body.data.execution.applied).toBe(true);
    expect(response.body.data.execution.entityType).toBe("goal");

    const goals = await request(app).get("/goals").set("x-company-id", companyId);
    expect(goals.status).toBe(200);
    expect(
      goals.body.data.some((goal: { title: string; status: string }) => goal.title === "Ship trustworthy automation" && goal.status === "active")
    ).toBe(true);
  });

  it("resolves override_budget approvals by updating agent monthly budget", async () => {
    const agent = await createAgent(db, {
      companyId,
      role: "Engineer",
      name: "Budgeted Worker",
      providerType: "shell",
      heartbeatCron: "*/5 * * * *",
      monthlyBudgetUsd: "5.0000",
      runtimeCommand: "echo",
      runtimeArgsJson: JSON.stringify(['{"summary":"noop","tokenInput":0,"tokenOutput":0,"usdCost":0}']),
      runtimeCwd: tempDir
    });
    await db.execute(
      `UPDATE agents SET used_budget_usd = '5.0000' WHERE company_id = '${companyId}' AND id = '${agent.id}'`
    );

    const approvalId = await createApprovalRequest(db, {
      companyId,
      action: "override_budget",
      payload: {
        agentId: agent.id,
        additionalBudgetUsd: 10,
        reason: "Board approved additional budget."
      }
    });

    const response = await request(app).post("/governance/resolve").set("x-company-id", companyId).send({
      approvalId,
      status: "approved"
    });

    expect(response.status).toBe(200);
    expect(response.body.data.execution.applied).toBe(true);
    expect(response.body.data.execution.entityType).toBe("agent");

    const agentsResponse = await request(app).get("/agents").set("x-company-id", companyId);
    expect(agentsResponse.status).toBe(200);
    const updated = agentsResponse.body.data.find((entry: { id: string }) => entry.id === agent.id);
    expect(updated.monthlyBudgetUsd).toBe(15);
  });

  it("resolves pause_agent and terminate_agent approvals with status changes", async () => {
    const agent = await createAgent(db, {
      companyId,
      role: "Engineer",
      name: "Lifecycle Worker",
      providerType: "shell",
      heartbeatCron: "*/5 * * * *",
      monthlyBudgetUsd: "10.0000",
      runtimeCommand: "echo",
      runtimeArgsJson: JSON.stringify(['{"summary":"noop","tokenInput":0,"tokenOutput":0,"usdCost":0}']),
      runtimeCwd: tempDir
    });

    const pauseApprovalId = await createApprovalRequest(db, {
      companyId,
      action: "pause_agent",
      payload: { agentId: agent.id, reason: "Temporary hold." }
    });
    const pauseResponse = await request(app).post("/governance/resolve").set("x-company-id", companyId).send({
      approvalId: pauseApprovalId,
      status: "approved"
    });
    expect(pauseResponse.status).toBe(200);
    expect(pauseResponse.body.data.execution.applied).toBe(true);

    const terminateApprovalId = await createApprovalRequest(db, {
      companyId,
      action: "terminate_agent",
      payload: { agentId: agent.id, reason: "Role sunset." }
    });
    const terminateResponse = await request(app).post("/governance/resolve").set("x-company-id", companyId).send({
      approvalId: terminateApprovalId,
      status: "approved"
    });
    expect(terminateResponse.status).toBe(200);
    expect(terminateResponse.body.data.execution.applied).toBe(true);

    const agentsResponse = await request(app).get("/agents").set("x-company-id", companyId);
    const updated = agentsResponse.body.data.find((entry: { id: string }) => entry.id === agent.id);
    expect(updated.status).toBe("terminated");
  });

  it("auto-creates a single pending budget override approval on hard-stop", async () => {
    const project = await createProject(db, { companyId, name: "Budget Hard Stop Project" });
    const agent = await createAgent(db, {
      companyId,
      role: "Engineer",
      name: "Hard Stop Worker",
      providerType: "shell",
      heartbeatCron: "*/5 * * * *",
      monthlyBudgetUsd: "1.0000",
      runtimeCommand: "echo",
      runtimeArgsJson: JSON.stringify(['{"summary":"noop","tokenInput":0,"tokenOutput":0,"usdCost":0}']),
      runtimeCwd: tempDir
    });
    await createIssue(db, {
      companyId,
      projectId: project.id,
      title: "Blocked by budget",
      assigneeAgentId: agent.id,
      status: "todo"
    });
    await db
      .execute(`UPDATE agents SET used_budget_usd = '1.0000' WHERE company_id = '${companyId}' AND id = '${agent.id}'`);

    const firstRunId = await runHeartbeatForAgent(db, companyId, agent.id);
    expect(firstRunId).toBeTruthy();
    const secondRunId = await runHeartbeatForAgent(db, companyId, agent.id);
    expect(secondRunId).toBeTruthy();

    const approvals = await listApprovalRequests(db, companyId);
    const overrideApprovals = approvals.filter((approval) => approval.action === "override_budget");
    expect(overrideApprovals).toHaveLength(1);
    expect(overrideApprovals[0]?.status).toBe("pending");
    const payload = JSON.parse(String(overrideApprovals[0]?.payloadJson ?? "{}")) as Record<string, unknown>;
    expect(payload.agentId).toBe(agent.id);
  });

  it("codifies budget scope as agent-level in table models", async () => {
    const projectColumns = Object.keys(projects);
    const issueColumns = Object.keys(issues);
    const agentColumns = Object.keys(agents);

    expect(projectColumns.includes("monthlyBudgetUsd")).toBe(true);
    expect(projectColumns.includes("usedBudgetUsd")).toBe(true);
    expect(projectColumns.includes("budgetWindowStartAt")).toBe(true);
    expect(issueColumns.includes("monthlyBudgetUsd")).toBe(false);
    expect(issueColumns.includes("usedBudgetUsd")).toBe(false);
    expect(agentColumns.includes("monthlyBudgetUsd")).toBe(true);
    expect(agentColumns.includes("usedBudgetUsd")).toBe(true);
  });

  it("hard-stops project work, creates deduped project override approval, and unblocks after approval", async () => {
    const project = await createProject(db, {
      companyId,
      name: "Project Budget Block",
      monthlyBudgetUsd: "1.0000"
    });
    const agent = await createAgent(db, {
      companyId,
      role: "Engineer",
      name: "Project Block Worker",
      providerType: "shell",
      heartbeatCron: "*/5 * * * *",
      monthlyBudgetUsd: "100.0000",
      runtimeCommand: "echo",
      runtimeArgsJson: JSON.stringify(['{"summary":"work","tokenInput":10,"tokenOutput":5,"usdCost":0.500000}']),
      runtimeCwd: tempDir
    });
    await createIssue(db, {
      companyId,
      projectId: project!.id,
      title: "Blocked on project budget",
      assigneeAgentId: agent.id,
      status: "todo"
    });
    await db.execute(
      `UPDATE projects SET used_budget_usd = '1.0000' WHERE company_id = '${companyId}' AND id = '${project!.id}'`
    );

    const runId = await runHeartbeatForAgent(db, companyId, agent.id);
    expect(runId).toBeTruthy();
    await runHeartbeatForAgent(db, companyId, agent.id);

    const approvals = await listApprovalRequests(db, companyId);
    const projectOverrideApprovals = approvals.filter((approval) => {
      if (approval.action !== "override_budget") {
        return false;
      }
      try {
        const payload = JSON.parse(String(approval.payloadJson ?? "{}")) as Record<string, unknown>;
        return payload.projectId === project!.id;
      } catch {
        return false;
      }
    });
    expect(projectOverrideApprovals).toHaveLength(1);
    expect(projectOverrideApprovals[0]?.status).toBe("pending");
    const approvalId = projectOverrideApprovals[0]!.id;

    const blockedManualRun = await request(app).post("/heartbeats/run-agent").set("x-company-id", companyId).send({ agentId: agent.id });
    expect(blockedManualRun.status).toBe(423);

    const approveResponse = await request(app).post("/governance/resolve").set("x-company-id", companyId).send({
      approvalId,
      status: "approved"
    });
    expect(approveResponse.status).toBe(200);
    expect(approveResponse.body.data.execution.applied).toBe(true);

    const unblockedManualRun = await request(app).post("/heartbeats/run-agent").set("x-company-id", companyId).send({ agentId: agent.id });
    expect(unblockedManualRun.status).toBe(200);
    expect(unblockedManualRun.body.data.status).toBe("queued");
  });

  it("resets project monthly usage on new window and then accrues fresh spend", async () => {
    const project = await createProject(db, {
      companyId,
      name: "Monthly Reset Project",
      workspaceLocalPath: tempDir,
      monthlyBudgetUsd: "2.0000",
      usedBudgetUsd: "2.0000",
      budgetWindowStartAt: new Date(Date.UTC(2023, 0, 1))
    });
    const agent = await createAgent(db, {
      companyId,
      role: "Engineer",
      name: "Monthly Reset Worker",
      providerType: "shell",
      heartbeatCron: "*/5 * * * *",
      monthlyBudgetUsd: "50.0000",
      runtimeCommand: "echo",
      runtimeArgsJson: JSON.stringify(['{"summary":"window reset work","tokenInput":20,"tokenOutput":20,"usdCost":0.250000}']),
      runtimeCwd: tempDir
    });
    await createIssue(db, {
      companyId,
      projectId: project!.id,
      title: "Monthly reset issue",
      assigneeAgentId: agent.id,
      status: "todo"
    });

    const runId = await runHeartbeatForAgent(db, companyId, agent.id);
    expect(runId).toBeTruthy();
    const approvals = await listApprovalRequests(db, companyId);
    const projectOverrideApprovals = approvals.filter((approval) => {
      if (approval.action !== "override_budget") {
        return false;
      }
      try {
        const payload = JSON.parse(String(approval.payloadJson ?? "{}")) as Record<string, unknown>;
        return payload.projectId === project!.id;
      } catch {
        return false;
      }
    });
    expect(projectOverrideApprovals).toHaveLength(0);

    const projectsResponse = await request(app).get("/projects").set("x-company-id", companyId);
    expect(projectsResponse.status).toBe(200);
    const updatedProject = projectsResponse.body.data.find((entry: { id: string }) => entry.id === project!.id);
    expect(updatedProject.monthlyBudgetUsd).toBe(2);
    const windowStart = new Date(updatedProject.budgetWindowStartAt);
    const now = new Date();
    expect(windowStart.getUTCFullYear()).toBe(now.getUTCFullYear());
    expect(windowStart.getUTCMonth()).toBe(now.getUTCMonth());
  });

  it("cancels queued jobs for project budget blocked runs instead of retry/dead-letter churn", async () => {
    const project = await createProject(db, {
      companyId,
      name: "Queue Block Project",
      monthlyBudgetUsd: "1.0000"
    });
    const agent = await createAgent(db, {
      companyId,
      role: "Engineer",
      name: "Queue Block Worker",
      providerType: "shell",
      heartbeatCron: "*/5 * * * *",
      monthlyBudgetUsd: "100.0000",
      runtimeCommand: "echo",
      runtimeArgsJson: JSON.stringify(['{"summary":"work","tokenInput":1,"tokenOutput":1,"usdCost":0.100000}']),
      runtimeCwd: tempDir
    });
    await createIssue(db, {
      companyId,
      projectId: project!.id,
      title: "Queue blocked issue",
      assigneeAgentId: agent.id,
      status: "todo"
    });
    await db.execute(
      `UPDATE projects SET used_budget_usd = '1.0000' WHERE company_id = '${companyId}' AND id = '${project!.id}'`
    );

    const job = await enqueueHeartbeatQueueJob(db, {
      companyId,
      agentId: agent.id,
      jobType: "manual",
      payload: {}
    });
    const sweep = await runHeartbeatQueueSweep(db, companyId, { maxJobsPerSweep: 1 });
    expect(sweep.processed).toBe(1);

    const queueItems = await listHeartbeatQueueJobs(db, {
      companyId,
      agentId: agent.id,
      limit: 10
    });
    const updatedJob = queueItems.find((entry) => entry.id === job.id);
    expect(updatedJob?.status).toBe("canceled");
  });
});
