import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../apps/api/src/app";
import type { BopoDb } from "../packages/db/src/client";
import { bootstrapDatabase, createCompany, createGoal, createProject } from "../packages/db/src/index";

describe("goals hierarchy API", { timeout: 30_000 }, () => {
  let db: BopoDb;
  let app: ReturnType<typeof createApp>;
  let tempDir: string;
  let companyId: string;
  let client: { close?: () => Promise<void> };

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "bopodev-goals-tree-"));
    const boot = await bootstrapDatabase(join(tempDir, "test.db"));
    db = boot.db;
    client = boot.client as { close?: () => Promise<void> };
    app = createApp({ db });
    const company = await createCompany(db, { name: "Goals Tree Co" });
    companyId = company.id;
  });

  afterEach(async () => {
    await client?.close?.();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("POST /goals rejects project goal without projectId", async () => {
    const res = await request(app)
      .post("/goals")
      .set("x-company-id", companyId)
      .send({ level: "project", title: "Orphan project goal" });
    expect(res.status).toBe(422);
  });

  it("POST /goals accepts project goal with company parent", async () => {
    const project = await createProject(db, { companyId, name: "P1" });
    const parent = await createGoal(db, { companyId, level: "company", title: "North star" });
    const res = await request(app)
      .post("/goals")
      .set("x-company-id", companyId)
      .send({
        level: "project",
        projectId: project.id,
        parentGoalId: parent.id,
        title: "Ship feature"
      });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.parentGoalId).toBe(parent.id);
    expect(res.body.data.projectId).toBe(project.id);
  });

  it("POST /goals rejects project goal with project-level parent", async () => {
    const p1 = await createProject(db, { companyId, name: "A" });
    const p2 = await createProject(db, { companyId, name: "B" });
    const cg = await createGoal(db, { companyId, level: "company", title: "C" });
    const pg = await createGoal(db, {
      companyId,
      level: "project",
      projectId: p1.id,
      parentGoalId: cg.id,
      title: "P goal"
    });
    const res = await request(app)
      .post("/goals")
      .set("x-company-id", companyId)
      .send({
        level: "project",
        projectId: p2.id,
        parentGoalId: pg.id,
        title: "Bad parent"
      });
    expect(res.status).toBe(422);
  });

  it("POST /goals rejects agent goal with project parent and mismatched projectId", async () => {
    const project = await createProject(db, { companyId, name: "P" });
    const cg = await createGoal(db, { companyId, level: "company", title: "C" });
    const pg = await createGoal(db, {
      companyId,
      level: "project",
      projectId: project.id,
      parentGoalId: cg.id,
      title: "Epic"
    });
    const res = await request(app)
      .post("/goals")
      .set("x-company-id", companyId)
      .send({
        level: "agent",
        parentGoalId: pg.id,
        title: "Agent slice"
      });
    expect(res.status).toBe(422);
  });

  it("POST /goals accepts agent goal under project parent with same projectId", async () => {
    const project = await createProject(db, { companyId, name: "P" });
    const cg = await createGoal(db, { companyId, level: "company", title: "C" });
    const pg = await createGoal(db, {
      companyId,
      level: "project",
      projectId: project.id,
      parentGoalId: cg.id,
      title: "Epic"
    });
    const res = await request(app)
      .post("/goals")
      .set("x-company-id", companyId)
      .send({
        level: "agent",
        projectId: project.id,
        parentGoalId: pg.id,
        title: "Agent slice"
      });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("PUT /goals rejects cycle when setting parent to descendant", async () => {
    const cg = await createGoal(db, { companyId, level: "company", title: "Root" });
    const child = await createGoal(db, {
      companyId,
      level: "company",
      parentGoalId: cg.id,
      title: "Child"
    });
    const res = await request(app)
      .put(`/goals/${cg.id}`)
      .set("x-company-id", companyId)
      .send({ parentGoalId: child.id });
    expect(res.status).toBe(422);
  });
});
