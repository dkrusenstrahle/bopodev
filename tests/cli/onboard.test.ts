import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { runOnboardFlow } from "../../packages/cli/src/commands/onboard";

describe("bopo onboard flow", () => {
  const cleanup: Array<() => void> = [];
  const originalEnv = {
    BOPO_CLI_WORKSPACE_ROOT: process.env.BOPO_CLI_WORKSPACE_ROOT,
    BOPO_INSTANCE_ROOT: process.env.BOPO_INSTANCE_ROOT,
    BOPO_HOME: process.env.BOPO_HOME,
    BOPO_INSTANCE_ID: process.env.BOPO_INSTANCE_ID,
    BOPO_REPO_URL: process.env.BOPO_REPO_URL,
    BOPO_REPO_REF: process.env.BOPO_REPO_REF
  };

  afterEach(() => {
    while (cleanup.length > 0) {
      const fn = cleanup.pop();
      fn?.();
    }
    restoreManagedWorkspaceEnv();
  });

  function restoreManagedWorkspaceEnv() {
    if (originalEnv.BOPO_CLI_WORKSPACE_ROOT === undefined) {
      delete process.env.BOPO_CLI_WORKSPACE_ROOT;
    } else {
      process.env.BOPO_CLI_WORKSPACE_ROOT = originalEnv.BOPO_CLI_WORKSPACE_ROOT;
    }
    if (originalEnv.BOPO_INSTANCE_ROOT === undefined) {
      delete process.env.BOPO_INSTANCE_ROOT;
    } else {
      process.env.BOPO_INSTANCE_ROOT = originalEnv.BOPO_INSTANCE_ROOT;
    }
    if (originalEnv.BOPO_HOME === undefined) {
      delete process.env.BOPO_HOME;
    } else {
      process.env.BOPO_HOME = originalEnv.BOPO_HOME;
    }
    if (originalEnv.BOPO_INSTANCE_ID === undefined) {
      delete process.env.BOPO_INSTANCE_ID;
    } else {
      process.env.BOPO_INSTANCE_ID = originalEnv.BOPO_INSTANCE_ID;
    }
    if (originalEnv.BOPO_REPO_URL === undefined) {
      delete process.env.BOPO_REPO_URL;
    } else {
      process.env.BOPO_REPO_URL = originalEnv.BOPO_REPO_URL;
    }
    if (originalEnv.BOPO_REPO_REF === undefined) {
      delete process.env.BOPO_REPO_REF;
    } else {
      process.env.BOPO_REPO_REF = originalEnv.BOPO_REPO_REF;
    }
  }

  test("bootstraps workspace and prints doctor summary", async () => {
    const workspace = await createWorkspace();
    const logs = captureStdout();
    cleanup.push(() => logs.restore());

    const installDependencies = vi.fn(async () => {});
    const initializeDatabase = vi.fn(async () => {});
    const seedOnboardingDatabase = vi.fn(async () => ({
      companyId: "company-123",
      companyName: "Acme AI",
      companyCreated: true,
      ceoCreated: true,
      ceoProviderType: "codex" as const,
      ceoRuntimeModel: "gpt-5",
      ceoMigrated: false
    }));
    const startServices = vi.fn(async () => 0);
    const runDoctor = vi.fn(async () => [
      { label: "Node.js", ok: true, details: "ok" },
      { label: "pnpm", ok: true, details: "ok" }
    ]);
    const promptForCompanyName = vi.fn(async () => "Acme AI");
    const promptForAgentProvider = vi.fn(async () => "codex" as const);
    const promptForAgentModel = vi.fn(async () => "gpt-5");

    const result = await runOnboardFlow(
      { cwd: workspace, yes: true, start: false, forceInstall: false },
      {
        installDependencies,
        initializeDatabase,
        seedOnboardingDatabase,
        startServices,
        runDoctor,
        promptForCompanyName,
        promptForAgentProvider,
        promptForAgentModel
      }
    );

    expect(result.workspaceRoot).toBe(workspace);
    expect(result.envCreated).toBe(true);
    expect(result.dbInitialized).toBe(true);
    expect(installDependencies).toHaveBeenCalledTimes(1);
    expect(initializeDatabase).toHaveBeenCalledTimes(1);
    expect(seedOnboardingDatabase).toHaveBeenCalledWith(workspace, {
      dbPath: undefined,
      companyName: "Acme AI",
      companyId: undefined,
      agentProvider: "codex"
    });
    expect(startServices).not.toHaveBeenCalled();
    expect(promptForCompanyName).toHaveBeenCalledTimes(1);

    const envContent = await readFile(join(workspace, ".env"), "utf8");
    expect(envContent).toContain("NEXT_PUBLIC_API_URL=http://localhost:4020");
    expect(envContent).toContain("BOPO_DEFAULT_COMPANY_NAME=\"Acme AI\"");
    expect(envContent).toContain("BOPO_DEFAULT_COMPANY_ID=company-123");
    expect(envContent).toContain("NEXT_PUBLIC_DEFAULT_COMPANY_ID=company-123");
    expect(envContent).toContain("BOPO_DEFAULT_AGENT_PROVIDER=codex");
    expect(logs.output).toContain("| Mode");
    expect(logs.output).toContain("Default company");
    expect(logs.output).toContain("Primary agent framework");
  });

  test("keeps existing .env in place", async () => {
    const workspace = await createWorkspace();
    await writeFile(
      join(workspace, ".env"),
      "EXISTING=1\nBOPO_DEFAULT_COMPANY_NAME=\"Acme AI\"\nBOPO_DEFAULT_AGENT_PROVIDER=codex\n",
      "utf8"
    );
    const promptForCompanyName = vi.fn(async () => "Unused Name");
    const promptForAgentProvider = vi.fn(async () => "shell" as const);
    const promptForAgentModel = vi.fn(async () => "gpt-5");

    await runOnboardFlow(
      { cwd: workspace, yes: true, start: false, forceInstall: false },
      {
        installDependencies: async () => {},
        initializeDatabase: async () => {},
        seedOnboardingDatabase: async () => ({
          companyId: "company-123",
          companyName: "Acme AI",
          companyCreated: false,
          ceoCreated: false,
          ceoProviderType: "codex" as const,
          ceoRuntimeModel: "gpt-5",
          ceoMigrated: false
        }),
        startServices: async () => 0,
        runDoctor: async () => [],
        promptForCompanyName,
        promptForAgentProvider,
        promptForAgentModel
      }
    );

    const envContent = await readFile(join(workspace, ".env"), "utf8");
    expect(envContent).toContain("EXISTING=1");
    expect(envContent).toContain("BOPO_DEFAULT_COMPANY_NAME=\"Acme AI\"");
    expect(envContent).toContain("BOPO_DEFAULT_COMPANY_ID=company-123");
    expect(envContent).toContain("BOPO_DEFAULT_AGENT_PROVIDER=codex");
    expect(promptForCompanyName).not.toHaveBeenCalled();
    expect(promptForAgentProvider).not.toHaveBeenCalled();
  });

  test("skips install when node_modules already exists", async () => {
    const workspace = await createWorkspace();
    await writeFile(join(workspace, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
    await mkdir(join(workspace, "node_modules"), { recursive: true });
    await writeFile(join(workspace, "node_modules", ".modules.yaml"), "hoistPattern: []\n", "utf8");

    const installDependencies = vi.fn(async () => {});
    await runOnboardFlow(
      { cwd: workspace, yes: true, start: false, forceInstall: false },
      {
        installDependencies,
        initializeDatabase: async () => {},
        seedOnboardingDatabase: async () => ({
          companyId: "company-123",
          companyName: "Acme AI",
          companyCreated: false,
          ceoCreated: false,
          ceoProviderType: "shell" as const,
          ceoRuntimeModel: "gpt-5",
          ceoMigrated: false
        }),
        startServices: async () => 0,
        runDoctor: async () => [],
        promptForCompanyName: async () => "Acme AI",
        promptForAgentProvider: async () => "shell" as const,
        promptForAgentModel: async () => "gpt-5"
      }
    );

    expect(installDependencies).not.toHaveBeenCalled();
  });

  test("reruns skip the company-name prompt when already configured", async () => {
    const workspace = await createWorkspace();
    await writeFile(
      join(workspace, ".env"),
      'NEXT_PUBLIC_API_URL=http://localhost:4020\nBOPO_DEFAULT_COMPANY_NAME="Existing Co"\nBOPO_DEFAULT_COMPANY_ID=company-789\nBOPO_DEFAULT_AGENT_PROVIDER=codex\n',
      "utf8"
    );
    const promptForCompanyName = vi.fn(async () => "Unused Name");
    const promptForAgentProvider = vi.fn(async () => "shell" as const);
    const promptForAgentModel = vi.fn(async () => "gpt-5");
    const seedOnboardingDatabase = vi.fn(async () => ({
      companyId: "company-789",
      companyName: "Existing Co",
      companyCreated: false,
      ceoCreated: false,
      ceoProviderType: "codex" as const,
      ceoRuntimeModel: "gpt-5",
      ceoMigrated: false
    }));

    await runOnboardFlow(
      { cwd: workspace, yes: true, start: false, forceInstall: false },
      {
        installDependencies: async () => {},
        initializeDatabase: async () => {},
        seedOnboardingDatabase,
        startServices: async () => 0,
        runDoctor: async () => [],
        promptForCompanyName,
        promptForAgentProvider,
        promptForAgentModel
      }
    );

    expect(promptForCompanyName).not.toHaveBeenCalled();
    expect(seedOnboardingDatabase).toHaveBeenCalledWith(workspace, {
      dbPath: undefined,
      companyName: "Existing Co",
      companyId: "company-789",
      agentProvider: "codex"
    });
    expect(promptForAgentProvider).not.toHaveBeenCalled();
  });

  test("prompts for a replacement provider when env still points to hidden cursor", async () => {
    const workspace = await createWorkspace();
    await writeFile(
      join(workspace, ".env"),
      'NEXT_PUBLIC_API_URL=http://localhost:4020\nBOPO_DEFAULT_COMPANY_NAME="Cursor Co"\nBOPO_DEFAULT_COMPANY_ID=company-cursor\nBOPO_DEFAULT_AGENT_PROVIDER=cursor\n',
      "utf8"
    );
    const promptForAgentProvider = vi.fn(async () => "shell" as const);
    const promptForAgentModel = vi.fn(async () => "gpt-5");
    const seedOnboardingDatabase = vi.fn(async () => ({
      companyId: "company-cursor",
      companyName: "Cursor Co",
      companyCreated: false,
      ceoCreated: false,
      ceoProviderType: "shell" as const,
      ceoRuntimeModel: "gpt-5",
      ceoMigrated: false
    }));

    await runOnboardFlow(
      { cwd: workspace, yes: true, start: false, forceInstall: false },
      {
        installDependencies: async () => {},
        initializeDatabase: async () => {},
        seedOnboardingDatabase,
        startServices: async () => 0,
        runDoctor: async () => [],
        promptForCompanyName: async () => "Unused Name",
        promptForAgentProvider,
        promptForAgentModel
      }
    );

    expect(promptForAgentProvider).toHaveBeenCalledTimes(1);
    expect(seedOnboardingDatabase).toHaveBeenCalledWith(workspace, {
      dbPath: undefined,
      companyName: "Cursor Co",
      companyId: "company-cursor",
      agentProvider: "shell"
    });
  });

  test("creates .env with defaults when .env.example is missing", async () => {
    const workspace = await createWorkspace({ includeEnvExample: false });

    await runOnboardFlow(
      { cwd: workspace, yes: true, start: false, forceInstall: false },
      {
        installDependencies: async () => {},
        initializeDatabase: async () => {},
        seedOnboardingDatabase: async () => ({
          companyId: "company-123",
          companyName: "Acme AI",
          companyCreated: true,
          ceoCreated: true,
          ceoProviderType: "codex" as const,
          ceoRuntimeModel: "gpt-5",
          ceoMigrated: false
        }),
        startServices: async () => 0,
        runDoctor: async () => [],
        promptForCompanyName: async () => "Acme AI",
        promptForAgentProvider: async () => "codex" as const,
        promptForAgentModel: async () => "gpt-5"
      }
    );

    const envContent = await readFile(join(workspace, ".env"), "utf8");
    expect(envContent).toContain("NEXT_PUBLIC_API_URL=http://localhost:4020");
    expect(envContent).toContain('BOPO_DEFAULT_COMPANY_NAME="Acme AI"');
    expect(envContent).toContain("BOPO_DEFAULT_AGENT_PROVIDER=codex");
  });

  test("passes selected template through onboarding and uses strict seed mode", async () => {
    const workspace = await createWorkspace();
    const logs = captureStdout();
    cleanup.push(() => logs.restore());
    const seedOnboardingDatabase = vi.fn(async () => ({
      companyId: "company-123",
      companyName: "Acme AI",
      companyCreated: true,
      ceoCreated: false,
      ceoProviderType: "codex" as const,
      ceoRuntimeModel: "gpt-5",
      ceoMigrated: false,
      templateApplied: true,
      templateId: "template-123"
    }));

    await runOnboardFlow(
      {
        cwd: workspace,
        yes: true,
        start: false,
        forceInstall: false,
        template: "founder-startup-basic"
      },
      {
        installDependencies: async () => {},
        initializeDatabase: async () => {},
        seedOnboardingDatabase,
        startServices: async () => 0,
        runDoctor: async () => [],
        promptForCompanyName: async () => "Acme AI",
        promptForAgentProvider: async () => "codex" as const,
        promptForAgentModel: async () => "gpt-5"
      }
    );

    expect(seedOnboardingDatabase).toHaveBeenCalledWith(workspace, {
      dbPath: undefined,
      companyName: "Acme AI",
      companyId: undefined,
      agentProvider: "codex",
      templateId: "founder-startup-basic"
    });
    expect(logs.output).toContain("Seed mode");
    expect(logs.output).toContain("Template-only (strict)");
  });

  test("fails fast when selected onboarding template cannot be applied", async () => {
    const workspace = await createWorkspace();
    await expect(
      runOnboardFlow(
        {
          cwd: workspace,
          yes: true,
          start: false,
          forceInstall: false,
          template: "missing-template"
        },
        {
          installDependencies: async () => {},
          initializeDatabase: async () => {},
          seedOnboardingDatabase: async () => {
            throw new Error("Requested onboarding template 'missing-template' was not found.");
          },
          startServices: async () => 0,
          runDoctor: async () => [],
          promptForCompanyName: async () => "Acme AI",
          promptForAgentProvider: async () => "codex" as const,
          promptForAgentModel: async () => "gpt-5"
        }
      )
    ).rejects.toThrow("missing-template");
  });

  test("uses managed workspace fallback when launched outside a repo", async () => {
    const managedWorkspace = await createWorkspace();
    const nonWorkspaceCwd = await mkdtemp(join(tmpdir(), "bopo-cli-cwd-"));
    process.env.BOPO_CLI_WORKSPACE_ROOT = managedWorkspace;

    const installDependencies = vi.fn(async () => {});
    const initializeDatabase = vi.fn(async () => {});
    const seedOnboardingDatabase = vi.fn(async () => ({
      companyId: "company-123",
      companyName: "Acme AI",
      companyCreated: true,
      ceoCreated: true,
      ceoProviderType: "codex" as const,
      ceoRuntimeModel: "gpt-5",
      ceoMigrated: false
    }));

    const result = await runOnboardFlow(
      { cwd: nonWorkspaceCwd, yes: true, start: false, forceInstall: false },
      {
        installDependencies,
        initializeDatabase,
        seedOnboardingDatabase,
        startServices: async () => 0,
        runDoctor: async () => [],
        promptForCompanyName: async () => "Acme AI",
        promptForAgentProvider: async () => "codex" as const,
        promptForAgentModel: async () => "gpt-5"
      }
    );

    expect(result.workspaceRoot).toBe(managedWorkspace);
    expect(installDependencies).toHaveBeenCalledTimes(1);
    expect(initializeDatabase).toHaveBeenCalledTimes(1);
    expect(seedOnboardingDatabase).toHaveBeenCalledWith(managedWorkspace, {
      dbPath: undefined,
      companyName: "Acme AI",
      companyId: undefined,
      agentProvider: "codex"
    });
  });
});

async function createWorkspace(options?: { includeEnvExample?: boolean }) {
  const includeEnvExample = options?.includeEnvExample ?? true;
  const workspace = await mkdtemp(join(tmpdir(), "bopo-cli-test-"));
  await writeFile(join(workspace, "pnpm-workspace.yaml"), "packages:\n  - apps/*\n", "utf8");
  await writeFile(join(workspace, "package.json"), '{"name":"test-workspace"}\n', "utf8");
  if (includeEnvExample) {
    await writeFile(join(workspace, ".env.example"), "NEXT_PUBLIC_API_URL=http://localhost:4020\n", "utf8");
  }
  return workspace;
}

function captureStdout() {
  let output = "";
  const spy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
    output += String(chunk);
    return true;
  }) as typeof process.stdout.write);

  return {
    get output() {
      return output;
    },
    restore() {
      spy.mockRestore();
    }
  };
}
