import { describe, expect, it } from "vitest";
import { isApprovalRequired } from "../apps/api/src/services/governance-service";

describe("governance approval gating", () => {
  it("marks hire_agent as approval-gated", () => {
    expect(isApprovalRequired("hire_agent")).toBe(true);
  });

  it("does not gate arbitrary actions", () => {
    expect(isApprovalRequired("not_a_real_action")).toBe(false);
  });
});
