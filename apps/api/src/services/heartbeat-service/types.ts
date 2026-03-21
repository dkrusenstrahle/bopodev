import type { RunCompletionReason } from "bopodev-contracts";

export type HeartbeatRunTrigger = "manual" | "scheduler";
export type HeartbeatRunMode = "default" | "resume" | "redo";
export type HeartbeatProviderType =
  | "claude_code"
  | "codex"
  | "cursor"
  | "opencode"
  | "gemini_cli"
  | "openai_api"
  | "anthropic_api"
  | "http"
  | "shell";

export type ActiveHeartbeatRun = {
  companyId: string;
  agentId: string;
  abortController: AbortController;
  cancelReason?: string | null;
  cancelRequestedAt?: string | null;
  cancelRequestedBy?: string | null;
};

export type HeartbeatWakeContext = {
  reason?: string | null;
  commentId?: string | null;
  commentBody?: string | null;
  issueIds?: string[];
};

export type RunDigestSignal = {
  sequence: number;
  kind: "system" | "assistant" | "thinking" | "tool_call" | "tool_result" | "result" | "stderr";
  label: string | null;
  text: string | null;
  payload: string | null;
  signalLevel: "high" | "medium" | "low" | "noise";
  groupKey: string | null;
  source: "stdout" | "stderr" | "trace_fallback";
};

export type RunDigest = {
  status: "completed" | "failed" | "skipped";
  headline: string;
  summary: string;
  successes: string[];
  failures: string[];
  blockers: string[];
  nextAction: string;
  evidence: {
    transcriptSignalCount: number;
    outcomeActionCount: number;
    outcomeBlockerCount: number;
    failureType: string | null;
  };
};

export type RunTerminalPresentation = {
  internalStatus: "completed" | "failed" | "skipped";
  publicStatus: "completed" | "failed";
  completionReason: RunCompletionReason;
};

export type HeartbeatIdlePolicy = "full" | "skip_adapter" | "micro_prompt";
