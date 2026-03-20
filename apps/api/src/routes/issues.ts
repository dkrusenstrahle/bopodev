import { Router } from "express";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { and, desc, eq, inArray } from "drizzle-orm";
import multer from "multer";
import { z } from "zod";
import { IssueDetailSchema, IssueSchema } from "bopodev-contracts";
import {
  addIssueAttachment,
  addIssueComment,
  agents,
  appendActivity,
  appendAuditEvent,
  createIssue,
  deleteIssueAttachment,
  deleteIssueComment,
  deleteIssue,
  getIssue,
  heartbeatRuns,
  getIssueAttachment,
  issues,
  listIssueAttachments,
  listIssueActivity,
  listIssueComments,
  listIssues,
  projects,
  projectWorkspaces,
  updateIssueComment,
  updateIssue
} from "bopodev-db";
import { nanoid } from "nanoid";
import type { AppContext } from "../context";
import { sendError, sendOk, sendOkValidated } from "../http";
import {
  dedupeCommentRecipients,
  normalizeRecipientsForPersistence,
  type CommentRecipientInput,
  type PersistedCommentRecipient
} from "../lib/comment-recipients";
import { isInsidePath, normalizeCompanyWorkspacePath, resolveProjectWorkspacePath } from "../lib/instance-paths";
import { requireCompanyScope } from "../middleware/company-scope";
import { requirePermission } from "../middleware/request-actor";
import { triggerIssueCommentDispatchWorker } from "../services/comment-recipient-dispatch-service";
import { publishAttentionSnapshot } from "../realtime/attention";

const createIssueSchema = z.object({
  projectId: z.string().min(1),
  parentIssueId: z.string().optional(),
  title: z.string().min(1),
  body: z.string().optional(),
  metadata: z
    .object({
      delegatedHiringIntent: z
        .object({
          intentType: z.literal("agent_hiring_request"),
          requestedRole: z.string().nullable().optional(),
          requestedRoleKey: z.string().nullable().optional(),
          requestedTitle: z.string().nullable().optional(),
          requestedName: z.string().nullable().optional(),
          requestedManagerAgentId: z.string().nullable().optional(),
          requestedProviderType: z.string().nullable().optional(),
          requestedRuntimeModel: z.string().nullable().optional()
        })
        .optional()
    })
    .optional(),
  status: z.enum(["todo", "in_progress", "blocked", "in_review", "done", "canceled"]).default("todo"),
  priority: z.enum(["none", "low", "medium", "high", "urgent"]).default("none"),
  assigneeAgentId: z.string().nullable().optional(),
  labels: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([])
});

const createIssueCommentSchema = z.object({
  body: z.string().min(1),
  recipients: z
    .array(
      z.object({
        recipientType: z.enum(["agent", "board", "member"]),
        recipientId: z.string().nullable().optional()
      })
    )
    .default([]),
  authorType: z.enum(["human", "agent", "system"]).optional(),
  authorId: z.string().optional()
});

const createIssueCommentLegacySchema = z.object({
  issueId: z.string().min(1),
  body: z.string().min(1),
  recipients: z
    .array(
      z.object({
        recipientType: z.enum(["agent", "board", "member"]),
        recipientId: z.string().nullable().optional()
      })
    )
    .default([]),
  authorType: z.enum(["human", "agent", "system"]).optional(),
  authorId: z.string().optional()
});

const updateIssueCommentSchema = z.object({
  body: z.string().min(1)
});

const MAX_ATTACHMENTS_PER_REQUEST = parsePositiveIntEnv("BOPO_ISSUE_ATTACHMENTS_MAX_FILES", 10);
const MAX_ATTACHMENT_SIZE_BYTES = parsePositiveIntEnv("BOPO_ISSUE_ATTACHMENTS_MAX_BYTES", 20 * 1024 * 1024);
const ALLOWED_ATTACHMENT_MIME_TYPES = parseCsvSet(
  process.env.BOPO_ISSUE_ATTACHMENTS_ALLOWED_MIME_TYPES,
  [
    "image/png",
    "image/jpeg",
    "image/webp",
    "image/gif",
    "application/pdf",
    "text/plain",
    "text/markdown",
    "application/json",
    "text/csv",
    "application/zip",
    "application/x-zip-compressed"
  ]
);
const ALLOWED_ATTACHMENT_EXTENSIONS = parseCsvSet(
  process.env.BOPO_ISSUE_ATTACHMENTS_ALLOWED_EXTENSIONS,
  ["png", "jpg", "jpeg", "webp", "gif", "pdf", "txt", "md", "json", "csv", "zip"]
);

type IssueAttachmentResponse = Record<string, unknown> & { id: string; downloadPath: string };
const COMMENT_RUN_ID_HEADER = "x-bopodev-run-id";

function parseStringArray(value: unknown) {
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry));
  }
  if (typeof value !== "string") {
    return [];
  }
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map((entry) => String(entry)) : [];
  } catch {
    return [];
  }
}

function toIssueResponse(issue: Record<string, unknown>) {
  const labels = parseStringArray(issue.labelsJson);
  const tags = parseStringArray(issue.tagsJson);
  const { labelsJson: _labelsJson, tagsJson: _tagsJson, ...rest } = issue;
  return {
    ...rest,
    labels,
    tags
  };
}

const updateIssueSchema = z
  .object({
    projectId: z.string().min(1).optional(),
    title: z.string().min(1).optional(),
    body: z.string().nullable().optional(),
    status: z.enum(["todo", "in_progress", "blocked", "in_review", "done", "canceled"]).optional(),
    priority: z.enum(["none", "low", "medium", "high", "urgent"]).optional(),
    assigneeAgentId: z.string().nullable().optional(),
    labels: z.array(z.string()).optional(),
    tags: z.array(z.string()).optional()
  })
  .refine((payload) => Object.keys(payload).length > 0, "At least one field must be provided.");

export function createIssuesRouter(ctx: AppContext) {
  const router = Router();
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: MAX_ATTACHMENT_SIZE_BYTES,
      files: MAX_ATTACHMENTS_PER_REQUEST
    }
  });
  router.use(requireCompanyScope);

  router.get("/", async (req, res) => {
    const projectId = req.query.projectId?.toString();
    const rows = await listIssues(ctx.db, req.companyId!, projectId);
    return sendOkValidated(
      res,
      IssueSchema.array(),
      rows.map((row) => toIssueResponse(row as unknown as Record<string, unknown>)),
      "issues.list"
    );
  });

  router.get("/:issueId", async (req, res) => {
    const issueId = req.params.issueId;
    const issueRow = await getIssue(ctx.db, req.companyId!, issueId);
    if (!issueRow) {
      return sendError(res, "Issue not found.", 404);
    }
    const base = toIssueResponse(issueRow as unknown as Record<string, unknown>);
    const attachmentRows = await listIssueAttachments(ctx.db, req.companyId!, issueId);
    const attachments = attachmentRows.map((row) =>
      toIssueAttachmentResponse(row as unknown as Record<string, unknown>, issueId)
    );
    return sendOkValidated(res, IssueDetailSchema, { ...base, attachments }, "issues.detail");
  });

  router.post("/", async (req, res) => {
    requirePermission("issues:write")(req, res, () => {});
    if (res.headersSent) {
      return;
    }
    const parsed = createIssueSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(res, parsed.error.message, 422);
    }
    if (parsed.data.assigneeAgentId) {
      const assignmentValidation = await validateIssueAssignmentScope(
        ctx,
        req.companyId!,
        parsed.data.projectId,
        parsed.data.assigneeAgentId
      );
      if (assignmentValidation) {
        return sendError(res, assignmentValidation, 422);
      }
    }
    const issue = await createIssue(ctx.db, {
      companyId: req.companyId!,
      projectId: parsed.data.projectId,
      parentIssueId: parsed.data.parentIssueId,
      title: parsed.data.title,
      body: applyIssueMetadataToBody(parsed.data.body, parsed.data.metadata),
      status: parsed.data.status,
      priority: parsed.data.priority,
      assigneeAgentId: parsed.data.assigneeAgentId,
      labels: parsed.data.labels,
      tags: parsed.data.tags
    });
    await appendActivity(ctx.db, {
      companyId: req.companyId!,
      issueId: issue.id,
      actorType: "human",
      eventType: "issue.created",
      payload: { issue }
    });
    await appendAuditEvent(ctx.db, {
      companyId: req.companyId!,
      actorType: "human",
      eventType: "issue.created",
      entityType: "issue",
      entityId: issue.id,
      payload: issue
    });
    return sendOk(res, toIssueResponse(issue as unknown as Record<string, unknown>));
  });

  router.post("/:issueId/attachments", async (req, res) => {
    requirePermission("issues:write")(req, res, () => {});
    if (res.headersSent) {
      return;
    }

    upload.array("files", MAX_ATTACHMENTS_PER_REQUEST)(req, res, async (uploadError) => {
      if (uploadError) {
        if (uploadError instanceof multer.MulterError) {
          if (uploadError.code === "LIMIT_FILE_SIZE") {
            return sendError(
              res,
              `Attachment exceeds max file size of ${MAX_ATTACHMENT_SIZE_BYTES} bytes.`,
              422
            );
          }
          if (uploadError.code === "LIMIT_FILE_COUNT") {
            return sendError(
              res,
              `Too many files. Max ${MAX_ATTACHMENTS_PER_REQUEST} attachment(s) per request.`,
              422
            );
          }
          return sendError(res, uploadError.message, 422);
        }
        return sendError(res, "Failed to parse multipart attachment payload.", 422);
      }

      try {
        const files = (req.files as Express.Multer.File[] | undefined) ?? [];
        if (files.length === 0) {
          return sendError(res, "At least one attachment file is required.", 422);
        }
        const issueContext = await getIssueContextForAttachment(ctx, req.companyId!, req.params.issueId);
        if (!issueContext) {
          return sendError(res, "Issue not found.", 404);
        }
        const workspacePath = resolveWorkspacePath(issueContext.companyId, issueContext.projectId, issueContext.workspaceCwd);
        const attachmentDir = join(workspacePath, ".bopo", "issues", issueContext.issueId, "attachments");
        await mkdir(attachmentDir, { recursive: true });

        const uploaded: IssueAttachmentResponse[] = [];
        for (const file of files) {
          if (!isAllowedAttachmentFile(file)) {
            return sendError(
              res,
              `Unsupported attachment type for '${file.originalname}'. Allowed extensions: ${Array.from(ALLOWED_ATTACHMENT_EXTENSIONS).join(", ")}`,
              422
            );
          }

          const attachmentId = nanoid(14);
          const safeFileName = sanitizeAttachmentFileName(file.originalname);
          const storedFileName = `${attachmentId}-${safeFileName}`;
          const relativePath = join(".bopo", "issues", issueContext.issueId, "attachments", storedFileName);
          const absolutePath = resolve(workspacePath, relativePath);
          if (!isInsidePath(workspacePath, absolutePath)) {
            return sendError(res, "Invalid attachment destination path.", 422);
          }

          await writeFile(absolutePath, file.buffer);
          try {
            const attachment = await addIssueAttachment(ctx.db, {
              id: attachmentId,
              companyId: req.companyId!,
              issueId: issueContext.issueId,
              projectId: issueContext.projectId,
              fileName: file.originalname,
              mimeType: file.mimetype || null,
              fileSizeBytes: file.size,
              relativePath,
              uploadedByActorType: req.actor?.type === "agent" ? "agent" : "human",
              uploadedByActorId: req.actor?.id
            });
            uploaded.push(toIssueAttachmentResponse(attachment as unknown as Record<string, unknown>, issueContext.issueId));
          } catch (error) {
            await rm(absolutePath, { force: true }).catch(() => undefined);
            throw error;
          }
        }

        await appendActivity(ctx.db, {
          companyId: req.companyId!,
          issueId: issueContext.issueId,
          actorType: req.actor?.type === "agent" ? "agent" : "human",
          actorId: req.actor?.id,
          eventType: "issue.attachments_added",
          payload: { count: uploaded.length, attachmentIds: uploaded.map((entry) => entry.id) }
        });
        await appendAuditEvent(ctx.db, {
          companyId: req.companyId!,
          actorType: req.actor?.type === "agent" ? "agent" : "human",
          actorId: req.actor?.id,
          eventType: "issue.attachments_added",
          entityType: "issue",
          entityId: issueContext.issueId,
          payload: { attachments: uploaded }
        });
        return sendOk(res, uploaded);
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error(error);
        return sendError(res, "Failed to upload attachments.", 500);
      }
    });
  });

  router.get("/:issueId/attachments", async (req, res) => {
    const issueContext = await getIssueContextForAttachment(ctx, req.companyId!, req.params.issueId);
    if (!issueContext) {
      return sendError(res, "Issue not found.", 404);
    }
    const attachments = await listIssueAttachments(ctx.db, req.companyId!, req.params.issueId);
    return sendOk(
      res,
      attachments.map((attachment) =>
        toIssueAttachmentResponse(attachment as unknown as Record<string, unknown>, req.params.issueId)
      )
    );
  });

  router.get("/:issueId/attachments/:attachmentId/download", async (req, res) => {
    const issueContext = await getIssueContextForAttachment(ctx, req.companyId!, req.params.issueId);
    if (!issueContext) {
      return sendError(res, "Issue not found.", 404);
    }
    const attachment = await getIssueAttachment(ctx.db, req.companyId!, req.params.issueId, req.params.attachmentId);
    if (!attachment) {
      return sendError(res, "Attachment not found.", 404);
    }
    const workspacePath = resolveWorkspacePath(issueContext.companyId, issueContext.projectId, issueContext.workspaceCwd);
    const absolutePath = resolve(workspacePath, attachment.relativePath);
    if (!isInsidePath(workspacePath, absolutePath)) {
      return sendError(res, "Invalid attachment path.", 422);
    }
    try {
      await stat(absolutePath);
    } catch {
      return sendError(res, "Attachment file is missing on disk.", 404);
    }
    const fileBuffer = await readFile(absolutePath);
    if (attachment.mimeType) {
      res.setHeader("content-type", attachment.mimeType);
    } else {
      res.setHeader("content-type", "application/octet-stream");
    }
    res.setHeader("content-disposition", `attachment; filename="${encodeURIComponent(attachment.fileName)}"`);
    return res.send(fileBuffer);
  });

  router.delete("/:issueId/attachments/:attachmentId", async (req, res) => {
    requirePermission("issues:write")(req, res, () => {});
    if (res.headersSent) {
      return;
    }
    const issueContext = await getIssueContextForAttachment(ctx, req.companyId!, req.params.issueId);
    if (!issueContext) {
      return sendError(res, "Issue not found.", 404);
    }
    const attachment = await getIssueAttachment(ctx.db, req.companyId!, req.params.issueId, req.params.attachmentId);
    if (!attachment) {
      return sendError(res, "Attachment not found.", 404);
    }
    const workspacePath = resolveWorkspacePath(issueContext.companyId, issueContext.projectId, issueContext.workspaceCwd);
    const absolutePath = resolve(workspacePath, attachment.relativePath);
    if (!isInsidePath(workspacePath, absolutePath)) {
      return sendError(res, "Invalid attachment path.", 422);
    }
    await rm(absolutePath, { force: true }).catch(() => undefined);
    const deleted = await deleteIssueAttachment(ctx.db, req.companyId!, req.params.issueId, req.params.attachmentId);
    if (!deleted) {
      return sendError(res, "Attachment not found.", 404);
    }
    await appendActivity(ctx.db, {
      companyId: req.companyId!,
      issueId: issueContext.issueId,
      actorType: req.actor?.type === "agent" ? "agent" : "human",
      actorId: req.actor?.id,
      eventType: "issue.attachment_deleted",
      payload: { attachmentId: req.params.attachmentId }
    });
    await appendAuditEvent(ctx.db, {
      companyId: req.companyId!,
      actorType: req.actor?.type === "agent" ? "agent" : "human",
      actorId: req.actor?.id,
      eventType: "issue.attachment_deleted",
      entityType: "issue_attachment",
      entityId: req.params.attachmentId,
      payload: deleted as unknown as Record<string, unknown>
    });
    return sendOk(res, { deleted: true });
  });

  router.get("/:issueId/comments", async (req, res) => {
    const comments = await listIssueComments(ctx.db, req.companyId!, req.params.issueId);
    return sendOk(res, comments);
  });

  router.get("/:issueId/activity", async (req, res) => {
    const activity = await listIssueActivity(ctx.db, req.companyId!, req.params.issueId);
    return sendOk(
      res,
      activity.map((row) => ({
        ...row,
        payload: parsePayload(row.payloadJson)
      }))
    );
  });

  router.post("/:issueId/comments", async (req, res) => {
    requirePermission("issues:write")(req, res, () => {});
    if (res.headersSent) {
      return;
    }
    const parsed = createIssueCommentSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(res, parsed.error.message, 422);
    }
    return createIssueCommentWithRecipients(ctx, req, res, {
      issueId: req.params.issueId,
      body: parsed.data.body,
      recipients: parsed.data.recipients,
      authorType: parsed.data.authorType,
      authorId: parsed.data.authorId
    });
  });

  // Backward-compatible endpoint used by older clients.
  router.post("/comment", async (req, res) => {
    requirePermission("issues:write")(req, res, () => {});
    if (res.headersSent) {
      return;
    }
    const parsed = createIssueCommentLegacySchema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(res, parsed.error.message, 422);
    }
    return createIssueCommentWithRecipients(ctx, req, res, {
      issueId: parsed.data.issueId,
      body: parsed.data.body,
      recipients: parsed.data.recipients,
      authorType: parsed.data.authorType,
      authorId: parsed.data.authorId
    });
  });

  router.put("/:issueId/comments/:commentId", async (req, res) => {
    requirePermission("issues:write")(req, res, () => {});
    if (res.headersSent) {
      return;
    }
    const parsed = updateIssueCommentSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(res, parsed.error.message, 422);
    }

    const body =
      req.actor?.type === "agent" ? sanitizeCommentBodyForAuthor(parsed.data.body, "agent") : parsed.data.body;
    if (req.actor?.type === "agent" && !body) {
      return sendError(res, "Agent comments must include non-emoji text.", 422);
    }
    const comment = await updateIssueComment(ctx.db, {
      companyId: req.companyId!,
      issueId: req.params.issueId,
      id: req.params.commentId,
      body
    });
    if (!comment) {
      return sendError(res, "Comment not found.", 404);
    }

    await appendActivity(ctx.db, {
      companyId: req.companyId!,
      issueId: req.params.issueId,
      actorType: req.actor?.type === "agent" ? "agent" : "human",
      actorId: req.actor?.id,
      eventType: "issue.comment_updated",
      payload: { commentId: comment.id }
    });
    await appendAuditEvent(ctx.db, {
      companyId: req.companyId!,
      actorType: req.actor?.type === "agent" ? "agent" : "human",
      actorId: req.actor?.id,
      eventType: "issue.comment_updated",
      entityType: "issue_comment",
      entityId: comment.id,
      payload: comment
    });
    return sendOk(res, comment);
  });

  router.delete("/:issueId/comments/:commentId", async (req, res) => {
    requirePermission("issues:write")(req, res, () => {});
    if (res.headersSent) {
      return;
    }
    const deleted = await deleteIssueComment(ctx.db, req.companyId!, req.params.issueId, req.params.commentId);
    if (!deleted) {
      return sendError(res, "Comment not found.", 404);
    }

    await appendActivity(ctx.db, {
      companyId: req.companyId!,
      issueId: req.params.issueId,
      actorType: req.actor?.type === "agent" ? "agent" : "human",
      actorId: req.actor?.id,
      eventType: "issue.comment_deleted",
      payload: { commentId: req.params.commentId }
    });
    await appendAuditEvent(ctx.db, {
      companyId: req.companyId!,
      actorType: req.actor?.type === "agent" ? "agent" : "human",
      actorId: req.actor?.id,
      eventType: "issue.comment_deleted",
      entityType: "issue_comment",
      entityId: req.params.commentId,
      payload: { id: req.params.commentId, issueId: req.params.issueId }
    });
    return sendOk(res, { deleted: true });
  });

  router.put("/:issueId", async (req, res) => {
    requirePermission("issues:write")(req, res, () => {});
    if (res.headersSent) {
      return;
    }
    const parsed = updateIssueSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(res, parsed.error.message, 422);
    }
    if (parsed.data.assigneeAgentId !== undefined || parsed.data.projectId !== undefined) {
      const [existingIssue] = await ctx.db
        .select({
          id: issues.id,
          projectId: issues.projectId,
          assigneeAgentId: issues.assigneeAgentId
        })
        .from(issues)
        .where(and(eq(issues.companyId, req.companyId!), eq(issues.id, req.params.issueId)))
        .limit(1);
      if (!existingIssue) {
        return sendError(res, "Issue not found.", 404);
      }
      const effectiveProjectId = parsed.data.projectId ?? existingIssue.projectId;
      const effectiveAssigneeAgentId =
        parsed.data.assigneeAgentId === undefined ? existingIssue.assigneeAgentId : parsed.data.assigneeAgentId;
      if (effectiveAssigneeAgentId) {
        const assignmentValidation = await validateIssueAssignmentScope(
          ctx,
          req.companyId!,
          effectiveProjectId,
          effectiveAssigneeAgentId
        );
        if (assignmentValidation) {
          return sendError(res, assignmentValidation, 422);
        }
      }
    }

    const issue = await updateIssue(ctx.db, { companyId: req.companyId!, id: req.params.issueId, ...parsed.data });
    if (!issue) {
      return sendError(res, "Issue not found.", 404);
    }

    await appendActivity(ctx.db, {
      companyId: req.companyId!,
      issueId: issue.id,
      actorType: "human",
      eventType: "issue.updated",
      payload: { issue }
    });
    await appendAuditEvent(ctx.db, {
      companyId: req.companyId!,
      actorType: "human",
      eventType: "issue.updated",
      entityType: "issue",
      entityId: issue.id,
      payload: issue
    });
    return sendOk(res, toIssueResponse(issue as unknown as Record<string, unknown>));
  });

  router.delete("/:issueId", async (req, res) => {
    requirePermission("issues:write")(req, res, () => {});
    if (res.headersSent) {
      return;
    }
    const deleted = await deleteIssue(ctx.db, req.companyId!, req.params.issueId);
    if (!deleted) {
      return sendError(res, "Issue not found.", 404);
    }
    await appendAuditEvent(ctx.db, {
      companyId: req.companyId!,
      actorType: "human",
      eventType: "issue.deleted",
      entityType: "issue",
      entityId: req.params.issueId,
      payload: { id: req.params.issueId }
    });
    return sendOk(res, { deleted: true });
  });

  return router;
}

function applyIssueMetadataToBody(
  body: string | undefined,
  metadata:
    | {
        delegatedHiringIntent?: {
          intentType: "agent_hiring_request";
          requestedRole?: string | null;
          requestedName?: string | null;
          requestedManagerAgentId?: string | null;
          requestedProviderType?: string | null;
          requestedRuntimeModel?: string | null;
        };
      }
    | undefined
) {
  if (!metadata || Object.keys(metadata).length === 0) {
    return body;
  }
  const metadataBlock = [
    "",
    "---",
    "<!-- bopodev:issue-metadata:v1",
    JSON.stringify(metadata),
    "-->"
  ].join("\n");
  return `${body ?? ""}${metadataBlock}`.trim();
}

function parsePayload(payloadJson: string) {
  try {
    const parsed = JSON.parse(payloadJson) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

async function createIssueCommentWithRecipients(
  ctx: AppContext,
  req: {
    companyId?: string;
    actor?: { type?: "board" | "member" | "agent"; id?: string };
    requestId?: string;
    header(name: string): string | undefined;
  },
  res: Parameters<typeof sendOk>[0],
  input: {
    issueId: string;
    body: string;
    recipients: CommentRecipientInput[];
    authorType?: "human" | "agent" | "system";
    authorId?: string;
  }
) {
  const spoofValidationError = validateCommentAuthorInput(req.actor?.type, req.actor?.id, {
    authorType: input.authorType,
    authorId: input.authorId
  });
  if (spoofValidationError) {
    return sendError(res, spoofValidationError, 422);
  }
  const author = resolveIssueCommentAuthor(req.actor?.type, req.actor?.id, {
    authorType: input.authorType,
    authorId: input.authorId
  });
  let normalizedRecipients: PersistedCommentRecipient[];
  try {
    normalizedRecipients = await normalizeCommentRecipients(ctx, req.companyId!, input.recipients);
  } catch (error) {
    return sendError(res, error instanceof Error ? error.message : "Invalid recipients.", 422);
  }
  const runId = await resolveIssueCommentRunId(ctx, {
    companyId: req.companyId!,
    actorType: req.actor?.type,
    actorId: req.actor?.id,
    runIdHeader: req.header(COMMENT_RUN_ID_HEADER)
  });
  const sanitizedBody = sanitizeCommentBodyForAuthor(input.body, author.authorType);
  if (!sanitizedBody) {
    return sendError(res, "Agent/system comments must include non-emoji text.", 422);
  }
  const comment = await addIssueComment(ctx.db, {
    companyId: req.companyId!,
    issueId: input.issueId,
    body: sanitizedBody,
    authorType: author.authorType,
    authorId: author.authorId,
    runId,
    recipients: normalizedRecipients
  });
  await appendActivity(ctx.db, {
    companyId: req.companyId!,
    issueId: comment.issueId,
    actorType: coerceActorType(comment.authorType),
    actorId: comment.authorId,
    eventType: "issue.comment_added",
    payload: {
      commentId: comment.id,
      runId: comment.runId ?? null,
      recipientCount: normalizedRecipients.length
    }
  });
  await appendAuditEvent(ctx.db, {
    companyId: req.companyId!,
    actorType: coerceActorType(comment.authorType),
    actorId: comment.authorId,
    eventType: "issue.comment_added",
    entityType: "issue_comment",
    entityId: comment.id,
    payload: comment
  });
  if (normalizedRecipients.some((recipient) => recipient.recipientType === "board")) {
    await publishAttentionSnapshot(ctx.db, ctx.realtimeHub, req.companyId!);
  }
  triggerIssueCommentDispatchWorker(ctx.db, req.companyId!, {
    requestId: req.requestId,
    realtimeHub: ctx.realtimeHub,
    limit: 10
  });
  return sendOk(res, comment);
}

function resolveIssueCommentAuthor(
  actorType: "board" | "member" | "agent" | undefined,
  actorId: string | undefined,
  input: { authorType?: "human" | "agent" | "system"; authorId?: string }
) {
  if ((actorType === "board" || actorType === undefined) && (input.authorType || input.authorId)) {
    return {
      authorType: input.authorType ?? "human",
      authorId: input.authorId
    };
  }
  if (actorType === "agent") {
    return { authorType: "agent" as const, authorId: actorId };
  }
  return { authorType: "human" as const, authorId: actorId };
}

function validateCommentAuthorInput(
  actorType: "board" | "member" | "agent" | undefined,
  actorId: string | undefined,
  input: { authorType?: "human" | "agent" | "system"; authorId?: string }
) {
  if (!input.authorType && !input.authorId) {
    return null;
  }
  if (actorType !== "member" && actorType !== "agent") {
    // Board/default channels are trusted for migration/backfill and may set explicit authorship.
    return null;
  }
  const expectedAuthorType = actorType === "agent" ? "agent" : "human";
  if (input.authorType && input.authorType !== expectedAuthorType) {
    return "Comment author fields are derived from actor identity and cannot be overridden.";
  }
  if (input.authorId && actorId && input.authorId !== actorId) {
    return "Comment author fields are derived from actor identity and cannot be overridden.";
  }
  if (input.authorId && !actorId) {
    return "Comment author fields are derived from actor identity and cannot be overridden.";
  }
  return null;
}

function coerceActorType(value: string | null | undefined): "human" | "agent" | "system" {
  if (value === "agent" || value === "system") {
    return value;
  }
  return "human";
}

function sanitizeCommentBodyForAuthor(body: string, authorType: "human" | "agent" | "system") {
  if (authorType === "human") {
    return body;
  }
  const withoutEmoji = body.replace(/[\p{Extended_Pictographic}\uFE0F\u200D]/gu, "");
  const trimmed = withoutEmoji.trim();
  const extractedSummary = extractSummaryFromJsonLikeText(trimmed);
  const isPureJsonLike =
    /^\s*\{[\s\S]*\}\s*$/m.test(trimmed) || /^\s*```(?:json)?[\s\S]*```\s*$/im.test(trimmed);
  if (isPureJsonLike && extractedSummary) {
    return extractedSummary;
  }
  const trailingJsonSummary = trimmed.match(/^(?<main>[\s\S]*?)\n+\{[\s\S]*"summary"\s*:\s*"[\s\S]*?"[\s\S]*\}\s*$/);
  if (trailingJsonSummary?.groups?.main) {
    return trailingJsonSummary.groups.main.trim();
  }
  return trimmed;
}

function extractSummaryFromJsonLikeText(input: string) {
  const fencedMatch = input.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fencedMatch?.[1]?.trim() ?? input.match(/\{[\s\S]*\}\s*$/)?.[0]?.trim();
  if (!candidate) {
    return null;
  }
  try {
    const parsed = JSON.parse(candidate) as Record<string, unknown>;
    const summary = parsed.summary;
    if (typeof summary === "string" && summary.trim().length > 0) {
      return summary.trim();
    }
  } catch {
    // Fall through to regex extraction for loosely-formatted JSON.
  }
  const summaryMatch = candidate.match(/"summary"\s*:\s*"([\s\S]*?)"/);
  const summary = summaryMatch?.[1]
    ?.replace(/\\"/g, "\"")
    .replace(/\\n/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return summary && summary.length > 0 ? summary : null;
}

async function resolveIssueCommentRunId(
  ctx: AppContext,
  input: {
    companyId: string;
    actorType: "board" | "member" | "agent" | undefined;
    actorId: string | undefined;
    runIdHeader: string | undefined;
  }
) {
  const runId = input.runIdHeader?.trim();
  if (runId) {
    const [run] = await ctx.db
      .select({ id: heartbeatRuns.id, agentId: heartbeatRuns.agentId })
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.id, runId)))
      .limit(1);
    if (!run) {
      return null;
    }
    if (input.actorType === "agent" && input.actorId && run.agentId !== input.actorId) {
      return null;
    }
    return run.id;
  }
  if (input.actorType !== "agent" || !input.actorId) {
    return null;
  }
  const [latestRun] = await ctx.db
    .select({ id: heartbeatRuns.id })
    .from(heartbeatRuns)
    .where(
      and(
        eq(heartbeatRuns.companyId, input.companyId),
        eq(heartbeatRuns.agentId, input.actorId),
        eq(heartbeatRuns.status, "started")
      )
    )
    .orderBy(desc(heartbeatRuns.startedAt))
    .limit(1);
  return latestRun?.id ?? null;
}

async function normalizeCommentRecipients(
  ctx: AppContext,
  companyId: string,
  recipients: CommentRecipientInput[]
): Promise<PersistedCommentRecipient[]> {
  if (recipients.length === 0) {
    return [] as PersistedCommentRecipient[];
  }
  const deduped = dedupeCommentRecipients(recipients);
  const agentIds = deduped
    .filter((recipient) => recipient.recipientType === "agent" && recipient.recipientId)
    .map((recipient) => recipient.recipientId as string);
  if (agentIds.length > 0) {
    const existingAgents = await ctx.db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.companyId, companyId), inArray(agents.id, agentIds)));
    const existingAgentIds = new Set(existingAgents.map((agent) => agent.id));
    const missing = agentIds.find((id) => !existingAgentIds.has(id));
    if (missing) {
      throw new Error(`Recipient agent not found: ${missing}`);
    }
  }
  return normalizeRecipientsForPersistence(deduped);
}

async function validateIssueAssignmentScope(
  ctx: AppContext,
  companyId: string,
  projectId: string,
  assigneeAgentId: string
) {
  const [project] = await ctx.db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.companyId, companyId), eq(projects.id, projectId)))
    .limit(1);
  if (!project) {
    return "Project not found.";
  }

  const [agent] = await ctx.db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.companyId, companyId), eq(agents.id, assigneeAgentId)))
    .limit(1);
  if (!agent) {
    return "Assigned agent not found.";
  }

  return null;
}

function parsePositiveIntEnv(name: string, fallback: number) {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function parseCsvSet(raw: string | undefined, fallback: string[]) {
  if (!raw || raw.trim().length === 0) {
    return new Set(fallback);
  }
  return new Set(
    raw
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean)
  );
}

function sanitizeAttachmentFileName(input: string) {
  const original = basename(input || "attachment");
  const sanitized = original.replace(/[^a-zA-Z0-9._-]/g, "_");
  return sanitized.length > 0 ? sanitized : "attachment";
}

function isAllowedAttachmentFile(file: Express.Multer.File) {
  const extension = extname(file.originalname).slice(1).toLowerCase();
  const mime = (file.mimetype ?? "").toLowerCase();
  if (extension && ALLOWED_ATTACHMENT_EXTENSIONS.has(extension)) {
    return true;
  }
  return mime.length > 0 && ALLOWED_ATTACHMENT_MIME_TYPES.has(mime);
}

function toIssueAttachmentResponse(attachment: Record<string, unknown>, issueId: string) {
  const id = String(attachment.id ?? "");
  return {
    ...attachment,
    id,
    downloadPath: `/issues/${issueId}/attachments/${id}/download`
  };
}

function resolveWorkspacePath(companyId: string, projectId: string, workspaceCwd: string | null) {
  if (workspaceCwd && workspaceCwd.trim().length > 0) {
    return normalizeCompanyWorkspacePath(companyId, workspaceCwd);
  }
  return resolveProjectWorkspacePath(companyId, projectId);
}

async function getIssueContextForAttachment(ctx: AppContext, companyId: string, issueId: string) {
  const [issue] = await ctx.db
    .select({
      issueId: issues.id,
      companyId: issues.companyId,
      projectId: issues.projectId
    })
    .from(issues)
    .where(and(eq(issues.companyId, companyId), eq(issues.id, issueId)))
    .limit(1);
  if (!issue) {
    return null;
  }
  const [project] = await ctx.db
    .select({
      id: projects.id
    })
    .from(projects)
    .where(and(eq(projects.companyId, companyId), eq(projects.id, issue.projectId)))
    .limit(1);
  if (!project) {
    return null;
  }
  const [workspace] = await ctx.db
    .select({
      cwd: projectWorkspaces.cwd
    })
    .from(projectWorkspaces)
    .where(
      and(
        eq(projectWorkspaces.companyId, companyId),
        eq(projectWorkspaces.projectId, issue.projectId),
        eq(projectWorkspaces.isPrimary, true)
      )
    )
    .limit(1);
  return {
    issueId: issue.issueId,
    companyId: issue.companyId,
    projectId: issue.projectId,
    workspaceCwd: workspace?.cwd ?? null
  };
}

