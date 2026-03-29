import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BUILTIN_BOPO_SKILL_IDS } from "bopodev-contracts";

const DIR = dirname(fileURLToPath(import.meta.url));

export type BuiltinBopoSkill = {
  id: string;
  title: string;
  content: string;
};

const BUILTIN_TITLES: Record<string, string> = {
  "bopodev-control-plane": "Bopo control plane",
  "bopodev-create-agent": "Bopo create agent",
  "para-memory-files": "PARA memory files"
};

function readBundled(id: string, title: string): BuiltinBopoSkill {
  try {
    const content = readFileSync(join(DIR, `${id}.md`), "utf8");
    return { id, title, content };
  } catch {
    return {
      id,
      title,
      content: `# ${title}\n\nBuilt-in skill text is not available in this build (missing bundled copy of \`${id}.md\`).\n`
    };
  }
}

/** Injected into local agent runtimes alongside company `skills/`. Read-only in Settings UI. */
export const BUILTIN_BOPO_SKILLS: BuiltinBopoSkill[] = BUILTIN_BOPO_SKILL_IDS.map((id) =>
  readBundled(id, BUILTIN_TITLES[id] ?? id)
);
