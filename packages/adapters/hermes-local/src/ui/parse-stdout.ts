export function parseStdoutLine(line: string, timestampIso: string) {
  const text = line.trim();
  if (!text) return [];
  return [{ kind: "stdout", ts: timestampIso, text, adapterType: "hermes_local" }];
}
