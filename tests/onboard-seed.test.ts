import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { ensureOnboardingSeed } from "../apps/api/src/scripts/onboard-seed";
import {
  bootstrapDatabase,
  createAgent,
  createCompany,
  createTemplate,
  createTemplateVersion,
  listAgents,
  listCompanies,
  listIssues,
  listProjects
} from "../packages/db/src";

describe("onboarding seed bootstrap", { timeout: 20_000 }, () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanupDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  test("creates the default company and CEO once, then reuses them", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "bopo-onboard-seed-"));
    cleanupDirs.push(tempDir);
    const dbPath = join(tempDir, "seed.db");

    const first = await ensureOnboardingSeed({
      dbPath,
      companyName: "Acme AI",
      agentProvider: "codex"
    });

    expect(first.companyName).toBe("Acme AI");
    expect(first.companyCreated).toBe(true);
    expect(first.ceoCreated).toBe(true);
    expect(first.ceoMigrated).toBe(false);
    expect(first.ceoProviderType).toBe("codex");

    const second = await ensureOnboardingSeed({
      dbPath,
      companyName: "Acme AI",
      companyId: first.companyId,
      agentProvider: "shell"
    });

    expect(second.companyId).toBe(first.companyId);
    expect(second.companyCreated).toBe(false);
    expect(second.ceoCreated).toBe(false);
    expect(second.ceoMigrated).toBe(false);
    expect(second.ceoProviderType).toBe("codex");

    const { db, client } = await bootstrapDatabase(dbPath);
    try {
      const companies = await listCompanies(db);
      const agents = await listAgents(db, first.companyId);
      const projects = await listProjects(db, first.companyId);
      const issues = await listIssues(db, first.companyId);

      expect(companies).toHaveLength(1);
      expect(companies[0]?.name).toBe("Acme AI");
      expect(agents).toHaveLength(1);
      expect(agents[0]?.name).toBe("CEO");
      expect(agents[0]?.role).toBe("CEO");
      expect(agents[0]?.providerType).toBe("codex");
      expect(agents[0]?.canHireAgents).toBe(true);
      expect(typeof agents[0]?.runtimeCwd).toBe("string");
      expect(String(agents[0]?.runtimeCwd ?? "")).toContain("/workspaces/");
      expect(projects).toHaveLength(1);
      expect(projects[0]?.name).toBe("Leadership Setup");
      expect(issues).toHaveLength(1);
      expect(issues[0]?.title).toBe("Set up CEO operating files and hire founding engineer");
      expect(issues[0]?.assigneeAgentId).toBe(agents[0]?.id);
      const startupBody = issues[0]?.body ?? "";
      expect(startupBody).toContain("[bopodev:onboarding:ceo-startup:v1]");
      expect(startupBody).toContain("runtimeConfig.bootstrapPrompt");
      expect(startupBody).toContain("Do not call `GET /agents/:agentId`");
      expect(startupBody).toContain("Do not call a checkout endpoint");
      expect(startupBody).toContain("Do not use unsupported hire fields such as `adapterType`, `adapterConfig`, or `reportsTo`.");
      expect(startupBody).not.toContain("instruction file path");
    } finally {
      await (client as { close?: () => Promise<void> }).close?.();
    }
  });

  test("applies requested template during onboarding when available", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "bopo-onboard-seed-"));
    cleanupDirs.push(tempDir);
    const dbPath = join(tempDir, "seed.db");
    const boot = await bootstrapDatabase(dbPath);
    try {
      const company = await createCompany(boot.db, { name: "Template Co" });
      const template = await createTemplate(boot.db, {
        companyId: company.id,
        slug: "starter-template",
        name: "Starter Template",
        currentVersion: "1.0.0",
        variablesJson: "[]"
      });
      expect(template).toBeTruthy();
      await createTemplateVersion(boot.db, {
        companyId: company.id,
        templateId: template!.id,
        version: "1.0.0",
        manifestJson: JSON.stringify({
          projects: [{ key: "ops", name: "Operations" }],
          issues: [{ title: "Set up operating cadence", projectKey: "ops" }]
        })
      });
      const result = await ensureOnboardingSeed({
        dbPath,
        companyName: "Template Co",
        companyId: company.id,
        agentProvider: "codex",
        templateId: "starter-template"
      });
      expect(result.templateApplied).toBe(true);
      expect(result.templateId).toBe(template!.id);
      const verify = await bootstrapDatabase(dbPath);
      try {
        const projects = await listProjects(verify.db, company.id);
        const issues = await listIssues(verify.db, company.id);
        expect(projects.some((project) => project.name === "Operations")).toBe(true);
        expect(issues.some((issue) => issue.title === "Set up operating cadence")).toBe(true);
      } finally {
        await verify.client.close?.();
      }
    } finally {
      await boot.client.close?.();
    }
  });

  test("applies built-in founder-startup-basic template during onboarding by slug", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "bopo-onboard-seed-"));
    cleanupDirs.push(tempDir);
    const dbPath = join(tempDir, "seed.db");
    const result = await ensureOnboardingSeed({
      dbPath,
      companyName: "Builtins Co",
      agentProvider: "codex",
      templateId: "founder-startup-basic"
    });

    expect(result.templateApplied).toBe(true);
    expect(result.templateId).toBeTruthy();

    const verify = await bootstrapDatabase(dbPath);
    try {
      const projects = await listProjects(verify.db, result.companyId);
      expect(projects.some((project) => project.name === "Leadership Operations")).toBe(true);
      expect(projects.some((project) => project.name === "Product Delivery")).toBe(true);
    } finally {
      await verify.client.close?.();
    }
  });

  test("migrates existing bootstrap echo CEO to selected provider", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "bopo-onboard-seed-"));
    cleanupDirs.push(tempDir);
    const dbPath = join(tempDir, "seed.db");
    const { db, client } = await bootstrapDatabase(dbPath);
    const company = await createCompany(db, { name: "Demo Co" });
    await createAgent(db, {
      companyId: company.id,
      role: "CEO",
      name: "CEO",
      providerType: "shell",
      heartbeatCron: "*/5 * * * *",
      monthlyBudgetUsd: "100.0000",
      canHireAgents: true,
      initialState: {
        runtime: {
          command: "echo",
          args: ['{"summary":"ceo bootstrap heartbeat","tokenInput":0,"tokenOutput":0,"usdCost":0}']
        }
      }
    });
    await client.close?.();

    const result = await ensureOnboardingSeed({
      dbPath,
      companyName: "Demo Co",
      companyId: company.id,
      agentProvider: "codex"
    });

    expect(result.ceoCreated).toBe(false);
    expect(result.ceoMigrated).toBe(true);
    expect(result.ceoProviderType).toBe("codex");

    const verify = await bootstrapDatabase(dbPath);
    try {
      const agents = await listAgents(verify.db, company.id);
      const projects = await listProjects(verify.db, company.id);
      const issues = await listIssues(verify.db, company.id);
      expect(agents).toHaveLength(1);
      expect(agents[0]?.providerType).toBe("codex");
      expect(typeof agents[0]?.runtimeCwd).toBe("string");
      expect(String(agents[0]?.runtimeCwd ?? "")).toContain("/workspaces/");
      expect(projects).toHaveLength(1);
      expect(issues).toHaveLength(1);
      expect(issues[0]?.title).toBe("Set up CEO operating files and hire founding engineer");
    } finally {
      await verify.client.close?.();
    }
  });

  test("does not migrate existing non-bootstrap CEO", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "bopo-onboard-seed-"));
    cleanupDirs.push(tempDir);
    const dbPath = join(tempDir, "seed.db");
    const { db, client } = await bootstrapDatabase(dbPath);
    const company = await createCompany(db, { name: "Real Co" });
    await createAgent(db, {
      companyId: company.id,
      role: "CEO",
      name: "CEO",
      providerType: "codex",
      heartbeatCron: "*/5 * * * *",
      monthlyBudgetUsd: "100.0000",
      canHireAgents: true,
      initialState: {}
    });
    await client.close?.();

    const result = await ensureOnboardingSeed({
      dbPath,
      companyName: "Real Co",
      companyId: company.id,
      agentProvider: "claude_code"
    });

    expect(result.ceoCreated).toBe(false);
    expect(result.ceoMigrated).toBe(false);
    expect(result.ceoProviderType).toBe("codex");
  });

  test("seeds codex OPENAI_API_KEY from global env when available", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "bopo-onboard-seed-"));
    cleanupDirs.push(tempDir);
    const dbPath = join(tempDir, "seed.db");
    const previous = process.env.BOPO_OPENAI_API_KEY;
    process.env.BOPO_OPENAI_API_KEY = "sk-seeded-test";
    try {
      const result = await ensureOnboardingSeed({
        dbPath,
        companyName: "Seed Key Co",
        agentProvider: "codex"
      });
      const { db, client } = await bootstrapDatabase(dbPath);
      try {
        const agents = await listAgents(db, result.companyId);
        expect(agents).toHaveLength(1);
        const runtimeEnvJson = String(agents[0]?.runtimeEnvJson ?? "{}");
        expect(runtimeEnvJson).toContain("OPENAI_API_KEY");
        expect(runtimeEnvJson).toContain("sk-seeded-test");
      } finally {
        await (client as { close?: () => Promise<void> }).close?.();
      }
    } finally {
      if (previous === undefined) {
        delete process.env.BOPO_OPENAI_API_KEY;
      } else {
        process.env.BOPO_OPENAI_API_KEY = previous;
      }
    }
  });

  test("seeds claude ANTHROPIC_API_KEY from global env when available", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "bopo-onboard-seed-"));
    cleanupDirs.push(tempDir);
    const dbPath = join(tempDir, "seed.db");
    const previous = process.env.BOPO_ANTHROPIC_API_KEY;
    process.env.BOPO_ANTHROPIC_API_KEY = "sk-ant-seeded-test";
    try {
      const result = await ensureOnboardingSeed({
        dbPath,
        companyName: "Seed Claude Key Co",
        agentProvider: "claude_code"
      });
      const { db, client } = await bootstrapDatabase(dbPath);
      try {
        const agents = await listAgents(db, result.companyId);
        expect(agents).toHaveLength(1);
        const runtimeEnvJson = String(agents[0]?.runtimeEnvJson ?? "{}");
        expect(runtimeEnvJson).toContain("ANTHROPIC_API_KEY");
        expect(runtimeEnvJson).toContain("sk-ant-seeded-test");
      } finally {
        await (client as { close?: () => Promise<void> }).close?.();
      }
    } finally {
      if (previous === undefined) {
        delete process.env.BOPO_ANTHROPIC_API_KEY;
      } else {
        process.env.BOPO_ANTHROPIC_API_KEY = previous;
      }
    }
  });

  test("accepts opencode as onboarding provider", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "bopo-onboard-seed-"));
    cleanupDirs.push(tempDir);
    const dbPath = join(tempDir, "seed.db");

    const result = await ensureOnboardingSeed({
      dbPath,
      companyName: "OpenCode Co",
      agentProvider: "opencode"
    });

    expect(result.ceoCreated).toBe(true);
    expect(result.ceoProviderType).toBe("opencode");

    const verify = await bootstrapDatabase(dbPath);
    try {
      const agents = await listAgents(verify.db, result.companyId);
      expect(agents).toHaveLength(1);
      expect(agents[0]?.providerType).toBe("opencode");
      expect(agents[0]?.runtimeModel === null || agents[0]?.runtimeModel.includes("/")).toBe(true);
    } finally {
      await verify.client.close?.();
    }
  });

  test("uses BOPO_OPENCODE_MODEL override during opencode onboarding seed", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "bopo-onboard-seed-"));
    cleanupDirs.push(tempDir);
    const dbPath = join(tempDir, "seed.db");
    const previous = process.env.BOPO_OPENCODE_MODEL;
    process.env.BOPO_OPENCODE_MODEL = "opencode/big-pickle";
    try {
      const result = await ensureOnboardingSeed({
        dbPath,
        companyName: "OpenCode Model Override Co",
        agentProvider: "opencode"
      });

      const verify = await bootstrapDatabase(dbPath);
      try {
        const agents = await listAgents(verify.db, result.companyId);
        expect(agents).toHaveLength(1);
        expect(agents[0]?.providerType).toBe("opencode");
        expect(agents[0]?.runtimeModel).toBe("opencode/big-pickle");
      } finally {
        await verify.client.close?.();
      }
    } finally {
      if (previous === undefined) {
        delete process.env.BOPO_OPENCODE_MODEL;
      } else {
        process.env.BOPO_OPENCODE_MODEL = previous;
      }
    }
  });
});
