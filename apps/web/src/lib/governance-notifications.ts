import type { Route } from "next";
import type { ApprovalRequest } from "bopodev-contracts";

export function getGovernanceToastContent(approval: ApprovalRequest, companyId: string) {
  const href = { pathname: "/governance" as Route, query: { companyId } } as const;

  if (approval.action === "hire_agent") {
    const name = typeof approval.payload.name === "string" ? approval.payload.name : "A new agent";
    const role = typeof approval.payload.role === "string" ? approval.payload.role : null;
    return {
      title: "Approval required",
      message: role ? `${name} is waiting for governance approval as ${role}.` : `${name} is waiting for governance approval.`,
      href,
      linkLabel: "Open approvals"
    };
  }

  if (approval.action === "activate_goal") {
    const title = typeof approval.payload.title === "string" ? approval.payload.title : "A goal";
    return {
      title: "Goal approval required",
      message: `${title} is ready for governance review before activation.`,
      href,
      linkLabel: "Open approvals"
    };
  }

  return {
    title: "Approval action required",
    message: `${formatApprovalAction(approval.action)} needs board approval in Governance.`,
    href,
    linkLabel: "Open approvals"
  };
}

function formatApprovalAction(action: ApprovalRequest["action"]) {
  return action
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}
