"use client";

import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { AGENT_ROLE_KEYS, AGENT_ROLE_LABELS, type AgentRoleKey } from "bopodev-contracts";
import { ApiError, apiDelete, apiGet, apiPost, apiPut } from "@/lib/api";
import { formatArgsInput, formatEnvInput, parseArgsInput, parseEnvInput } from "@/lib/agent-config-form";
import { agentDefaultsStorageKey, readAgentRuntimeDefaults } from "@/lib/agent-defaults";
import {
  heartbeatCronToIntervalSec,
  heartbeatIntervalSecToCron
} from "@/lib/agent-runtime-options";
import {
  buildRegistryModelOptions,
  getDefaultModelForProvider,
  getRegistryModelValuesForRuntimeProvider,
  type ModelRegistryRow
} from "@/lib/model-registry-options";
import { showThinkingEffortControlForProvider } from "@/lib/provider-runtime-ui";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger
} from "@/components/ui/dialog";
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import styles from "./create-agent-modal.module.scss";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select";

type RuntimePreflightResponse = {
  status: "pass" | "warn" | "fail";
  testedAt: string;
  checks: Array<{
    code: string;
    level: "info" | "warn" | "error";
    message: string;
    detail?: string;
    hint?: string;
  }>;
};

type ProviderType =
  | "claude_code"
  | "codex"
  | "cursor"
  | "opencode"
  | "gemini_cli"
  | "openai_api"
  | "anthropic_api"
  | "http"
  | "shell";

type AdapterMetadataResponse = {
  adapters: Array<{
    providerType: ProviderType;
    label: string;
    supportsModelSelection: boolean;
    supportsEnvironmentTest: boolean;
    supportsWebSearch: boolean;
    supportsThinkingEffort: boolean;
    requiresRuntimeCwd: boolean;
  }>;
};

type ProviderOption = {
  providerType: ProviderType;
  label: string;
};

type ProjectOption = {
  id: string;
  name: string;
};

const EDIT_AGENT_VISIBLE_PROVIDER_TYPES: ProviderType[] = ["claude_code", "codex", "opencode", "gemini_cli"];

const defaultVisibleProviders: ProviderOption[] = [
  { providerType: "claude_code", label: "Claude Code" },
  { providerType: "codex", label: "Codex" },
  { providerType: "opencode", label: "OpenCode" },
  { providerType: "gemini_cli", label: "Gemini CLI" }
];

function normalizeRoleKey(roleKey: AgentRoleKey | null | undefined, legacyRole: string | null | undefined): AgentRoleKey {
  if (roleKey && AGENT_ROLE_KEYS.includes(roleKey)) {
    return roleKey;
  }
  const normalizedLegacy = legacyRole?.trim().toLowerCase();
  if (!normalizedLegacy) {
    return "general";
  }
  const match = AGENT_ROLE_KEYS.find(
    (key) => key === normalizedLegacy || AGENT_ROLE_LABELS[key].toLowerCase() === normalizedLegacy
  );
  return match ?? "general";
}

export function CreateAgentModal({
  companyId,
  agent,
  availableAgents,
  projects,
  delegateAgentId,
  delegateAgentLabel,
  suggestedRuntimeCwd,
  fallbackDefaults,
  triggerLabel,
  triggerVariant = "default",
  triggerSize = "sm",
  open,
  onOpenChange,
  hideTrigger = false
}: {
  companyId: string;
  agent?: {
    id: string;
    name: string;
    role: string;
    roleKey?: AgentRoleKey | null;
    title?: string | null;
    managerAgentId?: string | null;
    providerType: ProviderType;
    heartbeatCron?: string;
    monthlyBudgetUsd?: number;
    canHireAgents?: boolean;
    runtimeCommand?: string | null;
    runtimeArgsJson?: string | null;
    runtimeCwd?: string | null;
    runtimeEnvJson?: string | null;
    runtimeModel?: string | null;
    runtimeThinkingEffort?: "auto" | "low" | "medium" | "high" | null;
    bootstrapPrompt?: string | null;
    runtimeTimeoutSec?: number | null;
    interruptGraceSec?: number | null;
    runPolicyJson?: string | null;
    stateBlob?: string;
  };
  availableAgents?: Array<{ id: string; name: string }>;
  projects?: ProjectOption[];
  delegateAgentId?: string | null;
  delegateAgentLabel?: string;
  suggestedRuntimeCwd?: string | null;
  fallbackDefaults?: {
    providerType?: ProviderType | null;
    runtimeModel?: string | null;
  };
  triggerLabel?: string;
  triggerVariant?: "default" | "outline" | "secondary" | "ghost" | "destructive";
  triggerSize?: "default" | "sm" | "lg" | "icon";
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  hideTrigger?: boolean;
}) {
  const router = useRouter();
  const [internalOpen, setInternalOpen] = useState(false);
  const dialogOpen = open ?? internalOpen;
  const setDialogOpen = (nextOpen: boolean) => {
    if (open === undefined) {
      setInternalOpen(nextOpen);
    }
    onOpenChange?.(nextOpen);
  };
  const [name, setName] = useState(agent?.name ?? "");
  const [roleKey, setRoleKey] = useState<AgentRoleKey>(normalizeRoleKey(agent?.roleKey, agent?.role));
  const [title, setTitle] = useState(agent?.title ?? "");
  const [managerAgentId, setManagerAgentId] = useState<string | null>(agent?.managerAgentId ?? null);
  const [budget, setBudget] = useState(agent?.monthlyBudgetUsd?.toString() ?? "30");
  const [providerType, setProviderType] = useState<ProviderType>(agent?.providerType ?? "claude_code");
  const [heartbeatIntervalSec, setHeartbeatIntervalSec] = useState(
    String(heartbeatCronToIntervalSec(agent?.heartbeatCron, 300))
  );
  const [canHireAgents, setCanHireAgents] = useState(agent?.canHireAgents ?? false);
  const [runtimeCommand, setRuntimeCommand] = useState("");
  const [runtimeArgs, setRuntimeArgs] = useState("");
  const [runtimeCwd, setRuntimeCwd] = useState("");
  const [runtimeModel, setRuntimeModel] = useState("");
  const [runtimeThinkingEffort, setRuntimeThinkingEffort] = useState<"auto" | "low" | "medium" | "high">("auto");
  const [bootstrapPrompt, setBootstrapPrompt] = useState("");
  const [runtimeEnv, setRuntimeEnv] = useState("");
  const [runtimeTimeoutSec, setRuntimeTimeoutSec] = useState("0");
  const [interruptGraceSec, setInterruptGraceSec] = useState("15");
  const [sandboxMode, setSandboxMode] = useState<"workspace_write" | "full_access">("workspace_write");
  const [allowWebSearch, setAllowWebSearch] = useState(false);
  const isEditing = Boolean(agent);
  const [creationMode, setCreationMode] = useState<"intro" | "delegate" | "advanced">(isEditing ? "advanced" : "intro");
  const [delegateProjectId, setDelegateProjectId] = useState("");
  const [delegateRequest, setDelegateRequest] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [adapterMetadataByProvider, setAdapterMetadataByProvider] = useState<
    Partial<
      Record<
        ProviderType,
        AdapterMetadataResponse["adapters"][number]
      >
    >
  >({});
  const [modelRegistryRows, setModelRegistryRows] = useState<ModelRegistryRow[]>([]);
  const providerMetadata = adapterMetadataByProvider[providerType];
  const visibleProviders: ProviderOption[] = (
    Object.values(adapterMetadataByProvider).filter(Boolean).length > 0
      ? Object.values(adapterMetadataByProvider)
          .filter((adapter): adapter is NonNullable<typeof adapter> => Boolean(adapter))
          .filter((adapter) => EDIT_AGENT_VISIBLE_PROVIDER_TYPES.includes(adapter.providerType))
          .map((adapter) => ({ providerType: adapter.providerType, label: adapter.label }))
          .sort((a, b) => a.label.localeCompare(b.label))
      : defaultVisibleProviders
  ).concat(
    providerType && !EDIT_AGENT_VISIBLE_PROVIDER_TYPES.includes(providerType)
      ? [{ providerType, label: adapterMetadataByProvider[providerType]?.label ?? providerType }]
      : []
  );
  const runtimeCwdRequired = providerMetadata?.requiresRuntimeCwd ?? (
    providerType === "codex" ||
    providerType === "claude_code" ||
    providerType === "cursor" ||
    providerType === "opencode" ||
    providerType === "shell"
  );
  const modelOptions = useMemo(
    () =>
      buildRegistryModelOptions({
        rows: modelRegistryRows,
        providerType,
        currentModel: runtimeModel,
        includeDefault: false
      }),
    [modelRegistryRows, providerType, runtimeModel]
  );
  const visibleModelOptions = providerType === "opencode" ? modelOptions.filter((option) => option.value.trim().length > 0) : modelOptions;
  const providerSupportsWebSearch = providerMetadata?.supportsWebSearch ?? providerType === "codex";
  const sandboxPermissionLabel = providerType === "claude_code" ? "Skip permissions" : "Bypass approvals and sandbox";
  const managerOptions = useMemo(() => {
    return (availableAgents ?? [])
      .filter((candidate) => candidate.id !== agent?.id)
      .sort((a, b) => {
        const nameCmp = a.name.localeCompare(b.name);
        if (nameCmp !== 0) {
          return nameCmp;
        }
        return a.id.localeCompare(b.id);
      });
  }, [availableAgents, agent?.id]);

  function parseHeartbeatIntervalSeconds(value: string) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 60) {
      throw new Error("Heartbeat interval must be at least 60 seconds.");
    }
    return Math.floor(parsed);
  }

  function findInvalidEnvLines(input: string) {
    return input
      .split(/\r?\n/)
      .map((rawLine, index) => ({ line: rawLine.trim(), lineNumber: index + 1 }))
      .filter(({ line }) => line.length > 0 && !line.startsWith("#"))
      .filter(({ line }) => line.indexOf("=") < 1)
      .map(({ lineNumber }) => lineNumber);
  }

  function normalizeRuntimeEnvInput(input: string) {
    const lines = input.split(/\r?\n/);
    const nonCommentEntries = lines
      .map((rawLine, index) => ({ rawLine, line: rawLine.trim(), index }))
      .filter(({ line }) => line.length > 0 && !line.startsWith("#"));
    const hasOpenAiKey = nonCommentEntries.some(({ line }) => line.startsWith("OPENAI_API_KEY="));
    if (hasOpenAiKey || nonCommentEntries.length !== 1) {
      return input;
    }
    const [onlyEntry] = nonCommentEntries;
    if (!onlyEntry || onlyEntry.line.includes("=") || !onlyEntry.line.startsWith("sk-")) {
      return input;
    }
    const normalized = [...lines];
    normalized[onlyEntry.index] = `OPENAI_API_KEY=${onlyEntry.line}`;
    return normalized.join("\n");
  }

  function parseRuntimeState(rawStateBlob: string | undefined) {
    if (!rawStateBlob) {
      return {
        command: "",
        args: "",
        cwd: "",
        env: "",
        model: "",
        thinkingEffort: "auto" as const,
        bootstrapPrompt: "",
        timeoutSec: "0",
        interruptGraceSec: "15",
        sandboxMode: "workspace_write" as const,
        allowWebSearch: false
      };
    }
    try {
      const parsed = JSON.parse(rawStateBlob) as {
        runtime?: {
          command?: string;
          args?: string[];
          cwd?: string;
          env?: Record<string, string>;
          timeoutMs?: number;
          model?: string;
          thinkingEffort?: "auto" | "low" | "medium" | "high";
          interruptGraceSec?: number;
          runPolicy?: { sandboxMode?: "workspace_write" | "full_access"; allowWebSearch?: boolean };
        };
        promptTemplate?: string;
      };
      return {
        command: parsed.runtime?.command ?? "",
        args: formatArgsInput(parsed.runtime?.args),
        cwd: parsed.runtime?.cwd ?? "",
        env: formatEnvInput(parsed.runtime?.env),
        model: parsed.runtime?.model ?? "",
        thinkingEffort: parsed.runtime?.thinkingEffort ?? "auto",
        bootstrapPrompt: parsed.promptTemplate ?? "",
        timeoutSec:
          typeof parsed.runtime?.timeoutMs === "number" && parsed.runtime.timeoutMs > 0
            ? String(Math.floor(parsed.runtime.timeoutMs / 1000))
            : "0",
        interruptGraceSec: parsed.runtime?.interruptGraceSec ? String(parsed.runtime.interruptGraceSec) : "15",
        sandboxMode: parsed.runtime?.runPolicy?.sandboxMode === "full_access" ? "full_access" : "workspace_write",
        allowWebSearch: Boolean(parsed.runtime?.runPolicy?.allowWebSearch)
      };
    } catch {
      return {
        command: "",
        args: "",
        cwd: "",
        env: "",
        model: "",
        thinkingEffort: "auto",
        bootstrapPrompt: "",
        timeoutSec: "0",
        interruptGraceSec: "15",
        sandboxMode: "workspace_write",
        allowWebSearch: false
      };
    }
  }

  function isProviderType(value: unknown): value is ProviderType {
    return (
      value === "claude_code" ||
      value === "codex" ||
      value === "cursor" ||
      value === "opencode" ||
      value === "openai_api" ||
      value === "anthropic_api" ||
      value === "http" ||
      value === "shell"
    );
  }

  useEffect(() => {
    if (!open) {
      return;
    }
    if (isEditing && agent) {
      const runtime = parseRuntimeState(agent.stateBlob);
      const runtimeArgs = (() => {
        if (typeof agent.runtimeArgsJson === "string" && agent.runtimeArgsJson.trim()) {
          try {
            const parsed = JSON.parse(agent.runtimeArgsJson) as unknown;
            return Array.isArray(parsed) ? formatArgsInput(parsed.map((value) => String(value))) : runtime.args;
          } catch {
            return runtime.args;
          }
        }
        return runtime.args;
      })();
      const runtimeEnv = (() => {
        if (typeof agent.runtimeEnvJson === "string" && agent.runtimeEnvJson.trim()) {
          try {
            const parsed = JSON.parse(agent.runtimeEnvJson) as Record<string, unknown>;
            return formatEnvInput(
              Object.fromEntries(
                Object.entries(parsed).filter(([, value]) => typeof value === "string")
              ) as Record<string, string>
            );
          } catch {
            return runtime.env;
          }
        }
        return runtime.env;
      })();
      const runPolicy = (() => {
        if (typeof agent.runPolicyJson === "string" && agent.runPolicyJson.trim()) {
          try {
            const parsed = JSON.parse(agent.runPolicyJson) as { sandboxMode?: unknown; allowWebSearch?: unknown };
            return {
              sandboxMode: parsed.sandboxMode === "full_access" ? "full_access" : "workspace_write",
              allowWebSearch: Boolean(parsed.allowWebSearch)
            } as const;
          } catch {
            return { sandboxMode: runtime.sandboxMode, allowWebSearch: runtime.allowWebSearch } as const;
          }
        }
        return { sandboxMode: runtime.sandboxMode, allowWebSearch: runtime.allowWebSearch } as const;
      })();
      setName(agent.name);
      setRoleKey(normalizeRoleKey(agent.roleKey, agent.role));
      setTitle(agent.title ?? "");
      setManagerAgentId(agent.managerAgentId ?? null);
      setProviderType(agent.providerType);
      setHeartbeatIntervalSec(String(heartbeatCronToIntervalSec(agent.heartbeatCron, 300)));
      setBudget(agent.monthlyBudgetUsd?.toString() ?? "30");
      setCanHireAgents(agent.canHireAgents ?? false);
      setRuntimeCommand(agent.runtimeCommand ?? runtime.command);
      setRuntimeArgs(runtimeArgs);
      setRuntimeCwd(agent.runtimeCwd ?? runtime.cwd);
      setRuntimeModel(agent.runtimeModel ?? runtime.model);
      setRuntimeThinkingEffort((agent.runtimeThinkingEffort ?? runtime.thinkingEffort) as "auto" | "low" | "medium" | "high");
      setBootstrapPrompt(agent.bootstrapPrompt ?? runtime.bootstrapPrompt);
      setRuntimeEnv(runtimeEnv);
      setRuntimeTimeoutSec(
        typeof agent.runtimeTimeoutSec === "number" ? String(agent.runtimeTimeoutSec) : runtime.timeoutSec
      );
      setInterruptGraceSec(
        typeof agent.interruptGraceSec === "number" ? String(agent.interruptGraceSec) : runtime.interruptGraceSec
      );
      setSandboxMode(runPolicy.sandboxMode as "workspace_write" | "full_access");
      setAllowWebSearch(runPolicy.allowWebSearch);
      setCreationMode("advanced");
      setError(null);
      return;
    }
    const defaults = readAgentRuntimeDefaults();
    const hasStoredDefaults = window.localStorage.getItem(agentDefaultsStorageKey) !== null;
    const effectiveDefaults =
      !hasStoredDefaults && fallbackDefaults
        ? {
            ...defaults,
            providerType: isProviderType(fallbackDefaults.providerType) ? fallbackDefaults.providerType : defaults.providerType,
            runtimeModel: typeof fallbackDefaults.runtimeModel === "string" ? fallbackDefaults.runtimeModel : defaults.runtimeModel
          }
        : defaults;
    setName("");
    setRoleKey("general");
    setTitle("");
    setManagerAgentId(null);
    setProviderType(effectiveDefaults.providerType);
    setHeartbeatIntervalSec(effectiveDefaults.heartbeatIntervalSec);
    setBudget(effectiveDefaults.monthlyBudgetUsd);
    setCanHireAgents(false);
    setRuntimeCommand(effectiveDefaults.runtimeCommand);
    setRuntimeArgs(effectiveDefaults.runtimeArgs);
    const initialRuntimeCwd = effectiveDefaults.runtimeCwd || suggestedRuntimeCwd || "";
    setRuntimeCwd(initialRuntimeCwd);
    setRuntimeModel(effectiveDefaults.runtimeModel);
    setRuntimeThinkingEffort(effectiveDefaults.runtimeThinkingEffort);
    setBootstrapPrompt(effectiveDefaults.bootstrapPrompt);
    setRuntimeEnv(effectiveDefaults.runtimeEnv);
    setRuntimeTimeoutSec(effectiveDefaults.runtimeTimeoutSec);
    setInterruptGraceSec(effectiveDefaults.interruptGraceSec);
    setSandboxMode(effectiveDefaults.sandboxMode);
    setAllowWebSearch(effectiveDefaults.allowWebSearch);
    setCreationMode("intro");
    setDelegateProjectId(projects?.[0]?.id ?? "");
    setDelegateRequest("");
    setError(null);
    if (!initialRuntimeCwd) {
      void apiGet<{ runtimeCwd: string }>("/agents/runtime-default-cwd", companyId)
        .then((result) => {
          setRuntimeCwd((current) => current || result.data.runtimeCwd || "");
        })
        .catch(() => {
          // Silent fallback: keep field empty when suggestion lookup fails.
        });
    }
  }, [open, isEditing, agent, suggestedRuntimeCwd, companyId, fallbackDefaults, projects]);

  useEffect(() => {
    if (!open) {
      return;
    }
    void apiGet<AdapterMetadataResponse>("/agents/adapter-metadata", companyId)
      .then((result) => {
        setAdapterMetadataByProvider(
          Object.fromEntries(result.data.adapters.map((adapter) => [adapter.providerType, adapter]))
        );
      })
      .catch(() => {
        // Fall back to local defaults if metadata endpoint fails.
      });
  }, [open, companyId]);

  useEffect(() => {
    if (!open) {
      return;
    }
    void apiGet<Array<ModelRegistryRow>>("/observability/models/pricing", companyId)
      .then((result) => {
        setModelRegistryRows(result.data);
      })
      .catch(() => {
        setModelRegistryRows([]);
      });
  }, [open, companyId]);

  useEffect(() => {
    if (providerType !== "codex" && allowWebSearch) {
      setAllowWebSearch(false);
    }
  }, [providerType, allowWebSearch]);

  useEffect(() => {
    if (!showThinkingEffortControlForProvider(providerType)) {
      setRuntimeThinkingEffort("auto");
    }
  }, [providerType]);

  useEffect(() => {
    const allowedValues = getRegistryModelValuesForRuntimeProvider(modelRegistryRows, providerType);
    if (runtimeModel && !allowedValues.includes(runtimeModel)) {
      const defaultId = getDefaultModelForProvider(providerType);
      setRuntimeModel(defaultId && allowedValues.includes(defaultId) ? defaultId : allowedValues[0] ?? "");
      return;
    }
    const requiresNamedModel = providerType !== "http" && providerType !== "shell";
    if (requiresNamedModel && !runtimeModel && allowedValues.length > 0) {
      const defaultId = getDefaultModelForProvider(providerType);
      setRuntimeModel(defaultId && allowedValues.includes(defaultId) ? defaultId : allowedValues[0] ?? "");
    }
  }, [modelRegistryRows, providerType, runtimeModel]);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setIsSubmitting(true);
    setError(null);
    try {
      if (!isEditing && creationMode === "intro") {
        setError("Choose whether to ask the CEO or configure the agent yourself.");
        return;
      }
      if (!isEditing && creationMode === "delegate") {
        if (!delegateAgentId) {
          setError("No hiring delegate found. Assign at least one hiring-capable agent first.");
          return;
        }
        if (!delegateProjectId) {
          setError("Select a project for the CEO request.");
          return;
        }
        const requestNotes = delegateRequest.trim();
        const managerName = managerOptions.find((entry) => entry.id === managerAgentId)?.name ?? "No manager";
        const requestedRoleLabel = AGENT_ROLE_LABELS[roleKey];
        const requestedTitle = title.trim();
        const requestedRole = requestedTitle || requestedRoleLabel;
        const requestedName = name.trim();
        const requestedModel = runtimeModel.trim();
        const issueBody = [
          "Please create a new agent with the following profile:",
          "",
          `- Name: ${requestedName || "(decide best fit)"}`,
          `- Role: ${requestedRole}`,
          `- Reports to: ${managerName}`,
          `- Preferred provider: ${providerType}`,
          `- Preferred model: ${requestedModel || "(delegate chooses best model)"}`,
          "",
          "Additional request details:",
          requestNotes || "- None provided."
        ].join("\n");
        await apiPost("/issues", companyId, {
          projectId: delegateProjectId,
          title: `Create a new ${requestedRole} agent`,
          body: issueBody,
          metadata: {
            delegatedHiringIntent: {
              intentType: "agent_hiring_request",
              requestedRole: requestedRole || null,
              requestedRoleKey: roleKey,
              requestedTitle: requestedTitle || null,
              requestedName: requestedName || null,
              requestedManagerAgentId: managerAgentId ?? null,
              requestedProviderType: providerType,
              requestedRuntimeModel: requestedModel || null
            }
          },
          status: "todo",
          assigneeAgentId: delegateAgentId,
          labels: ["agent-hiring", "delegated"]
        });
        setDialogOpen(false);
        router.refresh();
        return;
      }
      const normalizedRuntimeEnv = normalizeRuntimeEnvInput(runtimeEnv);
      if (normalizedRuntimeEnv !== runtimeEnv) {
        setRuntimeEnv(normalizedRuntimeEnv);
      }
      const invalidEnvLines = findInvalidEnvLines(normalizedRuntimeEnv);
      if (invalidEnvLines.length > 0) {
        setError(`Environment variables must use KEY=value format. Fix line(s): ${invalidEnvLines.join(", ")}.`);
        return;
      }
      const heartbeatIntervalSeconds = parseHeartbeatIntervalSeconds(heartbeatIntervalSec);
      const parsedRuntimeArgs = parseArgsInput(runtimeArgs);
      const parsedRuntimeEnv = parseEnvInput(normalizedRuntimeEnv);
      const runtimeConfig = {
        runtimeCommand: runtimeCommand || undefined,
        runtimeArgs: parsedRuntimeArgs,
        runtimeCwd: runtimeCwd || undefined,
        runtimeEnv: parsedRuntimeEnv,
        runtimeModel: runtimeModel || undefined,
        runtimeThinkingEffort,
        bootstrapPrompt: bootstrapPrompt || undefined,
        runtimeTimeoutSec: Number(runtimeTimeoutSec || "0"),
        interruptGraceSec: Number(interruptGraceSec || "15"),
        runPolicy: {
          sandboxMode,
          allowWebSearch
        }
      };

      if (providerType === "opencode") {
        const normalizedModel = runtimeModel.trim();
        if (!normalizedModel || !/^[^/\s]+\/[^/\s]+$/.test(normalizedModel)) {
          setError("OpenCode model is required and must use provider/model format (for example: openai/gpt-5).");
          return;
        }
      } else if (providerType !== "http" && providerType !== "shell" && !runtimeModel.trim()) {
        setError("Select a named model before saving this agent.");
        return;
      }

      const shouldRunPreflight = providerMetadata?.supportsEnvironmentTest ?? providerType !== "http";
      if (shouldRunPreflight) {
        const preflight = await apiPost<RuntimePreflightResponse>("/agents/runtime-preflight", companyId, {
          providerType,
          runtimeConfig
        });
        const result = preflight.data;
        if (result.status !== "pass") {
          const actionable =
            result.checks.find((check) => check.level === "error") ??
            result.checks.find((check) => check.level === "warn");
          if (actionable) {
            setError(
              `${actionable.message}${actionable.hint ? ` ${actionable.hint}` : ""}${
                actionable.detail ? ` (${actionable.detail})` : ""
              }`
            );
          } else {
            setError("Runtime preflight did not pass. Please retry after fixing runtime configuration.");
          }
          return;
        }
      }

      if (isEditing && agent) {
        await apiPut(`/agents/${agent.id}`, companyId, {
          name,
          role: title.trim() || AGENT_ROLE_LABELS[roleKey],
          roleKey,
          title: title.trim() || null,
          managerAgentId: managerAgentId ?? null,
          providerType,
          heartbeatCron: heartbeatIntervalSecToCron(heartbeatIntervalSeconds),
          monthlyBudgetUsd: Number(budget),
          canHireAgents,
          runtimeConfig
        });
      } else {
        await apiPost("/agents", companyId, {
          name,
          role: title.trim() || AGENT_ROLE_LABELS[roleKey],
          roleKey,
          title: title.trim() || null,
          managerAgentId: managerAgentId ?? undefined,
          providerType,
          heartbeatCron: heartbeatIntervalSecToCron(heartbeatIntervalSeconds),
          monthlyBudgetUsd: Number(budget),
          canHireAgents,
          requestApproval: true,
          runtimeConfig
        });
      }
      setDialogOpen(false);
      router.refresh();
    } catch (submitError) {
      if (submitError instanceof ApiError) {
        setError(submitError.message);
      } else {
        setError(isEditing ? "Failed to update agent." : "Failed to hire agent.");
      }
    } finally {
      setIsSubmitting(false);
    }
  }

  async function onDeleteAgent() {
    if (!agent) {
      return;
    }
    setError(null);
    setIsDeleting(true);
    try {
      await apiDelete(`/agents/${agent.id}`, companyId);
      setDialogOpen(false);
      router.push(`/agents?companyId=${companyId}` as Parameters<typeof router.push>[0]);
    } catch (deleteError) {
      if (deleteError instanceof ApiError) {
        setError(deleteError.message);
      } else {
        setError("Failed to delete agent.");
      }
    } finally {
      setIsDeleting(false);
    }
  }

  return (
    <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
      {!hideTrigger ? (
        <DialogTrigger asChild>
          <Button variant={triggerVariant} size={triggerSize}>
            {triggerLabel ?? (isEditing ? "Edit" : "Hire Agent")}
          </Button>
        </DialogTrigger>
      ) : null}
      <DialogContent className={styles.createAgentModalDialogContent}>
        <DialogHeader>
          <DialogTitle>{isEditing ? "Edit agent" : "Hire AI agent"}</DialogTitle>
          <DialogDescription>
            {isEditing ? "Update the full agent configuration from one dialog." : "Hiring is routed through governance approvals by default."}
          </DialogDescription>
        </DialogHeader>
        <form className={styles.createAgentModalForm} onSubmit={onSubmit}>
          <div className="ui-dialog-content-scrollable">
            {!isEditing && creationMode === "intro" ? (
              <section className={styles.createAgentModalSection}>
                <p className={styles.createAgentModalSectionDescription}>
                  It's recommended to use {delegateAgentLabel ?? "your leadership agent"} to handle setup. They have the full context of the company and can create the agent with the correct configuration.
                </p>
                <Button
                  type="button"
                  onClick={() => {
                    setCreationMode("delegate");
                    setError(null);
                  }}
                >
                  {delegateAgentLabel ? `Tell ${delegateAgentLabel} to create the agent` : "Ask leadership to create the agent"}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => {
                    setCreationMode("advanced");
                    setError(null);
                  }}
                >
                  I'll configure the agent instead
                </Button>
              </section>
            ) : null}
            {!isEditing && creationMode === "delegate" ? (
              <section className={styles.createAgentModalSection}>
                <FieldGroup>
                  <Field>
                    <FieldLabel>Project</FieldLabel>
                    <Select value={delegateProjectId} onValueChange={setDelegateProjectId}>
                      <SelectTrigger className={styles.createAgentModalSelectTrigger}>
                        <SelectValue placeholder="Select a project" />
                      </SelectTrigger>
                      <SelectContent>
                        {(projects ?? []).map((project) => (
                          <SelectItem key={project.id} value={project.id}>
                            {project.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {(projects ?? []).length === 0 ? (
                      <FieldDescription>Create a project first so delegation requests have a destination.</FieldDescription>
                    ) : null}
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="agent-name">Requested agent name</FieldLabel>
                    <Input id="agent-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Ada" />
                  </Field>
                  <Field>
                    <FieldLabel>Requested role</FieldLabel>
                    <Select value={roleKey} onValueChange={(value) => setRoleKey(value as AgentRoleKey)}>
                      <SelectTrigger className={styles.createAgentModalSelectTrigger}>
                        <SelectValue placeholder="Select a role" />
                      </SelectTrigger>
                      <SelectContent>
                        {AGENT_ROLE_KEYS.map((value) => (
                          <SelectItem key={value} value={value}>
                            {AGENT_ROLE_LABELS[value]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="agent-title">Requested title (optional)</FieldLabel>
                    <Input
                      id="agent-title"
                      value={title}
                      onChange={(e) => setTitle(e.target.value)}
                      placeholder={`${AGENT_ROLE_LABELS[roleKey]} (default)`}
                    />
                  </Field>
                  <Field>
                    <FieldLabel>Reports to</FieldLabel>
                    <Select value={managerAgentId ?? "__none"} onValueChange={(value) => setManagerAgentId(value === "__none" ? null : value)}>
                      <SelectTrigger className={styles.createAgentModalSelectTrigger}>
                        <SelectValue placeholder="No manager (top level)" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__none">No manager</SelectItem>
                        {managerOptions.map((entry) => (
                          <SelectItem key={entry.id} value={entry.id}>
                            {entry.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="delegate-request-notes">Request details</FieldLabel>
                    <Textarea
                      id="delegate-request-notes"
                      value={delegateRequest}
                      onChange={(e) => setDelegateRequest(e.target.value)}
                      placeholder="Describe what kind of agent you want and any constraints."
                    />
                  </Field>
                </FieldGroup>
              </section>
            ) : null}
            {isEditing || creationMode === "advanced" ? (
              <>
            <section className={styles.createAgentModalSection}>
              <FieldGroup className={styles.createAgentModalFieldGroup}>
                <Field>
                  <FieldLabel htmlFor="agent-name">Agent name</FieldLabel>
                  <Input id="agent-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Ada" required />
                </Field>
                <Field>
                  <FieldLabel>Role</FieldLabel>
                  <Select value={roleKey} onValueChange={(value) => setRoleKey(value as AgentRoleKey)}>
                    <SelectTrigger className={styles.createAgentModalSelectTrigger}>
                      <SelectValue placeholder="Select a role" />
                    </SelectTrigger>
                    <SelectContent>
                      {AGENT_ROLE_KEYS.map((value) => (
                        <SelectItem key={value} value={value}>
                          {AGENT_ROLE_LABELS[value]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                <Field>
                  <FieldLabel htmlFor="agent-title">Title (optional)</FieldLabel>
                  <Input
                    id="agent-title"
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder={`${AGENT_ROLE_LABELS[roleKey]} (default)`}
                  />
                </Field>
                <Field>
                  <FieldLabel>Reports to</FieldLabel>
                  <Select
                    value={managerAgentId ?? "__none"}
                    onValueChange={(value) => setManagerAgentId(value === "__none" ? null : value)}>
                    <SelectTrigger className={styles.createAgentModalSelectTrigger}>
                      <SelectValue placeholder="No manager (top level)" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none">No manager</SelectItem>
                      {managerOptions.map((entry) => (
                        <SelectItem key={entry.id} value={entry.id}>
                          {entry.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
              </FieldGroup>
            </section>

            <section className={styles.createAgentModalSection}>
              <FieldGroup className={styles.createAgentModalFieldGroup}>
                <Field>
                  <FieldLabel>Provider</FieldLabel>
                  <Select
                    value={providerType}
                    onValueChange={(value) =>
                      setProviderType(value as ProviderType)
                    }
                  >
                    <SelectTrigger className={styles.createAgentModalSelectTrigger}>
                      <SelectValue placeholder="Select a provider" />
                    </SelectTrigger>
                    <SelectContent>
                      {visibleProviders.map((adapter) => (
                        <SelectItem key={adapter.providerType} value={adapter.providerType}>
                          {adapter.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                <Field>
                  <FieldLabel htmlFor="agent-runtime-model">Model</FieldLabel>
                  <Select
                    value={runtimeModel || undefined}
                    onValueChange={(value) => setRuntimeModel(value)}
                  >
                    <SelectTrigger id="agent-runtime-model" className={styles.createAgentModalSelectTrigger}>
                      <SelectValue placeholder="Select a model" />
                    </SelectTrigger>
                    <SelectContent>
                      {visibleModelOptions.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                <Field>
                  <FieldLabel htmlFor="agent-heartbeat-interval">Heartbeat interval (seconds)</FieldLabel>
                  <Input
                    id="agent-heartbeat-interval"
                    value={heartbeatIntervalSec}
                    onChange={(e) => setHeartbeatIntervalSec(e.target.value)}
                    type="number"
                    min={60}
                    step="1"
                    placeholder="300"
                    required
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="agent-budget">Monthly budget (USD)</FieldLabel>
                  <Input id="agent-budget" value={budget} onChange={(e) => setBudget(e.target.value)} type="number" min={0} step="1" />
                </Field>
              </FieldGroup>
            </section>

            <section className={styles.createAgentModalSection}>
              <FieldGroup className={styles.createAgentModalFieldGroup}>
                <Field>
                  <FieldLabel htmlFor="agent-runtime-command">Command</FieldLabel>
                  <Input
                    id="agent-runtime-command"
                    value={runtimeCommand}
                    onChange={(e) => setRuntimeCommand(e.target.value)}
                    placeholder="codex"
                  />
                </Field>
                {showThinkingEffortControlForProvider(providerType) ? (
                  <Field>
                    <FieldLabel>Thinking effort</FieldLabel>
                    <Select value={runtimeThinkingEffort} onValueChange={(value) => setRuntimeThinkingEffort(value as "auto" | "low" | "medium" | "high")}>
                      <SelectTrigger className={styles.createAgentModalSelectTrigger}>
                        <SelectValue placeholder="Select thinking effort" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="auto">Auto</SelectItem>
                        <SelectItem value="low">Low</SelectItem>
                        <SelectItem value="medium">Medium</SelectItem>
                        <SelectItem value="high">High</SelectItem>
                      </SelectContent>
                    </Select>
                  </Field>
                ) : null}
                <Field>
                  <FieldLabel htmlFor="agent-runtime-args">Extra args</FieldLabel>
                  <Input
                    id="agent-runtime-args"
                    value={runtimeArgs}
                    onChange={(e) => setRuntimeArgs(e.target.value)}
                    placeholder='--verbose --foo "bar baz"'
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="agent-runtime-timeout">Timeout (sec)</FieldLabel>
                  <Input
                    id="agent-runtime-timeout"
                    value={runtimeTimeoutSec}
                    onChange={(e) => setRuntimeTimeoutSec(e.target.value)}
                    type="number"
                    min={0}
                    step="1"
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="agent-interrupt-grace">Interrupt grace period (sec)</FieldLabel>
                  <Input
                    id="agent-interrupt-grace"
                    value={interruptGraceSec}
                    onChange={(e) => setInterruptGraceSec(e.target.value)}
                    type="number"
                    min={0}
                    step="1"
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="agent-runtime-cwd">Runtime working directory</FieldLabel>
                  <Input
                    id="agent-runtime-cwd"
                    value={runtimeCwd}
                    onChange={(e) => setRuntimeCwd(e.target.value)}
                    placeholder="/path/to/workspace"
                    required={runtimeCwdRequired}
                  />
                </Field>
                {providerType === "codex" || providerType === "claude_code" ? (
                  <Field orientation="horizontal">
                    <Checkbox
                      id="agent-skip-permissions"
                      checked={sandboxMode === "full_access"}
                      onCheckedChange={(checked) =>
                        setSandboxMode(Boolean(checked) ? "full_access" : "workspace_write")
                      }
                    />
                    <FieldContent>
                      <FieldLabel htmlFor="agent-skip-permissions">{sandboxPermissionLabel}</FieldLabel>
                    </FieldContent>
                  </Field>
                ) : null}
              </FieldGroup>
              <FieldGroup className={styles.createAgentModalFieldGroup}>
                {providerSupportsWebSearch ? (
                  <Field orientation="horizontal">
                    <Checkbox
                      id="agent-allow-web-search"
                      checked={allowWebSearch}
                      onCheckedChange={(checked) => setAllowWebSearch(Boolean(checked))}
                    />
                    <FieldContent>
                      <FieldLabel htmlFor="agent-allow-web-search">Enable web search</FieldLabel>
                    </FieldContent>
                  </Field>
                ) : null}
                <Field orientation="horizontal">
                  <Checkbox
                    id="agent-can-hire"
                    checked={canHireAgents}
                    onCheckedChange={(checked) => setCanHireAgents(Boolean(checked))}
                  />
                  <FieldContent>
                    <FieldLabel htmlFor="agent-can-hire">Can create new agents</FieldLabel>
                  </FieldContent>
                </Field>
              </FieldGroup>
              </section>
              <section className={styles.createAgentModalSection}>
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="agent-bootstrap-prompt">Bootstrap prompt (first run)</FieldLabel>
                  <Textarea
                    id="agent-bootstrap-prompt"
                    value={bootstrapPrompt}
                    onChange={(e) => setBootstrapPrompt(e.target.value)}
                    placeholder="Optional initial setup prompt for the first run"
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="agent-runtime-env">Environment variables</FieldLabel>
                  <Textarea
                    id="agent-runtime-env"
                    className={styles.createAgentModalEnvTextarea}
                    rows={4}
                    wrap="hard"
                    value={runtimeEnv}
                    onChange={(e) => setRuntimeEnv(e.target.value)}
                    placeholder={"KEY=value\nANOTHER_KEY=value"}
                  />
                </Field>
              </FieldGroup>
            </section>
              </>
            ) : null}
          </div>
          {error ? <p className={styles.createAgentModalText}>{error}</p> : null}
          <DialogFooter showCloseButton={!isEditing}>
            {isEditing ? (
              <Button type="button" variant="ghost" onClick={() => void onDeleteAgent()} disabled={isSubmitting || isDeleting}>
                {isDeleting ? "Deleting..." : "Delete"}
              </Button>
            ) : null}
            {isEditing || creationMode !== "intro" ? (
              <Button type="submit" disabled={isSubmitting || isDeleting}>
                {isEditing ? "Save" : creationMode === "delegate" ? "Create request" : "Submit for approval"}
              </Button>
            ) : null}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
