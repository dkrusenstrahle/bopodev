import { and, eq, inArray, issues, sql } from "bopodev-db";
import type { BopoDb } from "bopodev-db";

export async function claimIssuesForAgent(
  db: BopoDb,
  companyId: string,
  agentId: string,
  heartbeatRunId: string,
  maxItems = 5
) {
  const result = await db.execute(sql`
    WITH candidate AS (
      SELECT id
      FROM issues
      WHERE company_id = ${companyId}
        AND assignee_agent_id = ${agentId}
        AND status IN ('todo', 'in_progress')
        AND is_claimed = false
      ORDER BY
        CASE priority
          WHEN 'urgent' THEN 0
          WHEN 'high' THEN 1
          WHEN 'medium' THEN 2
          WHEN 'low' THEN 3
          ELSE 4
        END ASC,
        updated_at ASC
      LIMIT ${maxItems}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE issues i
    SET is_claimed = true,
        claimed_by_heartbeat_run_id = ${heartbeatRunId},
        updated_at = CURRENT_TIMESTAMP
    FROM candidate c
    WHERE i.id = c.id
    RETURNING i.id, i.project_id, i.parent_issue_id, i.title, i.body, i.status, i.priority, i.labels_json, i.tags_json;
  `);

  return result as unknown as Array<{
    id: string;
    project_id: string;
    parent_issue_id: string | null;
    title: string;
    body: string | null;
    status: string;
    priority: string;
    labels_json: string;
    tags_json: string;
  }>;
}

export async function releaseClaimedIssues(db: BopoDb, companyId: string, issueIds: string[]) {
  if (issueIds.length === 0) {
    return;
  }
  await db
    .update(issues)
    .set({ isClaimed: false, claimedByHeartbeatRunId: null, updatedAt: new Date() })
    .where(and(eq(issues.companyId, companyId), inArray(issues.id, issueIds)));
}
