import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../apps/api/src/app";
import type { BopoDb } from "../packages/db/src/client";
import { bootstrapDatabase, createCompany } from "../packages/db/src/index";

describe("goals routes", { timeout: 30_000 }, () => {
  let db: BopoDb;
  let app: ReturnType<typeof createApp>;
  let tempDir: string;
  let companyId: string;
  let client: { close?: () => Promise<void> };

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "bopodev-goals-test-"));
    const boot = await bootstrapDatabase(join(tempDir, "test.db"));
    db = boot.db;
    client = boot.client as { close?: () => Promise<void> };
    app = createApp({ db });
    const company = await createCompany(db, { name: "Goals Co", mission: "Goal route tests." });
    companyId = company.id;
  });

  afterEach(async () => {
    await client?.close?.();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("supports create, list, update, and delete for board actor", async () => {
    const createResponse = await request(app).post("/goals").set("x-company-id", companyId).send({
      level: "company",
      title: "Ship release candidate",
      description: "Complete remaining polish."
    });
    expect(createResponse.status).toBe(200);
    const goalId = createResponse.body.data.id as string;

    const listResponse = await request(app).get("/goals").set("x-company-id", companyId);
    expect(listResponse.status).toBe(200);
    expect(listResponse.body.data.some((goal: { id: string }) => goal.id === goalId)).toBe(true);

    const updateResponse = await request(app).put(`/goals/${goalId}`).set("x-company-id", companyId).send({
      status: "active",
      description: "Now active."
    });
    expect(updateResponse.status).toBe(200);
    expect(updateResponse.body.data.status).toBe("active");
    expect(updateResponse.body.data.description).toBe("Now active.");

    const deleteResponse = await request(app).delete(`/goals/${goalId}`).set("x-company-id", companyId);
    expect(deleteResponse.status).toBe(200);
    expect(deleteResponse.body.data.deleted).toBe(true);
  });

  it("queues activateNow creates for governance approval", async () => {
    const response = await request(app).post("/goals").set("x-company-id", companyId).send({
      level: "company",
      title: "Activate by approval",
      activateNow: true
    });

    expect(response.status).toBe(200);
    expect(response.body.data.queuedForApproval).toBe(true);
    expect(typeof response.body.data.approvalId).toBe("string");
  });

  it("requires goals:write permission for member writes", async () => {
    const forbidden = await request(app)
      .post("/goals")
      .set("x-company-id", companyId)
      .set("x-actor-type", "member")
      .set("x-actor-id", "member-no-goals-write")
      .set("x-actor-companies", companyId)
      .send({ level: "company", title: "Denied goal" });

    expect(forbidden.status).toBe(403);
    expect(String(forbidden.body.error ?? "")).toContain("goals:write");

    const allowed = await request(app)
      .post("/goals")
      .set("x-company-id", companyId)
      .set("x-actor-type", "member")
      .set("x-actor-id", "member-goals-write")
      .set("x-actor-companies", companyId)
      .set("x-actor-permissions", "goals:write")
      .send({ level: "company", title: "Allowed goal" });

    expect(allowed.status).toBe(200);
    expect(allowed.body.data.title).toBe("Allowed goal");
  });

  it("returns not found for updating and deleting unknown goals", async () => {
    const updateResponse = await request(app).put("/goals/missing-goal").set("x-company-id", companyId).send({
      status: "completed"
    });
    expect(updateResponse.status).toBe(404);

    const deleteResponse = await request(app).delete("/goals/missing-goal").set("x-company-id", companyId);
    expect(deleteResponse.status).toBe(404);
  });
});
