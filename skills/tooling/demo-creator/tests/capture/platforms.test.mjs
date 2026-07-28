import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { captureScenario, doctorCapture } from "../../scripts/capture/index.mjs";
import {
  finalizePointerEvents,
  seedPinnedExtensionPreferences,
  validatePinnedExtensionPreferences,
} from "../../scripts/capture/common.mjs";
import { buildLinuxDryRun, cleanupLinuxCapture, ffmpegArgs, linuxCaptureEnvironment, validateLinuxRecording } from "../../scripts/capture/linux/index.mjs";
import {
  assertBrowserApplicationWatcherResult,
  assertExclusiveBrowserBundle,
  assertOriginalBrowserChildLive,
  assertTrackedObsProcessRunning,
  browserBundleProcessIdsCommand,
  browserWindowIdentityCommand,
  buildMacosDryRun,
  buildHammerspoonCaptureControl,
  buildObsEnvironment,
  buildObsLaunchServicesArgs,
  cleanupMacosCapture,
  createHammerspoonAlignedMonotonicNow,
  createSpawnGuard,
  deleteObsCaptureRecordings,
  finalizeObsRecording,
  invokeBrowserApplicationWatcher,
  macosSignalstatsArgs,
  parseSignalstatsLuma,
  parseExecutableProcessIds,
  parseObsProcessIds,
  preserveObsFailureDiagnostics,
  readBrowserWindowIdentity,
  refuseRunningChromeForTesting,
  refuseRunningObs,
  startHammerspoonPointerCapture,
  stopObsLaunch,
  validateMacosRecordingLuma,
  validateBrowserWindowIdentity,
  waitForObsRecordingReady,
  waitForNewObsProcess,
  writeObsConfiguration,
} from "../../scripts/capture/macos/index.mjs";

const config = {
  extensionDir: "/tmp/extension",
  extensionId: "bjlckanpiblmfadkmknbbpeenckfdgpi",
  width: 1920,
  height: 1080,
  browserWidth: 1280,
  browserHeight: 720,
  fps: 30,
  extraBrowserArgs: [],
  startUrl: "about:blank",
};

test("macOS dry run resolves the launched browser window identity before isolated OBS", () => {
  const commands = buildMacosDryRun(config, {
    browserPath: "/Applications/CfT",
    profileDir: "/tmp/private",
    osascriptPath: "/usr/bin/osascript",
    openPath: "/usr/bin/open",
    obsHome: "/tmp/private/obs-home",
    browserPid: 4242,
  });
  assert.equal(commands.length, 5);
  assert.match(commands[0].args.join(" "), /disable-extensions-except/);
  assert.ok(commands[0].args.includes("--window-size=1280,720"));
  assert.ok(commands[0].args.includes("--force-renderer-accessibility"));
  assert.match(commands[1].args[0], /run_hammerspoon\.applescript$/);
  assert.match(commands[1].args[1], /hs\.application\.get\(4242\)/);
  assert.match(commands[1].args[1], /applicationsForBundleID/);
  assert.match(commands[2].args[1], /app:mainWindow\(\)/);
  assert.match(commands[2].args[1], /app:focusedWindow\(\)/);
  assert.match(commands[2].args[1], /window:id\(\)/);
  assert.match(commands[2].args[1], /window:frame\(\)/);
  assert.equal(commands[3].executable, "/usr/bin/open");
  assert.deepEqual(commands[3].args.slice(0, 4), ["-W", "-n", "-a", "/Applications/OBS.app"]);
  assert.ok(commands[3].args.includes("--multi"));
  assert.ok(commands[3].args.includes("--startrecording"));
  assert.match(commands[4].args[1], /open_extension\.lua/);
});

test("macOS bundle-exclusivity preflight requires the launched PID to be the sole bundle app", async () => {
  const bundleId = "com.google.chrome.for.testing";
  const command = browserBundleProcessIdsCommand("/usr/bin/osascript", 4242, bundleId);
  assert.match(command.args[1], /hs\.application\.get\(4242\)/);
  assert.match(command.args[1], /applicationsForBundleID\("com\.google\.chrome\.for\.testing"\)/);

  assert.equal(await assertExclusiveBrowserBundle(
    "/usr/bin/osascript",
    4242,
    bundleId,
    async () => ({
      stdout: `${JSON.stringify({
        expectedFound: true,
        expectedBundle: bundleId,
        pids: [4242],
      })}\n`,
      stderr: "",
    }),
  ), 4242);

  await assert.rejects(
    assertExclusiveBrowserBundle(
      "/usr/bin/osascript",
      4242,
      bundleId,
      async () => ({
        stdout: `${JSON.stringify({
          expectedFound: true,
          expectedBundle: bundleId,
          pids: [4242, 4343],
        })}\n`,
        stderr: "",
      }),
    ),
    /expected sole PID 4242, found 4242, 4343/,
  );
  await assert.rejects(
    assertExclusiveBrowserBundle(
      "/usr/bin/osascript",
      4242,
      bundleId,
      async () => ({ stdout: "not-json\n", stderr: "" }),
    ),
    /returned invalid JSON/,
  );
});

test("macOS Hammerspoon controls and Lua bind capture actions to the launched PID", async () => {
  const controls = [
    buildHammerspoonCaptureControl(4242, "start-application-watcher"),
    buildHammerspoonCaptureControl(4242, "start-pointer", { pointerOutput: "/tmp/pointer" }),
    buildHammerspoonCaptureControl(4242, "open", { extensionId: "extension-id" }),
    buildHammerspoonCaptureControl(4242, "stop-pointer"),
    buildHammerspoonCaptureControl(4242, "stop-application-watcher"),
  ];
  assert.deepEqual(controls.map(({ action, applicationPid }) => ({ action, applicationPid })), [
    { action: "start-application-watcher", applicationPid: 4242 },
    { action: "start-pointer", applicationPid: 4242 },
    { action: "open", applicationPid: 4242 },
    { action: "stop-pointer", applicationPid: 4242 },
    { action: "stop-application-watcher", applicationPid: 4242 },
  ]);
  for (const control of controls) assert.equal("applicationName" in control, false);

  const lua = await readFile(new URL(
    "../../scripts/capture/macos/open_extension.lua",
    import.meta.url,
  ), "utf8");
  assert.match(lua, /hs\.application\.get\(config\.applicationPid\)/);
  assert.match(lua, /app:bundleID\(\) ~= chrome_for_testing_bundle_id/);
  assert.match(lua, /acpDemoCreatorPointerPid ~= config\.applicationPid/);
  assert.match(lua, /hs\.application\.watcher\.new/);
  assert.match(lua, /event == hs\.application\.watcher\.terminated/);
  assert.match(lua, /state\.otherPids\[pid\] = true/);
  assert.doesNotMatch(lua, /applicationName|hs\.application\.find/);
  assert.doesNotMatch(lua, /Extensions menu|pin to toolbar|keyStroke/);
  assert.doesNotMatch(lua, /hs\.eventtap\.leftClick|opened = true/);
  assert.doesNotMatch(lua, /hs\.eventtap\.new|hs\.eventtap\.event\.types\.(?:mouseMoved|leftMouseDown)/);
  assert.match(lua, /preseeded extension toolbar action is absent/);
  assert.match(lua, /preseeded extension toolbar action is ambiguous/);
  assert.match(lua, /string_attribute\(element, "AXRole"\) == "AXPopUpButton"/);
  assert.match(lua, /supports_action\(element, "AXPress"\)/);
  assert.match(lua, /description == config\.extensionName or description == config\.extensionId/);
  assert.match(lua, /value == config\.extensionId/);
  assert.match(lua, /normalized_center_y >= 0\.1/);
  assert.match(lua, /#candidates > 1/);
  assert.match(lua, /append_pointer\(config\.pointerOutput, "click"/);
  assert.match(lua, /candidate\.element:performAction\("AXPress"\)/);
  assert.match(lua, /if not press_result then error/);
  assert.match(lua, /pressed = true, pinned = true, preseeded = true/);
  assert.match(lua, /monotonicSeconds = hs\.timer\.absoluteTime\(\) \/ 1000000000/);
  assert.ok(
    lua.indexOf('append_pointer(config.pointerOutput, "click"')
      < lua.indexOf('candidate.element:performAction("AXPress")'),
    "the pointer click event must be timestamped before the semantic toolbar press",
  );

  const macos = await readFile(new URL(
    "../../scripts/capture/macos/index.mjs",
    import.meta.url,
  ), "utf8");
  const pointerStartIndex = macos.indexOf("await startHammerspoonPointerCapture({");
  const baselineIndex = macos.indexOf("const beforeTargets = await readCdpTargets(port);", pointerStartIndex);
  const toolbarPressIndex = macos.indexOf('buildHammerspoonCaptureControl(browserPid, "open"', baselineIndex);
  assert.ok(pointerStartIndex >= 0 && baselineIndex >= 0 && toolbarPressIndex >= 0);
  assert.ok(
    pointerStartIndex < baselineIndex && baselineIndex < toolbarPressIndex,
    "the CDP baseline must be captured immediately before the exact toolbar press",
  );
  assert.match(macos.slice(pointerStartIndex, baselineIndex), /armCleanup: \(\) => \{ pointerStarted = true; \}/);
  assert.match(macos, /monotonicNow: alignedMonotonicNow/);
});

test("macOS aligns Node panel events to the Hammerspoon pointer clock", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "hammerspoon-clock-alignment-"));
  context.after(() => import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true })));
  const rawPath = path.join(root, "pointer.raw.jsonl");
  const outputPath = path.join(root, "pointer.jsonl");
  const hammerspoonAtReceipt = 251_475;
  const nodeMidpoint = hammerspoonAtReceipt + 51_793;
  const nodeBefore = nodeMidpoint - 0.2;
  const nodeAfter = nodeMidpoint + 0.2;
  const nodeSamples = [nodeBefore, nodeAfter, nodeMidpoint + 0.4, nodeMidpoint + 1.2];
  let cleanupArmed = false;
  const synchronization = await startHammerspoonPointerCapture({
    osascriptPath: "/usr/bin/osascript",
    browserPid: 4242,
    pointerOutput: "/tmp/pointer.raw.jsonl",
    privateRoot: "/tmp/private-root",
    armCleanup: () => { cleanupArmed = true; },
    invoke: async () => ({ started: true, monotonicSeconds: hammerspoonAtReceipt }),
    nodeNow: () => nodeSamples.shift(),
  });
  assert.equal(cleanupArmed, true);
  assert.ok(Math.abs(synchronization.uncertaintySeconds - 0.2) < 1e-9);
  assert.ok(Math.abs(synchronization.nodeToHammerspoonOffsetSeconds + 51_793) < 1e-9);
  const alignedNow = synchronization.monotonicNow;
  const events = [
    { type: "move", monotonicSeconds: hammerspoonAtReceipt, x: 0.8, y: 0.1 },
    { type: "click", monotonicSeconds: alignedNow(), x: 0.9, y: 0.2 },
    { type: "click", monotonicSeconds: alignedNow(), x: 0.9, y: 0.3 },
  ];
  await writeFile(rawPath, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
  const normalized = await finalizePointerEvents(rawPath, outputPath);
  assert.ok(Math.abs(normalized[0].time) < 1e-9);
  assert.ok(Math.abs(normalized[1].time - 0.4) < 1e-9);
  assert.ok(Math.abs(normalized[2].time - 1.2) < 1e-9);
  assert.ok(normalized.every((event, index) => index === 0 || event.time >= normalized[index - 1].time));
  assert.ok(normalized.every((event) => event.time >= 0 && event.time <= 2));

  assert.throws(
    () => createHammerspoonAlignedMonotonicNow(
      { started: true, monotonicSeconds: Number.NaN },
      { nodeBefore, nodeAfter },
    ),
    /invalid monotonic timestamp/,
  );
  assert.throws(
    () => createHammerspoonAlignedMonotonicNow(
      { started: true, monotonicSeconds: null },
      { nodeBefore, nodeAfter },
    ),
    /invalid monotonic timestamp/,
  );
  const invalidLater = createHammerspoonAlignedMonotonicNow(
    { started: true, monotonicSeconds: hammerspoonAtReceipt },
    { nodeBefore, nodeAfter },
    () => Number.POSITIVE_INFINITY,
  );
  assert.throws(() => invalidLater(), /invalid monotonic timestamp/);
  const backward = createHammerspoonAlignedMonotonicNow(
    { started: true, monotonicSeconds: hammerspoonAtReceipt },
    { nodeBefore, nodeAfter },
    () => nodeMidpoint - 1,
  );
  assert.throws(() => backward(), /invalid monotonic timestamp/);
  assert.throws(
    () => createHammerspoonAlignedMonotonicNow(
      { started: true, monotonicSeconds: hammerspoonAtReceipt },
      { nodeBefore: nodeMidpoint - 0.6, nodeAfter: nodeMidpoint + 0.6 },
    ),
    /uncertainty 0\.600s exceeds 0\.250s/,
  );
});

test("macOS pointer start arms exact-PID idempotent cleanup before lost or malformed receipts", async () => {
  const cases = [
    {
      name: "lost receipt",
      invoke: async () => { throw new Error("pointer start transport failed"); },
    },
    {
      name: "malformed receipt",
      invoke: async () => ({ started: true, monotonicSeconds: null }),
    },
  ];
  for (const testCase of cases) {
    let pointerCleanupArmed = false;
    let primaryError;
    const startControls = [];
    let nodeTime = 303_268;
    try {
      await startHammerspoonPointerCapture({
        osascriptPath: "/usr/bin/osascript",
        browserPid: 4242,
        pointerOutput: "/tmp/pointer.raw.jsonl",
        privateRoot: "/tmp/private-root",
        armCleanup: () => { pointerCleanupArmed = true; },
        nodeNow: () => { nodeTime += 0.05; return nodeTime; },
        invoke: async (_executable, control) => {
          assert.equal(pointerCleanupArmed, true, `${testCase.name} must arm cleanup before remote start`);
          startControls.push(control);
          return testCase.invoke();
        },
      });
      assert.fail(`${testCase.name} should fail`);
    } catch (error) {
      primaryError = error;
    }
    assert.equal(pointerCleanupArmed, true);
    assert.deepEqual(startControls[0], {
      action: "start-pointer",
      applicationPid: 4242,
      pointerOutput: "/tmp/pointer.raw.jsonl",
    });

    const cleanupControls = [];
    await assert.rejects(
      cleanupMacosCapture({
        pointerStarted: pointerCleanupArmed,
        applicationWatcherStarted: false,
        osascriptPath: "/usr/bin/osascript",
        privateRoot: "/tmp/private-root",
        obs: undefined,
        browser: { pid: 4242 },
        browserPid: 4242,
        rawDir: "/tmp/raw",
        succeeded: false,
        keepProfile: false,
        primaryError,
        invokePointer: async (_executable, control) => {
          cleanupControls.push(control);
          return { stopped: true };
        },
        stopObs: async () => {},
        deleteRecordings: async () => {},
        stopBrowser: async () => {},
        cleanupProfile: async () => {},
      }),
      (error) => error === primaryError,
    );
    assert.deepEqual(cleanupControls, [{ action: "stop-pointer", applicationPid: 4242 }]);
  }
});

test("private capture profiles preseed only the verified extension as pinned", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "chrome-pinned-extension-"));
  context.after(() => import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true })));
  const seeded = await seedPinnedExtensionPreferences(root, config.extensionId);
  const preferences = JSON.parse(await readFile(seeded.preferencesPath, "utf8"));
  assert.deepEqual(preferences.extensions.pinned_extensions, [config.extensionId]);
  assert.deepEqual(preferences.account_values.extensions.pinned_extensions, [config.extensionId]);
  assert.equal((await stat(seeded.preferencesPath)).mode & 0o777, 0o600);
  assert.throws(
    () => validatePinnedExtensionPreferences({
      extensions: { pinned_extensions: [config.extensionId, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"] },
      account_values: { extensions: { pinned_extensions: [config.extensionId] } },
    }, config.extensionId),
    /must contain only the verified extension ID/,
  );
  await assert.rejects(
    seedPinnedExtensionPreferences(root, "not-an-extension-id"),
    /require the verified extension ID/,
  );
});

test("Linux seeds the verified toolbar preference before Chrome and has no menu fallback", async () => {
  const linux = await readFile(new URL(
    "../../scripts/capture/linux/index.mjs",
    import.meta.url,
  ), "utf8");
  const seedIndex = linux.indexOf("await seedPinnedExtensionPreferences(");
  const spawnIndex = linux.indexOf("browser = spawnCommand(");
  assert.ok(seedIndex >= 0, "Linux capture must seed pinned extension preferences");
  assert.ok(spawnIndex >= 0, "Linux capture must spawn Chrome");
  assert.ok(seedIndex < spawnIndex, "Linux capture must seed preferences before Chrome starts");

  const atSpi = await readFile(new URL(
    "../../scripts/capture/linux/open_extension_atspi.py",
    import.meta.url,
  ), "utf8");
  assert.match(atSpi, /preseeded extension toolbar action is absent from Chrome AT-SPI/);
  assert.match(atSpi, /"pressed": True, "pinned": True, "preseeded": True/);
  assert.doesNotMatch(atSpi, /"opened": True/);
  assert.doesNotMatch(atSpi, /Extensions menu|pin to toolbar|"key", "Escape"/);
});

test("Linux capture subprocess environment excludes the bearer token", async () => {
  const environment = linuxCaptureEnvironment(":123", {
    PATH: "/usr/bin",
    DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
    XAUTHORITY: "/home/demo/.Xauthority",
    ACP_URL: "http://127.0.0.1:8080",
    ACP_BEARER_TOKEN: "synthetic-test-credential",
  });
  // Xvfb, Chrome, ffmpeg, xdotool and pyatspi all consume this environment.
  assert.equal(environment.DISPLAY, ":123");
  assert.equal(environment.NO_AT_BRIDGE, "0");
  assert.equal(environment.PATH, "/usr/bin");
  assert.equal(environment.DBUS_SESSION_BUS_ADDRESS, "unix:path=/run/user/1000/bus");
  assert.equal(environment.XAUTHORITY, "/home/demo/.Xauthority");
  assert.equal(Object.hasOwn(environment, "ACP_BEARER_TOKEN"), false);
  assert.equal(JSON.stringify(environment).includes("synthetic-test-credential"), false);

  // Lock the live wiring so it cannot silently revert to raw process.env.
  const linux = await readFile(new URL(
    "../../scripts/capture/linux/index.mjs",
    import.meta.url,
  ), "utf8");
  assert.match(linux, /const captureEnv = linuxCaptureEnvironment\(display\)/);
  assert.doesNotMatch(linux, /\.\.\.process\.env, DISPLAY/);
});

test("macOS launches Chrome with the bearer token stripped from its environment", async () => {
  const macos = await readFile(new URL(
    "../../scripts/capture/macos/index.mjs",
    import.meta.url,
  ), "utf8");
  const spawnStart = macos.indexOf("browser = spawnCommand(");
  const spawnEnd = macos.indexOf("browserPid = browser.pid;");
  assert.ok(spawnStart >= 0 && spawnEnd > spawnStart, "macOS capture must spawn Chrome");
  const chromeSpawn = macos.slice(spawnStart, spawnEnd);
  assert.match(chromeSpawn, /env: sanitizedInheritedEnv\(\)/);
});

test("macOS persistent application watcher fails on transient second apps and expected termination", async () => {
  const clean = {
    expectedPid: 4242,
    expectedTerminated: false,
    otherPids: [],
    stopped: false,
  };
  assert.equal(assertBrowserApplicationWatcherResult(clean, 4242, false), clean);
  assert.throws(
    () => assertBrowserApplicationWatcherResult({
      ...clean,
      otherPids: [4343],
      stopped: true,
    }, 4242, true),
    /observed another Chrome for Testing PID during capture: 4343/,
  );
  assert.throws(
    () => assertBrowserApplicationWatcherResult({
      ...clean,
      expectedTerminated: true,
      stopped: true,
    }, 4242, true),
    /observed expected Chrome for Testing PID 4242 terminate/,
  );

  const calls = [];
  const result = await invokeBrowserApplicationWatcher({
    osascriptPath: "/usr/bin/osascript",
    browserPid: 4242,
    privateRoot: "/private/root",
    action: "start-application-watcher",
    invoke: async (executable, control, privateRoot) => {
      calls.push({ executable, control, privateRoot });
      return clean;
    },
  });
  assert.equal(result, clean);
  assert.deepEqual(calls[0].control, {
    action: "start-application-watcher",
    applicationPid: 4242,
  });
});

test("macOS browser-window preflight requires an exact nonzero CGWindowID and positive AX frame", async () => {
  const calls = [];
  assert.deepEqual(await readBrowserWindowIdentity("/usr/bin/osascript", 4242, async (executable, args) => {
    calls.push({ executable, args });
    return {
      stdout: '{"found":true,"applicationPid":4242,"windowId":13096,"frame":{"x":0,"y":34,"w":1512,"h":948},"role":"AXWindow","subrole":"AXStandardWindow"}\n',
      stderr: "",
    };
  }), {
    applicationPid: 4242,
    windowId: 13096,
    frame: { x: 0, y: 34, width: 1512, height: 948 },
    role: "AXWindow",
    subrole: "AXStandardWindow",
  });
  assert.equal(calls[0].executable, "/usr/bin/osascript");
  assert.match(calls[0].args[0], /run_hammerspoon\.applescript$/);
  assert.equal(calls[0].args[1], browserWindowIdentityCommand(
    "/usr/bin/osascript",
    4242,
  ).args[1]);
  assert.match(calls[0].args[1], /hs\.application\.get\(4242\)/);
  assert.equal(validateBrowserWindowIdentity({
    found: true,
    applicationPid: 4242,
    windowId: 0,
    frame: { x: 0, y: 34, w: 1512, h: 948 },
    role: "AXWindow",
  }, 4242), undefined);
  assert.equal(validateBrowserWindowIdentity({
    found: true,
    applicationPid: 4242,
    windowId: 13096,
    frame: { x: 0, y: 34, w: 0, h: 948 },
    role: "AXWindow",
  }, 4242), undefined);
  assert.equal(validateBrowserWindowIdentity({
    found: true,
    applicationPid: 5151,
    windowId: 13096,
    frame: { x: 0, y: 34, w: 1512, h: 948 },
    role: "AXWindow",
  }, 4242), undefined);
  let attempts = 0;
  await assert.rejects(
    readBrowserWindowIdentity(
      "/usr/bin/osascript",
      4242,
      async () => {
        attempts += 1;
        return { stdout: '{"found":true,"applicationPid":4242,"windowId":0,"frame":{"x":0,"y":0,"w":0,"h":0},"role":"AXWindow"}\n', stderr: "" };
      },
      { timeoutMs: 5, pollIntervalMs: 1 },
    ),
    /did not expose an exact nonzero CGWindowID and positive AX frame within 5ms/,
  );
  assert.ok(attempts > 0);
  await assert.rejects(
    readBrowserWindowIdentity(
      "/usr/bin/osascript",
      4242,
      async () => ({ stdout: "not-json\n", stderr: "" }),
    ),
    /returned invalid JSON/,
  );
  await assert.rejects(
    readBrowserWindowIdentity("/usr/bin/osascript", undefined),
    /requires the launched Chrome PID/,
  );
});

test("macOS OBS launch uses LaunchServices with only the isolated environment", () => {
  const environment = buildObsEnvironment("/private/obs-home", {
    PATH: "/safe/bin",
    ACP_BEARER_TOKEN: "must-not-pass",
  });
  const args = buildObsLaunchServicesArgs({
    environment,
    obsArguments: ["--multi", "--startrecording"],
  });
  assert.deepEqual(args.slice(0, 4), ["-W", "-n", "-a", "/Applications/OBS.app"]);
  const separator = args.indexOf("--args");
  assert.deepEqual(args.slice(separator + 1), ["--multi", "--startrecording"]);
  const forwarded = args.slice(4, separator).join("\n");
  assert.match(forwarded, /HOME=\/private\/obs-home/);
  assert.match(forwarded, /CFFIXED_USER_HOME=\/private\/obs-home/);
  assert.doesNotMatch(forwarded, /ACP_BEARER_TOKEN|must-not-pass/);
  assert.deepEqual(args.slice(separator - 4, separator), [
    "--stdout", "/dev/null", "--stderr", "/dev/null",
  ]);
});

test("macOS OBS PID discovery matches only the exact application executable", async () => {
  const output = [
    "  100 /Applications/OBS.app/Contents/MacOS/OBS --multi",
    "  101 /tmp/OBS.app/Contents/MacOS/OBS --multi",
    "  102 /Applications/OBS.app/Contents/MacOS/OBS-helper",
    "  103 /Applications/OBS.app/Contents/MacOS/OBS",
  ].join("\n");
  assert.deepEqual(parseObsProcessIds(output), [100, 103]);
  await assert.rejects(
    refuseRunningObs(async () => [100]),
    /refuses to run while OBS is already open \(PID 100\)/,
  );
  const child = { exitCode: null };
  assert.equal(await waitForNewObsProcess({
    child,
    previousPids: [90],
    listPids: async () => [90, 100],
    timeoutMs: 100,
  }), 100);
});

test("macOS Chrome preflight refuses only the exact resolved executable and reports its PID", async () => {
  const browserPath = "/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";
  const output = [
    `  200 ${browserPath} --user-data-dir=/tmp/other`,
    "  201 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=/tmp/other",
    `  202 ${browserPath}-helper`,
  ].join("\n");
  assert.deepEqual(parseExecutableProcessIds(output, browserPath), [200]);
  await assert.rejects(
    refuseRunningChromeForTesting(browserPath, async () => [200]),
    /Chrome for Testing is already open.*PID 200/,
  );
  assert.deepEqual(await refuseRunningChromeForTesting(browserPath, async () => []), []);
});

test("macOS OBS cleanup signals only the owned PID and reaps the open wrapper", async () => {
  const signals = [];
  const launcherStops = [];
  let running = true;
  const obs = { pid: 4242, launcher: { name: "open-wrapper" } };
  await stopObsLaunch(obs, {
    listPids: async () => running ? [4242, 9000] : [9000],
    signalProcess: (pid, signal) => {
      signals.push([pid, signal]);
      if (pid === 4242 && signal === "SIGINT") running = false;
    },
    stopLauncher: async (...args) => launcherStops.push(args),
    timeoutMs: 100,
  });
  assert.deepEqual(signals, [[4242, "SIGINT"]]);
  assert.deepEqual(launcherStops, [[obs.launcher, "SIGTERM", 1_000]]);
});

test("macOS OBS cleanup escalates its owned PID to SIGKILL after the bounded graceful wait", async () => {
  const signals = [];
  let running = true;
  await stopObsLaunch({ pid: 4242, launcher: {} }, {
    listPids: async () => running ? [4242] : [],
    signalProcess: (_pid, signal) => {
      signals.push(signal);
      if (signal === "SIGKILL") running = false;
    },
    stopLauncher: async () => {},
    timeoutMs: 0,
  });
  assert.deepEqual(signals, ["SIGINT", "SIGKILL"]);
});

test("macOS recording finalization refuses partial output after the tracked OBS PID exits", async () => {
  const obs = { pid: 4242, launcher: {} };
  await assert.rejects(
    assertTrackedObsProcessRunning(obs, async () => [9000]),
    /tracked OBS process 4242 exited before recording could be finalized/,
  );

  const calls = [];
  await assert.rejects(
    finalizeObsRecording({
      obs,
      rawDir: "/tmp/raw",
      browser: { pid: 4141, exitCode: null, killed: false },
      expectedBrowserPid: 4141,
      stopAndAssertApplicationWatcher: async () => calls.push("stop-watcher"),
      assertBrowserLive: () => calls.push("assert-browser-live"),
      assertRunning: async () => {
        calls.push("assert-running");
        throw new Error("OBS exited");
      },
      stopObs: async () => calls.push("stop"),
      claimRecording: async () => calls.push("claim"),
    }),
    /OBS exited/,
  );
  assert.deepEqual(calls, ["assert-browser-live", "assert-running"]);
});

test("macOS recording finalization refuses output when the application watcher reports a violation", async () => {
  const calls = [];
  await assert.rejects(
    finalizeObsRecording({
      obs: { pid: 4242, launcher: {} },
      rawDir: "/tmp/raw",
      browser: { pid: 4141, exitCode: null, killed: false },
      expectedBrowserPid: 4141,
      stopAndAssertApplicationWatcher: async () => {
        calls.push("stop-watcher");
        throw new Error("second Chrome for Testing instance appeared");
      },
      assertBrowserLive: () => calls.push("assert-browser-live"),
      assertRunning: async () => calls.push("assert-running"),
      stopObs: async () => calls.push("stop"),
      claimRecording: async () => calls.push("claim"),
    }),
    /second Chrome for Testing instance appeared/,
  );
  assert.deepEqual(calls, ["assert-browser-live", "assert-running", "stop", "stop-watcher"]);
});

test("macOS recording finalization rejects an exited original browser ChildProcess", async () => {
  assert.equal(assertOriginalBrowserChildLive({
    pid: 4141,
    exitCode: null,
    killed: false,
  }, 4141), 4141);
  assert.throws(
    () => assertOriginalBrowserChildLive({ pid: 4141, exitCode: 0, killed: false }, 4141),
    /original Chrome ChildProcess 4141 exited/,
  );
  assert.throws(
    () => assertOriginalBrowserChildLive({ pid: 5151, exitCode: null, killed: false }, 4141),
    /ChildProcess PID changed: expected 4141, found 5151/,
  );

  const calls = [];
  await assert.rejects(
    finalizeObsRecording({
      obs: { pid: 4242, launcher: {} },
      rawDir: "/tmp/raw",
      browser: { pid: 4141, exitCode: 1, killed: false },
      expectedBrowserPid: 4141,
      stopAndAssertApplicationWatcher: async () => calls.push("stop-watcher"),
      assertRunning: async () => calls.push("assert-obs-live"),
      stopObs: async () => calls.push("stop-obs"),
      claimRecording: async () => calls.push("claim"),
    }),
    /original Chrome ChildProcess 4141 exited/,
  );
  assert.deepEqual(calls, []);
});

test("macOS recording finalization checks the tracked PID before stop and claim", async () => {
  const calls = [];
  const recording = await finalizeObsRecording({
    obs: { pid: 4242, launcher: {} },
    rawDir: "/tmp/raw",
    browser: { pid: 4141, exitCode: null, killed: false },
    expectedBrowserPid: 4141,
    stopAndAssertApplicationWatcher: async () => calls.push("stop-watcher"),
    assertBrowserLive: () => calls.push("assert-browser-live"),
    assertRunning: async () => calls.push("assert-running"),
    stopObs: async () => calls.push("stop"),
    claimRecording: async () => {
      calls.push("claim");
      return "/tmp/raw/browser.mkv";
    },
  });
  assert.equal(recording, "/tmp/raw/browser.mkv");
  assert.deepEqual(calls, ["assert-browser-live", "assert-running", "stop", "stop-watcher", "claim"]);
});

test("macOS spawn errors reject through the capture path and still allow cleanup", async () => {
  const child = new EventEmitter();
  child.name = "obs";
  const guard = createSpawnGuard(child, "OBS");
  const cleanupCalls = [];
  setImmediate(() => child.emit("error", new Error("synthetic spawn failure")));
  await assert.rejects((async () => {
    let primaryError;
    try {
      await guard.race(new Promise(() => {}));
    } catch (error) {
      primaryError = error;
    } finally {
      await cleanupMacosCapture({
        pointerStarted: false,
        privateRoot: "/private/root",
        obs: child,
        succeeded: false,
        keepProfile: false,
        primaryError,
        stopObs: async (process) => cleanupCalls.push(`stop-${process?.name ?? "none"}`),
        stopBrowser: async (process) => cleanupCalls.push(`stop-${process?.name ?? "none"}`),
        cleanupProfile: async () => cleanupCalls.push("profile-removed"),
      });
    }
  })(), /OBS failed to start: synthetic spawn failure/);
  assert.deepEqual(cleanupCalls, ["stop-obs", "stop-none", "profile-removed"]);
});

test("isolated OBS environment excludes ACP and host credential variables", () => {
  const environment = buildObsEnvironment("/private/obs-home", {
    PATH: "/safe/bin",
    ACP_BEARER_TOKEN: "must-not-pass",
    ACP_URL: "http://internal.invalid",
    GITHUB_TOKEN: "must-not-pass",
    AWS_SECRET_ACCESS_KEY: "must-not-pass",
    SSH_AUTH_SOCK: "/private/agent.sock",
  });
  assert.deepEqual(Object.keys(environment).sort(), [
    "CFFIXED_USER_HOME",
    "HOME",
    "LANG",
    "LC_ALL",
    "PATH",
    "TMPDIR",
    "TZ",
    "XDG_CACHE_HOME",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
  ]);
  assert.equal(environment.PATH, "/safe/bin");
  assert.equal(environment.HOME, "/private/obs-home");
  assert.equal(environment.TMPDIR, "/private/obs-home/tmp");
  assert.equal(JSON.stringify(environment).includes("must-not-pass"), false);
  assert.equal(Object.hasOwn(environment, "ACP_BEARER_TOKEN"), false);
  assert.equal(Object.hasOwn(environment, "SSH_AUTH_SOCK"), false);
});

test("Linux dry run uses Xvfb, headful Chrome accessibility, x11grab, and AT-SPI", () => {
  const commands = buildLinuxDryRun(config, {
    display: ":98",
    browserPath: "/usr/bin/chrome",
    profileDir: "/tmp/private",
    xvfbPath: "/usr/bin/Xvfb",
    ffmpegPath: "/usr/bin/ffmpeg",
    pythonPath: "/usr/bin/python3",
  });
  assert.equal(commands.length, 4);
  assert.ok(commands[1].args.includes("--force-renderer-accessibility"));
  assert.ok(commands[1].args.includes("--window-size=1280,720"));
  assert.ok(commands[2].args.includes("x11grab"));
  assert.match(commands[3].args[0], /open_extension_atspi\.py$/);
});

test("Linux dry run AT-SPI step mirrors the live toolbar-press invocation contract", () => {
  const commands = buildLinuxDryRun({ ...config, extensionName: "ACP Demo Extension" }, {
    display: ":98",
    browserPath: "/usr/bin/chrome",
    profileDir: "/tmp/private",
    xvfbPath: "/usr/bin/Xvfb",
    ffmpegPath: "/usr/bin/ffmpeg",
    pythonPath: "/usr/bin/python3",
    xdotoolPath: "/usr/bin/xdotool",
  });
  const atspi = commands.at(-1);
  assert.equal(atspi.executable, "/usr/bin/python3");
  assert.match(atspi.args[0], /open_extension_atspi\.py$/);

  // Every option open_extension_atspi.py marks required=True, plus the explicit
  // application name the live invokeAtSpi always passes, must appear in the plan.
  // Otherwise the emitted command is neither runnable nor a faithful mirror of
  // the capture-time toolbar press (argparse would reject the missing options).
  const valueAfter = (flag) => {
    const index = atspi.args.indexOf(flag);
    assert.ok(index >= 0, `dry-run AT-SPI command must pass ${flag}`);
    const value = atspi.args[index + 1];
    assert.ok(
      typeof value === "string" && value.length > 0 && !value.startsWith("--"),
      `${flag} must be followed by an operand in the dry-run plan`,
    );
    return value;
  };
  assert.equal(valueAfter("--application-name"), "Google Chrome for Testing");
  assert.equal(valueAfter("--extension-name"), "ACP Demo Extension");
  assert.equal(valueAfter("--extension-id"), config.extensionId);
  assert.equal(valueAfter("--xdotool"), "/usr/bin/xdotool");
  for (const flag of ["--pointer-output", "--window-x", "--window-y", "--window-width", "--window-height"]) {
    valueAfter(flag);
  }
});

test("native panel pointer projection uses browser dimensions rather than recording canvas dimensions", async () => {
  for (const adapter of ["macos", "linux"]) {
    const source = await readFile(new URL(
      `../../scripts/capture/${adapter}/index.mjs`,
      import.meta.url,
    ), "utf8");
    assert.match(source, /captureWidth: config\.browserWidth/);
    assert.match(source, /captureHeight: config\.browserHeight/);
    assert.doesNotMatch(source, /captureWidth: config\.width/);
    assert.doesNotMatch(source, /captureHeight: config\.height/);
  }
});

test("Linux recording scales the browser window to a fixed-size canvas without cursor or host audio", () => {
  const args = ffmpegArgs(config, ":99", "/tmp/raw.mp4");
  assert.deepEqual(args.slice(args.indexOf("-video_size"), args.indexOf("-video_size") + 2), ["-video_size", "1280x720"]);
  assert.deepEqual(args.slice(args.indexOf("-draw_mouse"), args.indexOf("-draw_mouse") + 2), ["-draw_mouse", "0"]);
  assert.deepEqual(args.slice(args.indexOf("-vf"), args.indexOf("-vf") + 2), ["-vf", "scale=1920:1080:flags=lanczos,setsar=1"]);
  assert.ok(args.includes("30"));
  assert.ok(args.includes("-an"));
  assert.ok(args.includes("yuv420p"));
});

test("Linux recorder requires a clean exit and a non-empty output", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "linux-recorder-"));
  const outputPath = path.join(root, "browser.mp4");
  await assert.rejects(
    validateLinuxRecording({ child: { exitCode: 1 }, stderr: "encoder failed", outputPath }),
    /exited 1: encoder failed/,
  );
  await assert.rejects(
    validateLinuxRecording({ child: { exitCode: 0 }, outputPath }),
    /produced no output file/,
  );
  await writeFile(outputPath, "");
  await assert.rejects(
    validateLinuxRecording({ child: { exitCode: 0 }, outputPath }),
    /empty output file/,
  );
  await writeFile(outputPath, "video");
  assert.deepEqual(
    await validateLinuxRecording({ child: { exitCode: 0 }, outputPath }),
    { exitCode: 0, sizeBytes: 5 },
  );
});

test("macOS cleanup releases pointer ownership and removes failed profiles without masking the capture error", async () => {
  const calls = [];
  const original = new Error("panel action failed");
  const pointerError = new Error("pointer stop failed");
  await assert.rejects(
    cleanupMacosCapture({
      pointerStarted: true,
      osascriptPath: "/usr/bin/osascript",
      privateRoot: "/tmp/private-root",
      obs: { name: "obs" },
      browser: { name: "browser", pid: 4242 },
      browserPid: 4242,
      succeeded: false,
      keepProfile: true,
      primaryError: original,
      invokePointer: async (_executable, control) => {
        calls.push(`${control.action}-${control.applicationPid}`);
        throw pointerError;
      },
      stopObs: async (child) => calls.push(`stop-${child.name}`),
      stopBrowser: async (child) => calls.push(`stop-${child.name}`),
      cleanupProfile: async (_root, keep) => calls.push(`profile-keep-${keep}`),
    }),
    (error) => {
      assert.equal(error, original);
      assert.deepEqual(error.cleanupErrors, [pointerError]);
      return true;
    },
  );
  assert.deepEqual(calls, ["stop-pointer-4242", "stop-obs", "stop-browser", "profile-keep-false"]);
});

test("failed macOS cleanup deletes unclaimed and claimed OBS recordings after stopping OBS", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "obs-partial-cleanup-"));
  const rawDir = path.join(root, "raw");
  await mkdir(rawDir);
  const partials = [
    "raw-browser.mkv",
    "raw-browser-1.mp4",
    "raw-browser-retry.mov",
  ];
  await Promise.all(partials.map((name) => writeFile(path.join(rawDir, name), "partial")));
  await writeFile(path.join(rawDir, "browser.mkv"), "claimed-output");
  context.after(() => import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true })));

  const calls = [];
  let obsStopped = false;
  await cleanupMacosCapture({
    pointerStarted: false,
    applicationWatcherStarted: true,
    osascriptPath: "/usr/bin/osascript",
    privateRoot: "/tmp/private-root",
    obs: { name: "obs" },
    browser: { name: "browser", pid: 4242 },
    browserPid: 4242,
    rawDir,
    succeeded: false,
    keepProfile: false,
    invokeApplicationWatcher: async (_executable, control) => {
      calls.push(`${control.action}-${control.applicationPid}`);
      return {
        expectedPid: 4242,
        expectedTerminated: false,
        otherPids: [],
        stopped: true,
      };
    },
    stopObs: async () => {
      calls.push("stop-obs");
      obsStopped = true;
    },
    deleteRecordings: async (directory) => {
      assert.equal(obsStopped, true);
      calls.push("delete-raw");
      return deleteObsCaptureRecordings(directory);
    },
    stopBrowser: async () => calls.push("stop-browser"),
    cleanupProfile: async () => calls.push("cleanup-profile"),
  });
  assert.deepEqual(calls, [
    "stop-obs",
    "stop-application-watcher-4242",
    "delete-raw",
    "stop-browser",
    "cleanup-profile",
  ]);
  for (const name of partials) {
    await assert.rejects(stat(path.join(rawDir, name)), /ENOENT/);
  }
  await assert.rejects(stat(path.join(rawDir, "browser.mkv")), /ENOENT/);
});

test("macOS waits for a non-empty isolated OBS recording before interaction", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "obs-readiness-"));
  const rawDir = path.join(root, "raw");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(rawDir));
  context.after(() => import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true })));
  setTimeout(() => writeFile(path.join(rawDir, "raw-browser.mkv"), "header"), 10);
  const proof = await waitForObsRecordingReady({
    child: { exitCode: null },
    rawDir,
    obsHome: path.join(root, "obs-home"),
    timeoutMs: 1_000,
  });
  assert.equal(proof.proof, "non-empty-isolated-recording");
  assert.equal(proof.sizeBytes, 6);
  await assert.rejects(
    waitForObsRecordingReady({
      child: { exitCode: 2 },
      rawDir: path.join(root, "missing"),
      obsHome: path.join(root, "obs-home"),
      timeoutMs: 10,
    }),
    /exited 2 before recording readiness/,
  );
});

test("macOS OBS config suppresses permission onboarding and binds Chrome to its exact CGWindowID", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "obs-config-"));
  const obsHome = path.join(root, "obs-home");
  const outputDir = path.join(root, "raw");
  await mkdir(outputDir);
  context.after(() => import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true })));
  await writeObsConfiguration({
    obsHome,
    outputDir,
    width: 1920,
    height: 1080,
    fps: 30,
    bundleId: "com.google.chrome.for.testing",
    windowId: 13096,
  });
  const globalConfig = await readFile(path.join(
    obsHome,
    "Library/Application Support/obs-studio/global.ini",
  ), "utf8");
  const collection = JSON.parse(await readFile(path.join(
    obsHome,
    "Library/Application Support/obs-studio/basic/scenes/ACP Demo Creator.json",
  ), "utf8"));
  const source = collection.sources.find((candidate) => candidate.id === "screen_capture");
  assert.match(globalConfig, /^MacOSPermissionsDialogLastShown=1$/m);
  assert.equal(source.settings.application, "com.google.chrome.for.testing");
  assert.equal(source.settings.window, 13096);
  assert.equal("display" in source.settings, false);
  assert.equal("display_uuid" in source.settings, false);
  assert.equal(source.settings.type, 1);
  assert.equal(source.settings.show_cursor, false);
  await assert.rejects(
    writeObsConfiguration({
      obsHome: path.join(root, "invalid-obs-home"),
      outputDir,
      width: 1920,
      height: 1080,
      fps: 30,
      bundleId: "com.google.chrome.for.testing",
      windowId: 0,
    }),
    /positive CGWindowID/,
  );
});

test("macOS OBS denial log wins over a non-empty partial recording", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "obs-permission-"));
  const obsHome = path.join(root, "obs-home");
  const rawDir = path.join(root, "raw");
  const logsDir = path.join(obsHome, "Library/Application Support/obs-studio/logs");
  await mkdir(rawDir, { recursive: true });
  await mkdir(logsDir, { recursive: true });
  await writeFile(path.join(logsDir, "obs.txt"), "[macOS] Permission for screen capture denied.\n");
  await writeFile(path.join(rawDir, "raw-browser.mkv"), "partial-output");
  context.after(() => import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true })));
  await assert.rejects(
    waitForObsRecordingReady({ child: { exitCode: null }, rawDir, obsHome, timeoutMs: 1_000 }),
    /does not have macOS Screen Recording permission/,
  );
});

test("macOS OBS ScreenCaptureKit initialization failure wins over partial media", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "obs-source-init-"));
  const obsHome = path.join(root, "obs-home");
  const rawDir = path.join(root, "raw");
  const logsDir = path.join(obsHome, "Library/Application Support/obs-studio/logs");
  await mkdir(rawDir, { recursive: true });
  await mkdir(logsDir, { recursive: true });
  await writeFile(
    path.join(logsDir, "obs.txt"),
    "[ mac-screencapture ]: init_screen_stream: Invalid target window ID: 13096\n",
  );
  await writeFile(path.join(rawDir, "raw-browser.mkv"), "partial-output");
  context.after(() => import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true })));
  await assert.rejects(
    waitForObsRecordingReady({ child: { exitCode: null }, rawDir, obsHome, timeoutMs: 1_000 }),
    /ScreenCaptureKit source failed to initialize/,
  );
});

test("macOS luma parsing rejects uniform-black capture and accepts a bounded nonblack sample", async () => {
  const black = [
    "frame:0 pts:0 pts_time:0",
    "lavfi.signalstats.YMIN=16",
    "lavfi.signalstats.YAVG=16",
    "lavfi.signalstats.YMAX=16",
    "frame:1 pts:1 pts_time:1",
    "lavfi.signalstats.YMIN=16",
    "lavfi.signalstats.YAVG=16",
    "lavfi.signalstats.YMAX=16",
  ].join("\n");
  const nonblack = `${black}\nframe:2 pts:2 pts_time:2\nlavfi.signalstats.YMIN=16\nlavfi.signalstats.YAVG=112.5\nlavfi.signalstats.YMAX=235\n`;
  assert.deepEqual(parseSignalstatsLuma(black), [
    { ymin: 16, yavg: 16, ymax: 16 },
    { ymin: 16, yavg: 16, ymax: 16 },
  ]);

  const calls = [];
  await assert.rejects(
    validateMacosRecordingLuma("/tmp/black.mkv", "/usr/bin/ffmpeg", async (executable, args) => {
      calls.push({ executable, args });
      return { stdout: black, stderr: "" };
    }),
    /uniform-black capture/,
  );
  const result = await validateMacosRecordingLuma(
    "/tmp/nonblack.mkv",
    "/usr/bin/ffmpeg",
    async () => ({ stdout: nonblack, stderr: "" }),
  );
  assert.deepEqual(result, {
    sampleCount: 3,
    meaningfulFrameCount: 1,
    minimumRequiredRange: 8,
    minimumRequiredAverage: 18,
    maximumObservedRange: 219,
  });
  assert.equal(calls[0].executable, "/usr/bin/ffmpeg");
  assert.deepEqual(calls[0].args, macosSignalstatsArgs("/tmp/black.mkv"));
  assert.equal(calls[0].args[calls[0].args.indexOf("-frames:v") + 1], "6");
  assert.throws(
    () => macosSignalstatsArgs("/tmp/video.mkv", 7),
    /samples between 1 and 6 frames/,
  );
});

test("macOS luma failure remains primary while failed cleanup deletes claimed media", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "obs-black-cleanup-"));
  const rawDir = path.join(root, "raw");
  const claimed = path.join(rawDir, "browser.mkv");
  await mkdir(rawDir, { recursive: true });
  await writeFile(claimed, "black-video-placeholder");
  context.after(() => import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true })));

  let lumaFailure;
  try {
    await validateMacosRecordingLuma(claimed, "/usr/bin/ffmpeg", async () => ({
      stdout: [
        "frame:0 pts:0 pts_time:0",
        "lavfi.signalstats.YMIN=16",
        "lavfi.signalstats.YAVG=16",
        "lavfi.signalstats.YMAX=16",
      ].join("\n"),
      stderr: "",
    }));
  } catch (error) {
    lumaFailure = error;
  }
  assert.match(lumaFailure?.message ?? "", /uniform-black capture/);
  await assert.rejects(
    cleanupMacosCapture({
      pointerStarted: false,
      applicationWatcherStarted: false,
      privateRoot: root,
      rawDir,
      succeeded: false,
      keepProfile: false,
      primaryError: lumaFailure,
      stopObs: async () => {},
      stopBrowser: async () => {},
      cleanupProfile: async () => {},
    }),
    (error) => error === lumaFailure,
  );
  await assert.rejects(stat(claimed), /ENOENT/);
});

test("failed macOS capture retains only bounded redacted OBS diagnostics", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "obs-diagnostics-"));
  const obsHome = path.join(root, "private", "obs-home");
  const outputDir = path.join(root, "output");
  const logsDir = path.join(obsHome, "Library/Application Support/obs-studio/logs");
  const chromeProfile = path.join(root, "private", "chrome-profile");
  const secret = "synthetic-sensitive-value-123456789";
  await mkdir(logsDir, { recursive: true });
  await mkdir(chromeProfile, { recursive: true });
  await writeFile(path.join(chromeProfile, "must-not-copy"), secret);
  await writeFile(path.join(logsDir, "obs.txt"), `${"x".repeat(70 * 1024)}\nBearer ${secret}\n`);
  context.after(() => import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true })));

  const retained = await preserveObsFailureDiagnostics({
    obsHome,
    outputDir,
    error: new Error(`OBS failed with ${secret}`),
    environment: { ACP_BEARER_TOKEN: secret, ACP_PROJECT: "x" },
  });
  const logText = await readFile(retained.retainedLog, "utf8");
  const summaryText = await readFile(retained.summaryPath, "utf8");
  const summary = JSON.parse(summaryText);
  assert.equal(logText.includes(secret), false);
  assert.equal(summaryText.includes(secret), false);
  assert.ok((await stat(retained.retainedLog)).size <= 64 * 1024);
  assert.equal(summary.maximumLogBytes, 64 * 1024);
  assert.equal(summary.chromeProfileRetained, false);
  await assert.rejects(stat(path.join(retained.diagnosticsDir, "must-not-copy")), /ENOENT/);

  const emptyObsHome = path.join(root, "private", "empty-obs-home");
  const second = await preserveObsFailureDiagnostics({
    obsHome: emptyObsHome,
    outputDir,
    error: new Error("second failure has no OBS log"),
    environment: {},
  });
  const secondSummary = JSON.parse(await readFile(second.summaryPath, "utf8"));
  assert.equal(second.retainedLog, undefined);
  assert.equal(secondSummary.logFound, false);
  await assert.rejects(stat(path.join(second.diagnosticsDir, "latest.log")), /ENOENT/);
});

test("Linux cleanup removes a failed private profile even when keepProfile was requested", async () => {
  const calls = [];
  const original = new Error("AT-SPI failed");
  await assert.rejects(
    cleanupLinuxCapture({
      ffmpeg: { name: "ffmpeg" },
      browser: { name: "browser" },
      xvfb: { name: "xvfb" },
      privateRoot: "/tmp/private-root",
      succeeded: false,
      keepProfile: true,
      primaryError: original,
      stop: async (child) => calls.push(`stop-${child.name}`),
      cleanupProfile: async (_root, keep) => calls.push(`profile-keep-${keep}`),
    }),
    (error) => error === original,
  );
  assert.deepEqual(calls, ["stop-ffmpeg", "stop-browser", "stop-xvfb", "profile-keep-false"]);
});

test("public capture contract dispatches dry runs without requiring installed native tools", async () => {
  const result = await captureScenario({
    scenarioDir: "/tmp/scenario",
    outputDir: "/tmp/output",
    captureOptions: {
      platform: "linux",
      dryRun: true,
      extensionDir: "/tmp/scenario/extension",
    },
    scenario: {
      fps: 30,
      story: [{ type: "browser", durationSeconds: 5 }],
      extension: {
        expectedId: config.extensionId,
      },
    },
  });
  assert.equal(result.platform, "linux");
  assert.equal(result.nativeBrowser, true);
  assert.equal(result.dryRun, true);
  assert.equal(result.commands[0].executable, "<Xvfb>");
});

test("doctor reports unsupported platforms rather than falling back to a simulated panel", async () => {
  const result = await doctorCapture({
    scenarioDir: path.sep,
    captureOptions: { platform: "win32", dryRun: true },
    scenario: {},
  });
  assert.equal(result.ok, false);
  assert.match(result.checks[0].detail, /macOS or Linux/);
});

test("live capture requires the seeded project during cleanup without masking capture failure", async () => {
  const calls = [];
  const environment = { ACP_URL: "http://127.0.0.1:7777" };
  const original = new Error("native capture failed");
  const cleanupProblem = new Error("cleanup also failed");
  await assert.rejects(
    captureScenario({
      repoRoot: "/tmp/repo",
      scenarioDir: "/tmp/scenario",
      outputDir: "/tmp/output",
      captureOptions: { platform: "linux" },
      scenario: {
        acp: { project: "demo-example" },
        extension: { expectedId: config.extensionId },
      },
    }, {
      environment,
      seedAcpProject: async () => ({ action: "created" }),
      verifyAcpProject: async () => ({ action: "verified" }),
      buildExtensionGate: async () => {
        throw original;
      },
      cleanupAcpProject: async (_scenario, options) => {
        calls.push({ name: "cleanup", options });
        throw cleanupProblem;
      },
    }),
    (error) => {
      assert.equal(error, original);
      assert.deepEqual(error.cleanupErrors, [cleanupProblem]);
      return true;
    },
  );
  assert.deepEqual(calls, [{
    name: "cleanup",
    options: { environment, expectPresent: true, keepProject: false },
  }]);
});

test("keepProject still runs ownership and determinism cleanup verification", async () => {
  const environment = { ACP_URL: "http://127.0.0.1:7777" };
  let cleanupOptions;
  await assert.rejects(
    captureScenario({
      repoRoot: "/tmp/repo",
      scenarioDir: "/tmp/scenario",
      outputDir: "/tmp/output",
      keepProject: true,
      captureOptions: { platform: "linux" },
      scenario: { acp: { project: "demo-example" }, extension: { expectedId: config.extensionId } },
    }, {
      environment,
      seedAcpProject: async () => ({ action: "created" }),
      verifyAcpProject: async () => { throw new Error("verify failed"); },
      cleanupAcpProject: async (_scenario, options) => {
        cleanupOptions = options;
        return { action: "kept" };
      },
    }),
    /verify failed/,
  );
  assert.deepEqual(cleanupOptions, { environment, expectPresent: true, keepProject: true });
});
