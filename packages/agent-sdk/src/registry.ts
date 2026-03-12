import type {
  AdapterEnvironmentResult,
  AdapterMetadata,
  AdapterModule,
  AdapterModelOption,
  AgentAdapter,
  AgentProviderType,
  AgentRuntimeConfig
} from "./types";
import { codexAdapterModule } from "../../adapters/codex/src";
import { claudecodeAdapterModule } from "../../adapters/claude-code/src";
import { cursorAdapterModule } from "../../adapters/cursor/src";
import { opencodeAdapterModule } from "../../adapters/opencode/src";
import { geminiCliAdapterModule } from "../../adapters/gemini-cli/src";
import { openaiapiAdapterModule } from "../../adapters/openai-api/src";
import { anthropicapiAdapterModule } from "../../adapters/anthropic-api/src";
import { httpAdapterModule } from "../../adapters/http/src";
import { shellAdapterModule } from "../../adapters/shell/src";

const adapterModules: Record<AgentProviderType, AdapterModule> = {
  claude_code: claudecodeAdapterModule,
  codex: codexAdapterModule,
  cursor: cursorAdapterModule,
  opencode: opencodeAdapterModule,
  gemini_cli: geminiCliAdapterModule,
  openai_api: openaiapiAdapterModule,
  anthropic_api: anthropicapiAdapterModule,
  http: httpAdapterModule,
  shell: shellAdapterModule
};

export function getRegisteredAdapterModules(): Record<AgentProviderType, AdapterModule> {
  return adapterModules;
}

const adapters: Record<AgentProviderType, AgentAdapter> = {
  claude_code: {
    providerType: "claude_code",
    execute: (context) => adapterModules.claude_code.server.execute(context)
  },
  codex: {
    providerType: "codex",
    execute: (context) => adapterModules.codex.server.execute(context)
  },
  cursor: {
    providerType: "cursor",
    execute: (context) => adapterModules.cursor.server.execute(context)
  },
  opencode: {
    providerType: "opencode",
    execute: (context) => adapterModules.opencode.server.execute(context)
  },
  gemini_cli: {
    providerType: "gemini_cli",
    execute: (context) => adapterModules.gemini_cli.server.execute(context)
  },
  openai_api: {
    providerType: "openai_api",
    execute: (context) => adapterModules.openai_api.server.execute(context)
  },
  anthropic_api: {
    providerType: "anthropic_api",
    execute: (context) => adapterModules.anthropic_api.server.execute(context)
  },
  http: {
    providerType: "http",
    execute: (context) => adapterModules.http.server.execute(context)
  },
  shell: {
    providerType: "shell",
    execute: (context) => adapterModules.shell.server.execute(context)
  }
};

export function resolveAdapter(providerType: AgentProviderType) {
  return adapters[providerType];
}

export async function getAdapterModels(
  providerType: AgentProviderType,
  runtime?: AgentRuntimeConfig
): Promise<AdapterModelOption[]> {
  const fromModule = await adapterModules[providerType].server.listModels?.(runtime);
  if (fromModule) {
    return fromModule;
  }
  return adapterModules[providerType].models ? [...adapterModules[providerType].models] : [];
}

export function getAdapterMetadata(): AdapterMetadata[] {
  return Object.values(adapterModules).map((module) => module.metadata);
}

export async function runAdapterEnvironmentTest(
  providerType: AgentProviderType,
  runtime?: AgentRuntimeConfig
): Promise<AdapterEnvironmentResult> {
  const testEnvironment = adapterModules[providerType].server.testEnvironment;
  if (testEnvironment) {
    return testEnvironment(runtime);
  }
  return {
    providerType,
    status: "warn",
    testedAt: new Date().toISOString(),
    checks: [{ code: "test_environment_unavailable", level: "warn", message: "Adapter does not expose testEnvironment." }]
  };
}
