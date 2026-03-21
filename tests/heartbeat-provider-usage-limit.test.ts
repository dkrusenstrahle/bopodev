import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runHeartbeatForAgent } from "../apps/api/src/services/heartbeat-service";
import type { BopoDb } from "../packages/db/src/client";
import {
  bootstrapDatabase,
  createAgent,
  createCompany,
  createIssue,
  createProject,
  listAgents,
  listHeartbeatRuns,
  listIssueComments
} from "../packages/db/src/index";

describe("heartbeat provider usage limit handling", { timeout: 90_000 }, () => {
  let db: BopoDb;
  let tempDir: string;
  let companyId: string;
  let client: { close?: () => Promise<void> };
  const originalFetch = globalThis.fetch;
  const previousOpenAiApiKey = process.env.OPENAI_API_KEY;
  const previousInstanceRoot = process.env.BOPO_INSTANCE_ROOT;
  const previousNodeEnv = process.env.NODE_ENV;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "bopodev-heartbeat-provider-limit-"));
    process.env.BOPO_INSTANCE_ROOT = join(tempDir, "instances");
    process.env.NODE_ENV = "development";
    process.env.OPENAI_API_KEY = "test-key";
    const boot = await bootstrapDatabase(join(tempDir, "test.db"));
    db = boot.db;
    client = boot.client as { close?: () => Promise<void> };
    const company = await createCompany(db, { name: "Provider Limit Co" });
    companyId = company.id;
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    process.env.OPENAI_API_KEY = previousOpenAiApiKey;
    process.env.BOPO_INSTANCE_ROOT = previousInstanceRoot;
    process.env.NODE_ENV = previousNodeEnv;
    await client?.close?.();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("persists usage-limit runs as skipped, pauses the agent, and notifies board recipients", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          type: "error",
          error: {
            type: "invalid_request_error",
            message: "You have reached your specified API usage limits. You will regain access on 2026-04-01 at 00:00 UTC."
          }
        }),
        {
          status: 400,
          headers: { "content-type": "application/json" }
        }
      )
    ) as typeof globalThis.fetch;
    const project = await createProject(db, {
      companyId,
      name: "Provider Limit Project"
    });
    const runtimeCwd = join(tempDir, "instances", "workspaces", companyId, "agents", "runtime");
    const agent = await createAgent(db, {
      companyId,
      role: "Engineer",
      name: "Provider Limit Agent",
      providerType: "openai_api",
      heartbeatCron: "*/5 * * * *",
      monthlyBudgetUsd: "10.0000",
      runtimeCwd,
      runtimeModel: "gpt-5"
    });
    const issue = await createIssue(db, {
      companyId,
      projectId: project!.id,
      title: "Handle provider usage limit",
      assigneeAgentId: agent.id
    });

    const runId = await runHeartbeatForAgent(db, companyId, agent.id);
    expect(runId).toBeTruthy();

    const runs = await listHeartbeatRuns(db, companyId);
    const run = runs.find((entry) => entry.id === runId);
    expect(run?.status).toBe("skipped");
    expect((run?.message ?? "").toLowerCase()).toContain("usage limit");

    const agents = await listAgents(db, companyId);
    const updatedAgent = agents.find((entry) => entry.id === agent.id);
    expect(updatedAgent?.status).toBe("paused");

    const comments = await listIssueComments(db, companyId, issue.id);
    const boardComment = comments.find((comment) =>
      comment.recipients.some((recipient) => recipient.recipientType === "board")
    );
    expect(boardComment).toBeDefined();
    expect((boardComment?.body ?? "").toLowerCase()).toContain("run failed due to provider limits");
  });
});
