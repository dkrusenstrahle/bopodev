import type { OfficeOccupant, RealtimeEventEnvelope, RealtimeMessage } from "bopodev-contracts";
import { AGENT_ROLE_LABELS, AgentRoleKeySchema } from "bopodev-contracts";
import {
  and,
  agents,
  approvalRequests,
  desc,
  eq,
  getApprovalRequest,
  heartbeatRuns,
  issues,
  listAgents,
  listApprovalRequests,
  listHeartbeatRuns,
  type BopoDb
} from "bopodev-db";
import type { RealtimeHub } from "./hub";

export async function loadOfficeSpaceRealtimeSnapshot(
  db: BopoDb,
  companyId: string
): Promise<Extract<RealtimeMessage, { kind: "event" }>> {
  return createRealtimeEvent(companyId, {
    channel: "office-space",
    event: {
      type: "office.snapshot",
      occupants: await listOfficeOccupants(db, companyId)
    }
  });
}

export function createOfficeSpaceRealtimeEvent(
  companyId: string,
  event: Extract<RealtimeEventEnvelope, { channel: "office-space" }>["event"]
): Extract<RealtimeMessage, { kind: "event" }> {
  return createRealtimeEvent(companyId, {
    channel: "office-space",
    event
  });
}

export async function publishOfficeOccupantForAgent(
  db: BopoDb,
  realtimeHub: RealtimeHub | undefined,
  companyId: string,
  agentId: string
) {
  if (!realtimeHub) {
    return;
  }

  const occupant = await loadOfficeOccupantForAgent(db, companyId, agentId);
  if (!occupant) {
    realtimeHub.publish(
      createOfficeSpaceRealtimeEvent(companyId, {
        type: "office.occupant.left",
        occupantId: buildAgentOccupantId(agentId)
      })
    );
    return;
  }

  realtimeHub.publish(
    createOfficeSpaceRealtimeEvent(companyId, {
      type: "office.occupant.updated",
      occupant
    })
  );
}

export async function publishOfficeOccupantForApproval(
  db: BopoDb,
  realtimeHub: RealtimeHub | undefined,
  companyId: string,
  approvalId: string
) {
  if (!realtimeHub) {
    return;
  }

  const occupant = await loadOfficeOccupantForApproval(db, companyId, approvalId);
  if (!occupant) {
    realtimeHub.publish(
      createOfficeSpaceRealtimeEvent(companyId, {
        type: "office.occupant.left",
        occupantId: buildHireCandidateOccupantId(approvalId)
      })
    );
    return;
  }

  realtimeHub.publish(
    createOfficeSpaceRealtimeEvent(companyId, {
      type: "office.occupant.updated",
      occupant
    })
  );
}

async function listOfficeOccupants(db: BopoDb, companyId: string): Promise<OfficeOccupant[]> {
  const [agentRows, heartbeatRows, approvalRows, issueRows] = await Promise.all([
    listAgents(db, companyId),
    listHeartbeatRuns(db, companyId, 500),
    listApprovalRequests(db, companyId),
    db
      .select({
        id: issues.id,
        assigneeAgentId: issues.assigneeAgentId,
        claimedByHeartbeatRunId: issues.claimedByHeartbeatRunId,
        isClaimed: issues.isClaimed,
        title: issues.title,
        status: issues.status,
        updatedAt: issues.updatedAt
      })
      .from(issues)
      .where(eq(issues.companyId, companyId))
  ]);

  return sortOccupants([
    ...agentRows
      .map((agent) =>
        deriveAgentOccupant(agent, {
          pendingApprovals: approvalRows,
          heartbeatRows,
          issueRows
        })
      )
      .filter((occupant): occupant is OfficeOccupant => occupant !== null),
    ...approvalRows
      .map((approval) => deriveHireCandidateOccupant(approval))
      .filter((occupant): occupant is OfficeOccupant => occupant !== null)
  ]);
}

async function loadOfficeOccupantForAgent(db: BopoDb, companyId: string, agentId: string): Promise<OfficeOccupant | null> {
  const [agent] = await db
    .select({
      id: agents.id,
      companyId: agents.companyId,
      name: agents.name,
      avatarSeed: agents.avatarSeed,
      lucideIconName: agents.lucideIconName,
      role: agents.role,
      status: agents.status,
      providerType: agents.providerType,
      updatedAt: agents.updatedAt
    })
    .from(agents)
    .where(and(eq(agents.companyId, companyId), eq(agents.id, agentId)))
    .limit(1);

  if (!agent) {
    return null;
  }

  const [pendingApprovals, startedRuns, assignedIssues] = await Promise.all([
    db
      .select({
        id: approvalRequests.id,
        companyId: approvalRequests.companyId,
        requestedByAgentId: approvalRequests.requestedByAgentId,
        action: approvalRequests.action,
        payloadJson: approvalRequests.payloadJson,
        status: approvalRequests.status,
        createdAt: approvalRequests.createdAt,
        resolvedAt: approvalRequests.resolvedAt
      })
      .from(approvalRequests)
      .where(
        and(
          eq(approvalRequests.companyId, companyId),
          eq(approvalRequests.requestedByAgentId, agentId),
          eq(approvalRequests.status, "pending")
        )
      )
      .orderBy(desc(approvalRequests.createdAt)),
    db
      .select({
        id: heartbeatRuns.id,
        agentId: heartbeatRuns.agentId,
        status: heartbeatRuns.status,
        startedAt: heartbeatRuns.startedAt,
        finishedAt: heartbeatRuns.finishedAt
      })
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.agentId, agentId), eq(heartbeatRuns.status, "started")))
      .orderBy(desc(heartbeatRuns.startedAt)),
    db
      .select({
        id: issues.id,
        assigneeAgentId: issues.assigneeAgentId,
        claimedByHeartbeatRunId: issues.claimedByHeartbeatRunId,
        isClaimed: issues.isClaimed,
        title: issues.title,
        status: issues.status,
        updatedAt: issues.updatedAt
      })
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.assigneeAgentId, agentId)))
  ]);

  const claimedIssues =
    startedRuns[0] && startedRuns[0].status === "started"
      ? assignedIssues.filter((issue) => issue.isClaimed && issue.claimedByHeartbeatRunId === startedRuns[0]?.id)
      : [];

  return deriveAgentOccupant(agent, {
    pendingApprovals,
    heartbeatRows: startedRuns,
    issueRows: assignedIssues,
    claimedIssuesOverride: claimedIssues
  });
}

async function loadOfficeOccupantForApproval(db: BopoDb, companyId: string, approvalId: string): Promise<OfficeOccupant | null> {
  const approval = await getApprovalRequest(db, companyId, approvalId);
  return approval ? deriveHireCandidateOccupant(approval) : null;
}

function deriveAgentOccupant(
  agent: {
    id: string;
    companyId: string;
    name: string;
    avatarSeed?: string | null;
    lucideIconName?: string | null;
    role: string;
    status: string;
    providerType: string;
    updatedAt: Date;
  },
  input: {
    pendingApprovals: Array<{
      id: string;
      requestedByAgentId: string | null;
      action: string;
      payloadJson: string;
      status: string;
      createdAt: Date;
      resolvedAt: Date | null;
    }>;
    heartbeatRows: Array<{
      id: string;
      agentId: string;
      status: string;
      startedAt: Date;
      finishedAt: Date | null;
    }>;
    issueRows: Array<{
      id: string;
      assigneeAgentId: string | null;
      claimedByHeartbeatRunId: string | null;
      isClaimed: boolean;
      title: string;
      status: string;
      updatedAt: Date;
    }>;
    claimedIssuesOverride?: Array<{
      id: string;
      assigneeAgentId: string | null;
      claimedByHeartbeatRunId: string | null;
      isClaimed: boolean;
      title: string;
      status: string;
      updatedAt: Date;
    }>;
  }
): OfficeOccupant | null {
  if (agent.status === "terminated") {
    return null;
  }

  const pendingApproval = input.pendingApprovals
    .filter((approval) => approval.status === "pending" && approval.requestedByAgentId === agent.id)
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];

  const activeRun = input.heartbeatRows
    .filter((run) => run.status === "started" && run.agentId === agent.id && !run.finishedAt)
    .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())[0];

  const claimedIssues =
    input.claimedIssuesOverride ??
    input.issueRows
      .filter((issue) => issue.isClaimed && issue.claimedByHeartbeatRunId === activeRun?.id)
      .sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime());

  const nextAssignedIssue = input.issueRows
    .filter((issue) => issue.assigneeAgentId === agent.id && issue.status !== "done" && issue.status !== "canceled")
    .sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime())[0];

  if (pendingApproval) {
    return {
      id: buildAgentOccupantId(agent.id),
      kind: "agent",
      companyId: agent.companyId,
      agentId: agent.id,
      approvalId: pendingApproval.id,
      displayName: agent.name,
      role: agent.role,
      room: "security",
      status: "waiting_for_approval",
      taskLabel: `${formatActionLabel(pendingApproval.action)} approval`,
      providerType: normalizeProviderType(agent.providerType),
      avatarSeed: agent.avatarSeed ?? null,
      lucideIconName: agent.lucideIconName?.trim() ? agent.lucideIconName.trim() : null,
      focusEntityType: "approval",
      focusEntityId: pendingApproval.id,
      updatedAt: pendingApproval.createdAt.toISOString()
    };
  }

  if (activeRun) {
    return {
      id: buildAgentOccupantId(agent.id),
      kind: "agent",
      companyId: agent.companyId,
      agentId: agent.id,
      approvalId: null,
      displayName: agent.name,
      role: agent.role,
      room: "work_space",
      status: "working",
      taskLabel: claimedIssues[0]?.title ?? "Checking in on work",
      providerType: normalizeProviderType(agent.providerType),
      avatarSeed: agent.avatarSeed ?? null,
      lucideIconName: agent.lucideIconName?.trim() ? agent.lucideIconName.trim() : null,
      focusEntityType: claimedIssues[0] ? "issue" : "agent",
      focusEntityId: claimedIssues[0]?.id ?? agent.id,
      updatedAt: activeRun.startedAt.toISOString()
    };
  }

  if (agent.status === "paused") {
    return {
      id: buildAgentOccupantId(agent.id),
      kind: "agent",
      companyId: agent.companyId,
      agentId: agent.id,
      approvalId: null,
      displayName: agent.name,
      role: agent.role,
      room: "waiting_room",
      status: "paused",
      taskLabel: "Paused",
      providerType: normalizeProviderType(agent.providerType),
      avatarSeed: agent.avatarSeed ?? null,
      lucideIconName: agent.lucideIconName?.trim() ? agent.lucideIconName.trim() : null,
      focusEntityType: "agent",
      focusEntityId: agent.id,
      updatedAt: agent.updatedAt.toISOString()
    };
  }

  return {
    id: buildAgentOccupantId(agent.id),
    kind: "agent",
    companyId: agent.companyId,
    agentId: agent.id,
    approvalId: null,
    displayName: agent.name,
    role: agent.role,
    room: "waiting_room",
    status: "idle",
    taskLabel: nextAssignedIssue ? `Up next: ${nextAssignedIssue.title}` : "Waiting for work",
    providerType: normalizeProviderType(agent.providerType),
    avatarSeed: agent.avatarSeed ?? null,
    lucideIconName: agent.lucideIconName?.trim() ? agent.lucideIconName.trim() : null,
    focusEntityType: nextAssignedIssue ? "issue" : "agent",
    focusEntityId: nextAssignedIssue?.id ?? agent.id,
    updatedAt: nextAssignedIssue?.updatedAt.toISOString() ?? agent.updatedAt.toISOString()
  };
}

function deriveHireCandidateOccupant(approval: {
  id: string;
  companyId: string;
  action: string;
  payloadJson: string;
  status: string;
  createdAt: Date;
}): OfficeOccupant | null {
  if (approval.status !== "pending" || approval.action !== "hire_agent") {
    return null;
  }

  const payload = parsePayload(approval.payloadJson);
  const name = typeof payload.name === "string" ? payload.name : "Pending hire";
  const role = resolvePayloadRoleLabel(payload);
  const providerType =
    typeof payload.providerType === "string" ? normalizeProviderType(payload.providerType) : null;

  return {
    id: buildHireCandidateOccupantId(approval.id),
    kind: "hire_candidate",
    companyId: approval.companyId,
    agentId: null,
    approvalId: approval.id,
    displayName: name,
    role,
    room: "security",
    status: "waiting_for_approval",
    taskLabel: "Awaiting hire approval",
    providerType,
    avatarSeed: null,
    lucideIconName: null,
    focusEntityType: "approval",
    focusEntityId: approval.id,
    updatedAt: approval.createdAt.toISOString()
  };
}

function createRealtimeEvent(
  companyId: string,
  envelope: Extract<RealtimeEventEnvelope, { channel: "office-space" }>
): Extract<RealtimeMessage, { kind: "event" }> {
  return {
    kind: "event",
    companyId,
    ...envelope
  };
}

function sortOccupants(occupants: OfficeOccupant[]) {
  const roomOrder: Record<OfficeOccupant["room"], number> = {
    waiting_room: 0,
    work_space: 1,
    security: 2
  };

  return [...occupants].sort((a, b) => {
    const roomComparison = roomOrder[a.room] - roomOrder[b.room];
    if (roomComparison !== 0) {
      return roomComparison;
    }
    return a.displayName.localeCompare(b.displayName);
  });
}

function normalizeProviderType(value: string): OfficeOccupant["providerType"] {
  return value === "claude_code" ||
    value === "codex" ||
    value === "cursor" ||
    value === "opencode" ||
    value === "gemini_cli" ||
    value === "hermes_local" ||
    value === "openai_api" ||
    value === "anthropic_api" ||
    value === "openclaw_gateway" ||
    value === "http" ||
    value === "shell"
    ? value
    : null;
}

function formatActionLabel(action: string) {
  return action
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function resolvePayloadRoleLabel(payload: Record<string, unknown>) {
  const title = typeof payload.title === "string" ? payload.title.trim() : "";
  if (title) {
    return title;
  }
  const roleKeyValue = typeof payload.roleKey === "string" ? payload.roleKey.trim().toLowerCase() : "";
  const parsedRoleKey = roleKeyValue ? AgentRoleKeySchema.safeParse(roleKeyValue) : null;
  if (parsedRoleKey?.success) {
    return AGENT_ROLE_LABELS[parsedRoleKey.data];
  }
  const role = typeof payload.role === "string" ? payload.role.trim() : "";
  return role || null;
}

function parsePayload(payloadJson: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(payloadJson) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function buildAgentOccupantId(agentId: string) {
  return `agent:${agentId}`;
}

function buildHireCandidateOccupantId(approvalId: string) {
  return `hire-candidate:${approvalId}`;
}
