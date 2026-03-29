import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = dirname(fileURLToPath(import.meta.url));

export type BuiltinBopoSkill = {
  id: string;
  title: string;
  content: string;
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
export const BUILTIN_BOPO_SKILLS: BuiltinBopoSkill[] = [
  readBundled("bopodev-control-plane", "Bopo control plane"),
  readBundled("bopodev-create-agent", "Bopo create agent"),
  readBundled("para-memory-files", "PARA memory files")
];
