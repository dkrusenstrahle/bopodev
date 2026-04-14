import type { AdapterMetadata, AdapterModule } from "../../../agent-sdk/src/types";
import * as server from "./server/index";
import * as ui from "./ui/index";
import * as cli from "./cli/index";

export const type = "hermes_local" as const;
export const label = "Hermes";
export const models = [
  {
    id: "auto",
    label: "Auto"
  }
] as const;
export const agentConfigurationDoc = `Use when:
- You need Hermes CLI execution in a local workspace.
- You want adapter metadata, model listing, and runtime preflight support.

Do not use when:
- Hermes CLI is unavailable on the host.
- You only need direct provider API execution.`;

export const metadata: AdapterMetadata = {
  providerType: type,
  label,
  supportsModelSelection: true,
  supportsEnvironmentTest: true,
  supportsWebSearch: false,
  supportsThinkingEffort: false,
  requiresRuntimeCwd: true
};

export const hermesLocalAdapterModule: AdapterModule = {
  type,
  label,
  metadata,
  models: [...models],
  agentConfigurationDoc,
  server: { type, execute: server.execute, listModels: server.listModels, testEnvironment: server.testEnvironment },
  ui: { type, parseStdoutLine: ui.parseStdoutLine, buildAdapterConfig: ui.buildAdapterConfig },
  cli: { type, formatStdoutEvent: cli.formatStdoutEvent }
};
