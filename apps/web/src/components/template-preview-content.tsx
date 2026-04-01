"use client";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import type { TemplateRow } from "@/components/workspace/types";

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function recordArray(x: unknown): Record<string, unknown>[] {
  if (!Array.isArray(x)) {
    return [];
  }
  return x.filter(isRecord);
}

function str(x: unknown): string {
  if (x === null || x === undefined) {
    return "";
  }
  if (typeof x === "string") {
    return x;
  }
  if (typeof x === "number" || typeof x === "boolean") {
    return String(x);
  }
  return "";
}

function formatDefaultValue(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value === "string") {
    return value.trim() ? value : null;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function TemplatePreviewContent({ template }: { template: TemplateRow }) {
  const manifest = template.manifest ?? {};
  const company = isRecord(manifest.company) ? manifest.company : null;
  const mission = str(company?.mission).trim();
  const projects = recordArray(manifest.projects);
  const goals = recordArray(manifest.goals);
  const agents = recordArray(manifest.agents);
  const issues = recordArray(manifest.issues);
  const plugins = recordArray(manifest.plugins);
  const recurrence = recordArray(manifest.recurrence);
  const variables = template.variables ?? [];

  return (
    <div className="space-y-6">
      <section>
        <h3 className="mb-3 text-base font-medium">When you import</h3>
        <p className="text-muted-foreground text-base leading-relaxed">
          You will be prompted for the fields below. The org structure summarizes what will be created in your workspace.
        </p>
      </section>

      <section>
        <h3 className="mb-3 text-base font-medium">Variables</h3>
        {variables.length === 0 ? (
          <p className="text-muted-foreground text-base">No variables—this template applies as-is.</p>
        ) : (
          <ul className="space-y-3">
            {variables.map((v) => {
              const def = formatDefaultValue(v.defaultValue);
              const opts = Array.isArray(v.options) ? v.options.filter((o) => typeof o === "string" && o.trim()) : [];
              return (
                <li
                  key={v.key}
                  className="rounded-lg border bg-card px-4 py-3 shadow-sm"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{v.label?.trim() || v.key}</span>
                    <Badge variant="secondary" className="font-normal">
                      {v.type}
                    </Badge>
                    {v.required ? (
                      <Badge variant="outline" className="font-normal">
                        Required
                      </Badge>
                    ) : (
                      <Badge variant="outline" className="text-muted-foreground font-normal">
                        Optional
                      </Badge>
                    )}
                  </div>
                  {v.description?.trim() ? (
                    <p className="text-muted-foreground mt-1.5 text-base">{v.description.trim()}</p>
                  ) : null}
                  <div className="text-muted-foreground mt-2 font-mono text-base">Key: {v.key}</div>
                  {def ? (
                    <div className="text-muted-foreground mt-1 text-base">
                      Default: <span className="text-foreground">{def}</span>
                    </div>
                  ) : null}
                  {opts.length > 0 ? (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {opts.map((o) => (
                        <Badge key={o} variant="outline" className="font-normal">
                          {o}
                        </Badge>
                      ))}
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <Separator />

      <section>
        <h3 className="mb-3 text-base font-medium">What gets created</h3>
        <div className="space-y-4">
          {mission ? (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">Company mission</CardTitle>
                <CardDescription>Applied after you fill in variables (placeholders like {"{{name}}"} are substituted).</CardDescription>
              </CardHeader>
              <CardContent>
                <p className="text-base leading-relaxed whitespace-pre-wrap">{mission}</p>
              </CardContent>
            </Card>
          ) : null}

          {projects.length > 0 ? (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">Projects ({projects.length})</CardTitle>
                <CardDescription>Work areas created with the template.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {projects.map((p, i) => {
                  const key = str(p.key) || `project-${i}`;
                  const name = str(p.name) || key;
                  const desc = str(p.description).trim();
                  const status = str(p.status).trim();
                  return (
                    <div key={key} className="rounded-md border bg-muted/30 px-3 py-2.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{name}</span>
                        {status ? (
                          <Badge variant="outline" className="font-normal">
                            {status}
                          </Badge>
                        ) : null}
                      </div>
                      {desc ? <p className="text-muted-foreground mt-1.5 text-base">{desc}</p> : null}
                      <div className="text-muted-foreground mt-1 font-mono text-base">key: {key}</div>
                    </div>
                  );
                })}
              </CardContent>
            </Card>
          ) : null}

          {goals.length > 0 ? (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">Goals ({goals.length})</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {goals.map((g, i) => {
                  const title = str(g.title) || `Goal ${i + 1}`;
                  const level = str(g.level).trim();
                  const pk = str(g.projectKey).trim();
                  const desc = str(g.description).trim();
                  return (
                    <div key={`${title}-${i}`} className="flex flex-col gap-1 rounded-md border px-3 py-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{title}</span>
                        {level ? (
                          <Badge variant="secondary" className="font-normal">
                            {level}
                          </Badge>
                        ) : null}
                        {pk ? (
                          <Badge variant="outline" className="font-normal">
                            project: {pk}
                          </Badge>
                        ) : null}
                      </div>
                      {desc ? <p className="text-muted-foreground text-base">{desc}</p> : null}
                    </div>
                  );
                })}
              </CardContent>
            </Card>
          ) : null}

          {agents.length > 0 ? (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">Agents ({agents.length})</CardTitle>
                <CardDescription>Roles, reporting structure, and capabilities in the template.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {agents.map((a, i) => {
                  const key = str(a.key) || `agent-${i}`;
                  const name = str(a.name) || key;
                  const role = str(a.role).trim();
                  const title = str(a.title).trim();
                  const caps = str(a.capabilities).trim();
                  const mgr = str(a.managerAgentKey).trim();
                  const rk = str(a.roleKey).trim();
                  return (
                    <div key={key} className="rounded-md border bg-muted/30 px-3 py-2.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{name}</span>
                        {role ? <Badge variant="secondary">{role}</Badge> : null}
                        {rk ? (
                          <Badge variant="outline" className="font-normal">
                            {rk}
                          </Badge>
                        ) : null}
                      </div>
                      {title ? <p className="text-muted-foreground mt-1 text-base">{title}</p> : null}
                      {caps ? (
                        <p className="text-muted-foreground mt-2 text-base leading-relaxed line-clamp-3">{caps}</p>
                      ) : null}
                      {mgr ? (
                        <p className="text-muted-foreground mt-2 text-base">
                          Reports to: <span className="text-foreground font-medium">{mgr}</span>
                        </p>
                      ) : null}
                      <div className="text-muted-foreground mt-1 font-mono text-base">key: {key}</div>
                    </div>
                  );
                })}
              </CardContent>
            </Card>
          ) : null}

          {issues.length > 0 ? (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">Seed issues ({issues.length})</CardTitle>
                <CardDescription>Starter tasks created in the matching projects.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-2">
                {issues.map((issue, i) => {
                  const title = str(issue.title) || `Issue ${i + 1}`;
                  const pk = str(issue.projectKey).trim();
                  const pri = str(issue.priority).trim();
                  return (
                    <div key={`${title}-${i}`} className="flex flex-wrap items-start gap-2 rounded-md border px-3 py-2">
                      <span className="min-w-0 flex-1 font-medium">{title}</span>
                      {pk ? (
                        <Badge variant="outline" className="shrink-0 font-normal">
                          {pk}
                        </Badge>
                      ) : null}
                      {pri ? (
                        <Badge variant="secondary" className="shrink-0 font-normal">
                          {pri}
                        </Badge>
                      ) : null}
                    </div>
                  );
                })}
              </CardContent>
            </Card>
          ) : null}

          {recurrence.length > 0 ? (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">Scheduled routines ({recurrence.length})</CardTitle>
                <CardDescription>Recurring work assigned to agents when the template is applied.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {recurrence.map((job, i) => {
                  const cron = str(job.cron).trim();
                  const target = str(job.targetKey).trim();
                  const ttype = str(job.targetType).trim();
                  const instr = str(job.instruction).trim();
                  return (
                    <div key={`${cron}-${target}-${i}`} className="rounded-md border px-3 py-2.5">
                      <div className="flex flex-wrap gap-2">
                        {cron ? (
                          <Badge variant="secondary" className="font-mono font-normal">
                            {cron}
                          </Badge>
                        ) : null}
                        {ttype ? (
                          <Badge variant="outline" className="font-normal">
                            {ttype}
                          </Badge>
                        ) : null}
                        {target ? (
                          <span className="text-base">
                            → <span className="font-medium">{target}</span>
                          </span>
                        ) : null}
                      </div>
                      {instr ? <p className="text-muted-foreground mt-2 text-base leading-relaxed">{instr}</p> : null}
                    </div>
                  );
                })}
              </CardContent>
            </Card>
          ) : null}

          {plugins.length > 0 ? (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">Plugins ({plugins.length})</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {plugins.map((pl, i) => {
                  const id = str(pl.pluginId) || `plugin-${i}`;
                  const en = pl.enabled === true;
                  return (
                    <div key={id} className="flex flex-wrap items-center gap-2 rounded-md border px-3 py-2">
                      <span className="font-mono text-base">{id}</span>
                      <Badge variant={en ? "default" : "outline"}>{en ? "enabled" : "disabled"}</Badge>
                    </div>
                  );
                })}
              </CardContent>
            </Card>
          ) : null}

          {!mission &&
          projects.length === 0 &&
          goals.length === 0 &&
          agents.length === 0 &&
          issues.length === 0 &&
          recurrence.length === 0 &&
          plugins.length === 0 ? (
            <p className="text-muted-foreground text-base">No manifest details available for this template.</p>
          ) : null}
        </div>
      </section>
    </div>
  );
}
