"use client";

import Link from "next/link";
import type { Route } from "next";
import { useCallback, useEffect, useId, useMemo, useState, type FormEvent, type ReactNode } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { useRouter } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { AgentAvatar } from "@/components/agent-avatar";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { FieldLabelWithHelp } from "@/components/ui/field-label-with-help";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { DataTable } from "@/components/ui/data-table";
import { DataTableColumnHeader } from "@/components/ui/data-table-column-header";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ApiError, apiDelete, apiGet, apiPatch, apiPost } from "@/lib/api";
import { agentAvatarSeed } from "@/lib/agent-avatar";
import { formatSmartDateTime } from "@/lib/smart-date";
import { getStatusBadgeClassName } from "@/lib/status-presentation";
import type { WorkspacePageProps } from "@/components/workspace/workspace-page-props";
import { CollapsibleMarkdown } from "@/components/markdown-view";
import { LazyMarkdownMdxEditor } from "@/components/modals/lazy-markdown-mdx-editor";
import { SectionHeading, formatDateTime } from "@/components/workspace/shared";
import { WeekdayMultiSelect } from "@/components/weekday-multi-select";
import { SCHEDULE_HOUR_OPTIONS, SCHEDULE_MINUTE_OPTIONS } from "@/lib/schedule-picker-options";
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";

type ScheduleKind =
  | "every_minute"
  | "every_hour"
  | "every_day"
  | "weekdays"
  | "weekly"
  | "monthly"
  | "custom_cron";

type TriggerRow = {
  id: string;
  kind: string;
  enabled: boolean;
  cronExpression: string;
  timezone: string;
  nextRunAt: string | null;
  lastFiredAt: string | null;
  lastResult: string | null;
};

type RunRow = {
  id: string;
  status: string;
  source: string;
  triggeredAt: string;
  linkedIssueId: string | null;
  failureReason: string | null;
};

type RoutineDetail = {
  id: string;
  title: string;
  description: string | null;
  projectId: string;
  assigneeAgentId: string;
  priority: string;
  status: string;
  concurrencyPolicy: string;
  catchUpPolicy: string;
  lastTriggeredAt: string | null;
  createdAt: string;
  updatedAt: string;
  triggers: TriggerRow[];
  recentRuns: RunRow[];
};

type ActivityRow = {
  id: string;
  eventType: string;
  actorType: string;
  actorId: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
};

const LOOP_RUNS_AREA_CHART_CONFIG = {
  issueCreated: { label: "Issue opened", color: "var(--chart-1)" },
  failed: { label: "Failed", color: "var(--chart-5)" }
} satisfies ChartConfig;

const LOOP_ISSUES_AREA_CHART_CONFIG = {
  done: { label: "Done", color: "var(--chart-1)" },
  inReview: { label: "In review", color: "var(--chart-2)" },
  active: { label: "Open / active", color: "var(--chart-3)" }
} satisfies ChartConfig;

function shortRoutineId(value: string) {
  return value.length > 12 ? `${value.slice(0, 8)}…` : value;
}

function PropertyRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="ui-property-field">
      <div className="ui-property-label">{label}</div>
      <div className="ui-property-value">{value}</div>
    </div>
  );
}

function normalizeCronWeekday(value: number) {
  return value === 7 ? 0 : value;
}

function parseWeeklyDaysFromCron(dowField: string): number[] {
  if (!/^[0-7](,[0-7])*$/.test(dowField)) {
    return [];
  }
  const parsed = dowField
    .split(",")
    .map((part) => normalizeCronWeekday(Number(part)))
    .filter((day) => Number.isInteger(day) && day >= 0 && day <= 6);
  return [...new Set(parsed)].sort((a, b) => a - b);
}

function parseTriggerCron(cronExpression: string): {
  scheduleKind: ScheduleKind;
  hour24: number;
  minute: number;
  weekDays: number[];
  dayOfMonth: number;
  customCron: string;
} {
  const base = {
    scheduleKind: "custom_cron" as ScheduleKind,
    hour24: 9,
    minute: 0,
    weekDays: [1],
    dayOfMonth: 1,
    customCron: cronExpression
  };

  const parts = cronExpression.trim().split(/\s+/);
  if (parts.length !== 5) {
    return base;
  }
  const minuteField = parts[0] ?? "";
  const hourField = parts[1] ?? "";
  const dayOfMonthField = parts[2] ?? "";
  const monthField = parts[3] ?? "";
  const dayOfWeekField = parts[4] ?? "";
  const isNumeric = (value: string) => /^\d+$/.test(value);

  if (minuteField === "*" && hourField === "*" && dayOfMonthField === "*" && monthField === "*" && dayOfWeekField === "*") {
    return { ...base, scheduleKind: "every_minute" };
  }
  if (
    isNumeric(minuteField) &&
    hourField === "*" &&
    dayOfMonthField === "*" &&
    monthField === "*" &&
    dayOfWeekField === "*"
  ) {
    return {
      ...base,
      scheduleKind: "every_hour",
      minute: Math.min(59, Math.max(0, Number(minuteField)))
    };
  }
  if (
    isNumeric(minuteField) &&
    isNumeric(hourField) &&
    dayOfMonthField === "*" &&
    monthField === "*" &&
    dayOfWeekField === "*"
  ) {
    return {
      ...base,
      scheduleKind: "every_day",
      minute: Math.min(59, Math.max(0, Number(minuteField))),
      hour24: Math.min(23, Math.max(0, Number(hourField)))
    };
  }
  if (
    isNumeric(minuteField) &&
    isNumeric(hourField) &&
    dayOfMonthField === "*" &&
    monthField === "*" &&
    dayOfWeekField === "1-5"
  ) {
    return {
      ...base,
      scheduleKind: "weekdays",
      minute: Math.min(59, Math.max(0, Number(minuteField))),
      hour24: Math.min(23, Math.max(0, Number(hourField)))
    };
  }
  if (
    isNumeric(minuteField) &&
    isNumeric(hourField) &&
    isNumeric(dayOfMonthField) &&
    monthField === "*" &&
    dayOfWeekField === "*"
  ) {
    return {
      ...base,
      scheduleKind: "monthly",
      minute: Math.min(59, Math.max(0, Number(minuteField))),
      hour24: Math.min(23, Math.max(0, Number(hourField))),
      dayOfMonth: Math.min(31, Math.max(1, Number(dayOfMonthField)))
    };
  }
  if (isNumeric(minuteField) && isNumeric(hourField) && dayOfMonthField === "*" && monthField === "*") {
    const days = parseWeeklyDaysFromCron(dayOfWeekField);
    if (days.length > 0) {
      return {
        ...base,
        scheduleKind: "weekly",
        minute: Math.min(59, Math.max(0, Number(minuteField))),
        hour24: Math.min(23, Math.max(0, Number(hourField))),
        weekDays: days
      };
    }
  }

  return base;
}

function formatTime12Hour(hour24: number, minute: number) {
  const date = new Date(Date.UTC(2000, 0, 1, hour24, minute, 0));
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: "UTC"
  }).format(date);
}

function formatScheduleLabel(cronExpression: string) {
  const parsed = parseTriggerCron(cronExpression);
  const atTime = formatTime12Hour(parsed.hour24, parsed.minute);
  const weekdayLabel = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  if (parsed.scheduleKind === "every_minute") {
    return "Every minute";
  }
  if (parsed.scheduleKind === "every_hour") {
    return `Every hour at :${String(parsed.minute).padStart(2, "0")}`;
  }
  if (parsed.scheduleKind === "every_day") {
    return `Every day at ${atTime}`;
  }
  if (parsed.scheduleKind === "weekdays") {
    return `Weekdays at ${atTime}`;
  }
  if (parsed.scheduleKind === "weekly") {
    const days = parsed.weekDays.map((d) => weekdayLabel[d] ?? String(d)).join(", ");
    return `Weekly on ${days} at ${atTime}`;
  }
  if (parsed.scheduleKind === "monthly") {
    return `Monthly on day ${parsed.dayOfMonth} at ${atTime}`;
  }
  return cronExpression;
}

/** Visible fields in the “add trigger” row (excluding custom cron). */
function addTriggerGridColumnCount(scheduleKind: ScheduleKind): number {
  if (scheduleKind === "custom_cron") {
    return 0;
  }
  if (scheduleKind === "every_minute") {
    return 1;
  }
  if (scheduleKind === "every_hour") {
    return 2;
  }
  if (scheduleKind === "monthly") {
    return 4;
  }
  if (scheduleKind === "weekly") {
    return 4;
  }
  return 3;
}

/** Add-trigger count plus the Status field in the edit dialog. */
function editTriggerGridColumnCount(scheduleKind: ScheduleKind): number {
  return addTriggerGridColumnCount(scheduleKind) + 1;
}

function formatTriggerLastResult(raw: string | null, companyId: string | null): ReactNode {
  if (!raw?.trim()) {
    return "No result yet.";
  }
  if (raw === "Coalesced into an existing open issue") {
    return "No new issue was opened — this run was merged with an existing open issue from this routine.";
  }
  if (raw === "Skipped while an open issue exists") {
    return "Skipped because an issue from this routine is still open.";
  }
  if (raw === "Execution failed") {
    return "The run failed; no new issue was opened.";
  }
  if (raw === "Skipped missed window (catch-up: skip missed)") {
    return "Skipped: the schedule was too far behind and catch-up is set to skip missed runs.";
  }
  const created = /^Created execution issue (.+)$/.exec(raw);
  if (created) {
    const issueId = created[1]!;
    if (companyId) {
      const href = `/issues/${issueId}?companyId=${encodeURIComponent(companyId)}` as Route;
      return (
        <>
          Opened a new issue:{" "}
          <Link href={href} className="ui-loop-issue-link">
            {issueId}
          </Link>
        </>
      );
    }
    return `Opened a new issue (${issueId}).`;
  }
  return raw;
}

function formatLoopRunOutcomeLabel(status: string): string {
  switch (status) {
    case "issue_created":
      return "Opened a new issue";
    case "coalesced":
      return "Merged with an existing open issue";
    case "skipped":
      return "Skipped — an issue from this routine is still open";
    case "failed":
      return "Failed";
    case "received":
      return "In progress";
    default:
      return status.replaceAll("_", " ");
  }
}

export function RoutineDetailPageClient(
  props: WorkspacePageProps & {
    routineId: string;
  }
) {
  const { companyId, companies, projects, agents, routineId, issues } = props;
  const router = useRouter();
  const [detail, setDetail] = useState<RoutineDetail | null>(null);
  const [activity, setActivity] = useState<ActivityRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [scheduleKind, setScheduleKind] = useState<ScheduleKind>("every_day");
  const [hour24, setHour24] = useState(9);
  const [minute, setMinute] = useState(0);
  const [editOpen, setEditOpen] = useState(false);
  const [editInstructionsMdxKey, setEditInstructionsMdxKey] = useState(0);
  const [editBusy, setEditBusy] = useState(false);
  const [editTitle, setEditTitle] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editConcurrencyPolicy, setEditConcurrencyPolicy] = useState("coalesce_if_active");
  const [editCatchUpPolicy, setEditCatchUpPolicy] = useState("skip_missed");
  const [editingTriggerId, setEditingTriggerId] = useState<string | null>(null);
  const [triggerEditBusy, setTriggerEditBusy] = useState(false);
  const [triggerDeleteBusy, setTriggerDeleteBusy] = useState(false);
  const [triggerEditScheduleKind, setTriggerEditScheduleKind] = useState<ScheduleKind>("every_day");
  const [triggerEditHour24, setTriggerEditHour24] = useState(9);
  const [triggerEditMinute, setTriggerEditMinute] = useState(0);
  const [triggerEditWeekDays, setTriggerEditWeekDays] = useState<number[]>([1]);
  const [triggerEditDayOfMonth, setTriggerEditDayOfMonth] = useState(1);
  const [triggerEditCustomCron, setTriggerEditCustomCron] = useState("0 9 * * *");
  const [triggerEditEnabled, setTriggerEditEnabled] = useState<"enabled" | "disabled">("enabled");
  /** Cron DOW 0–6 (Sun–Sat); default Monday only */
  const [weekDays, setWeekDays] = useState<number[]>([1]);
  const [dayOfMonth, setDayOfMonth] = useState(1);
  const [customCron, setCustomCron] = useState("0 9 * * *");
  const [addTriggerBusy, setAddTriggerBusy] = useState(false);

  const load = useCallback(async () => {
    if (!companyId) {
      return;
    }
    setError(null);
    try {
      const res = await apiGet<{ data: RoutineDetail }>(`/routines/${routineId}`, companyId);
      setDetail(res.data.data);
      const act = await apiGet<{ data: ActivityRow[] }>(`/routines/${routineId}/activity`, companyId);
      setActivity(act.data.data ?? []);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Failed to load routine.");
      setDetail(null);
    }
  }, [companyId, routineId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!detail) {
      return;
    }
    setEditTitle(detail.title);
    setEditDescription(detail.description ?? "");
    setEditConcurrencyPolicy(detail.concurrencyPolicy);
    setEditCatchUpPolicy(detail.catchUpPolicy);
  }, [detail]);

  const projectName = projects.find((p) => p.id === detail?.projectId)?.name;
  const agent = agents.find((a) => a.id === detail?.assigneeAgentId);
  const editingTrigger = detail?.triggers.find((t) => t.id === editingTriggerId) ?? null;

  const loopSidebarMeta = useMemo(() => {
    if (!detail) {
      return { lastRunAt: null as string | null, lastRun: null as RunRow | null };
    }
    const lastRun = detail.recentRuns[0] ?? null;
    const lastRunAt = detail.lastTriggeredAt ?? lastRun?.triggeredAt ?? null;
    return { lastRunAt, lastRun };
  }, [detail]);

  const chartGradientId = useId().replace(/:/g, "");

  const loopRunsDailyChartData = useMemo(() => {
    const now = new Date();
    const days = 14;
    const byDay = new Map<string, { issueCreated: number; failed: number }>();
    for (let i = days - 1; i >= 0; i -= 1) {
      const day = new Date(now);
      day.setHours(0, 0, 0, 0);
      day.setDate(day.getDate() - i);
      const key = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
      byDay.set(key, { issueCreated: 0, failed: 0 });
    }
    const runs = detail?.recentRuns ?? [];
    for (const run of runs) {
      const day = new Date(run.triggeredAt);
      day.setHours(0, 0, 0, 0);
      const key = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
      const current = byDay.get(key);
      if (!current) {
        continue;
      }
      if (run.status === "issue_created") {
        current.issueCreated += 1;
      } else if (run.status === "failed") {
        current.failed += 1;
      }
    }
    return Array.from(byDay.entries()).map(([date, values]) => ({
      label: date.slice(5),
      issueCreated: values.issueCreated,
      failed: values.failed
    }));
  }, [detail]);

  const loopIssueActivityByDay = useMemo(() => {
    const now = new Date();
    const days = 14;
    const byDay = new Map<string, { done: number; inReview: number; active: number }>();
    for (let i = days - 1; i >= 0; i -= 1) {
      const day = new Date(now);
      day.setHours(0, 0, 0, 0);
      day.setDate(day.getDate() - i);
      const key = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
      byDay.set(key, { done: 0, inReview: 0, active: 0 });
    }
    for (const issue of issues) {
      if (issue.routineId !== routineId || issue.status === "canceled") {
        continue;
      }
      const day = new Date(issue.updatedAt);
      day.setHours(0, 0, 0, 0);
      const key = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
      const current = byDay.get(key);
      if (!current) {
        continue;
      }
      if (issue.status === "done") {
        current.done += 1;
      } else if (issue.status === "in_review") {
        current.inReview += 1;
      } else {
        current.active += 1;
      }
    }
    return Array.from(byDay.entries()).map(([date, values]) => ({
      label: date.slice(5),
      done: values.done,
      inReview: values.inReview,
      active: values.active
    }));
  }, [issues, routineId]);

  const hasLoopRunsTrend = useMemo(
    () => loopRunsDailyChartData.some((row) => row.issueCreated > 0 || row.failed > 0),
    [loopRunsDailyChartData]
  );
  const hasLoopIssuesTrend = useMemo(
    () => loopIssueActivityByDay.some((row) => row.done > 0 || row.inReview > 0 || row.active > 0),
    [loopIssueActivityByDay]
  );

  const loopRunColumns = useMemo<ColumnDef<RunRow>[]>(
    () => [
      {
        accessorKey: "triggeredAt",
        header: ({ column }) => <DataTableColumnHeader column={column} title="Triggered" />,
        cell: ({ row }) => (
          <time
            className="ui-run-table-datetime"
            dateTime={row.original.triggeredAt}
            title={formatDateTime(row.original.triggeredAt)}
          >
            {formatSmartDateTime(row.original.triggeredAt, { includeSeconds: true })}
          </time>
        )
      },
      {
        accessorKey: "status",
        header: ({ column }) => <DataTableColumnHeader column={column} title="Status" />,
        cell: ({ row }) => (
          <Badge variant="outline" className={getStatusBadgeClassName(row.original.status)}>
            {formatLoopRunOutcomeLabel(row.original.status)}
          </Badge>
        )
      },
      {
        accessorKey: "source",
        header: ({ column }) => <DataTableColumnHeader column={column} title="Source" />,
        cell: ({ row }) => <span className="ui-run-table-cell-muted">{row.original.source}</span>
      },
      {
        accessorKey: "failureReason",
        header: "Failure",
        enableSorting: false,
        cell: ({ row }) => {
          const fr = row.original.failureReason;
          if (!fr?.trim()) {
            return <span className="ui-run-table-cell-muted">—</span>;
          }
          const preview = fr.length > 120 ? `${fr.slice(0, 117)}…` : fr;
          return (
            <div className="ui-run-table-message" title={fr}>
              {preview}
            </div>
          );
        }
      },
      {
        accessorKey: "id",
        header: ({ column }) => <DataTableColumnHeader column={column} title="Run" />,
        cell: ({ row }) => (
          <span className="ui-run-table-cell-muted font-mono text-sm tabular-nums">{shortRoutineId(row.original.id)}</span>
        )
      }
    ],
    []
  );

  const loopActivityColumns = useMemo<ColumnDef<ActivityRow>[]>(
    () => [
      {
        accessorKey: "createdAt",
        header: ({ column }) => <DataTableColumnHeader column={column} title="Time" />,
        cell: ({ row }) => (
          <time
            className="ui-run-table-datetime"
            dateTime={row.original.createdAt}
            title={formatDateTime(row.original.createdAt)}
          >
            {formatSmartDateTime(row.original.createdAt, { includeSeconds: true })}
          </time>
        )
      },
      {
        accessorKey: "eventType",
        header: ({ column }) => <DataTableColumnHeader column={column} title="Event" />,
        cell: ({ row }) => <span>{row.original.eventType}</span>
      },
      {
        accessorKey: "actorType",
        header: ({ column }) => <DataTableColumnHeader column={column} title="Actor type" />,
        cell: ({ row }) => <span className="ui-run-table-cell-muted">{row.original.actorType}</span>
      },
      {
        accessorKey: "actorId",
        header: "Actor id",
        enableSorting: false,
        cell: ({ row }) => (
          <span className="ui-run-table-cell-muted font-mono text-sm">{row.original.actorId ?? "—"}</span>
        )
      },
      {
        id: "payloadPreview",
        accessorFn: (row) => JSON.stringify(row.payload),
        header: "Payload",
        enableSorting: false,
        cell: ({ row }) => {
          const raw = JSON.stringify(row.original.payload);
          const preview = raw.length > 160 ? `${raw.slice(0, 157)}…` : raw;
          return (
            <div className="ui-run-table-message font-mono text-sm" title={raw}>
              {preview}
            </div>
          );
        }
      }
    ],
    []
  );

  async function setActive(next: boolean) {
    if (!companyId || !detail) {
      return;
    }
    try {
      await apiPatch(`/routines/${detail.id}`, companyId, { status: next ? "active" : "paused" });
      await load();
      router.refresh();
    } catch {
      setError("Failed to update status.");
    }
  }

  async function runNow() {
    if (!companyId || !detail) {
      return;
    }
    setRunning(true);
    setError(null);
    try {
      await apiPost(`/routines/${detail.id}/run`, companyId, {});
      await load();
      router.refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Run failed.");
    } finally {
      setRunning(false);
    }
  }

  async function saveLoopEdits(e: FormEvent) {
    e.preventDefault();
    if (!companyId || !detail || !editTitle.trim()) {
      return;
    }
    setEditBusy(true);
    setError(null);
    try {
      const nextTitle = editTitle.trim();
      const nextDescription = editDescription.trim() || null;
      const patch: Record<string, unknown> = {};
      if (nextTitle !== detail.title) {
        patch.title = nextTitle;
      }
      if (nextDescription !== (detail.description ?? null)) {
        patch.description = nextDescription;
      }
      if (editConcurrencyPolicy !== detail.concurrencyPolicy) {
        patch.concurrencyPolicy = editConcurrencyPolicy;
      }
      if (editCatchUpPolicy !== detail.catchUpPolicy) {
        patch.catchUpPolicy = editCatchUpPolicy;
      }

      if (Object.keys(patch).length === 0) {
        setEditOpen(false);
        return;
      }

      const res = await apiPatch<{ data?: Partial<RoutineDetail> }>(`/routines/${detail.id}`, companyId, patch);
      const updated = res.data?.data;
      setDetail((prev) =>
        prev
          ? {
              ...prev,
              title: typeof updated?.title === "string" ? updated.title : nextTitle,
              description:
                updated && "description" in updated
                  ? (updated.description as string | null)
                  : nextDescription,
              concurrencyPolicy:
                typeof updated?.concurrencyPolicy === "string" ? updated.concurrencyPolicy : editConcurrencyPolicy,
              catchUpPolicy: typeof updated?.catchUpPolicy === "string" ? updated.catchUpPolicy : editCatchUpPolicy
            }
          : prev
      );
      setEditOpen(false);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : e instanceof Error ? e.message : "Failed to update routine.");
    } finally {
      setEditBusy(false);
    }
  }

  function openTriggerEdit(trigger: TriggerRow) {
    const parsed = parseTriggerCron(trigger.cronExpression);
    setEditingTriggerId(trigger.id);
    setTriggerEditScheduleKind(parsed.scheduleKind);
    setTriggerEditHour24(parsed.hour24);
    setTriggerEditMinute(parsed.minute);
    setTriggerEditWeekDays(parsed.weekDays);
    setTriggerEditDayOfMonth(parsed.dayOfMonth);
    setTriggerEditCustomCron(parsed.customCron);
    setTriggerEditEnabled(trigger.enabled ? "enabled" : "disabled");
  }

  async function saveTriggerEdits(e: FormEvent) {
    e.preventDefault();
    if (!companyId || !detail || !editingTriggerId || !editingTrigger) {
      return;
    }
    let nextCron = "";
    if (triggerEditScheduleKind === "custom_cron") {
      nextCron = triggerEditCustomCron.trim();
    } else if (triggerEditScheduleKind === "every_minute") {
      nextCron = "* * * * *";
    } else if (triggerEditScheduleKind === "every_hour") {
      nextCron = `${triggerEditMinute} * * * *`;
    } else if (triggerEditScheduleKind === "every_day") {
      nextCron = `${triggerEditMinute} ${triggerEditHour24} * * *`;
    } else if (triggerEditScheduleKind === "weekdays") {
      nextCron = `${triggerEditMinute} ${triggerEditHour24} * * 1-5`;
    } else if (triggerEditScheduleKind === "weekly") {
      const days = [...new Set(triggerEditWeekDays.filter((d) => d >= 0 && d <= 6))].sort((a, b) => a - b);
      if (days.length === 0) {
        setError("Select at least one day of the week.");
        return;
      }
      nextCron = `${triggerEditMinute} ${triggerEditHour24} * * ${days.join(",")}`;
    } else if (triggerEditScheduleKind === "monthly") {
      nextCron = `${triggerEditMinute} ${triggerEditHour24} ${triggerEditDayOfMonth} * *`;
    }
    if (!nextCron) {
      setError("Cron expression is required.");
      return;
    }

    const patch: Record<string, unknown> = {};
    if (nextCron !== editingTrigger.cronExpression) {
      patch.cronExpression = nextCron;
    }
    const nextEnabled = triggerEditEnabled === "enabled";
    if (nextEnabled !== editingTrigger.enabled) {
      patch.enabled = nextEnabled;
    }
    if (Object.keys(patch).length === 0) {
      setEditingTriggerId(null);
      return;
    }

    setTriggerEditBusy(true);
    setError(null);
    try {
      const res = await apiPatch<{ data?: Partial<TriggerRow> }>(
        `/routines/${detail.id}/triggers/${editingTriggerId}`,
        companyId,
        patch
      );
      const updated = res.data?.data;
      setDetail((prev) => {
        if (!prev) {
          return prev;
        }
        return {
          ...prev,
          triggers: prev.triggers.map((trigger) =>
            trigger.id !== editingTriggerId
              ? trigger
              : {
                  ...trigger,
                  cronExpression:
                    typeof updated?.cronExpression === "string"
                      ? updated.cronExpression
                      : (patch.cronExpression as string | undefined) ?? trigger.cronExpression,
                  enabled:
                    typeof updated?.enabled === "boolean"
                      ? updated.enabled
                      : (patch.enabled as boolean | undefined) ?? trigger.enabled,
                  timezone:
                    typeof updated?.timezone === "string"
                      ? updated.timezone
                      : trigger.timezone
                }
          )
        };
      });
      setEditingTriggerId(null);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : e instanceof Error ? e.message : "Failed to update trigger.");
    } finally {
      setTriggerEditBusy(false);
    }
  }

  async function deleteTrigger() {
    if (!companyId || !detail || !editingTriggerId) {
      return;
    }
    setError(null);
    setTriggerDeleteBusy(true);
    try {
      await apiDelete(`/routines/${detail.id}/triggers/${editingTriggerId}`, companyId);
      const removedId = editingTriggerId;
      setDetail((prev) => {
        if (!prev) {
          return prev;
        }
        return { ...prev, triggers: prev.triggers.filter((t) => t.id !== removedId) };
      });
      setEditingTriggerId(null);
      router.refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : e instanceof Error ? e.message : "Failed to delete trigger.");
    } finally {
      setTriggerDeleteBusy(false);
    }
  }

  async function addTrigger(e: FormEvent) {
    e.preventDefault();
    if (!companyId || !detail) {
      return;
    }
    const timezone = "UTC";
    setAddTriggerBusy(true);
    setError(null);
    try {
      if (scheduleKind === "custom_cron") {
        await apiPost(`/routines/${detail.id}/triggers`, companyId, {
          mode: "cron",
          cronExpression: customCron.trim(),
          timezone,
          enabled: true
        });
      } else if (scheduleKind === "every_minute") {
        await apiPost(`/routines/${detail.id}/triggers`, companyId, {
          mode: "cron",
          cronExpression: "* * * * *",
          timezone,
          enabled: true
        });
      } else if (scheduleKind === "every_hour") {
        await apiPost(`/routines/${detail.id}/triggers`, companyId, {
          mode: "cron",
          cronExpression: `${minute} * * * *`,
          timezone,
          enabled: true
        });
      } else if (scheduleKind === "every_day") {
        await apiPost(`/routines/${detail.id}/triggers`, companyId, {
          mode: "preset",
          preset: "daily",
          hour24,
          minute,
          timezone,
          enabled: true
        });
      } else if (scheduleKind === "weekdays") {
        await apiPost(`/routines/${detail.id}/triggers`, companyId, {
          mode: "cron",
          cronExpression: `${minute} ${hour24} * * 1-5`,
          timezone,
          enabled: true
        });
      } else if (scheduleKind === "weekly") {
        const days = [...new Set(weekDays.filter((d) => d >= 0 && d <= 6))].sort((a, b) => a - b);
        if (days.length === 0) {
          setError("Select at least one day of the week.");
          return;
        }
        if (days.length === 1) {
          await apiPost(`/routines/${detail.id}/triggers`, companyId, {
            mode: "preset",
            preset: "weekly",
            hour24,
            minute,
            dayOfWeek: days[0],
            timezone,
            enabled: true
          });
        } else {
          await apiPost(`/routines/${detail.id}/triggers`, companyId, {
            mode: "cron",
            cronExpression: `${minute} ${hour24} * * ${days.join(",")}`,
            timezone,
            enabled: true
          });
        }
      } else if (scheduleKind === "monthly") {
        await apiPost(`/routines/${detail.id}/triggers`, companyId, {
          mode: "cron",
          cronExpression: `${minute} ${hour24} ${dayOfMonth} * *`,
          timezone,
          enabled: true
        });
      }
      await load();
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to add trigger.");
    } finally {
      setAddTriggerBusy(false);
    }
  }

  const rightPane =
    !detail ? null : (
      <div className="ui-detail-sidebar">
        <Card>
          <CardContent className="ui-detail-sidebar-section">
            <PropertyRow label="Title" value={detail.title} />
            <PropertyRow
              label="Agent"
              value={
                agent && companyId ? (
                  <Link
                    href={`/agents/${agent.id}?companyId=${encodeURIComponent(companyId)}` as Route}
                    className="ui-link-sidebar-nested"
                  >
                    {agent.name}
                  </Link>
                ) : (
                  (agent?.name ?? "Unknown agent")
                )
              }
            />
            <PropertyRow
              label="Project"
              value={
                companyId && projectName ? (
                  <Link
                    href={`/projects/${detail.projectId}?companyId=${encodeURIComponent(companyId)}` as Route}
                    className="ui-link-sidebar-nested"
                  >
                    {projectName}
                  </Link>
                ) : (
                  (projectName ?? "Unknown")
                )
              }
            />
            <PropertyRow
              label="Last run"
              value={
                loopSidebarMeta.lastRunAt
                  ? `${formatSmartDateTime(loopSidebarMeta.lastRunAt)}${
                      loopSidebarMeta.lastRun
                        ? ` · ${formatLoopRunOutcomeLabel(loopSidebarMeta.lastRun.status)}`
                        : ""
                    }`
                  : "Never"
              }
            />
            <PropertyRow label="Created" value={formatSmartDateTime(detail.createdAt)} />
            <PropertyRow label="Updated" value={formatSmartDateTime(detail.updatedAt)} />
          </CardContent>
        </Card>
      </div>
    );

  return (
    <AppShell
      leftPane={
        <div className="ui-page-stack ui-loop-detail-scroll">
          {error ? (
            <p className="ui-loop-inline-error" role="alert">
              {error}
            </p>
          ) : null}
          {!detail ? null : (
            <>
              <div className="ui-page-section-gap-sm">
                <div className="ui-page-header-row">
                  <div className="ui-page-header-intro">
                    <SectionHeading title={detail.title} description="Routine details and scheduling controls." />
                  </div>
                  <div className="ui-page-header-actions">
                    <Dialog
                      open={editOpen}
                      onOpenChange={(next) => {
                        setEditOpen(next);
                        if (next) {
                          setEditInstructionsMdxKey((k) => k + 1);
                        }
                      }}
                    >
                    {detail.status === "archived" ? (
                      <Badge variant="outline" className="ui-loop-header-badge">
                        Archived
                      </Badge>
                    ) : (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => void setActive(detail.status !== "active")}
                        aria-pressed={detail.status === "active"}
                      >
                        {detail.status === "active" ? "Pause" : "Resume"}
                      </Button>
                    )}
                      <DialogTrigger asChild>
                        <Button type="button" size="sm" variant="outline">
                          Edit
                        </Button>
                      </DialogTrigger>
                      <DialogContent>
                        <DialogHeader>
                          <DialogTitle>Edit routine</DialogTitle>
                        </DialogHeader>
                        <form onSubmit={saveLoopEdits}>
                          <FieldGroup>
                            <Field>
                              <FieldLabel>Title</FieldLabel>
                              <Input value={editTitle} onChange={(ev) => setEditTitle(ev.target.value)} required />
                            </Field>
                            <Field>
                              <FieldLabelWithHelp helpText="Becomes the new issue body when the routine runs. The markdown editor shows formatted text as you type; the routine and issue pages render the same Markdown.">
                                Instructions
                              </FieldLabelWithHelp>
                              <LazyMarkdownMdxEditor
                                editorKey={`routine-edit-instructions-${routineId}-${editInstructionsMdxKey}`}
                                markdown={editDescription}
                                onChange={setEditDescription}
                                placeholder="Instructions for each run…"
                              />
                            </Field>
                            <Field>
                              <FieldLabelWithHelp helpText="When a trigger fires but the last run still has an open issue: reuse that issue (coalesce), skip this firing, or create a new issue anyway.">
                                If another run is already open
                              </FieldLabelWithHelp>
                              <Select value={editConcurrencyPolicy} onValueChange={setEditConcurrencyPolicy}>
                                <SelectTrigger>
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="coalesce_if_active">Reuse the existing open item</SelectItem>
                                  <SelectItem value="skip_if_active">Skip this run</SelectItem>
                                  <SelectItem value="always_enqueue">Create a new item anyway</SelectItem>
                                </SelectContent>
                              </Select>
                            </Field>
                            <Field>
                              <FieldLabelWithHelp helpText="After downtime or pauses: skip missed windows without backfilling, or enqueue catch-up runs—at most 25 missed fires processed in one scheduler pass.">
                                If some scheduled runs were missed
                              </FieldLabelWithHelp>
                              <Select value={editCatchUpPolicy} onValueChange={setEditCatchUpPolicy}>
                                <SelectTrigger>
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="skip_missed">Ignore missed runs</SelectItem>
                                  <SelectItem value="enqueue_missed_with_cap">Catch up missed runs (limited)</SelectItem>
                                </SelectContent>
                              </Select>
                            </Field>
                          </FieldGroup>
                          <DialogFooter>
                            <Button type="submit" disabled={editBusy || !editTitle.trim()}>
                              {editBusy ? "Saving…" : "Save changes"}
                            </Button>
                          </DialogFooter>
                        </form>
                      </DialogContent>
                    </Dialog>
                    <Button type="button" size="sm" variant="default" disabled={running} onClick={() => void runNow()}>
                      {running ? "Running…" : "Run now"}
                    </Button>
                  </div>
                </div>
              </div>

              <Tabs defaultValue="dashboard" className="ui-tabs-gap-none">
                <TabsList>
                  <TabsTrigger value="dashboard">Dashboard</TabsTrigger>
                  <TabsTrigger value="triggers">Triggers</TabsTrigger>
                  <TabsTrigger value="instructions">Instructions</TabsTrigger>
                  <TabsTrigger value="runs">Runs</TabsTrigger>
                  <TabsTrigger value="activity">Activity</TabsTrigger>
                </TabsList>
                <TabsContent value="dashboard" className="ui-issue-tabs-content">
                  <div className="ui-agent-dashboard-charts-grid">
                    <Card>
                      <CardHeader>
                        <CardTitle>Run outcomes</CardTitle>
                        <CardDescription>
                          Issue opened vs failed by trigger day (last 14 days). Based on recent runs loaded with this routine
                          (up to 30); skipped or coalesced runs are not shown.
                        </CardDescription>
                      </CardHeader>
                      <CardContent>
                        {hasLoopRunsTrend ? (
                          <ChartContainer config={LOOP_RUNS_AREA_CHART_CONFIG} className="ui-agent-dashboard-chart">
                            <AreaChart accessibilityLayer data={loopRunsDailyChartData} margin={{ top: 8, left: -8, right: -8 }}>
                              <defs>
                                <linearGradient id={`${chartGradientId}-loopRunsOpened`} x1="0" y1="0" x2="0" y2="1">
                                  <stop offset="10%" stopColor="var(--color-issueCreated)" stopOpacity={0.45} />
                                  <stop offset="90%" stopColor="var(--color-issueCreated)" stopOpacity={0.06} />
                                </linearGradient>
                                <linearGradient id={`${chartGradientId}-loopRunsFailed`} x1="0" y1="0" x2="0" y2="1">
                                  <stop offset="10%" stopColor="var(--color-failed)" stopOpacity={0.4} />
                                  <stop offset="90%" stopColor="var(--color-failed)" stopOpacity={0.04} />
                                </linearGradient>
                              </defs>
                              <CartesianGrid vertical={false} strokeDasharray="4 4" strokeOpacity={0.3} />
                              <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={10} minTickGap={22} />
                              <YAxis hide />
                              <ChartTooltip content={<ChartTooltipContent indicator="line" />} cursor={false} />
                              <Area
                                type="monotone"
                                dataKey="issueCreated"
                                stroke="var(--color-issueCreated)"
                                fill={`url(#${chartGradientId}-loopRunsOpened)`}
                                fillOpacity={1}
                                strokeWidth={2}
                              />
                              <Area
                                type="monotone"
                                dataKey="failed"
                                stroke="var(--color-failed)"
                                fill={`url(#${chartGradientId}-loopRunsFailed)`}
                                fillOpacity={1}
                                strokeWidth={2}
                              />
                            </AreaChart>
                          </ChartContainer>
                        ) : (
                          <p className="text-sm text-muted-foreground">
                            No issue-opened or failed runs in the last 14 days in the recent runs list.
                          </p>
                        )}
                      </CardContent>
                    </Card>
                    <Card>
                      <CardHeader>
                        <CardTitle>Routine issue activity</CardTitle>
                        <CardDescription>
                          Issues tied to this routine, counted on the day they were last updated, stacked by status (last 14
                          days).
                        </CardDescription>
                      </CardHeader>
                      <CardContent>
                        {hasLoopIssuesTrend ? (
                          <ChartContainer config={LOOP_ISSUES_AREA_CHART_CONFIG} className="ui-agent-dashboard-chart">
                            <AreaChart accessibilityLayer data={loopIssueActivityByDay} margin={{ top: 8, left: -8, right: -8 }}>
                              <defs>
                                <linearGradient id={`${chartGradientId}-loopIssDone`} x1="0" y1="0" x2="0" y2="1">
                                  <stop offset="10%" stopColor="var(--color-done)" stopOpacity={0.45} />
                                  <stop offset="90%" stopColor="var(--color-done)" stopOpacity={0.06} />
                                </linearGradient>
                                <linearGradient id={`${chartGradientId}-loopIssReview`} x1="0" y1="0" x2="0" y2="1">
                                  <stop offset="10%" stopColor="var(--color-inReview)" stopOpacity={0.4} />
                                  <stop offset="90%" stopColor="var(--color-inReview)" stopOpacity={0.06} />
                                </linearGradient>
                                <linearGradient id={`${chartGradientId}-loopIssActive`} x1="0" y1="0" x2="0" y2="1">
                                  <stop offset="10%" stopColor="var(--color-active)" stopOpacity={0.38} />
                                  <stop offset="90%" stopColor="var(--color-active)" stopOpacity={0.05} />
                                </linearGradient>
                              </defs>
                              <CartesianGrid vertical={false} strokeDasharray="4 4" strokeOpacity={0.3} />
                              <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={10} minTickGap={22} />
                              <YAxis hide />
                              <ChartTooltip content={<ChartTooltipContent indicator="line" />} cursor={false} />
                              <Area
                                type="monotone"
                                dataKey="done"
                                stackId="loopIssues"
                                stroke="var(--color-done)"
                                fill={`url(#${chartGradientId}-loopIssDone)`}
                                fillOpacity={1}
                                strokeWidth={2}
                              />
                              <Area
                                type="monotone"
                                dataKey="inReview"
                                stackId="loopIssues"
                                stroke="var(--color-inReview)"
                                fill={`url(#${chartGradientId}-loopIssReview)`}
                                fillOpacity={1}
                                strokeWidth={2}
                              />
                              <Area
                                type="monotone"
                                dataKey="active"
                                stackId="loopIssues"
                                stroke="var(--color-active)"
                                fill={`url(#${chartGradientId}-loopIssActive)`}
                                fillOpacity={1}
                                strokeWidth={2}
                              />
                            </AreaChart>
                          </ChartContainer>
                        ) : (
                          <p className="text-sm text-muted-foreground">No routine issue updates in the last 14 days.</p>
                        )}
                      </CardContent>
                    </Card>
                  </div>
                </TabsContent>
                <TabsContent value="instructions" className="ui-issue-tabs-content">
                  <Card>
                    <CardContent className="ui-detail-sidebar-section">
                      {detail.description?.trim() ? (
                        <CollapsibleMarkdown
                          content={detail.description}
                          className="ui-markdown"
                          maxHeightPx={280}
                        />
                      ) : (
                        <span className="ui-issue-muted-text">No instructions provided.</span>
                      )}
                    </CardContent>
                  </Card>
                </TabsContent>
                <TabsContent value="triggers">
                  <Card>
                    <form onSubmit={addTrigger}>
                      <CardContent className="ui-loop-trigger-form-card-body">
                        {scheduleKind === "custom_cron" ? (
                          <FieldGroup>
                              <Field>
                                <FieldLabel>Schedule</FieldLabel>
                                <Select
                                  value={scheduleKind}
                                  onValueChange={(v) => setScheduleKind(v as ScheduleKind)}>
                                  <SelectTrigger>
                                    <SelectValue />
                                  </SelectTrigger>
                                  <SelectContent>
                                    <SelectItem value="every_minute">Every minute</SelectItem>
                                    <SelectItem value="every_hour">Every hour</SelectItem>
                                    <SelectItem value="every_day">Every day</SelectItem>
                                    <SelectItem value="weekdays">Weekdays</SelectItem>
                                    <SelectItem value="weekly">Weekly</SelectItem>
                                    <SelectItem value="monthly">Monthly</SelectItem>
                                    <SelectItem value="custom_cron">Custom (cron)</SelectItem>
                                  </SelectContent>
                                </Select>
                              </Field>
                            <Field>
                              <FieldLabel>Cron expression</FieldLabel>
                              <Textarea
                                value={customCron}
                                onChange={(ev) => setCustomCron(ev.target.value)}
                                placeholder="minute hour day-of-month month day-of-week"
                                rows={2}
                                className="ui-loop-cron-textarea"
                              />
                              <p className="ui-loop-form-hint">
                                Five fields: minute, hour, day of month, month, day of week (cron syntax).
                              </p>
                            </Field>
                          </FieldGroup>
                        ) : (
                          <div
                            className="ui-loop-trigger-fields-row"
                            style={{
                              gridTemplateColumns: `repeat(${addTriggerGridColumnCount(scheduleKind)}, minmax(0, 1fr))`
                            }}
                          >
                            <Field className="ui-field-min-w-0">
                              <FieldLabel>Schedule</FieldLabel>
                              <Select
                                value={scheduleKind}
                                onValueChange={(v) => setScheduleKind(v as ScheduleKind)}>
                                <SelectTrigger>
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="every_minute">Every minute</SelectItem>
                                  <SelectItem value="every_hour">Every hour</SelectItem>
                                  <SelectItem value="every_day">Every day</SelectItem>
                                  <SelectItem value="weekdays">Weekdays</SelectItem>
                                  <SelectItem value="weekly">Weekly</SelectItem>
                                  <SelectItem value="monthly">Monthly</SelectItem>
                                  <SelectItem value="custom_cron">Custom (cron)</SelectItem>
                                </SelectContent>
                              </Select>
                            </Field>
                            {scheduleKind === "monthly" ? (
                              <Field className="ui-field-min-w-0">
                                <FieldLabel>Day</FieldLabel>
                                <Select value={String(dayOfMonth)} onValueChange={(v) => setDayOfMonth(Number(v))}>
                                  <SelectTrigger>
                                    <SelectValue />
                                  </SelectTrigger>
                                  <SelectContent>
                                    {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => (
                                      <SelectItem key={d} value={String(d)}>
                                        {d}
                                      </SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                              </Field>
                            ) : null}
                            {scheduleKind === "every_minute" ? null : scheduleKind === "every_hour" ? (
                              <>
                                <Field className="ui-field-min-w-0">
                                  <FieldLabel>Minute</FieldLabel>
                                  <Select value={String(minute)} onValueChange={(v) => setMinute(Number(v))}>
                                    <SelectTrigger>
                                      <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent className="ui-select-content-tall">
                                      {SCHEDULE_MINUTE_OPTIONS.map((opt) => (
                                        <SelectItem key={opt.value} value={opt.value}>
                                          {opt.label}
                                        </SelectItem>
                                      ))}
                                    </SelectContent>
                                  </Select>
                                </Field>
                              </>
                            ) : (
                              <>
                                <Field className="ui-field-min-w-0">
                                  <FieldLabel>Hour</FieldLabel>
                                  <Select value={String(hour24)} onValueChange={(v) => setHour24(Number(v))}>
                                    <SelectTrigger>
                                      <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent className="ui-select-content-tall">
                                      {SCHEDULE_HOUR_OPTIONS.map((opt) => (
                                        <SelectItem key={opt.value} value={opt.value}>
                                          {opt.label}
                                        </SelectItem>
                                      ))}
                                    </SelectContent>
                                  </Select>
                                </Field>
                                <Field className="ui-field-min-w-0">
                                  <FieldLabel>Minute</FieldLabel>
                                  <Select value={String(minute)} onValueChange={(v) => setMinute(Number(v))}>
                                    <SelectTrigger>
                                      <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent className="ui-select-content-tall">
                                      {SCHEDULE_MINUTE_OPTIONS.map((opt) => (
                                        <SelectItem key={opt.value} value={opt.value}>
                                          {opt.label}
                                        </SelectItem>
                                      ))}
                                    </SelectContent>
                                  </Select>
                                </Field>
                              </>
                            )}
                            {scheduleKind === "weekly" ? (
                              <Field className="ui-field-min-w-0">
                                <FieldLabel className="ui-field-label-align-start">Days</FieldLabel>
                                <WeekdayMultiSelect value={weekDays} onChange={setWeekDays} />
                              </Field>
                            ) : null}
                          </div>
                        )}
                      </CardContent>
                      <CardFooter className="ui-loop-card-footer-actions">
                        <Button type="submit" size="sm" disabled={addTriggerBusy}>
                          {addTriggerBusy ? "Adding…" : "Add trigger"}
                        </Button>
                      </CardFooter>
                    </form>
                  </Card>
                  <div className="ui-loop-triggers-after-form">
                    <SectionHeading
                      title="Triggers"
                      description="Triggers for this routine."
                    />
                    {detail.triggers.length === 0 ? (
                      <p className="ui-issue-muted-text">No triggers yet.</p>
                    ) : (
                      detail.triggers.map((t) => (
                        <Card key={t.id}>
                          <CardContent className="ui-loop-trigger-detail-rows">
                            <div className="ui-loop-trigger-meta-row">
                              <span className="ui-loop-trigger-meta-label">Schedule</span>
                              <span className="ui-loop-trigger-meta-value">{formatScheduleLabel(t.cronExpression)}</span>
                            </div>
                            <div className="ui-loop-trigger-meta-row">
                              <span className="ui-loop-trigger-meta-label">Next run</span>
                              <span className="ui-loop-trigger-meta-value">
                                {t.nextRunAt ? formatSmartDateTime(t.nextRunAt) : "Not scheduled"}
                              </span>
                            </div>
                            <div className="ui-loop-trigger-meta-row">
                              <span className="ui-loop-trigger-meta-label">Last fired</span>
                              <span className="ui-loop-trigger-meta-value">
                                {t.lastFiredAt ? formatSmartDateTime(t.lastFiredAt) : "Never"}
                              </span>
                            </div>
                            <div className="ui-loop-trigger-meta-row">
                              <span className="ui-loop-trigger-meta-label">Last result</span>
                              <span className="ui-loop-trigger-meta-value">
                                {formatTriggerLastResult(t.lastResult, companyId)}
                              </span>
                            </div>
                          </CardContent>
                          <CardFooter className="ui-loop-card-footer-actions">
                            <Button type="button" size="sm" variant="outline" onClick={() => openTriggerEdit(t)}>Edit</Button>
                          </CardFooter>
                        </Card>
                      ))
                    )}
                  </div>
                  <Dialog open={!!editingTriggerId} onOpenChange={(open) => (!open ? setEditingTriggerId(null) : undefined)}>
                    <DialogContent>
                      <DialogHeader>
                        <DialogTitle>Edit trigger</DialogTitle>
                      </DialogHeader>
                      <form onSubmit={saveTriggerEdits}>
                        {triggerEditScheduleKind === "custom_cron" ? (
                          <FieldGroup>
                            <Field>
                              <FieldLabel>Schedule</FieldLabel>
                              <Select
                                value={triggerEditScheduleKind}
                                onValueChange={(v) => setTriggerEditScheduleKind(v as ScheduleKind)}
                              >
                                <SelectTrigger>
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="every_minute">Every minute</SelectItem>
                                  <SelectItem value="every_hour">Every hour</SelectItem>
                                  <SelectItem value="every_day">Every day</SelectItem>
                                  <SelectItem value="weekdays">Weekdays</SelectItem>
                                  <SelectItem value="weekly">Weekly</SelectItem>
                                  <SelectItem value="monthly">Monthly</SelectItem>
                                  <SelectItem value="custom_cron">Custom (cron)</SelectItem>
                                </SelectContent>
                              </Select>
                            </Field>
                            <Field>
                              <FieldLabel>Cron expression</FieldLabel>
                              <Textarea
                                value={triggerEditCustomCron}
                                onChange={(ev) => setTriggerEditCustomCron(ev.target.value)}
                                placeholder="minute hour day-of-month month day-of-week"
                                rows={2}
                                className="ui-loop-cron-textarea"
                              />
                              <p className="ui-loop-form-hint">
                                Five fields: minute, hour, day of month, month, day of week (cron syntax).
                              </p>
                            </Field>
                          </FieldGroup>
                        ) : (
                          <div
                            className="ui-loop-trigger-fields-row"
                            style={{
                              gridTemplateColumns: `repeat(${editTriggerGridColumnCount(triggerEditScheduleKind)}, minmax(0, 1fr))`
                            }}
                          >
                            <Field className="ui-field-min-w-0">
                              <FieldLabel>Schedule</FieldLabel>
                              <Select
                                value={triggerEditScheduleKind}
                                onValueChange={(v) => setTriggerEditScheduleKind(v as ScheduleKind)}
                              >
                                <SelectTrigger>
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="every_minute">Every minute</SelectItem>
                                  <SelectItem value="every_hour">Every hour</SelectItem>
                                  <SelectItem value="every_day">Every day</SelectItem>
                                  <SelectItem value="weekdays">Weekdays</SelectItem>
                                  <SelectItem value="weekly">Weekly</SelectItem>
                                  <SelectItem value="monthly">Monthly</SelectItem>
                                  <SelectItem value="custom_cron">Custom (cron)</SelectItem>
                                </SelectContent>
                              </Select>
                            </Field>
                            {triggerEditScheduleKind === "monthly" ? (
                              <Field className="ui-field-min-w-0">
                                <FieldLabel>Day</FieldLabel>
                                <Select value={String(triggerEditDayOfMonth)} onValueChange={(v) => setTriggerEditDayOfMonth(Number(v))}>
                                  <SelectTrigger>
                                    <SelectValue />
                                  </SelectTrigger>
                                  <SelectContent>
                                    {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => (
                                      <SelectItem key={d} value={String(d)}>
                                        {d}
                                      </SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                              </Field>
                            ) : null}
                            {triggerEditScheduleKind === "every_minute" ? null : triggerEditScheduleKind === "every_hour" ? (
                              <Field className="ui-field-min-w-0">
                                <FieldLabel>Minute</FieldLabel>
                                <Select value={String(triggerEditMinute)} onValueChange={(v) => setTriggerEditMinute(Number(v))}>
                                  <SelectTrigger>
                                    <SelectValue />
                                  </SelectTrigger>
                                  <SelectContent className="ui-select-content-tall">
                                    {SCHEDULE_MINUTE_OPTIONS.map((opt) => (
                                      <SelectItem key={opt.value} value={opt.value}>
                                        {opt.label}
                                      </SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                              </Field>
                            ) : (
                              <>
                                <Field className="ui-field-min-w-0">
                                  <FieldLabel>Hour</FieldLabel>
                                  <Select value={String(triggerEditHour24)} onValueChange={(v) => setTriggerEditHour24(Number(v))}>
                                    <SelectTrigger>
                                      <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent className="ui-select-content-tall">
                                      {SCHEDULE_HOUR_OPTIONS.map((opt) => (
                                        <SelectItem key={opt.value} value={opt.value}>
                                          {opt.label}
                                        </SelectItem>
                                      ))}
                                    </SelectContent>
                                  </Select>
                                </Field>
                                <Field className="ui-field-min-w-0">
                                  <FieldLabel>Minute</FieldLabel>
                                  <Select value={String(triggerEditMinute)} onValueChange={(v) => setTriggerEditMinute(Number(v))}>
                                    <SelectTrigger>
                                      <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent className="ui-select-content-tall">
                                      {SCHEDULE_MINUTE_OPTIONS.map((opt) => (
                                        <SelectItem key={opt.value} value={opt.value}>
                                          {opt.label}
                                        </SelectItem>
                                      ))}
                                    </SelectContent>
                                  </Select>
                                </Field>
                              </>
                            )}
                            {triggerEditScheduleKind === "weekly" ? (
                              <Field className="ui-field-min-w-0">
                                <FieldLabel className="ui-field-label-align-start">Days</FieldLabel>
                                <WeekdayMultiSelect value={triggerEditWeekDays} onChange={setTriggerEditWeekDays} />
                              </Field>
                            ) : null}
                            <Field className="ui-field-min-w-0">
                              <FieldLabel>Status</FieldLabel>
                              <Select value={triggerEditEnabled} onValueChange={(v) => setTriggerEditEnabled(v as "enabled" | "disabled")}>
                                <SelectTrigger>
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="enabled">Active</SelectItem>
                                  <SelectItem value="disabled">Paused</SelectItem>
                                </SelectContent>
                              </Select>
                            </Field>
                          </div>
                        )}
                        <DialogFooter>
                          <Button
                            type="button"
                            variant="ghost"
                            onClick={() => void deleteTrigger()}
                            disabled={triggerEditBusy || triggerDeleteBusy}
                          >
                            {triggerDeleteBusy ? "Deleting…" : "Delete"}
                          </Button>
                          <Button type="submit" disabled={triggerEditBusy || triggerDeleteBusy}>
                            {triggerEditBusy ? "Saving…" : "Save trigger"}
                          </Button>
                        </DialogFooter>
                      </form>
                    </DialogContent>
                  </Dialog>
                </TabsContent>
                <TabsContent value="runs" className="ui-issue-tabs-content">
                  <SectionHeading
                    title="Runs"
                    description="Heartbeat runs scoped to this routine."
                  />
                  <DataTable
                    columns={loopRunColumns}
                    data={detail.recentRuns}
                    emptyMessage="No runs yet."
                    defaultPageSize={10}
                    showViewOptions={false}
                  />
                </TabsContent>
                <TabsContent value="activity" className="ui-issue-tabs-content">
                <SectionHeading
                  title="Activity"
                  description="Activity log for this routine."
                />
                  <DataTable
                    columns={loopActivityColumns}
                    data={activity}
                    emptyMessage="No activity yet."
                    defaultPageSize={10}
                    showViewOptions={false}
                  />
                </TabsContent>
              </Tabs>
            </>
          )}
        </div>
      }
      rightPane={rightPane}
      activeNav="Routines"
      companies={companies}
      activeCompanyId={companyId}
    />
  );
}
