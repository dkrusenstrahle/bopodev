import { Router } from "express";
import { mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { ProjectSchema } from "bopodev-contracts";
import {
  appendAuditEvent,
  createProject,
  createProjectWorkspace,
  deleteProject,
  deleteProjectWorkspace,
  listProjects,
  listProjectWorkspaces,
  syncProjectGoals,
  updateProject,
  updateProjectWorkspace
} from "bopodev-db";
import type { AppContext } from "../context";
import { sendError, sendOk, sendOkValidated } from "../http";
import { normalizeCompanyWorkspacePath, resolveProjectWorkspacePath } from "../lib/instance-paths";
import { requireCompanyScope } from "../middleware/company-scope";
import { requirePermission } from "../middleware/request-actor";

const projectStatusSchema = z.enum(["planned", "active", "paused", "blocked", "completed", "archived"]);
const executionWorkspacePolicySchema = z
  .object({
    mode: z.enum(["project_primary", "isolated", "agent_default"]).optional(),
    strategy: z
      .object({
        type: z.enum(["git_worktree"]).optional(),
        rootDir: z.string().optional().nullable(),
        branchPrefix: z.string().optional().nullable()
      })
      .optional()
      .nullable(),
    credentials: z
      .object({
        mode: z.enum(["host", "env_token"]).optional(),
        tokenEnvVar: z.string().optional().nullable(),
        username: z.string().optional().nullable()
      })
      .optional()
      .nullable(),
    allowRemotes: z.array(z.string().min(1)).optional().nullable(),
    allowBranchPrefixes: z.array(z.string().min(1)).optional().nullable()
  })
  .partial();

const createProjectSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  status: projectStatusSchema.default("planned"),
  plannedStartAt: z.string().optional(),
  monthlyBudgetUsd: z.number().positive().default(100),
  executionWorkspacePolicy: executionWorkspacePolicySchema.optional().nullable(),
  workspace: z
    .object({
      name: z.string().min(1).optional(),
      cwd: z.string().optional().nullable(),
      repoUrl: z.string().url().optional().nullable(),
      repoRef: z.string().optional().nullable(),
      isPrimary: z.boolean().optional().default(true)
    })
    .optional(),
  goalIds: z.array(z.string().min(1)).default([])
});

const updateProjectSchema = z
  .object({
    name: z.string().min(1).optional(),
    description: z.string().nullable().optional(),
    status: projectStatusSchema.optional(),
    plannedStartAt: z.string().nullable().optional(),
    monthlyBudgetUsd: z.number().positive().optional(),
    executionWorkspacePolicy: executionWorkspacePolicySchema.nullable().optional(),
    goalIds: z.array(z.string().min(1)).optional()
  })
  .refine((payload) => Object.keys(payload).length > 0, "At least one field must be provided.");

const createProjectWorkspaceSchema = z
  .object({
    name: z.string().min(1).optional(),
    cwd: z.string().optional().nullable(),
    repoUrl: z.string().url().optional().nullable(),
    repoRef: z.string().optional().nullable(),
    isPrimary: z.boolean().optional().default(false)
  })
  .superRefine((value, ctx) => {
    const hasCwd = Boolean(value.cwd?.trim());
    const hasRepoUrl = Boolean(value.repoUrl?.trim());
    if (!hasCwd && !hasRepoUrl) {
      ctx.addIssue({
        code: "custom",
        message: "Workspace must include at least one of cwd or repoUrl.",
        path: ["cwd"]
      });
    }
  });

const updateProjectWorkspaceSchema = z
  .object({
    name: z.string().min(1).optional(),
    cwd: z.string().nullable().optional(),
    repoUrl: z.string().url().nullable().optional(),
    repoRef: z.string().nullable().optional(),
    isPrimary: z.boolean().optional()
  })
  .refine((payload) => Object.keys(payload).length > 0, "At least one field must be provided.");

function parsePlannedStartAt(value?: string | null) {
  if (!value) {
    return null;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error("Invalid plannedStartAt value.");
  }
  return parsed;
}

export function createProjectsRouter(ctx: AppContext) {
  const router = Router();
  router.use(requireCompanyScope);

  router.get("/", async (req, res) => {
    const projects = await listProjects(ctx.db, req.companyId!);
    const withDiagnostics = await Promise.all(projects.map((project) => enrichProjectDiagnostics(req.companyId!, project)));
    return sendOkValidated(res, ProjectSchema.array(), withDiagnostics, "projects.list");
  });

  router.post("/", async (req, res) => {
    requirePermission("projects:write")(req, res, () => {});
    if (res.headersSent) {
      return;
    }
    const parsed = createProjectSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(res, parsed.error.message, 422);
    }
    const project = await createProject(ctx.db, {
      companyId: req.companyId!,
      name: parsed.data.name,
      description: parsed.data.description,
      status: parsed.data.status,
      plannedStartAt: parsePlannedStartAt(parsed.data.plannedStartAt),
      monthlyBudgetUsd: parsed.data.monthlyBudgetUsd.toFixed(4),
      executionWorkspacePolicy: parsed.data.executionWorkspacePolicy ?? null
    });
    if (!project) {
      return sendError(res, "Project creation failed.", 500);
    }
    if (parsed.data.workspace) {
      let normalizedWorkspace: ReturnType<typeof normalizeWorkspaceInput>;
      try {
        normalizedWorkspace = normalizeWorkspaceInput(req.companyId!, parsed.data.workspace);
      } catch (error) {
        return sendError(res, String(error), 422);
      }
      if (!normalizedWorkspace.cwd && !normalizedWorkspace.repoUrl) {
        return sendError(res, "Workspace must include at least one of cwd or repoUrl.", 422);
      }
      const workspace = await createProjectWorkspace(ctx.db, {
        companyId: req.companyId!,
        projectId: project!.id,
        name: normalizedWorkspace.name,
        cwd: normalizedWorkspace.cwd ?? null,
        repoUrl: normalizedWorkspace.repoUrl ?? null,
        repoRef: normalizedWorkspace.repoRef ?? null,
        isPrimary: normalizedWorkspace.isPrimary
      });
      if (workspace?.cwd) {
        await mkdir(workspace.cwd, { recursive: true });
      }
    } else {
      const defaultWorkspaceCwd = resolveProjectWorkspacePath(req.companyId!, project.id);
      await mkdir(defaultWorkspaceCwd, { recursive: true });
      const workspace = await createProjectWorkspace(ctx.db, {
        companyId: req.companyId!,
        projectId: project.id,
        name: "Primary workspace",
        cwd: defaultWorkspaceCwd,
        isPrimary: true
      });
      if (!workspace) {
        return sendError(res, "Project workspace provisioning failed.", 500);
      }
    }
    await syncProjectGoals(ctx.db, {
      companyId: req.companyId!,
      projectId: project.id,
      goalIds: parsed.data.goalIds
    });
    const [hydratedProject] = await listProjects(ctx.db, req.companyId!).then((projects) => projects.filter((entry) => entry.id === project.id));
    await appendAuditEvent(ctx.db, {
      companyId: req.companyId!,
      actorType: "human",
      eventType: "project.created",
      entityType: "project",
      entityId: project.id,
      payload: hydratedProject ?? project
    });
    return sendOk(res, await enrichProjectDiagnostics(req.companyId!, hydratedProject ?? project));
  });

  router.put("/:projectId", async (req, res) => {
    requirePermission("projects:write")(req, res, () => {});
    if (res.headersSent) {
      return;
    }
    const parsed = updateProjectSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(res, parsed.error.message, 422);
    }

    const project = await updateProject(ctx.db, {
      companyId: req.companyId!,
      id: req.params.projectId,
      name: parsed.data.name,
      description: parsed.data.description,
      status: parsed.data.status,
      plannedStartAt:
        parsed.data.plannedStartAt === undefined ? undefined : parsePlannedStartAt(parsed.data.plannedStartAt),
      monthlyBudgetUsd: parsed.data.monthlyBudgetUsd === undefined ? undefined : parsed.data.monthlyBudgetUsd.toFixed(4),
      executionWorkspacePolicy: parsed.data.executionWorkspacePolicy
    });
    if (!project) {
      return sendError(res, "Project not found.", 404);
    }

    if (parsed.data.goalIds) {
      await syncProjectGoals(ctx.db, {
        companyId: req.companyId!,
        projectId: project.id,
        goalIds: parsed.data.goalIds
      });
    }

    await appendAuditEvent(ctx.db, {
      companyId: req.companyId!,
      actorType: "human",
      eventType: "project.updated",
      entityType: "project",
      entityId: project.id,
      payload: project
    });
    return sendOk(res, await enrichProjectDiagnostics(req.companyId!, project));
  });

  router.get("/:projectId/workspaces", async (req, res) => {
    const projects = await listProjects(ctx.db, req.companyId!);
    const project = projects.find((entry) => entry.id === req.params.projectId);
    if (!project) {
      return sendError(res, "Project not found.", 404);
    }
    const workspaces = await listProjectWorkspaces(ctx.db, req.companyId!, req.params.projectId);
    return sendOk(res, workspaces);
  });

  router.post("/:projectId/workspaces", async (req, res) => {
    requirePermission("projects:write")(req, res, () => {});
    if (res.headersSent) {
      return;
    }
    const parsed = createProjectWorkspaceSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(res, parsed.error.message, 422);
    }
    const projects = await listProjects(ctx.db, req.companyId!);
    const project = projects.find((entry) => entry.id === req.params.projectId);
    if (!project) {
      return sendError(res, "Project not found.", 404);
    }
    let workspaceInput: ReturnType<typeof normalizeWorkspaceInput>;
    try {
      workspaceInput = normalizeWorkspaceInput(req.companyId!, parsed.data);
    } catch (error) {
      return sendError(res, String(error), 422);
    }
    if (!workspaceInput.cwd && !workspaceInput.repoUrl) {
      return sendError(res, "Workspace must include at least one of cwd or repoUrl.", 422);
    }
    const created = await createProjectWorkspace(ctx.db, {
      companyId: req.companyId!,
      projectId: req.params.projectId,
      name: workspaceInput.name,
      cwd: workspaceInput.cwd ?? null,
      repoUrl: workspaceInput.repoUrl ?? null,
      repoRef: workspaceInput.repoRef ?? null,
      isPrimary: workspaceInput.isPrimary
    });
    if (!created) {
      return sendError(res, "Project workspace creation failed.", 500);
    }
    if (created.cwd) {
      await mkdir(created.cwd, { recursive: true });
    }
    await appendAuditEvent(ctx.db, {
      companyId: req.companyId!,
      actorType: "human",
      eventType: "project.workspace_created",
      entityType: "project_workspace",
      entityId: created.id,
      payload: created as unknown as Record<string, unknown>
    });
    return sendOk(res, created);
  });

  router.put("/:projectId/workspaces/:workspaceId", async (req, res) => {
    requirePermission("projects:write")(req, res, () => {});
    if (res.headersSent) {
      return;
    }
    const parsed = updateProjectWorkspaceSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(res, parsed.error.message, 422);
    }
    let workspaceInput: ReturnType<typeof normalizeWorkspaceInput>;
    try {
      workspaceInput = normalizeWorkspaceInput(req.companyId!, parsed.data);
    } catch (error) {
      return sendError(res, String(error), 422);
    }
    if (parsed.data.cwd !== undefined || parsed.data.repoUrl !== undefined) {
      const hasCwd = workspaceInput.cwd !== null && workspaceInput.cwd !== undefined && workspaceInput.cwd.length > 0;
      const hasRepo = workspaceInput.repoUrl !== null && workspaceInput.repoUrl !== undefined && workspaceInput.repoUrl.length > 0;
      if (!hasCwd && !hasRepo) {
        return sendError(res, "Workspace must include at least one of cwd or repoUrl.", 422);
      }
    }

    const updated = await updateProjectWorkspace(ctx.db, {
      companyId: req.companyId!,
      projectId: req.params.projectId,
      id: req.params.workspaceId,
      name: workspaceInput.name,
      cwd: workspaceInput.cwd,
      repoUrl: workspaceInput.repoUrl,
      repoRef: workspaceInput.repoRef,
      isPrimary: workspaceInput.isPrimary
    });
    if (!updated) {
      return sendError(res, "Project workspace not found.", 404);
    }
    if (updated.cwd) {
      await mkdir(updated.cwd, { recursive: true });
    }
    await appendAuditEvent(ctx.db, {
      companyId: req.companyId!,
      actorType: "human",
      eventType: "project.workspace_updated",
      entityType: "project_workspace",
      entityId: updated.id,
      payload: updated as unknown as Record<string, unknown>
    });
    return sendOk(res, updated);
  });

  router.delete("/:projectId/workspaces/:workspaceId", async (req, res) => {
    requirePermission("projects:write")(req, res, () => {});
    if (res.headersSent) {
      return;
    }
    const deleted = await deleteProjectWorkspace(ctx.db, {
      companyId: req.companyId!,
      projectId: req.params.projectId,
      id: req.params.workspaceId
    });
    if (!deleted) {
      return sendError(res, "Project workspace not found.", 404);
    }
    await appendAuditEvent(ctx.db, {
      companyId: req.companyId!,
      actorType: "human",
      eventType: "project.workspace_deleted",
      entityType: "project_workspace",
      entityId: req.params.workspaceId,
      payload: deleted as unknown as Record<string, unknown>
    });
    return sendOk(res, { deleted: true });
  });

  router.delete("/:projectId", async (req, res) => {
    requirePermission("projects:write")(req, res, () => {});
    if (res.headersSent) {
      return;
    }
    const deleted = await deleteProject(ctx.db, req.companyId!, req.params.projectId);
    if (!deleted) {
      return sendError(res, "Project not found.", 404);
    }

    await appendAuditEvent(ctx.db, {
      companyId: req.companyId!,
      actorType: "human",
      eventType: "project.deleted",
      entityType: "project",
      entityId: req.params.projectId,
      payload: { id: req.params.projectId }
    });
    return sendOk(res, { deleted: true });
  });

  return router;
}

function normalizeWorkspaceInput(
  companyId: string,
  value:
    | {
        name?: string;
        cwd?: string | null;
        repoUrl?: string | null;
        repoRef?: string | null;
        isPrimary?: boolean;
      }
    | undefined
) {
  if (!value) {
    return {
      name: "Workspace",
      cwd: null,
      repoUrl: null,
      repoRef: null,
      isPrimary: false
    };
  }
  const cwd =
    value.cwd && value.cwd.trim().length > 0
      ? normalizeCompanyWorkspacePath(companyId, value.cwd, { requireAbsoluteInput: true })
      : null;
  const repoUrl = value.repoUrl && value.repoUrl.trim().length > 0 ? value.repoUrl.trim() : null;
  const repoRef = value.repoRef && value.repoRef.trim().length > 0 ? value.repoRef.trim() : null;
  const name = value.name && value.name.trim().length > 0 ? value.name.trim() : inferWorkspaceName(cwd, repoUrl);
  return {
    name,
    cwd,
    repoUrl,
    repoRef,
    isPrimary: value.isPrimary ?? false
  };
}

function inferWorkspaceName(cwd: string | null, repoUrl: string | null) {
  if (cwd) {
    const segments = cwd.split("/").filter(Boolean);
    return segments[segments.length - 1] ?? "Workspace";
  }
  if (repoUrl) {
    const parts = repoUrl.replace(/\/+$/, "").split("/");
    return parts[parts.length - 1] || "Workspace";
  }
  return "Workspace";
}

async function enrichProjectDiagnostics(
  companyId: string,
  project: {
    id: string;
    executionWorkspacePolicy?: Record<string, unknown> | null;
    primaryWorkspace?: {
      cwd?: string | null;
      repoUrl?: string | null;
      repoRef?: string | null;
    } | null;
    workspaces?: Array<{
      id: string;
      cwd?: string | null;
      repoUrl?: string | null;
      repoRef?: string | null;
    }>;
  } & Record<string, unknown>
) {
  const policy = project.executionWorkspacePolicy ?? null;
  const credentials = (policy?.credentials ?? {}) as { mode?: string; tokenEnvVar?: string | null };
  const primaryWorkspace = project.primaryWorkspace;
  const effectiveCwd =
    primaryWorkspace?.cwd?.trim() ||
    (primaryWorkspace?.repoUrl ? resolveProjectWorkspacePath(companyId, project.id) : null);
  const hasRepo = Boolean(primaryWorkspace?.repoUrl?.trim());
  const hasLocal = Boolean(primaryWorkspace?.cwd?.trim());
  const gitDirReady = effectiveCwd ? await pathExists(join(effectiveCwd, ".git")) : false;
  const workspaceStatus = hasRepo
    ? hasLocal
      ? "hybrid"
      : "repo_only"
    : hasLocal
      ? "local_only"
      : "unconfigured";
  const cloneState = hasRepo ? (gitDirReady ? "ready" : "missing") : "n/a";
  return {
    ...project,
    gitDiagnostics: {
      workspaceStatus,
      effectiveCwd,
      cloneState,
      authMode: credentials.mode === "env_token" ? "env_token" : "host",
      tokenEnvVar:
        credentials.mode === "env_token" && typeof credentials.tokenEnvVar === "string"
          ? credentials.tokenEnvVar
          : null
    }
  };
}

async function pathExists(path: string) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
