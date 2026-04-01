import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

export function resolvePluginArtifactsDir() {
  return process.env.BOPO_PLUGIN_ARTIFACTS_DIR || resolve(process.cwd(), ".bopo", "plugin-artifacts");
}

export async function ensurePluginArtifactsDir() {
  const dir = resolvePluginArtifactsDir();
  await mkdir(dir, { recursive: true });
  return dir;
}

export function sanitizeArtifactSegment(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]/g, "-");
}

export function buildPluginArtifactInstallDir(input: { pluginId: string; version: string; buildHash: string }) {
  const root = resolvePluginArtifactsDir();
  const plugin = sanitizeArtifactSegment(input.pluginId);
  const version = sanitizeArtifactSegment(input.version);
  const hash = sanitizeArtifactSegment(input.buildHash.slice(0, 16));
  return resolve(root, plugin, `${version}-${hash}`);
}

export async function removePluginArtifactInstallDir(path: string) {
  await rm(path, { recursive: true, force: true });
}
