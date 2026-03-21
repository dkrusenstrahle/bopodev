import { describe, expect, it } from "vitest";
import { isHeartbeatDue } from "../apps/api/src/services/heartbeat-service/cron";

describe("heartbeat cron scheduling", () => {
  it("treats every-minute cron as due when there is no prior run", () => {
    const now = new Date("2025-03-21T14:37:00.000Z");
    expect(isHeartbeatDue("* * * * *", null, now)).toBe(true);
  });

  it("does not double-fire within the same minute", () => {
    const now = new Date("2025-03-21T14:37:22.000Z");
    const lastRun = new Date("2025-03-21T14:37:05.000Z");
    expect(isHeartbeatDue("* * * * *", lastRun, now)).toBe(false);
  });

  it("fires again on the next minute", () => {
    const now = new Date("2025-03-21T14:38:00.000Z");
    const lastRun = new Date("2025-03-21T14:37:30.000Z");
    expect(isHeartbeatDue("* * * * *", lastRun, now)).toBe(true);
  });
});
