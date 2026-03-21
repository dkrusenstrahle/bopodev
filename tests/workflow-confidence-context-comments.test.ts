import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPrompt } from "../packages/agent-sdk/src/adapters";
import type { HeartbeatContext } from "../packages/agent-sdk/src/types";
import { createApp } from "../apps/api/src/app";
import type { BopoDb } from "../packages/db/src/client";
import { bootstrapDatabase, createAgent, createCompany, createIssue, createProject } from "../packages/db/src/index";

describe("workflow confidence: context + comments", () => {
  let db: BopoDb;
  let app: ReturnType<typeof createApp>;
  let tempDir: string;
  let companyId: string;
  let client: { close?: () => Promise<void> };
  let issueId: string;
  let recipientAgentId: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "bopodev-workflow-confidence-context-comments-"));
    const boot = await bootstrapDatabase(join(tempDir, "test.db"));
    db = boot.db;
    client = boot.client as { close?: () => Promise<void> };
    app = createApp({ db });
    const company = await createCompany(db, { name: "Context Co", mission: "Validate comment and context behavior." });
    companyId = company.id;
    const project = await createProject(db, { companyId, name: "Context Project" });
    const recipientAgent = await createAgent(db, {
      companyId,
      role: "Engineer",
      name: "Recipient Agent",
      providerType: "shell",
      heartbeatCron: "*/5 * * * *",
      monthlyBudgetUsd: "20.0000",
      runtimeCommand: "echo",
      runtimeArgsJson: JSON.stringify(['{"summary":"noop","tokenInput":0,"tokenOutput":0,"usdCost":0}']),
      runtimeCwd: tempDir
    });
    recipientAgentId = recipientAgent.id;
    const issue = await createIssue(db, {
      companyId,
      projectId: project.id,
      title: "Validate comment workflow",
      body: "Ensure recipients and directives are applied correctly."
    });
    issueId = issue.id;
  });

  afterEach(async () => {
    await client?.close?.();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("rejects comment author spoofing in modern and legacy endpoints", async () => {
    const modern = await request(app)
      .post(`/issues/${issueId}/comments`)
      .set("x-company-id", companyId)
      .set("x-actor-type", "member")
      .set("x-actor-id", "member-1")
      .set("x-actor-companies", companyId)
      .set("x-actor-permissions", "issues:write")
      .send({
        body: "Please implement this update.",
        authorType: "agent",
        authorId: recipientAgentId
      });
    expect(modern.status).toBe(422);
    expect(String(modern.body.error ?? "")).toContain("derived from actor identity");

    const legacy = await request(app)
      .post("/issues/comment")
      .set("x-company-id", companyId)
      .set("x-actor-type", "member")
      .set("x-actor-id", "member-1")
      .set("x-actor-companies", companyId)
      .set("x-actor-permissions", "issues:write")
      .send({
        issueId,
        body: "Legacy endpoint spoof attempt.",
        authorType: "agent",
        authorId: recipientAgentId
      });
    expect(legacy.status).toBe(422);
    expect(String(legacy.body.error ?? "")).toContain("derived from actor identity");
  });

  it("normalizes recipient states so non-agent recipients are terminal immediately", async () => {
    const response = await request(app)
      .post(`/issues/${issueId}/comments`)
      .set("x-company-id", companyId)
      .set("x-actor-type", "member")
      .set("x-actor-id", "member-2")
      .set("x-actor-companies", companyId)
      .set("x-actor-permissions", "issues:write")
      .send({
        body: "Agent executes this. Board and member are FYI recipients.",
        recipients: [
          { recipientType: "board" },
          { recipientType: "member", recipientId: "member-3" },
          { recipientType: "agent", recipientId: recipientAgentId }
        ]
      });
    expect(response.status).toBe(200);
    const recipients = response.body.data.recipients as Array<{
      recipientType: "agent" | "board" | "member";
      deliveryStatus: "pending" | "dispatched" | "failed" | "skipped";
    }>;
    const boardRecipient = recipients.find((entry) => entry.recipientType === "board");
    const memberRecipient = recipients.find((entry) => entry.recipientType === "member");
    const agentRecipient = recipients.find((entry) => entry.recipientType === "agent");
    expect(boardRecipient?.deliveryStatus).toBe("skipped");
    expect(memberRecipient?.deliveryStatus).toBe("skipped");
    expect(agentRecipient?.deliveryStatus).toBe("pending");
  });

  it("includes sub-issue hierarchy and comment-order directives in prompt context", () => {
    const context: HeartbeatContext = {
      companyId: "company-1",
      agentId: "agent-1",
      providerType: "codex",
      heartbeatRunId: "run-1",
      company: {
        name: "Acme",
        mission: "Ship useful software"
      },
      agent: {
        name: "Worker",
        role: "Engineer",
        managerAgentId: "agent-manager"
      },
      state: {},
      goalContext: {
        companyGoals: ["Increase reliability"],
        projectGoals: ["Close all critical workflow bugs"],
        agentGoals: ["Keep audit quality high"]
      },
      wakeContext: {
        reason: "issue_comment_recipient",
        commentId: "comment-42",
        commentBody: "Fix the failing integration and report back.",
        issueIds: ["issue-parent"]
      },
      workItems: [
        {
          issueId: "issue-parent",
          parentIssueId: null,
          childIssueIds: ["issue-child-a", "issue-child-b"],
          projectId: "project-1",
          projectName: "Core Platform",
          title: "Deliver confidence hardening",
          body: null,
          status: "in_progress",
          priority: "high"
        }
      ]
    };

    const prompt = createPrompt(context);
    expect(prompt).toContain("Comment-order directives:");
    expect(prompt).toContain("Linked issues: issue-parent");
    expect(prompt).toContain("Sub-issues: issue-child-a, issue-child-b");
  });
});
