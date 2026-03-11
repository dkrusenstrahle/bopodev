export type CostSummaryEntry = {
  tokenInput: number;
  tokenOutput: number;
  usdCost: number;
};

export type StopCheckRun = {
  status: string;
  message: string | null;
};

export type RunFilterCandidate = {
  status: string;
  runType?: string | null;
  message: string | null;
};

export type StopCheckDetails = {
  errorType?: string;
};

export type NamedProject = {
  id: string;
  name: string;
};

export function summarizeCosts(entries: CostSummaryEntry[]) {
  return entries.reduce(
    (acc, entry) => {
      acc.input += entry.tokenInput;
      acc.output += entry.tokenOutput;
      acc.usd += entry.usdCost;
      return acc;
    },
    { input: 0, output: 0, usd: 0 }
  );
}

export function resolveWindowStart(window: "today" | "7d" | "30d" | "90d" | "all") {
  const now = new Date();
  if (window === "all") {
    return null;
  }
  if (window === "today") {
    return new Date(now.getFullYear(), now.getMonth(), now.getDate());
  }
  const days = window === "7d" ? 7 : window === "30d" ? 30 : 90;
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

export function isStoppedRun(run: StopCheckRun, details?: StopCheckDetails) {
  if (run.status !== "failed") {
    return false;
  }
  if ((details?.errorType ?? "").toLowerCase() === "cancelled") {
    return true;
  }
  return (run.message ?? "").toLowerCase().includes("cancelled by stop request");
}

export function isNoAssignedWorkRun(run: RunFilterCandidate) {
  return run.runType === "no_assigned_work";
}

export function isSkippedRun(run: RunFilterCandidate) {
  return run.status === "skipped" || run.runType === "no_assigned_work" || run.runType?.endsWith("_skip") === true;
}

export function selectedProjectNameFor(projectId: string, projects: NamedProject[]) {
  return projects.find((project) => project.id === projectId)?.name ?? "Unknown";
}
