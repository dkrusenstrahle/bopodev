import type { PluginManifestV2 } from "bopodev-contracts";
import { PluginInvocationResultSchema, PluginManifestV2Schema } from "bopodev-contracts";
import type { BopoDb } from "bopodev-db";
import { appendPluginRun, listCompanyPluginConfigs } from "bopodev-db";
import { pluginWorkerHost } from "./plugin-worker-host";

const lastJobRun = new Map<string, number>();

function shouldRunJob(companyId: string, pluginId: string, jobKey: string) {
  const key = `${companyId}:${pluginId}:${jobKey}`;
  const now = Date.now();
  const previous = lastJobRun.get(key) ?? 0;
  if (now - previous < 55_000) {
    return false;
  }
  lastJobRun.set(key, now);
  return true;
}

export async function runPluginJobSweep(db: BopoDb, companyId: string) {
  const rows = await listCompanyPluginConfigs(db, companyId);
  for (const row of rows) {
    if (!row.enabled) continue;
    const manifest = parseManifest(row.manifestJson);
    if (!manifest || manifest.jobs.length === 0) continue;
    for (const job of manifest.jobs) {
      if (!shouldRunJob(companyId, row.pluginId, job.jobKey)) continue;
      const startedAt = Date.now();
      try {
        const result = await pluginWorkerHost.invoke(manifest, {
          method: "plugin.job",
          params: {
            companyId,
            pluginId: row.pluginId,
            jobKey: job.jobKey,
            schedule: job.schedule
          }
        });
        const validated = PluginInvocationResultSchema.parse(result);
        await appendPluginRun(db, {
          companyId,
          runId: null,
          pluginId: row.pluginId,
          hook: `job:${job.jobKey}`,
          status: validated.status,
          durationMs: Date.now() - startedAt,
          diagnosticsJson: JSON.stringify(validated.diagnostics ?? {}),
          error: validated.status === "failed" || validated.status === "blocked" ? validated.summary : null
        });
      } catch (error) {
        await appendPluginRun(db, {
          companyId,
          runId: null,
          pluginId: row.pluginId,
          hook: `job:${job.jobKey}`,
          status: "failed",
          durationMs: Date.now() - startedAt,
          error: String(error)
        });
      }
    }
  }
}

function parseManifest(value: string | null | undefined): PluginManifestV2 | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    const result = PluginManifestV2Schema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}
