import { resolveWorkspaceRootOrManaged, runCommandStreaming } from "../lib/process";

export async function runStartCommand(cwd: string, options?: { quiet?: boolean }) {
  const workspaceRoot = await resolveWorkspaceRootOrManaged(cwd);
  if (!workspaceRoot) {
    throw new Error("Could not find a Bopodev workspace root. Run `bopodev onboard` first.");
  }

  const script = options?.quiet === false ? "start" : "start:quiet";
  const code = await runCommandStreaming("pnpm", [script], { cwd: workspaceRoot });
  if (code !== 0) {
    throw new Error(`pnpm ${script} failed with exit code ${String(code)}`);
  }
}
