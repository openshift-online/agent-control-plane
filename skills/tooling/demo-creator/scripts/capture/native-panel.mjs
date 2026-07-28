import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export const POST_ACTION_SETTLE_MILLISECONDS = 650;
const POINTER_PRODUCING_ACTIONS = new Set(["click", "fill", "uploadConnection"]);

export async function readCdpTargets(port, fetchImpl = globalThis.fetch, options = {}) {
  const timeoutMs = Math.max(1, Number(options.timeoutMs ?? 10_000));
  const signal = options.signal ?? AbortSignal.timeout(timeoutMs);
  const response = await fetchImpl(`http://127.0.0.1:${port}/json/list`, { signal });
  if (!response.ok) {
    throw new Error(`CDP target discovery failed with HTTP ${response.status}`);
  }
  return response.json();
}

function isMatchingNativePanelTarget(target, extensionId, panelUrlPattern) {
  const type = String(target.type ?? "");
  if (["service_worker", "background_page"].includes(type)) return false;
  let url;
  try {
    url = new URL(String(target.url ?? ""));
  } catch {
    return false;
  }
  const expectedPath = `/${String(panelUrlPattern).replace(/^\/+/, "")}`;
  return (
    url.protocol === "chrome-extension:"
    && url.hostname === extensionId
    && url.pathname === expectedPath
  );
}

export function selectNativePanelTarget(before, after, extensionId, panelUrlPattern) {
  const beforeIds = new Set(before.map((target) => target.id));
  const matches = after.filter((target) => (
    isMatchingNativePanelTarget(target, extensionId, panelUrlPattern)
  ));
  const newMatches = matches.filter((target) => !beforeIds.has(target.id));
  if (matches.length > 1) {
    throw new Error(
      `ambiguous native side-panel targets after toolbar press: ${matches.map((target) => target.id).join(", ")}`,
    );
  }
  return newMatches.length === 1 ? newMatches[0] : undefined;
}

export async function waitForNativePanelTarget({
  port,
  beforeTargets,
  extensionId,
  panelUrlPattern,
  toolbarPressProof,
  timeoutMs = 10_000,
  fetchImpl = globalThis.fetch,
}) {
  if (
    toolbarPressProof?.pressed !== true
    || toolbarPressProof?.pinned !== true
    || toolbarPressProof?.preseeded !== true
  ) {
    throw new Error("native side-panel discovery requires a successful OS-level toolbar press");
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const targets = await readCdpTargets(port, fetchImpl, {
      timeoutMs: Math.max(1, deadline - Date.now()),
    });
    const panelTarget = selectNativePanelTarget(
      beforeTargets,
      targets,
      extensionId,
      panelUrlPattern,
    );
    if (panelTarget) return panelTarget;
    await delay(100);
  }
  throw new Error(
    "the toolbar press did not create exactly one matching native side-panel target; direct extension navigation is prohibited",
  );
}

async function pageForTarget(browser, target) {
  for (const context of browser.contexts()) {
    for (const page of context.pages()) {
      if (page.url() !== target.url) continue;
      const session = await context.newCDPSession(page);
      const { targetInfo } = await session.send("Target.getTargetInfo");
      if (targetInfo.targetId === target.id) return page;
    }
  }
  return undefined;
}

async function waitForText(locator, expected, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const text = await locator.textContent().catch(() => "");
    if (String(text ?? "").includes(expected)) return;
    await delay(100);
  }
  throw new Error(`native panel did not show expected text: ${expected}`);
}

function cdpException(result, operation) {
  if (result?.exceptionDetails) {
    throw new Error(`native panel CDP ${operation} failed`);
  }
  return result?.result?.value;
}

export async function createTargetCdpDriver(rootSession, targetId, { timeoutMs = 10_000 } = {}) {
  const { sessionId } = await rootSession.send("Target.attachToTarget", {
    targetId,
    flatten: false,
  });
  let nextId = 1;
  const pending = new Map();
  const eventWaiters = new Map();
  const receive = ({ sessionId: receivedSessionId, message }) => {
    if (receivedSessionId !== sessionId) return;
    const payload = JSON.parse(message);
    if (payload.id && pending.has(payload.id)) {
      const request = pending.get(payload.id);
      pending.delete(payload.id);
      clearTimeout(request.timer);
      if (payload.error) request.reject(new Error(`native panel CDP ${request.method} failed`));
      else request.resolve(payload.result ?? {});
      return;
    }
    if (payload.method && eventWaiters.has(payload.method)) {
      const waiters = eventWaiters.get(payload.method);
      eventWaiters.delete(payload.method);
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        waiter.resolve(payload.params ?? {});
      }
    }
  };
  rootSession.on("Target.receivedMessageFromTarget", receive);

  const send = async (method, params = {}) => {
    const id = nextId++;
    const response = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`native panel CDP ${method} timed out`));
      }, timeoutMs);
      pending.set(id, { method, resolve, reject, timer });
    });
    try {
      await rootSession.send("Target.sendMessageToTarget", {
        sessionId,
        message: JSON.stringify({ id, method, params }),
      });
    } catch (error) {
      const request = pending.get(id);
      pending.delete(id);
      if (request) clearTimeout(request.timer);
      throw error;
    }
    return response;
  };
  const waitForEvent = (method) => new Promise((resolve, reject) => {
    const waiter = {
      resolve,
      reject,
      timer: setTimeout(() => {
        const waiters = eventWaiters.get(method) ?? [];
        const remaining = waiters.filter((candidate) => candidate !== waiter);
        if (remaining.length > 0) eventWaiters.set(method, remaining);
        else eventWaiters.delete(method);
        reject(new Error(`native panel CDP ${method} event timed out`));
      }, timeoutMs),
    };
    eventWaiters.set(method, [...(eventWaiters.get(method) ?? []), waiter]);
  });
  const evaluate = async (expression) => cdpException(await send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  }), "evaluation");
  const elementExpression = (selector, body) => `(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) throw new Error("selector not found");
    ${body}
  })()`;
  const box = (selector) => evaluate(elementExpression(selector, `
    const rectangle = element.getBoundingClientRect();
    if (rectangle.width <= 0 || rectangle.height <= 0) throw new Error("selector not visible");
    return { x: rectangle.x, y: rectangle.y, width: rectangle.width, height: rectangle.height,
      viewportWidth: globalThis.innerWidth, viewportHeight: globalThis.innerHeight };
  `));
  const click = async (selector) => {
    const rectangle = await box(selector);
    const x = rectangle.x + rectangle.width / 2;
    const y = rectangle.y + rectangle.height / 2;
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
    return rectangle;
  };
  const nodeFor = async (selector) => {
    const { root } = await send("DOM.getDocument", { depth: 0 });
    const { nodeId } = await send("DOM.querySelector", { nodeId: root.nodeId, selector });
    if (!nodeId) throw new Error("native panel upload selector was not found");
    return nodeId;
  };

  return {
    box,
    click,
    wait: (milliseconds) => delay(milliseconds),
    fill: async (selector, value) => evaluate(elementExpression(selector, `
      element.focus();
      element.value = ${JSON.stringify(value)};
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    `)),
    upload: async (selector, filePath) => send("DOM.setFileInputFiles", {
      nodeId: await nodeFor(selector),
      files: [filePath],
    }),
    uploadViaChooser: async (selector, filePath) => {
      await send("Page.enable");
      await send("Page.setInterceptFileChooserDialog", { enabled: true });
      try {
        const chooser = waitForEvent("Page.fileChooserOpened");
        const rectangle = await click(selector);
        const { backendNodeId } = await chooser;
        if (!backendNodeId) throw new Error("native panel file chooser did not identify its input");
        await send("DOM.setFileInputFiles", { backendNodeId, files: [filePath] });
        return rectangle;
      } finally {
        await send("Page.setInterceptFileChooserDialog", { enabled: false });
      }
    },
    text: (selector) => evaluate(elementExpression(selector, "return element.textContent ?? '';")),
    configureBearer: async ({ url, project, token }) => {
      const storedConfig = JSON.stringify({
        baseUrl: url,
        projectName: project,
        authMode: "bearer",
        theme: "dark",
      });
      await evaluate(`(() => {
        localStorage.setItem("acpConfig", ${JSON.stringify(storedConfig)});
        localStorage.setItem("acpToken", JSON.stringify({ access_token: ${JSON.stringify(token)}, manual: true,
          expires_at: Date.now() + 86400000 }));
      })()`);
      await send("Page.enable");
      const loaded = waitForEvent("Page.loadEventFired");
      await send("Page.reload", { ignoreCache: true });
      await loaded;
    },
    close: async () => {
      rootSession.off?.("Target.receivedMessageFromTarget", receive);
      for (const request of pending.values()) {
        clearTimeout(request.timer);
        request.reject(new Error("native panel CDP driver closed"));
      }
      pending.clear();
      for (const waiters of eventWaiters.values()) {
        for (const waiter of waiters) {
          clearTimeout(waiter.timer);
          waiter.reject(new Error("native panel CDP driver closed"));
        }
      }
      eventWaiters.clear();
      await rootSession.send("Target.detachFromTarget", { sessionId });
    },
  };
}

function defaultMonotonicNow() {
  return Number(process.hrtime.bigint()) / 1e9;
}

function pointerMonotonicSeconds(options) {
  const monotonicNow = options.monotonicNow ?? defaultMonotonicNow;
  if (typeof monotonicNow !== "function") {
    throw new Error("native panel pointer monotonic clock must be callable");
  }
  const timestamp = monotonicNow();
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp) || timestamp < 0) {
    throw new Error("native panel pointer clock returned an invalid monotonic timestamp");
  }
  return timestamp;
}

async function recordDirectPointer(rectangle, options) {
  if (!options.recordPointer) return;
  const captureWidth = options.captureWidth;
  const captureHeight = options.captureHeight;
  if (!captureWidth || !captureHeight) {
    throw new Error("native panel pointer mapping requires capture dimensions");
  }
  const panelLeft = Math.max(0, captureWidth - rectangle.viewportWidth);
  const panelTop = Math.max(0, captureHeight - rectangle.viewportHeight);
  await options.recordPointer({
    type: "click",
    monotonicSeconds: pointerMonotonicSeconds(options),
    x: Math.min(1, Math.max(0, (panelLeft + rectangle.x + rectangle.width / 2) / captureWidth)),
    y: Math.min(1, Math.max(0, (panelTop + rectangle.y + rectangle.height / 2) / captureHeight)),
  });
}

export async function runDirectTargetActions(driver, actions, options = {}) {
  const completed = [];
  for (const [index, action] of actions.entries()) {
    const label = `extension.actions[${index}]`;
    if (action.action === "wait") {
      await driver.wait(action.ms);
    } else if (action.action === "click") {
      const rectangle = await driver.box(action.selector);
      await recordDirectPointer(rectangle, options);
      await driver.click(action.selector);
    } else if (action.action === "fill") {
      const rectangle = await driver.box(action.selector);
      await recordDirectPointer(rectangle, options);
      await driver.fill(action.selector, action.value);
    } else if (action.action === "upload") {
      await driver.upload(action.selector, await resolveScenarioUpload(options.scenarioDir, action.path));
    } else if (action.action === "uploadConnection") {
      if (!options.connectionRegistryPath) throw new Error(`${label} requires the generated connection registry`);
      const rectangle = await driver.box(action.selector);
      await recordDirectPointer(rectangle, options);
      await driver.uploadViaChooser(action.selector, options.connectionRegistryPath);
    } else if (action.action === "expect") {
      const deadline = Date.now() + 10_000;
      const readText = async () => {
        try {
          return String(await driver.text(action.selector));
        } catch {
          // The selector may not be attached yet; keep polling until the deadline.
          return "";
        }
      };
      while (Date.now() < deadline && !(await readText()).includes(action.text)) {
        await delay(100);
      }
      if (!(await readText()).includes(action.text)) {
        throw new Error(`native panel did not show expected text: ${action.text}`);
      }
    } else if (action.action === "configureBearer") {
      if (options.keepProfile) throw new Error(`${label} refuses configureBearer when keepProfile is enabled`);
      const url = options.environment?.ACP_URL ?? process.env.ACP_URL;
      const project = options.environment?.ACP_PROJECT ?? process.env.ACP_PROJECT;
      const token = options.environment?.ACP_BEARER_TOKEN ?? process.env.ACP_BEARER_TOKEN;
      if (!url || !project || !token) throw new Error(`${label} requires ACP_URL, ACP_PROJECT, and ACP_BEARER_TOKEN`);
      await driver.configureBearer({ url, project, token });
    } else {
      throw new Error(`${label} has unsupported action ${action.action}`);
    }
    if (POINTER_PRODUCING_ACTIONS.has(action.action)) {
      await driver.wait(POST_ACTION_SETTLE_MILLISECONDS);
    }
    completed.push(action.action);
  }
  return completed;
}

export async function runPanelActions(page, actions, options = {}) {
  const completed = [];
  for (const [index, action] of actions.entries()) {
    const label = `extension.actions[${index}]`;
    if (action.action === "wait") {
      await page.waitForTimeout(action.ms);
    } else if (action.action === "click") {
      const locator = page.locator(action.selector);
      await recordLocatorPointer(page, locator, options);
      await locator.click();
    } else if (action.action === "fill") {
      const locator = page.locator(action.selector);
      await recordLocatorPointer(page, locator, options);
      await locator.fill(action.value);
    } else if (action.action === "upload") {
      const uploadPath = await resolveScenarioUpload(options.scenarioDir, action.path);
      await page.locator(action.selector).setInputFiles(uploadPath);
    } else if (action.action === "uploadConnection") {
      if (!options.connectionRegistryPath) throw new Error(`${label} requires the generated connection registry`);
      const trigger = page.locator(action.selector);
      await recordLocatorPointer(page, trigger, options);
      const [chooser] = await Promise.all([
        page.waitForEvent("filechooser"),
        trigger.click(),
      ]);
      await chooser.setFiles(options.connectionRegistryPath);
    } else if (action.action === "expect") {
      const locator = page.locator(action.selector);
      await locator.waitFor({ state: "visible" });
      await waitForText(locator, action.text);
    } else if (action.action === "configureBearer") {
      if (options.keepProfile) {
        throw new Error(`${label} refuses configureBearer when keepProfile is enabled`);
      }
      const baseUrl = options.environment?.ACP_URL ?? process.env.ACP_URL;
      const projectName = options.environment?.ACP_PROJECT ?? process.env.ACP_PROJECT;
      const accessToken = options.environment?.ACP_BEARER_TOKEN ?? process.env.ACP_BEARER_TOKEN;
      if (!baseUrl || !projectName || !accessToken) {
        throw new Error(`${label} requires ACP_URL, ACP_PROJECT, and ACP_BEARER_TOKEN`);
      }
      await page.evaluate(({ url, project, token }) => {
        localStorage.setItem("acpConfig", JSON.stringify({
          baseUrl: url,
          projectName: project,
          authMode: "bearer",
          theme: "dark",
        }));
        localStorage.setItem("acpToken", JSON.stringify({
          access_token: token,
          manual: true,
          expires_at: Date.now() + 86_400_000,
        }));
      }, { url: baseUrl, project: projectName, token: accessToken });
      await page.reload({ waitUntil: "domcontentloaded" });
    } else {
      throw new Error(`${label} has unsupported action ${action.action}`);
    }
    if (POINTER_PRODUCING_ACTIONS.has(action.action)) {
      await page.waitForTimeout(POST_ACTION_SETTLE_MILLISECONDS);
    }
    completed.push(action.action);
  }
  return completed;
}

export async function resolveScenarioUpload(scenarioDir, requestedPath) {
  if (!scenarioDir || !requestedPath) {
    throw new Error("native panel upload requires a scenario directory and path");
  }
  const scenarioRoot = await realpath(scenarioDir);
  const uploadPath = await realpath(path.resolve(scenarioRoot, requestedPath));
  const relative = path.relative(scenarioRoot, uploadPath);
  if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) {
    throw new Error("native panel upload path escapes the scenario directory");
  }
  const details = await stat(uploadPath);
  if (!details.isFile()) {
    throw new Error("native panel upload path must be a regular file");
  }
  return uploadPath;
}

async function recordLocatorPointer(page, locator, options) {
  if (!options.recordPointer) return;
  const box = await locator.boundingBox();
  if (!box) throw new Error("native panel action target has no visible bounds");
  const viewport = page.viewportSize?.() ?? await page.evaluate(() => ({
    width: globalThis.innerWidth,
    height: globalThis.innerHeight,
  }));
  const captureWidth = options.captureWidth;
  const captureHeight = options.captureHeight;
  if (!viewport || !captureWidth || !captureHeight) {
    throw new Error("native panel pointer mapping requires capture and viewport dimensions");
  }
  const panelLeft = Math.max(0, captureWidth - viewport.width);
  const panelTop = Math.max(0, captureHeight - viewport.height);
  await options.recordPointer({
    type: "click",
    monotonicSeconds: pointerMonotonicSeconds(options),
    x: Math.min(1, Math.max(0, (panelLeft + box.x + box.width / 2) / captureWidth)),
    y: Math.min(1, Math.max(0, (panelTop + box.y + box.height / 2) / captureHeight)),
  });
}

export async function attachNativePanel({
  port,
  target,
  playwrightModule,
  actions = [],
  actionOptions = {},
  onAttached,
  directDriverFactory = createTargetCdpDriver,
}) {
  let playwright = playwrightModule;
  if (!playwright) {
    try {
      playwright = await import("playwright");
    } catch {
      if (actions.length > 0 || onAttached) {
        throw new Error("Playwright is required to drive declarative native-panel actions");
      }
      return {
        driver: "cdp-target",
        targetId: target.id,
        url: target.url,
      };
    }
  }

  const browser = await playwright.chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const session = await browser.newBrowserCDPSession();
  const { targetInfos } = await session.send("Target.getTargets");
  const attachedTarget = targetInfos.find((candidate) => candidate.targetId === target.id);
  if (!attachedTarget) {
    throw new Error("native side-panel target disappeared before Playwright attached");
  }
  if (attachedTarget.url !== target.url || attachedTarget.type !== target.type) {
    throw new Error("native side-panel target identity changed before Playwright attached");
  }
  const page = await pageForTarget(browser, target);
  let completedActions = [];
  let directDriver;
  if (page) {
    completedActions = await runPanelActions(page, actions, actionOptions);
  } else if (actions.length > 0) {
    directDriver = await directDriverFactory(session, attachedTarget.targetId);
    try {
      completedActions = await runDirectTargetActions(directDriver, actions, actionOptions);
      if (onAttached) await onAttached({ browser, session, page, directDriver, target: attachedTarget });
    } finally {
      await directDriver.close();
    }
  }
  if (onAttached && (page || actions.length === 0)) {
    await onAttached({ browser, session, page, directDriver, target: attachedTarget });
  }
  // The CDP connection intentionally remains open until the captured Chrome
  // process exits. Calling browser.close() here would close the recorded app.
  return {
    driver: page || actions.length === 0 ? "playwright-cdp" : "direct-target-cdp",
    targetId: attachedTarget.targetId,
    type: attachedTarget.type,
    url: attachedTarget.url,
    actionCount: completedActions.length,
    actions: completedActions,
  };
}
