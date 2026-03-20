import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../apps/api/src/app";
import type { BopoDb } from "../packages/db/src/client";
import { bootstrapDatabase, createApprovalRequest, createCompany } from "../packages/db/src/index";

describe("governance inbox actions", { timeout: 30_000 }, () => {
  let db: BopoDb;
  let app: ReturnType<typeof createApp>;
  let tempDir: string;
  let companyId: string;
  let client: { close?: () => Promise<void> };
  let approvalId: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "bopodev-gov-inbox-test-"));
    const boot = await bootstrapDatabase(join(tempDir, "test.db"));
    db = boot.db;
    client = boot.client as { close?: () => Promise<void> };
    app = createApp({ db });
    const company = await createCompany(db, { name: "Inbox Co", mission: "Inbox route tests." });
    companyId = company.id;
    approvalId = await createApprovalRequest(db, {
      companyId,
      action: "hire_agent",
      payload: {
        name: "Needs review",
        role: "Engineer",
        providerType: "shell",
        heartbeatCron: "*/5 * * * *",
        monthlyBudgetUsd: 25,
        canHireAgents: false,
        runtimeCommand: "echo",
        runtimeCwd: tempDir,
        runtimeArgs: ['{"summary":"noop","tokenInput":0,"tokenOutput":0,"usdCost":0}']
      }
    });
  });

  afterEach(async () => {
    await client.close?.();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("marks inbox items seen, dismissed, and undismissed", async () => {
    const actorHeaders = {
      "x-company-id": companyId,
      "x-actor-type": "member",
      "x-actor-id": "member-governance",
      "x-actor-companies": companyId
    };

    const seenResponse = await request(app).post(`/governance/inbox/${approvalId}/seen`).set(actorHeaders).send({});
    expect(seenResponse.status).toBe(200);

    const dismissResponse = await request(app).post(`/governance/inbox/${approvalId}/dismiss`).set(actorHeaders).send({});
    expect(dismissResponse.status).toBe(200);

    const inboxAfterDismiss = await request(app).get("/governance/inbox").set(actorHeaders);
    expect(inboxAfterDismiss.status).toBe(200);
    const dismissedItem = inboxAfterDismiss.body.data.items.find(
      (item: { approval: { id: string }; dismissedAt: string | null; seenAt: string | null }) => item.approval.id === approvalId
    );
    expect(dismissedItem?.seenAt).toBeTruthy();
    expect(dismissedItem?.dismissedAt).toBeTruthy();

    const undismissResponse = await request(app).post(`/governance/inbox/${approvalId}/undismiss`).set(actorHeaders).send({});
    expect(undismissResponse.status).toBe(200);

    const inboxAfterUndismiss = await request(app).get("/governance/inbox").set(actorHeaders);
    const undismissedItem = inboxAfterUndismiss.body.data.items.find(
      (item: { approval: { id: string }; dismissedAt: string | null }) => item.approval.id === approvalId
    );
    expect(undismissedItem?.dismissedAt).toBe(null);

    const attention = await request(app).get("/attention").set(actorHeaders);
    expect(attention.status).toBe(200);
    expect(
      (attention.body.data.items as Array<{ category: string; evidence?: { approvalId?: string }; state: string }>).some(
        (item) =>
          item.category === "approval_required" &&
          item.evidence?.approvalId === approvalId &&
          (item.state === "open" || item.state === "acknowledged")
      )
    ).toBe(true);
  });

  it("returns 404 for inbox actions on unknown approvals", async () => {
    const response = await request(app)
      .post("/governance/inbox/missing-approval/seen")
      .set("x-company-id", companyId)
      .send({});

    expect(response.status).toBe(404);
    expect(String(response.body.error ?? "")).toContain("not found");
  });

  it("keeps resolved approvals on /attention for the same history window as governance inbox", async () => {
    const resolveResponse = await request(app)
      .post("/governance/resolve")
      .set("x-company-id", companyId)
      .send({ approvalId, status: "rejected" });
    expect(resolveResponse.status).toBe(200);

    const attention = await request(app).get("/attention").set("x-company-id", companyId);
    expect(attention.status).toBe(200);
    const items = attention.body.data.items as Array<{
      category: string;
      evidence?: { approvalId?: string };
      state: string;
      title: string;
    }>;
    const resolvedItem = items.find(
      (item) => item.category === "approval_required" && item.evidence?.approvalId === approvalId
    );
    expect(resolvedItem).toBeDefined();
    expect(resolvedItem?.state).toBe("resolved");
    expect(resolvedItem?.title).toContain("Rejected");
  });
});
