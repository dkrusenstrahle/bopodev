import type { ExecutionOutcome, ProviderType } from "bopodev-contracts";

export type AgentProviderType = ProviderType;

export interface AgentWorkItem {
  issueId: string;
  projectId: string;
  projectName?: string | null;
  title: string;
  body?: string | null;
  status?: string;
  priority?: string;
  labels?: string[];
  tags?: string[];
  attachments?: Array<{
    id: string;
    fileName: string;
    mimeType?: string | null;
    fileSizeBytes: number;
    relativePath: string;
    absolutePath: string;
  }>;
}

export interface AgentState {
  sessionId?: string;
  cwd?: string;
  cursorSession?: {
    sessionId: string;
    cwd?: string;
  };
  metadata?: Record<string, unknown>;
}

export interface AgentMemoryContext {
  memoryRoot: string;
  tacitNotes?: string;
  durableFacts: string[];
  dailyNotes: string[];
}

export interface HeartbeatContext {
  companyId: string;
  agentId: string;
  providerType: AgentProviderType;
  heartbeatRunId: string;
  company: {
    name: string;
    mission?: string | null;
  };
  agent: {
    name: string;
    role: string;
    managerAgentId?: string | null;
  };
  workItems: AgentWorkItem[];
  goalContext?: {
    companyGoals: string[];
    projectGoals: string[];
    agentGoals: string[];
  };
  state: AgentState;
  memoryContext?: AgentMemoryContext;
  runtime?: AgentRuntimeConfig;
  wakeContext?: {
    reason?: string | null;
    commentId?: string | null;
    commentBody?: string | null;
    issueIds?: string[];
  };
}

/**
 * Normalized usage contract produced by adapter execution.
 *
 * Invariants:
 * - `inputTokens` excludes cache reads.
 * - `cachedInputTokens` tracks cache-hit prompt tokens only.
 * - persisted `tokenInput` = `inputTokens + cachedInputTokens` for backwards compatibility.
 * - `outputTokens` reflects generated/completion tokens.
 */
export interface AdapterNormalizedUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  costUsd?: number;
  summary?: string;
}

export interface AdapterExecutionResult {
  status: "ok" | "skipped" | "failed";
  summary: string;
  tokenInput: number;
  tokenOutput: number;
  usdCost: number;
  usage?: AdapterNormalizedUsage;
  pricingProviderType?: string | null;
  pricingModelId?: string | null;
  outcome?: ExecutionOutcome;
  nextState?: AgentState;
  trace?: AdapterTrace;
}

export interface AgentAdapter {
  providerType: AgentProviderType;
  execute(context: HeartbeatContext): Promise<AdapterExecutionResult>;
}

export interface AdapterSessionCodec {
  deserialize(raw: unknown): Record<string, unknown> | null;
  serialize(params: Record<string, unknown> | null): Record<string, unknown> | null;
  getDisplayId?(params: Record<string, unknown> | null): string | null;
}

export type AdapterEnvironmentCheckLevel = "info" | "warn" | "error";
export type AdapterEnvironmentStatus = "pass" | "warn" | "fail";

export interface AdapterEnvironmentCheck {
  code: string;
  level: AdapterEnvironmentCheckLevel;
  message: string;
  detail?: string;
  hint?: string;
}

export interface AdapterEnvironmentResult {
  providerType: AgentProviderType;
  status: AdapterEnvironmentStatus;
  testedAt: string;
  checks: AdapterEnvironmentCheck[];
}

export interface AdapterModelOption {
  id: string;
  label: string;
}

export interface AdapterMetadata {
  providerType: AgentProviderType;
  label: string;
  supportsModelSelection: boolean;
  supportsEnvironmentTest: boolean;
  supportsWebSearch: boolean;
  supportsThinkingEffort: boolean;
  requiresRuntimeCwd: boolean;
}

export interface ServerAdapterModule {
  type: AgentProviderType;
  execute(context: HeartbeatContext): Promise<AdapterExecutionResult>;
  listModels?(runtime?: AgentRuntimeConfig): Promise<AdapterModelOption[]>;
  testEnvironment?(runtime?: AgentRuntimeConfig): Promise<AdapterEnvironmentResult>;
  sessionCodec?: AdapterSessionCodec;
}

export interface UIAdapterModule {
  type: AgentProviderType;
  parseStdoutLine?: (line: string, timestampIso: string) => Array<Record<string, unknown>>;
  buildAdapterConfig?: (values: Record<string, unknown>) => Record<string, unknown>;
}

export interface CLIAdapterModule {
  type: AgentProviderType;
  formatStdoutEvent?: (line: string, debug: boolean) => void;
}

export interface AdapterModule {
  type: AgentProviderType;
  label: string;
  metadata: AdapterMetadata;
  models?: AdapterModelOption[];
  agentConfigurationDoc?: string;
  server: ServerAdapterModule;
  ui?: UIAdapterModule;
  cli?: CLIAdapterModule;
}

export interface AgentRuntimeConfig {
  command?: string;
  args?: string[];
  cwd?: string;
  timeoutMs?: number;
  abortSignal?: AbortSignal;
  interruptGraceSec?: number;
  retryCount?: number;
  retryBackoffMs?: number;
  env?: Record<string, string>;
  model?: string;
  thinkingEffort?: "auto" | "low" | "medium" | "high";
  bootstrapPrompt?: string;
  runPolicy?: {
    sandboxMode?: "workspace_write" | "full_access";
    allowWebSearch?: boolean;
  };
  onTranscriptEvent?: (event: {
    kind: "system" | "assistant" | "thinking" | "tool_call" | "tool_result" | "result" | "stderr";
    label?: string;
    text?: string;
    payload?: string;
    signalLevel?: "high" | "medium" | "low" | "noise";
    groupKey?: string;
    source?: "stdout" | "stderr" | "trace_fallback";
  }) => void;
}

export interface AdapterTrace {
  command?: string;
  args?: string[];
  cwd?: string;
  exitCode?: number | null;
  elapsedMs?: number;
  timedOut?: boolean;
  failureType?: string;
  timeoutSource?: "runtime" | "watchdog" | null;
  usageSource?: "structured" | "none" | "unknown";
  attemptCount?: number;
  attempts?: Array<{
    attempt: number;
    code: number | null;
    timedOut: boolean;
    elapsedMs: number;
    signal: NodeJS.Signals | null;
    spawnErrorCode?: string;
    forcedKill: boolean;
  }>;
  stdoutPreview?: string;
  stderrPreview?: string;
  session?: {
    currentSessionId?: string | null;
    resumedSessionId?: string | null;
    resumeAttempted?: boolean;
    resumeSkippedReason?: string | null;
    clearedStaleSession?: boolean;
  };
  structuredOutputSource?: "stdout" | "stderr";
  structuredOutputDiagnostics?: {
    stdoutJsonObjectCount: number;
    stderrJsonObjectCount: number;
    stderrStructuredUsageDetected: boolean;
    stdoutBytes: number;
    stderrBytes: number;
    hasAnyOutput: boolean;
    lastStdoutLine?: string;
    lastStderrLine?: string;
    likelyCause:
      | "no_output_from_runtime"
      | "json_missing"
      | "json_on_stderr_only"
      | "schema_or_shape_mismatch";
    claudeStopReason?: string;
    claudeResultSubtype?: string;
    claudeSessionId?: string;
    cursorSessionId?: string;
    cursorErrorMessage?: string;
    geminiSessionId?: string;
    claudeContract?: {
      commandOverride: boolean;
      commandLooksClaude: boolean;
      commandWasProviderAlias: boolean;
      hasPromptFlag: boolean;
      hasOutputFormatJson: boolean;
      outputFormat: string | null;
      hasMaxTurnsFlag: boolean;
      hasVerboseFlag: boolean;
      hasDangerouslySkipPermissions: boolean;
      hasJsonSchema: boolean;
      missingRequiredArgs: string[];
    };
  };
  transcript?: Array<{
    kind: "system" | "assistant" | "thinking" | "tool_call" | "tool_result" | "result" | "stderr";
    label?: string;
    text?: string;
    payload?: string;
  }>;
}
