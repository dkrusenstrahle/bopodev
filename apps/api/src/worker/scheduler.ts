import type { BopoDb } from "bopodev-db";
import type { RealtimeHub } from "../realtime/hub";
import { runHeartbeatSweep } from "../services/heartbeat-service";
import { runHeartbeatQueueSweep } from "../services/heartbeat-queue-service";
import { runIssueCommentDispatchSweep } from "../services/comment-recipient-dispatch-service";
import { runLoopSweep } from "../services/work-loop-service";
import { runPluginJobSweep } from "../services/plugin-jobs-service";

export type HeartbeatSchedulerHandle = {
  stop: () => Promise<void>;
};

export function createHeartbeatScheduler(db: BopoDb, companyId: string, realtimeHub?: RealtimeHub) {
  const heartbeatIntervalMs = Number(process.env.BOPO_HEARTBEAT_SWEEP_MS ?? 60_000);
  const queueIntervalMs = Number(process.env.BOPO_HEARTBEAT_QUEUE_SWEEP_MS ?? 2_000);
  const commentDispatchIntervalMs = Number(process.env.BOPO_COMMENT_DISPATCH_SWEEP_MS ?? 3_000);
  const loopSweepIntervalMs = Number(process.env.BOPO_LOOP_SWEEP_MS ?? 60_000);
  const pluginJobSweepIntervalMs = Number(process.env.BOPO_PLUGIN_JOB_SWEEP_MS ?? 60_000);
  const loopSweepEnabled = (process.env.BOPO_LOOP_SWEEP_ENABLED ?? "1").trim() !== "0";
  let heartbeatRunning = false;
  let queueRunning = false;
  let commentDispatchRunning = false;
  let loopSweepRunning = false;
  let pluginJobSweepRunning = false;
  let heartbeatPromise: Promise<unknown> | null = null;
  let queuePromise: Promise<unknown> | null = null;
  let commentDispatchPromise: Promise<unknown> | null = null;
  let loopSweepPromise: Promise<unknown> | null = null;
  let pluginJobSweepPromise: Promise<unknown> | null = null;
  const heartbeatTimer = setInterval(() => {
    if (heartbeatRunning) {
      return;
    }
    heartbeatRunning = true;
    heartbeatPromise = runHeartbeatSweep(db, companyId, { realtimeHub })
      .catch((error) => {
        // eslint-disable-next-line no-console
        console.error("[scheduler] heartbeat sweep failed", error);
      })
      .finally(() => {
        heartbeatRunning = false;
        heartbeatPromise = null;
      });
  }, heartbeatIntervalMs);
  const queueTimer = setInterval(() => {
    if (queueRunning) {
      return;
    }
    queueRunning = true;
    queuePromise = runHeartbeatQueueSweep(db, companyId, { realtimeHub })
      .catch((error) => {
        // eslint-disable-next-line no-console
        console.error("[scheduler] queue sweep failed", error);
      })
      .finally(() => {
        queueRunning = false;
        queuePromise = null;
      });
  }, queueIntervalMs);
  const commentDispatchTimer = setInterval(() => {
    if (commentDispatchRunning) {
      return;
    }
    commentDispatchRunning = true;
    commentDispatchPromise = runIssueCommentDispatchSweep(db, companyId, { realtimeHub })
      .catch((error) => {
        // eslint-disable-next-line no-console
        console.error("[scheduler] comment dispatch sweep failed", error);
      })
      .finally(() => {
        commentDispatchRunning = false;
        commentDispatchPromise = null;
      });
  }, commentDispatchIntervalMs);
  const loopSweepTimer = loopSweepEnabled
    ? setInterval(() => {
        if (loopSweepRunning) {
          return;
        }
        loopSweepRunning = true;
        loopSweepPromise = runLoopSweep(db, companyId, { realtimeHub })
          .catch((error) => {
            // eslint-disable-next-line no-console
            console.error("[scheduler] work loop sweep failed", error);
          })
          .finally(() => {
            loopSweepRunning = false;
            loopSweepPromise = null;
          });
      }, loopSweepIntervalMs)
    : null;
  const pluginJobTimer = setInterval(() => {
    if (pluginJobSweepRunning) {
      return;
    }
    pluginJobSweepRunning = true;
    pluginJobSweepPromise = runPluginJobSweep(db, companyId)
      .catch((error) => {
        // eslint-disable-next-line no-console
        console.error("[scheduler] plugin job sweep failed", error);
      })
      .finally(() => {
        pluginJobSweepRunning = false;
        pluginJobSweepPromise = null;
      });
  }, pluginJobSweepIntervalMs);
  const stop = async () => {
    clearInterval(heartbeatTimer);
    clearInterval(queueTimer);
    clearInterval(commentDispatchTimer);
    if (loopSweepTimer) {
      clearInterval(loopSweepTimer);
    }
    clearInterval(pluginJobTimer);
    await Promise.allSettled(
      [heartbeatPromise, queuePromise, commentDispatchPromise, loopSweepPromise, pluginJobSweepPromise].filter(
        (promise): promise is Promise<unknown> => promise !== null
      )
    );
  };
  return { stop } satisfies HeartbeatSchedulerHandle;
}
