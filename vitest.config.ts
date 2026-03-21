import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Embedded Postgres bootstrap can exceed Vitest's default 30s hook budget on slow CI hosts.
    hookTimeout: 60_000,
    // Embedded Postgres binds a port per DB; parallel test files fight for ports and flake.
    fileParallelism: false,
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "json-summary"],
      include: ["apps/**/*.ts", "packages/**/*.ts"],
      thresholds: {
        lines: 40,
        functions: 40,
        branches: 30,
        statements: 40
      }
    }
  }
});
