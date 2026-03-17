type AgentLike = {
  id: string;
  name: string;
  role: string;
  status: string;
  canHireAgents?: boolean | null;
};

export type HiringDelegateResolution =
  | {
      delegate: {
        agentId: string;
        name: string;
        role: string;
      };
      reason: "ceo_with_hiring_capability" | "first_hiring_capable_agent";
    }
  | {
      delegate: null;
      reason: "no_hiring_capable_agent";
    };

export function resolveHiringDelegate(agents: AgentLike[]): HiringDelegateResolution {
  const eligible = agents
    .filter((agent) => agent.status !== "terminated")
    .filter((agent) => Boolean(agent.canHireAgents));
  if (eligible.length === 0) {
    return {
      delegate: null,
      reason: "no_hiring_capable_agent"
    };
  }
  const normalized = eligible.map((agent) => ({
    ...agent,
    normalizedRole: agent.role.trim().toLowerCase(),
    normalizedName: agent.name.trim().toLowerCase()
  }));
  const ceo =
    normalized.find((agent) => agent.normalizedRole === "ceo") ??
    normalized.find((agent) => agent.normalizedName === "ceo");
  if (ceo) {
    return {
      delegate: {
        agentId: ceo.id,
        name: ceo.name,
        role: ceo.role
      },
      reason: "ceo_with_hiring_capability"
    };
  }
  const fallback = [...normalized].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))[0]!;
  return {
    delegate: {
      agentId: fallback.id,
      name: fallback.name,
      role: fallback.role
    },
    reason: "first_hiring_capable_agent"
  };
}
