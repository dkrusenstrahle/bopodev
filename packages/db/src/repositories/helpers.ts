import { and, eq } from "drizzle-orm";
import type { BopoDb } from "../client";
import { agents, goals, issues, projects, templates } from "../schema";

export class RepositoryValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RepositoryValidationError";
  }
}

export async function assertProjectBelongsToCompany(db: BopoDb, companyId: string, projectId: string) {
  const [project] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.companyId, companyId), eq(projects.id, projectId)))
    .limit(1);
  if (!project) {
    throw new RepositoryValidationError("Project not found for company.");
  }
}

export async function assertIssueBelongsToCompany(db: BopoDb, companyId: string, issueId: string) {
  const [issue] = await db
    .select({ id: issues.id })
    .from(issues)
    .where(and(eq(issues.companyId, companyId), eq(issues.id, issueId)))
    .limit(1);
  if (!issue) {
    throw new RepositoryValidationError("Issue not found for company.");
  }
}

export async function assertGoalBelongsToCompany(db: BopoDb, companyId: string, goalId: string) {
  const [goal] = await db
    .select({ id: goals.id })
    .from(goals)
    .where(and(eq(goals.companyId, companyId), eq(goals.id, goalId)))
    .limit(1);
  if (!goal) {
    throw new RepositoryValidationError("Parent goal not found for company.");
  }
}

/** Ensures a goal can be linked to an issue: same company; project-scoped goals must match the issue's project. */
export async function assertIssueGoalAssignable(
  db: BopoDb,
  companyId: string,
  issueProjectId: string,
  goalId: string | null | undefined
) {
  if (!goalId) {
    return;
  }
  const [goal] = await db
    .select({ id: goals.id, projectId: goals.projectId })
    .from(goals)
    .where(and(eq(goals.companyId, companyId), eq(goals.id, goalId)))
    .limit(1);
  if (!goal) {
    throw new RepositoryValidationError("Goal not found for company.");
  }
  if (goal.projectId && goal.projectId !== issueProjectId) {
    throw new RepositoryValidationError("Goal is scoped to a different project than this issue.");
  }
}

/** Validates each goal can be linked to an issue (same company; project goals must match issue project). */
export async function assertIssueGoalsAssignable(
  db: BopoDb,
  companyId: string,
  issueProjectId: string,
  goalIds: string[]
) {
  for (const goalId of goalIds) {
    await assertIssueGoalAssignable(db, companyId, issueProjectId, goalId);
  }
}

export async function assertAgentBelongsToCompany(db: BopoDb, companyId: string, agentId: string) {
  const [agent] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.companyId, companyId), eq(agents.id, agentId)))
    .limit(1);
  if (!agent) {
    throw new RepositoryValidationError("Agent not found for company.");
  }
}

export async function assertTemplateBelongsToCompany(db: BopoDb, companyId: string, templateId: string) {
  const [template] = await db
    .select({ id: templates.id })
    .from(templates)
    .where(and(eq(templates.companyId, companyId), eq(templates.id, templateId)))
    .limit(1);
  if (!template) {
    throw new RepositoryValidationError("Template not found for company.");
  }
}

export function compactUpdate<T extends Record<string, unknown>>(input: T) {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

const GOAL_PARENT_CHAIN_MAX_DEPTH = 32;

type GoalLevel = "company" | "project" | "agent";

/** Walk parent_goal_id upward; detects cycles and whether `selfId` appears (would make self an ancestor of the parent). */
async function walkGoalParentChain(
  db: BopoDb,
  companyId: string,
  startParentId: string,
  selfId: string | undefined
) {
  const visited = new Set<string>();
  let current: string | null = startParentId;
  let depth = 0;
  while (current && depth < GOAL_PARENT_CHAIN_MAX_DEPTH) {
    if (selfId && current === selfId) {
      throw new RepositoryValidationError("Goal cannot be its own ancestor.");
    }
    if (visited.has(current)) {
      throw new RepositoryValidationError("Parent goal chain contains a cycle.");
    }
    visited.add(current);
    const [row] = await db
      .select({ parentGoalId: goals.parentGoalId })
      .from(goals)
      .where(and(eq(goals.companyId, companyId), eq(goals.id, current)))
      .limit(1);
    current = row?.parentGoalId?.trim() ? row.parentGoalId : null;
    depth += 1;
  }
  if (current && depth >= GOAL_PARENT_CHAIN_MAX_DEPTH) {
    throw new RepositoryValidationError("Parent goal chain exceeds maximum depth.");
  }
}

/**
 * Validates level ↔ projectId and optional parent_goal_id tree rules:
 * - company: projectId must be null; parent must be company-level (or absent).
 * - project: projectId required; parent must be company-level or absent.
 * - agent: parent absent, company-level, or project-level with same projectId as child (child projectId required in that case).
 */
export async function assertValidGoalHierarchy(
  db: BopoDb,
  companyId: string,
  input: {
    id?: string;
    level: GoalLevel;
    projectId: string | null;
    parentGoalId: string | null;
  }
) {
  const level = input.level;
  const projectId = input.projectId?.trim() ? input.projectId.trim() : null;
  const parentGoalId = input.parentGoalId?.trim() ? input.parentGoalId.trim() : null;

  if (level === "company" && projectId) {
    throw new RepositoryValidationError("Company goals cannot be scoped to a project.");
  }
  if (level === "project" && !projectId) {
    throw new RepositoryValidationError("Project goals must have a project.");
  }

  if (!parentGoalId) {
    return;
  }

  const [parent] = await db
    .select({
      id: goals.id,
      level: goals.level,
      projectId: goals.projectId
    })
    .from(goals)
    .where(and(eq(goals.companyId, companyId), eq(goals.id, parentGoalId)))
    .limit(1);

  if (!parent) {
    throw new RepositoryValidationError("Parent goal not found for company.");
  }

  const pLevel = parent.level as GoalLevel;
  if (pLevel !== "company" && pLevel !== "project") {
    throw new RepositoryValidationError("Parent goal must be company or project level.");
  }

  if (level === "company") {
    if (pLevel !== "company") {
      throw new RepositoryValidationError("Company goals may only have a company-level parent.");
    }
  } else if (level === "project") {
    if (pLevel !== "company") {
      throw new RepositoryValidationError("Project goals may only have a company-level parent.");
    }
  } else {
    // agent
    if (pLevel === "company") {
      // ok
    } else if (pLevel === "project") {
      const parentPid = parent.projectId?.trim() ? parent.projectId : null;
      if (!parentPid || parentPid !== projectId) {
        throw new RepositoryValidationError(
          "Agent goals with a project parent must use the same project as the parent goal."
        );
      }
    }
  }

  await walkGoalParentChain(db, companyId, parentGoalId, input.id);
}
