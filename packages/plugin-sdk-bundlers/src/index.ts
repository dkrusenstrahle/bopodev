export type PluginBundlerPreset = {
  target: "worker" | "ui" | "manifest";
  format: "esm" | "cjs";
  sourcemap: boolean;
  outDir: string;
  minify: boolean;
};

export function createPluginBundlerPresets(): PluginBundlerPreset[] {
  return [
    { target: "worker", format: "esm", sourcemap: true, outDir: "dist/worker", minify: false },
    { target: "ui", format: "esm", sourcemap: true, outDir: "dist/ui", minify: false },
    { target: "manifest", format: "esm", sourcemap: false, outDir: "dist", minify: false }
  ];
}
