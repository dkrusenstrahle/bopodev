import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mdV1 = "---\nname: synced-skill\n---\n\n# One\n";
const mdV2 = "---\nname: synced-skill\n---\n\n# Two\n";

function mockFetchSequence(bodies: string[]) {
  let i = 0;
  return vi.fn(async () => {
    const text = bodies[Math.min(i, bodies.length - 1)] ?? bodies[bodies.length - 1]!;
    i += 1;
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () => new TextEncoder().encode(text).buffer
    };
  });
}

describe("company skill URL link and refresh", () => {
  let tempRoot: string;
  let prevInstanceRoot: string | undefined;
  let prevFetch: typeof fetch;

  beforeEach(async () => {
    prevInstanceRoot = process.env.BOPO_INSTANCE_ROOT;
    tempRoot = await mkdtemp(join(tmpdir(), "bopo-skill-link-"));
    process.env.BOPO_INSTANCE_ROOT = join(tempRoot, "instances");
    prevFetch = globalThis.fetch;
  });

  afterEach(async () => {
    if (prevInstanceRoot === undefined) {
      delete process.env.BOPO_INSTANCE_ROOT;
    } else {
      process.env.BOPO_INSTANCE_ROOT = prevInstanceRoot;
    }
    globalThis.fetch = prevFetch;
    await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
  });

  it("linkCompanySkillFromUrl writes SKILL.md and link metadata", async () => {
    globalThis.fetch = mockFetchSequence([mdV1]) as unknown as typeof fetch;
    const {
      linkCompanySkillFromUrl,
      readOptionalSkillLinkRecord,
      readCompanySkillFile
    } = await import("../apps/api/src/services/company-skill-file-service");
    const url =
      "https://raw.githubusercontent.com/org/repo/main/skills/synced-skill/SKILL.md";
    const result = await linkCompanySkillFromUrl({
      companyId: "co1",
      url,
      skillId: "synced-skill"
    });
    expect(result.skillId).toBe("synced-skill");
    expect(result.lastFetchedAt).toMatch(/^\d{4}-/);
    const rec = await readOptionalSkillLinkRecord(
      join(tempRoot, "instances", "workspaces", "co1", "skills", "synced-skill")
    );
    expect(rec?.url).toBe(url);
    expect(rec?.lastFetchedAt).toBe(result.lastFetchedAt);
    const file = await readCompanySkillFile({
      companyId: "co1",
      skillId: "synced-skill",
      relativePath: "SKILL.md"
    });
    expect(file.content).toContain("# One");
  });

  it("refreshCompanySkillFromUrl overwrites SKILL.md", async () => {
    const fetchMock = mockFetchSequence([mdV1, mdV2]);
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const { linkCompanySkillFromUrl, refreshCompanySkillFromUrl, readCompanySkillFile } =
      await import("../apps/api/src/services/company-skill-file-service");
    const url =
      "https://raw.githubusercontent.com/org/repo/main/skills/synced-skill/SKILL.md";
    await linkCompanySkillFromUrl({ companyId: "co1", url, skillId: "synced-skill" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await refreshCompanySkillFromUrl({
      companyId: "co1",
      skillId: "synced-skill"
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const file = await readCompanySkillFile({
      companyId: "co1",
      skillId: "synced-skill",
      relativePath: "SKILL.md"
    });
    expect(file.content).toContain("# Two");
  });

  it("refreshCompanySkillFromUrl throws when skill is not URL-linked", async () => {
    globalThis.fetch = vi.fn() as unknown as typeof fetch;
    const { createCompanySkillPackage, refreshCompanySkillFromUrl } = await import(
      "../apps/api/src/services/company-skill-file-service"
    );
    await createCompanySkillPackage({ companyId: "co1", skillId: "local-only" });
    await expect(
      refreshCompanySkillFromUrl({ companyId: "co1", skillId: "local-only" })
    ).rejects.toThrow(/not linked from a URL/i);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("readOptionalSkillLinkRecord accepts legacy JSON without lastFetchedAt", async () => {
    const { readOptionalSkillLinkRecord } = await import(
      "../apps/api/src/services/company-skill-file-service"
    );
    const skillDir = join(tempRoot, "instances", "workspaces", "co1", "skills", "legacy");
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, ".bopo-skill-link.json"),
      JSON.stringify({ url: "https://raw.githubusercontent.com/x/y/main/SKILL.md" }),
      "utf8"
    );
    const rec = await readOptionalSkillLinkRecord(skillDir);
    expect(rec?.url).toContain("raw.githubusercontent.com");
    expect(rec?.lastFetchedAt).toBeNull();
  });
});
