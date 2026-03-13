#!/usr/bin/env node
import { Command } from "commander";
import { cancel, outro } from "@clack/prompts";
import { runDoctorCommand } from "./commands/doctor";
import { runOnboardFlow } from "./commands/onboard";
import { runStartCommand } from "./commands/start";

const program = new Command();

program.name("bopodev").description("Bopodev CLI");

program
  .command("onboard")
  .description("Install, configure, and start Bopodev locally")
  .option("--yes", "Run non-interactively using defaults", false)
  .option("--force-install", "Force reinstall dependencies even if already installed", false)
  .option("--template <template>", "Apply template by id or slug during onboarding")
  .option("--no-start", "Run setup and doctor checks without starting services")
  .action(async (options: { yes: boolean; start: boolean; forceInstall: boolean; template?: string }) => {
    try {
      await runOnboardFlow({
        cwd: process.cwd(),
        yes: options.yes,
        start: options.start,
        forceInstall: options.forceInstall,
        template: options.template
      });
      if (!options.start) {
        outro("Onboarding finished.");
      }
    } catch (error) {
      cancel(String(error));
      process.exitCode = 1;
    }
  });

program
  .command("start")
  .description("Start Bopodev without rerunning onboarding")
  .option("--full-logs", "Use full startup logs instead of quiet mode", false)
  .action(async (options: { fullLogs: boolean }) => {
    try {
      await runStartCommand(process.cwd(), { quiet: !options.fullLogs });
    } catch (error) {
      cancel(String(error));
      process.exitCode = 1;
    }
  });

program
  .command("doctor")
  .description("Run local preflight checks")
  .action(async () => {
    try {
      await runDoctorCommand(process.cwd());
      outro("Doctor finished.");
    } catch (error) {
      cancel(String(error));
      process.exitCode = 1;
    }
  });

void program.parseAsync(process.argv);
