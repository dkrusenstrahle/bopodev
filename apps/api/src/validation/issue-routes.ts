import { z } from "zod";

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
    labels: z.array(z.string()).optional(),
    tags: z.array(z.string()).optional()
  })
  .refine((payload) => Object.keys(payload).length > 0, "At least one field must be provided.");
