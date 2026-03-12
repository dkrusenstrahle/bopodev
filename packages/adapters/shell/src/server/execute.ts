import type { HeartbeatContext, AdapterExecutionResult } from "../../../../agent-sdk/src/types";
import { createSkippedResult, GenericHeartbeatAdapter } from "../../../../agent-sdk/src/adapters";

export async function execute(context: HeartbeatContext): Promise<AdapterExecutionResult> {
  if (context.workItems.length === 0) {
    return createSkippedResult("Shell", "shell", context);
  }
  const adapter = new GenericHeartbeatAdapter("shell");
  return adapter.execute(context);
}
