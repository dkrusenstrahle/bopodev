import { runDoctorChecks } from "../lib/checks";
import { resolveWorkspaceRootOrManaged } from "../lib/process";
import { printBanner, printCheck, printDivider, printLine, printSection, printSummaryCard } from "../lib/ui";

export async function runDoctorCommand(cwd: string) {
  const workspaceRoot = await resolveWorkspaceRootOrManaged(cwd);
  if (!workspaceRoot) {
    throw new Error("Could not find a Bopodev workspace root. Run `bopodev onboard` first.");
  }

  printBanner();
  printSection("bopodev doctor");
  printLine(`Workspace: ${workspaceRoot}`);
  printDivider();

  const checks = await runDoctorChecks({ workspaceRoot });
  for (const check of checks) {
    printCheck(check.ok ? "ok" : "warn", check.label, check.details);
  }

  const passed = checks.filter((check) => check.ok).length;
  const failed = checks.length - passed;
  printLine("");
  printSummaryCard([`Summary: ${passed} passed, ${failed} warnings`]);
}
