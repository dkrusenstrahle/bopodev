"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger
} from "@/components/ui/drawer";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SlidersHorizontal } from "lucide-react";
import { subscribeToRealtime } from "@/lib/realtime";
import { isSkippedRun } from "@/lib/workspace-logic";
import type { HeartbeatRunDetailData, HeartbeatRunMessageRow } from "@/lib/workspace-data";
import { SectionHeading } from "./workspace/shared";

type TranscriptSignalLevel = NonNullable<HeartbeatRunMessageRow["signalLevel"]>;
type TranscriptSource = NonNullable<HeartbeatRunMessageRow["source"]>;

export function RunDetailPageClient({
  companyId,
  companies,
  runDetail,
  initialMessages,
  scopedAgentId,
  recentRuns
}: {
  companyId: string;
  companies: Array<{ id: string; name: string }>;
  runDetail: HeartbeatRunDetailData;
  initialMessages: HeartbeatRunMessageRow[];
  scopedAgentId: string | null;
  recentRuns: Array<{
    id: string;
    agentId: string;
    status: string;
    publicStatus?: "started" | "completed" | "failed";
    runType: "work" | "no_assigned_work" | "budget_skip" | "overlap_skip" | "other_skip" | "failed" | "running";
    message: string | null;
    startedAt: string;
    finishedAt?: string | null;
  }>;
}) {
  const [run, setRun] = useState(runDetail.run);
  const [messages, setMessages] = useState(initialMessages);
  const [searchQuery, setSearchQuery] = useState("");
  const [kindFilter, setKindFilter] = useState<"all" | HeartbeatRunMessageRow["kind"]>("all");
  const [signalFilter, setSignalFilter] = useState<"all" | HeartbeatRunMessageRow["signalLevel"]>("all");
  const [sourceFilter, setSourceFilter] = useState<"all" | HeartbeatRunMessageRow["source"]>("all");
  const [mobileFilterOpen, setMobileFilterOpen] = useState(false);
  const [showRawDebug, setShowRawDebug] = useState(false);

  useEffect(() => {
    const unsubscribe = subscribeToRealtime({
      companyId,
      channels: ["heartbeat-runs"],
      onMessage: (message) => {
        if (message.kind !== "event" || message.channel !== "heartbeat-runs") {
          return;
        }
        const event = message.event;
        if (event.type === "runs.snapshot") {
          const runSnapshot = event.runs.find((entry) => entry.runId === runDetail.run.id);
          if (runSnapshot) {
            setRun((prev) => ({
              ...prev,
              status: runSnapshot.status,
              publicStatus:
                runSnapshot.status === "completed" || runSnapshot.status === "failed"
                  ? runSnapshot.status
                  : prev.publicStatus ?? "failed",
              message: runSnapshot.message ?? prev.message,
              startedAt: runSnapshot.startedAt ?? prev.startedAt,
              finishedAt: runSnapshot.finishedAt ?? prev.finishedAt
            }));
          }
          const transcriptSnapshot = event.transcripts.find((entry) => entry.runId === runDetail.run.id);
          if (transcriptSnapshot) {
            setMessages((prev) => {
              const known = new Set(prev.map((entry) => entry.id));
              const appended = transcriptSnapshot.messages
                .filter((entry) => !known.has(entry.id))
                .map((entry) => ({ ...entry, companyId }));
              return [...prev, ...appended];
            });
          }
          return;
        }
        if (event.type === "run.status.updated") {
          if (event.runId !== runDetail.run.id) {
            return;
          }
          setRun((prev) => ({
            ...prev,
            status: event.status,
            publicStatus:
              event.status === "completed" || event.status === "failed"
                ? event.status
                : prev.publicStatus ?? "failed",
            message: event.message ?? prev.message,
            startedAt: event.startedAt ?? prev.startedAt,
            finishedAt: event.finishedAt ?? prev.finishedAt
          }));
          return;
        }
        if (event.type === "run.transcript.snapshot") {
          if (event.runId !== runDetail.run.id) {
            return;
          }
          setMessages((prev) => {
            const known = new Set(prev.map((entry) => entry.id));
            const appended = event.messages
              .filter((entry) => !known.has(entry.id))
              .map((entry) => ({ ...entry, companyId }));
            return [...prev, ...appended];
          });
          return;
        }
        if (event.type === "run.transcript.append") {
          if (event.runId !== runDetail.run.id) {
            return;
          }
          setMessages((prev) => {
            const known = new Set(prev.map((entry) => entry.id));
            const appended = event.messages
              .filter((entry) => !known.has(entry.id))
              .map((entry) => ({ ...entry, companyId }));
            return [...prev, ...appended];
          });
        }
      }
    });
    return unsubscribe;
  }, [companyId, runDetail.run.id]);

  const sortedMessages = useMemo(() => [...messages].sort((a, b) => a.sequence - b.sequence), [messages]);
  const transcriptRows = useMemo(() => toTranscriptRows(sortedMessages, showRawDebug), [sortedMessages, showRawDebug]);
  const availableSources = useMemo(
    () => Array.from(new Set(transcriptRows.map((row) => row.source))).sort((a, b) => a.localeCompare(b)),
    [transcriptRows]
  );
  const filteredTranscriptRows = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    return transcriptRows.filter((row) => {
      if (!showRawDebug && (row.signalLevel === "low" || row.signalLevel === "noise")) {
        return false;
      }
      if (kindFilter !== "all" && row.kind !== kindFilter) {
        return false;
      }
      if (signalFilter !== "all" && row.signalLevel !== signalFilter) {
        return false;
      }
      if (sourceFilter !== "all" && row.source !== sourceFilter) {
        return false;
      }
      if (query.length > 0 && !row.searchText.includes(query)) {
        return false;
      }
      return true;
    });
  }, [transcriptRows, searchQuery, kindFilter, signalFilter, sourceFilter, showRawDebug]);
  const backHref = scopedAgentId
    ? { pathname: `/agents/${scopedAgentId}`, query: { companyId } }
    : { pathname: "/runs", query: { companyId } };
  const backLabel = scopedAgentId ? "Back to agent" : "Back to runs";
  const visibleRecentRuns = useMemo(
    () => recentRuns.filter((entry) => entry.id === run.id || !isSkippedRun(entry)),
    [recentRuns, run.id]
  );
  const sidebarRecentRuns = useMemo(() => visibleRecentRuns.slice(0, 20), [visibleRecentRuns]);

  const transcriptScrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const container = transcriptScrollRef.current;
    if (!container) {
      return;
    }
    container.scrollTop = container.scrollHeight;
  }, [filteredTranscriptRows.length]);

  return (
    <AppShell
      activeNav="Runs"
      companies={companies}
      activeCompanyId={companyId}
      leftPaneScrollable={false}
      secondaryPane={
        <div className="run-sidebar-pane">
          <div className="run-sidebar-title">Recent runs</div>
          <div className="run-sidebar-list">
            {sidebarRecentRuns.map((entry) => {
              const isActive = entry.id === run.id;
              const messagePreview = formatRunMessagePreview(entry.message);
              return (
                <Link
                  key={entry.id}
                  href={{
                    pathname: `/runs/${entry.id}`,
                    query: { companyId, agentId: scopedAgentId ?? undefined }
                  }}
                  className={`run-sidebar-item${isActive ? " run-sidebar-item--active" : ""}`}
                >
                  <div className="run-sidebar-item-header">
                    <span className="run-sidebar-item-id" title={entry.id}>
                      {entry.id}
                    </span>
                    <Badge variant="outline" className="run-sidebar-item-badge">
                      {formatRunStatusLabel(entry.publicStatus ?? entry.status)}
                    </Badge>
                  </div>
                  <p className="run-sidebar-item-message">{messagePreview}</p>
                  <p className="run-sidebar-item-time">
                    {formatRelativeTime(entry.startedAt)} ·{" "}
                    {new Date(entry.startedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                  </p>
                </Link>
              );
            })}
          </div>
        </div>
      }
      leftPane={
        <div className="run-detail-pane">
          <div className="lg:hidden rounded-lg border bg-card p-3">
            <div className="text-xs uppercase tracking-wide text-muted-foreground">Recent runs</div>
            <div className="mt-2 space-y-2">
              {sidebarRecentRuns.slice(0, 6).map((entry) => (
                <Link
                  key={`mobile-${entry.id}`}
                  href={{
                    pathname: `/runs/${entry.id}`,
                    query: { companyId, agentId: scopedAgentId ?? undefined }
                  }}
                  className={`run-sidebar-item${entry.id === run.id ? " run-sidebar-item--active" : ""}`}
                >
                  <div className="run-sidebar-item-header">
                    <span className="run-sidebar-item-id" title={entry.id}>
                      {entry.id}
                    </span>
                    <Badge variant="outline" className="run-sidebar-item-badge">
                      {formatRunStatusLabel(entry.publicStatus ?? entry.status)}
                    </Badge>
                  </div>
                </Link>
              ))}
            </div>
          </div>
          <SectionHeading
              title={`Run ${run.id}`}
              description="Realtime status and summary for this run."
              actions={
                <Button asChild variant="default" size="sm">
                  <Link href={backHref}>{backLabel}</Link>
                </Button>
              }
            />
          {runDetail.transcript.fallbackFromTrace ? (
            <Alert>
              <AlertTitle>Legacy transcript fallback</AlertTitle>
              <AlertDescription>
                This run does not yet have persisted transcript messages. Data may be partial from trace preview.
              </AlertDescription>
            </Alert>
          ) : null}
          <div className="run-transcript-filters">
            <div className="hidden md:flex run-transcript-filters-main">
              <Input
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder={showRawDebug ? "Search text, payload, action, or label..." : "Search the human-readable paper trail..."}
                className="run-transcript-filters-search"
              />
              <Select value={kindFilter} onValueChange={(value) => setKindFilter(value as typeof kindFilter)}>
                <SelectTrigger className="run-transcript-filters-select">
                  <SelectValue placeholder="Kind" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All kinds</SelectItem>
                  <SelectItem value="assistant">assistant</SelectItem>
                  <SelectItem value="tool_call">tool_call</SelectItem>
                  <SelectItem value="tool_result">tool_result</SelectItem>
                  <SelectItem value="result">result</SelectItem>
                  <SelectItem value="thinking">thinking</SelectItem>
                  <SelectItem value="system">system</SelectItem>
                  <SelectItem value="stderr">stderr</SelectItem>
                </SelectContent>
              </Select>
              <Select value={signalFilter} onValueChange={(value) => setSignalFilter(value as typeof signalFilter)}>
                <SelectTrigger className="run-transcript-filters-select">
                  <SelectValue placeholder="Signal" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All signal levels</SelectItem>
                  <SelectItem value="high">high</SelectItem>
                  <SelectItem value="medium">medium</SelectItem>
                  <SelectItem value="low">low</SelectItem>
                  <SelectItem value="noise">noise</SelectItem>
                </SelectContent>
              </Select>
              <Select value={sourceFilter} onValueChange={(value) => setSourceFilter(value as typeof sourceFilter)}>
                <SelectTrigger className="run-transcript-filters-select">
                  <SelectValue placeholder="Source" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All sources</SelectItem>
                  {availableSources.map((source) => (
                    <SelectItem key={source} value={source}>
                      {source}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            <div className="hidden md:flex run-transcript-filters-action">
              <Button variant="outline" onClick={() => setShowRawDebug((value) => !value)}>
                {showRawDebug ? "Hide debug" : "Show debug"}
              </Button>
            </div>
            </div>
            <div className="md:hidden">
              <Input
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder={showRawDebug ? "Search text, payload, action, or label..." : "Search the human-readable paper trail..."}
                className="run-transcript-filters-search mb-2"
              />
              <Drawer open={mobileFilterOpen} onOpenChange={setMobileFilterOpen}>
                <DrawerTrigger asChild>
                  <div className="flex w-full gap-2">
                    <Button variant="outline" size="sm" className="flex-1">
                      <SlidersHorizontal />
                      Filters
                    </Button>
                    <Button variant="outline" size="sm" className="flex-1" onClick={() => setShowRawDebug((value) => !value)}>
                      {showRawDebug ? "Hide debug" : "Show debug"}
                    </Button>
                  </div>
                </DrawerTrigger>
                <DrawerContent className="ui-mobile-safe-bottom">
                  <DrawerHeader>
                    <DrawerTitle>Transcript filters</DrawerTitle>
                  <DrawerDescription>{showRawDebug ? "Narrow the raw transcript stream." : "Narrow the human-readable paper trail."}</DrawerDescription>
                  </DrawerHeader>
                  <div className="space-y-3 pb-2">
                    <Select value={kindFilter} onValueChange={(value) => setKindFilter(value as typeof kindFilter)}>
                      <SelectTrigger className="run-transcript-filters-select">
                        <SelectValue placeholder="Kind" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">All kinds</SelectItem>
                        <SelectItem value="assistant">assistant</SelectItem>
                        <SelectItem value="tool_call">tool_call</SelectItem>
                        <SelectItem value="tool_result">tool_result</SelectItem>
                        <SelectItem value="result">result</SelectItem>
                        <SelectItem value="thinking">thinking</SelectItem>
                        <SelectItem value="system">system</SelectItem>
                        <SelectItem value="stderr">stderr</SelectItem>
                      </SelectContent>
                    </Select>
                    <Select value={signalFilter} onValueChange={(value) => setSignalFilter(value as typeof signalFilter)}>
                      <SelectTrigger className="run-transcript-filters-select">
                        <SelectValue placeholder="Signal" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">All signal levels</SelectItem>
                        <SelectItem value="high">high</SelectItem>
                        <SelectItem value="medium">medium</SelectItem>
                        <SelectItem value="low">low</SelectItem>
                        <SelectItem value="noise">noise</SelectItem>
                      </SelectContent>
                    </Select>
                    <Select value={sourceFilter} onValueChange={(value) => setSourceFilter(value as typeof sourceFilter)}>
                      <SelectTrigger className="run-transcript-filters-select">
                        <SelectValue placeholder="Source" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">All sources</SelectItem>
                        {availableSources.map((source) => (
                          <SelectItem key={source} value={source}>
                            {source}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </DrawerContent>
              </Drawer>
            </div>
          </div>
          {transcriptRows.length === 0 ? (
            <p className="run-transcript-empty">Waiting for transcript messages...</p>
          ) : filteredTranscriptRows.length === 0 ? (
            <p className="run-transcript-empty">No transcript messages match the current filters.</p>
          ) : (
            <div className="run-transcript-outer">
              <div className="run-transcript-col-header">
                <span>Timestamp</span>
                <span>{showRawDebug ? "Action" : "Paper trail"}</span>
                <span>{showRawDebug ? "Result" : "Manager-readable detail"}</span>
              </div>
              <div className="run-transcript-scroll" ref={transcriptScrollRef}>
                {filteredTranscriptRows.map((row) => (
                  <div key={row.id} className="run-transcript-row">
                    <span className="run-transcript-time">{row.time}</span>
                    <span className={row.kindClass}>{row.kindLabel}</span>
                    <div className={row.isToolBlock ? "run-transcript-body-tool" : "run-transcript-body"}>
                      {row.body}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      }
    />
  );
}

function toTranscriptRows(messages: HeartbeatRunMessageRow[], showRawDebug: boolean) {
  const normalized = messages
    .map((entry) => ({
      id: entry.id,
      createdAt: entry.createdAt,
      kind: entry.kind,
      kindLabel: toKindLabel(entry.kind),
      kindClass: toKindClass(entry.kind),
      body: formatEventBody(entry, showRawDebug),
      isToolBlock: entry.kind === "tool_call" || entry.kind === "tool_result",
      signalLevel: entry.signalLevel ?? "noise",
      source: entry.source ?? "trace_fallback"
    }));

  const rows: Array<{
    id: string;
    startedAt: string;
    endedAt: string;
    kind: HeartbeatRunMessageRow["kind"];
    kindLabel: string;
    kindClass: string;
    body: string;
    isToolBlock: boolean;
    signalLevel: TranscriptSignalLevel;
    source: TranscriptSource;
  }> = [];

  for (const item of normalized) {
    rows.push({
      id: item.id,
      startedAt: item.createdAt,
      endedAt: item.createdAt,
      kind: item.kind,
      kindLabel: item.kindLabel,
      kindClass: item.kindClass,
      body: item.body,
      isToolBlock: item.isToolBlock,
      signalLevel: item.signalLevel,
      source: item.source
    });
  }

  return rows.map((row) => ({
    id: row.id,
    time: formatClock(row.startedAt),
    kindLabel: row.kindLabel,
    kindClass: row.kindClass,
    body: row.body,
    isToolBlock: row.isToolBlock,
    kind: row.kind,
    signalLevel: row.signalLevel,
    source: row.source,
    searchText: `${row.kindLabel}\n${row.body}`.toLowerCase()
  }));
}


function formatEventBody(entry: HeartbeatRunMessageRow, showRawDebug: boolean) {
  const text = (entry.text ?? "").trim();
  const payload = (entry.payload ?? "").trim();
  if (!showRawDebug) {
    const concise = formatHumanReadableEventBody(entry, text, payload);
    if (concise) {
      return concise;
    }
  }
  if (entry.kind === "tool_call" || entry.kind === "tool_result") {
    const lines = [entry.label?.trim(), text, payload].filter((part): part is string => Boolean(part && part.length > 0));
    if (lines.length === 0) {
      return "";
    }
    return lines.join("\n");
  }
  const source = text.length > 0 ? text : payload;
  if (!source) {
    return "";
  }
  const normalized = source.trim();
  return normalized.length > 2000 ? `${normalized.slice(0, 2000)}…` : normalized;
}

function formatHumanReadableEventBody(entry: HeartbeatRunMessageRow, text: string, payload: string) {
  const parsedPayload = tryParsePayload(payload);
  if (entry.kind === "tool_call") {
    const command =
      getString(parsedPayload?.command) ??
      getString(parsedPayload?.path) ??
      getString(parsedPayload?.description) ??
      firstLine(text) ??
      entry.label?.trim() ??
      "Tool invoked";
    return truncateBody(command, 320);
  }
  if (entry.kind === "tool_result") {
    const commandResult = summarizeCommandExecution(text);
    if (commandResult) {
      return commandResult;
    }
    const primary =
      firstLine(text) ??
      getString(parsedPayload?.summary) ??
      getString(parsedPayload?.message) ??
      firstLine(payload);
    return truncateBody(primary ?? "Tool finished without a structured result.", 360);
  }
  if (entry.kind === "result") {
    const commandResult = summarizeCommandExecution(text);
    if (commandResult) {
      return commandResult;
    }
    const primary =
      getString(parsedPayload?.summary) ??
      getString(parsedPayload?.resultSummary) ??
      firstLine(text) ??
      firstLine(payload);
    return truncateBody(primary ?? "Run produced a final result.", 360);
  }
  if (entry.kind === "assistant") {
    return truncateBody(firstLine(text) ?? "Assistant responded.", 360);
  }
  if (entry.kind === "stderr") {
    return truncateBody(firstLine(text) ?? firstLine(payload) ?? "Runtime reported an error.", 360);
  }
  return truncateBody(firstLine(text) ?? firstLine(payload) ?? "", 360);
}

function toKindLabel(kind: HeartbeatRunMessageRow["kind"]) {
  if (kind === "tool_call") return "tool_call";
  if (kind === "tool_result") return "tool_result";
  if (kind === "system") return "system";
  if (kind === "thinking") return "thinking";
  if (kind === "stderr") return "error";
  if (kind === "assistant") return "assistant";
  if (kind === "result") return "result";
  return kind;
}

function toKindClass(kind: HeartbeatRunMessageRow["kind"]) {
  if (kind === "stderr") return "run-transcript-kind run-transcript-kind--stderr";
  if (kind === "tool_call") return "run-transcript-kind run-transcript-kind--tool-call";
  if (kind === "tool_result") return "run-transcript-kind run-transcript-kind--tool-result";
  if (kind === "result") return "run-transcript-kind run-transcript-kind--result";
  return "run-transcript-kind run-transcript-kind--default";
}

function formatRunStatusLabel(status: string) {
  return status === "started" ? "running" : status;
}


function formatClock(value: string) {
  const date = new Date(value);
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const min = String(date.getMinutes()).padStart(2, "0");
  const sec = String(date.getSeconds()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${min}:${sec}`;
}

function formatRelativeTime(value: string) {
  const ms = Date.now() - new Date(value).getTime();
  if (ms < 60_000) return "just now";
  const min = Math.floor(ms / 60_000);
  if (min < 60) return `${min}m ago`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function tryParsePayload(payload: string) {
  if (!payload) {
    return null;
  }
  try {
    const parsed = JSON.parse(payload) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function getString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function firstLine(value: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const [first] = trimmed.split("\n");
  return first?.trim() || null;
}

function truncateBody(value: string, limit: number) {
  return value.length > limit ? `${value.slice(0, limit - 1).trimEnd()}…` : value;
}

function summarizeCommandExecution(value: string) {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized.startsWith("command:")) {
    return null;
  }
  const match = normalized.match(/^command:\s+(.+?)\s+status:\s+([a-z_]+)(?:\s+exit_code:\s+(-?\d+))?/i);
  if (!match) {
    return truncateBody(normalized, 220);
  }
  const [, command, statusRaw, exitCode] = match;
  const status = statusRaw ?? "completed";
  const statusLabel = status.toLowerCase() === "completed" ? "completed" : status.toLowerCase();
  const suffix = exitCode ? ` (exit ${exitCode})` : "";
  return truncateBody(`Command ${statusLabel}${suffix}: ${command}`, 220);
}

function extractSummaryFromJsonLikeMessage(input: string) {
  const normalized = input.trim();
  const fencedMatch = normalized.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fencedMatch?.[1]?.trim() ?? normalized.match(/\{[\s\S]*\}\s*$/)?.[0]?.trim();
  if (!candidate) {
    return null;
  }
  try {
    const parsed = JSON.parse(candidate) as Record<string, unknown>;
    const summary = parsed.summary;
    if (typeof summary === "string" && summary.trim()) {
      return summary.trim();
    }
  } catch {
    // Ignore parse failures and attempt regex extraction.
  }
  const summaryMatch = candidate.match(/"summary"\s*:\s*"([\s\S]*?)"/);
  const summary = summaryMatch?.[1]
    ?.replace(/\\"/g, "\"")
    .replace(/\\n/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return summary && summary.length > 0 ? summary : null;
}

function formatRunMessagePreview(message: string | null | undefined) {
  if (!message || !message.trim()) {
    return "No summary available";
  }
  const normalized = message
    .trim()
    .replace(/\\n/g, "\n")
    .replace(/\\"/g, "\"");
  const extractedSummary = extractSummaryFromJsonLikeMessage(normalized);
  if (extractedSummary) {
    return extractedSummary;
  }
  const plain = normalized
    .replace(/```(?:json)?/gi, "")
    .replace(/```/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (plain.length <= 180) {
    return plain;
  }
  return `${plain.slice(0, 177)}...`;
}
