export const sectionItems = [
  { slug: "dashboard", label: "Dashboard" },
  { slug: "projects", label: "Projects" },
  { slug: "issues", label: "Issues" },
  { slug: "goals", label: "Goals" },
  { slug: "agents", label: "Agents" },
  { slug: "org-chart", label: "Organization" },
  { slug: "office-space", label: "Office" },
  { slug: "inbox", label: "Inbox" },
  { slug: "governance", label: "Approvals" },
  { slug: "runs", label: "Runs" },
  { slug: "trace-logs", label: "Logs" },
  { slug: "costs", label: "Costs" },
  { slug: "models", label: "Models" },
  { slug: "templates", label: "Templates" },
  { slug: "plugins", label: "Plugins" },
  { slug: "settings", label: "Settings" }
] as const;

export type SectionSlug = (typeof sectionItems)[number]["slug"];
export type SectionLabel = (typeof sectionItems)[number]["label"];

export const defaultSectionSlug: SectionSlug = "issues";

const sectionBySlug = new Map(sectionItems.map((item) => [item.slug, item]));

export function getSectionBySlug(section: string) {
  return sectionBySlug.get(section as SectionSlug);
}
