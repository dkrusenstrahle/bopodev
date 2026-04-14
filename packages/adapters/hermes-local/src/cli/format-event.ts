export function formatStdoutEvent(line: string, debug: boolean) {
  const text = line.trim();
  if (!text) return;
  if (debug) console.log(`[{"adapter":"hermes_local"}] ` + text);
}
