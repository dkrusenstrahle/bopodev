import { describe, expect, it } from "vitest";
import {
  extractSkillsShProseHtml,
  htmlProseFragmentToMarkdown
} from "../apps/api/src/services/company-skill-file-service";

describe("skills.sh import HTML extraction", () => {
  it("extracts prose fragment and converts to markdown", () => {
    const page = `<!DOCTYPE html><html><body><span>SKILL.md</span></div><div class="prose prose-invert max-w-none"><h1>Find Skills</h1><p>Hello <strong>world</strong>.</p></div></div></div><div class=" lg:col-span-3">sidebar`;
    const fragment = extractSkillsShProseHtml(page);
    expect(fragment).toBeTruthy();
    const md = htmlProseFragmentToMarkdown(fragment!);
    expect(md).toContain("# Find Skills");
    expect(md).toContain("Hello");
    expect(md).toContain("world");
  });

  it("returns null when prose block is missing", () => {
    expect(extractSkillsShProseHtml("<html><body><p>nope</p></body></html>")).toBeNull();
  });
});
