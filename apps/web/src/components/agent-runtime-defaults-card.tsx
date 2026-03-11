"use client";

import { useEffect, useState } from "react";
import {
  agentDefaultsStorageKey,
  defaultAgentRuntimeDefaults,
  readAgentRuntimeDefaults,
  writeAgentRuntimeDefaults,
  type AgentRuntimeDefaults
} from "@/lib/agent-defaults";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import styles from "./agent-runtime-defaults-card.module.scss";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select";
import { getSupportedModelOptionsForProvider } from "@/lib/agent-runtime-options";

export function AgentRuntimeDefaultsCard({
  fallbackDefaults
}: {
  fallbackDefaults?: {
    providerType?: AgentRuntimeDefaults["providerType"] | null;
    runtimeModel?: string | null;
  };
}) {
  const [defaults, setDefaults] = useState<AgentRuntimeDefaults>(defaultAgentRuntimeDefaults);
  const [saved, setSaved] = useState(false);
  const modelOptions = getSupportedModelOptionsForProvider(defaults.providerType);

  function buildFallbackDefaults(): AgentRuntimeDefaults {
    if (!fallbackDefaults?.providerType) {
      return defaultAgentRuntimeDefaults;
    }
    return {
      ...defaultAgentRuntimeDefaults,
      providerType: fallbackDefaults.providerType,
      runtimeModel: fallbackDefaults.runtimeModel ?? ""
    };
  }

  useEffect(() => {
    const stored = readAgentRuntimeDefaults();
    const hasStoredDefaults = window.localStorage.getItem(agentDefaultsStorageKey) !== null;
    if (!hasStoredDefaults && fallbackDefaults?.providerType) {
      const next = {
        ...stored,
        providerType: fallbackDefaults.providerType,
        runtimeModel: fallbackDefaults.runtimeModel ?? ""
      };
      const allowedValues = getSupportedModelOptionsForProvider(next.providerType).map((option) => option.value);
      setDefaults({
        ...next,
        runtimeModel: next.runtimeModel && allowedValues.includes(next.runtimeModel) ? next.runtimeModel : ""
      });
      return;
    }
    setDefaults(stored);
  }, [fallbackDefaults]);

  function update<K extends keyof AgentRuntimeDefaults>(key: K, value: AgentRuntimeDefaults[K]) {
    setDefaults((current) => ({ ...current, [key]: value }));
    setSaved(false);
  }

  useEffect(() => {
    const allowedValues = getSupportedModelOptionsForProvider(defaults.providerType).map((option) => option.value);
    if (!defaults.runtimeModel || allowedValues.includes(defaults.runtimeModel)) {
      return;
    }
    setDefaults((current) => ({ ...current, runtimeModel: "" }));
    setSaved(false);
  }, [defaults.providerType, defaults.runtimeModel]);

  function save() {
    writeAgentRuntimeDefaults(defaults);
    setSaved(true);
  }

  function reset() {
    const baseDefaults = buildFallbackDefaults();
    setDefaults(baseDefaults);
    writeAgentRuntimeDefaults(baseDefaults);
    setSaved(true);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Agent Runtime Defaults</CardTitle>
        <CardDescription>
          These values prefill the hire-agent flow and keep local runtime configuration consistent.
        </CardDescription>
      </CardHeader>
      <CardContent className={styles.runtimeDefaultsCardContent}>
        <FieldGroup className={styles.runtimeDefaultsFieldGroup}>
          <Field>
            <FieldLabel>Provider</FieldLabel>
            <Select
              value={defaults.providerType}
              onValueChange={(value) => update("providerType", value as AgentRuntimeDefaults["providerType"])}
            >
              <SelectTrigger className={styles.runtimeDefaultsSelectTrigger}>
                <SelectValue placeholder="Select a provider" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="claude_code">Claude Code</SelectItem>
                <SelectItem value="codex">OpenAI Codex</SelectItem>
                <SelectItem value="opencode">OpenCode</SelectItem>
                <SelectItem value="http">HTTP Worker</SelectItem>
                <SelectItem value="shell">Shell Runtime</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field>
            <FieldLabel htmlFor="defaults-heartbeat-interval">Heartbeat interval (sec)</FieldLabel>
            <Input
              id="defaults-heartbeat-interval"
              type="number"
              min={60}
              step="1"
              value={defaults.heartbeatIntervalSec}
              onChange={(event) => update("heartbeatIntervalSec", event.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="defaults-budget">Monthly budget (USD)</FieldLabel>
            <Input
              id="defaults-budget"
              type="number"
              min={0}
              step="1"
              value={defaults.monthlyBudgetUsd}
              onChange={(event) => update("monthlyBudgetUsd", event.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="defaults-runtime-cwd">Runtime cwd</FieldLabel>
            <Input id="defaults-runtime-cwd" value={defaults.runtimeCwd} onChange={(event) => update("runtimeCwd", event.target.value)} />
          </Field>
        </FieldGroup>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="defaults-runtime-command">Runtime command</FieldLabel>
            <Input id="defaults-runtime-command" value={defaults.runtimeCommand} onChange={(event) => update("runtimeCommand", event.target.value)} />
          </Field>
          <Field>
            <FieldLabel htmlFor="defaults-runtime-args">Runtime args</FieldLabel>
            <Input id="defaults-runtime-args" value={defaults.runtimeArgs} onChange={(event) => update("runtimeArgs", event.target.value)} />
            <FieldDescription>Arguments are stored as a space-separated string and parsed when the agent is created.</FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="defaults-runtime-model">Model</FieldLabel>
            <Select
              value={defaults.runtimeModel || "__default"}
              onValueChange={(value) => update("runtimeModel", value === "__default" ? "" : value)}
            >
              <SelectTrigger id="defaults-runtime-model" className={styles.runtimeDefaultsSelectTrigger}>
                <SelectValue placeholder="Select a model" />
              </SelectTrigger>
              <SelectContent>
                {modelOptions.map((option) => (
                  <SelectItem key={option.value || "__default"} value={option.value || "__default"}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field>
            <FieldLabel>Thinking effort</FieldLabel>
            <Select
              value={defaults.runtimeThinkingEffort}
              onValueChange={(value) => update("runtimeThinkingEffort", value as AgentRuntimeDefaults["runtimeThinkingEffort"])}
            >
              <SelectTrigger className={styles.runtimeDefaultsSelectTrigger}>
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
          <Field>
            <FieldLabel htmlFor="defaults-timeout-sec">Timeout (sec)</FieldLabel>
            <Input
              id="defaults-timeout-sec"
              type="number"
              min={0}
              step="1"
              value={defaults.runtimeTimeoutSec}
              onChange={(event) => update("runtimeTimeoutSec", event.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="defaults-interrupt-grace-sec">Interrupt grace period (sec)</FieldLabel>
            <Input
              id="defaults-interrupt-grace-sec"
              type="number"
              min={0}
              step="1"
              value={defaults.interruptGraceSec}
              onChange={(event) => update("interruptGraceSec", event.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel>Sandbox mode</FieldLabel>
            <Select
              value={defaults.sandboxMode}
              onValueChange={(value) => update("sandboxMode", value as AgentRuntimeDefaults["sandboxMode"])}
            >
              <SelectTrigger className={styles.runtimeDefaultsSelectTrigger}>
                <SelectValue placeholder="Select sandbox mode" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="workspace_write">Workspace write</SelectItem>
                <SelectItem value="full_access">Full access</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field orientation="horizontal">
            <Checkbox
              id="defaults-allow-web-search"
              checked={defaults.allowWebSearch}
              onCheckedChange={(checked) => update("allowWebSearch", Boolean(checked))}
            />
            <FieldContent>
              <FieldLabel htmlFor="defaults-allow-web-search">Enable web search</FieldLabel>
              <FieldDescription>Allow runtime web search when provider support is available.</FieldDescription>
            </FieldContent>
          </Field>
          <Field>
            <FieldLabel htmlFor="defaults-bootstrap-prompt">Bootstrap prompt</FieldLabel>
            <Textarea
              id="defaults-bootstrap-prompt"
              value={defaults.bootstrapPrompt}
              onChange={(event) => update("bootstrapPrompt", event.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="defaults-runtime-env">Default environment variables</FieldLabel>
            <Textarea
              id="defaults-runtime-env"
              value={defaults.runtimeEnv}
              onChange={(event) => update("runtimeEnv", event.target.value)}
              placeholder={"KEY=value\nANOTHER_KEY=value"}
            />
          </Field>
        </FieldGroup>
      </CardContent>
      <CardFooter className={styles.runtimeDefaultsCardFooter}>
        <span className={styles.runtimeDefaultsLabel}>{saved ? "Saved to local workspace settings." : "Unsaved changes."}</span>
        <div className={styles.runtimeDefaultsContainer}>
          <Button variant="outline" onClick={reset}>
            Reset
          </Button>
          <Button onClick={save}>Save defaults</Button>
        </div>
      </CardFooter>
    </Card>
  );
}
