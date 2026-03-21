import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bootstrapDatabase, createCompany, listCompanies } from "../packages/db/src";

describe("restart lifecycle", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanupDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("reopens the same database path after a clean close", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "bopodev-restart-db-"));
    cleanupDirs.push(tempDir);
    const dbPath = join(tempDir, "test.db");

    const firstBoot = await bootstrapDatabase(dbPath);
    try {
      await createCompany(firstBoot.db, { name: "Restart Co" });
    } finally {
      await firstBoot.client?.close?.();
    }

    const secondBoot = await bootstrapDatabase(dbPath);
    try {
      const companies = await listCompanies(secondBoot.db);
      expect(companies).toHaveLength(1);
      expect(companies[0]?.name).toBe("Restart Co");
    } finally {
      await secondBoot.client?.close?.();
    }
  });
});

describe("scheduler shutdown", () => {
  const envSnapshot = {
    heartbeat: process.env.BOPO_HEARTBEAT_SWEEP_MS,
    queue: process.env.BOPO_HEARTBEAT_QUEUE_SWEEP_MS,
    comment: process.env.BOPO_COMMENT_DISPATCH_SWEEP_MS
  };

  beforeEach(() => {
    vi.resetModules();
    process.env.BOPO_HEARTBEAT_SWEEP_MS = "5";
    process.env.BOPO_HEARTBEAT_QUEUE_SWEEP_MS = "5";
    process.env.BOPO_COMMENT_DISPATCH_SWEEP_MS = "5";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (envSnapshot.heartbeat === undefined) {
      delete process.env.BOPO_HEARTBEAT_SWEEP_MS;
    } else {
      process.env.BOPO_HEARTBEAT_SWEEP_MS = envSnapshot.heartbeat;
    }
    if (envSnapshot.queue === undefined) {
      delete process.env.BOPO_HEARTBEAT_QUEUE_SWEEP_MS;
    } else {
      process.env.BOPO_HEARTBEAT_QUEUE_SWEEP_MS = envSnapshot.queue;
    }
    if (envSnapshot.comment === undefined) {
      delete process.env.BOPO_COMMENT_DISPATCH_SWEEP_MS;
    } else {
      process.env.BOPO_COMMENT_DISPATCH_SWEEP_MS = envSnapshot.comment;
    }
  });

  it("waits for in-flight sweeps before resolving stop", async () => {
    let resolveHeartbeat!: () => void;
    let resolveQueue!: () => void;
    let resolveComment!: () => void;
    const heartbeatPromise = new Promise<void>((resolve) => {
      resolveHeartbeat = resolve;
    });
    const queuePromise = new Promise<void>((resolve) => {
      resolveQueue = resolve;
    });
    const commentPromise = new Promise<void>((resolve) => {
      resolveComment = resolve;
    });
    const runHeartbeatSweep = vi.fn(() => heartbeatPromise);
    const runHeartbeatQueueSweep = vi.fn(() => queuePromise);
    const runIssueCommentDispatchSweep = vi.fn(() => commentPromise);

    vi.doMock("../apps/api/src/services/heartbeat-service", () => ({
      runHeartbeatSweep
    }));
    vi.doMock("../apps/api/src/services/heartbeat-queue-service", () => ({
      runHeartbeatQueueSweep
    }));
    vi.doMock("../apps/api/src/services/comment-recipient-dispatch-service", () => ({
      runIssueCommentDispatchSweep
    }));

    const { createHeartbeatScheduler } = await import("../apps/api/src/worker/scheduler");
    const scheduler = createHeartbeatScheduler({} as any, "company-id");
    await sleep(25);

    const stopPromise = scheduler.stop();
    let stopped = false;
    void stopPromise.then(() => {
      stopped = true;
    });

    await sleep(0);
    expect(stopped).toBe(false);
    expect(runHeartbeatSweep).toHaveBeenCalled();
    expect(runHeartbeatQueueSweep).toHaveBeenCalled();
    expect(runIssueCommentDispatchSweep).toHaveBeenCalled();

    resolveHeartbeat();
    resolveQueue();
    resolveComment();
    await stopPromise;
    expect(stopped).toBe(true);
  });

  it("blocks new queue workers once shutdown begins", async () => {
    vi.doUnmock("../apps/api/src/services/heartbeat-queue-service");

    const {
      beginHeartbeatQueueShutdown,
      resetHeartbeatQueueShutdownForTests,
      runHeartbeatQueueSweep,
      triggerHeartbeatQueueWorker,
      waitForHeartbeatQueueDrain
    } = await import("../apps/api/src/services/heartbeat-queue-service");

    resetHeartbeatQueueShutdownForTests();
    beginHeartbeatQueueShutdown();
    const execute = vi.fn();
    const result = await runHeartbeatQueueSweep({ execute } as any, "company-id");
    triggerHeartbeatQueueWorker({ execute } as any, "company-id");

    await waitForHeartbeatQueueDrain();
    expect(result.processed).toBe(0);
    expect(execute).not.toHaveBeenCalled();
  });
});

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
