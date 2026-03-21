import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadOfficeSpaceRealtimeSnapshot } from "../apps/api/src/realtime/office-space";
import { bootstrapDatabase, createApprovalRequest, createCompany } from "../packages/db/src";

describe("office-space realtime snapshot", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanupDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("preserves opencode provider type for hire candidates", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "bopo-office-space-"));
    cleanupDirs.push(tempDir);
    const dbPath = join(tempDir, "test.db");
    const { db, client } = await bootstrapDatabase(dbPath);
    try {
      const company = await createCompany(db, { name: "Realtime Co" });
      await createApprovalRequest(db, {
        companyId: company.id,
        action: "hire_agent",
        payload: {
          name: "OpenCode Engineer",
          role: "Engineer",
          providerType: "opencode",
          heartbeatCron: "*/5 * * * *",
          monthlyBudgetUsd: 50
        }
      });

      const message = await loadOfficeSpaceRealtimeSnapshot(db, company.id);
      expect(message.channel).toBe("office-space");
      expect(message.event.type).toBe("office.snapshot");
      if (message.event.type !== "office.snapshot") {
        throw new Error("Expected office snapshot event.");
      }

      const hireCandidate = message.event.occupants.find((occupant) => occupant.kind === "hire_candidate");
      expect(hireCandidate?.providerType).toBe("opencode");
    } finally {
      await client?.close?.();
    }
  });
});
