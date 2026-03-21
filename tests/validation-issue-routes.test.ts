import { describe, expect, it } from "vitest";
import {
  createIssueSchema,
  updateIssueSchema
} from "../apps/api/src/validation/issue-routes";

describe("issue route validation", () => {
  it("accepts a minimal valid create payload", () => {
    const parsed = createIssueSchema.safeParse({
      projectId: "proj1",
      title: "Hello"
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.status).toBe("todo");
      expect(parsed.data.priority).toBe("none");
      expect(parsed.data.labels).toEqual([]);
    }
  });

  it("rejects update payload with no fields", () => {
    const parsed = updateIssueSchema.safeParse({});
    expect(parsed.success).toBe(false);
  });

  it("accepts update with a single field", () => {
    const parsed = updateIssueSchema.safeParse({ title: "Only title" });
    expect(parsed.success).toBe(true);
  });
});
