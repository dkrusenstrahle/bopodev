import { notFound } from "next/navigation";
import { RunDetailPageClient } from "@/components/run-detail-page-client";
import {
  loadHeartbeatRunDetail,
  loadHeartbeatRunMessages,
  loadWorkspaceData
} from "@/lib/workspace-data";
import { isNoAssignedWorkRun } from "@/lib/workspace-logic";
import { ApiError } from "@/lib/api";
import type { HeartbeatRunMessageRow } from "@/lib/workspace-data";

export default async function RunDetailPage({
  params,
  searchParams
}: {
  params: Promise<{ runId: string }>;
  searchParams: Promise<{ companyId?: string; agentId?: string }>;
}) {
  const { runId } = await params;
  const { companyId, agentId } = await searchParams;
  const workspaceData = await loadWorkspaceData(companyId, {
    include: {
      issues: false,
      goals: false,
      approvals: false,
      governanceInbox: false,
      auditEvents: false,
      costEntries: false,
      projects: false,
      heartbeatRuns: true,
      agents: true
    }
  });
  if (!workspaceData.companyId) {
    notFound();
  }
  try {
    const [runDetail, transcript] = await Promise.all([
      loadHeartbeatRunDetail(workspaceData.companyId, runId),
      loadHeartbeatRunMessages(workspaceData.companyId, runId, undefined, 200, { signalOnly: true })
    ]);
    const fallbackMessages =
      transcript.items.length === 0 ? extractFallbackMessagesFromTrace(runDetail, workspaceData.companyId) : [];
    const initialMessages = transcript.items.length > 0 ? transcript.items : fallbackMessages;
    const recentRuns = workspaceData.heartbeatRuns
      .filter((entry) => !isNoAssignedWorkRun(entry))
      .filter((entry) => (agentId ? entry.agentId === agentId : true))
      .slice(0, 25);
    return (
      <RunDetailPageClient
        companyId={workspaceData.companyId}
        companies={workspaceData.companies}
        runDetail={runDetail}
        initialMessages={initialMessages}
        scopedAgentId={agentId ?? null}
        recentRuns={recentRuns}
      />
    );
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      notFound();
    }
    throw error;
  }
}

function extractFallbackMessagesFromTrace(
  runDetail: Awaited<ReturnType<typeof loadHeartbeatRunDetail>>,
  companyId: string
): HeartbeatRunMessageRow[] {
  const details = runDetail.details;
  const messages: HeartbeatRunMessageRow[] = [];
  if (details && typeof details === "object") {
    const detailsRecord = details as Record<string, unknown>;
    const trace = detailsRecord.trace;
    if (trace && typeof trace === "object") {
      const transcript = (trace as Record<string, unknown>).transcript;
      if (Array.isArray(transcript)) {
        transcript.forEach((entry, index) => {
          if (!entry || typeof entry !== "object") {
            return;
          }
          const record = entry as Record<string, unknown>;
          const kind = typeof record.kind === "string" ? record.kind : "system";
          messages.push({
            id: `legacy-${runDetail.run.id}-${index}`,
            companyId,
            runId: runDetail.run.id,
            sequence: index,
            kind: normalizeKind(kind),
            label: typeof record.label === "string" ? record.label : null,
            text: typeof record.text === "string" ? record.text : null,
            payload: typeof record.payload === "string" ? record.payload : null,
            signalLevel: normalizeSignalLevel(record.signalLevel, kind),
            groupKey: typeof record.groupKey === "string" ? record.groupKey : null,
            source: "trace_fallback",
            createdAt: runDetail.run.startedAt
          });
        });
      }
    }
    if (messages.length === 0) {
      const fallbackText =
        (typeof detailsRecord.result === "string" && detailsRecord.result.trim()) ||
        (typeof detailsRecord.message === "string" && detailsRecord.message.trim()) ||
        (typeof detailsRecord.errorMessage === "string" && detailsRecord.errorMessage.trim()) ||
        runDetail.run.message ||
        "";
      if (fallbackText) {
        messages.push({
          id: `legacy-${runDetail.run.id}-summary`,
          companyId,
          runId: runDetail.run.id,
          sequence: 0,
          kind: "result",
          label: runDetail.run.status,
          text: fallbackText,
          payload: null,
          signalLevel: "high",
          groupKey: "result",
          source: "trace_fallback",
          createdAt: runDetail.run.finishedAt ?? runDetail.run.startedAt
        });
      }
    }
  }
  return messages;
}

function normalizeSignalLevel(value: unknown, kind: string): "high" | "medium" | "low" | "noise" {
  if (value === "high" || value === "medium" || value === "low" || value === "noise") {
    return value;
  }
  if (kind === "tool_call" || kind === "tool_result" || kind === "result") {
    return "high";
  }
  if (kind === "assistant") {
    return "medium";
  }
  if (kind === "stderr") {
    return "low";
  }
  return "noise";
}

function normalizeKind(
  kind: string
): "system" | "assistant" | "thinking" | "tool_call" | "tool_result" | "result" | "stderr" {
  if (
    kind === "system" ||
    kind === "assistant" ||
    kind === "thinking" ||
    kind === "tool_call" ||
    kind === "tool_result" ||
    kind === "result" ||
    kind === "stderr"
  ) {
    return kind;
  }
  return "system";
}
