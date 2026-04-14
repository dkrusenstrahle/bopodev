import type { AdapterRuntimeUsageResolution } from "../../../../agent-sdk/src/adapters";
import { parseStructuredUsage } from "../../../../agent-sdk/src/runtime-parsers";

const SESSION_ID_LINE_RE = /\bsession[_\s-]?id\s*[:=]\s*([a-zA-Z0-9._:-]+)/i;
const SESSION_ID_TOKEN_RE = /\b\d{8}_\d{6}_[a-zA-Z0-9]+/;

export function resolveHermesRuntimeUsage(input: {
  stdout: string;
  stderr: string;
  parsedUsage?: {
    tokenInput?: number;
    tokenOutput?: number;
    usdCost?: number;
    summary?: string;
  };
  structuredOutputSource?: "stdout" | "stderr";
}): AdapterRuntimeUsageResolution {
  const stdoutUsage = parseStructuredUsage(input.stdout);
  if (stdoutUsage) {
    return { parsedUsage: stdoutUsage, structuredOutputSource: "stdout" };
  }
  const stderrUsage = parseStructuredUsage(input.stderr);
  if (stderrUsage) {
    return { parsedUsage: stderrUsage, structuredOutputSource: "stderr" };
  }
  return {
    parsedUsage: input.parsedUsage,
    structuredOutputSource: input.structuredOutputSource
  };
}

export function resolveHermesSessionId(stdout: string, stderr: string) {
  const lines = `${stdout}\n${stderr}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (const line of lines) {
    const explicit = line.match(SESSION_ID_LINE_RE);
    if (explicit?.[1]) {
      return explicit[1].trim();
    }
    const token = line.match(SESSION_ID_TOKEN_RE);
    if (token?.[0]) {
      return token[0].trim();
    }
  }
  return null;
}
