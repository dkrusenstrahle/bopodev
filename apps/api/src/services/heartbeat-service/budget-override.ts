import { and, eq, inArray, approvalRequests, issues } from "bopodev-db";
import type { BopoDb } from "bopodev-db";

export async function findPendingProjectBudgetOverrideBlocksForAgent(
  db: BopoDb,
  companyId: string,
  agentId: string
) {
  const assignedRows = await db
    .select({ projectId: issues.projectId })
    .from(issues)
    .where(
      and(
        eq(issues.companyId, companyId),
        eq(issues.assigneeAgentId, agentId),
        inArray(issues.status, ["todo", "in_progress"])
      )
    );
  const assignedProjectIds = new Set(assignedRows.map((row) => row.projectId));
  if (assignedProjectIds.size === 0) {
    return [] as string[];
  }
  const pendingOverrides = await db
    .select({ payloadJson: approvalRequests.payloadJson })
    .from(approvalRequests)
    .where(
      and(
        eq(approvalRequests.companyId, companyId),
        eq(approvalRequests.action, "override_budget"),
        eq(approvalRequests.status, "pending")
      )
    );
  const blockedProjectIds = new Set<string>();
  for (const approval of pendingOverrides) {
    try {
      const payload = JSON.parse(approval.payloadJson) as Record<string, unknown>;
      const projectId = typeof payload.projectId === "string" ? payload.projectId.trim() : "";
      if (projectId && assignedProjectIds.has(projectId)) {
        blockedProjectIds.add(projectId);
      }
    } catch {
      // Ignore malformed payloads to keep enforcement resilient.
    }
  }
  return Array.from(blockedProjectIds);
}
