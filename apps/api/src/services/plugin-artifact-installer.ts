import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { PluginManifestV2Schema, type PluginManifestV2 } from "bopodev-contracts";
import { buildPluginArtifactInstallDir, ensurePluginArtifactsDir, sanitizeArtifactSegment } from "./plugin-artifact-store";

const execFileAsync = promisify(execFile);

type NpmPackResultRow = {
  filename: string;
  integrity?: string;
};

export async function installPluginArtifactFromNpm(input: { packageName: string; version?: string }) {
  const packageRef = input.version?.trim() ? `${input.packageName}@${input.version.trim()}` : input.packageName.trim();
  if (!packageRef) {
    throw new Error("packageName is required.");
  }
  const artifactsRoot = await ensurePluginArtifactsDir();
  const tempRoot = await mkdtemp(resolve(tmpdir(), "bopo-plugin-pack-"));
  try {
    const { stdout } = await execFileAsync("npm", ["pack", packageRef, "--json"], {
      cwd: tempRoot,
      maxBuffer: 5 * 1024 * 1024
    });
    const parsed = JSON.parse(stdout.trim()) as NpmPackResultRow[] | NpmPackResultRow;
    const row = Array.isArray(parsed) ? parsed[0] : parsed;
    if (!row?.filename) {
      throw new Error("npm pack did not return a filename.");
    }
    const tarballPath = resolve(tempRoot, row.filename);
    const tarball = await readFile(tarballPath);
    const buildHash = createHash("sha256").update(tarball).digest("hex");
    const installDir = buildPluginArtifactInstallDir({
      pluginId: sanitizeArtifactSegment(input.packageName),
      version: input.version?.trim() || "latest",
      buildHash
    });
    await mkdir(installDir, { recursive: true });
    await execFileAsync("tar", ["-xzf", tarballPath, "-C", installDir], {
      maxBuffer: 5 * 1024 * 1024
    });
    const packageRoot = resolve(installDir, "package");
    const packageJsonRaw = await readFile(resolve(packageRoot, "package.json"), "utf8");
    const packageJsonParsed = JSON.parse(packageJsonRaw) as Record<string, unknown>;
    const manifestPath = resolveManifestPath(packageRoot, packageJsonParsed);
    const manifestRaw = await readFile(manifestPath, "utf8");
    const manifestParsed = PluginManifestV2Schema.parse(JSON.parse(manifestRaw) as unknown);
    const normalizedManifest = normalizeManifestEntrypoints(packageRoot, manifestParsed, {
      packageName: input.packageName.trim(),
      packageRef,
      integrity: row.integrity,
      buildHash,
      artifactPath: packageRoot
    });
    return {
      manifest: normalizedManifest,
      packageRoot,
      packageRef,
      buildHash,
      integrity: row.integrity
    };
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
    await mkdir(artifactsRoot, { recursive: true });
  }
}

function resolveManifestPath(packageRoot: string, packageJson: Record<string, unknown>) {
  const bopo = packageJson.bopo;
  if (typeof bopo === "object" && bopo !== null) {
    const maybe = (bopo as Record<string, unknown>).pluginManifest;
    if (typeof maybe === "string" && maybe.trim()) {
      return resolve(packageRoot, maybe);
    }
  }
  const legacy = packageJson.bopoPluginManifest;
  if (typeof legacy === "string" && legacy.trim()) {
    return resolve(packageRoot, legacy);
  }
  return resolve(packageRoot, "plugin.json");
}

function normalizeManifestEntrypoints(
  packageRoot: string,
  manifest: PluginManifestV2,
  input: {
    packageName: string;
    packageRef: string;
    integrity?: string;
    buildHash: string;
    artifactPath: string;
  }
): PluginManifestV2 {
  return {
    ...manifest,
    apiVersion: "2",
    entrypoints: {
      worker: resolve(packageRoot, manifest.entrypoints.worker),
      ui: manifest.entrypoints.ui ? resolve(packageRoot, manifest.entrypoints.ui) : undefined
    },
    install: {
      sourceType: "registry",
      sourceRef: input.packageRef,
      integrity: input.integrity,
      buildHash: input.buildHash || randomUUID(),
      installedAt: new Date().toISOString(),
      artifactPath: input.artifactPath,
      packageName: input.packageName
    }
  };
}
