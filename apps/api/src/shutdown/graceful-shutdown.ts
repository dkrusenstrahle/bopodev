import type { Server } from "node:http";
import type { RealtimeHub } from "../realtime/hub";
import { beginIssueCommentDispatchShutdown, waitForIssueCommentDispatchDrain } from "../services/comment-recipient-dispatch-service";
import { beginHeartbeatQueueShutdown, waitForHeartbeatQueueDrain } from "../services/heartbeat-queue-service";

export async function closeDatabaseClient(client: unknown) {
  if (!client || typeof client !== "object") {
    return;
  }
  const closeFn = (client as { close?: unknown }).close;
  if (typeof closeFn !== "function") {
    return;
  }
  await (closeFn as () => Promise<void>)();
}

export function attachGracefulShutdownHandlers(options: {
  server: Server;
  realtimeHub: RealtimeHub;
  dbClient: unknown;
  scheduler?: { stop: () => Promise<void> };
  pluginWorkers?: { shutdown: () => Promise<void> };
}) {
  const { server, realtimeHub, dbClient, scheduler, pluginWorkers } = options;
  let shutdownInFlight: Promise<void> | null = null;

  function shutdown(signal: string) {
    const shutdownTimeoutMs = Number(process.env.BOPO_SHUTDOWN_TIMEOUT_MS ?? 15_000);
    const forcedExit = setTimeout(() => {
      // eslint-disable-next-line no-console
      console.error(`[shutdown] timed out after ${shutdownTimeoutMs}ms; forcing exit.`);
      process.exit(process.exitCode ?? 1);
    }, shutdownTimeoutMs);
    forcedExit.unref();
    shutdownInFlight ??= (async () => {
      // eslint-disable-next-line no-console
      console.log(`[shutdown] ${signal} — draining HTTP/background work before closing the embedded database…`);
      beginHeartbeatQueueShutdown();
      beginIssueCommentDispatchShutdown();
      await Promise.allSettled([
        scheduler?.stop() ?? Promise.resolve(),
        pluginWorkers?.shutdown() ?? Promise.resolve(),
        new Promise<void>((resolve, reject) => {
          server.close((err) => {
            if (err) {
              reject(err);
              return;
            }
            resolve();
          });
        })
      ]);
      await Promise.allSettled([waitForHeartbeatQueueDrain(), waitForIssueCommentDispatchDrain()]);
      try {
        await realtimeHub.close();
      } catch (closeError) {
        // eslint-disable-next-line no-console
        console.error("[shutdown] realtime hub close error", closeError);
      }
      try {
        await closeDatabaseClient(dbClient);
      } catch (closeDbError) {
        // eslint-disable-next-line no-console
        console.error("[shutdown] database close error", closeDbError);
      }
      // eslint-disable-next-line no-console
      console.log("[shutdown] clean exit");
      process.exitCode = 0;
    })().catch((error) => {
      // eslint-disable-next-line no-console
      console.error("[shutdown] failed", error);
      process.exitCode = 1;
    });
    return shutdownInFlight;
  }

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}
