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
    <div className="ui-template-preview-root">
      <section>
        <h3 className="ui-template-preview-section-title">When you import</h3>
        <p className="ui-template-preview-lead">
          You will be prompted for the fields below. The org structure summarizes what will be created in your workspace.
        </p>
      </section>

      <section>
        <h3 className="ui-template-preview-section-title">Variables</h3>
        {variables.length === 0 ? (
          <p className="ui-template-preview-muted-p">No variables—this template applies as-is.</p>
        ) : (
          <ul className="ui-template-preview-variable-list">
            {variables.map((v) => {
              const def = formatDefaultValue(v.defaultValue);
              const opts = Array.isArray(v.options) ? v.options.filter((o) => typeof o === "string" && o.trim()) : [];
              return (
                <li key={v.key} className="ui-template-preview-variable-item">
                  <div className="ui-template-preview-row-wrap">
                    <span className="ui-template-preview-emphasis">{v.label?.trim() || v.key}</span>
                    <Badge variant="secondary" className="ui-template-preview-badge">
                      {v.type}
                    </Badge>
                    {v.required ? (
                      <Badge variant="outline" className="ui-template-preview-badge">
                        Required
                      </Badge>
                    ) : (
                      <Badge variant="outline" className="ui-template-preview-badge--optional">
                        Optional
                      </Badge>
                    )}
                  </div>
                  {v.description?.trim() ? (
                    <p className="ui-template-preview-variable-desc">{v.description.trim()}</p>
                  ) : null}
                  <div className="ui-template-preview-meta-key">Key: {v.key}</div>
                  {def ? (
                    <div className="ui-template-preview-default-row">
                      Default: <span className="ui-template-preview-default-value">{def}</span>
                    </div>
                  ) : null}
                  {opts.length > 0 ? (
                    <div className="ui-template-preview-options-row">
                      {opts.map((o) => (
                        <Badge key={o} variant="outline" className="ui-template-preview-badge">
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
        <h3 className="ui-template-preview-section-title">What gets created</h3>
        <div className="ui-template-preview-stack-4">
          {mission ? (
            <Card>
              <CardHeader className="ui-template-preview-card-header">
                <CardTitle className="ui-template-preview-card-title">Company mission</CardTitle>
                <CardDescription>Applied after you fill in variables (placeholders like {"{{name}}"} are substituted).</CardDescription>
              </CardHeader>
              <CardContent>
                <p className="ui-template-preview-body-pre">{mission}</p>
              </CardContent>
            </Card>
          ) : null}

          {projects.length > 0 ? (
            <Card>
              <CardHeader className="ui-template-preview-card-header">
                <CardTitle className="ui-template-preview-card-title">Projects ({projects.length})</CardTitle>
                <CardDescription>Work areas created with the template.</CardDescription>
              </CardHeader>
              <CardContent className="ui-template-preview-stack-3">
                {projects.map((p, i) => {
                  const key = str(p.key) || `project-${i}`;
                  const name = str(p.name) || key;
                  const desc = str(p.description).trim();
                  const status = str(p.status).trim();
                  return (
                    <div key={key} className="ui-template-preview-muted-box">
                      <div className="ui-template-preview-row-wrap">
                        <span className="ui-template-preview-emphasis">{name}</span>
                        {status ? (
                          <Badge variant="outline" className="ui-template-preview-badge">
                            {status}
                          </Badge>
                        ) : null}
                      </div>
                      {desc ? <p className="ui-template-preview-variable-desc">{desc}</p> : null}
                      <div className="ui-template-preview-meta-key-tight">key: {key}</div>
                    </div>
                  );
                })}
              </CardContent>
            </Card>
          ) : null}

          {goals.length > 0 ? (
            <Card>
              <CardHeader className="ui-template-preview-card-header">
                <CardTitle className="ui-template-preview-card-title">Goals ({goals.length})</CardTitle>
              </CardHeader>
              <CardContent className="ui-template-preview-stack-2">
                {goals.map((g, i) => {
                  const title = str(g.title) || `Goal ${i + 1}`;
                  const level = str(g.level).trim();
                  const pk = str(g.projectKey).trim();
                  const desc = str(g.description).trim();
                  return (
                    <div key={`${title}-${i}`} className="ui-template-preview-goal-card">
                      <div className="ui-template-preview-row-wrap">
                        <span className="ui-template-preview-emphasis">{title}</span>
                        {level ? (
                          <Badge variant="secondary" className="ui-template-preview-badge">
                            {level}
                          </Badge>
                        ) : null}
                        {pk ? (
                          <Badge variant="outline" className="ui-template-preview-badge">
                            project: {pk}
                          </Badge>
                        ) : null}
                      </div>
                      {desc ? <p className="ui-template-preview-muted-p">{desc}</p> : null}
                    </div>
                  );
                })}
              </CardContent>
            </Card>
          ) : null}

          {agents.length > 0 ? (
            <Card>
              <CardHeader className="ui-template-preview-card-header">
                <CardTitle className="ui-template-preview-card-title">Agents ({agents.length})</CardTitle>
                <CardDescription>Roles, reporting structure, and capabilities in the template.</CardDescription>
              </CardHeader>
              <CardContent className="ui-template-preview-stack-3">
                {agents.map((a, i) => {
                  const key = str(a.key) || `agent-${i}`;
                  const name = str(a.name) || key;
                  const role = str(a.role).trim();
                  const title = str(a.title).trim();
                  const caps = str(a.capabilities).trim();
                  const mgr = str(a.managerAgentKey).trim();
                  const rk = str(a.roleKey).trim();
                  return (
                    <div key={key} className="ui-template-preview-muted-box">
                      <div className="ui-template-preview-row-wrap">
                        <span className="ui-template-preview-emphasis">{name}</span>
                        {role ? (
                          <Badge variant="secondary" className="ui-template-preview-badge">
                            {role}
                          </Badge>
                        ) : null}
                        {rk ? (
                          <Badge variant="outline" className="ui-template-preview-badge">
                            {rk}
                          </Badge>
                        ) : null}
                      </div>
                      {title ? <p className="ui-template-preview-subtitle">{title}</p> : null}
                      {caps ? <p className="ui-template-preview-caps">{caps}</p> : null}
                      {mgr ? (
                        <p className="ui-template-preview-reports">
                          Reports to: <span className="ui-template-preview-reports-strong">{mgr}</span>
                        </p>
                      ) : null}
                      <div className="ui-template-preview-meta-key-tight">key: {key}</div>
                    </div>
                  );
                })}
              </CardContent>
            </Card>
          ) : null}

          {issues.length > 0 ? (
            <Card>
              <CardHeader className="ui-template-preview-card-header">
                <CardTitle className="ui-template-preview-card-title">Seed issues ({issues.length})</CardTitle>
                <CardDescription>Starter tasks created in the matching projects.</CardDescription>
              </CardHeader>
              <CardContent className="ui-template-preview-stack-2">
                {issues.map((issue, i) => {
                  const title = str(issue.title) || `Issue ${i + 1}`;
                  const pk = str(issue.projectKey).trim();
                  const pri = str(issue.priority).trim();
                  return (
                    <div key={`${title}-${i}`} className="ui-template-preview-issue-row">
                      <span className="ui-template-preview-issue-title">{title}</span>
                      {pk ? (
                        <Badge variant="outline" className="ui-template-preview-badge--shrink">
                          {pk}
                        </Badge>
                      ) : null}
                      {pri ? (
                        <Badge variant="secondary" className="ui-template-preview-badge--shrink">
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
              <CardHeader className="ui-template-preview-card-header">
                <CardTitle className="ui-template-preview-card-title">Scheduled routines ({recurrence.length})</CardTitle>
                <CardDescription>Recurring work assigned to agents when the template is applied.</CardDescription>
              </CardHeader>
              <CardContent className="ui-template-preview-stack-3">
                {recurrence.map((job, i) => {
                  const cron = str(job.cron).trim();
                  const target = str(job.targetKey).trim();
                  const ttype = str(job.targetType).trim();
                  const instr = str(job.instruction).trim();
                  return (
                    <div key={`${cron}-${target}-${i}`} className="ui-template-preview-recurrence-box">
                      <div className="ui-template-preview-recurrence-row">
                        {cron ? (
                          <Badge variant="secondary" className="ui-template-preview-badge--mono">
                            {cron}
                          </Badge>
                        ) : null}
                        {ttype ? (
                          <Badge variant="outline" className="ui-template-preview-badge">
                            {ttype}
                          </Badge>
                        ) : null}
                        {target ? (
                          <span className="ui-template-preview-recurrence-arrow">
                            → <span className="ui-template-preview-recurrence-target">{target}</span>
                          </span>
                        ) : null}
                      </div>
                      {instr ? <p className="ui-template-preview-recurrence-instr">{instr}</p> : null}
                    </div>
                  );
                })}
              </CardContent>
            </Card>
          ) : null}

          {plugins.length > 0 ? (
            <Card>
              <CardHeader className="ui-template-preview-card-header">
                <CardTitle className="ui-template-preview-card-title">Plugins ({plugins.length})</CardTitle>
              </CardHeader>
              <CardContent className="ui-template-preview-stack-2">
                {plugins.map((pl, i) => {
                  const id = str(pl.pluginId) || `plugin-${i}`;
                  const en = pl.enabled === true;
                  return (
                    <div key={id} className="ui-template-preview-plugin-row">
                      <span className="ui-template-preview-plugin-id">{id}</span>
                      <Badge variant={en ? "default" : "outline"} className="ui-template-preview-badge">
                        {en ? "enabled" : "disabled"}
                      </Badge>
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
            <p className="ui-template-preview-muted-p">No manifest details available for this template.</p>
          ) : null}
        </div>
      </section>
    </div>
  );
}
