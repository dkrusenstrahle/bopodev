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
      expect(parsed.data.goalIds).toEqual([]);
      expect(parsed.data.knowledgePaths).toEqual([]);
    }
  });

  it("accepts create payload with goalIds", () => {
    const parsed = createIssueSchema.safeParse({
      projectId: "proj1",
      title: "Hello",
      goalIds: ["goal_a", "goal_b"]
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.goalIds).toEqual(["goal_a", "goal_b"]);
    }
  });

  it("accepts update payload with goalIds", () => {
    const parsed = updateIssueSchema.safeParse({ goalIds: [] });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.goalIds).toEqual([]);
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

  it("accepts create payload with knowledgePaths", () => {
    const parsed = createIssueSchema.safeParse({
      projectId: "proj1",
      title: "Hello",
      knowledgePaths: ["playbook/a.md", "config.yaml"]
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.knowledgePaths).toEqual(["playbook/a.md", "config.yaml"]);
    }
  });

  it("rejects knowledgePaths with traversal", () => {
    const parsed = createIssueSchema.safeParse({
      projectId: "proj1",
      title: "Hello",
      knowledgePaths: ["../secret.md"]
    });
    expect(parsed.success).toBe(false);
  });

  it("accepts update with knowledgePaths only", () => {
    const parsed = updateIssueSchema.safeParse({ knowledgePaths: ["notes/x.md"] });
    expect(parsed.success).toBe(true);
  });
});
