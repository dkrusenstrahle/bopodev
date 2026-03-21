import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../apps/api/src/app";
import {
  resolveAgentMemoryRootPath,
  resolveCompanyMemoryRootPath,
  resolveProjectMemoryRootPath
} from "../apps/api/src/lib/instance-paths";
import { runHeartbeatForAgent } from "../apps/api/src/services/heartbeat-service";
import type { BopoDb } from "../packages/db/src/client";
import {
  appendHeartbeatRunMessages,
  appendCost,
  bootstrapDatabase,
  createAgent,
  createCompany,
  createIssue,
  createProject,
  heartbeatRuns,
  listCostEntries,
  listHeartbeatRuns
} from "../packages/db/src/index";

describe("observability routes", { timeout: 30_000 }, () => {
  let db: BopoDb;
  let app: ReturnType<typeof createApp>;
  let tempDir: string;
  let companyId: string;
  let client: { close?: () => Promise<void> };
  const previousInstanceRoot = process.env.BOPO_INSTANCE_ROOT;
  const previousNodeEnv = process.env.NODE_ENV;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "bopodev-observability-test-"));
    process.env.BOPO_INSTANCE_ROOT = join(tempDir, "instances");
    process.env.NODE_ENV = "development";
    const boot = await bootstrapDatabase(join(tempDir, "test.db"));
    db = boot.db;
    client = boot.client as { close?: () => Promise<void> };
    app = createApp({ db });
    const company = await createCompany(db, { name: "Observability Co", mission: "Observe everything." });
    companyId = company.id;
  });

  async function seedArtifactRun(artifacts: Array<Record<string, unknown>>) {
    const project = await createProject(db, {
      companyId,
      name: "Artifact Download Seed"
    });
    const report = {
      employee_comment: "done",
      results: ["created report"],
      errors: [],
      artifacts,
      tokenInput: 1,
      tokenOutput: 1,
      usdCost: 0.0001
    };
    const agent = await createAgent(db, {
      companyId,
      role: "Worker",
      name: "Artifact Seed Worker",
      providerType: "shell",
      heartbeatCron: "* * * * *",
      monthlyBudgetUsd: "25.0000",
      canHireAgents: false,
      runtimeCommand: "echo",
      runtimeArgsJson: JSON.stringify([JSON.stringify(report)])
    });
    await createIssue(db, {
      companyId,
      projectId: project.id,
      title: "Produce artifact report",
      assigneeAgentId: agent.id
    });
    const runId = await runHeartbeatForAgent(db, companyId, agent.id, { trigger: "manual" });
    expect(runId).toBeTruthy();
    return runId!;
  }

  afterEach(async () => {
    process.env.BOPO_INSTANCE_ROOT = previousInstanceRoot;
    process.env.NODE_ENV = previousNodeEnv;
    await client.close?.();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("returns costs and heartbeats including derived run outcome", async () => {
    const project = await createProject(db, {
      companyId,
      name: "Observability Project",
      workspaceLocalPath: join(tempDir, "instances", "workspaces", companyId, "observability-project")
    });
    const agent = await createAgent(db, {
      companyId,
      role: "Worker",
      name: "Observer",
      providerType: "shell",
      heartbeatCron: "* * * * *",
      monthlyBudgetUsd: "25.0000",
      canHireAgents: false,
      runtimeCommand: "echo",
      runtimeArgsJson:
        '["{\\"employee_comment\\":\\"Completed the observability run and left the result ready for review.\\",\\"results\\":[\\"Created the run report.\\"],\\"errors\\":[],\\"artifacts\\":[{\\"kind\\":\\"file\\",\\"path\\":\\"reports/run.md\\"}],\\"tokenInput\\":8,\\"tokenOutput\\":3,\\"usdCost\\":0.1234,\\"issue_id\\":\\"wrong-issue\\",\\"agent_id\\":\\"wrong-agent\\",\\"cost\\":999}"]'
    });
    const issue = await createIssue(db, {
      companyId,
      projectId: project.id,
      title: "Observe heartbeat cost recording",
      assigneeAgentId: agent.id
    });

    const runId = await runHeartbeatForAgent(db, companyId, agent.id, {
      trigger: "manual"
    });
    expect(runId).toBeTruthy();
    await appendCost(db, {
      companyId,
      providerType: "shell",
      tokenInput: 8,
      tokenOutput: 3,
      usdCost: "0.1234",
      projectId: project.id,
      agentId: agent.id
    });

    const costsBeforeRoute = await listCostEntries(db, companyId);
    const runsBeforeRoute = await listHeartbeatRuns(db, companyId);
    expect(costsBeforeRoute.length).toBeGreaterThan(0);
    expect(runsBeforeRoute.length).toBeGreaterThan(0);

    const costsResponse = await request(app).get("/observability/costs").set("x-company-id", companyId);
    expect(costsResponse.status).toBe(200);
    expect(Array.isArray(costsResponse.body.data)).toBe(true);
    expect(costsResponse.body.data.some((row: { usdCost: number }) => row.usdCost > 0)).toBe(true);

    const heartbeatsResponse = await request(app).get("/observability/heartbeats").set("x-company-id", companyId);
    expect(heartbeatsResponse.status).toBe(200);
    expect(Array.isArray(heartbeatsResponse.body.data)).toBe(true);
    const runRow = heartbeatsResponse.body.data.find((row: { id: string }) => row.id === runId);
    expect(runRow).toBeTruthy();
    expect(runRow.outcome).not.toBe(null);
    expect(typeof runRow.outcome).toBe("object");
    expect(runRow.publicStatus).toBe("completed");
    expect(runRow.report?.finalStatus).toBe("completed");
    expect(runRow.runType).toBe("work");
    expect(runRow.report?.employeeComment).toContain("Completed the observability run");
    expect(runRow.report?.cost?.usdCost).toBeCloseTo(0.1234, 6);
    expect(runRow.report?.issueIds).toContain(issue.id);
    expect(runRow.report?.issueIds).not.toContain("wrong-issue");

    const runDetailResponse = await request(app)
      .get(`/observability/heartbeats/${encodeURIComponent(runId!)}`)
      .set("x-company-id", companyId);
    expect(runDetailResponse.status).toBe(200);
    expect(runDetailResponse.body.data.run.id).toBe(runId);
    expect(runDetailResponse.body.data.details).toBeTruthy();
    expect(runDetailResponse.body.data.details.report).toBeTruthy();
    expect(runDetailResponse.body.data.details.report.employeeComment).toContain("Completed the observability run");
    expect(runDetailResponse.body.data.transcript).toBeTruthy();

    const runMessagesResponse = await request(app)
      .get(`/observability/heartbeats/${encodeURIComponent(runId!)}/messages?limit=25`)
      .set("x-company-id", companyId);
    expect(runMessagesResponse.status).toBe(200);
    expect(runMessagesResponse.body.data.runId).toBe(runId);
    expect(Array.isArray(runMessagesResponse.body.data.items)).toBe(true);
    if (runMessagesResponse.body.data.items.length > 0) {
      expect(typeof runMessagesResponse.body.data.items[0].sequence).toBe("number");
    }

    await appendHeartbeatRunMessages(db, {
      companyId,
      runId: runId!,
      messages: [
        {
          sequence: 10_000,
          kind: "system",
          text: "OpenAI Codex vX banner",
          signalLevel: "noise",
          groupKey: "system",
          source: "stderr"
        },
        {
          sequence: 10_001,
          kind: "tool_call",
          label: "ReadFile",
          text: "ReadFile src/main.ts",
          signalLevel: "high",
          groupKey: "tool:readfile",
          source: "stdout"
        }
      ]
    });

    const signalOnlyResponse = await request(app)
      .get(`/observability/heartbeats/${encodeURIComponent(runId!)}/messages?signalOnly=true&limit=500`)
      .set("x-company-id", companyId);
    expect(signalOnlyResponse.status).toBe(200);
    expect(
      signalOnlyResponse.body.data.items.every((item: { signalLevel?: string }) => item.signalLevel !== "noise")
    ).toBe(true);

    const kindFilteredResponse = await request(app)
      .get(`/observability/heartbeats/${encodeURIComponent(runId!)}/messages?signalOnly=false&kinds=tool_call&limit=500`)
      .set("x-company-id", companyId);
    expect(kindFilteredResponse.status).toBe(200);
    expect(kindFilteredResponse.body.data.items.length).toBeGreaterThan(0);
    expect(kindFilteredResponse.body.data.items.every((item: { kind: string }) => item.kind === "tool_call")).toBe(
      true
    );
    expect(
      kindFilteredResponse.body.data.items.some(
        (item: { groupKey?: string | null; source?: string }) => item.groupKey && item.source
      )
    ).toBe(true);

    const memoryListResponse = await request(app)
      .get(`/observability/memory?agentId=${encodeURIComponent(agent.id)}`)
      .set("x-company-id", companyId);
    expect(memoryListResponse.status).toBe(200);
    expect(Array.isArray(memoryListResponse.body.data.items)).toBe(true);
    expect(memoryListResponse.body.data.items.length).toBeGreaterThan(0);
    const dailyNoteEntry = memoryListResponse.body.data.items.find((item: { relativePath: string }) =>
      item.relativePath.includes("memory/")
    );
    expect(dailyNoteEntry).toBeTruthy();
    if (!dailyNoteEntry) {
      throw new Error("Expected a daily memory note entry.");
    }

    const memoryFileResponse = await request(app)
      .get(
        `/observability/memory/${encodeURIComponent(agent.id)}/file?path=${encodeURIComponent(dailyNoteEntry.relativePath)}`
      )
      .set("x-company-id", companyId);
    expect(memoryFileResponse.status).toBe(200);
    expect(typeof memoryFileResponse.body.data.content).toBe("string");
    expect(memoryFileResponse.body.data.content).toContain(runId);
  });

  it("drops idle no-assigned-work runs from heartbeat_runs after completion", async () => {
    const agent = await createAgent(db, {
      companyId,
      role: "Worker",
      name: "No Work Agent",
      providerType: "shell",
      heartbeatCron: "* * * * *",
      monthlyBudgetUsd: "25.0000",
      canHireAgents: false,
      runtimeCommand: "echo",
      runtimeArgsJson: '["{\\"summary\\":\\"no-op\\",\\"tokenInput\\":0,\\"tokenOutput\\":0,\\"usdCost\\":0}"]'
    });

    const runId = await runHeartbeatForAgent(db, companyId, agent.id, { trigger: "manual" });
    expect(runId).toBeTruthy();

    const heartbeatsResponse = await request(app).get("/observability/heartbeats").set("x-company-id", companyId);
    expect(heartbeatsResponse.status).toBe(200);
    const runRow = heartbeatsResponse.body.data.find((row: { id: string }) => row.id === runId);
    expect(runRow).toBeUndefined();

    const runsInDb = await listHeartbeatRuns(db, companyId);
    expect(runsInDb.some((row) => row.id === runId)).toBe(false);
  });

  it("classifies adapter-prefixed no-assigned-work messages as no_assigned_work", async () => {
    const project = await createProject(db, {
      companyId,
      name: "Message Classification",
      workspaceLocalPath: join(tempDir, "instances", "workspaces", companyId, "message-classification")
    });
    const agent = await createAgent(db, {
      companyId,
      role: "Worker",
      name: "Codex Message Agent",
      providerType: "shell",
      heartbeatCron: "* * * * *",
      monthlyBudgetUsd: "25.0000",
      canHireAgents: false,
      runtimeCommand: "echo",
      runtimeArgsJson: '["{\\"summary\\":\\"work-run\\",\\"tokenInput\\":1,\\"tokenOutput\\":1,\\"usdCost\\":0.0001}"]'
    });
    await createIssue(db, {
      companyId,
      projectId: project.id,
      title: "Generate a normal completed run",
      assigneeAgentId: agent.id
    });

    const runId = await runHeartbeatForAgent(db, companyId, agent.id, { trigger: "manual" });
    expect(runId).toBeTruthy();

    await db
      .update(heartbeatRuns)
      .set({ message: "Codex adapter: No assigned work found." });

    const heartbeatsResponse = await request(app).get("/observability/heartbeats").set("x-company-id", companyId);
    expect(heartbeatsResponse.status).toBe(200);
    const runRow = heartbeatsResponse.body.data.find((row: { id: string }) => row.id === runId);
    expect(runRow).toBeTruthy();
    expect(runRow.runType).toBe("no_assigned_work");
  });

  it("downloads artifacts resolved from workspace-relative report paths", async () => {
    const project = await createProject(db, {
      companyId,
      name: "Artifact Download"
    });
    const script =
      "const fs=require('node:fs');fs.mkdirSync('reports',{recursive:true});fs.writeFileSync('reports/run.md','artifact body\\n');console.log(JSON.stringify({employee_comment:'done',results:['created report'],errors:[],artifacts:[{kind:'file',path:'./reports/run.md'}],tokenInput:1,tokenOutput:1,usdCost:0.0001}));";
    const agent = await createAgent(db, {
      companyId,
      role: "Worker",
      name: "Artifact Worker",
      providerType: "shell",
      heartbeatCron: "* * * * *",
      monthlyBudgetUsd: "25.0000",
      canHireAgents: false,
      runtimeCommand: process.execPath,
      runtimeArgsJson: JSON.stringify(["-e", script])
    });
    await createIssue(db, {
      companyId,
      projectId: project.id,
      title: "Produce downloadable artifact",
      assigneeAgentId: agent.id
    });

    const runId = await runHeartbeatForAgent(db, companyId, agent.id, { trigger: "manual" });
    expect(runId).toBeTruthy();

    const downloadResponse = await request(app)
      .get(`/observability/heartbeats/${encodeURIComponent(runId!)}/artifacts/0/download`)
      .query({ companyId })
      .set("x-company-id", companyId);
    expect(downloadResponse.status).toBe(200);
    expect(Buffer.from(downloadResponse.body).toString("utf8")).toContain("artifact body");
  });

  it("downloads artifacts when report path is workspace/company scoped", async () => {
    const project = await createProject(db, {
      companyId,
      name: "Workspace Scoped Artifact Download"
    });
    const agent = await createAgent(db, {
      companyId,
      role: "Worker",
      name: "Workspace Artifact Worker",
      providerType: "shell",
      heartbeatCron: "* * * * *",
      monthlyBudgetUsd: "25.0000",
      canHireAgents: false,
      runtimeCommand: "echo",
      runtimeArgsJson: JSON.stringify([
        JSON.stringify({
          employee_comment: "done",
          results: ["created workspace-scoped report"],
          errors: [],
          artifacts: [{ kind: "file", path: `workspace/${companyId}/agents/download-worker/operating/AGENTS.md` }],
          tokenInput: 1,
          tokenOutput: 1,
          usdCost: 0.0001
        })
      ])
    });
    await createIssue(db, {
      companyId,
      projectId: project.id,
      title: "Produce workspace-scoped artifact",
      assigneeAgentId: agent.id
    });

    const runId = await runHeartbeatForAgent(db, companyId, agent.id, { trigger: "manual" });
    expect(runId).toBeTruthy();
    const workspaceScopedArtifactDir = join(
      process.env.BOPO_INSTANCE_ROOT!,
      "workspaces",
      companyId,
      "agents",
      "download-worker",
      "operating"
    );
    const workspaceScopedArtifactPath = join(workspaceScopedArtifactDir, "AGENTS.md");
    await mkdir(workspaceScopedArtifactDir, { recursive: true });
    await writeFile(workspaceScopedArtifactPath, "workspace scoped artifact\n");

    const downloadResponse = await request(app)
      .get(`/observability/heartbeats/${encodeURIComponent(runId!)}/artifacts/0/download`)
      .query({ companyId })
      .set("x-company-id", companyId);
    expect(downloadResponse.status).toBe(200);
    expect(Buffer.from(downloadResponse.body).toString("utf8")).toContain("workspace scoped artifact");
  });

  it("downloads artifacts when report path uses projects/agents operating scope", async () => {
    const project = await createProject(db, {
      companyId,
      name: "Projects Agents Scoped Artifact Download"
    });
    const agentFolder = "projects-agents-worker";
    const agent = await createAgent(db, {
      companyId,
      role: "Worker",
      name: "Projects Agents Artifact Worker",
      providerType: "shell",
      heartbeatCron: "* * * * *",
      monthlyBudgetUsd: "25.0000",
      canHireAgents: false,
      runtimeCommand: "echo",
      runtimeArgsJson: JSON.stringify([
        JSON.stringify({
          employee_comment: "done",
          results: ["created projects/agents operating report"],
          errors: [],
          artifacts: [{ kind: "file", path: `projects/agents/${agentFolder}/operating/AGENTS.md` }],
          tokenInput: 1,
          tokenOutput: 1,
          usdCost: 0.0001
        })
      ])
    });
    await createIssue(db, {
      companyId,
      projectId: project.id,
      title: "Produce projects/agents-scoped artifact",
      assigneeAgentId: agent.id
    });

    const runId = await runHeartbeatForAgent(db, companyId, agent.id, { trigger: "manual" });
    expect(runId).toBeTruthy();
    const operatingDir = join(
      process.env.BOPO_INSTANCE_ROOT!,
      "workspaces",
      companyId,
      "agents",
      agentFolder,
      "operating"
    );
    await mkdir(operatingDir, { recursive: true });
    await writeFile(join(operatingDir, "AGENTS.md"), "projects agents scoped artifact\n");

    const downloadResponse = await request(app)
      .get(`/observability/heartbeats/${encodeURIComponent(runId!)}/artifacts/0/download`)
      .query({ companyId })
      .set("x-company-id", companyId);
    expect(downloadResponse.status).toBe(200);
    expect(Buffer.from(downloadResponse.body).toString("utf8")).toContain("projects agents scoped artifact");
  });

  it("downloads artifacts when workspace/ company segment typos the real company id", async () => {
    const project = await createProject(db, {
      companyId,
      name: "Typo Company Segment Artifact"
    });
    const agentFolder = "typo-segment-worker";
    const agent = await createAgent(db, {
      companyId,
      role: "Worker",
      name: "Typo Segment Worker",
      providerType: "shell",
      heartbeatCron: "* * * * *",
      monthlyBudgetUsd: "25.0000",
      canHireAgents: false,
      runtimeCommand: "echo",
      runtimeArgsJson: JSON.stringify([
        JSON.stringify({
          employee_comment: "done",
          results: ["reported operating file"],
          errors: [],
          artifacts: [
            {
              kind: "file",
              path: `workspace/${companyId}typo/agents/${agentFolder}/operating/typo-segment.md`
            }
          ],
          tokenInput: 1,
          tokenOutput: 1,
          usdCost: 0.0001
        })
      ])
    });
    await createIssue(db, {
      companyId,
      projectId: project.id,
      title: "Typo workspace prefix",
      assigneeAgentId: agent.id
    });

    const operatingDir = join(
      process.env.BOPO_INSTANCE_ROOT!,
      "workspaces",
      companyId,
      "agents",
      agentFolder,
      "operating"
    );
    await mkdir(operatingDir, { recursive: true });
    await writeFile(join(operatingDir, "typo-segment.md"), "typo segment body\n");

    const runId = await runHeartbeatForAgent(db, companyId, agent.id, { trigger: "manual" });
    expect(runId).toBeTruthy();

    const downloadResponse = await request(app)
      .get(`/observability/heartbeats/${encodeURIComponent(runId!)}/artifacts/0/download`)
      .query({ companyId })
      .set("x-company-id", companyId);
    expect(downloadResponse.status).toBe(200);
    expect(Buffer.from(downloadResponse.body).toString("utf8")).toContain("typo segment body");
  });

  it("rejects invalid artifact index values", async () => {
    const runId = await seedArtifactRun([{ kind: "file", path: "reports/run.md" }]);

    const nonNumericResponse = await request(app)
      .get(`/observability/heartbeats/${encodeURIComponent(runId)}/artifacts/not-a-number/download`)
      .set("x-company-id", companyId);
    expect(nonNumericResponse.status).toBe(422);
    expect(nonNumericResponse.body.error).toContain("non-negative integer");

    const negativeIndexResponse = await request(app)
      .get(`/observability/heartbeats/${encodeURIComponent(runId)}/artifacts/-1/download`)
      .set("x-company-id", companyId);
    expect(negativeIndexResponse.status).toBe(422);
    expect(negativeIndexResponse.body.error).toContain("non-negative integer");
  });

  it("rejects unsafe absolute artifact paths and safely handles unresolved relative paths", async () => {
    const outsidePath = join(tempDir, "outside-artifact.txt");
    await writeFile(outsidePath, "outside scope\n");

    const traversalRunId = await seedArtifactRun([
      {
        kind: "file",
        path: "../../outside-artifact.txt"
      }
    ]);
    const traversalResponse = await request(app)
      .get(`/observability/heartbeats/${encodeURIComponent(traversalRunId)}/artifacts/0/download`)
      .set("x-company-id", companyId);
    expect(traversalResponse.status).toBe(404);
    expect(traversalResponse.body.error).toContain("not found on disk");

    const absoluteEscapeRunId = await seedArtifactRun([
      {
        kind: "file",
        absolutePath: outsidePath
      }
    ]);
    const absoluteEscapeResponse = await request(app)
      .get(`/observability/heartbeats/${encodeURIComponent(absoluteEscapeRunId)}/artifacts/0/download`)
      .set("x-company-id", companyId);
    expect(absoluteEscapeResponse.status).toBe(422);
    expect(absoluteEscapeResponse.body.error).toContain("invalid");
  });

  it("returns not found for missing artifact entries", async () => {
    const runId = await seedArtifactRun([{ kind: "file", path: "reports/run.md" }]);

    const response = await request(app)
      .get(`/observability/heartbeats/${encodeURIComponent(runId)}/artifacts/5/download`)
      .set("x-company-id", companyId);
    expect(response.status).toBe(404);
    expect(response.body.error).toContain("Artifact not found");
  });

  it("returns unprocessable entity when artifact path resolves to a directory", async () => {
    const dirRelativePath = `workspace/${companyId}/agents/non-file-worker/operating/report-dir`;
    const runId = await seedArtifactRun([{ kind: "file", path: dirRelativePath }]);
    const directoryAbsolutePath = join(
      process.env.BOPO_INSTANCE_ROOT!,
      "workspaces",
      companyId,
      "agents",
      "non-file-worker",
      "operating",
      "report-dir"
    );
    await mkdir(directoryAbsolutePath, { recursive: true });

    const response = await request(app)
      .get(`/observability/heartbeats/${encodeURIComponent(runId)}/artifacts/0/download`)
      .set("x-company-id", companyId);
    expect(response.status).toBe(422);
    expect(response.body.error).toContain("not a file");
  });

  it("preserves nextCursor when filters reduce returned items", async () => {
    const project = await createProject(db, {
      companyId,
      name: "Cursor Correctness",
      workspaceLocalPath: join(tempDir, "instances", "workspaces", companyId, "cursor-correctness")
    });
    const agent = await createAgent(db, {
      companyId,
      role: "Worker",
      name: "Cursor Tester",
      providerType: "shell",
      heartbeatCron: "* * * * *",
      monthlyBudgetUsd: "25.0000",
      canHireAgents: false,
      runtimeCommand: "echo",
      runtimeArgsJson: '["{\\"summary\\":\\"cursor-run\\",\\"tokenInput\\":1,\\"tokenOutput\\":1,\\"usdCost\\":0.0001}"]'
    });
    await createIssue(db, {
      companyId,
      projectId: project.id,
      title: "Generate run for cursor coverage",
      assigneeAgentId: agent.id
    });
    const runId = await runHeartbeatForAgent(db, companyId, agent.id, { trigger: "manual" });
    expect(runId).toBeTruthy();

    await appendHeartbeatRunMessages(db, {
      companyId,
      runId: runId!,
      messages: Array.from({ length: 16 }, (_value, index) => ({
        sequence: 20_000 + index,
        kind: "system",
        text: `noise-${index}`,
        signalLevel: "noise" as const,
        groupKey: "system",
        source: "stderr" as const
      }))
    });

    const response = await request(app)
      .get(`/observability/heartbeats/${encodeURIComponent(runId!)}/messages?signalOnly=true&limit=10`)
      .set("x-company-id", companyId);

    expect(response.status).toBe(200);
    expect(Array.isArray(response.body.data.items)).toBe(true);
    expect(response.body.data.items.length).toBeLessThan(10);
    expect(response.body.data.nextCursor).not.toBeNull();
  });

  it("does not create memory folders when reading context preview", async () => {
    const project = await createProject(db, {
      companyId,
      name: "Context Preview Read Only"
    });
    const agent = await createAgent(db, {
      companyId,
      role: "Worker",
      name: "Read Only Memory Agent",
      providerType: "shell",
      heartbeatCron: "* * * * *",
      monthlyBudgetUsd: "25.0000",
      canHireAgents: false,
      runtimeCommand: "echo",
      runtimeArgsJson: '["{\\"summary\\":\\"no-op\\",\\"tokenInput\\":1,\\"tokenOutput\\":1,\\"usdCost\\":0.0001}"]'
    });

    const contextResponse = await request(app)
      .get(
        `/observability/memory/${encodeURIComponent(agent.id)}/context-preview?projectIds=${encodeURIComponent(project.id)}`
      )
      .set("x-company-id", companyId);
    expect(contextResponse.status).toBe(200);

    const companyMemoryRoot = resolveCompanyMemoryRootPath(companyId);
    const projectMemoryRoot = resolveProjectMemoryRootPath(companyId, project.id);
    const agentMemoryRoot = resolveAgentMemoryRootPath(companyId, agent.id);

    await expect(stat(companyMemoryRoot)).rejects.toThrow();
    await expect(stat(projectMemoryRoot)).rejects.toThrow();
    await expect(stat(agentMemoryRoot)).rejects.toThrow();
  });
});
