import color from "picocolors";

type CheckMark = "ok" | "warn" | "fail";

export function printBanner() {
  const lines = [
    "",
    "░██                                         ",
    "░██                                         ",
    "░████████   ░███████  ░████████   ░███████  ",
    "░██    ░██ ░██    ░██ ░██    ░██ ░██    ░██ ",
    "░██    ░██ ░██    ░██ ░██    ░██ ░██    ░██ ",
    "░███   ░██ ░██    ░██ ░███   ░██ ░██    ░██ ",
    "░██░█████   ░███████  ░██░█████   ░███████  ",
    "                      ░██                   ",
    "                      ░██                   ",
    ""
  ];
  const logoColor = "\x1b[38;2;221;128;92m";
  const logoReset = "\x1b[0m";
  for (const line of lines) {
    process.stdout.write(`${logoColor}${line}${logoReset}\n`);
  }
  process.stdout.write(`${color.dim("Open-source orchestration for autonomous companies")}\n\n`);
}

export function printSection(title: string) {
  process.stdout.write(`${color.bold(title)}\n`);
}

export function printLine(text: string) {
  process.stdout.write(`${text}\n`);
}

export function printDivider() {
  process.stdout.write(`${color.dim("----------------------------------------")}\n`);
}

export function printCheck(state: CheckMark, label: string, details: string, options?: { indent?: number }) {
  const status = state === "ok" ? color.green("ok") : state === "warn" ? color.yellow("warn") : color.red("fail");
  const indent = " ".repeat(Math.max(0, options?.indent ?? 0));
  const paddedLabel = `${label}:`.padEnd(26);
  process.stdout.write(`│  ${indent}${color.bold(paddedLabel)} ${details}  ${status}\n`);
}

export function printSummaryCard(lines: string[]) {
  const width = Math.max(...lines.map((line) => line.length), 10) + 2;
  const top = `+${"-".repeat(width)}+`;
  process.stdout.write(`${color.dim(top)}\n`);
  for (const line of lines) {
    process.stdout.write(`${color.dim("|")} ${line.padEnd(width - 1)}${color.dim("|")}\n`);
  }
  process.stdout.write(`${color.dim(top)}\n`);
}
