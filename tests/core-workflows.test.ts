import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../apps/api/src/app";
import { claimIssuesForAgent, runHeartbeatForAgent, runHeartbeatSweep } from "../apps/api/src/services/heartbeat-service";
import { enqueueHeartbeatQueueJob, runHeartbeatQueueSweep } from "../apps/api/src/services/heartbeat-queue-service";
import { runIssueCommentDispatchSweep } from "../apps/api/src/services/comment-recipient-dispatch-service";
import type { BopoDb } from "../packages/db/src/client";
import {
  addIssueAttachment,
  agents,
  bootstrapDatabase,
  createAgent,
  createApprovalRequest,
  createCompany,
  createIssue,
  createProject,
  heartbeatRuns,
  listIssueAttachments,
  listHeartbeatQueueJobs,
  listIssueComments,
  listCostEntries,
  listHeartbeatRuns,
  listIssues
} from "../packages/db/src/index";

describe("BopoDev core workflows", () => {
  let db: BopoDb;
  let app: ReturnType<typeof createApp>;
  let tempDir: string;
  let companyId: string;
  let client: { close?: () => Promise<void> };

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "bopodev-test-"));
    const boot = await bootstrapDatabase(join(tempDir, "test.db"));
    db = boot.db;
    client = boot.client as { close?: () => Promise<void> };
    app = createApp({ db });
    const company = await createCompany(db, { name: "Acme AI", mission: "Ship a stable autonomous company." });
    companyId = company.id;
  });

  afterEach(async () => {
    await client.close?.();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("applies approved hire requests and exposes parsed approval payloads", async () => {
    const approvalId = await createApprovalRequest(db, {
      companyId,
      action: "hire_agent",
      payload: {
        name: "CTO Claude",
        role: "CTO",
        providerType: "claude_code",
        heartbeatCron: "*/5 * * * *",
        monthlyBudgetUsd: 50,
        canHireAgents: true,
        runtimeCommand: "claude",
        runtimeArgs: ["--print"],
        runtimeCwd: "/tmp/work"
      }
    });

    const resolveResponse = await request(app)
      .post("/governance/resolve")
      .set("x-company-id", companyId)
      .send({ approvalId, status: "approved" });

    expect(resolveResponse.status).toBe(200);
    expect(resolveResponse.body.data.execution.applied).toBe(true);
    expect(resolveResponse.body.data.execution.entityType).toBe("agent");
    const resolveRetryResponse = await request(app)
      .post("/governance/resolve")
      .set("x-company-id", companyId)
      .send({ approvalId, status: "approved" });
    expect(resolveRetryResponse.status).toBe(200);
    expect(resolveRetryResponse.body.data.execution.applied).toBe(false);

    const agentsResponse = await request(app).get("/agents").set("x-company-id", companyId);
    expect(agentsResponse.status).toBe(200);
    expect(agentsResponse.body.ok).toBe(true);
    expect(Array.isArray(agentsResponse.body.data)).toBe(true);
    expect(
      (agentsResponse.body.data as unknown[]).every((entry) => entry !== null && typeof entry === "object" && !Array.isArray(entry))
    ).toBe(true);
    expect(agentsResponse.body.data).toHaveLength(1);
    expect(agentsResponse.body.data[0].name).toBe("CTO Claude");

    const approvalsResponse = await request(app).get("/governance/approvals").set("x-company-id", companyId);
    expect(approvalsResponse.status).toBe(200);
    expect(approvalsResponse.body.data[0].payload).toMatchObject({
      name: "CTO Claude",
      providerType: "claude_code"
    });

    const startupIssues = await listIssues(db, companyId);
    expect(startupIssues.length).toBeGreaterThan(0);
    const startupForHiredAgent = startupIssues.find((issue) => issue.assigneeAgentId === agentsResponse.body.data[0].id);
    expect(startupForHiredAgent?.title).toContain("operating files");
    expect(startupForHiredAgent?.body ?? "").toContain("HEARTBEAT.md");
    expect(startupForHiredAgent?.body ?? "").toContain("SOUL.md");
    expect(startupForHiredAgent?.body ?? "").toContain("TOOLS.md");

    const logsResponse = await request(app).get("/observability/logs").set("x-company-id", companyId);
    expect(logsResponse.status).toBe(200);
    expect(logsResponse.body.data.some((event: { payload?: Record<string, unknown> }) => typeof event.payload === "object")).toBe(
      true
    );
  });

  it("prevents duplicate hire approvals for same manager and role", async () => {
    const manager = await createAgent(db, {
      companyId,
      role: "CEO",
      name: "Manager",
      providerType: "shell",
      heartbeatCron: "*/5 * * * *",
      monthlyBudgetUsd: "100.0000",
      canHireAgents: true,
      initialState: {
        runtime: {
          command: "echo",
          cwd: tempDir,
          args: ['{"summary":"manager","tokenInput":0,"tokenOutput":0,"usdCost":0}']
        }
      }
    });

    const first = await request(app).post("/agents").set("x-company-id", companyId).send({
      managerAgentId: manager.id,
      role: "Engineer",
      name: "Founding Engineer",
      providerType: "opencode",
      heartbeatCron: "*/5 * * * *",
      monthlyBudgetUsd: 40,
      canHireAgents: false,
      requestApproval: true,
      runtimeCwd: tempDir
    });
    expect(first.status).toBe(200);
    expect(first.body.data.queuedForApproval).toBe(true);
    const firstApprovalId = first.body.data.approvalId as string;

    const second = await request(app).post("/agents").set("x-company-id", companyId).send({
      managerAgentId: manager.id,
      role: "Engineer",
      name: "Founding Engineer Duplicate",
      providerType: "opencode",
      heartbeatCron: "*/5 * * * *",
      monthlyBudgetUsd: 40,
      canHireAgents: false,
      requestApproval: true,
      runtimeCwd: tempDir
    });
    expect(second.status).toBe(200);
    expect(second.body.data.queuedForApproval).toBe(false);
    expect(second.body.data.duplicate).toBe(true);
    expect(second.body.data.pendingApprovalId).toBe(firstApprovalId);
  });

  it("returns actionable codex runtime preflight results", async () => {
    const runtimeCwd = tempDir;
    const passResponse = await request(app)
      .post("/agents/runtime-preflight")
      .set("x-company-id", companyId)
      .send({
        providerType: "codex",
        runtimeConfig: {
          runtimeCommand: process.execPath,
          runtimeArgs: [
            "-e",
            "console.log('{\"summary\":\"hello\",\"tokenInput\":1,\"tokenOutput\":1,\"usdCost\":0.000001}')"
          ],
          runtimeCwd
        }
      });
    expect(passResponse.status).toBe(200);
    expect(passResponse.body.data.status).toBe("pass");

    const authWarnResponse = await request(app)
      .post("/agents/runtime-preflight")
      .set("x-company-id", companyId)
      .send({
        providerType: "codex",
        runtimeConfig: {
          runtimeCommand: process.execPath,
          runtimeArgs: ["-e", "process.stderr.write('401 Unauthorized: Missing bearer or basic authentication in header'); process.exit(1);"],
          runtimeCwd
        }
      });
    expect(authWarnResponse.status).toBe(200);
    expect(["warn", "pass"]).toContain(authWarnResponse.body.data.status);
    if (authWarnResponse.body.data.status === "warn") {
      expect(
        (authWarnResponse.body.data.checks as Array<{ code: string }>).some((check) => check.code === "codex_auth_required")
      ).toBe(true);
    }
  });

  it("returns direct API runtime preflight errors when keys are missing", async () => {
    const openaiResponse = await request(app)
      .post("/agents/runtime-preflight")
      .set("x-company-id", companyId)
      .send({
        providerType: "openai_api",
        runtimeConfig: {
          runtimeEnv: {}
        }
      });
    expect(openaiResponse.status).toBe(200);
    expect(openaiResponse.body.data.status).toBe("fail");
    expect(
      (openaiResponse.body.data.checks as Array<{ code: string }>).some((check) => check.code === "api_key_missing")
    ).toBe(true);

    const anthropicResponse = await request(app)
      .post("/agents/runtime-preflight")
      .set("x-company-id", companyId)
      .send({
        providerType: "anthropic_api",
        runtimeConfig: {
          runtimeEnv: {}
        }
      });
    expect(anthropicResponse.status).toBe(200);
    expect(anthropicResponse.body.data.status).toBe("fail");
    expect(
      (anthropicResponse.body.data.checks as Array<{ code: string }>).some((check) => check.code === "api_key_missing")
    ).toBe(true);
  });

  it("returns explicit errors for unsupported agent update fields", async () => {
    const createResponse = await request(app).post("/agents").set("x-company-id", companyId).send({
      role: "CEO",
      name: "Schema Test CEO",
      providerType: "shell",
      heartbeatCron: "*/5 * * * *",
      monthlyBudgetUsd: 10,
      canHireAgents: true,
      requestApproval: false,
      runtimeCommand: "echo",
      runtimeCwd: tempDir,
      runtimeArgs: ['{"summary":"schema-test","tokenInput":0,"tokenOutput":0,"usdCost":0}']
    });
    expect(createResponse.status).toBe(200);
    const agentId = createResponse.body.data.id as string;

    const updateResponse = await request(app).put(`/agents/${agentId}`).set("x-company-id", companyId).send({
      instructionFilePath: "agents/ceo/AGENTS.md"
    });
    expect(updateResponse.status).toBe(422);
    expect(String(updateResponse.body.error ?? "")).toContain("Unsupported agent update fields");
    expect(String(updateResponse.body.error ?? "")).toContain("instructionFilePath");
  });

  it("supports comment create, update, and delete flows on issues", async () => {
    const project = await createProject(db, { companyId, name: "Core Platform", description: "Main backlog." });
    const issue = await createIssue(db, { companyId, projectId: project.id, title: "Wire comments", body: "Need full thread CRUD." });

    const createResponse = await request(app)
      .post(`/issues/${issue.id}/comments`)
      .set("x-company-id", companyId)
      .send({
        body: "Initial context",
        authorType: "human",
        recipients: [{ recipientType: "board" }]
      });

    expect(createResponse.status).toBe(200);
    expect(createResponse.body.data.body).toBe("Initial context");
    expect(createResponse.body.data.runId ?? null).toBeNull();
    expect(createResponse.body.data.recipients).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          recipientType: "board",
          recipientId: null
        })
      ])
    );

    const createdCommentId = createResponse.body.data.id as string;

    const updateResponse = await request(app)
      .put(`/issues/${issue.id}/comments/${createdCommentId}`)
      .set("x-company-id", companyId)
      .send({ body: "Updated context" });

    expect(updateResponse.status).toBe(200);
    expect(updateResponse.body.data.body).toBe("Updated context");

    const listResponse = await request(app).get(`/issues/${issue.id}/comments`).set("x-company-id", companyId);
    expect(listResponse.status).toBe(200);
    expect(listResponse.body.data).toHaveLength(1);
    expect(listResponse.body.data[0].body).toBe("Updated context");

    const deleteResponse = await request(app).delete(`/issues/${issue.id}/comments/${createdCommentId}`).set("x-company-id", companyId);
    expect(deleteResponse.status).toBe(200);

    const afterDeleteResponse = await request(app).get(`/issues/${issue.id}/comments`).set("x-company-id", companyId);
    expect(afterDeleteResponse.body.data).toHaveLength(0);
  });

  it("dispatches comment orders to recipient runs without reprocessing unrelated assigned issues", async () => {
    const project = await createProject(db, { companyId, name: "Comment Dispatch", description: "Recipient dispatch checks." });
    const authorAgent = await createAgent(db, {
      companyId,
      role: "CTO",
      name: "Author Agent",
      providerType: "shell",
      heartbeatCron: "*/5 * * * *",
      monthlyBudgetUsd: "20.0000",
      initialState: {
        runtime: {
          command: "echo",
          args: ['{"summary":"author","tokenInput":0,"tokenOutput":0,"usdCost":0}']
        }
      }
    });
    const recipientAgent = await createAgent(db, {
      companyId,
      role: "Engineer",
      name: "Recipient Agent",
      providerType: "shell",
      heartbeatCron: "*/5 * * * *",
      monthlyBudgetUsd: "20.0000",
      initialState: {
        runtime: {
          command: process.execPath,
          args: [
            "-e",
            [
              "const prompt = process.argv.slice(1).join(' ');",
              "const hasCommentOrder = prompt.includes('Comment-order directives:');",
              "const hasTriggerComment = prompt.includes('Please fix only the login redirect flow.');",
              "const hasTargetIssue = prompt.includes('Target issue context');",
              "const hasBacklogIssue = prompt.includes('Unrelated backlog issue');",
              "console.log(JSON.stringify({",
              "  summary: `order=${hasCommentOrder};comment=${hasTriggerComment};target=${hasTargetIssue};backlog=${hasBacklogIssue}`,",
              "  tokenInput: 1,",
              "  tokenOutput: 1,",
              "  usdCost: 0.000001",
              "}));"
            ].join("\n")
          ]
        }
      }
    });
    const issue = await createIssue(db, {
      companyId,
      projectId: project.id,
      title: "Target issue context",
      assigneeAgentId: recipientAgent.id
    });
    await createIssue(db, {
      companyId,
      projectId: project.id,
      title: "Unrelated backlog issue",
      assigneeAgentId: recipientAgent.id
    });
    const seededRunId = "commentseedrun1";
    await db.insert(heartbeatRuns).values({
      id: seededRunId,
      companyId,
      agentId: authorAgent.id,
      status: "started",
      message: "seeded run",
      startedAt: new Date()
    });

    const createResponse = await request(app)
      .post(`/issues/${issue.id}/comments`)
      .set("x-company-id", companyId)
      .set("x-actor-type", "agent")
      .set("x-actor-id", authorAgent.id)
      .set("x-actor-companies", companyId)
      .set("x-actor-permissions", "issues:write,heartbeats:run")
      .send({
        body: "Please fix only the login redirect flow.",
        recipients: [{ recipientType: "agent", recipientId: recipientAgent.id }]
      });

    expect(createResponse.status).toBe(200);
    expect(createResponse.body.data.runId).toBe(seededRunId);
    const pendingRecipient = (createResponse.body.data.recipients as Array<Record<string, unknown>>)[0];
    expect(pendingRecipient).toMatchObject({
      recipientType: "agent",
      recipientId: recipientAgent.id,
      deliveryStatus: "pending"
    });
    let recipientRuns = (await listHeartbeatRuns(db, companyId)).filter((run) => run.agentId === recipientAgent.id);
    if (recipientRuns.length === 0) {
      await runIssueCommentDispatchSweep(db, companyId, { requestId: "comment-order-test", limit: 10 });
      recipientRuns = (await listHeartbeatRuns(db, companyId)).filter((run) => run.agentId === recipientAgent.id);
    }
    for (let attempt = 0; attempt < 10 && recipientRuns.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      recipientRuns = (await listHeartbeatRuns(db, companyId)).filter((run) => run.agentId === recipientAgent.id);
    }
    expect(recipientRuns.length).toBeGreaterThan(0);
    let latestRecipientRun = recipientRuns.sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())[0];
    for (let attempt = 0; attempt < 20 && latestRecipientRun?.status === "started"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      recipientRuns = (await listHeartbeatRuns(db, companyId)).filter((run) => run.agentId === recipientAgent.id);
      latestRecipientRun = recipientRuns.sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())[0];
    }
    expect(latestRecipientRun?.message).toContain("order=true");
    expect(latestRecipientRun?.message).toContain("comment=true");
    expect(latestRecipientRun?.message).toContain("target=true");
    expect(latestRecipientRun?.message).toContain("backlog=false");
    const issueComments = await listIssueComments(db, companyId, issue.id);
    const runSummaryComment = issueComments.find(
      (comment) =>
        comment.runId === latestRecipientRun?.id && comment.authorType === "agent" && comment.authorId === recipientAgent.id
    );
    expect((runSummaryComment?.body ?? "").length).toBeGreaterThan(0);
    expect(runSummaryComment?.body).not.toContain("{\"summary\"");
  });

  it("keeps comment recipient pending while agent is busy and retries once free", async () => {
    const project = await createProject(db, {
      companyId,
      name: "Busy recipient retry",
      description: "Do not drop comment orders when recipient is occupied."
    });
    const recipientAgent = await createAgent(db, {
      companyId,
      role: "Engineer",
      name: "Busy Recipient",
      providerType: "shell",
      heartbeatCron: "*/5 * * * *",
      monthlyBudgetUsd: "20.0000",
      initialState: {
        runtime: {
          command: "echo",
          args: ['{"summary":"recipient-executed","tokenInput":1,"tokenOutput":1,"usdCost":0.000001}']
        }
      }
    });
    const issue = await createIssue(db, {
      companyId,
      projectId: project.id,
      title: "Queue while busy",
      assigneeAgentId: recipientAgent.id
    });
    const busyRunId = "busycommentrun1";
    await db.insert(heartbeatRuns).values({
      id: busyRunId,
      companyId,
      agentId: recipientAgent.id,
      status: "started",
      message: "simulated busy run",
      startedAt: new Date()
    });

    const createResponse = await request(app)
      .post(`/issues/${issue.id}/comments`)
      .set("x-company-id", companyId)
      .send({
        body: "Run this once you are free.",
        authorType: "human",
        recipients: [{ recipientType: "agent", recipientId: recipientAgent.id }]
      });
    expect(createResponse.status).toBe(200);
    const orderCommentId = createResponse.body.data.id as string;

    await runIssueCommentDispatchSweep(db, companyId, { requestId: "busy-dispatch-1", limit: 20 });
    let comments = await listIssueComments(db, companyId, issue.id);
    const firstComment = comments.find((comment) => comment.id === orderCommentId);
    const firstRecipient = firstComment?.recipients?.[0];
    expect(firstRecipient?.deliveryStatus).toBe("pending");
    expect(firstRecipient?.dispatchedRunId ?? null).toBeNull();

    const releaseBusyRun = await request(app).post(`/heartbeats/${busyRunId}/stop`).set("x-company-id", companyId).send({});
    expect(releaseBusyRun.status).toBe(200);

    await runIssueCommentDispatchSweep(db, companyId, { requestId: "busy-dispatch-2", limit: 20 });
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await runHeartbeatQueueSweep(db, companyId, { maxJobsPerSweep: 20 });
      comments = await listIssueComments(db, companyId, issue.id);
      const secondComment = comments.find((comment) => comment.id === orderCommentId);
      const secondRecipient = secondComment?.recipients?.[0];
      if (secondRecipient?.deliveryStatus === "dispatched" && secondRecipient.dispatchedRunId) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    comments = await listIssueComments(db, companyId, issue.id);
    const secondComment = comments.find((comment) => comment.id === orderCommentId);
    const secondRecipient = secondComment?.recipients?.[0];
    expect(secondRecipient?.deliveryStatus).toBe("dispatched");
    expect(typeof secondRecipient?.dispatchedRunId).toBe("string");
    expect((secondRecipient?.dispatchedRunId ?? "").length).toBeGreaterThan(0);
  });

  it("supports uploading, listing, downloading, and deleting issue attachments", async () => {
    const project = await createProject(db, {
      companyId,
      name: "Attachment Project",
      workspaceLocalPath: tempDir
    });
    const issue = await createIssue(db, {
      companyId,
      projectId: project.id,
      title: "Attach files to issue"
    });

    const uploadResponse = await request(app)
      .post(`/issues/${issue.id}/attachments`)
      .set("x-company-id", companyId)
      .attach("files", Buffer.from("hello attachment"), { filename: "notes.txt", contentType: "text/plain" })
      .attach("files", Buffer.from("tiny image"), { filename: "image.png", contentType: "image/png" });

    expect(uploadResponse.status).toBe(200);
    expect(uploadResponse.body.data).toHaveLength(2);

    const listResponse = await request(app).get(`/issues/${issue.id}/attachments`).set("x-company-id", companyId);
    expect(listResponse.status).toBe(200);
    expect(listResponse.body.data).toHaveLength(2);
    const notesAttachment = (listResponse.body.data as Array<{ id: string; fileName: string }>).find(
      (attachment) => attachment.fileName === "notes.txt"
    );
    expect(notesAttachment).toBeDefined();

    const downloadResponse = await request(app)
      .get(`/issues/${issue.id}/attachments/${notesAttachment!.id}/download`)
      .set("x-company-id", companyId);
    expect(downloadResponse.status).toBe(200);
    expect(downloadResponse.text).toBe("hello attachment");

    const dbAttachments = await listIssueAttachments(db, companyId, issue.id);
    expect(dbAttachments).toHaveLength(2);
    const notesPath = dbAttachments.find((entry) => entry.fileName === "notes.txt")?.relativePath;
    expect(typeof notesPath).toBe("string");
    const savedBody = await readFile(join(tempDir, notesPath!), "utf8");
    expect(savedBody).toBe("hello attachment");

    const deleteResponse = await request(app)
      .delete(`/issues/${issue.id}/attachments/${notesAttachment!.id}`)
      .set("x-company-id", companyId);
    expect(deleteResponse.status).toBe(200);

    const afterDeleteListResponse = await request(app).get(`/issues/${issue.id}/attachments`).set("x-company-id", companyId);
    expect(afterDeleteListResponse.status).toBe(200);
    expect(afterDeleteListResponse.body.data).toHaveLength(1);
  });

  it("sanitizes attachment filenames and blocks unsupported attachment types", async () => {
    const project = await createProject(db, {
      companyId,
      name: "Attachment Safety",
      workspaceLocalPath: tempDir
    });
    const issue = await createIssue(db, {
      companyId,
      projectId: project.id,
      title: "Attachment safety checks"
    });

    const traversalUpload = await request(app)
      .post(`/issues/${issue.id}/attachments`)
      .set("x-company-id", companyId)
      .attach("files", Buffer.from("safe data"), {
        filename: "../../../etc/passwd.txt",
        contentType: "text/plain"
      });
    expect(traversalUpload.status).toBe(200);

    const [savedAttachment] = await listIssueAttachments(db, companyId, issue.id);
    expect(savedAttachment).toBeDefined();
    expect(savedAttachment.relativePath.includes("..")).toBe(false);
    expect(join(tempDir, savedAttachment.relativePath).startsWith(tempDir)).toBe(true);

    const unsupportedUpload = await request(app)
      .post(`/issues/${issue.id}/attachments`)
      .set("x-company-id", companyId)
      .attach("files", Buffer.from("#!/bin/bash\necho nope"), {
        filename: "run.sh",
        contentType: "application/x-sh"
      });
    expect(unsupportedUpload.status).toBe(422);
    expect(String(unsupportedUpload.body.error ?? "")).toContain("Unsupported attachment type");
  });

  it("includes issue attachment paths in heartbeat prompt context", async () => {
    const project = await createProject(db, {
      companyId,
      name: "Attachment Prompt Context",
      workspaceLocalPath: tempDir
    });
    const agent = await createAgent(db, {
      companyId,
      role: "Engineer",
      name: "Attachment Aware",
      providerType: "shell",
      heartbeatCron: "*/5 * * * *",
      monthlyBudgetUsd: "10.0000",
      initialState: {
        runtime: {
          command: process.execPath,
          cwd: tempDir,
          args: [
            "-e",
            [
              "const prompt = process.argv.slice(1).join(' ');",
              "const hasAttachments = /Attachments:/.test(prompt);",
              "const hasNotes = /notes\\.txt/.test(prompt);",
              "const hasAttachmentPath = /\\.bopo[\\\\/]+issues/.test(prompt);",
              "console.log(JSON.stringify({ summary: `attach=${hasAttachments};notes=${hasNotes};path=${hasAttachmentPath}`, tokenInput: 1, tokenOutput: 1, usdCost: 0.000001 }));"
            ].join("\n")
          ]
        }
      }
    });
    const issue = await createIssue(db, {
      companyId,
      projectId: project.id,
      title: "Follow attachment references",
      body: "Please read notes.txt in attachments and proceed.",
      assigneeAgentId: agent.id
    });
    await addIssueAttachment(db, {
      companyId,
      issueId: issue.id,
      projectId: project.id,
      fileName: "notes.txt",
      mimeType: "text/plain",
      fileSizeBytes: 12,
      relativePath: `.bopo/issues/${issue.id}/attachments/test-notes.txt`,
      uploadedByActorType: "human"
    });

    const runId = await runHeartbeatForAgent(db, companyId, agent.id);
    expect(runId).toBeTruthy();
    const heartbeatRows = await listHeartbeatRuns(db, companyId);
    const latest = heartbeatRows.find((row) => row.id === runId);
    expect(latest?.status).toBe("completed");
    expect(latest?.message).toContain("attach=true;notes=true;path=true");
  });

  it("infers agent comment author from request actor headers", async () => {
    const project = await createProject(db, { companyId, name: "Author Inference", description: "Infer comment author type." });
    const agent = await createAgent(db, {
      companyId,
      role: "Engineer",
      name: "Comment Agent",
      providerType: "shell",
      heartbeatCron: "*/5 * * * *",
      monthlyBudgetUsd: "10.0000",
      initialState: {
        runtime: {
          command: "echo",
          args: ['{"summary":"noop","tokenInput":0,"tokenOutput":0,"usdCost":0}']
        }
      }
    });
    const issue = await createIssue(db, { companyId, projectId: project.id, title: "Agent authored comment" });

    const response = await request(app)
      .post(`/issues/${issue.id}/comments`)
      .set("x-company-id", companyId)
      .set("x-actor-type", "agent")
      .set("x-actor-id", agent.id)
      .set("x-actor-companies", companyId)
      .set("x-actor-permissions", "issues:write")
      .send({ body: "Agent progress update." });

    expect(response.status).toBe(200);
    expect(response.body.data.authorType).toBe("agent");
    expect(response.body.data.authorId).toBe(agent.id);
  });

  it("returns 400 for malformed request actor headers", async () => {
    const project = await createProject(db, { companyId, name: "Malformed Actor Headers", description: "Header validation." });
    const issue = await createIssue(db, { companyId, projectId: project.id, title: "Reject malformed actor headers" });

    const response = await request(app)
      .post(`/issues/${issue.id}/comments`)
      .set("x-company-id", companyId)
      .set("x-actor-type", "invalid_actor")
      .send({ body: "This should fail." });

    expect(response.status).toBe(400);
    expect(String(response.body.error ?? "")).toContain("Invalid actor headers");
  });

  it("runs end-to-end workflow from CEO intake to approved hire, comments, and worker execution", async () => {
    const project = await createProject(db, {
      companyId,
      name: "CEO Workflow",
      description: "End-to-end orchestration.",
      workspaceLocalPath: tempDir
    });

    const createCeoResponse = await request(app).post("/agents").set("x-company-id", companyId).send({
      role: "CEO",
      name: "Workflow CEO",
      providerType: "shell",
      heartbeatCron: "*/5 * * * *",
      monthlyBudgetUsd: 100,
      canHireAgents: true,
      requestApproval: false,
      runtimeCommand: "echo",
      runtimeCwd: tempDir,
      runtimeArgs: ['{"summary":"ceo heartbeat","tokenInput":0,"tokenOutput":0,"usdCost":0}']
    });
    expect(createCeoResponse.status).toBe(200);
    const ceoId = createCeoResponse.body.data.id as string;

    const createIssueResponse = await request(app).post("/issues").set("x-company-id", companyId).send({
      projectId: project.id,
      title: "Ship customer-facing trace improvements",
      body: "Top-level task should flow from CEO to hired worker.",
      priority: "high",
      assigneeAgentId: ceoId
    });
    expect(createIssueResponse.status).toBe(200);
    const issueId = createIssueResponse.body.data.id as string;

    const ceoIntakeComment = await request(app)
      .post(`/issues/${issueId}/comments`)
      .set("x-company-id", companyId)
      .send({
        body: "CEO intake: approved scope and preparing to hire execution support.",
        authorType: "agent",
        authorId: ceoId
      });
    expect(ceoIntakeComment.status).toBe(200);

    const hireRequestResponse = await request(app).post("/agents").set("x-company-id", companyId).send({
      managerAgentId: ceoId,
      role: "Engineer",
      name: "Execution Worker",
      providerType: "shell",
      heartbeatCron: "*/5 * * * *",
      monthlyBudgetUsd: 40,
      canHireAgents: false,
      requestApproval: true,
      runtimeCommand: "echo",
      runtimeCwd: tempDir,
      runtimeArgs: ['{"summary":"implemented task","tokenInput":8,"tokenOutput":5,"usdCost":0.05}']
    });
    expect(hireRequestResponse.status).toBe(200);
    expect(hireRequestResponse.body.data.queuedForApproval).toBe(true);
    const approvalId = hireRequestResponse.body.data.approvalId as string;

    const resolveResponse = await request(app).post("/governance/resolve").set("x-company-id", companyId).send({
      approvalId,
      status: "approved"
    });
    expect(resolveResponse.status).toBe(200);
    expect(resolveResponse.body.data.execution.applied).toBe(true);
    expect(resolveResponse.body.data.execution.entityType).toBe("agent");
    const workerId = resolveResponse.body.data.execution.entityId as string;

    const agentsResponse = await request(app).get("/agents").set("x-company-id", companyId);
    expect(agentsResponse.status).toBe(200);
    const hiredWorker = (agentsResponse.body.data as Array<{ id: string; managerAgentId?: string | null }>).find(
      (agent) => agent.id === workerId
    );
    expect(hiredWorker).toBeDefined();
    expect(hiredWorker?.managerAgentId ?? null).toBe(ceoId);

    const handoffResponse = await request(app).put(`/issues/${issueId}`).set("x-company-id", companyId).send({
      assigneeAgentId: workerId,
      status: "in_progress"
    });
    expect(handoffResponse.status).toBe(200);

    const ceoHandoffComment = await request(app)
      .post(`/issues/${issueId}/comments`)
      .set("x-company-id", companyId)
      .send({
        body: "CEO handoff: assigning to Execution Worker for implementation.",
        authorType: "agent",
        authorId: ceoId
      });
    expect(ceoHandoffComment.status).toBe(200);

    const workerStartComment = await request(app)
      .post(`/issues/${issueId}/comments`)
      .set("x-company-id", companyId)
      .send({
        body: "Worker update: implementation started.",
        authorType: "agent",
        authorId: workerId
      });
    expect(workerStartComment.status).toBe(200);

    const runId = await runHeartbeatForAgent(db, companyId, workerId);
    expect(runId).toBeTruthy();

    const issueRows = await listIssues(db, companyId);
    const workflowIssue = issueRows.find((row) => row.id === issueId);
    expect(workflowIssue?.status).toBe("in_review");

    const commentsResponse = await request(app).get(`/issues/${issueId}/comments`).set("x-company-id", companyId);
    expect(commentsResponse.status).toBe(200);
    const commentBodies = (commentsResponse.body.data as Array<{ body: string }>).map((comment) => comment.body);
    expect(commentBodies).toContain("CEO intake: approved scope and preparing to hire execution support.");
    expect(commentBodies).toContain("CEO handoff: assigning to Execution Worker for implementation.");
    expect(commentBodies).toContain("Worker update: implementation started.");
  });

  it("auto-populates OpenCode model for approved hires when runtimeModel is omitted", async () => {
    const previousDefault = process.env.BOPO_OPENCODE_MODEL;
    process.env.BOPO_OPENCODE_MODEL = "opencode/big-pickle";
    try {
      const ceoResponse = await request(app).post("/agents").set("x-company-id", companyId).send({
        role: "CEO",
        name: "OpenCode CEO",
        providerType: "shell",
        heartbeatCron: "*/5 * * * *",
        monthlyBudgetUsd: 100,
        canHireAgents: true,
        requestApproval: false,
        runtimeCommand: "echo",
        runtimeCwd: tempDir,
        runtimeArgs: ['{"summary":"ceo heartbeat","tokenInput":0,"tokenOutput":0,"usdCost":0}']
      });
      expect(ceoResponse.status).toBe(200);
      const ceoId = ceoResponse.body.data.id as string;

      const hireRequestResponse = await request(app).post("/agents").set("x-company-id", companyId).send({
        managerAgentId: ceoId,
        role: "Engineer",
        name: "OpenCode Founding Engineer",
        providerType: "opencode",
        heartbeatCron: "*/5 * * * *",
        monthlyBudgetUsd: 40,
        canHireAgents: false,
        requestApproval: true,
        runtimeCommand: "opencode",
        runtimeCwd: tempDir
      });
      expect(hireRequestResponse.status).toBe(200);
      const approvalId = hireRequestResponse.body.data.approvalId as string;

      const resolveResponse = await request(app).post("/governance/resolve").set("x-company-id", companyId).send({
        approvalId,
        status: "approved"
      });
      expect(resolveResponse.status).toBe(200);
      expect(resolveResponse.body.data.execution.applied).toBe(true);
      const workerId = resolveResponse.body.data.execution.entityId as string;

      const agentsResponse = await request(app).get("/agents").set("x-company-id", companyId);
      expect(agentsResponse.status).toBe(200);
      const hiredWorker = (
        agentsResponse.body.data as Array<{ id: string; providerType: string; runtimeModel?: string | null }>
      ).find((agent) => agent.id === workerId);
      expect(hiredWorker?.providerType).toBe("opencode");
      expect(hiredWorker?.runtimeModel).toBe("opencode/big-pickle");
    } finally {
      if (previousDefault === undefined) {
        delete process.env.BOPO_OPENCODE_MODEL;
      } else {
        process.env.BOPO_OPENCODE_MODEL = previousDefault;
      }
    }
  });

  it("runs only due heartbeats, advances issues to review, and records cost entries", async () => {
    const project = await createProject(db, {
      companyId,
      name: "Runtime",
      description: "Heartbeat tests.",
      workspaceLocalPath: tempDir
    });
    const now = new Date();
    const dueCron = `${now.getMinutes()} ${now.getHours()} * * *`;
    const notDueCron = `${(now.getMinutes() + 1) % 60} ${now.getHours()} * * *`;

    const dueAgent = await createAgent(db, {
      companyId,
      role: "Engineer",
      name: "Shell Worker",
      providerType: "shell",
      heartbeatCron: dueCron,
      monthlyBudgetUsd: "30.0000",
      initialState: {
        runtime: {
          command: "echo",
          cwd: tempDir,
          args: ['{"summary":"processed","tokenInput":12,"tokenOutput":7,"usdCost":0.125}']
        }
      }
    });
    await createAgent(db, {
      companyId,
      role: "Analyst",
      name: "Sleeping Worker",
      providerType: "shell",
      heartbeatCron: notDueCron,
      monthlyBudgetUsd: "30.0000",
      initialState: {
        runtime: {
          command: "echo",
          cwd: tempDir,
          args: ['{"summary":"processed","tokenInput":2,"tokenOutput":1,"usdCost":0.01}']
        }
      }
    });

    await createIssue(db, {
      companyId,
      projectId: project.id,
      title: "Ship runtime sync",
      body: "Agent should pick this up.",
      assigneeAgentId: dueAgent.id
    });

    const runIds = await runHeartbeatSweep(db, companyId);
    expect(runIds).toHaveLength(1);

    const issueRows = await listIssues(db, companyId);
    expect(issueRows[0]?.status).toBe("in_review");

    const costEntries = await listCostEntries(db, companyId);
    expect(costEntries).toHaveLength(1);
    expect(Number(costEntries[0]?.usdCost ?? 0)).toBeGreaterThan(0);

    const heartbeatRows = await listHeartbeatRuns(db, companyId);
    expect(heartbeatRows[0]?.status).toBe("completed");
  });

  it("injects control-plane runtime env for heartbeat execution", async () => {
    const previousGlobalKey = process.env.BOPO_OPENAI_API_KEY;
    const previousClaudeKey = process.env.BOPO_ANTHROPIC_API_KEY;
    process.env.BOPO_OPENAI_API_KEY = "sk-global-test";
    process.env.BOPO_ANTHROPIC_API_KEY = "sk-ant-global-test";
    try {
    const project = await createProject(db, {
      companyId,
      name: "Control Plane Env",
        description: "Ensure BOPODEV runtime env injection.",
      workspaceLocalPath: tempDir
    });
    const agent = await createAgent(db, {
      companyId,
      role: "CEO",
      name: "Env Aware CEO",
      providerType: "shell",
      heartbeatCron: "*/5 * * * *",
      monthlyBudgetUsd: "30.0000",
      canHireAgents: true,
      initialState: {
        runtime: {
          command: process.execPath,
          cwd: tempDir,
          env: {
            USER_DEFINED_FLAG: "1"
          },
          args: [
            "-e",
            [
              "const ok = Boolean(process.env.BOPODEV_AGENT_ID) &&",
              "  Boolean(process.env.BOPODEV_COMPANY_ID) &&",
              "  Boolean(process.env.BOPODEV_RUN_ID) &&",
              "  Boolean(process.env.BOPODEV_API_BASE_URL) &&",
              "  ['true', 'false'].includes(process.env.BOPODEV_FORCE_MANAGED_CODEX_HOME ?? '') &&",
              "  process.env.USER_DEFINED_FLAG === '1' &&",
              "  process.env.OPENAI_API_KEY === 'sk-global-test' &&",
              "  process.env.ANTHROPIC_API_KEY === 'sk-ant-global-test' &&",
              "  process.env.BOPODEV_CAN_HIRE_AGENTS === 'true';",
              "console.log(JSON.stringify({",
              "  summary: ok ? 'control-plane-env-ready' : 'control-plane-env-missing',",
              "  tokenInput: 1,",
              "  tokenOutput: 1,",
              "  usdCost: 0.000001",
              "}));"
            ].join("\n")
          ]
        }
      }
    });
    await createIssue(db, {
      companyId,
      projectId: project.id,
      title: "Validate control-plane env injection",
      assigneeAgentId: agent.id
    });

    const runId = await runHeartbeatForAgent(db, companyId, agent.id);
    expect(runId).toBeTruthy();

    const heartbeatRows = await listHeartbeatRuns(db, companyId);
    const latest = heartbeatRows.find((row) => row.id === runId);
    expect(latest?.status).toBe("completed");
    expect(latest?.message).toContain("control-plane-env-ready");

    const logsResponse = await request(app).get("/observability/logs").set("x-company-id", companyId);
    expect(logsResponse.status).toBe(200);
    const runtimeLaunchEvent = (logsResponse.body.data as Array<{ eventType: string; payload?: Record<string, unknown> }>).find(
      (event) => event.eventType === "heartbeat.runtime_launch"
    );
    expect(runtimeLaunchEvent).toBeDefined();
    const runtimePayload = runtimeLaunchEvent?.payload?.runtime as Record<string, unknown> | undefined;
    expect(runtimePayload?.authMode).toBeNull();
    expect(runtimePayload?.envFlags).toBeTruthy();
    expect((runtimePayload?.envFlags as { hasOpenAiKey?: boolean } | undefined)?.hasOpenAiKey).toBe(true);
    expect((runtimePayload?.envFlags as { hasAnthropicKey?: boolean } | undefined)?.hasAnthropicKey).toBe(true);
    } finally {
      if (previousGlobalKey === undefined) {
        delete process.env.BOPO_OPENAI_API_KEY;
      } else {
        process.env.BOPO_OPENAI_API_KEY = previousGlobalKey;
      }
      if (previousClaudeKey === undefined) {
        delete process.env.BOPO_ANTHROPIC_API_KEY;
      } else {
        process.env.BOPO_ANTHROPIC_API_KEY = previousClaudeKey;
      }
    }
  });

  it("fails heartbeat early when control-plane preflight reports connectivity failure", async () => {
    const previousPreflight = process.env.BOPODEV_COMMUNICATION_PREFLIGHT;
    const previousApiBase = process.env.BOPODEV_API_BASE_URL;
    const previousFetch = globalThis.fetch;
    process.env.BOPODEV_COMMUNICATION_PREFLIGHT = "true";
    process.env.BOPODEV_API_BASE_URL = "http://127.0.0.1:4020";
    globalThis.fetch = (async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:4020");
    }) as typeof fetch;
    try {
      const project = await createProject(db, {
        companyId,
        name: "Preflight Failure",
        description: "Heartbeat should fail before runtime execution.",
        workspaceLocalPath: tempDir
      });
      const agent = await createAgent(db, {
        companyId,
        role: "Engineer",
        name: "Codex Worker",
        providerType: "codex",
        heartbeatCron: "*/5 * * * *",
        monthlyBudgetUsd: "25.0000",
        initialState: {
          runtime: {
            command: process.execPath,
            cwd: tempDir,
            args: ['-e', 'console.log("{\\"summary\\":\\"should-not-run\\",\\"tokenInput\\":1,\\"tokenOutput\\":1,\\"usdCost\\":0.000001}")']
          }
        }
      });
      await createIssue(db, {
        companyId,
        projectId: project.id,
        title: "Probe control plane first",
        assigneeAgentId: agent.id
      });

      const runId = await runHeartbeatForAgent(db, companyId, agent.id);
      expect(runId).toBeTruthy();

      const heartbeatRows = await listHeartbeatRuns(db, companyId);
      const latest = heartbeatRows.find((row) => row.id === runId);
      expect(latest?.status).toBe("failed");
      expect(latest?.message).toContain("Control-plane connectivity preflight failed");
    } finally {
      globalThis.fetch = previousFetch;
      if (previousPreflight === undefined) {
        delete process.env.BOPODEV_COMMUNICATION_PREFLIGHT;
      } else {
        process.env.BOPODEV_COMMUNICATION_PREFLIGHT = previousPreflight;
      }
      if (previousApiBase === undefined) {
        delete process.env.BOPODEV_API_BASE_URL;
      } else {
        process.env.BOPODEV_API_BASE_URL = previousApiBase;
      }
    }
  });

  it("allows codex heartbeat execution when control-plane preflight passes", async () => {
    const previousPreflight = process.env.BOPODEV_COMMUNICATION_PREFLIGHT;
    const previousApiBase = process.env.BOPODEV_API_BASE_URL;
    const previousFetch = globalThis.fetch;
    process.env.BOPODEV_COMMUNICATION_PREFLIGHT = "true";
    process.env.BOPODEV_API_BASE_URL = "http://127.0.0.1:4020";
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ ok: true, data: [] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })) as typeof fetch;
    try {
      const project = await createProject(db, {
        companyId,
        name: "Preflight Success",
        description: "Heartbeat should continue when probe passes.",
        workspaceLocalPath: tempDir
      });
      const agent = await createAgent(db, {
        companyId,
        role: "Engineer",
        name: "Codex Worker",
        providerType: "codex",
        heartbeatCron: "*/5 * * * *",
        monthlyBudgetUsd: "25.0000",
        initialState: {
          runtime: {
            command: process.execPath,
            cwd: tempDir,
            args: ['-e', 'console.log("{\\"summary\\":\\"preflight-ok\\",\\"tokenInput\\":1,\\"tokenOutput\\":1,\\"usdCost\\":0.000001}")']
          }
        }
      });
      await createIssue(db, {
        companyId,
        projectId: project.id,
        title: "Proceed after preflight",
        assigneeAgentId: agent.id
      });

      const runId = await runHeartbeatForAgent(db, companyId, agent.id);
      expect(runId).toBeTruthy();

      const heartbeatRows = await listHeartbeatRuns(db, companyId);
      const latest = heartbeatRows.find((row) => row.id === runId);
      expect(latest?.status).toBe("completed");
      expect(latest?.message).toContain("preflight-ok");
    } finally {
      globalThis.fetch = previousFetch;
      if (previousPreflight === undefined) {
        delete process.env.BOPODEV_COMMUNICATION_PREFLIGHT;
      } else {
        process.env.BOPODEV_COMMUNICATION_PREFLIGHT = previousPreflight;
      }
      if (previousApiBase === undefined) {
        delete process.env.BOPODEV_API_BASE_URL;
      } else {
        process.env.BOPODEV_API_BASE_URL = previousApiBase;
      }
    }
  });

  it("does not advance issues to review for bootstrap/demo heartbeat output", async () => {
    const project = await createProject(db, {
      companyId,
      name: "Bootstrap Guard",
      description: "Review gating tests.",
      workspaceLocalPath: tempDir
    });
    const bootstrapAgent = await createAgent(db, {
      companyId,
      role: "CEO",
      name: "Bootstrap CEO",
      providerType: "shell",
      heartbeatCron: "*/5 * * * *",
      monthlyBudgetUsd: "100.0000",
      canHireAgents: true,
      initialState: {
        runtime: {
          command: "echo",
          cwd: tempDir,
          args: ['{"summary":"ceo bootstrap heartbeat","tokenInput":0,"tokenOutput":0,"usdCost":0}']
        }
      }
    });
    const issue = await createIssue(db, {
      companyId,
      projectId: project.id,
      title: "Must require real work evidence",
      body: "Bootstrap summaries should not push this into review.",
      assigneeAgentId: bootstrapAgent.id
    });

    const runId = await runHeartbeatForAgent(db, companyId, bootstrapAgent.id);
    expect(runId).toBeTruthy();

    const issueRows = await listIssues(db, companyId);
    const targetIssue = issueRows.find((row) => row.id === issue.id);
    expect(targetIssue?.status).toBe("todo");

    const heartbeatRows = await listHeartbeatRuns(db, companyId);
    expect(heartbeatRows[0]?.status).toBe("completed");
    expect(heartbeatRows[0]?.message).toBe("ceo bootstrap heartbeat");
  });

  it("records structured outcomes and keeps issues unchanged for blocked outcomes", async () => {
    const project = await createProject(db, {
      companyId,
      name: "Structured Outcome",
      description: "Outcome-driven review gating.",
      workspaceLocalPath: tempDir
    });
    const opencodeAgent = await createAgent(db, {
      companyId,
      role: "Engineer",
      name: "OpenCode Blocked",
      providerType: "opencode",
      heartbeatCron: "*/5 * * * *",
      monthlyBudgetUsd: "20.0000",
      initialState: {
        runtime: {
          command: "opencode",
          cwd: tempDir
        }
      }
    });
    const issue = await createIssue(db, {
      companyId,
      projectId: project.id,
      title: "Blocked outcome issue",
      assigneeAgentId: opencodeAgent.id
    });

    const runId = await runHeartbeatForAgent(db, companyId, opencodeAgent.id);
    expect(runId).toBeTruthy();

    const issueRows = await listIssues(db, companyId);
    const targetIssue = issueRows.find((row) => row.id === issue.id);
    expect(targetIssue?.status).toBe("todo");

    const logsResponse = await request(app).get("/observability/logs").set("x-company-id", companyId);
    expect(logsResponse.status).toBe(200);
    const completionEvent = (logsResponse.body.data as Array<{ eventType: string; payload?: Record<string, unknown> }>).find(
      (event) => event.eventType === "heartbeat.completed" || event.eventType === "heartbeat.failed"
    );
    expect(completionEvent).toBeDefined();
    const outcome = completionEvent?.payload?.outcome as { kind?: string } | undefined;
    expect(outcome?.kind).toBe("blocked");
  });

  it("falls back to a deterministic workspace when project path is missing", async () => {
    const project = await createProject(db, {
      companyId,
      name: "Scope Guard",
      description: "Requires project workspace path and agent runtime cwd."
    });
    const agent = await createAgent(db, {
      companyId,
      role: "Engineer",
      name: "Scoped Worker",
      providerType: "shell",
      heartbeatCron: "*/5 * * * *",
      monthlyBudgetUsd: "20.0000",
      initialState: {
        runtime: {
          command: "echo",
          cwd: tempDir,
          args: ['{"summary":"processed","tokenInput":1,"tokenOutput":1,"usdCost":0.01}']
        }
      }
    });
    const issue = await createIssue(db, {
      companyId,
      projectId: project.id,
      title: "Workspace scope enforcement",
      assigneeAgentId: agent.id
    });

    const runId = await runHeartbeatForAgent(db, companyId, agent.id);
    expect(runId).toBeTruthy();

    const issueRows = await listIssues(db, companyId);
    const targetIssue = issueRows.find((row) => row.id === issue.id);
    expect(targetIssue?.status).toBe("in_review");

    const heartbeatRows = await listHeartbeatRuns(db, companyId);
    expect(heartbeatRows[0]?.status).toBe("completed");
    expect(heartbeatRows[0]?.message).toContain("processed");
  });

  it("bootstraps repo-only project workspaces before heartbeat execution", async () => {
    const remoteRepoPath = await createSeedGitRemote(tempDir, "repo-bootstrap");
    const projectWorkspacePath = join(tempDir, "repo-workspace");
    const project = await createProject(db, {
      companyId,
      name: "Repo Bootstrap Workspace",
      executionWorkspacePolicy: { mode: "project_primary" }
    });
    const createWorkspaceResponse = await request(app)
      .post(`/projects/${project.id}/workspaces`)
      .set("x-company-id", companyId)
      .send({
        name: "Repo workspace",
        cwd: projectWorkspacePath,
        repoUrl: remoteRepoPath,
        repoRef: "main",
        isPrimary: true
      });
    expect(createWorkspaceResponse.status).toBe(200);
    const agent = await createAgent(db, {
      companyId,
      role: "Engineer",
      name: "Repo Bootstrap Worker",
      providerType: "shell",
      heartbeatCron: "*/5 * * * *",
      monthlyBudgetUsd: "10.0000",
      initialState: {
        runtime: {
          command: process.execPath,
          args: [
            "-e",
            [
              "const fs = require('node:fs');",
              "const hasReadme = fs.existsSync('README.md');",
              "const cwd = process.cwd();",
              "console.log(JSON.stringify({ summary: `repo-bootstrap:${hasReadme}:${cwd}`, tokenInput: 1, tokenOutput: 1, usdCost: 0.000001 }));"
            ].join("\n")
          ]
        }
      }
    });
    await createIssue(db, {
      companyId,
      projectId: project.id,
      title: "Bootstrap repo workspace",
      assigneeAgentId: agent.id
    });
    const runId = await runHeartbeatForAgent(db, companyId, agent.id);
    expect(runId).toBeTruthy();
    const runs = await listHeartbeatRuns(db, companyId);
    const latest = runs.find((run) => run.id === runId);
    expect(latest?.status).toBe("completed");
    expect(latest?.message).toContain("repo-bootstrap:true:");
    expect(latest?.message).toContain(projectWorkspacePath);
  });

  it("uses git worktree isolation when policy and feature flag are enabled", async () => {
    const previousFlag = process.env.BOPO_ENABLE_GIT_WORKTREE_ISOLATION;
    process.env.BOPO_ENABLE_GIT_WORKTREE_ISOLATION = "true";
    try {
      const remoteRepoPath = await createSeedGitRemote(tempDir, "repo-isolated");
      const baseWorkspacePath = join(tempDir, "isolated-base");
      const project = await createProject(db, {
        companyId,
        name: "Isolated Worktree Workspace",
        executionWorkspacePolicy: {
          mode: "isolated",
          strategy: {
            type: "git_worktree",
            branchPrefix: "bopo-test"
          }
        }
      });
      const createWorkspaceResponse = await request(app)
        .post(`/projects/${project.id}/workspaces`)
        .set("x-company-id", companyId)
        .send({
          name: "Repo workspace",
          cwd: baseWorkspacePath,
          repoUrl: remoteRepoPath,
          repoRef: "main",
          isPrimary: true
        });
      expect(createWorkspaceResponse.status).toBe(200);
      const agent = await createAgent(db, {
        companyId,
        role: "Engineer",
        name: "Isolated Worker",
        providerType: "shell",
        heartbeatCron: "*/5 * * * *",
        monthlyBudgetUsd: "10.0000",
        initialState: {
          runtime: {
            command: process.execPath,
            args: [
              "-e",
              "console.log(JSON.stringify({ summary: `isolated-cwd:${process.cwd()}`, tokenInput: 1, tokenOutput: 1, usdCost: 0.000001 }));"
            ]
          }
        }
      });
      await createIssue(db, {
        companyId,
        projectId: project.id,
        title: "Run in isolated worktree",
        assigneeAgentId: agent.id
      });
      const runId = await runHeartbeatForAgent(db, companyId, agent.id);
      expect(runId).toBeTruthy();
      const runs = await listHeartbeatRuns(db, companyId);
      const latest = runs.find((run) => run.id === runId);
      expect(latest?.status).toBe("completed");
      expect(latest?.message).toContain("isolated-cwd:");
      expect(latest?.message).toContain(`/workspaces/${companyId}/agents/${agent.id}/worktrees/${project.id}`);
    } finally {
      if (previousFlag === undefined) {
        delete process.env.BOPO_ENABLE_GIT_WORKTREE_ISOLATION;
      } else {
        process.env.BOPO_ENABLE_GIT_WORKTREE_ISOLATION = previousFlag;
      }
    }
  });

  it("hard-stops heartbeats when an agent has exhausted budget", async () => {
    const agent = await createAgent(db, {
      companyId,
      role: "Engineer",
      name: "Budget Limited",
      providerType: "shell",
      heartbeatCron: "*/5 * * * *",
      monthlyBudgetUsd: "1.0000",
      initialState: {
        runtime: {
          command: "echo",
          args: ['{"summary":"processed","tokenInput":1,"tokenOutput":1,"usdCost":0.01}']
        }
      }
    });

    await db.update(agents).set({ usedBudgetUsd: "1.0000" });

    const runId = await runHeartbeatForAgent(db, companyId, agent.id);
    expect(runId).toBeTruthy();

    const heartbeatRows = await listHeartbeatRuns(db, companyId);
    expect(heartbeatRows[0]?.status).toBe("skipped");
    expect(heartbeatRows[0]?.message).toContain("budget hard-stop");
  });

  it("finalizes failed heartbeats and releases claimed issues", async () => {
    const project = await createProject(db, {
      companyId,
      name: "Runtime Failures",
      description: "Failure handling.",
      workspaceLocalPath: tempDir
    });
    const now = new Date();
    const dueCron = `${now.getMinutes()} ${now.getHours()} * * *`;
    const failingAgent = await createAgent(db, {
      companyId,
      role: "Engineer",
      name: "Failing Worker",
      providerType: "shell",
      heartbeatCron: dueCron,
      monthlyBudgetUsd: "20.0000",
      initialState: {
        runtime: {
          command: process.execPath,
          cwd: tempDir,
          args: ["-e", "process.exit(2)"]
        }
      }
    });
    const issue = await createIssue(db, {
      companyId,
      projectId: project.id,
      title: "Fails safely",
      body: "Should never stay claimed.",
      assigneeAgentId: failingAgent.id
    });

    const runId = await runHeartbeatForAgent(db, companyId, failingAgent.id);
    expect(runId).toBeTruthy();

    const heartbeatRows = await listHeartbeatRuns(db, companyId);
    expect(heartbeatRows[0]?.status).toBe("failed");
    expect(heartbeatRows[0]?.finishedAt).toBeTruthy();
    const failedRunCosts = await listCostEntries(db, companyId);
    expect(Number(failedRunCosts[0]?.usdCost ?? 0)).toBeGreaterThan(0);

    const issueRows = await listIssues(db, companyId);
    const targetIssue = issueRows.find((row) => row.id === issue.id);
    expect(targetIssue?.isClaimed).toBe(false);
  });

  it("records failed heartbeat runs when runtime binary is missing", async () => {
    const project = await createProject(db, {
      companyId,
      name: "Missing Runtime",
      description: "Failing command.",
      workspaceLocalPath: tempDir
    });
    const now = new Date();
    const dueCron = `${now.getMinutes()} ${now.getHours()} * * *`;
    const missingRuntimeAgent = await createAgent(db, {
      companyId,
      role: "Engineer",
      name: "Missing Binary Worker",
      providerType: "shell",
      heartbeatCron: dueCron,
      monthlyBudgetUsd: "20.0000",
      initialState: {
        runtime: {
          command: "definitely-not-real-bopodev-cmd",
          cwd: tempDir,
          args: []
        }
      }
    });
    await createIssue(db, {
      companyId,
      projectId: project.id,
      title: "Should fail quickly",
      assigneeAgentId: missingRuntimeAgent.id
    });

    const runId = await runHeartbeatForAgent(db, companyId, missingRuntimeAgent.id);
    expect(runId).toBeTruthy();

    const heartbeatRows = await listHeartbeatRuns(db, companyId);
    expect(heartbeatRows[0]?.status).toBe("failed");
    expect(heartbeatRows[0]?.message).toContain("runtime failed");
    const missingBinaryCosts = await listCostEntries(db, companyId);
    expect(missingBinaryCosts).toHaveLength(0);
  });

  it("records runtime timeout source on failed heartbeat traces", async () => {
    const project = await createProject(db, {
      companyId,
      name: "Runtime Timeout",
      description: "Timeout diagnostics.",
      workspaceLocalPath: tempDir
    });
    const now = new Date();
    const dueCron = `${now.getMinutes()} ${now.getHours()} * * *`;
    const timeoutAgent = await createAgent(db, {
      companyId,
      role: "Engineer",
      name: "Timeout Worker",
      providerType: "shell",
      heartbeatCron: dueCron,
      monthlyBudgetUsd: "20.0000",
      runtimeTimeoutSec: 1,
      interruptGraceSec: 1,
      initialState: {
        runtime: {
          command: process.execPath,
          cwd: tempDir,
          args: ["-e", "setTimeout(() => console.log('late output'), 2500);"]
        }
      }
    });
    await createIssue(db, {
      companyId,
      projectId: project.id,
      title: "Should time out",
      assigneeAgentId: timeoutAgent.id
    });

    const runId = await runHeartbeatForAgent(db, companyId, timeoutAgent.id);
    expect(runId).toBeTruthy();

    const heartbeatRows = await listHeartbeatRuns(db, companyId);
    const latest = heartbeatRows.find((row) => row.id === runId);
    expect(latest?.status).toBe("failed");
    expect(latest?.message).toContain("timed out");

    const logsResponse = await request(app).get("/observability/logs").set("x-company-id", companyId);
    expect(logsResponse.status).toBe(200);
    const completionEvent = (logsResponse.body.data as Array<{ entityId: string; eventType: string; payload?: Record<string, unknown> }>).find(
      (event) => event.entityId === runId && event.eventType === "heartbeat.completed"
    );
    const trace = completionEvent?.payload?.trace as { timeoutSource?: string; failureType?: string } | undefined;
    expect(trace?.timeoutSource).toBe("runtime");
    expect(trace?.failureType).toBe("timeout");
  });

  it("records cost entries when failed runtime includes structured usage", async () => {
    const project = await createProject(db, {
      companyId,
      name: "Failed Usage",
      description: "Capture usage from failed runtime.",
      workspaceLocalPath: tempDir
    });
    const now = new Date();
    const dueCron = `${now.getMinutes()} ${now.getHours()} * * *`;
    const usageFailAgent = await createAgent(db, {
      companyId,
      role: "Engineer",
      name: "Usage Fail Worker",
      providerType: "shell",
      heartbeatCron: dueCron,
      monthlyBudgetUsd: "20.0000",
      initialState: {
        runtime: {
          command: process.execPath,
          cwd: tempDir,
          args: [
            "-e",
            "console.log('{\"summary\":\"failed-with-usage\",\"tokenInput\":7,\"tokenOutput\":3,\"usdCost\":0.0005}'); process.exit(1);"
          ]
        }
      }
    });
    await createIssue(db, {
      companyId,
      projectId: project.id,
      title: "Should still record usage cost",
      assigneeAgentId: usageFailAgent.id
    });

    const runId = await runHeartbeatForAgent(db, companyId, usageFailAgent.id);
    expect(runId).toBeTruthy();

    const heartbeatRows = await listHeartbeatRuns(db, companyId);
    expect(heartbeatRows[0]?.status).toBe("failed");

    const costs = await listCostEntries(db, companyId);
    const latestCost = costs[0];
    expect(Number(latestCost?.usdCost ?? 0)).toBeGreaterThan(0);
    expect(latestCost?.tokenInput).toBe(7);
    expect(latestCost?.tokenOutput).toBe(3);
  });

  it("recovers stale started runs and allows a fresh run", async () => {
    const prevStaleMs = process.env.BOPO_HEARTBEAT_STALE_RUN_MS;
    process.env.BOPO_HEARTBEAT_STALE_RUN_MS = "1000";
    try {
      const project = await createProject(db, {
        companyId,
        name: "Stale Recovery",
        description: "recover started runs",
        workspaceLocalPath: tempDir
      });
      const now = new Date();
      const dueCron = `${now.getMinutes()} ${now.getHours()} * * *`;
      const agent = await createAgent(db, {
        companyId,
        role: "Engineer",
        name: "Stale Recovery Worker",
        providerType: "shell",
        heartbeatCron: dueCron,
        monthlyBudgetUsd: "20.0000",
        initialState: {
          runtime: {
            command: "echo",
            cwd: tempDir,
            args: ['{"summary":"processed","tokenInput":1,"tokenOutput":1,"usdCost":0.01}']
          }
        }
      });

      const issue = await createIssue(db, {
        companyId,
        projectId: project.id,
        title: "Recover issue",
        assigneeAgentId: agent.id
      });
      const staleRunId = "stalerun000001";
      await db.insert(heartbeatRuns).values({
        id: staleRunId,
        companyId,
        agentId: agent.id,
        status: "started",
        startedAt: new Date(Date.now() - 60_000),
        message: "stale run"
      });
      await claimIssuesForAgent(db, companyId, agent.id, staleRunId);

      const newRunId = await runHeartbeatForAgent(db, companyId, agent.id);
      expect(newRunId).toBeTruthy();

      const runs = await listHeartbeatRuns(db, companyId);
      const recovered = runs.find((run) => run.id === staleRunId);
      expect(recovered?.status).toBe("failed");
      expect(recovered?.message).toContain("auto-failed");

      const updatedIssueRows = await listIssues(db, companyId);
      const updatedIssue = updatedIssueRows.find((row) => row.id === issue.id);
      expect(updatedIssue?.isClaimed).toBe(false);
    } finally {
      if (prevStaleMs === undefined) {
        delete process.env.BOPO_HEARTBEAT_STALE_RUN_MS;
      } else {
        process.env.BOPO_HEARTBEAT_STALE_RUN_MS = prevStaleMs;
      }
    }
  });

  it("continues sweep execution when one agent run fails", async () => {
    const project = await createProject(db, {
      companyId,
      name: "Sweep Isolation",
      description: "Keep sweeping.",
      workspaceLocalPath: tempDir
    });
    const now = new Date();
    const dueCron = `${now.getMinutes()} ${now.getHours()} * * *`;
    const healthyAgent = await createAgent(db, {
      companyId,
      role: "Engineer",
      name: "Healthy Worker",
      providerType: "shell",
      heartbeatCron: dueCron,
      monthlyBudgetUsd: "25.0000",
      initialState: {
        runtime: {
          command: "echo",
          cwd: tempDir,
          args: ['{"summary":"ok","tokenInput":1,"tokenOutput":1,"usdCost":0.01}']
        }
      }
    });
    const failingAgent = await createAgent(db, {
      companyId,
      role: "Engineer",
      name: "Bad Worker",
      providerType: "shell",
      heartbeatCron: dueCron,
      monthlyBudgetUsd: "25.0000",
      initialState: {
        runtime: {
          command: "definitely-not-real-bopodev-cmd",
          cwd: tempDir,
          args: []
        }
      }
    });

    await createIssue(db, {
      companyId,
      projectId: project.id,
      title: "Healthy issue",
      assigneeAgentId: healthyAgent.id
    });
    await createIssue(db, {
      companyId,
      projectId: project.id,
      title: "Failing issue",
      assigneeAgentId: failingAgent.id
    });

    const runIds = await runHeartbeatSweep(db, companyId);
    expect(runIds.length).toBe(2);

    const heartbeatRows = await listHeartbeatRuns(db, companyId);
    const statuses = heartbeatRows.map((row) => row.status);
    expect(statuses).toContain("completed");
    expect(statuses).toContain("failed");
  });

  it("denies sensitive governance actions for unauthorized actors", async () => {
    const approvalId = await createApprovalRequest(db, {
      companyId,
      action: "hire_agent",
      payload: {
        name: "Unauthorized Hire",
        role: "Engineer",
        providerType: "shell",
        heartbeatCron: "*/5 * * * *",
        monthlyBudgetUsd: 10,
        canHireAgents: false
      }
    });

    const response = await request(app)
      .post("/governance/resolve")
      .set("x-company-id", companyId)
      .set("x-actor-type", "member")
      .set("x-actor-id", "member-1")
      .set("x-actor-companies", companyId)
      .send({ approvalId, status: "approved" });

    expect(response.status).toBe(403);
    expect(String(response.body.error ?? "")).toContain("Missing permission");
  });

  it("blocks manual heartbeat invocation when an agent is paused", async () => {
    const pausedAgent = await createAgent(db, {
      companyId,
      role: "Engineer",
      name: "Paused Worker",
      providerType: "shell",
      heartbeatCron: "*/5 * * * *",
      monthlyBudgetUsd: "10.0000",
      initialState: {
        runtime: {
          command: "echo",
          args: ['{"summary":"noop","tokenInput":0,"tokenOutput":0,"usdCost":0}']
        }
      }
    });

    const pauseResponse = await request(app).post(`/agents/${pausedAgent.id}/pause`).set("x-company-id", companyId).send({});
    expect(pauseResponse.status).toBe(200);

    const runResponse = await request(app)
      .post("/heartbeats/run-agent")
      .set("x-company-id", companyId)
      .send({ agentId: pausedAgent.id });
    expect(runResponse.status).toBe(409);
    expect(String(runResponse.body.error ?? "")).toContain("not invokable");
  });

  it("queues manual heartbeat when agent is already running", async () => {
    const agent = await createAgent(db, {
      companyId,
      role: "Engineer",
      name: "Overlap Worker",
      providerType: "shell",
      heartbeatCron: "*/5 * * * *",
      monthlyBudgetUsd: "10.0000",
      initialState: {
        runtime: {
          command: "echo",
          args: ['{"summary":"noop","tokenInput":0,"tokenOutput":0,"usdCost":0}']
        }
      }
    });

    await db.insert(heartbeatRuns).values({
      id: "running-overlap",
      companyId,
      agentId: agent.id,
      status: "started",
      message: "already running",
      startedAt: new Date()
    });

    const runResponse = await request(app)
      .post("/heartbeats/run-agent")
      .set("x-company-id", companyId)
      .send({ agentId: agent.id });

    expect(runResponse.status).toBe(200);
    expect(runResponse.body.data.status).toBe("queued");
    expect(typeof runResponse.body.data.jobId).toBe("string");
    const queuedJobs = await listHeartbeatQueueJobs(db, { companyId, agentId: agent.id, status: "pending", limit: 20 });
    expect(queuedJobs.some((job) => job.id === runResponse.body.data.jobId)).toBe(true);
  });

  it("returns queued status for successful manual heartbeat invocation", async () => {
    const now = new Date();
    const dueCron = `${now.getMinutes()} ${now.getHours()} * * *`;
    const startedAgent = await createAgent(db, {
      companyId,
      role: "Engineer",
      name: "Started Worker",
      providerType: "shell",
      heartbeatCron: dueCron,
      monthlyBudgetUsd: "10.0000",
      initialState: {
        runtime: {
          command: "echo",
          args: ['{"summary":"noop","tokenInput":0,"tokenOutput":0,"usdCost":0}']
        }
      }
    });

    await createIssue(db, {
      companyId,
      projectId: (await createProject(db, { companyId, name: "Started Invocations", workspaceLocalPath: tempDir })).id,
      title: "Start route run",
      assigneeAgentId: startedAgent.id
    });

    const runResponse = await request(app)
      .post("/heartbeats/run-agent")
      .set("x-company-id", companyId)
      .send({ agentId: startedAgent.id });

    expect(runResponse.status).toBe(200);
    expect(runResponse.body.data.status).toBe("queued");
    expect(runResponse.body.data.runId).toBeNull();
    expect(typeof runResponse.body.data.jobId).toBe("string");
  });

  it("stops an in-progress heartbeat run via stop endpoint", async () => {
    const stoppableAgent = await createAgent(db, {
      companyId,
      role: "Engineer",
      name: "Stoppable Worker",
      providerType: "shell",
      heartbeatCron: "*/5 * * * *",
      monthlyBudgetUsd: "10.0000",
      initialState: {
        runtime: {
          command: process.execPath,
          args: [
            "-e",
            "setTimeout(() => { console.log('{\"summary\":\"late\",\"tokenInput\":1,\"tokenOutput\":1,\"usdCost\":0.000001}'); }, 4000);"
          ],
          timeoutMs: 30_000
        }
      }
    });
    const project = await createProject(db, { companyId, name: "Stop Runs", workspaceLocalPath: tempDir });
    await createIssue(db, {
      companyId,
      projectId: project.id,
      title: "Stop me",
      assigneeAgentId: stoppableAgent.id
    });

    const runRequest = request(app).post("/heartbeats/run-agent").set("x-company-id", companyId).send({ agentId: stoppableAgent.id });
    void runRequest.then(() => undefined);
    let running: Awaited<ReturnType<typeof listHeartbeatRuns>>[number] | undefined;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 150));
      const runsDuringExecution = await listHeartbeatRuns(db, companyId);
      running = runsDuringExecution.find((run) => run.agentId === stoppableAgent.id && run.status === "started");
      if (running) {
        break;
      }
    }
    expect(running).toBeDefined();

    const stopResponse = await request(app).post(`/heartbeats/${running!.id}/stop`).set("x-company-id", companyId).send({});
    expect(stopResponse.status).toBe(200);
    expect(stopResponse.body.data.status).toBe("stop_requested");

    await runRequest;
    const finalRuns = await listHeartbeatRuns(db, companyId);
    const finalRun = finalRuns.find((run) => run.id === running!.id);
    expect(finalRun?.status).toBe("failed");
    expect(String(finalRun?.message ?? "").toLowerCase()).toContain("cancelled");

    const logsResponse = await request(app).get("/observability/logs").set("x-company-id", companyId);
    expect(logsResponse.status).toBe(200);
    expect(logsResponse.body.data.some((row: { eventType?: string; entityId?: string }) => row.eventType === "heartbeat.cancel_requested" && row.entityId === running!.id)).toBe(
      true
    );
  });

  it("rejects stop/resume/redo when run status transition is invalid", async () => {
    const agent = await createAgent(db, {
      companyId,
      role: "Engineer",
      name: "Transition Guard Agent",
      providerType: "shell",
      heartbeatCron: "*/5 * * * *",
      monthlyBudgetUsd: "10.0000"
    });
    await db.insert(heartbeatRuns).values({
      id: "completed-run",
      companyId,
      agentId: agent.id,
      status: "completed",
      startedAt: new Date(),
      finishedAt: new Date(),
      message: "done"
    });
    await db.insert(heartbeatRuns).values({
      id: "started-run",
      companyId,
      agentId: agent.id,
      status: "started",
      startedAt: new Date(),
      message: "running"
    });

    const stopCompleted = await request(app).post("/heartbeats/completed-run/stop").set("x-company-id", companyId).send({});
    expect(stopCompleted.status).toBe(409);

    const resumeStarted = await request(app).post("/heartbeats/started-run/resume").set("x-company-id", companyId).send({});
    expect(resumeStarted.status).toBe(409);

    const redoStarted = await request(app).post("/heartbeats/started-run/redo").set("x-company-id", companyId).send({});
    expect(redoStarted.status).toBe(409);
  });

  it("starts new runs for resume and redo controls", async () => {
    const agent = await createAgent(db, {
      companyId,
      role: "Engineer",
      name: "Replay Agent",
      providerType: "shell",
      heartbeatCron: "*/5 * * * *",
      monthlyBudgetUsd: "10.0000",
      initialState: {
        sessionId: "old-session",
        runtime: {
          command: "echo",
          args: ['{"summary":"noop","tokenInput":0,"tokenOutput":0,"usdCost":0}']
        }
      }
    });
    const project = await createProject(db, { companyId, name: "Replay Project", workspaceLocalPath: tempDir });
    await createIssue(db, {
      companyId,
      projectId: project.id,
      title: "Replay issue",
      assigneeAgentId: agent.id
    });
    const sourceRunId = await runHeartbeatForAgent(db, companyId, agent.id, { trigger: "manual" });
    expect(sourceRunId).toBeTruthy();
    if (!sourceRunId) {
      throw new Error("Expected source run to be created.");
    }

    const resumeResponse = await request(app).post(`/heartbeats/${sourceRunId}/resume`).set("x-company-id", companyId).send({});
    expect(resumeResponse.status).toBe(200);
    expect(resumeResponse.body.data.status).toBe("queued");
    expect(typeof resumeResponse.body.data.jobId).toBe("string");

    const redoResponse = await request(app).post(`/heartbeats/${sourceRunId}/redo`).set("x-company-id", companyId).send({});
    expect(redoResponse.status).toBe(200);
    expect(redoResponse.body.data.status).toBe("queued");
    expect(typeof redoResponse.body.data.jobId).toBe("string");
    expect(String(redoResponse.body.data.jobId)).not.toBe(String(resumeResponse.body.data.jobId));
    const resumeJobId = String(resumeResponse.body.data.jobId);
    const redoJobId = String(redoResponse.body.data.jobId);

    for (let attempt = 0; attempt < 25; attempt += 1) {
      const allJobs = await listHeartbeatQueueJobs(db, {
        companyId,
        agentId: agent.id,
        limit: 50
      });
      const resumeJob = allJobs.find((entry) => entry.id === resumeJobId);
      const redoJob = allJobs.find((entry) => entry.id === redoJobId);
      const done = resumeJob?.status === "completed" && redoJob?.status === "completed";
      if (done) {
        break;
      }
      await runHeartbeatQueueSweep(db, companyId, { maxJobsPerSweep: 20 });
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const postJobs = await listHeartbeatQueueJobs(db, { companyId, agentId: agent.id, limit: 50 });
    expect(postJobs.find((entry) => entry.id === resumeJobId)?.status).toBe("completed");
    expect(postJobs.find((entry) => entry.id === redoJobId)?.status).toBe("completed");

    const agentRows = await db.select({ id: agents.id, stateBlob: agents.stateBlob }).from(agents).limit(20);
    const agentRow = agentRows.find((row) => row.id === agent.id);
    const parsedState = JSON.parse(agentRow?.stateBlob ?? "{}") as Record<string, unknown>;
    expect(parsedState).toBeTypeOf("object");
  });

  it("dead-letters queued jobs that keep skipping with no retry budget", async () => {
    const now = new Date();
    const dueCron = `${now.getMinutes()} ${now.getHours()} * * *`;
    const agent = await createAgent(db, {
      companyId,
      role: "Engineer",
      name: "Dead Letter Worker",
      providerType: "shell",
      heartbeatCron: dueCron,
      monthlyBudgetUsd: "1.0000",
      initialState: {
        runtime: {
          command: "echo",
          args: ['{"summary":"noop","tokenInput":1,"tokenOutput":1,"usdCost":0.01}']
        }
      }
    });
    await db.update(agents).set({ usedBudgetUsd: "1.0000" });
    const job = await enqueueHeartbeatQueueJob(db, {
      companyId,
      agentId: agent.id,
      jobType: "manual",
      maxAttempts: 1,
      payload: {}
    });
    await runHeartbeatQueueSweep(db, companyId, { maxJobsPerSweep: 5 });
    const reloadedJob = await listHeartbeatQueueJobs(db, { companyId, agentId: agent.id, limit: 20 });
    const target = reloadedJob.find((entry) => entry.id === job.id);
    expect(target?.status).toBe("dead_letter");
  });
});

async function createSeedGitRemote(rootDir: string, name: string) {
  const remotePath = join(rootDir, `${name}-remote.git`);
  const seedPath = join(rootDir, `${name}-seed`);
  await mkdir(seedPath, { recursive: true });
  await runLocalCommand("git", ["init", "--bare", remotePath], rootDir);
  await runLocalCommand("git", ["init"], seedPath);
  await runLocalCommand("git", ["config", "user.email", "test@example.com"], seedPath);
  await runLocalCommand("git", ["config", "user.name", "Bopo Test"], seedPath);
  await writeFile(join(seedPath, "README.md"), `# ${name}\n`, "utf8");
  await runLocalCommand("git", ["add", "."], seedPath);
  await runLocalCommand("git", ["commit", "-m", "seed"], seedPath);
  await runLocalCommand("git", ["branch", "-M", "main"], seedPath);
  await runLocalCommand("git", ["remote", "add", "origin", remotePath], seedPath);
  await runLocalCommand("git", ["push", "-u", "origin", "main"], seedPath);
  return `file://${remotePath}`;
}

async function runLocalCommand(command: string, args: string[], cwd: string) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: process.env });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => reject(error));
    child.on("close", (code) => {
      if ((code ?? 1) !== 0) {
        reject(new Error(stderr || `${command} ${args.join(" ")} failed with code ${String(code)}`));
        return;
      }
      resolve();
    });
  });
}
