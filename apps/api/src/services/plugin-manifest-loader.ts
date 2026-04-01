import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { PluginManifestSchema, PluginManifestV2Schema, type PluginManifest } from "bopodev-contracts";

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
      const manifest = normalizeFilesystemManifest(manifestPath, PluginManifestSchema.parse(parsed));
      manifests.push(manifest);
    } catch (error) {
      warnings.push(`Invalid plugin manifest at '${manifestPath}': ${String(error)}`);
    }
  }

  return { manifests, warnings };
}

export function resolvePluginManifestsDir() {
  if (process.env.BOPO_PLUGIN_MANIFESTS_DIR) {
    return process.env.BOPO_PLUGIN_MANIFESTS_DIR;
  }
  const localPlugins = resolve(process.cwd(), "plugins");
  if (directoryHasPluginManifests(localPlugins)) {
    return localPlugins;
  }
  const repoRootPlugins = resolve(process.cwd(), "..", "..", "plugins");
  if (directoryHasPluginManifests(repoRootPlugins)) {
    return repoRootPlugins;
  }
  if (existsSync(localPlugins)) {
    return localPlugins;
  }
  if (existsSync(repoRootPlugins)) {
    return repoRootPlugins;
  }
  return localPlugins;
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

export async function writePackagedPluginManifestToFilesystem(
  manifest: PluginManifest,
  input: {
    sourceType: "builtin" | "registry" | "local_path" | "archive_url";
    sourceRef?: string;
    integrity?: string;
    buildHash?: string;
  }
) {
  const nextManifest = {
    ...manifest,
    apiVersion: "2",
    install: {
      sourceType: input.sourceType,
      sourceRef: input.sourceRef,
      integrity: input.integrity,
      buildHash: input.buildHash,
      installedAt: new Date().toISOString()
    }
  } as PluginManifest;
  return writePluginManifestToFilesystem(nextManifest);
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

function directoryHasPluginManifests(dir: string) {
  if (!existsSync(dir)) {
    return false;
  }
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    return entries.some((entry) => entry.isDirectory() && existsSync(resolve(dir, entry.name, "plugin.json")));
  } catch {
    return false;
  }
}

function normalizeFilesystemManifest(manifestPath: string, manifest: PluginManifest): PluginManifest {
  const pluginDir = resolve(manifestPath, "..");
  const parsedV2 = PluginManifestV2Schema.safeParse(manifest);
  if (!parsedV2.success) {
    return manifest;
  }
  const v2 = parsedV2.data;
  const worker = resolve(pluginDir, v2.entrypoints.worker);
  const ui = v2.entrypoints.ui ? resolve(pluginDir, v2.entrypoints.ui) : undefined;
  return {
    ...v2,
    runtime: {
      ...v2.runtime,
      entrypoint: v2.runtime.type === "stdio" || v2.runtime.type === "http" ? resolve(pluginDir, v2.runtime.entrypoint) : v2.runtime.entrypoint
    },
    entrypoints: {
      worker,
      ui
    }
  };
}
