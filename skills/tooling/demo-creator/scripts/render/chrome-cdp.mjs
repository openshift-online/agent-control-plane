import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveChrome, sanitizedInheritedEnv, spawnManaged, terminateProcessTree, withPrivateTempDir } from "./common.mjs";

const DEFAULT_TIMEOUT_MS = 20_000;

export class CdpConnection {
  constructor(url, options = {}) {
    const {
      commandTimeoutMs = DEFAULT_TIMEOUT_MS,
      socketFactory = (socketUrl) => new WebSocket(socketUrl),
    } = options;
    this.commandTimeoutMs = commandTimeoutMs;
    this.socket = socketFactory(url);
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    this.failure = null;
    this.openedSettled = false;
    this.opened = new Promise((resolve, reject) => {
      this.openTimer = setTimeout(() => {
        const error = new Error("browser debugging connection timed out");
        this.#fail(error);
        this.openedSettled = true;
        reject(error);
      }, commandTimeoutMs);
      this.resolveOpened = () => {
        if (this.openedSettled) return;
        this.openedSettled = true;
        clearTimeout(this.openTimer);
        resolve();
      };
      this.rejectOpened = (error) => {
        if (this.openedSettled) return;
        this.openedSettled = true;
        clearTimeout(this.openTimer);
        reject(error);
      };
    });
    this.socket.addEventListener("open", this.resolveOpened, { once: true });
    this.socket.addEventListener("error", () => {
      const error = new Error("browser debugging connection failed");
      this.#fail(error);
      this.rejectOpened(error);
    }, { once: true });
    this.socket.addEventListener("message", (event) => {
      try {
        const message = JSON.parse(event.data);
        if (message.id) {
          const pending = this.pending.get(message.id);
          if (!pending) return;
          this.pending.delete(message.id);
          clearTimeout(pending.timer);
          if (message.error) pending.reject(new Error(message.error.message));
          else pending.resolve(message.result ?? {});
          return;
        }
        if (message.method) {
          for (const listener of this.listeners.get(message.method) ?? []) listener(message.params ?? {});
        }
      } catch (error) {
        this.#fail(new Error(`invalid browser debugging message: ${error.message}`));
      }
    });
    this.socket.addEventListener("close", () => {
      const error = new Error("browser debugging connection closed");
      this.#fail(error);
      this.rejectOpened(error);
    });
  }

  async send(method, params = {}) {
    await this.opened;
    if (this.failure) throw this.failure;
    const id = this.nextId;
    this.nextId += 1;
    const response = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`browser debugging command timed out: ${method}`));
      }, this.commandTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
    try {
      this.socket.send(JSON.stringify({ id, method, params }));
    } catch (error) {
      const pending = this.pending.get(id);
      this.pending.delete(id);
      clearTimeout(pending?.timer);
      pending?.reject(error);
    }
    return await response;
  }

  on(method, listener) {
    const listeners = this.listeners.get(method) ?? new Set();
    listeners.add(listener);
    this.listeners.set(method, listeners);
    return () => listeners.delete(listener);
  }

  #fail(error) {
    if (!this.failure) this.failure = error;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(this.failure);
    }
    this.pending.clear();
  }

  async close(timeoutMs = 1_000) {
    const error = new Error("browser debugging connection closed");
    this.#fail(error);
    this.rejectOpened(error);
    if (this.socket.readyState >= 2) return;
    await new Promise((resolveClose) => {
      const timer = setTimeout(resolveClose, timeoutMs);
      this.socket.addEventListener("close", () => {
        clearTimeout(timer);
        resolveClose();
      }, { once: true });
      this.socket.close();
    });
  }
}

export function localResourceAllowed(url, allowedFilePaths = []) {
  if (url.startsWith("data:")) return true;
  if (!url.startsWith("file:")) return false;
  let requestedPath;
  try {
    requestedPath = resolve(fileURLToPath(url));
  } catch {
    return false;
  }
  return allowedFilePaths.some((allowedPath) => requestedPath === resolve(allowedPath));
}

export function headlessBrowserArgs(profilePath) {
  const args = [
    "--headless=new",
    "--remote-debugging-port=0",
    `--user-data-dir=${profilePath}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--password-store=basic",
    "--use-mock-keychain",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-default-apps",
    "--disable-extensions",
    "--disable-sync",
    "--hide-scrollbars",
    "--metrics-recording-only",
    "--mute-audio",
    "about:blank",
  ];
  if (args.includes("--no-sandbox")) throw new Error("renderer refuses --no-sandbox");
  return args;
}

export async function terminateChild(child, graceMs = 2_000) {
  await terminateProcessTree(child, { graceMs });
}

async function waitForDebuggingAddress(child, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return await new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new Error("browser did not expose a debugging address")), timeoutMs);
    const inspect = (chunk) => {
      buffer = `${buffer}${chunk.toString("utf8")}`.slice(-64 * 1024);
      const match = buffer.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    };
    child.stderr.on("data", inspect);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`browser exited before startup with code ${code}`));
    });
  });
}

async function waitForDocument(connection) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const response = await connection.send("Runtime.evaluate", {
      expression: "document.readyState",
      returnByValue: true,
    });
    if (response.result?.value === "complete") return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("browser document did not finish loading");
}

async function waitForPageTarget(port) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`);
    if (response.ok) {
      const targets = await response.json();
      const page = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
      if (page) return page;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const response = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" });
  if (!response.ok) throw new Error("browser page target was not available");
  const page = await response.json();
  if (!page.webSocketDebuggerUrl) throw new Error("browser page target was not available");
  return page;
}

export async function withHeadlessPage(options, operation) {
  const {
    width,
    height,
    browserPath,
    allowedFilePaths = [],
  } = options;
  const executable = await resolveChrome(browserPath);
  if (!executable) throw new Error("Chrome for Testing or a Chromium-compatible browser is required");

  return await withPrivateTempDir("demo-browser-", async (profilePath) => {
    const args = headlessBrowserArgs(profilePath);
    const child = spawnManaged(executable, args, {
      env: sanitizedInheritedEnv(),
      stdio: ["ignore", "ignore", "pipe"],
    });
    let connection;
    try {
      const browserAddress = await waitForDebuggingAddress(child);
      const port = new URL(browserAddress).port;
      const page = await waitForPageTarget(port);
      connection = new CdpConnection(page.webSocketDebuggerUrl);
      await connection.send("Page.enable");
      await connection.send("Runtime.enable");
      const blockedRequests = [];
      connection.on("Fetch.requestPaused", ({ request, requestId }) => {
        const url = request?.url ?? "";
        const action = localResourceAllowed(url, allowedFilePaths)
          ? connection.send("Fetch.continueRequest", { requestId })
          : connection.send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" });
        if (!localResourceAllowed(url, allowedFilePaths)) blockedRequests.push(url);
        action.catch(() => {});
      });
      await connection.send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] });
      await connection.send("Emulation.setDeviceMetricsOverride", {
        width,
        height,
        deviceScaleFactor: 1,
        mobile: false,
      });
      const pageApi = {
        async navigate(pathOrUrl) {
          const url = pathOrUrl.includes("://") ? pathOrUrl : pathToFileURL(pathOrUrl).href;
          await connection.send("Page.navigate", { url });
          await waitForDocument(connection);
          if (blockedRequests.length > 0) {
            throw new Error("renderer blocked non-local resource");
          }
        },
        async evaluate(expression) {
          const response = await connection.send("Runtime.evaluate", {
            expression,
            awaitPromise: true,
            returnByValue: true,
          });
          if (response.exceptionDetails) throw new Error(response.exceptionDetails.text ?? "browser evaluation failed");
          return response.result?.value;
        },
        async screenshot() {
          if (blockedRequests.length > 0) {
            throw new Error("renderer blocked non-local resource");
          }
          const response = await connection.send("Page.captureScreenshot", {
            format: "png",
            captureBeyondViewport: false,
            fromSurface: true,
          });
          return Buffer.from(response.data, "base64");
        },
      };
      return await operation(pageApi);
    } finally {
      await connection?.close().catch(() => {});
      await terminateChild(child);
    }
  });
}
