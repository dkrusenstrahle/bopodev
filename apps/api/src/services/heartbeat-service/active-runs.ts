import type { ActiveHeartbeatRun } from "./types";

const activeHeartbeatRuns = new Map<string, ActiveHeartbeatRun>();

export function registerActiveHeartbeatRun(runId: string, run: ActiveHeartbeatRun) {
  activeHeartbeatRuns.set(runId, run);
}

export function unregisterActiveHeartbeatRun(runId: string) {
  activeHeartbeatRuns.delete(runId);
}

export function getActiveHeartbeatRun(runId: string) {
  return activeHeartbeatRuns.get(runId);
}
