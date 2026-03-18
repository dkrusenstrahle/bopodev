import { and, eq, sql } from "drizzle-orm";
import type { BopoDb } from "bopodev-db";
import { agents, projects } from "bopodev-db";

export interface BudgetCheckResult {
  allowed: boolean;
  hardStopped: boolean;
  utilizationPct: number;
}

export interface ProjectBudgetCheckResult extends BudgetCheckResult {
  projectId: string;
  monthlyBudgetUsd: number;
  usedBudgetUsd: number;
  budgetWindowStartAt: Date | null;
}

export async function checkAgentBudget(db: BopoDb, companyId: string, agentId: string): Promise<BudgetCheckResult> {
  // Budget enforcement is currently agent-scoped. Project/issue budgets are intentionally out of scope.
  const [agent] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.companyId, companyId), eq(agents.id, agentId)))
    .limit(1);

  if (!agent) {
    return { allowed: false, hardStopped: true, utilizationPct: 100 };
  }

  const monthlyBudget = Number(agent.monthlyBudgetUsd);
  const usedBudget = Number(agent.usedBudgetUsd);
  const utilizationPct = monthlyBudget <= 0 ? 0 : (usedBudget / monthlyBudget) * 100;

  return {
    allowed: utilizationPct < 100,
    hardStopped: utilizationPct >= 100,
    utilizationPct
  };
}

export async function checkProjectBudget(
  db: BopoDb,
  companyId: string,
  projectId: string,
  now = new Date()
): Promise<ProjectBudgetCheckResult> {
  const [project] = await db
    .select({
      id: projects.id,
      monthlyBudgetUsd: projects.monthlyBudgetUsd,
      usedBudgetUsd: projects.usedBudgetUsd,
      budgetWindowStartAt: projects.budgetWindowStartAt
    })
    .from(projects)
    .where(and(eq(projects.companyId, companyId), eq(projects.id, projectId)))
    .limit(1);

  if (!project) {
    return {
      projectId,
      allowed: false,
      hardStopped: true,
      utilizationPct: 100,
      monthlyBudgetUsd: 0,
      usedBudgetUsd: 0,
      budgetWindowStartAt: null
    };
  }

  const expectedWindowStart = startOfCurrentMonthUtc(now);
  const persistedWindowStart = project.budgetWindowStartAt ? new Date(project.budgetWindowStartAt) : null;
  const staleWindow = !persistedWindowStart || !isSameUtcMonth(persistedWindowStart, expectedWindowStart);
  if (staleWindow) {
    await db
      .update(projects)
      .set({
        usedBudgetUsd: "0.0000",
        budgetWindowStartAt: expectedWindowStart,
        updatedAt: new Date()
      })
      .where(and(eq(projects.companyId, companyId), eq(projects.id, projectId)));
  }

  const monthlyBudgetUsd = Number(project.monthlyBudgetUsd);
  const usedBudgetUsd = staleWindow ? 0 : Number(project.usedBudgetUsd);
  const utilizationPct = monthlyBudgetUsd <= 0 ? 100 : (usedBudgetUsd / monthlyBudgetUsd) * 100;
  const allowed = monthlyBudgetUsd > 0 && utilizationPct < 100;

  return {
    projectId: project.id,
    allowed,
    hardStopped: !allowed,
    utilizationPct,
    monthlyBudgetUsd,
    usedBudgetUsd,
    budgetWindowStartAt: staleWindow ? expectedWindowStart : persistedWindowStart
  };
}

export async function appendProjectBudgetUsage(
  db: BopoDb,
  input: {
    companyId: string;
    projectCostsUsd: Array<{ projectId: string; usdCost: number }>;
  }
) {
  for (const entry of input.projectCostsUsd) {
    const cost = Math.max(0, entry.usdCost);
    if (cost <= 0) {
      continue;
    }
    await db
      .update(projects)
      .set({
        usedBudgetUsd: sql`${projects.usedBudgetUsd} + ${cost}`,
        updatedAt: new Date()
      })
      .where(and(eq(projects.companyId, input.companyId), eq(projects.id, entry.projectId)));
  }
}

function startOfCurrentMonthUtc(now: Date) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));
}

function isSameUtcMonth(left: Date, right: Date) {
  return left.getUTCFullYear() === right.getUTCFullYear() && left.getUTCMonth() === right.getUTCMonth();
}
