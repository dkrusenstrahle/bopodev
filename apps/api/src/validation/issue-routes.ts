import { z } from "zod";
import { assertKnowledgeRelativePath } from "../services/company-knowledge-file-service";

const KnowledgePathSchema = z.string().min(1).max(1024).superRefine((val, ctx) => {
  try {
    assertKnowledgeRelativePath(val);
  } catch (err) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: err instanceof Error ? err.message : "Invalid knowledge path"
    });
  }
});

const knowledgePathsCreate = z.array(KnowledgePathSchema).max(20).default([]);
const knowledgePathsUpdate = z.array(KnowledgePathSchema).max(20);

export const createIssueSchema = z.object({
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
          requestedRuntimeModel: z.string().nullable().optional(),
          requestedCapabilities: z.string().max(4000).nullable().optional()
        })
        .optional()
    })
    .optional(),
  status: z.enum(["todo", "in_progress", "blocked", "in_review", "done", "canceled"]).default("todo"),
  priority: z.enum(["none", "low", "medium", "high", "urgent"]).default("none"),
  assigneeAgentId: z.string().nullable().optional(),
  goalIds: z.array(z.string().min(1)).default([]),
  externalLink: z.string().max(2048).nullable().optional(),
  labels: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([]),
  knowledgePaths: knowledgePathsCreate
});

export const createIssueCommentSchema = z.object({
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

export const createIssueCommentLegacySchema = z.object({
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

export const updateIssueCommentSchema = z.object({
  body: z.string().min(1)
});

export const updateIssueSchema = z
  .object({
    projectId: z.string().min(1).optional(),
    title: z.string().min(1).optional(),
    body: z.string().nullable().optional(),
    status: z.enum(["todo", "in_progress", "blocked", "in_review", "done", "canceled"]).optional(),
    priority: z.enum(["none", "low", "medium", "high", "urgent"]).optional(),
    assigneeAgentId: z.string().nullable().optional(),
    goalIds: z.array(z.string().min(1)).optional(),
    externalLink: z.string().max(2048).nullable().optional(),
    labels: z.array(z.string()).optional(),
    tags: z.array(z.string()).optional(),
    knowledgePaths: knowledgePathsUpdate.optional()
  })
  .refine((payload) => Object.keys(payload).length > 0, "At least one field must be provided.");
