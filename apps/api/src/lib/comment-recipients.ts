export type CommentRecipientType = "agent" | "board" | "member";

export type CommentRecipientInput = {
  recipientType: CommentRecipientType;
  recipientId?: string | null;
};

export type PersistedCommentRecipient = {
  recipientType: CommentRecipientType;
  recipientId: string | null;
  deliveryStatus: "pending" | "dispatched" | "failed" | "skipped";
  dispatchedRunId: string | null;
  dispatchedAt: string | null;
  acknowledgedAt: string | null;
};

export function dedupeCommentRecipients(recipients: CommentRecipientInput[]) {
  const result: Array<{ recipientType: CommentRecipientType; recipientId: string | null }> = [];
  const seen = new Set<string>();
  for (const recipient of recipients) {
    const recipientId = recipient.recipientId?.trim() ? recipient.recipientId.trim() : null;
    if (recipient.recipientType !== "board" && !recipientId) {
      continue;
    }
    const key = `${recipient.recipientType}:${recipientId ?? "__all__"}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push({
      recipientType: recipient.recipientType,
      recipientId
    });
  }
  return result;
}

export function normalizeRecipientsForPersistence(
  recipients: Array<{ recipientType: CommentRecipientType; recipientId: string | null }>
): PersistedCommentRecipient[] {
  return recipients.map((recipient) => ({
    recipientType: recipient.recipientType,
    recipientId: recipient.recipientId ?? null,
    // Non-agent recipients are terminal at creation time; they are not dispatch targets.
    deliveryStatus: recipient.recipientType === "agent" ? "pending" : "skipped",
    dispatchedRunId: null,
    dispatchedAt: null,
    acknowledgedAt: null
  }));
}

export function parseIssueCommentRecipients(raw: string | null): PersistedCommentRecipient[] {
  if (!raw) {
    return [];
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
        const deliveryStatusRaw = String(candidate.deliveryStatus ?? "").trim();
        const deliveryStatus =
          deliveryStatusRaw === "pending" ||
          deliveryStatusRaw === "dispatched" ||
          deliveryStatusRaw === "failed" ||
          deliveryStatusRaw === "skipped"
            ? deliveryStatusRaw
            : "pending";
        const recipientId =
          typeof candidate.recipientId === "string" && candidate.recipientId.trim().length > 0
            ? candidate.recipientId.trim()
            : null;
        return {
          recipientType: recipientTypeRaw as CommentRecipientType,
          recipientId,
          deliveryStatus,
          dispatchedRunId:
            typeof candidate.dispatchedRunId === "string" && candidate.dispatchedRunId.trim().length > 0
              ? candidate.dispatchedRunId.trim()
              : null,
          dispatchedAt:
            typeof candidate.dispatchedAt === "string" && candidate.dispatchedAt.trim().length > 0
              ? candidate.dispatchedAt.trim()
              : null,
          acknowledgedAt:
            typeof candidate.acknowledgedAt === "string" && candidate.acknowledgedAt.trim().length > 0
              ? candidate.acknowledgedAt.trim()
              : null
        } satisfies PersistedCommentRecipient;
      })
      .filter(Boolean) as PersistedCommentRecipient[];
  } catch {
    return [];
  }
}
