import { and, asc, desc, eq, gt, inArray, notInArray, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { BopoDb } from "./client";
import {
  activityLogs,
  agents,
  approvalInboxStates,
  approvalRequests,
  auditEvents,
  companies,
  costLedger,
  goals,
  heartbeatRunQueue,
  heartbeatRuns,
  heartbeatRunMessages,
  issueAttachments,
  issueComments,
  issues,
  modelPricing,
  pluginConfigs,
  pluginRuns,
  plugins,
  projectWorkspaces,
  projects,
  templateInstalls,
  templateVersions,
  templates,
  touchUpdatedAtSql
} from "./schema";

export class RepositoryValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RepositoryValidationError";
  }
}

async function assertProjectBelongsToCompany(db: BopoDb, companyId: string, projectId: string) {
  const [project] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.companyId, companyId), eq(projects.id, projectId)))
    .limit(1);
  if (!project) {
    throw new RepositoryValidationError("Project not found for company.");
  }
}

async function assertIssueBelongsToCompany(db: BopoDb, companyId: string, issueId: string) {
  const [issue] = await db
    .select({ id: issues.id })
    .from(issues)
    .where(and(eq(issues.companyId, companyId), eq(issues.id, issueId)))
    .limit(1);
  if (!issue) {
    throw new RepositoryValidationError("Issue not found for company.");
  }
}

async function assertGoalBelongsToCompany(db: BopoDb, companyId: string, goalId: string) {
  const [goal] = await db
    .select({ id: goals.id })
    .from(goals)
    .where(and(eq(goals.companyId, companyId), eq(goals.id, goalId)))
    .limit(1);
  if (!goal) {
    throw new RepositoryValidationError("Parent goal not found for company.");
  }
}

async function assertAgentBelongsToCompany(db: BopoDb, companyId: string, agentId: string) {
  const [agent] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.companyId, companyId), eq(agents.id, agentId)))
    .limit(1);
  if (!agent) {
    throw new RepositoryValidationError("Agent not found for company.");
  }
}

async function assertTemplateBelongsToCompany(db: BopoDb, companyId: string, templateId: string) {
  const [template] = await db
    .select({ id: templates.id })
    .from(templates)
    .where(and(eq(templates.companyId, companyId), eq(templates.id, templateId)))
    .limit(1);
  if (!template) {
    throw new RepositoryValidationError("Template not found for company.");
  }
}

export async function createCompany(db: BopoDb, input: { name: string; mission?: string | null }) {
  const id = nanoid(12);
  await db.insert(companies).values({
    id,
    name: input.name,
    mission: input.mission ?? null
  });
  return { id, ...input };
}

export async function listCompanies(db: BopoDb) {
  return db.select().from(companies).orderBy(desc(companies.createdAt));
}

export async function updateCompany(
  db: BopoDb,
  input: { id: string; name?: string; mission?: string | null }
) {
  const [company] = await db
    .update(companies)
    .set(compactUpdate({ name: input.name, mission: input.mission }))
    .where(eq(companies.id, input.id))
    .returning();
  return company ?? null;
}

export async function deleteCompany(db: BopoDb, id: string) {
  const [deletedCompany] = await db.delete(companies).where(eq(companies.id, id)).returning({ id: companies.id });
  return Boolean(deletedCompany);
}

export async function listProjects(db: BopoDb, companyId: string) {
  const rows = await db.select().from(projects).where(eq(projects.companyId, companyId)).orderBy(desc(projects.createdAt));
  return hydrateProjectsWithWorkspaces(db, rows);
}

export async function createProject(
  db: BopoDb,
  input: {
    id?: string;
    companyId: string;
    name: string;
    description?: string | null;
    status?: "planned" | "active" | "paused" | "blocked" | "completed" | "archived";
    plannedStartAt?: Date | null;
    monthlyBudgetUsd?: string;
    usedBudgetUsd?: string;
    budgetWindowStartAt?: Date | null;
    executionWorkspacePolicy?: Record<string, unknown> | null;
    workspaceLocalPath?: string | null;
    workspaceGithubRepo?: string | null;
  }
) {
  const id = nanoid(12);
  await db.insert(projects).values({
    id,
    companyId: input.companyId,
    name: input.name,
    description: input.description ?? null,
    status: input.status ?? "planned",
    plannedStartAt: input.plannedStartAt ?? null,
    monthlyBudgetUsd: input.monthlyBudgetUsd ?? "100.0000",
    usedBudgetUsd: input.usedBudgetUsd ?? "0.0000",
    budgetWindowStartAt: input.budgetWindowStartAt ?? new Date(),
    executionWorkspacePolicy: input.executionWorkspacePolicy ? JSON.stringify(input.executionWorkspacePolicy) : null
  });
  const legacyWorkspaceLocalPath = input.workspaceLocalPath?.trim();
  const legacyWorkspaceGithubRepo = input.workspaceGithubRepo?.trim();
  if ((legacyWorkspaceLocalPath && legacyWorkspaceLocalPath.length > 0) || (legacyWorkspaceGithubRepo && legacyWorkspaceGithubRepo.length > 0)) {
    await createProjectWorkspace(db, {
      companyId: input.companyId,
      projectId: id,
      name: input.name,
      cwd: legacyWorkspaceLocalPath && legacyWorkspaceLocalPath.length > 0 ? legacyWorkspaceLocalPath : null,
      repoUrl: legacyWorkspaceGithubRepo && legacyWorkspaceGithubRepo.length > 0 ? legacyWorkspaceGithubRepo : null,
      isPrimary: true
    });
  }
  return getProjectById(db, input.companyId, id);
}

export async function updateProject(
  db: BopoDb,
  input: {
    companyId: string;
    id: string;
    name?: string;
    description?: string | null;
    status?: "planned" | "active" | "paused" | "blocked" | "completed" | "archived";
    plannedStartAt?: Date | null;
    monthlyBudgetUsd?: string;
    usedBudgetUsd?: string;
    budgetWindowStartAt?: Date | null;
    executionWorkspacePolicy?: Record<string, unknown> | null;
    workspaceLocalPath?: string | null;
    workspaceGithubRepo?: string | null;
  }
) {
  const [project] = await db
    .update(projects)
    .set(
      compactUpdate({
        name: input.name,
        description: input.description,
        status: input.status,
        plannedStartAt: input.plannedStartAt,
        monthlyBudgetUsd: input.monthlyBudgetUsd,
        usedBudgetUsd: input.usedBudgetUsd,
        budgetWindowStartAt: input.budgetWindowStartAt,
        executionWorkspacePolicy:
          input.executionWorkspacePolicy === undefined
            ? undefined
            : input.executionWorkspacePolicy === null
              ? null
              : JSON.stringify(input.executionWorkspacePolicy),
        updatedAt: touchUpdatedAtSql
      })
    )
    .where(and(eq(projects.companyId, input.companyId), eq(projects.id, input.id)))
    .returning();
  if (!project) {
    return null;
  }
  if (input.workspaceLocalPath !== undefined || input.workspaceGithubRepo !== undefined) {
    const existingWorkspaces = await listProjectWorkspaces(db, input.companyId, input.id);
    const primaryWorkspace = existingWorkspaces.find((workspace) => workspace.isPrimary) ?? existingWorkspaces[0] ?? null;
    const hasAnyWorkspaceField =
      (input.workspaceLocalPath?.trim() ?? "").length > 0 || (input.workspaceGithubRepo?.trim() ?? "").length > 0;
    if (!hasAnyWorkspaceField) {
      if (primaryWorkspace) {
        await updateProjectWorkspace(db, {
          companyId: input.companyId,
          projectId: input.id,
          id: primaryWorkspace.id,
          cwd: null,
          repoUrl: null
        });
      }
    } else if (primaryWorkspace) {
      await updateProjectWorkspace(db, {
        companyId: input.companyId,
        projectId: input.id,
        id: primaryWorkspace.id,
        cwd: input.workspaceLocalPath ?? null,
        repoUrl: input.workspaceGithubRepo ?? null,
        isPrimary: true
      });
    } else {
      await createProjectWorkspace(db, {
        companyId: input.companyId,
        projectId: input.id,
        name: input.name ?? project.name,
        cwd: input.workspaceLocalPath ?? null,
        repoUrl: input.workspaceGithubRepo ?? null,
        isPrimary: true
      });
    }
  }
  return getProjectById(db, input.companyId, project.id);
}

export async function listProjectWorkspaces(db: BopoDb, companyId: string, projectId: string) {
  return db
    .select()
    .from(projectWorkspaces)
    .where(and(eq(projectWorkspaces.companyId, companyId), eq(projectWorkspaces.projectId, projectId)))
    .orderBy(desc(projectWorkspaces.isPrimary), asc(projectWorkspaces.createdAt), asc(projectWorkspaces.id));
}

export async function createProjectWorkspace(
  db: BopoDb,
  input: {
    companyId: string;
    projectId: string;
    name: string;
    cwd?: string | null;
    repoUrl?: string | null;
    repoRef?: string | null;
    isPrimary?: boolean;
  }
) {
  const id = nanoid(12);
  return db.transaction(async (tx) => {
    const existingWorkspaces = await tx
      .select({ id: projectWorkspaces.id })
      .from(projectWorkspaces)
      .where(and(eq(projectWorkspaces.companyId, input.companyId), eq(projectWorkspaces.projectId, input.projectId)))
      .limit(1);
    const shouldBePrimary = input.isPrimary === true || existingWorkspaces.length === 0;
    if (shouldBePrimary) {
      await tx
        .update(projectWorkspaces)
        .set({ isPrimary: false, updatedAt: touchUpdatedAtSql })
        .where(and(eq(projectWorkspaces.companyId, input.companyId), eq(projectWorkspaces.projectId, input.projectId)));
    }
    const [workspace] = await tx
      .insert(projectWorkspaces)
      .values({
        id,
        companyId: input.companyId,
        projectId: input.projectId,
        name: input.name,
        cwd: input.cwd ?? null,
        repoUrl: input.repoUrl ?? null,
        repoRef: input.repoRef ?? null,
        isPrimary: shouldBePrimary
      })
      .returning();
    return workspace;
  });
}

export async function updateProjectWorkspace(
  db: BopoDb,
  input: {
    companyId: string;
    projectId: string;
    id: string;
    name?: string;
    cwd?: string | null;
    repoUrl?: string | null;
    repoRef?: string | null;
    isPrimary?: boolean;
  }
) {
  return db.transaction(async (tx) => {
    if (input.isPrimary === true) {
      await tx
        .update(projectWorkspaces)
        .set({ isPrimary: false, updatedAt: touchUpdatedAtSql })
        .where(and(eq(projectWorkspaces.companyId, input.companyId), eq(projectWorkspaces.projectId, input.projectId)));
    }

    const [workspace] = await tx
      .update(projectWorkspaces)
      .set(
        compactUpdate({
          name: input.name,
          cwd: input.cwd,
          repoUrl: input.repoUrl,
          repoRef: input.repoRef,
          isPrimary: input.isPrimary,
          updatedAt: touchUpdatedAtSql
        })
      )
      .where(
        and(
          eq(projectWorkspaces.companyId, input.companyId),
          eq(projectWorkspaces.projectId, input.projectId),
          eq(projectWorkspaces.id, input.id)
        )
      )
      .returning();

    if (!workspace) {
      return null;
    }

    const primary = await tx
      .select({ id: projectWorkspaces.id })
      .from(projectWorkspaces)
      .where(
        and(
          eq(projectWorkspaces.companyId, input.companyId),
          eq(projectWorkspaces.projectId, input.projectId),
          eq(projectWorkspaces.isPrimary, true)
        )
      )
      .limit(1);
    if (primary.length === 0) {
      await tx
        .update(projectWorkspaces)
        .set({ isPrimary: true, updatedAt: touchUpdatedAtSql })
        .where(
          and(
            eq(projectWorkspaces.companyId, input.companyId),
            eq(projectWorkspaces.projectId, input.projectId),
            eq(projectWorkspaces.id, workspace.id)
          )
        );
      const [rehydrated] = await tx
        .select()
        .from(projectWorkspaces)
        .where(eq(projectWorkspaces.id, workspace.id))
        .limit(1);
      return rehydrated ?? workspace;
    }
    return workspace;
  });
}

export async function deleteProjectWorkspace(
  db: BopoDb,
  input: { companyId: string; projectId: string; id: string }
) {
  return db.transaction(async (tx) => {
    const [workspace] = await tx
      .delete(projectWorkspaces)
      .where(
        and(
          eq(projectWorkspaces.companyId, input.companyId),
          eq(projectWorkspaces.projectId, input.projectId),
          eq(projectWorkspaces.id, input.id)
        )
      )
      .returning();
    if (!workspace) {
      return null;
    }
    if (workspace.isPrimary) {
      const [fallback] = await tx
        .select({ id: projectWorkspaces.id })
        .from(projectWorkspaces)
        .where(and(eq(projectWorkspaces.companyId, input.companyId), eq(projectWorkspaces.projectId, input.projectId)))
        .orderBy(asc(projectWorkspaces.createdAt), asc(projectWorkspaces.id))
        .limit(1);
      if (fallback) {
        await tx
          .update(projectWorkspaces)
          .set({ isPrimary: true, updatedAt: touchUpdatedAtSql })
          .where(eq(projectWorkspaces.id, fallback.id));
      }
    }
    return workspace;
  });
}

export async function syncProjectGoals(
  db: BopoDb,
  input: { companyId: string; projectId: string; goalIds: string[] }
) {
  const dedupedGoalIds = Array.from(new Set(input.goalIds));
  if (dedupedGoalIds.length > 0) {
    const matchingGoals = await db
      .select({ id: goals.id })
      .from(goals)
      .where(and(eq(goals.companyId, input.companyId), inArray(goals.id, dedupedGoalIds)));
    if (matchingGoals.length !== dedupedGoalIds.length) {
      throw new RepositoryValidationError("One or more goals do not belong to the company.");
    }
  }

  const detachWhere =
    dedupedGoalIds.length > 0
      ? and(eq(goals.companyId, input.companyId), eq(goals.projectId, input.projectId), notInArray(goals.id, dedupedGoalIds))
      : and(eq(goals.companyId, input.companyId), eq(goals.projectId, input.projectId));

  await db
    .update(goals)
    .set({
      projectId: null,
      updatedAt: touchUpdatedAtSql
    })
    .where(detachWhere);

  if (dedupedGoalIds.length > 0) {
    await db
      .update(goals)
      .set({
        projectId: input.projectId,
        updatedAt: touchUpdatedAtSql
      })
      .where(and(eq(goals.companyId, input.companyId), inArray(goals.id, dedupedGoalIds)));
  }
}

export async function deleteProject(db: BopoDb, companyId: string, id: string) {
  const [deletedProject] = await db
    .delete(projects)
    .where(and(eq(projects.companyId, companyId), eq(projects.id, id)))
    .returning({ id: projects.id });
  return Boolean(deletedProject);
}

async function getProjectById(db: BopoDb, companyId: string, projectId: string) {
  const [row] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.companyId, companyId), eq(projects.id, projectId)))
    .limit(1);
  if (!row) {
    return null;
  }
  const [project] = await hydrateProjectsWithWorkspaces(db, [row]);
  return project ?? null;
}

async function hydrateProjectsWithWorkspaces(
  db: BopoDb,
  projectRows: Array<typeof projects.$inferSelect>
) {
  if (projectRows.length === 0) {
    return [] as Array<
      typeof projects.$inferSelect & {
        executionWorkspacePolicy: Record<string, unknown> | null;
        monthlyBudgetUsd: number;
        usedBudgetUsd: number;
        budgetWindowStartAt: string | null;
        workspaces: Array<typeof projectWorkspaces.$inferSelect>;
        primaryWorkspace: typeof projectWorkspaces.$inferSelect | null;
      }
    >;
  }
  const projectIds = projectRows.map((project) => project.id);
  const companyIds = Array.from(new Set(projectRows.map((project) => project.companyId)));
  const workspaces = await db
    .select()
    .from(projectWorkspaces)
    .where(and(inArray(projectWorkspaces.projectId, projectIds), inArray(projectWorkspaces.companyId, companyIds)))
    .orderBy(desc(projectWorkspaces.isPrimary), asc(projectWorkspaces.createdAt), asc(projectWorkspaces.id));
  const workspacesByProject = new Map<string, Array<typeof projectWorkspaces.$inferSelect>>();
  for (const workspace of workspaces) {
    const existing = workspacesByProject.get(workspace.projectId) ?? [];
    existing.push(workspace);
    workspacesByProject.set(workspace.projectId, existing);
  }

  return projectRows.map((project) => {
    const projectWorkspacesRows = workspacesByProject.get(project.id) ?? [];
    const primaryWorkspace = projectWorkspacesRows.find((workspace) => workspace.isPrimary) ?? projectWorkspacesRows[0] ?? null;
    let executionWorkspacePolicy: Record<string, unknown> | null = null;
    if (project.executionWorkspacePolicy) {
      try {
        executionWorkspacePolicy = JSON.parse(project.executionWorkspacePolicy) as Record<string, unknown>;
      } catch {
        executionWorkspacePolicy = null;
      }
    }
    return {
      ...project,
      monthlyBudgetUsd: Number(project.monthlyBudgetUsd),
      usedBudgetUsd: Number(project.usedBudgetUsd),
      budgetWindowStartAt: project.budgetWindowStartAt ? project.budgetWindowStartAt.toISOString() : null,
      workspaceLocalPath: primaryWorkspace?.cwd ?? null,
      workspaceGithubRepo: primaryWorkspace?.repoUrl ?? null,
      executionWorkspacePolicy,
      workspaces: projectWorkspacesRows,
      primaryWorkspace
    };
  });
}

export async function listIssues(db: BopoDb, companyId: string, projectId?: string) {
  const where = projectId
    ? and(eq(issues.companyId, companyId), eq(issues.projectId, projectId))
    : eq(issues.companyId, companyId);

  return db.select().from(issues).where(where).orderBy(desc(issues.updatedAt));
}

export async function createIssue(
  db: BopoDb,
  input: {
    companyId: string;
    projectId: string;
    parentIssueId?: string | null;
    title: string;
    body?: string;
    status?: string;
    priority?: string;
    assigneeAgentId?: string | null;
    labels?: string[];
    tags?: string[];
  }
) {
  await assertProjectBelongsToCompany(db, input.companyId, input.projectId);
  if (input.parentIssueId) {
    await assertIssueBelongsToCompany(db, input.companyId, input.parentIssueId);
  }
  if (input.assigneeAgentId) {
    await assertAgentBelongsToCompany(db, input.companyId, input.assigneeAgentId);
  }
  const id = nanoid(12);
  await db.insert(issues).values({
    id,
    companyId: input.companyId,
    projectId: input.projectId,
    parentIssueId: input.parentIssueId ?? null,
    title: input.title,
    body: input.body,
    status: input.status ?? "todo",
    priority: input.priority ?? "none",
    assigneeAgentId: input.assigneeAgentId ?? null,
    labelsJson: JSON.stringify(input.labels ?? []),
    tagsJson: JSON.stringify(input.tags ?? [])
  });

  return { id, ...input };
}

export async function updateIssue(
  db: BopoDb,
  input: {
    companyId: string;
    id: string;
    projectId?: string;
    title?: string;
    body?: string | null;
    status?: string;
    priority?: string;
    assigneeAgentId?: string | null;
    labels?: string[];
    tags?: string[];
  }
) {
  if (input.projectId) {
    await assertProjectBelongsToCompany(db, input.companyId, input.projectId);
  }
  if (input.assigneeAgentId) {
    await assertAgentBelongsToCompany(db, input.companyId, input.assigneeAgentId);
  }
  const [issue] = await db
    .update(issues)
    .set(
      compactUpdate({
        projectId: input.projectId,
        title: input.title,
        body: input.body,
        status: input.status,
        priority: input.priority,
        assigneeAgentId: input.assigneeAgentId,
        labelsJson: input.labels ? JSON.stringify(input.labels) : undefined,
        tagsJson: input.tags ? JSON.stringify(input.tags) : undefined,
        updatedAt: touchUpdatedAtSql
      })
    )
    .where(and(eq(issues.companyId, input.companyId), eq(issues.id, input.id)))
    .returning();
  return issue ?? null;
}

export async function deleteIssue(db: BopoDb, companyId: string, id: string) {
  const [deletedIssue] = await db
    .delete(issues)
    .where(and(eq(issues.companyId, companyId), eq(issues.id, id)))
    .returning({ id: issues.id });
  return Boolean(deletedIssue);
}

export async function addIssueAttachment(
  db: BopoDb,
  input: {
    id?: string;
    companyId: string;
    issueId: string;
    projectId: string;
    fileName: string;
    mimeType?: string | null;
    fileSizeBytes: number;
    relativePath: string;
    uploadedByActorType?: "human" | "agent" | "system";
    uploadedByActorId?: string | null;
  }
) {
  await assertIssueBelongsToCompany(db, input.companyId, input.issueId);
  await assertProjectBelongsToCompany(db, input.companyId, input.projectId);
  const id = input.id ?? nanoid(14);
  await db.insert(issueAttachments).values({
    id,
    companyId: input.companyId,
    issueId: input.issueId,
    projectId: input.projectId,
    fileName: input.fileName,
    mimeType: input.mimeType ?? null,
    fileSizeBytes: input.fileSizeBytes,
    relativePath: input.relativePath,
    uploadedByActorType: input.uploadedByActorType ?? "human",
    uploadedByActorId: input.uploadedByActorId ?? null
  });
  return { id, ...input };
}

export async function listIssueAttachments(db: BopoDb, companyId: string, issueId: string) {
  return db
    .select()
    .from(issueAttachments)
    .where(and(eq(issueAttachments.companyId, companyId), eq(issueAttachments.issueId, issueId)))
    .orderBy(desc(issueAttachments.createdAt));
}

export async function getIssueAttachment(db: BopoDb, companyId: string, issueId: string, attachmentId: string) {
  const [attachment] = await db
    .select()
    .from(issueAttachments)
    .where(
      and(
        eq(issueAttachments.companyId, companyId),
        eq(issueAttachments.issueId, issueId),
        eq(issueAttachments.id, attachmentId)
      )
    )
    .limit(1);
  return attachment ?? null;
}

export async function deleteIssueAttachment(db: BopoDb, companyId: string, issueId: string, attachmentId: string) {
  const [deletedAttachment] = await db
    .delete(issueAttachments)
    .where(
      and(
        eq(issueAttachments.companyId, companyId),
        eq(issueAttachments.issueId, issueId),
        eq(issueAttachments.id, attachmentId)
      )
    )
    .returning();
  return deletedAttachment ?? null;
}

export async function addIssueComment(
  db: BopoDb,
  input: {
    companyId: string;
    issueId: string;
    authorType: "human" | "agent" | "system";
    authorId?: string | null;
    runId?: string | null;
    recipients?: Array<{
      recipientType: "agent" | "board" | "member";
      recipientId?: string | null;
      deliveryStatus?: "pending" | "dispatched" | "failed" | "skipped";
      dispatchedRunId?: string | null;
      dispatchedAt?: string | null;
      acknowledgedAt?: string | null;
    }>;
    body: string;
  }
) {
  await assertIssueBelongsToCompany(db, input.companyId, input.issueId);
  const id = nanoid(12);
  const [comment] = await db
    .insert(issueComments)
    .values({
      id,
      companyId: input.companyId,
      issueId: input.issueId,
      authorType: input.authorType,
      authorId: input.authorId ?? null,
      recipientsJson: JSON.stringify(input.recipients ?? []),
      runId: input.runId ?? null,
      body: input.body
    })
    .returning();
  if (!comment) {
    return {
      id,
      companyId: input.companyId,
      issueId: input.issueId,
      authorType: input.authorType,
      authorId: input.authorId ?? null,
      body: input.body,
      runId: input.runId ?? null,
      recipients: input.recipients ?? []
    };
  }
  return normalizeIssueComment(comment);
}

export async function listIssueComments(db: BopoDb, companyId: string, issueId: string) {
  const comments = await db
    .select()
    .from(issueComments)
    .where(and(eq(issueComments.companyId, companyId), eq(issueComments.issueId, issueId)))
    .orderBy(desc(issueComments.createdAt));
  return comments.map((comment) => normalizeIssueComment(comment));
}

export async function listIssueActivity(db: BopoDb, companyId: string, issueId: string, limit = 100) {
  return db
    .select()
    .from(activityLogs)
    .where(and(eq(activityLogs.companyId, companyId), eq(activityLogs.issueId, issueId)))
    .orderBy(desc(activityLogs.createdAt))
    .limit(limit);
}

export async function updateIssueComment(
  db: BopoDb,
  input: {
    companyId: string;
    issueId: string;
    id: string;
    body: string;
  }
) {
  const [comment] = await db
    .update(issueComments)
    .set({ body: input.body })
    .where(
      and(
        eq(issueComments.companyId, input.companyId),
        eq(issueComments.issueId, input.issueId),
        eq(issueComments.id, input.id)
      )
    )
    .returning();
  return comment ? normalizeIssueComment(comment) : null;
}

export async function updateIssueCommentRecipients(
  db: BopoDb,
  input: {
    companyId: string;
    issueId: string;
    id: string;
    recipients: Array<{
      recipientType: "agent" | "board" | "member";
      recipientId?: string | null;
      deliveryStatus?: "pending" | "dispatched" | "failed" | "skipped";
      dispatchedRunId?: string | null;
      dispatchedAt?: string | null;
      acknowledgedAt?: string | null;
    }>;
  }
) {
  const [comment] = await db
    .update(issueComments)
    .set({ recipientsJson: JSON.stringify(input.recipients ?? []) })
    .where(
      and(
        eq(issueComments.companyId, input.companyId),
        eq(issueComments.issueId, input.issueId),
        eq(issueComments.id, input.id)
      )
    )
    .returning();
  return comment ? normalizeIssueComment(comment) : null;
}

export async function deleteIssueComment(db: BopoDb, companyId: string, issueId: string, id: string) {
  const [deletedComment] = await db
    .delete(issueComments)
    .where(and(eq(issueComments.companyId, companyId), eq(issueComments.issueId, issueId), eq(issueComments.id, id)))
    .returning({ id: issueComments.id });
  return Boolean(deletedComment);
}

function normalizeIssueComment(comment: typeof issueComments.$inferSelect) {
  const { recipientsJson, ...rest } = comment;
  return {
    ...rest,
    recipients: parseIssueCommentRecipients(recipientsJson)
  };
}

function parseIssueCommentRecipients(raw: string | null) {
  if (!raw) {
    return [] as Array<{
      recipientType: "agent" | "board" | "member";
      recipientId: string | null;
      deliveryStatus: "pending" | "dispatched" | "failed" | "skipped";
      dispatchedRunId: string | null;
      dispatchedAt: string | null;
      acknowledgedAt: string | null;
    }>;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .map((entry) => {
        if (!entry || typeof entry !== "object") {
          return null;
        }
        const candidate = entry as Record<string, unknown>;
        const recipientTypeRaw = String(candidate.recipientType ?? "").trim();
        if (recipientTypeRaw !== "agent" && recipientTypeRaw !== "board" && recipientTypeRaw !== "member") {
          return null;
        }
        const recipientType = recipientTypeRaw as "agent" | "board" | "member";
        const deliveryStatusRaw = String(candidate.deliveryStatus ?? "").trim();
        const deliveryStatus =
          deliveryStatusRaw === "pending" ||
          deliveryStatusRaw === "dispatched" ||
          deliveryStatusRaw === "failed" ||
          deliveryStatusRaw === "skipped"
            ? deliveryStatusRaw
            : "pending";
        const recipientId = typeof candidate.recipientId === "string" && candidate.recipientId.trim().length > 0
          ? candidate.recipientId.trim()
          : null;
        const dispatchedRunId =
          typeof candidate.dispatchedRunId === "string" && candidate.dispatchedRunId.trim().length > 0
            ? candidate.dispatchedRunId.trim()
            : null;
        const dispatchedAt =
          typeof candidate.dispatchedAt === "string" && candidate.dispatchedAt.trim().length > 0
            ? candidate.dispatchedAt.trim()
            : null;
        const acknowledgedAt =
          typeof candidate.acknowledgedAt === "string" && candidate.acknowledgedAt.trim().length > 0
            ? candidate.acknowledgedAt.trim()
            : null;
        return {
          recipientType,
          recipientId,
          deliveryStatus,
          dispatchedRunId,
          dispatchedAt,
          acknowledgedAt
        };
      })
      .filter(Boolean) as Array<{
      recipientType: "agent" | "board" | "member";
      recipientId: string | null;
      deliveryStatus: "pending" | "dispatched" | "failed" | "skipped";
      dispatchedRunId: string | null;
      dispatchedAt: string | null;
      acknowledgedAt: string | null;
    }>;
  } catch {
    return [];
  }
}

export async function createGoal(
  db: BopoDb,
  input: {
    companyId: string;
    projectId?: string | null;
    parentGoalId?: string | null;
    level: "company" | "project" | "agent";
    title: string;
    description?: string;
  }
) {
  if (input.projectId) {
    await assertProjectBelongsToCompany(db, input.companyId, input.projectId);
  }
  if (input.parentGoalId) {
    await assertGoalBelongsToCompany(db, input.companyId, input.parentGoalId);
  }
  const id = nanoid(12);
  await db.insert(goals).values({
    id,
    companyId: input.companyId,
    projectId: input.projectId ?? null,
    parentGoalId: input.parentGoalId ?? null,
    level: input.level,
    title: input.title,
    description: input.description ?? null
  });
  return { id, ...input };
}

export async function listGoals(db: BopoDb, companyId: string) {
  return db.select().from(goals).where(eq(goals.companyId, companyId)).orderBy(desc(goals.updatedAt));
}

export async function updateGoal(
  db: BopoDb,
  input: {
    companyId: string;
    id: string;
    projectId?: string | null;
    parentGoalId?: string | null;
    level?: "company" | "project" | "agent";
    title?: string;
    description?: string | null;
    status?: string;
  }
) {
  if (input.projectId) {
    await assertProjectBelongsToCompany(db, input.companyId, input.projectId);
  }
  if (input.parentGoalId) {
    await assertGoalBelongsToCompany(db, input.companyId, input.parentGoalId);
  }
  const [goal] = await db
    .update(goals)
    .set(
      compactUpdate({
        projectId: input.projectId,
        parentGoalId: input.parentGoalId,
        level: input.level,
        title: input.title,
        description: input.description,
        status: input.status,
        updatedAt: touchUpdatedAtSql
      })
    )
    .where(and(eq(goals.companyId, input.companyId), eq(goals.id, input.id)))
    .returning();
  return goal ?? null;
}

export async function deleteGoal(db: BopoDb, companyId: string, id: string) {
  const [deletedGoal] = await db
    .delete(goals)
    .where(and(eq(goals.companyId, companyId), eq(goals.id, id)))
    .returning({ id: goals.id });
  return Boolean(deletedGoal);
}

export async function createAgent(
  db: BopoDb,
  input: {
    companyId: string;
    managerAgentId?: string | null;
    role: string;
    name: string;
    providerType:
      | "claude_code"
      | "codex"
      | "cursor"
      | "opencode"
      | "gemini_cli"
      | "openai_api"
      | "anthropic_api"
      | "http"
      | "shell";
    heartbeatCron: string;
    monthlyBudgetUsd: string;
    canHireAgents?: boolean;
    avatarSeed?: string;
    runtimeCommand?: string | null;
    runtimeArgsJson?: string;
    runtimeCwd?: string | null;
    runtimeEnvJson?: string;
    runtimeModel?: string | null;
    runtimeThinkingEffort?: "auto" | "low" | "medium" | "high";
    bootstrapPrompt?: string | null;
    runtimeTimeoutSec?: number;
    interruptGraceSec?: number;
    runPolicyJson?: string;
    initialState?: Record<string, unknown>;
  }
) {
  if (input.managerAgentId) {
    await assertAgentBelongsToCompany(db, input.companyId, input.managerAgentId);
  }
  const id = nanoid(12);
  const avatarSeed = input.avatarSeed ?? nanoid(10);
  await db.insert(agents).values({
    id,
    companyId: input.companyId,
    managerAgentId: input.managerAgentId ?? null,
    role: input.role,
    name: input.name,
    providerType: input.providerType,
    heartbeatCron: input.heartbeatCron,
    monthlyBudgetUsd: input.monthlyBudgetUsd,
    canHireAgents: input.canHireAgents ?? false,
    avatarSeed,
    runtimeCommand: input.runtimeCommand ?? null,
    runtimeArgsJson: input.runtimeArgsJson ?? "[]",
    runtimeCwd: input.runtimeCwd ?? null,
    runtimeEnvJson: input.runtimeEnvJson ?? "{}",
    runtimeModel: input.runtimeModel ?? null,
    runtimeThinkingEffort: input.runtimeThinkingEffort ?? "auto",
    bootstrapPrompt: input.bootstrapPrompt ?? null,
    runtimeTimeoutSec: input.runtimeTimeoutSec ?? 0,
    interruptGraceSec: input.interruptGraceSec ?? 15,
    runPolicyJson: input.runPolicyJson ?? "{}",
    stateBlob: JSON.stringify(input.initialState ?? {})
  });

  return { id, ...input, avatarSeed };
}

export async function listAgents(db: BopoDb, companyId: string) {
  return db.select().from(agents).where(eq(agents.companyId, companyId)).orderBy(desc(agents.createdAt));
}

export async function updateAgent(
  db: BopoDb,
  input: {
    companyId: string;
    id: string;
    managerAgentId?: string | null;
    role?: string;
    name?: string;
    providerType?:
      | "claude_code"
      | "codex"
      | "cursor"
      | "opencode"
      | "gemini_cli"
      | "openai_api"
      | "anthropic_api"
      | "http"
      | "shell";
    status?: string;
    heartbeatCron?: string;
    monthlyBudgetUsd?: string;
    canHireAgents?: boolean;
    runtimeCommand?: string | null;
    runtimeArgsJson?: string;
    runtimeCwd?: string | null;
    runtimeEnvJson?: string;
    runtimeModel?: string | null;
    runtimeThinkingEffort?: "auto" | "low" | "medium" | "high";
    bootstrapPrompt?: string | null;
    runtimeTimeoutSec?: number;
    interruptGraceSec?: number;
    runPolicyJson?: string;
    stateBlob?: Record<string, unknown>;
  }
) {
  if (input.managerAgentId) {
    await assertAgentBelongsToCompany(db, input.companyId, input.managerAgentId);
  }
  const [agent] = await db
    .update(agents)
    .set(
      compactUpdate({
        managerAgentId: input.managerAgentId,
        role: input.role,
        name: input.name,
        providerType: input.providerType,
        status: input.status,
        heartbeatCron: input.heartbeatCron,
        monthlyBudgetUsd: input.monthlyBudgetUsd,
        canHireAgents: input.canHireAgents,
        runtimeCommand: input.runtimeCommand,
        runtimeArgsJson: input.runtimeArgsJson,
        runtimeCwd: input.runtimeCwd,
        runtimeEnvJson: input.runtimeEnvJson,
        runtimeModel: input.runtimeModel,
        runtimeThinkingEffort: input.runtimeThinkingEffort,
        bootstrapPrompt: input.bootstrapPrompt,
        runtimeTimeoutSec: input.runtimeTimeoutSec,
        interruptGraceSec: input.interruptGraceSec,
        runPolicyJson: input.runPolicyJson,
        stateBlob: input.stateBlob ? JSON.stringify(input.stateBlob) : undefined,
        updatedAt: touchUpdatedAtSql
      })
    )
    .where(and(eq(agents.companyId, input.companyId), eq(agents.id, input.id)))
    .returning();
  return agent ?? null;
}

export async function deleteAgent(db: BopoDb, companyId: string, id: string) {
  const [deletedAgent] = await db
    .delete(agents)
    .where(and(eq(agents.companyId, companyId), eq(agents.id, id)))
    .returning({ id: agents.id });
  return Boolean(deletedAgent);
}

export async function appendAuditEvent(
  db: BopoDb,
  input: {
    companyId: string;
    actorType: "human" | "agent" | "system";
    actorId?: string | null;
    eventType: string;
    entityType: string;
    entityId: string;
    correlationId?: string | null;
    payload: Record<string, unknown>;
  }
) {
  const id = nanoid(14);
  await db.insert(auditEvents).values({
    id,
    companyId: input.companyId,
    actorType: input.actorType,
    actorId: input.actorId ?? null,
    eventType: input.eventType,
    entityType: input.entityType,
    entityId: input.entityId,
    correlationId: input.correlationId ?? null,
    payloadJson: JSON.stringify(input.payload)
  });
  return id;
}

export async function listAuditEvents(db: BopoDb, companyId: string, limit = 100) {
  return db
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.companyId, companyId))
    .orderBy(desc(auditEvents.createdAt))
    .limit(limit);
}

export async function createApprovalRequest(
  db: BopoDb,
  input: {
    companyId: string;
    requestedByAgentId?: string | null;
    action: string;
    payload: Record<string, unknown>;
  }
) {
  const id = nanoid(12);
  await db.insert(approvalRequests).values({
    id,
    companyId: input.companyId,
    requestedByAgentId: input.requestedByAgentId ?? null,
    action: input.action,
    payloadJson: JSON.stringify(input.payload),
    status: "pending"
  });
  return id;
}

export async function getApprovalRequest(db: BopoDb, companyId: string, approvalId: string) {
  const [approval] = await db
    .select()
    .from(approvalRequests)
    .where(and(eq(approvalRequests.companyId, companyId), eq(approvalRequests.id, approvalId)))
    .limit(1);

  return approval ?? null;
}

export async function listApprovalRequests(db: BopoDb, companyId: string) {
  return db
    .select()
    .from(approvalRequests)
    .where(eq(approvalRequests.companyId, companyId))
    .orderBy(desc(approvalRequests.createdAt));
}

export async function countPendingApprovalRequests(db: BopoDb, companyId: string) {
  const [row] = await db
    .select({ count: sql<number>`count(*)` })
    .from(approvalRequests)
    .where(and(eq(approvalRequests.companyId, companyId), eq(approvalRequests.status, "pending")));
  return Number(row?.count ?? 0);
}

export async function listApprovalInboxStates(db: BopoDb, companyId: string, actorId: string) {
  return db
    .select()
    .from(approvalInboxStates)
    .where(and(eq(approvalInboxStates.companyId, companyId), eq(approvalInboxStates.actorId, actorId)))
    .orderBy(desc(approvalInboxStates.updatedAt));
}

export async function markApprovalInboxSeen(
  db: BopoDb,
  input: {
    companyId: string;
    actorId: string;
    approvalId: string;
    seenAt?: Date;
  }
) {
  const seenAt = input.seenAt ?? new Date();
  await db
    .insert(approvalInboxStates)
    .values({
      companyId: input.companyId,
      actorId: input.actorId,
      approvalId: input.approvalId,
      seenAt
    })
    .onConflictDoUpdate({
      target: [approvalInboxStates.companyId, approvalInboxStates.actorId, approvalInboxStates.approvalId],
      set: {
        seenAt,
        updatedAt: sql`CURRENT_TIMESTAMP`
      }
    });
}

export async function markApprovalInboxDismissed(
  db: BopoDb,
  input: {
    companyId: string;
    actorId: string;
    approvalId: string;
    dismissedAt?: Date;
  }
) {
  const dismissedAt = input.dismissedAt ?? new Date();
  await db
    .insert(approvalInboxStates)
    .values({
      companyId: input.companyId,
      actorId: input.actorId,
      approvalId: input.approvalId,
      dismissedAt
    })
    .onConflictDoUpdate({
      target: [approvalInboxStates.companyId, approvalInboxStates.actorId, approvalInboxStates.approvalId],
      set: {
        dismissedAt,
        updatedAt: sql`CURRENT_TIMESTAMP`
      }
    });
}

export async function clearApprovalInboxDismissed(
  db: BopoDb,
  input: {
    companyId: string;
    actorId: string;
    approvalId: string;
  }
) {
  await db
    .insert(approvalInboxStates)
    .values({
      companyId: input.companyId,
      actorId: input.actorId,
      approvalId: input.approvalId,
      dismissedAt: null
    })
    .onConflictDoUpdate({
      target: [approvalInboxStates.companyId, approvalInboxStates.actorId, approvalInboxStates.approvalId],
      set: {
        dismissedAt: null,
        updatedAt: sql`CURRENT_TIMESTAMP`
      }
    });
}

export async function appendCost(
  db: BopoDb,
  input: {
    companyId: string;
    providerType: string;
    runtimeModelId?: string | null;
    pricingProviderType?: string | null;
    pricingModelId?: string | null;
    pricingSource?: "exact" | "missing" | null;
    tokenInput: number;
    tokenOutput: number;
    usdCost: string;
    projectId?: string | null;
    issueId?: string | null;
    agentId?: string | null;
  }
) {
  const id = nanoid(14);
  await db.insert(costLedger).values({
    id,
    companyId: input.companyId,
    providerType: input.providerType,
    runtimeModelId: input.runtimeModelId ?? null,
    pricingProviderType: input.pricingProviderType ?? null,
    pricingModelId: input.pricingModelId ?? null,
    pricingSource: input.pricingSource ?? null,
    tokenInput: input.tokenInput,
    tokenOutput: input.tokenOutput,
    usdCost: input.usdCost,
    projectId: input.projectId ?? null,
    issueId: input.issueId ?? null,
    agentId: input.agentId ?? null
  });
  return id;
}

export async function listCostEntries(db: BopoDb, companyId: string, limit = 200) {
  return db
    .select()
    .from(costLedger)
    .where(eq(costLedger.companyId, companyId))
    .orderBy(desc(costLedger.createdAt))
    .limit(limit);
}

export async function listHeartbeatRuns(db: BopoDb, companyId: string, limit = 100) {
  return db
    .select()
    .from(heartbeatRuns)
    .where(eq(heartbeatRuns.companyId, companyId))
    .orderBy(desc(heartbeatRuns.startedAt))
    .limit(limit);
}

export type HeartbeatQueueJobType = "manual" | "scheduler" | "resume" | "redo" | "comment_dispatch";
export type HeartbeatQueueJobStatus = "pending" | "running" | "completed" | "failed" | "dead_letter" | "canceled";

type HeartbeatQueueJobRow = typeof heartbeatRunQueue.$inferSelect;

function normalizeHeartbeatQueueJob(rawRow: HeartbeatQueueJobRow | Record<string, unknown>) {
  const row = {
    id: String((rawRow as Record<string, unknown>).id ?? ""),
    companyId: String((rawRow as Record<string, unknown>).companyId ?? (rawRow as Record<string, unknown>).company_id ?? ""),
    agentId: String((rawRow as Record<string, unknown>).agentId ?? (rawRow as Record<string, unknown>).agent_id ?? ""),
    jobType: String((rawRow as Record<string, unknown>).jobType ?? (rawRow as Record<string, unknown>).job_type ?? ""),
    payloadJson: String((rawRow as Record<string, unknown>).payloadJson ?? (rawRow as Record<string, unknown>).payload_json ?? "{}"),
    status: String((rawRow as Record<string, unknown>).status ?? "pending"),
    priority: Number((rawRow as Record<string, unknown>).priority ?? 100),
    idempotencyKey:
      typeof (rawRow as Record<string, unknown>).idempotencyKey === "string"
        ? ((rawRow as Record<string, unknown>).idempotencyKey as string)
        : typeof (rawRow as Record<string, unknown>).idempotency_key === "string"
          ? ((rawRow as Record<string, unknown>).idempotency_key as string)
          : null,
    availableAt: coerceDate((rawRow as Record<string, unknown>).availableAt ?? (rawRow as Record<string, unknown>).available_at) ?? new Date(),
    attemptCount: Number((rawRow as Record<string, unknown>).attemptCount ?? (rawRow as Record<string, unknown>).attempt_count ?? 0),
    maxAttempts: Number((rawRow as Record<string, unknown>).maxAttempts ?? (rawRow as Record<string, unknown>).max_attempts ?? 10),
    lastError:
      typeof (rawRow as Record<string, unknown>).lastError === "string"
        ? ((rawRow as Record<string, unknown>).lastError as string)
        : typeof (rawRow as Record<string, unknown>).last_error === "string"
          ? ((rawRow as Record<string, unknown>).last_error as string)
          : null,
    startedAt: coerceDate((rawRow as Record<string, unknown>).startedAt ?? (rawRow as Record<string, unknown>).started_at),
    finishedAt: coerceDate((rawRow as Record<string, unknown>).finishedAt ?? (rawRow as Record<string, unknown>).finished_at),
    heartbeatRunId:
      typeof (rawRow as Record<string, unknown>).heartbeatRunId === "string"
        ? ((rawRow as Record<string, unknown>).heartbeatRunId as string)
        : typeof (rawRow as Record<string, unknown>).heartbeat_run_id === "string"
          ? ((rawRow as Record<string, unknown>).heartbeat_run_id as string)
          : null,
    createdAt: coerceDate((rawRow as Record<string, unknown>).createdAt ?? (rawRow as Record<string, unknown>).created_at) ?? new Date(),
    updatedAt: coerceDate((rawRow as Record<string, unknown>).updatedAt ?? (rawRow as Record<string, unknown>).updated_at) ?? new Date()
  } satisfies HeartbeatQueueJobRow;
  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(row.payloadJson ?? "{}") as Record<string, unknown>;
  } catch {
    payload = {};
  }
  return {
    ...row,
    payload
  };
}

function coerceDate(value: unknown) {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

export async function enqueueHeartbeatJob(
  db: BopoDb,
  input: {
    companyId: string;
    agentId: string;
    jobType: HeartbeatQueueJobType;
    payload?: Record<string, unknown>;
    priority?: number;
    availableAt?: Date;
    maxAttempts?: number;
    idempotencyKey?: string | null;
  }
) {
  await assertAgentBelongsToCompany(db, input.companyId, input.agentId);
  const normalizedIdempotencyKey = input.idempotencyKey?.trim() || null;
  if (normalizedIdempotencyKey) {
    const [existing] = await db
      .select()
      .from(heartbeatRunQueue)
      .where(
        and(
          eq(heartbeatRunQueue.companyId, input.companyId),
          eq(heartbeatRunQueue.agentId, input.agentId),
          eq(heartbeatRunQueue.idempotencyKey, normalizedIdempotencyKey),
          notInArray(heartbeatRunQueue.status, ["failed", "dead_letter", "canceled"])
        )
      )
      .orderBy(desc(heartbeatRunQueue.createdAt))
      .limit(1);
    if (existing) {
      return normalizeHeartbeatQueueJob(existing);
    }
  }
  const id = nanoid(14);
  const [job] = await db
    .insert(heartbeatRunQueue)
    .values({
      id,
      companyId: input.companyId,
      agentId: input.agentId,
      jobType: input.jobType,
      payloadJson: JSON.stringify(input.payload ?? {}),
      status: "pending",
      priority: Number.isFinite(input.priority) ? Math.max(0, Math.floor(input.priority!)) : 100,
      idempotencyKey: normalizedIdempotencyKey,
      availableAt: input.availableAt ?? new Date(),
      maxAttempts: Number.isFinite(input.maxAttempts) ? Math.max(1, Math.floor(input.maxAttempts!)) : 10
    })
    .returning();
  if (!job) {
    throw new RepositoryValidationError("Failed to enqueue heartbeat job.");
  }
  return normalizeHeartbeatQueueJob(job);
}

export async function claimNextHeartbeatJob(db: BopoDb, companyId: string) {
  const result = await db.execute(sql`
    WITH candidate AS (
      SELECT q.id
      FROM heartbeat_run_queue q
      WHERE q.company_id = ${companyId}
        AND q.status = 'pending'
        AND q.available_at <= CURRENT_TIMESTAMP
        AND NOT EXISTS (
          SELECT 1
          FROM heartbeat_run_queue active_q
          WHERE active_q.company_id = q.company_id
            AND active_q.agent_id = q.agent_id
            AND active_q.status = 'running'
        )
        AND NOT EXISTS (
          SELECT 1
          FROM heartbeat_runs r
          WHERE r.company_id = q.company_id
            AND r.agent_id = q.agent_id
            AND r.status = 'started'
        )
      ORDER BY q.priority ASC, q.created_at ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    UPDATE heartbeat_run_queue q
    SET
      status = 'running',
      started_at = CURRENT_TIMESTAMP,
      updated_at = CURRENT_TIMESTAMP,
      attempt_count = q.attempt_count + 1
    FROM candidate c
    WHERE q.id = c.id
    RETURNING q.*;
  `);
  const row = (result.rows ?? [])[0] as Record<string, unknown> | undefined;
  return row ? normalizeHeartbeatQueueJob(row) : null;
}

export async function getHeartbeatQueueJob(db: BopoDb, companyId: string, id: string) {
  const [job] = await db
    .select()
    .from(heartbeatRunQueue)
    .where(and(eq(heartbeatRunQueue.companyId, companyId), eq(heartbeatRunQueue.id, id)))
    .limit(1);
  return job ? normalizeHeartbeatQueueJob(job) : null;
}

export async function markHeartbeatJobCompleted(
  db: BopoDb,
  input: { companyId: string; id: string; heartbeatRunId?: string | null }
) {
  const [job] = await db
    .update(heartbeatRunQueue)
    .set({
      status: "completed",
      heartbeatRunId: input.heartbeatRunId ?? null,
      finishedAt: new Date(),
      updatedAt: touchUpdatedAtSql
    })
    .where(and(eq(heartbeatRunQueue.companyId, input.companyId), eq(heartbeatRunQueue.id, input.id)))
    .returning();
  return job ? normalizeHeartbeatQueueJob(job) : null;
}

export async function markHeartbeatJobRetry(
  db: BopoDb,
  input: { companyId: string; id: string; retryAt: Date; error?: string | null; heartbeatRunId?: string | null }
) {
  const [job] = await db
    .update(heartbeatRunQueue)
    .set({
      status: "pending",
      availableAt: input.retryAt,
      lastError: input.error ?? null,
      heartbeatRunId: input.heartbeatRunId ?? null,
      updatedAt: touchUpdatedAtSql
    })
    .where(and(eq(heartbeatRunQueue.companyId, input.companyId), eq(heartbeatRunQueue.id, input.id)))
    .returning();
  return job ? normalizeHeartbeatQueueJob(job) : null;
}

export async function markHeartbeatJobFailed(
  db: BopoDb,
  input: { companyId: string; id: string; error?: string | null; heartbeatRunId?: string | null }
) {
  const [job] = await db
    .update(heartbeatRunQueue)
    .set({
      status: "failed",
      lastError: input.error ?? null,
      heartbeatRunId: input.heartbeatRunId ?? null,
      finishedAt: new Date(),
      updatedAt: touchUpdatedAtSql
    })
    .where(and(eq(heartbeatRunQueue.companyId, input.companyId), eq(heartbeatRunQueue.id, input.id)))
    .returning();
  return job ? normalizeHeartbeatQueueJob(job) : null;
}

export async function markHeartbeatJobDeadLetter(
  db: BopoDb,
  input: { companyId: string; id: string; error?: string | null; heartbeatRunId?: string | null }
) {
  const [job] = await db
    .update(heartbeatRunQueue)
    .set({
      status: "dead_letter",
      lastError: input.error ?? null,
      heartbeatRunId: input.heartbeatRunId ?? null,
      finishedAt: new Date(),
      updatedAt: touchUpdatedAtSql
    })
    .where(and(eq(heartbeatRunQueue.companyId, input.companyId), eq(heartbeatRunQueue.id, input.id)))
    .returning();
  return job ? normalizeHeartbeatQueueJob(job) : null;
}

export async function cancelHeartbeatJob(db: BopoDb, input: { companyId: string; id: string }) {
  const [job] = await db
    .update(heartbeatRunQueue)
    .set({
      status: "canceled",
      finishedAt: new Date(),
      updatedAt: touchUpdatedAtSql
    })
    .where(
      and(
        eq(heartbeatRunQueue.companyId, input.companyId),
        eq(heartbeatRunQueue.id, input.id),
        notInArray(heartbeatRunQueue.status, ["completed", "failed", "dead_letter", "canceled"])
      )
    )
    .returning();
  return job ? normalizeHeartbeatQueueJob(job) : null;
}

export async function listHeartbeatQueueJobs(
  db: BopoDb,
  input: {
    companyId: string;
    status?: HeartbeatQueueJobStatus;
    agentId?: string;
    jobType?: HeartbeatQueueJobType;
    limit?: number;
  }
) {
  const conditions = [eq(heartbeatRunQueue.companyId, input.companyId)];
  if (input.status) {
    conditions.push(eq(heartbeatRunQueue.status, input.status));
  }
  if (input.agentId) {
    conditions.push(eq(heartbeatRunQueue.agentId, input.agentId));
  }
  if (input.jobType) {
    conditions.push(eq(heartbeatRunQueue.jobType, input.jobType));
  }
  const limit = Math.min(Math.max(input.limit ?? 200, 1), 1000);
  const rows = await db
    .select()
    .from(heartbeatRunQueue)
    .where(and(...conditions))
    .orderBy(asc(heartbeatRunQueue.priority), asc(heartbeatRunQueue.availableAt), asc(heartbeatRunQueue.createdAt))
    .limit(limit);
  return rows.map((row) => normalizeHeartbeatQueueJob(row));
}

export async function getHeartbeatRun(db: BopoDb, companyId: string, runId: string) {
  const [run] = await db
    .select()
    .from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.id, runId)))
    .limit(1);
  return run ?? null;
}

export async function appendHeartbeatRunMessages(
  db: BopoDb,
  input: {
    companyId: string;
    runId: string;
    messages: Array<{
      id?: string;
      sequence: number;
      kind: string;
      label?: string | null;
      text?: string | null;
      payloadJson?: string | null;
      signalLevel?: "high" | "medium" | "low" | "noise" | null;
      groupKey?: string | null;
      source?: "stdout" | "stderr" | "trace_fallback" | null;
      createdAt?: Date;
    }>;
  }
) {
  if (input.messages.length === 0) {
    return [] as string[];
  }
  const values = input.messages.map((message) => ({
    id: message.id ?? nanoid(14),
    companyId: input.companyId,
    runId: input.runId,
    sequence: message.sequence,
    kind: message.kind,
    label: message.label ?? null,
    text: message.text ?? null,
    payloadJson: message.payloadJson ?? null,
    signalLevel: message.signalLevel ?? null,
    groupKey: message.groupKey ?? null,
    source: message.source ?? null,
    createdAt: message.createdAt ?? new Date()
  }));
  await db.insert(heartbeatRunMessages).values(values);
  return values.map((message) => message.id);
}

export async function listHeartbeatRunMessages(
  db: BopoDb,
  input: { companyId: string; runId: string; afterSequence?: number; limit?: number }
) {
  const limit = Math.min(Math.max(input.limit ?? 200, 1), 500);
  const whereClause =
    input.afterSequence !== undefined
      ? and(
          eq(heartbeatRunMessages.companyId, input.companyId),
          eq(heartbeatRunMessages.runId, input.runId),
          gt(heartbeatRunMessages.sequence, input.afterSequence)
        )
      : and(eq(heartbeatRunMessages.companyId, input.companyId), eq(heartbeatRunMessages.runId, input.runId));
  const rows = await db
    .select()
    .from(heartbeatRunMessages)
    .where(whereClause)
    .orderBy(asc(heartbeatRunMessages.sequence))
    .limit(limit + 1);
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  return {
    items,
    nextCursor: hasMore ? String(items[items.length - 1]?.sequence ?? "") : null
  };
}

export async function listHeartbeatRunMessagesForRuns(
  db: BopoDb,
  input: { companyId: string; runIds: string[]; perRunLimit?: number }
) {
  const runIds = Array.from(new Set(input.runIds.filter((runId) => runId.trim().length > 0)));
  if (runIds.length === 0) {
    return new Map<string, { items: Array<(typeof heartbeatRunMessages.$inferSelect)>; nextCursor: string | null }>();
  }
  const perRunLimit = Math.min(Math.max(input.perRunLimit ?? 60, 1), 500);
  const runIdValues = sql.join(runIds.map((runId) => sql`(${runId})`), sql`, `);
  const rankedRows = await db.execute(sql`
    WITH requested(run_id) AS (
      VALUES ${runIdValues}
    ),
    ranked AS (
      SELECT
        m.id,
        m.company_id,
        m.run_id,
        m.sequence,
        m.kind,
        m.label,
        m.text,
        m.payload_json,
        m.signal_level,
        m.group_key,
        m.source,
        m.created_at,
        ROW_NUMBER() OVER (PARTITION BY m.run_id ORDER BY m.sequence DESC) AS rn,
        COUNT(*) OVER (PARTITION BY m.run_id) AS total_count
      FROM heartbeat_run_messages m
      JOIN requested r ON r.run_id = m.run_id
      WHERE m.company_id = ${input.companyId}
    )
    SELECT
      id,
      company_id,
      run_id,
      sequence,
      kind,
      label,
      text,
      payload_json,
      signal_level,
      group_key,
      source,
      created_at,
      total_count
    FROM ranked
    WHERE rn <= ${perRunLimit}
    ORDER BY run_id ASC, sequence ASC
  `);
  const rows = (rankedRows.rows ?? []) as Array<{
    id: string;
    company_id: string;
    run_id: string;
    sequence: number;
    kind: string;
    label: string | null;
    text: string | null;
    payload_json: string | null;
    signal_level: string | null;
    group_key: string | null;
    source: string | null;
    created_at: Date | string;
    total_count: number;
  }>;
  const grouped = new Map<string, { items: Array<(typeof heartbeatRunMessages.$inferSelect)>; nextCursor: string | null }>();
  for (const runId of runIds) {
    grouped.set(runId, { items: [], nextCursor: null });
  }
  for (const row of rows) {
    const bucket = grouped.get(row.run_id) ?? { items: [], nextCursor: null };
    bucket.items.push({
      id: row.id,
      companyId: row.company_id,
      runId: row.run_id,
      sequence: row.sequence,
      kind: row.kind,
      label: row.label,
      text: row.text,
      payloadJson: row.payload_json,
      signalLevel: row.signal_level,
      groupKey: row.group_key,
      source: row.source,
      createdAt: row.created_at instanceof Date ? row.created_at : new Date(row.created_at)
    });
    if (row.total_count > perRunLimit) {
      bucket.nextCursor = String(row.sequence);
    }
    grouped.set(row.run_id, bucket);
  }
  return grouped;
}

export async function appendActivity(
  db: BopoDb,
  input: {
    companyId: string;
    issueId?: string | null;
    actorType: "human" | "agent" | "system";
    actorId?: string | null;
    eventType: string;
    payload: Record<string, unknown>;
  }
) {
  const id = nanoid(12);
  await db.insert(activityLogs).values({
    id,
    companyId: input.companyId,
    issueId: input.issueId ?? null,
    actorType: input.actorType,
    actorId: input.actorId ?? null,
    eventType: input.eventType,
    payloadJson: JSON.stringify(input.payload)
  });
  return id;
}

export async function upsertPlugin(
  db: BopoDb,
  input: {
    id: string;
    name: string;
    version: string;
    kind: string;
    runtimeType: string;
    runtimeEntrypoint: string;
    hooksJson?: string;
    capabilitiesJson?: string;
    manifestJson?: string;
  }
) {
  await db
    .insert(plugins)
    .values({
      id: input.id,
      name: input.name,
      version: input.version,
      kind: input.kind,
      runtimeType: input.runtimeType,
      runtimeEntrypoint: input.runtimeEntrypoint,
      hooksJson: input.hooksJson ?? "[]",
      capabilitiesJson: input.capabilitiesJson ?? "[]",
      manifestJson: input.manifestJson ?? "{}"
    })
    .onConflictDoUpdate({
      target: plugins.id,
      set: {
        name: input.name,
        version: input.version,
        kind: input.kind,
        runtimeType: input.runtimeType,
        runtimeEntrypoint: input.runtimeEntrypoint,
        hooksJson: input.hooksJson ?? "[]",
        capabilitiesJson: input.capabilitiesJson ?? "[]",
        manifestJson: input.manifestJson ?? "{}",
        updatedAt: touchUpdatedAtSql
      }
    });
  return input.id;
}

export async function listPlugins(db: BopoDb) {
  return db.select().from(plugins).orderBy(asc(plugins.name));
}

export async function updatePluginConfig(
  db: BopoDb,
  input: {
    companyId: string;
    pluginId: string;
    enabled?: boolean;
    priority?: number;
    configJson?: string;
    grantedCapabilitiesJson?: string;
  }
) {
  await db
    .insert(pluginConfigs)
    .values({
      companyId: input.companyId,
      pluginId: input.pluginId,
      enabled: input.enabled ?? false,
      priority: input.priority ?? 100,
      configJson: input.configJson ?? "{}",
      grantedCapabilitiesJson: input.grantedCapabilitiesJson ?? "[]"
    })
    .onConflictDoUpdate({
      target: [pluginConfigs.companyId, pluginConfigs.pluginId],
      set: compactUpdate({
        enabled: input.enabled,
        priority: input.priority,
        configJson: input.configJson,
        grantedCapabilitiesJson: input.grantedCapabilitiesJson,
        updatedAt: touchUpdatedAtSql
      })
    });
}

export async function deletePluginConfig(
  db: BopoDb,
  input: {
    companyId: string;
    pluginId: string;
  }
) {
  await db
    .delete(pluginConfigs)
    .where(and(eq(pluginConfigs.companyId, input.companyId), eq(pluginConfigs.pluginId, input.pluginId)));
}

export async function deletePluginById(db: BopoDb, pluginId: string) {
  await db.delete(plugins).where(eq(plugins.id, pluginId));
}

export async function listCompanyPluginConfigs(db: BopoDb, companyId: string) {
  return db
    .select({
      companyId: pluginConfigs.companyId,
      pluginId: pluginConfigs.pluginId,
      enabled: pluginConfigs.enabled,
      priority: pluginConfigs.priority,
      configJson: pluginConfigs.configJson,
      grantedCapabilitiesJson: pluginConfigs.grantedCapabilitiesJson,
      pluginName: plugins.name,
      pluginVersion: plugins.version,
      pluginKind: plugins.kind,
      runtimeType: plugins.runtimeType,
      runtimeEntrypoint: plugins.runtimeEntrypoint,
      hooksJson: plugins.hooksJson,
      capabilitiesJson: plugins.capabilitiesJson,
      manifestJson: plugins.manifestJson
    })
    .from(pluginConfigs)
    .innerJoin(plugins, eq(pluginConfigs.pluginId, plugins.id))
    .where(eq(pluginConfigs.companyId, companyId))
    .orderBy(asc(pluginConfigs.priority), asc(pluginConfigs.pluginId));
}

export async function appendPluginRun(
  db: BopoDb,
  input: {
    companyId: string;
    runId?: string | null;
    pluginId: string;
    hook: string;
    status: string;
    durationMs: number;
    error?: string | null;
    diagnosticsJson?: string;
  }
) {
  const id = nanoid(14);
  await db.insert(pluginRuns).values({
    id,
    companyId: input.companyId,
    runId: input.runId ?? null,
    pluginId: input.pluginId,
    hook: input.hook,
    status: input.status,
    durationMs: Math.max(0, Math.floor(input.durationMs)),
    error: input.error ?? null,
    diagnosticsJson: input.diagnosticsJson ?? "{}"
  });
  return id;
}

export async function listPluginRuns(
  db: BopoDb,
  input: { companyId: string; pluginId?: string; runId?: string; limit?: number }
) {
  const limit = Math.min(Math.max(input.limit ?? 200, 1), 1000);
  return db
    .select()
    .from(pluginRuns)
    .where(
      and(
        eq(pluginRuns.companyId, input.companyId),
        input.pluginId ? eq(pluginRuns.pluginId, input.pluginId) : undefined,
        input.runId ? eq(pluginRuns.runId, input.runId) : undefined
      )
    )
    .orderBy(desc(pluginRuns.createdAt))
    .limit(limit);
}

export async function listTemplates(db: BopoDb, companyId: string) {
  return db
    .select()
    .from(templates)
    .where(eq(templates.companyId, companyId))
    .orderBy(desc(templates.updatedAt), asc(templates.slug));
}

export async function getTemplate(db: BopoDb, companyId: string, templateId: string) {
  const [template] = await db
    .select()
    .from(templates)
    .where(and(eq(templates.companyId, companyId), eq(templates.id, templateId)))
    .limit(1);
  return template ?? null;
}

export async function getTemplateBySlug(db: BopoDb, companyId: string, slug: string) {
  const [template] = await db
    .select()
    .from(templates)
    .where(and(eq(templates.companyId, companyId), eq(templates.slug, slug)))
    .limit(1);
  return template ?? null;
}

export async function createTemplate(
  db: BopoDb,
  input: {
    companyId: string;
    slug: string;
    name: string;
    description?: string | null;
    currentVersion?: string;
    status?: "draft" | "published" | "archived";
    visibility?: "company" | "private";
    variablesJson?: string;
  }
) {
  const id = nanoid(12);
  const [template] = await db
    .insert(templates)
    .values({
      id,
      companyId: input.companyId,
      slug: input.slug,
      name: input.name,
      description: input.description ?? null,
      currentVersion: input.currentVersion ?? "1.0.0",
      status: input.status ?? "draft",
      visibility: input.visibility ?? "company",
      variablesJson: input.variablesJson ?? "[]"
    })
    .returning();
  return template ?? null;
}

export async function updateTemplate(
  db: BopoDb,
  input: {
    companyId: string;
    id: string;
    slug?: string;
    name?: string;
    description?: string | null;
    currentVersion?: string;
    status?: "draft" | "published" | "archived";
    visibility?: "company" | "private";
    variablesJson?: string;
  }
) {
  const [template] = await db
    .update(templates)
    .set(
      compactUpdate({
        slug: input.slug,
        name: input.name,
        description: input.description,
        currentVersion: input.currentVersion,
        status: input.status,
        visibility: input.visibility,
        variablesJson: input.variablesJson,
        updatedAt: touchUpdatedAtSql
      })
    )
    .where(and(eq(templates.companyId, input.companyId), eq(templates.id, input.id)))
    .returning();
  return template ?? null;
}

export async function deleteTemplate(db: BopoDb, companyId: string, templateId: string) {
  const [deleted] = await db
    .delete(templates)
    .where(and(eq(templates.companyId, companyId), eq(templates.id, templateId)))
    .returning({ id: templates.id });
  return Boolean(deleted);
}

export async function listTemplateVersions(db: BopoDb, companyId: string, templateId: string) {
  await assertTemplateBelongsToCompany(db, companyId, templateId);
  return db
    .select()
    .from(templateVersions)
    .where(and(eq(templateVersions.companyId, companyId), eq(templateVersions.templateId, templateId)))
    .orderBy(desc(templateVersions.createdAt));
}

export async function getTemplateVersionByVersion(
  db: BopoDb,
  input: { companyId: string; templateId: string; version: string }
) {
  const [row] = await db
    .select()
    .from(templateVersions)
    .where(
      and(
        eq(templateVersions.companyId, input.companyId),
        eq(templateVersions.templateId, input.templateId),
        eq(templateVersions.version, input.version)
      )
    )
    .limit(1);
  return row ?? null;
}

export async function getCurrentTemplateVersion(db: BopoDb, companyId: string, templateId: string) {
  const template = await getTemplate(db, companyId, templateId);
  if (!template) {
    return null;
  }
  return getTemplateVersionByVersion(db, {
    companyId,
    templateId,
    version: template.currentVersion
  });
}

export async function createTemplateVersion(
  db: BopoDb,
  input: {
    companyId: string;
    templateId: string;
    version: string;
    manifestJson: string;
  }
) {
  await assertTemplateBelongsToCompany(db, input.companyId, input.templateId);
  const id = nanoid(14);
  const [row] = await db
    .insert(templateVersions)
    .values({
      id,
      companyId: input.companyId,
      templateId: input.templateId,
      version: input.version,
      manifestJson: input.manifestJson
    })
    .returning();
  return row ?? null;
}

export async function listTemplateInstalls(
  db: BopoDb,
  input: { companyId: string; templateId?: string; limit?: number }
) {
  const limit = Math.min(Math.max(input.limit ?? 200, 1), 1000);
  return db
    .select()
    .from(templateInstalls)
    .where(
      and(
        eq(templateInstalls.companyId, input.companyId),
        input.templateId ? eq(templateInstalls.templateId, input.templateId) : undefined
      )
    )
    .orderBy(desc(templateInstalls.createdAt))
    .limit(limit);
}

export async function createTemplateInstall(
  db: BopoDb,
  input: {
    companyId: string;
    templateId?: string | null;
    templateVersionId?: string | null;
    status?: "applied" | "queued" | "failed";
    summaryJson?: string;
    variablesJson?: string;
  }
) {
  if (input.templateId) {
    await assertTemplateBelongsToCompany(db, input.companyId, input.templateId);
  }
  const id = nanoid(14);
  const [row] = await db
    .insert(templateInstalls)
    .values({
      id,
      companyId: input.companyId,
      templateId: input.templateId ?? null,
      templateVersionId: input.templateVersionId ?? null,
      status: input.status ?? "applied",
      summaryJson: input.summaryJson ?? "{}",
      variablesJson: input.variablesJson ?? "{}"
    })
    .returning();
  return row ?? null;
}

export async function listModelPricing(db: BopoDb, companyId: string) {
  return db
    .select()
    .from(modelPricing)
    .where(eq(modelPricing.companyId, companyId))
    .orderBy(asc(modelPricing.providerType), asc(modelPricing.modelId));
}

export async function getModelPricing(
  db: BopoDb,
  input: { companyId: string; providerType: string; modelId: string }
) {
  const rows = await db
    .select()
    .from(modelPricing)
    .where(
      and(
        eq(modelPricing.companyId, input.companyId),
        eq(modelPricing.providerType, input.providerType),
        eq(modelPricing.modelId, input.modelId)
      )
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function upsertModelPricing(
  db: BopoDb,
  input: {
    companyId: string;
    providerType: string;
    modelId: string;
    displayName?: string | null;
    inputUsdPer1M?: string | null;
    outputUsdPer1M?: string | null;
    currency?: string | null;
    updatedBy?: string | null;
  }
) {
  await db
    .insert(modelPricing)
    .values({
      companyId: input.companyId,
      providerType: input.providerType,
      modelId: input.modelId,
      displayName: input.displayName ?? null,
      inputUsdPer1M: input.inputUsdPer1M ?? "0.000000",
      outputUsdPer1M: input.outputUsdPer1M ?? "0.000000",
      currency: input.currency ?? "USD",
      updatedBy: input.updatedBy ?? null
    })
    .onConflictDoUpdate({
      target: [modelPricing.companyId, modelPricing.providerType, modelPricing.modelId],
      set: compactUpdate({
        displayName: input.displayName ?? null,
        inputUsdPer1M: input.inputUsdPer1M ?? "0.000000",
        outputUsdPer1M: input.outputUsdPer1M ?? "0.000000",
        currency: input.currency ?? "USD",
        updatedBy: input.updatedBy ?? null,
        updatedAt: touchUpdatedAtSql
      })
    });
}

function compactUpdate<T extends Record<string, unknown>>(input: T) {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}
