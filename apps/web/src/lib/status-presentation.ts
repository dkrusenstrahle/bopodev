type StatusPresentation = {
  badgeClassName: string;
  chartColor: string;
};

const STATUS_PRESENTATION: Record<string, StatusPresentation> = {
  active: {
    badgeClassName: "border-emerald-500/40 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
    chartColor: "var(--color-chart-2)"
  },
  approved: {
    badgeClassName: "border-emerald-500/40 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
    chartColor: "var(--color-chart-2)"
  },
  done: {
    badgeClassName: "border-emerald-500/40 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
    chartColor: "var(--color-chart-2)"
  },
  completed: {
    badgeClassName: "border-emerald-500/40 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
    chartColor: "var(--color-chart-2)"
  },
  success: {
    badgeClassName: "border-emerald-500/40 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
    chartColor: "var(--color-chart-2)"
  },
  running: {
    badgeClassName: "border-sky-500/40 bg-sky-500/15 text-sky-700 dark:text-sky-300",
    chartColor: "var(--color-chart-1)"
  },
  started: {
    badgeClassName: "border-sky-500/40 bg-sky-500/15 text-sky-700 dark:text-sky-300",
    chartColor: "var(--color-chart-1)"
  },
  in_progress: {
    badgeClassName: "border-sky-500/40 bg-sky-500/15 text-sky-700 dark:text-sky-300",
    chartColor: "var(--color-chart-1)"
  },
  pending: {
    badgeClassName: "border-amber-500/40 bg-amber-500/15 text-amber-700 dark:text-amber-300",
    chartColor: "var(--color-chart-4)"
  },
  todo: {
    badgeClassName: "border-amber-500/40 bg-amber-500/15 text-amber-700 dark:text-amber-300",
    chartColor: "var(--color-chart-4)"
  },
  draft: {
    badgeClassName: "border-amber-500/40 bg-amber-500/15 text-amber-700 dark:text-amber-300",
    chartColor: "var(--color-chart-4)"
  },
  in_review: {
    badgeClassName: "border-violet-500/40 bg-violet-500/15 text-violet-700 dark:text-violet-300",
    chartColor: "var(--color-chart-3)"
  },
  overridden: {
    badgeClassName: "border-violet-500/40 bg-violet-500/15 text-violet-700 dark:text-violet-300",
    chartColor: "var(--color-chart-3)"
  },
  paused: {
    badgeClassName: "border-slate-500/40 bg-slate-500/15 text-slate-700 dark:text-slate-300",
    chartColor: "var(--color-chart-4)"
  },
  skipped: {
    badgeClassName: "border-slate-500/40 bg-slate-500/15 text-slate-700 dark:text-slate-300",
    chartColor: "var(--color-chart-4)"
  },
  failed: {
    badgeClassName: "border-rose-500/40 bg-rose-500/15 text-rose-700 dark:text-rose-300",
    chartColor: "var(--color-chart-5)"
  },
  rejected: {
    badgeClassName: "border-rose-500/40 bg-rose-500/15 text-rose-700 dark:text-rose-300",
    chartColor: "var(--color-chart-5)"
  },
  blocked: {
    badgeClassName: "border-rose-500/40 bg-rose-500/15 text-rose-700 dark:text-rose-300",
    chartColor: "var(--color-chart-5)"
  },
  canceled: {
    badgeClassName: "border-rose-500/40 bg-rose-500/15 text-rose-700 dark:text-rose-300",
    chartColor: "var(--color-chart-5)"
  },
  archived: {
    badgeClassName: "border-rose-500/40 bg-rose-500/15 text-rose-700 dark:text-rose-300",
    chartColor: "var(--color-chart-5)"
  },
  terminated: {
    badgeClassName: "border-rose-500/40 bg-rose-500/15 text-rose-700 dark:text-rose-300",
    chartColor: "var(--color-chart-5)"
  }
};

function normalizeStatus(status: string) {
  return status.toLowerCase().replace(/[\s-]+/g, "_");
}

export function getStatusBadgeClassName(status: string) {
  const normalized = normalizeStatus(status);
  return STATUS_PRESENTATION[normalized]?.badgeClassName ?? "border-border bg-muted/40 text-foreground";
}

export function getStatusChartColor(status: string, fallback = "var(--color-chart-1)") {
  const normalized = normalizeStatus(status);
  return STATUS_PRESENTATION[normalized]?.chartColor ?? fallback;
}
