import type { RealtimeHub } from "../../realtime/hub";
import { createHeartbeatRunsRealtimeEvent } from "../../realtime/heartbeat-runs";

export function publishHeartbeatRunStatus(
  realtimeHub: RealtimeHub | undefined,
  input: {
    companyId: string;
    runId: string;
    status: "started" | "completed" | "failed" | "skipped";
    message?: string | null;
    startedAt?: Date;
    finishedAt?: Date;
  }
) {
  if (!realtimeHub) {
    return;
  }
  realtimeHub.publish(
    createHeartbeatRunsRealtimeEvent(input.companyId, {
      type: "run.status.updated",
      runId: input.runId,
      status: input.status,
      message: input.message ?? null,
      startedAt: input.startedAt?.toISOString(),
      finishedAt: input.finishedAt?.toISOString() ?? null
    })
  );
}
