import { and, desc, eq, like } from "drizzle-orm";
import {
  issueComments,
  issues,
  listApprovalRequests,
  listAttentionInboxStates,
  listHeartbeatRuns,
  listIssues,
  markAttentionInboxAcknowledged,
  markAttentionInboxDismissed,
  markAttentionInboxResolved,
  markAttentionInboxSeen,
  clearAttentionInboxDismissed,
  type BopoDb
} from "bopodev-db";
import type { BoardAttentionItem } from "bopodev-contracts";

type AttentionStateRow = Awaited<ReturnType<typeof listAttentionInboxStates>>[number];

export async function listBoardAttentionItems(db: BopoDb, companyId: string, actorId: string): Promise<BoardAttentionItem[]> {
  const [approvals, blockedIssues, heartbeatRuns, stateRows, boardComments] = await Promise.all([
    listApprovalRequests(db, companyId),
    listIssues(db, companyId),
    listHeartbeatRuns(db, companyId, 300),
    listAttentionInboxStates(db, companyId, actorId),
    db
      .select({
        id: issueComments.id,
        issueId: issueComments.issueId,
        body: issueComments.body,
        createdAt: issueComments.createdAt,
        issueTitle: issues.title
      })
      .from(issueComments)
      .innerJoin(issues, and(eq(issues.id, issueComments.issueId), eq(issues.companyId, issueComments.companyId)))
      .where(and(eq(issueComments.companyId, companyId), like(issueComments.recipientsJson, '%"recipientType":"board"%')))
      .orderBy(desc(issueComments.createdAt))
      .limit(40)
  ]);

  const stateByKey = new Map(stateRows.map((row) => [row.itemKey, row]));
  const items: BoardAttentionItem[] = [];

  for (const approval of approvals) {
    if (approval.status !== "pending") {
      continue;
    }
    const payload = parsePayload(approval.payloadJson);
    const ageHours = ageHoursFromDate(approval.createdAt);
    if (approval.action === "override_budget") {
      const projectId = asString(payload.projectId);
      const agentId = asString(payload.agentId);
      const utilizationPct = asNumber(payload.utilizationPct);
      const currentBudget = asNumber(payload.currentMonthlyBudgetUsd);
      const usedBudget = asNumber(payload.usedBudgetUsd);
      const key = `budget:${approval.id}`;
      items.push(
        withState(
          {
            key,
            category: "budget_hard_stop",
            severity: ageHours >= 12 ? "critical" : "warning",
            requiredActor: "board",
            title: "Budget hard-stop requires board decision",
            contextSummary: projectId
              ? `Project ${shortId(projectId)} is blocked by budget hard-stop.`
              : agentId
                ? `Agent ${shortId(agentId)} is blocked by budget hard-stop.`
                : "Agent work is blocked by budget hard-stop.",
            actionLabel: "Review budget override",
            actionHref: "/governance",
            impactSummary: "Heartbeat work stays paused until budget override is approved or rejected.",
            evidence: {
              approvalId: approval.id,
              projectId: projectId ?? undefined,
              agentId: agentId ?? undefined
            },
            sourceTimestamp: approval.createdAt.toISOString(),
            state: "open",
            seenAt: null,
            acknowledgedAt: null,
            dismissedAt: null,
            resolvedAt: null
          },
          stateByKey.get(key),
          `Budget utilization ${formatPercent(utilizationPct)} (${formatUsd(usedBudget)} / ${formatUsd(currentBudget)}).`
        )
      );
      continue;
    }

    const key = `approval:${approval.id}`;
    items.push(
      withState(
        {
          key,
          category: "approval_required",
          severity: ageHours >= 24 ? "critical" : "warning",
          requiredActor: "board",
          title: "Approval required",
          contextSummary: formatApprovalContext(approval.action, payload),
          actionLabel: "Open approvals",
          actionHref: "/governance",
          impactSummary: "Execution remains blocked until this governance decision is resolved.",
          evidence: {
            approvalId: approval.id,
            projectId: asString(payload.projectId) ?? undefined,
            agentId: asString(payload.agentId) ?? undefined
          },
          sourceTimestamp: approval.createdAt.toISOString(),
          state: "open",
          seenAt: null,
          acknowledgedAt: null,
          dismissedAt: null,
          resolvedAt: null
        },
        stateByKey.get(key)
      )
    );
  }

  const openIssues = blockedIssues.filter((issue) => issue.status !== "done" && issue.status !== "canceled");
  const blockedOpenIssues = openIssues.filter((issue) => issue.status === "blocked");
  for (const issue of blockedOpenIssues) {
    const blockedHours = ageHoursFromDate(issue.updatedAt);
    if (blockedHours < 2) {
      continue;
    }
    const key = `issue_blocked:${issue.id}`;
    items.push(
      withState(
        {
          key,
          category: "blocker_escalation",
          severity: blockedHours >= 24 ? "critical" : "warning",
          requiredActor: "board",
          title: "Issue remains blocked",
          contextSummary: `${issue.title} has been blocked for ${formatAgeHours(blockedHours)}.`,
          actionLabel: "Open issue",
          actionHref: `/issues/${issue.id}`,
          impactSummary: "Delivery is delayed until this blocker is addressed or rerouted.",
          evidence: {
            issueId: issue.id,
            projectId: issue.projectId
          },
          sourceTimestamp: issue.updatedAt.toISOString(),
          state: "open",
          seenAt: null,
          acknowledgedAt: null,
          dismissedAt: null,
          resolvedAt: null
        },
        stateByKey.get(key)
      )
    );
  }

  const staleOpenIssues = openIssues.filter((issue) => ageHoursFromDate(issue.updatedAt) >= 7 * 24);
  if (staleOpenIssues.length > 0) {
    const oldest = staleOpenIssues.reduce((max, issue) => Math.max(max, ageHoursFromDate(issue.updatedAt)), 0);
    const key = "stalled_work:global";
    items.push(
      withState(
        {
          key,
          category: "stalled_work",
          severity: staleOpenIssues.length >= 5 || oldest >= 14 * 24 ? "critical" : "warning",
          requiredActor: "board",
          title: "Stalled work trend detected",
          contextSummary: `${staleOpenIssues.length} open issues have had no updates for over 7 days.`,
          actionLabel: "Review open issues",
          actionHref: "/issues",
          impactSummary: "Backlog throughput is slowing and confidence in delivery decreases over time.",
          evidence: {},
          sourceTimestamp: new Date().toISOString(),
          state: "open",
          seenAt: null,
          acknowledgedAt: null,
          dismissedAt: null,
          resolvedAt: null
        },
        stateByKey.get(key)
      )
    );
  }

  const now = Date.now();
  const runs24h = heartbeatRuns.filter((run) => now - run.startedAt.getTime() <= 24 * 60 * 60 * 1000);
  const failed24h = runs24h.filter((run) => run.status === "failed").length;
  if (failed24h > 0) {
    const key = "run_failure_spike:24h";
    const severity = failed24h >= 5 || failed24h / Math.max(runs24h.length, 1) >= 0.4 ? "critical" : "warning";
    items.push(
      withState(
        {
          key,
          category: "run_failure_spike",
          severity,
          requiredActor: "board",
          title: "Run failure spike in last 24h",
          contextSummary: `${failed24h} failed runs out of ${runs24h.length} total in the last 24 hours.`,
          actionLabel: "Inspect runs",
          actionHref: "/runs",
          impactSummary: "Repeated runtime failures can halt issue progress across multiple teams.",
          evidence: {},
          sourceTimestamp: new Date().toISOString(),
          state: "open",
          seenAt: null,
          acknowledgedAt: null,
          dismissedAt: null,
          resolvedAt: null
        },
        stateByKey.get(key)
      )
    );
  }

  for (const comment of boardComments) {
    const key = `comment:${comment.id}`;
    const body = comment.body.trim().replace(/\s+/g, " ");
    const summaryBody = body.length > 140 ? `${body.slice(0, 137)}...` : body;
    items.push(
      withState(
        {
          key,
          category: "board_mentioned_comment",
          severity: "warning",
          requiredActor: "board",
          title: "Board input requested on issue comment",
          contextSummary: `${comment.issueTitle}: ${summaryBody}`,
          actionLabel: "Open issue thread",
          actionHref: `/issues/${comment.issueId}`,
          impactSummary: "The team is waiting for board clarification to continue confidently.",
          evidence: {
            issueId: comment.issueId,
            commentId: comment.id
          },
          sourceTimestamp: comment.createdAt.toISOString(),
          state: "open",
          seenAt: null,
          acknowledgedAt: null,
          dismissedAt: null,
          resolvedAt: null
        },
        stateByKey.get(key)
      )
    );
  }

  return dedupeItems(items).sort(compareAttentionItems);
}

export async function markBoardAttentionSeen(db: BopoDb, companyId: string, actorId: string, itemKey: string) {
  await markAttentionInboxSeen(db, { companyId, actorId, itemKey });
}

export async function markBoardAttentionAcknowledged(db: BopoDb, companyId: string, actorId: string, itemKey: string) {
  await markAttentionInboxAcknowledged(db, { companyId, actorId, itemKey });
}

export async function markBoardAttentionDismissed(db: BopoDb, companyId: string, actorId: string, itemKey: string) {
  await markAttentionInboxDismissed(db, { companyId, actorId, itemKey });
}

export async function clearBoardAttentionDismissed(db: BopoDb, companyId: string, actorId: string, itemKey: string) {
  await clearAttentionInboxDismissed(db, { companyId, actorId, itemKey });
}

export async function markBoardAttentionResolved(db: BopoDb, companyId: string, actorId: string, itemKey: string) {
  await markAttentionInboxResolved(db, { companyId, actorId, itemKey });
}

function withState(item: BoardAttentionItem, state: AttentionStateRow | undefined, appendContext?: string) {
  const contextSummary = appendContext ? `${item.contextSummary} ${appendContext}`.trim() : item.contextSummary;
  if (!state) {
    return { ...item, contextSummary };
  }
  const resolvedAt = state.resolvedAt?.toISOString() ?? null;
  const dismissedAt = state.dismissedAt?.toISOString() ?? null;
  const acknowledgedAt = state.acknowledgedAt?.toISOString() ?? null;
  const seenAt = state.seenAt?.toISOString() ?? null;
  const computedState =
    resolvedAt ? "resolved" : dismissedAt ? "dismissed" : acknowledgedAt ? "acknowledged" : "open";
  return {
    ...item,
    contextSummary,
    state: computedState,
    resolvedAt,
    dismissedAt,
    acknowledgedAt,
    seenAt
  } satisfies BoardAttentionItem;
}

function compareAttentionItems(a: BoardAttentionItem, b: BoardAttentionItem) {
  const stateRank = new Map<BoardAttentionItem["state"], number>([
    ["open", 0],
    ["acknowledged", 1],
    ["dismissed", 2],
    ["resolved", 3]
  ]);
  const severityRank = new Map<BoardAttentionItem["severity"], number>([
    ["critical", 0],
    ["warning", 1],
    ["info", 2]
  ]);
  const byState = (stateRank.get(a.state) ?? 99) - (stateRank.get(b.state) ?? 99);
  if (byState !== 0) {
    return byState;
  }
  const bySeverity = (severityRank.get(a.severity) ?? 99) - (severityRank.get(b.severity) ?? 99);
  if (bySeverity !== 0) {
    return bySeverity;
  }
  return new Date(b.sourceTimestamp).getTime() - new Date(a.sourceTimestamp).getTime();
}

function dedupeItems(items: BoardAttentionItem[]) {
  const seen = new Set<string>();
  const deduped: BoardAttentionItem[] = [];
  for (const item of items) {
    if (seen.has(item.key)) {
      continue;
    }
    seen.add(item.key);
    deduped.push(item);
  }
  return deduped;
}

function parsePayload(payloadJson: string) {
  try {
    const parsed = JSON.parse(payloadJson) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function formatApprovalContext(action: string, payload: Record<string, unknown>) {
  const name = asString(payload.name);
  const role = asString(payload.role) ?? asString(payload.title);
  if (name && role) {
    return `${action.replaceAll("_", " ")} for ${name} (${role}).`;
  }
  if (name) {
    return `${action.replaceAll("_", " ")} for ${name}.`;
  }
  const projectId = asString(payload.projectId);
  if (projectId) {
    return `${action.replaceAll("_", " ")} for project ${shortId(projectId)}.`;
  }
  return `${action.replaceAll("_", " ")} pending board decision.`;
}

function shortId(value: string) {
  return value.length > 12 ? `${value.slice(0, 8)}...` : value;
}

function asString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function asNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function formatUsd(value: number | null) {
  if (value === null) {
    return "n/a";
  }
  return `$${value.toFixed(2)}`;
}

function formatPercent(value: number | null) {
  if (value === null) {
    return "n/a";
  }
  return `${value.toFixed(1)}%`;
}

function ageHoursFromDate(date: Date) {
  return Math.max(0, (Date.now() - date.getTime()) / (1000 * 60 * 60));
}

function formatAgeHours(hours: number) {
  if (hours < 24) {
    return `${hours.toFixed(1)}h`;
  }
  return `${(hours / 24).toFixed(1)}d`;
}
