import { spawn } from "node:child_process";
import { createServer } from "node:net";

const RESET = "\x1b[0m";
const METHOD_COLORS = {
  GET: "\x1b[38;2;80;200;120m",
  POST: "\x1b[38;2;70;140;255m",
  PUT: "\x1b[38;2;245;180;70m",
  PATCH: "\x1b[38;2;190;120;255m",
  DELETE: "\x1b[38;2;255;90;90m",
  OPTIONS: "\x1b[38;2;120;190;255m",
  HEAD: "\x1b[38;2;150;170;200m"
};

const methodPattern = /\b(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\b/g;

const defaultWebPort = Number(process.env.WEB_PORT ?? "4010");
const defaultApiPort = Number(process.env.API_PORT ?? "4020");

const webPort = await findOpenPort(defaultWebPort);
const apiPort = await findOpenPort(defaultApiPort, new Set([webPort]));

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const WARN = "\x1b[33m";

process.stdout.write(
  `\n${BOLD}[dev]${RESET} Open in this browser session:\n` +
    `  ${BOLD}Web${RESET}  ${RESET}→ http://127.0.0.1:${webPort}\n` +
    `  ${BOLD}API${RESET}  ${RESET}→ http://127.0.0.1:${apiPort}\n`
);
if (webPort !== defaultWebPort || apiPort !== defaultApiPort) {
  process.stdout.write(
    `${WARN}[dev] Default ports (${defaultWebPort}/${defaultApiPort}) were busy — you are NOT on the usual URLs.${RESET}\n` +
      `${DIM}If edits never show up, you may still have an old tab on :${defaultWebPort}. Run ${RESET}pnpm unstick${DIM} and restart.${RESET}\n`
  );
}
process.stdout.write(
  `${DIM}[dev] Stop with Ctrl+C so the API can close PGlite cleanly (avoid force-kill when switching from ${RESET}pnpm start${DIM}).${RESET}\n\n`
);

const child = spawn(
  "pnpm",
  [
    "turbo",
    "--no-update-notifier",
    "dev",
    "--ui=stream",
    "--output-logs=new-only",
    "--log-prefix=none",
    "--env-mode=loose"
  ],
  {
    env: {
      ...process.env,
      BOPO_SKIP_CODEX_PREFLIGHT: "1",
      WEB_PORT: String(webPort),
      API_PORT: String(apiPort),
      NEXT_PUBLIC_API_URL: `http://127.0.0.1:${apiPort}`
    },
    stdio: ["inherit", "pipe", "pipe"]
  }
);

pipeWithMethodColors(child.stdout, process.stdout);
pipeWithMethodColors(child.stderr, process.stderr);

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});

function pipeWithMethodColors(input, output) {
  if (!input) {
    return;
  }

  let buffered = "";
  input.setEncoding("utf8");
  input.on("data", (chunk) => {
    buffered += chunk;
    const lines = buffered.split(/\r?\n/);
    buffered = lines.pop() ?? "";
    for (const line of lines) {
      output.write(`${colorizeMethodTokens(line)}\n`);
    }
  });
  input.on("end", () => {
    if (buffered.length > 0) {
      output.write(colorizeMethodTokens(buffered));
    }
  });
}

function colorizeMethodTokens(text) {
  return text.replace(methodPattern, (method) => {
    const color = METHOD_COLORS[method];
    return color ? `${color}${method}${RESET}` : method;
  });
}

async function findOpenPort(startPort, reserved = new Set()) {
  for (let port = startPort; port < startPort + 100; port += 1) {
    if (reserved.has(port)) {
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    const available = await isPortAvailable(port);
    if (available) {
      return port;
    }
  }
  throw new Error(`No open port found near ${startPort}.`);
}

function isPortAvailable(port) {
  return new Promise((resolve) => {
    const server = createServer();
    server.unref();
    server.on("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolve(true));
    });
  });
}
