type StatusPresentation = {
  badgeClassName: string;
  chartColor: string;
};

/** Table pills: saturated tints and clear borders; no outer glow or shadow. */
const BADGE_EMERALD =
  "border-teal-500/55 bg-teal-500/12 font-semibold tracking-tight text-teal-900 dark:border-teal-300/50 dark:bg-teal-400/28 dark:text-teal-50";
const BADGE_SKY =
  "border-sky-500/55 bg-sky-500/12 font-semibold tracking-tight text-sky-900 dark:border-sky-300/50 dark:bg-sky-400/26 dark:text-sky-50";
const BADGE_AMBER =
  "border-amber-500/55 bg-amber-500/12 font-semibold tracking-tight text-amber-950 dark:border-amber-300/50 dark:bg-amber-400/24 dark:text-amber-50";
const BADGE_VIOLET =
  "border-violet-500/55 bg-violet-500/12 font-semibold tracking-tight text-violet-900 dark:border-violet-300/48 dark:bg-violet-400/28 dark:text-violet-50";
const BADGE_SLATE =
  "border-zinc-400/50 bg-zinc-500/10 font-semibold tracking-tight text-zinc-800 dark:border-zinc-400/40 dark:bg-zinc-400/16 dark:text-zinc-50";
const BADGE_ROSE =
  "border-red-500/50 bg-red-500/10 font-semibold tracking-tight text-red-950 dark:border-red-300/50 dark:bg-red-500/26 dark:text-red-50";
const BADGE_ORANGE =
  "border-orange-500/55 bg-orange-500/12 font-semibold tracking-tight text-orange-950 dark:border-orange-300/50 dark:bg-orange-400/26 dark:text-orange-50";
const BADGE_INDIGO =
  "border-indigo-500/55 bg-indigo-500/12 font-semibold tracking-tight text-indigo-950 dark:border-indigo-300/48 dark:bg-indigo-400/26 dark:text-indigo-50";

const STATUS_PRESENTATION: Record<string, StatusPresentation> = {
  active: {
    badgeClassName: BADGE_EMERALD,
    chartColor: "var(--color-chart-2)"
  },
  approved: {
    badgeClassName: BADGE_EMERALD,
    chartColor: "var(--color-chart-2)"
  },
  done: {
    badgeClassName: BADGE_EMERALD,
    chartColor: "var(--color-chart-2)"
  },
  completed: {
    badgeClassName: BADGE_EMERALD,
    chartColor: "var(--color-chart-2)"
  },
  success: {
    badgeClassName: BADGE_EMERALD,
    chartColor: "var(--color-chart-2)"
  },
  running: {
    badgeClassName: BADGE_SKY,
    chartColor: "var(--color-chart-1)"
  },
  started: {
    badgeClassName: BADGE_SKY,
    chartColor: "var(--color-chart-1)"
  },
  in_progress: {
    badgeClassName: BADGE_SKY,
    chartColor: "var(--color-chart-1)"
  },
  pending: {
    badgeClassName: BADGE_AMBER,
    chartColor: "var(--color-chart-4)"
  },
  todo: {
    badgeClassName: BADGE_AMBER,
    chartColor: "var(--color-chart-4)"
  },
  draft: {
    badgeClassName: BADGE_AMBER,
    chartColor: "var(--color-chart-4)"
  },
  in_review: {
    badgeClassName: BADGE_VIOLET,
    chartColor: "var(--color-chart-3)"
  },
  overridden: {
    badgeClassName: BADGE_VIOLET,
    chartColor: "var(--color-chart-3)"
  },
  paused: {
    badgeClassName: BADGE_SLATE,
    chartColor: "var(--color-chart-4)"
  },
  skipped: {
    badgeClassName: BADGE_SLATE,
    chartColor: "var(--color-chart-4)"
  },
  failed: {
    badgeClassName: BADGE_ROSE,
    chartColor: "var(--color-chart-5)"
  },
  rejected: {
    badgeClassName: BADGE_ROSE,
    chartColor: "var(--color-chart-5)"
  },
  blocked: {
    badgeClassName: BADGE_ROSE,
    chartColor: "var(--color-chart-5)"
  },
  canceled: {
    badgeClassName: BADGE_ROSE,
    chartColor: "var(--color-chart-5)"
  },
  archived: {
    badgeClassName: BADGE_ROSE,
    chartColor: "var(--color-chart-5)"
  },
  terminated: {
    badgeClassName: BADGE_ROSE,
    chartColor: "var(--color-chart-5)"
  }
};

/** Issue / work-item priority (bopodev-contracts IssuePriority). */
const PRIORITY_PRESENTATION: Record<string, string> = {
  none: BADGE_SLATE,
  low: BADGE_SKY,
  medium: BADGE_AMBER,
  high: BADGE_ORANGE,
  urgent: BADGE_ROSE
};

/** Goal hierarchy level (bopodev-contracts GoalLevel). */
const GOAL_LEVEL_PRESENTATION: Record<string, string> = {
  company: BADGE_INDIGO,
  project: BADGE_SKY,
  agent: BADGE_EMERALD
};

function normalizeStatus(status: string) {
  return status.toLowerCase().replace(/[\s-]+/g, "_");
}

/** Unknown workflow states: neutral but not flat gray-on-gray. */
const BADGE_FALLBACK =
  "border-zinc-500/45 bg-zinc-500/10 font-semibold tracking-tight text-zinc-800 dark:border-zinc-500/35 dark:bg-zinc-500/14 dark:text-zinc-100";

export function getStatusBadgeClassName(status: string) {
  const normalized = normalizeStatus(status);
  return STATUS_PRESENTATION[normalized]?.badgeClassName ?? BADGE_FALLBACK;
}

export function getPriorityBadgeClassName(priority: string) {
  const key = priority.toLowerCase().trim();
  return PRIORITY_PRESENTATION[key] ?? BADGE_FALLBACK;
}

export function getGoalLevelBadgeClassName(level: string) {
  const key = level.toLowerCase().trim();
  return GOAL_LEVEL_PRESENTATION[key] ?? BADGE_FALLBACK;
}

export function getStatusChartColor(status: string, fallback = "var(--color-chart-1)") {
  const normalized = normalizeStatus(status);
  return STATUS_PRESENTATION[normalized]?.chartColor ?? fallback;
}
