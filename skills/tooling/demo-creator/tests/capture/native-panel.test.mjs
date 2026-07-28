import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  POST_ACTION_SETTLE_MILLISECONDS,
  attachNativePanel,
  createTargetCdpDriver,
  readCdpTargets,
  resolveScenarioUpload,
  runPanelActions,
  runDirectTargetActions,
  selectNativePanelTarget,
  waitForNativePanelTarget,
} from "../../scripts/capture/native-panel.mjs";

const extensionId = "bjlckanpiblmfadkmknbbpeenckfdgpi";

test("does not accept a matching side-panel target that predates the toolbar press", () => {
  const before = [
    { id: "worker", type: "service_worker", url: `chrome-extension://${extensionId}/worker.js` },
    { id: "preloaded-panel", type: "page", url: `chrome-extension://${extensionId}/index.html` },
  ];
  assert.equal(selectNativePanelTarget(before, before, extensionId, "index.html"), undefined);
});

test("rejects a new matching target when a preexisting match makes the result ambiguous", () => {
  const before = [
    { id: "preloaded-panel", type: "page", url: `chrome-extension://${extensionId}/index.html` },
  ];
  const after = [
    ...before,
    { id: "new-panel", type: "other", url: `chrome-extension://${extensionId}/index.html` },
  ];
  assert.throws(
    () => selectNativePanelTarget(before, after, extensionId, "index.html"),
    /ambiguous native side-panel targets.*preloaded-panel, new-panel/,
  );
});

test("rejects ambiguous matching native side-panel targets", () => {
  const matches = [
    { id: "panel-one", type: "page", url: `chrome-extension://${extensionId}/index.html` },
    { id: "panel-two", type: "other", url: `chrome-extension://${extensionId}/index.html` },
  ];
  assert.throws(
    () => selectNativePanelTarget([], matches, extensionId, "index.html"),
    /ambiguous native side-panel targets.*panel-one, panel-two/,
  );
});

test("never accepts a service worker as the native panel", () => {
  const target = selectNativePanelTarget([], [
    { id: "worker", type: "service_worker", url: `chrome-extension://${extensionId}/index.html` },
    { id: "lookalike", type: "page", url: `chrome-extension://${extensionId}/not-index.html` },
    { id: "wrong-origin", type: "page", url: "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/index.html" },
    { id: "malformed", type: "page", url: "not a URL" },
  ], extensionId, "index.html");
  assert.equal(target, undefined);
});

test("wait requires one newly created match after the toolbar press", async () => {
  const worker = {
    id: "worker",
    type: "service_worker",
    url: `chrome-extension://${extensionId}/background.js`,
  };
  const panel = {
    id: "new-panel",
    type: "page",
    url: `chrome-extension://${extensionId}/index.html`,
  };
  const target = await waitForNativePanelTarget({
    port: 9222,
    beforeTargets: [worker],
    extensionId,
    panelUrlPattern: "index.html",
    toolbarPressProof: { pressed: true, pinned: true, preseeded: true },
    fetchImpl: async () => ({ ok: true, json: async () => [worker, panel] }),
  });
  assert.equal(target, panel);
  await assert.rejects(
    waitForNativePanelTarget({
      port: 9222,
      beforeTargets: [worker],
      extensionId,
      panelUrlPattern: "index.html",
      fetchImpl: async () => ({ ok: true, json: async () => [worker, panel] }),
    }),
    /requires a successful OS-level toolbar press/,
  );
  await assert.rejects(
    waitForNativePanelTarget({
      port: 9222,
      beforeTargets: [worker],
      extensionId,
      panelUrlPattern: "index.html",
      toolbarPressProof: { opened: true, pinned: true, preseeded: true },
      fetchImpl: async () => ({ ok: true, json: async () => [worker, panel] }),
    }),
    /requires a successful OS-level toolbar press/,
  );
});

test("wait rejects an unchanged preexisting panel target", async () => {
  const preloaded = {
    id: "preloaded-panel",
    type: "page",
    url: `chrome-extension://${extensionId}/index.html`,
  };
  await assert.rejects(
    waitForNativePanelTarget({
      port: 9222,
      beforeTargets: [preloaded],
      extensionId,
      panelUrlPattern: "index.html",
      toolbarPressProof: { pressed: true, pinned: true, preseeded: true },
      timeoutMs: 1,
      fetchImpl: async () => ({ ok: true, json: async () => [preloaded] }),
    }),
    /did not create exactly one matching native side-panel target/,
  );
});

test("CDP target discovery uses loopback and validates HTTP status", async () => {
  const urls = [];
  let suppliedSignal;
  const targets = await readCdpTargets(9222, async (url, options) => {
    urls.push(url);
    suppliedSignal = options.signal;
    return { ok: true, json: async () => [{ id: "one" }] };
  }, { timeoutMs: 50 });
  assert.deepEqual(urls, ["http://127.0.0.1:9222/json/list"]);
  assert.equal(suppliedSignal instanceof AbortSignal, true);
  assert.deepEqual(targets, [{ id: "one" }]);
  await assert.rejects(
    readCdpTargets(9222, async () => ({ ok: false, status: 403 })),
    /HTTP 403/,
  );
});

test("each CDP target poll is aborted at the remaining deadline", async () => {
  const observedSignals = [];
  const keepAlive = setTimeout(() => {}, 100);
  try {
    await assert.rejects(
      waitForNativePanelTarget({
        port: 9222,
        beforeTargets: [],
        extensionId,
        panelUrlPattern: "index.html",
        toolbarPressProof: { pressed: true, pinned: true, preseeded: true },
        timeoutMs: 10,
        fetchImpl: async (_url, { signal }) => {
          observedSignals.push(signal);
          return new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          });
        },
      }),
      (error) => error?.name === "TimeoutError",
    );
  } finally {
    clearTimeout(keepAlive);
  }
  assert.equal(observedSignals.length, 1);
});

test("attaches to the proved target through Playwright CDP without closing Chrome", async () => {
  let closed = false;
  const sentMethods = [];
  const result = await attachNativePanel({
    port: 9222,
    target: { id: "panel", type: "page", url: `chrome-extension://${extensionId}/index.html` },
    playwrightModule: { chromium: {
      connectOverCDP: async () => ({
        contexts: () => [],
        newBrowserCDPSession: async () => ({ send: async (method) => {
          sentMethods.push(method);
          return { targetInfos: [
            { targetId: "panel", type: "page", url: `chrome-extension://${extensionId}/index.html` },
          ] };
        } }),
        close: async () => { closed = true; },
      }),
    } },
  });
  assert.equal(result.driver, "playwright-cdp");
  assert.equal(result.targetId, "panel");
  assert.equal(closed, false);
  assert.deepEqual(sentMethods, ["Target.getTargets"]);
  assert.equal(sentMethods.includes("Target.createTarget"), false);
  assert.equal(sentMethods.includes("Page.navigate"), false);
});

test("drives a native target of type other through the bounded direct CDP adapter", async () => {
  let closed = false;
  const calls = [];
  const rectangle = { x: 10, y: 20, width: 100, height: 40, viewportWidth: 400, viewportHeight: 600 };
  const directDriver = {
    wait: async (ms) => calls.push(["wait", ms]),
    box: async (selector) => { calls.push(["box", selector]); return rectangle; },
    click: async (selector) => calls.push(["click", selector]),
    text: async () => "ready",
    close: async () => { closed = true; },
  };
  const result = await attachNativePanel({
    port: 9222,
    target: { id: "panel", type: "other", url: `chrome-extension://${extensionId}/index.html` },
    actions: [
      { action: "wait", ms: 10 },
      { action: "click", selector: "#open" },
      { action: "expect", selector: "#status", text: "ready" },
    ],
    actionOptions: {
      captureWidth: 1280,
      captureHeight: 720,
      monotonicNow: () => 251_475.5,
      recordPointer: async (event) => calls.push(["pointer", event]),
    },
    directDriverFactory: async () => directDriver,
    playwrightModule: { chromium: {
      connectOverCDP: async () => ({
        contexts: () => [],
        newBrowserCDPSession: async () => ({ send: async () => ({ targetInfos: [
          { targetId: "panel", type: "other", url: `chrome-extension://${extensionId}/index.html` },
        ] }) }),
      }),
    } },
  });
  assert.equal(result.driver, "direct-target-cdp");
  assert.equal(result.type, "other");
  assert.equal(result.actionCount, 3);
  assert.equal(closed, true);
  assert.ok(calls.some((call) => call[0] === "click" && call[1] === "#open"));
  const pointer = calls.find((call) => call[0] === "pointer")[1];
  assert.equal(pointer.monotonicSeconds, 251_475.5);
  assert.equal(pointer.x, 0.734375);
  assert.ok(Math.abs(pointer.y - (160 / 720)) < 1e-12);
});

test("direct target CDP requests fail within their configured bound", async () => {
  const root = new EventEmitter();
  root.send = async (method) => {
    if (method === "Target.attachToTarget") return { sessionId: "direct-session" };
    if (method === "Target.detachFromTarget") return {};
    return {};
  };
  const driver = await createTargetCdpDriver(root, "panel", { timeoutMs: 5 });
  await assert.rejects(driver.box("#never-responds"), /timed out/);
  await driver.close();
});

test("direct target action runner preserves native file chooser semantics", async () => {
  const calls = [];
  const rectangle = { x: 1, y: 2, width: 30, height: 20, viewportWidth: 400, viewportHeight: 900 };
  const actions = await runDirectTargetActions({
    box: async () => rectangle,
    uploadViaChooser: async (selector, filePath) => calls.push([selector, filePath]),
    wait: async (milliseconds) => calls.push(["wait", milliseconds]),
    text: async () => "selected",
  }, [
    { action: "uploadConnection", selector: "#importKindConnections" },
    { action: "expect", selector: "#status", text: "selected" },
  ], {
    connectionRegistryPath: "/private/connections.json",
    captureWidth: 1920,
    captureHeight: 1080,
    recordPointer: async () => {},
  });
  assert.deepEqual(actions, ["uploadConnection", "expect"]);
  assert.deepEqual(calls, [
    ["#importKindConnections", "/private/connections.json"],
    ["wait", POST_ACTION_SETTLE_MILLISECONDS],
  ]);
});

test("direct target runner settles after each pointer action and keeps authored waits additive", async () => {
  assert.equal(POST_ACTION_SETTLE_MILLISECONDS, 650);
  const calls = [];
  const rectangle = { x: 1, y: 2, width: 30, height: 20, viewportWidth: 400, viewportHeight: 900 };
  await runDirectTargetActions({
    box: async () => rectangle,
    click: async (selector) => calls.push(["click", selector]),
    fill: async (selector) => calls.push(["fill", selector]),
    uploadViaChooser: async (selector) => calls.push(["uploadConnection", selector]),
    wait: async (milliseconds) => calls.push(["wait", milliseconds]),
  }, [
    { action: "click", selector: "#click" },
    { action: "fill", selector: "#fill", value: "synthetic" },
    { action: "uploadConnection", selector: "#upload" },
    { action: "wait", ms: 25 },
  ], {
    connectionRegistryPath: "/private/connections.json",
    captureWidth: 1920,
    captureHeight: 1080,
    monotonicNow: () => 251_475.5,
    recordPointer: async () => calls.push(["pointer"]),
  });
  assert.deepEqual(calls, [
    ["pointer"], ["click", "#click"], ["wait", POST_ACTION_SETTLE_MILLISECONDS],
    ["pointer"], ["fill", "#fill"], ["wait", POST_ACTION_SETTLE_MILLISECONDS],
    ["pointer"], ["uploadConnection", "#upload"], ["wait", POST_ACTION_SETTLE_MILLISECONDS],
    ["wait", 25],
  ]);
});

test("Playwright runner settles after each pointer action and keeps authored waits additive", async () => {
  const calls = [];
  const locator = (selector) => ({
    boundingBox: async () => ({ x: 1, y: 2, width: 30, height: 20 }),
    click: async () => calls.push(["click", selector]),
    fill: async () => calls.push(["fill", selector]),
  });
  await runPanelActions({
    viewportSize: () => ({ width: 400, height: 900 }),
    locator,
    waitForTimeout: async (milliseconds) => calls.push(["wait", milliseconds]),
    waitForEvent: async () => ({
      setFiles: async () => calls.push(["uploadConnection", "#upload"]),
    }),
  }, [
    { action: "click", selector: "#click" },
    { action: "fill", selector: "#fill", value: "synthetic" },
    { action: "uploadConnection", selector: "#upload" },
    { action: "wait", ms: 25 },
  ], {
    connectionRegistryPath: "/private/connections.json",
    captureWidth: 1920,
    captureHeight: 1080,
    monotonicNow: () => 251_476.25,
    recordPointer: async () => calls.push(["pointer"]),
  });
  assert.deepEqual(calls, [
    ["pointer"], ["click", "#click"], ["wait", POST_ACTION_SETTLE_MILLISECONDS],
    ["pointer"], ["fill", "#fill"], ["wait", POST_ACTION_SETTLE_MILLISECONDS],
    ["pointer"], ["click", "#upload"], ["uploadConnection", "#upload"],
    ["wait", POST_ACTION_SETTLE_MILLISECONDS], ["wait", 25],
  ]);
});

test("runs declarative panel actions against the attached native target", async (context) => {
  const scenarioDir = await mkdtemp(path.join(tmpdir(), "native-panel-actions-"));
  context.after(() => rm(scenarioDir, { recursive: true, force: true }));
  const fixturePath = path.join(scenarioDir, "fixture.json");
  await writeFile(fixturePath, "{}\n");
  const resolvedFixturePath = await realpath(fixturePath);
  const calls = [];
  const locator = (selector) => ({
    boundingBox: async () => ({ x: 10, y: 20, width: 100, height: 40 }),
    click: async () => calls.push(["click", selector]),
    fill: async (value) => calls.push(["fill", selector, value]),
    setInputFiles: async (value) => calls.push(["upload", selector, value]),
    waitFor: async () => calls.push(["visible", selector]),
    textContent: async () => "Connection imported",
  });
  const completed = await runPanelActions({
    waitForTimeout: async (ms) => calls.push(["wait", ms]),
    waitForEvent: async (name) => ({
      setFiles: async (filePath) => calls.push([name, filePath]),
    }),
    viewportSize: () => ({ width: 400, height: 900 }),
    locator,
    evaluate: async (_callback, value) => calls.push(["evaluate", value]),
    reload: async (options) => calls.push(["reload", options]),
  }, [
    { action: "wait", ms: 200 },
    { action: "click", selector: "#open" },
    { action: "fill", selector: "#name", value: "synthetic" },
    { action: "upload", selector: "#file", path: "fixture.json" },
    { action: "uploadConnection", selector: "#connections" },
    { action: "expect", selector: "#status", text: "imported" },
    { action: "configureBearer" },
  ], {
    scenarioDir,
    connectionRegistryPath: "/private/connections.json",
    captureWidth: 1920,
    captureHeight: 1080,
    monotonicNow: () => 251_476.25,
    recordPointer: async (event) => calls.push(["pointer", event]),
    environment: {
      ACP_URL: "http://127.0.0.1:12811",
      ACP_PROJECT: "demo-example",
      ACP_BEARER_TOKEN: "synthetic-test-credential",
    },
  });
  assert.deepEqual(completed, ["wait", "click", "fill", "upload", "uploadConnection", "expect", "configureBearer"]);
  assert.ok(calls.some((call) => call[0] === "upload" && call[2] === resolvedFixturePath));
  assert.ok(calls.some((call) => call[0] === "filechooser" && call[1] === "/private/connections.json"));
  assert.ok(calls.some((call) => call[0] === "reload" && call[1].waitUntil === "domcontentloaded"));
  const pointer = calls.find((call) => call[0] === "pointer")[1];
  assert.equal(pointer.monotonicSeconds, 251_476.25);
  assert.ok(pointer.x > 0.75 && pointer.x <= 1);
  assert.ok(pointer.y >= 0 && pointer.y <= 1);
});

test("both native-panel pointer drivers fail closed on an invalid injected clock", async () => {
  const rectangle = { x: 1, y: 2, width: 30, height: 20, viewportWidth: 400, viewportHeight: 900 };
  const options = {
    captureWidth: 1920,
    captureHeight: 1080,
    monotonicNow: () => Number.NaN,
    recordPointer: async () => {},
  };
  await assert.rejects(
    runDirectTargetActions({
      box: async () => rectangle,
      click: async () => {},
    }, [{ action: "click", selector: "#direct" }], options),
    /invalid monotonic timestamp/,
  );
  await assert.rejects(
    runPanelActions({
      viewportSize: () => ({ width: 400, height: 900 }),
      locator: () => ({
        boundingBox: async () => rectangle,
        click: async () => {},
      }),
    }, [{ action: "click", selector: "#playwright" }], options),
    /invalid monotonic timestamp/,
  );
});

test("upload realpaths both roots and rejects escapes and non-files", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "native-panel-upload-"));
  const scenarioDir = path.join(root, "scenario");
  const outsidePath = path.join(root, "outside.json");
  await mkdir(scenarioDir);
  await writeFile(path.join(scenarioDir, "inside.json"), "{}\n");
  await writeFile(outsidePath, "{}\n");
  await mkdir(path.join(scenarioDir, "directory"));
  await symlink(outsidePath, path.join(scenarioDir, "escape.json"));
  context.after(() => rm(root, { recursive: true, force: true }));

  assert.equal(
    await resolveScenarioUpload(scenarioDir, "inside.json"),
    await realpath(path.join(scenarioDir, "inside.json")),
  );
  await assert.rejects(
    resolveScenarioUpload(scenarioDir, "escape.json"),
    /escapes the scenario directory/,
  );
  await assert.rejects(
    resolveScenarioUpload(scenarioDir, "directory"),
    /regular file/,
  );
});

test("configureBearer refuses profiles that would retain the token", async () => {
  await assert.rejects(
    runPanelActions({}, [{ action: "configureBearer" }], {
      keepProfile: true,
      environment: {
        ACP_URL: "http://127.0.0.1:12811",
        ACP_PROJECT: "demo-example",
        ACP_BEARER_TOKEN: "synthetic-test-credential",
      },
    }),
    /refuses configureBearer when keepProfile is enabled/,
  );
});
