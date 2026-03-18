import type { BopoDb } from "bopodev-db";
import type { RealtimeHub } from "../realtime/hub";
import { runHeartbeatSweep } from "../services/heartbeat-service";
import { runHeartbeatQueueSweep } from "../services/heartbeat-queue-service";
import { runIssueCommentDispatchSweep } from "../services/comment-recipient-dispatch-service";

export function createHeartbeatScheduler(db: BopoDb, companyId: string, realtimeHub?: RealtimeHub) {
  const heartbeatIntervalMs = Number(process.env.BOPO_HEARTBEAT_SWEEP_MS ?? 60_000);
  const queueIntervalMs = Number(process.env.BOPO_HEARTBEAT_QUEUE_SWEEP_MS ?? 2_000);
  const commentDispatchIntervalMs = Number(process.env.BOPO_COMMENT_DISPATCH_SWEEP_MS ?? 3_000);
  let heartbeatRunning = false;
  let queueRunning = false;
  let commentDispatchRunning = false;
  const heartbeatTimer = setInterval(() => {
    if (heartbeatRunning) {
      return;
    }
    heartbeatRunning = true;
    void runHeartbeatSweep(db, companyId, { realtimeHub })
      .catch((error) => {
        // eslint-disable-next-line no-console
        console.error("[scheduler] heartbeat sweep failed", error);
      })
      .finally(() => {
        heartbeatRunning = false;
      });
  }, heartbeatIntervalMs);
  const queueTimer = setInterval(() => {
    if (queueRunning) {
      return;
    }
    queueRunning = true;
    void runHeartbeatQueueSweep(db, companyId, { realtimeHub })
      .catch((error) => {
        // eslint-disable-next-line no-console
        console.error("[scheduler] queue sweep failed", error);
      })
      .finally(() => {
        queueRunning = false;
      });
  }, queueIntervalMs);
  const commentDispatchTimer = setInterval(() => {
    if (commentDispatchRunning) {
      return;
    }
    commentDispatchRunning = true;
    void runIssueCommentDispatchSweep(db, companyId, { realtimeHub })
      .catch((error) => {
        // eslint-disable-next-line no-console
        console.error("[scheduler] comment dispatch sweep failed", error);
      })
      .finally(() => {
        commentDispatchRunning = false;
      });
  }, commentDispatchIntervalMs);
  return () => {
    clearInterval(heartbeatTimer);
    clearInterval(queueTimer);
    clearInterval(commentDispatchTimer);
  };
}
