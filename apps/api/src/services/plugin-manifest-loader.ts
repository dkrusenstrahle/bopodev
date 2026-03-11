import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { PluginManifestSchema, type PluginManifest } from "bopodev-contracts";

export type FilesystemPluginManifestLoadResult = {
  manifests: PluginManifest[];
  warnings: string[];
};

export async function loadFilesystemPluginManifests(): Promise<FilesystemPluginManifestLoadResult> {
  const pluginRoot = resolvePluginManifestsDir();
  let entries: string[] = [];
  try {
    entries = await readdir(pluginRoot);
  } catch {
    // Missing plugin directory is valid; startup should continue without file-based manifests.
    return { manifests: [], warnings: [] };
  }

  const manifests: PluginManifest[] = [];
  const warnings: string[] = [];
  for (const entry of entries) {
    const manifestPath = resolve(pluginRoot, entry, "plugin.json");
    let raw: string;
    try {
      raw = await readFile(manifestPath, "utf8");
    } catch {
      continue;
    }
    try {
      const parsed = JSON.parse(raw) as unknown;
      const manifest = PluginManifestSchema.parse(parsed);
      manifests.push(manifest);
    } catch (error) {
      warnings.push(`Invalid plugin manifest at '${manifestPath}': ${String(error)}`);
    }
  }

  return { manifests, warnings };
}

export function resolvePluginManifestsDir() {
  return process.env.BOPO_PLUGIN_MANIFESTS_DIR || resolve(process.cwd(), "plugins");
}

export async function writePluginManifestToFilesystem(manifest: PluginManifest) {
  const pluginRoot = resolvePluginManifestsDir();
  const safeDirName = sanitizePluginDirectoryName(manifest.id);
  const pluginDir = resolve(pluginRoot, safeDirName);
  const manifestPath = resolve(pluginDir, "plugin.json");
  await mkdir(pluginDir, { recursive: true });
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
  return manifestPath;
}

export async function deletePluginManifestFromFilesystem(pluginId: string) {
  const pluginRoot = resolvePluginManifestsDir();
  const safeDirName = sanitizePluginDirectoryName(pluginId);
  const pluginDir = resolve(pluginRoot, safeDirName);
  await rm(pluginDir, { recursive: true, force: true });
}

function sanitizePluginDirectoryName(pluginId: string) {
  return pluginId.replace(/[^a-zA-Z0-9._-]/g, "-");
}
