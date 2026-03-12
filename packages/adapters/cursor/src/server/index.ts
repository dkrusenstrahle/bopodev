import type { AgentRuntimeConfig, AdapterEnvironmentResult, AdapterModelOption } from "../../../../agent-sdk/src/types";
import { execute } from "./execute";
import { testEnvironment } from "./test";
import { dedupeModels, discoverCursorModels } from "../../../../agent-sdk/src/adapters";
import { models } from "../index";

export { execute, testEnvironment };
export * from "./parse";

export async function listModels(runtime?: AgentRuntimeConfig): Promise<AdapterModelOption[]> {
  const discovered = await discoverCursorModels(runtime);
  return dedupeModels([...discovered, ...models]);
}
