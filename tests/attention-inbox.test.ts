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

describe("board attention inbox", { timeout: 30_000 }, () => {
  let db: BopoDb;
  let app: ReturnType<typeof createApp>;
  let tempDir: string;
  let companyId: string;
  let client: { close?: () => Promise<void> };
  let issueId: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "bopodev-attention-test-"));
    const boot = await bootstrapDatabase(join(tempDir, "test.db"));
    db = boot.db;
    client = boot.client as { close?: () => Promise<void> };
    app = createApp({ db });
    const company = await createCompany(db, { name: "Attention Co", mission: "Attention queue behavior." });
    companyId = company.id;
    const project = await createProject(db, { companyId, name: "Attention Project" });
    const issue = await createIssue(db, {
      companyId,
      projectId: project.id,
      title: "Board clarification required",
      status: "blocked"
    });
    issueId = issue.id;
  });

  afterEach(async () => {
    await client.close?.();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("combines budget approvals and board-mentioned comments into actionable attention items", async () => {
    await createApprovalRequest(db, {
      companyId,
      action: "override_budget",
      payload: {
        projectId: "proj-123",
        utilizationPct: 100,
        currentMonthlyBudgetUsd: 20,
        usedBudgetUsd: 20,
        reason: "Project reached budget hard-stop."
      }
    });

    const commentResponse = await request(app)
      .post(`/issues/${issueId}/comments`)
      .set("x-company-id", companyId)
      .send({
        body: "Please clarify the scope so we can continue.",
        recipients: [{ recipientType: "board" }]
      });
    expect(commentResponse.status).toBe(200);
    const commentId = commentResponse.body.data.id as string;

    const attentionResponse = await request(app).get("/attention").set("x-company-id", companyId);
    expect(attentionResponse.status).toBe(200);
    const items = attentionResponse.body.data.items as Array<{
      key: string;
      category: string;
      state: string;
      seenAt: string | null;
      acknowledgedAt: string | null;
      dismissedAt: string | null;
      resolvedAt: string | null;
    }>;
    expect(items.some((item) => item.category === "budget_hard_stop")).toBe(true);
    expect(items.some((item) => item.category === "board_mentioned_comment" && item.key === `comment:${commentId}`)).toBe(true);

    const commentItem = items.find((item) => item.key === `comment:${commentId}`);
    expect(commentItem).toBeDefined();

    const seen = await request(app)
      .post(`/attention/${encodeURIComponent(commentItem!.key)}/seen`)
      .set("x-company-id", companyId)
      .send({});
    expect(seen.status).toBe(200);

    const acknowledged = await request(app)
      .post(`/attention/${encodeURIComponent(commentItem!.key)}/acknowledge`)
      .set("x-company-id", companyId)
      .send({});
    expect(acknowledged.status).toBe(200);

    const dismissed = await request(app)
      .post(`/attention/${encodeURIComponent(commentItem!.key)}/dismiss`)
      .set("x-company-id", companyId)
      .send({});
    expect(dismissed.status).toBe(200);

    const restored = await request(app)
      .post(`/attention/${encodeURIComponent(commentItem!.key)}/undismiss`)
      .set("x-company-id", companyId)
      .send({});
    expect(restored.status).toBe(200);

    const resolved = await request(app)
      .post(`/attention/${encodeURIComponent(commentItem!.key)}/resolve`)
      .set("x-company-id", companyId)
      .send({});
    expect(resolved.status).toBe(200);

    const afterResolve = await request(app).get("/attention").set("x-company-id", companyId);
    expect(afterResolve.status).toBe(200);
    const resolvedItem = (afterResolve.body.data.items as Array<{ key: string; state: string }>).find(
      (item) => item.key === commentItem!.key
    );
    expect(resolvedItem?.state).toBe("resolved");
  });
});
