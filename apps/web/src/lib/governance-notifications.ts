import type { Route } from "next";
import type { ApprovalRequest } from "bopodev-contracts";
import { AGENT_ROLE_LABELS, AGENT_ROLE_KEYS, type AgentRoleKey } from "bopodev-contracts";

export function getGovernanceToastContent(approval: ApprovalRequest, companyId: string) {
  const href = { pathname: "/inbox" as Route, query: { companyId, preset: "board-decisions" } } as const;

  if (approval.action === "hire_agent") {
    const name = typeof approval.payload.name === "string" ? approval.payload.name : "A new agent";
    const role = resolveApprovalRoleLabel(approval.payload);
    return {
      title: "Approval required",
      message: role ? `${name} is waiting for governance approval as ${role}.` : `${name} is waiting for governance approval.`,
      href,
      linkLabel: "Open inbox"
    };
  }

  if (approval.action === "activate_goal") {
    const title = typeof approval.payload.title === "string" ? approval.payload.title : "A goal";
    return {
      title: "Goal approval required",
      message: `${title} is ready for governance review before activation.`,
      href,
      linkLabel: "Open inbox"
    };
  }

  return {
    title: "Approval action required",
    message: `${formatApprovalAction(approval.action)} needs board approval in Inbox.`,
    href,
    linkLabel: "Open inbox"
  };
}

function normalizeRoleKey(value: string | null | undefined): AgentRoleKey | null {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  return AGENT_ROLE_KEYS.includes(normalized as AgentRoleKey) ? (normalized as AgentRoleKey) : null;
}

function resolveApprovalRoleLabel(payload: ApprovalRequest["payload"]) {
  const title = typeof payload.title === "string" ? payload.title.trim() : "";
  if (title) {
    return title;
  }
  const roleKey = normalizeRoleKey(typeof payload.roleKey === "string" ? payload.roleKey : null);
  if (roleKey) {
    return AGENT_ROLE_LABELS[roleKey];
  }
  return typeof payload.role === "string" ? payload.role : null;
}

function formatApprovalAction(action: ApprovalRequest["action"]) {
  return action
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}
