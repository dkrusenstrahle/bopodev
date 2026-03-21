import { agents, eq } from "bopodev-db";
import { checkRuntimeCommandHealth } from "bopodev-agent-sdk";
import type { RuntimeCommandHealth } from "bopodev-agent-sdk";
import type { BootstrappedDb } from "./database";

type BopoDb = BootstrappedDb["db"];

export async function hasCodexAgentsConfigured(db: BopoDb) {
  const result = await db
    .select({ id: agents.id })
    .from(agents)
    .where(eq(agents.providerType, "codex"))
    .limit(1);
  return result.length > 0;
}

export async function hasOpenCodeAgentsConfigured(db: BopoDb) {
  const result = await db
    .select({ id: agents.id })
    .from(agents)
    .where(eq(agents.providerType, "opencode"))
    .limit(1);
  return result.length > 0;
}

export function emitCodexPreflightWarning(health: RuntimeCommandHealth) {
  const red = process.stderr.isTTY ? "\x1b[31m" : "";
  const yellow = process.stderr.isTTY ? "\x1b[33m" : "";
  const reset = process.stderr.isTTY ? "\x1b[0m" : "";
  const symbol = `${red}✖${reset}`;
  process.stderr.write(
    `${symbol} ${yellow}Codex preflight failed${reset}: command '${health.command}' is unavailable.\n`
  );
  process.stderr.write(`  Install Codex CLI or set BOPO_SKIP_CODEX_PREFLIGHT=1 for local dev.\n`);
  if (process.env.BOPO_VERBOSE_STARTUP_WARNINGS === "1") {
    process.stderr.write(`  Details: ${JSON.stringify(health)}\n`);
  }
}

export function emitOpenCodePreflightWarning(health: RuntimeCommandHealth) {
  const red = process.stderr.isTTY ? "\x1b[31m" : "";
  const yellow = process.stderr.isTTY ? "\x1b[33m" : "";
  const reset = process.stderr.isTTY ? "\x1b[0m" : "";
  const symbol = `${red}✖${reset}`;
  process.stderr.write(
    `${symbol} ${yellow}OpenCode preflight failed${reset}: command '${health.command}' is unavailable.\n`
  );
  process.stderr.write(`  Install OpenCode CLI or set BOPO_SKIP_OPENCODE_PREFLIGHT=1 for local dev.\n`);
  if (process.env.BOPO_VERBOSE_STARTUP_WARNINGS === "1") {
    process.stderr.write(`  Details: ${JSON.stringify(health)}\n`);
  }
}

export async function runStartupRuntimePreflights(options: {
  codexHealthRequired: boolean;
  openCodeHealthRequired: boolean;
  codexCommand: string;
  openCodeCommand: string;
}) {
  const { codexHealthRequired, openCodeHealthRequired, codexCommand, openCodeCommand } = options;
  if (codexHealthRequired) {
    const startupCodexHealth = await checkRuntimeCommandHealth(codexCommand, {
      timeoutMs: 5_000
    });
    if (!startupCodexHealth.available) {
      emitCodexPreflightWarning(startupCodexHealth);
    }
  }
  if (openCodeHealthRequired) {
    const startupOpenCodeHealth = await checkRuntimeCommandHealth(openCodeCommand, {
      timeoutMs: 5_000
    });
    if (!startupOpenCodeHealth.available) {
      emitOpenCodePreflightWarning(startupOpenCodeHealth);
    }
  }
}

export function buildGetRuntimeHealth(options: {
  codexCommand: string;
  openCodeCommand: string;
  skipCodexPreflight: boolean;
  skipOpenCodePreflight: boolean;
  codexHealthRequired: boolean;
  openCodeHealthRequired: boolean;
}) {
  const {
    codexCommand,
    openCodeCommand,
    skipCodexPreflight,
    skipOpenCodePreflight,
    codexHealthRequired,
    openCodeHealthRequired
  } = options;

  return async () => {
    const codex = codexHealthRequired
      ? await checkRuntimeCommandHealth(codexCommand, {
          timeoutMs: 5_000
        })
      : {
          command: codexCommand,
          available: skipCodexPreflight ? false : true,
          exitCode: null,
          elapsedMs: 0,
          error: skipCodexPreflight
            ? "Skipped by configuration: BOPO_SKIP_CODEX_PREFLIGHT=1."
            : "Skipped: no Codex agents configured."
        };
    const opencode = openCodeHealthRequired
      ? await checkRuntimeCommandHealth(openCodeCommand, {
          timeoutMs: 5_000
        })
      : {
          command: openCodeCommand,
          available: skipOpenCodePreflight ? false : true,
          exitCode: null,
          elapsedMs: 0,
          error: skipOpenCodePreflight
            ? "Skipped by configuration: BOPO_SKIP_OPENCODE_PREFLIGHT=1."
            : "Skipped: no OpenCode agents configured."
        };
    return {
      codex,
      opencode
    };
  };
}
