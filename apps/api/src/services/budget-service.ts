import { and, eq } from "drizzle-orm";
import type { BopoDb } from "bopodev-db";
import { agents } from "bopodev-db";

export interface BudgetCheckResult {
  allowed: boolean;
  hardStopped: boolean;
  utilizationPct: number;
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
