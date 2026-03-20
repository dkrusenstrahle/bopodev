import { spawn } from "node:child_process";
import { createServer } from "node:net";

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const ERROR = "\x1b[31m";
const DEFAULT_WEB_PORT = 4010;
const DEFAULT_API_PORT = 4020;
const DEFAULT_READY_RETRY_MS = 500;
const DEFAULT_CHILD_SHUTDOWN_TIMEOUT_MS = 15_000;
const SIGNAL_EXIT_CODES = {
  SIGINT: 130,
  SIGTERM: 143
};

export async function runRuntimeSupervisor(input) {
  const mode = input.mode;
  const openBrowser = input.openBrowser ?? false;
  const webPort = parsePort(process.env.WEB_PORT, DEFAULT_WEB_PORT, "WEB_PORT");
  const apiPort = parsePort(process.env.API_PORT, DEFAULT_API_PORT, "API_PORT");
  if (webPort === apiPort) {
    throw new Error(
      `WEB_PORT (${webPort}) and API_PORT (${apiPort}) must be different. Update your environment and retry.`
    );
  }

  await assertPortAvailable(webPort, "Web", mode);
  await assertPortAvailable(apiPort, "API", mode);

  const apiUrl = `http://127.0.0.1:${apiPort}`;
  const webUrl = `http://127.0.0.1:${webPort}`;
  printRuntimeBanner({
    mode,
    apiUrl,
    webUrl,
    openBrowser,
    quiet: input.quiet ?? false
  });

  const child = spawn("pnpm", input.commandArgs, {
    env: {
      ...process.env,
      ...input.extraEnv,
      WEB_PORT: String(webPort),
      API_PORT: String(apiPort),
      NEXT_PUBLIC_API_URL: apiUrl
    },
    stdio: ["inherit", "pipe", "pipe"]
  });

  let childExitState = null;
  let childError = null;
  child.on("error", (error) => {
    childError = error;
  });
  child.on("exit", (code, signal) => {
    childExitState = { code, signal };
  });

  pipeChildStream(child.stdout, process.stdout, input.stdoutLineTransform);
  pipeChildStream(child.stderr, process.stderr, input.stderrLineTransform);

  const forwardSignal = (signal) => {
    process.stderr.write(`\n[${mode}] Forwarding ${signal} to local runtime...\n`);
    if (!childExitState) {
      child.kill(signal);
    }
  };

  const handleSigint = () => forwardSignal("SIGINT");
  const handleSigterm = () => forwardSignal("SIGTERM");
  process.once("SIGINT", handleSigint);
  process.once("SIGTERM", handleSigterm);

  let forcedExitCode = null;
  try {
    await waitForRuntimeReady({
      mode,
      apiUrl,
      webUrl,
      apiTimeoutMs: input.apiReadyTimeoutMs,
      webTimeoutMs: input.webReadyTimeoutMs,
      retryMs: input.readyRetryMs,
      getChildExitState: () => childExitState,
      getChildError: () => childError
    });
    process.stdout.write(`[${mode}] Runtime ready. Web ${webUrl} | API ${apiUrl}\n`);
    if (openBrowser) {
      await openDefaultBrowser(webUrl);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${ERROR}[${mode}] Startup failed${RESET}: ${message}\n`);
    forcedExitCode = 1;
    await terminateChild(child, () => childExitState, input.childShutdownTimeoutMs);
  }

  process.removeListener("SIGINT", handleSigint);
  process.removeListener("SIGTERM", handleSigterm);

  const finalExit = await waitForChildExit(child, () => childExitState);
  if (forcedExitCode !== null) {
    process.exit(forcedExitCode);
    return;
  }
  if (finalExit.signal) {
    process.exit(SIGNAL_EXIT_CODES[finalExit.signal] ?? 1);
    return;
  }
  process.exit(finalExit.code ?? 0);
}

async function waitForRuntimeReady(input) {
  const retryMs = normalizePositiveInteger(input.retryMs, DEFAULT_READY_RETRY_MS);
  const apiDeadline = Date.now() + normalizePositiveInteger(input.apiTimeoutMs, 90_000);
  const webTimeoutMs = normalizePositiveInteger(input.webTimeoutMs, 120_000);
  let apiReady = false;
  let webReady = false;
  let lastApiDetail = "No successful API readiness check yet.";
  let lastWebDetail = "No successful web readiness check yet.";
  let webPhaseStartedAt = null;

  while (!apiReady || !webReady) {
    const childError = input.getChildError();
    if (childError) {
      throw childError;
    }
    const childExitState = input.getChildExitState();
    if (childExitState) {
      throw new Error(describeEarlyExit(input.mode, childExitState));
    }

    const now = Date.now();
    if (!apiReady) {
      const apiResult = await checkApiReadiness(input.apiUrl);
      apiReady = apiResult.ready;
      lastApiDetail = apiResult.detail;
      if (!apiReady && now >= apiDeadline) {
        throw new Error(`API readiness timed out. ${lastApiDetail}`);
      }
    }

    if (apiReady && !webReady) {
      webPhaseStartedAt ??= Date.now();
      const webResult = await checkWebReadiness(input.webUrl);
      webReady = webResult.ready;
      lastWebDetail = webResult.detail;
      if (!webReady && Date.now() - webPhaseStartedAt >= webTimeoutMs) {
        throw new Error(`Web readiness timed out. ${lastWebDetail}`);
      }
    }

    if (apiReady && webReady) {
      return;
    }

    await sleep(retryMs);
  }
}

export async function checkApiReadiness(apiUrl) {
  try {
    const response = await fetch(`${apiUrl}/health`, {
      signal: AbortSignal.timeout(2_000)
    });
    if (!response.ok) {
      const body = await readResponseText(response);
      return {
        ready: false,
        detail: `GET /health returned ${response.status}${body ? `: ${body}` : ""}`
      };
    }
    const payload = await response.json().catch(() => null);
    if (!payload || payload.ok !== true) {
      return {
        ready: false,
        detail: `GET /health did not report ok=true. Response: ${safeJson(payload)}`
      };
    }
    return {
      ready: true,
      detail: "API health check passed."
    };
  } catch (error) {
    return {
      ready: false,
      detail: `GET /health failed: ${error instanceof Error ? error.message : String(error)}`
    };
  }
}

export async function checkWebReadiness(webUrl) {
  try {
    const response = await fetch(webUrl, {
      redirect: "manual",
      signal: AbortSignal.timeout(2_000)
    });
    if (response.status >= 500 || response.status === 404) {
      const body = await readResponseText(response);
      return {
        ready: false,
        detail: `GET / returned ${response.status}${body ? `: ${body}` : ""}`
      };
    }
    return {
      ready: true,
      detail: `Web responded with ${response.status}.`
    };
  } catch (error) {
    return {
      ready: false,
      detail: `GET / failed: ${error instanceof Error ? error.message : String(error)}`
    };
  }
}

function printRuntimeBanner(input) {
  process.stdout.write(
    `\n${BOLD}[${input.mode}]${RESET} Starting local runtime:\n` +
      `  ${BOLD}Web${RESET}  -> ${input.webUrl}\n` +
      `  ${BOLD}API${RESET}  -> ${input.apiUrl}\n`
  );
  process.stdout.write(`${DIM}[${input.mode}] Using the configured local ports.${RESET}\n`);
  process.stdout.write(`${DIM}[${input.mode}] Waiting for services to become ready.${RESET}\n`);
  if (input.openBrowser) {
    process.stdout.write(`${DIM}[${input.mode}] Browser will open when the UI is ready.${RESET}\n`);
  }
  if (input.quiet) {
    process.stdout.write(`${DIM}[${input.mode}] Reduced log output enabled.${RESET}\n`);
  }
  process.stdout.write("\n");
}

function pipeChildStream(input, output, lineTransform) {
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
      output.write(`${lineTransform ? lineTransform(line) : line}\n`);
    }
  });
  input.on("end", () => {
    if (buffered.length > 0) {
      output.write(lineTransform ? lineTransform(buffered) : buffered);
    }
  });
}

async function terminateChild(child, getChildExitState, timeoutMs) {
  if (getChildExitState()) {
    return;
  }
  child.kill("SIGTERM");
  const exited = await waitForChildExit(child, getChildExitState, normalizePositiveInteger(timeoutMs, DEFAULT_CHILD_SHUTDOWN_TIMEOUT_MS));
  if (!exited) {
    child.kill("SIGKILL");
  }
}

async function waitForChildExit(child, getChildExitState, timeoutMs = 0) {
  const startedAt = Date.now();
  while (!getChildExitState()) {
    if (timeoutMs > 0 && Date.now() - startedAt >= timeoutMs) {
      return null;
    }
    await sleep(50);
  }
  return getChildExitState();
}

async function openDefaultBrowser(url) {
  if (process.platform === "darwin") {
    spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
    return;
  }
  if (process.platform === "win32") {
    spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
    return;
  }
  spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
}

export async function assertPortAvailable(port, label, mode) {
  if (await isPortAvailable(port)) {
    return;
  }
  throw new Error(
    `${label} port ${port} is already in use. Stop the existing process or run 'pnpm unstick'. ` +
      `To override intentionally, set ${label === "Web" ? "WEB_PORT" : "API_PORT"} before retrying.`
  );
}

function parsePort(rawValue, fallback, label) {
  const value = Number(rawValue ?? fallback);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return value;
}

function isPortAvailable(port) {
  return new Promise((resolve) => {
    const server = createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolve(true));
    });
  });
}

async function readResponseText(response) {
  try {
    const body = (await response.text()).trim();
    return body.length > 0 ? body : "";
  } catch {
    return "";
  }
}

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function describeEarlyExit(mode, exitState) {
  if (exitState.signal) {
    return `${mode} child exited from signal ${exitState.signal} before readiness completed.`;
  }
  return `${mode} child exited with code ${String(exitState.code)} before readiness completed.`;
}

function normalizePositiveInteger(value, fallback) {
  const normalized = Number(value ?? fallback);
  return Number.isInteger(normalized) && normalized > 0 ? normalized : fallback;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
