import { describe, expect, it } from "vitest";
import { assertKnowledgeRelativePath } from "../apps/api/src/services/company-knowledge-file-service";

describe("company-knowledge-file-service", () => {
  it("accepts valid relative paths", () => {
    expect(assertKnowledgeRelativePath("hello.md")).toBe("hello.md");
    expect(assertKnowledgeRelativePath("dir/page.md")).toBe("dir/page.md");
    expect(assertKnowledgeRelativePath("x/config.yaml")).toBe("x/config.yaml");
  });

  it("rejects path traversal", () => {
    expect(() => assertKnowledgeRelativePath("../x.md")).toThrow();
    expect(() => assertKnowledgeRelativePath("a/../b.md")).toThrow();
  });

  it("rejects disallowed extensions", () => {
    expect(() => assertKnowledgeRelativePath("x.pdf")).toThrow();
    expect(() => assertKnowledgeRelativePath("x.exe")).toThrow();
  });

  it("rejects hidden segments", () => {
    expect(() => assertKnowledgeRelativePath(".env.md")).toThrow();
    expect(() => assertKnowledgeRelativePath("dir/.secret.md")).toThrow();
  });
});
