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
