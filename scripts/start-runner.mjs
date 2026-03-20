import { spawn } from "node:child_process";
import { createServer } from "node:net";

const quiet = process.argv.includes("--quiet");
const openBrowser = resolveOpenBrowserFlag();
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const WARN = "\x1b[33m";

const defaultWebPort = Number(process.env.WEB_PORT ?? "4010");
const defaultApiPort = Number(process.env.API_PORT ?? "4020");

const webPort = await findOpenPort(defaultWebPort);
const apiPort = await findOpenPort(defaultApiPort, new Set([webPort]));
const apiUrl = `http://127.0.0.1:${apiPort}`;
const webUrl = `http://127.0.0.1:${webPort}`;

process.stdout.write(
  `\n${BOLD}[start]${RESET} Production bundle — open:\n` +
    `  ${BOLD}Web${RESET}  → ${webUrl}\n` +
    `  ${BOLD}API${RESET}  → ${apiUrl}\n`
);
if (apiPort !== defaultApiPort) {
  process.stdout.write(
    `${WARN}[start] API is not on :${defaultApiPort}. The web client was built with NEXT_PUBLIC_API_URL (often http://localhost:${defaultApiPort}).${RESET}\n` +
      `${DIM}API calls may fail until you rebuild with ${RESET}NEXT_PUBLIC_API_URL=${apiUrl}${DIM} pnpm build${RESET}, or free :${defaultApiPort} and restart.${RESET}\n`
  );
}
if (webPort !== defaultWebPort) {
  process.stdout.write(`${WARN}[start] Web is not on :${defaultWebPort} — use ${webUrl} (not an old dev tab).${RESET}\n`);
}
process.stdout.write(
  `${DIM}[start] Stop with Ctrl+C so PGlite can close cleanly; avoid force-quit or the next dev server may not open the DB.${RESET}\n\n`
);

const args = [
  "turbo",
  "--no-update-notifier",
  "start",
  "--filter=bopodev-api",
  "--filter=bopodev-web",
  "--env-mode=loose"
];
if (quiet) {
  args.push("--ui=stream", "--output-logs=errors-only", "--log-prefix=none");
}

const child = spawn("pnpm", args, {
  env: {
    ...process.env,
    WEB_PORT: String(webPort),
    API_PORT: String(apiPort),
    NEXT_PUBLIC_API_URL: apiUrl
  },
  stdio: "inherit"
});

let opened = false;
if (openBrowser) {
  void openBrowserWhenReady(webUrl).then((didOpen) => {
    opened = didOpen;
  });
}

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});

function resolveOpenBrowserFlag() {
  if (process.env.BOPO_OPEN_BROWSER === "0") {
    return false;
  }
  if (process.env.BOPO_OPEN_BROWSER === "1") {
    return true;
  }
  return Boolean(process.stdout.isTTY) && !process.env.CI;
}

async function openDefaultBrowser(url) {
  const platform = process.platform;
  if (platform === "darwin") {
    spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
    return;
  }
  if (platform === "win32") {
    spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
    return;
  }
  spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
}

async function openBrowserWhenReady(url) {
  const maxWaitMs = Number(process.env.BOPO_OPEN_BROWSER_MAX_WAIT_MS ?? "45000");
  const intervalMs = Number(process.env.BOPO_OPEN_BROWSER_RETRY_MS ?? "500");
  const startedAt = Date.now();

  while (Date.now() - startedAt < maxWaitMs) {
    // eslint-disable-next-line no-await-in-loop
    const ready = await isHttpReady(url);
    if (ready) {
      await openDefaultBrowser(url);
      return true;
    }
    // eslint-disable-next-line no-await-in-loop
    await sleep(intervalMs);
  }

  process.stdout.write(`[start] browser auto-open skipped: ${url} did not become ready within ${maxWaitMs}ms\n`);
  return false;
}

async function isHttpReady(url) {
  try {
    const response = await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(1500)
    });
    return response.status < 500;
  } catch {
    return false;
  }
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
