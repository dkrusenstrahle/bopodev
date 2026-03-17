"use client";

import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { ApiError, apiGet, apiPost } from "@/lib/api";
import { readAgentRuntimeDefaults } from "@/lib/agent-defaults";
import {
  buildRegistryModelOptions,
  getDefaultModelForProvider,
  getRegistryModelValuesForRuntimeProvider,
  type ModelRegistryRow,
  type RuntimeProviderType
} from "@/lib/model-registry-options";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import styles from "./create-company-modal.module.scss";

export function CreateCompanyModal({ companyId, trigger }: { companyId: string; trigger?: ReactNode }) {
  const router = useRouter();
  const defaults = useMemo(() => readAgentRuntimeDefaults(), []);
  const allowedProviders: RuntimeProviderType[] = ["claude_code", "codex", "opencode", "gemini_cli"];
  const initialProviderType = allowedProviders.includes(defaults.providerType) ? defaults.providerType : "claude_code";
  const [modelRegistryRows, setModelRegistryRows] = useState<ModelRegistryRow[]>([]);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [mission, setMission] = useState("");
  const [providerType, setProviderType] = useState<RuntimeProviderType>(initialProviderType);
  const [runtimeModel, setRuntimeModel] = useState(defaults.runtimeModel || "");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
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

  useEffect(() => {
    void apiGet<Array<ModelRegistryRow>>("/observability/models/pricing", companyId)
      .then((result) => setModelRegistryRows(result.data))
      .catch(() => setModelRegistryRows([]));
  }, [companyId]);

  useEffect(() => {
    const allowedValues = getRegistryModelValuesForRuntimeProvider(modelRegistryRows, providerType);
    const defaultId = getDefaultModelForProvider(providerType);
    const preferred = defaultId && allowedValues.includes(defaultId) ? defaultId : allowedValues[0] ?? defaultId ?? "";
    if (runtimeModel && !allowedValues.includes(runtimeModel)) {
      setRuntimeModel(preferred);
      return;
    }
    const requiresNamedModel = providerType !== "http" && providerType !== "shell";
    if (!requiresNamedModel || runtimeModel || allowedValues.length === 0) {
      return;
    }
    setRuntimeModel(preferred);
  }, [modelRegistryRows, providerType, runtimeModel]);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setIsSubmitting(true);
    setError(null);
    try {
      await apiPost("/companies", companyId, {
        name,
        mission: mission || undefined,
        providerType,
        runtimeModel: runtimeModel || undefined
      });
      setName("");
      setMission("");
      setOpen(false);
      router.refresh();
    } catch (submitError) {
      if (submitError instanceof ApiError) {
        setError(submitError.message);
      } else {
        setError("Failed to create company.");
      }
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {trigger ? (
        <DialogTrigger asChild>{trigger}</DialogTrigger>
      ) : (
        <DialogTrigger asChild>
          <Button>New Company</Button>
        </DialogTrigger>
      )}
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create company</DialogTitle>
          <DialogDescription>Create additional workspaces and organizations.</DialogDescription>
        </DialogHeader>
        <form className={styles.createCompanyModalForm} onSubmit={onSubmit}>
          <div className="ui-dialog-content-scrollable">
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="company-name">Company name</FieldLabel>
                <Input id="company-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Acme AI" required />
              </Field>
              <Field>
                <FieldLabel htmlFor="company-mission">Mission</FieldLabel>
                <Textarea
                  id="company-mission"
                  value={mission}
                  onChange={(e) => setMission(e.target.value)}
                  placeholder="Describe the company mission and operating context."
                />
                <FieldDescription>Optional context shown across the workspace.</FieldDescription>
              </Field>
              <Field>
                <FieldLabel>CEO provider</FieldLabel>
                <Select value={providerType} onValueChange={(value) => setProviderType(value as RuntimeProviderType)}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select a provider" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="claude_code">Claude Code</SelectItem>
                    <SelectItem value="codex">OpenAI Codex</SelectItem>
                    <SelectItem value="opencode">OpenCode</SelectItem>
                    <SelectItem value="gemini_cli">Gemini CLI</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
              <Field>
                <FieldLabel>CEO model</FieldLabel>
                <Select value={runtimeModel || undefined} onValueChange={setRuntimeModel}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select a model" />
                  </SelectTrigger>
                  <SelectContent>
                    {modelOptions.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FieldDescription>Model options follow the selected provider.</FieldDescription>
              </Field>
            </FieldGroup>
          </div>
          {error ? <p className={styles.createCompanyModalText}>{error}</p> : null}
          <DialogFooter showCloseButton>
            <Button type="submit" disabled={isSubmitting}>
              Create
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
