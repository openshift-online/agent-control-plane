import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import {
  chromeLaunchArgs,
  commandOutput,
  cleanupFailure,
  cleanupPrivateProfile,
  createTemporaryConnectionRegistry,
  appendPointerEvent,
  finalizePointerEvents,
  findExecutable,
  makePrivateTempDir,
  MACOS_CHROME_FOR_TESTING_BUNDLE_ID,
  monotonicSeconds,
  PINNED_CHROME_FOR_TESTING_VERSION,
  remainingCaptureHoldMilliseconds,
  sanitizedInheritedEnv,
  seedPinnedExtensionPreferences,
  spawnCommand,
  stopProcess,
  verifyExtensionArtifact,
  verifyPinnedChromeForTesting,
  waitForDevToolsPort,
  writePrivateJson,
} from "../common.mjs";
import {
  attachNativePanel,
  readCdpTargets,
  waitForNativePanelTarget,
} from "../native-panel.mjs";
import { redactText } from "../../core/security.mjs";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const MAX_OBS_DIAGNOSTIC_BYTES = 64 * 1024;
const OBS_APP_PATH = "/Applications/OBS.app";
const OBS_EXECUTABLE_PATH = `${OBS_APP_PATH}/Contents/MacOS/OBS`;
const OPEN_EXECUTABLE_PATH = "/usr/bin/open";
export const MAX_HAMMERSPOON_CLOCK_UNCERTAINTY_SECONDS = 0.25;
export const MACOS_LUMA_SAMPLE_LIMIT = 6;
export const MINIMUM_MEANINGFUL_LUMA_RANGE = 8;
export const MINIMUM_VISIBLE_LUMA_AVERAGE = 18;
export const MACOS_WINDOW_PREFLIGHT_TIMEOUT_MS = 10_000;

const OBS_ARGUMENTS = [
  "--multi",
  "--disable-shutdown-check",
  "--disable-updater",
  "--disable-missing-files-check",
  "--only-bundled-plugins",
  "--verbose",
  "--profile",
  "ACP Demo Creator",
  "--collection",
  "ACP Demo Creator",
  "--minimize-to-tray",
  "--startrecording",
];

export function createSpawnGuard(child, label) {
  const failure = new Promise((_, reject) => {
    child.once("error", (error) => {
      reject(new Error(`${label} failed to start: ${error.message}`, { cause: error }));
    });
  });
  // Attach a handler immediately so an error emitted before the first race can
  // never become an unhandled EventEmitter failure.
  failure.catch(() => {});
  return {
    race(operation) {
      return Promise.race([operation, failure]);
    },
  };
}

export function buildObsEnvironment(obsHome, hostEnvironment = process.env) {
  const pathValue = hostEnvironment.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin";
  return {
    PATH: pathValue,
    LANG: "en_US.UTF-8",
    LC_ALL: "en_US.UTF-8",
    TZ: "UTC",
    HOME: obsHome,
    CFFIXED_USER_HOME: obsHome,
    TMPDIR: path.join(obsHome, "tmp"),
    XDG_CONFIG_HOME: path.join(obsHome, ".config"),
    XDG_CACHE_HOME: path.join(obsHome, ".cache"),
    XDG_DATA_HOME: path.join(obsHome, ".local", "share"),
  };
}

export function buildObsLaunchServicesArgs({
  environment,
  appPath = OBS_APP_PATH,
  obsArguments = OBS_ARGUMENTS,
}) {
  const environmentArguments = Object.entries(environment)
    .flatMap(([name, value]) => ["--env", `${name}=${value}`]);
  return [
    "-W",
    "-n",
    "-a",
    appPath,
    ...environmentArguments,
    "--stdout",
    "/dev/null",
    "--stderr",
    "/dev/null",
    "--args",
    ...obsArguments,
  ];
}

export function parseExecutableProcessIds(output, executablePath) {
  const escapedPath = executablePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const processPattern = new RegExp(`^\\s*(\\d+)\\s+${escapedPath}(?:\\s|$)`);
  return String(output)
    .split(/\r?\n/)
    .map((line) => line.match(processPattern)?.[1])
    .filter(Boolean)
    .map(Number);
}

export function parseObsProcessIds(output, executablePath = OBS_EXECUTABLE_PATH) {
  return parseExecutableProcessIds(output, executablePath);
}

export async function listExecutableProcessIds(executablePath, runCommand = commandOutput) {
  const { stdout } = await runCommand("/bin/ps", ["-axo", "pid=,command="]);
  return parseExecutableProcessIds(stdout, executablePath);
}

export async function listObsProcessIds(runCommand = commandOutput) {
  return listExecutableProcessIds(OBS_EXECUTABLE_PATH, runCommand);
}

export async function refuseRunningObs(listPids = listObsProcessIds) {
  const pids = await listPids();
  if (pids.length > 0) {
    throw new Error(
      `native macOS capture refuses to run while OBS is already open (PID${pids.length === 1 ? "" : "s"} ${pids.join(", ")}); quit OBS and retry`,
    );
  }
  return pids;
}

export async function refuseRunningChromeForTesting(
  browserPath,
  listPids = () => listExecutableProcessIds(browserPath),
) {
  const pids = await listPids();
  if (pids.length > 0) {
    throw new Error(
      `native macOS capture refuses to run while Chrome for Testing is already open from ${browserPath} (PID${pids.length === 1 ? "" : "s"} ${pids.join(", ")}); quit it and retry`,
    );
  }
  return pids;
}

export async function waitForNewObsProcess({
  child,
  previousPids = [],
  listPids = listObsProcessIds,
  timeoutMs = 10_000,
}) {
  const previous = new Set(previousPids);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child?.exitCode !== null) {
      throw new Error(`LaunchServices exited ${child?.exitCode} before OBS started`);
    }
    const newPids = (await listPids()).filter((pid) => !previous.has(pid));
    if (newPids.length === 1) return newPids[0];
    if (newPids.length > 1) {
      throw new Error(`LaunchServices started multiple OBS processes (${newPids.join(", ")})`);
    }
    await delay(100);
  }
  throw new Error("LaunchServices did not start the expected OBS application process");
}

async function waitForObsProcessExit(pid, listPids, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await listPids()).includes(pid)) return true;
    await delay(100);
  }
  return !(await listPids()).includes(pid);
}

export async function stopObsLaunch(obs, {
  listPids = listObsProcessIds,
  signalProcess = process.kill,
  stopLauncher = stopProcess,
  timeoutMs = 10_000,
} = {}) {
  if (!obs) return;
  let cleanupError;
  try {
    let pid = obs.pid;
    if (!pid) {
      const previous = new Set(obs.previousPids ?? []);
      const candidates = (await listPids()).filter((candidate) => !previous.has(candidate));
      if (candidates.length > 1) {
        throw new Error(`refusing ambiguous OBS cleanup for PIDs ${candidates.join(", ")}`);
      }
      [pid] = candidates;
    }
    if (pid && (await listPids()).includes(pid)) {
      try {
        signalProcess(pid, "SIGINT");
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
      if (!(await waitForObsProcessExit(pid, listPids, timeoutMs))) {
        if ((await listPids()).includes(pid)) signalProcess(pid, "SIGKILL");
        if (!(await waitForObsProcessExit(pid, listPids, timeoutMs))) {
          throw new Error(`OBS process ${pid} did not exit after SIGKILL`);
        }
      }
    }
  } catch (error) {
    cleanupError = error;
  }
  let launcherError;
  try {
    await stopLauncher(obs.launcher, "SIGTERM", 1_000);
  } catch (error) {
    launcherError = error;
  }
  if (cleanupError) {
    if (launcherError) cleanupError.cleanupErrors = [launcherError];
    throw cleanupError;
  }
  if (launcherError) throw launcherError;
}

export async function assertTrackedObsProcessRunning(
  obs,
  listPids = listObsProcessIds,
) {
  if (!Number.isInteger(obs?.pid) || obs.pid <= 0) {
    throw new Error("cannot finalize recording without an exact tracked OBS PID");
  }
  if (!(await listPids()).includes(obs.pid)) {
    throw new Error(`tracked OBS process ${obs.pid} exited before recording could be finalized`);
  }
  return obs.pid;
}

export function assertOriginalBrowserChildLive(browser, expectedPid) {
  if (!Number.isInteger(expectedPid) || expectedPid <= 0) {
    throw new Error("cannot finalize recording without the original Chrome PID");
  }
  if (browser?.pid !== expectedPid) {
    throw new Error(`Chrome ChildProcess PID changed: expected ${expectedPid}, found ${browser?.pid ?? "none"}`);
  }
  if (browser.exitCode !== null || browser.killed === true) {
    throw new Error(`original Chrome ChildProcess ${expectedPid} exited before recording could be finalized`);
  }
  return expectedPid;
}

export async function finalizeObsRecording({
  obs,
  rawDir,
  browser,
  expectedBrowserPid,
  stopAndAssertApplicationWatcher,
  assertBrowserLive = assertOriginalBrowserChildLive,
  assertRunning = assertTrackedObsProcessRunning,
  stopObs = stopObsLaunch,
  claimRecording = claimObsRecording,
}) {
  if (typeof stopAndAssertApplicationWatcher !== "function") {
    throw new Error("cannot finalize recording without stopping and checking the application watcher");
  }
  assertBrowserLive(browser, expectedBrowserPid);
  await assertRunning(obs);
  await stopObs(obs);
  await stopAndAssertApplicationWatcher();
  return claimRecording(rawDir);
}

export async function doctorMacos(config, env = process.env) {
  const checks = await Promise.all([
    executableCheck(
      "chrome-for-testing",
      config.browserPath,
      "/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
      path.join(env.HOME ?? "", "Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"),
    ),
    executableCheck("hammerspoon-applescript", "osascript"),
    executableCheck("hammerspoon-app", "/Applications/Hammerspoon.app/Contents/MacOS/Hammerspoon"),
    executableCheck("obs", OBS_EXECUTABLE_PATH),
    executableCheck(
      "ffmpeg",
      config.ffmpegPath,
      env.DEMO_FFMPEG,
      "/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg",
      "/opt/homebrew/bin/ffmpeg",
      "/usr/local/opt/ffmpeg-full/bin/ffmpeg",
      "ffmpeg",
    ),
  ]);
  const chromePath = checks.find((check) => check.name === "chrome-for-testing")?.path;
  if (chromePath) {
    try {
      const version = await verifyPinnedChromeForTesting(chromePath);
      checks.push({ name: "chrome-for-testing-version", ok: true, detail: version });
    } catch (error) {
      checks.push({ name: "chrome-for-testing-version", ok: false, detail: error.message });
    }
  } else {
    checks.push({
      name: "chrome-for-testing-version",
      ok: false,
      detail: `install Chrome for Testing ${PINNED_CHROME_FOR_TESTING_VERSION}`,
    });
  }
  checks.push({
    name: "macos-permissions",
    ok: false,
    manual: true,
    detail: "Hammerspoon Accessibility and OBS Screen Recording permissions require an interactive macOS grant",
  });
  return { platform: "darwin", ok: checks.every((check) => check.ok || check.manual), checks };
}

async function executableCheck(name, ...candidates) {
  const executablePath = await findExecutable(candidates);
  return {
    name,
    ok: Boolean(executablePath),
    path: executablePath,
    detail: executablePath ? undefined : `missing ${name}`,
  };
}

export function buildMacosDryRun(config, paths = {}) {
  const browserPath = paths.browserPath ?? config.browserPath ?? "<chrome-for-testing>";
  const profileDir = paths.profileDir ?? "<private-profile>";
  const osascriptPath = paths.osascriptPath ?? "<osascript>";
  const openPath = paths.openPath ?? OPEN_EXECUTABLE_PATH;
  const obsHome = paths.obsHome ?? "<private-obs-home>";
  const browserPid = paths.browserPid ?? "<chrome-for-testing-pid>";
  const browserBundleId = config.browserBundleId ?? MACOS_CHROME_FOR_TESTING_BUNDLE_ID;
  const obsEnvironment = buildObsEnvironment(obsHome, { PATH: "<allowlisted-path>" });
  return [
    {
      executable: browserPath,
      args: chromeLaunchArgs({
        ...config,
        extraBrowserArgs: [...config.extraBrowserArgs, "--force-renderer-accessibility"],
      }, profileDir),
    },
    browserBundleProcessIdsCommand(osascriptPath, browserPid, browserBundleId),
    browserWindowIdentityCommand(osascriptPath, browserPid),
    {
      executable: openPath,
      args: buildObsLaunchServicesArgs({ environment: obsEnvironment }),
    },
    {
      executable: osascriptPath,
      args: [
        path.join(moduleDir, "run_hammerspoon.applescript"),
        `local m=dofile(${JSON.stringify(path.join(moduleDir, "open_extension.lua"))}); return hs.json.encode(m.run(${JSON.stringify("<control-json>")}))`,
      ],
    },
  ];
}

export function browserBundleProcessIdsCommand(osascriptPath, browserPid, bundleId) {
  const applicationHint = Number.isInteger(browserPid)
    ? String(browserPid)
    : JSON.stringify(String(browserPid));
  const source = [
    `local expected=hs.application.get(${applicationHint})`,
    "local expectedBundle=expected and expected:bundleID() or nil",
    `local apps=hs.application.applicationsForBundleID(${JSON.stringify(bundleId)})`,
    "local pids={}",
    "for _,app in ipairs(apps) do table.insert(pids,app:pid()) end",
    "table.sort(pids)",
    "return hs.json.encode({expectedFound=expected~=nil,expectedBundle=expectedBundle,pids=pids})",
  ].join("; ");
  return {
    executable: osascriptPath,
    args: [
      path.join(moduleDir, "run_hammerspoon.applescript"),
      source,
    ],
  };
}

export async function assertExclusiveBrowserBundle(
  osascriptPath,
  browserPid,
  bundleId = MACOS_CHROME_FOR_TESTING_BUNDLE_ID,
  runCommand = commandOutput,
) {
  if (!Number.isInteger(browserPid) || browserPid <= 0) {
    throw new Error("Hammerspoon bundle-exclusivity preflight requires the launched Chrome PID");
  }
  if (bundleId !== MACOS_CHROME_FOR_TESTING_BUNDLE_ID) {
    throw new Error(`Hammerspoon bundle-exclusivity preflight requires ${MACOS_CHROME_FOR_TESTING_BUNDLE_ID}`);
  }
  const command = browserBundleProcessIdsCommand(osascriptPath, browserPid, bundleId);
  let output;
  try {
    output = await runCommand(command.executable, command.args);
  } catch (error) {
    throw new Error(`Hammerspoon bundle-exclusivity preflight failed: ${error.message}`, { cause: error });
  }
  const line = output.stdout.trim().split(/\r?\n/).at(-1);
  let proof;
  try {
    proof = JSON.parse(line);
  } catch (error) {
    throw new Error("Hammerspoon bundle-exclusivity preflight returned invalid JSON", { cause: error });
  }
  const pids = Array.isArray(proof?.pids) ? proof.pids : [];
  if (
    proof?.expectedFound !== true
    || proof?.expectedBundle !== bundleId
    || pids.length !== 1
    || pids[0] !== browserPid
  ) {
    const found = pids.length > 0 ? pids.join(", ") : "none";
    throw new Error(
      `Chrome for Testing bundle exclusivity failed: expected sole PID ${browserPid}, found ${found}`,
    );
  }
  return browserPid;
}

export function buildHammerspoonCaptureControl(applicationPid, action, fields = {}) {
  if (!Number.isInteger(applicationPid) || applicationPid <= 0) {
    throw new Error("Hammerspoon capture control requires the launched Chrome PID");
  }
  return { ...fields, action, applicationPid };
}

export function createHammerspoonAlignedMonotonicNow(
  pointerStartReceipt,
  { nodeBefore, nodeAfter },
  nodeNow = monotonicSeconds,
  maximumUncertaintySeconds = MAX_HAMMERSPOON_CLOCK_UNCERTAINTY_SECONDS,
) {
  const hammerspoonAtReceipt = pointerStartReceipt?.monotonicSeconds;
  if (
    pointerStartReceipt?.started !== true
    || typeof hammerspoonAtReceipt !== "number"
    || !Number.isFinite(hammerspoonAtReceipt)
    || hammerspoonAtReceipt < 0
  ) {
    throw new Error("Hammerspoon pointer start returned an invalid monotonic timestamp");
  }
  if (typeof nodeNow !== "function") {
    throw new Error("Node monotonic clock must be callable");
  }
  if (
    typeof nodeBefore !== "number"
    || !Number.isFinite(nodeBefore)
    || nodeBefore < 0
    || typeof nodeAfter !== "number"
    || !Number.isFinite(nodeAfter)
    || nodeAfter < nodeBefore
  ) {
    throw new Error("Node pointer clock bracket returned invalid monotonic timestamps");
  }
  if (
    typeof maximumUncertaintySeconds !== "number"
    || !Number.isFinite(maximumUncertaintySeconds)
    || maximumUncertaintySeconds <= 0
  ) {
    throw new Error("Hammerspoon pointer clock uncertainty bound is invalid");
  }
  const uncertaintySeconds = (nodeAfter - nodeBefore) / 2;
  if (uncertaintySeconds > maximumUncertaintySeconds) {
    throw new Error(
      `Hammerspoon pointer clock uncertainty ${uncertaintySeconds.toFixed(3)}s exceeds ${maximumUncertaintySeconds.toFixed(3)}s`,
    );
  }
  const nodeMidpoint = nodeBefore + uncertaintySeconds;
  const offset = hammerspoonAtReceipt - nodeMidpoint;
  if (!Number.isFinite(offset)) throw new Error("Node pointer clock returned an invalid monotonic timestamp");
  let previousTimestamp = hammerspoonAtReceipt;
  return () => {
    const nodeTimestamp = nodeNow();
    if (
      typeof nodeTimestamp !== "number"
      || !Number.isFinite(nodeTimestamp)
      || nodeTimestamp < 0
    ) {
      throw new Error("aligned pointer clock returned an invalid monotonic timestamp");
    }
    const alignedTimestamp = nodeTimestamp + offset;
    if (!Number.isFinite(alignedTimestamp) || alignedTimestamp < previousTimestamp) {
      throw new Error("aligned pointer clock returned an invalid monotonic timestamp");
    }
    previousTimestamp = alignedTimestamp;
    return alignedTimestamp;
  };
}

export async function startHammerspoonPointerCapture({
  osascriptPath,
  browserPid,
  pointerOutput,
  privateRoot,
  armCleanup,
  invoke = invokeHammerspoon,
  nodeNow = monotonicSeconds,
  maximumUncertaintySeconds = MAX_HAMMERSPOON_CLOCK_UNCERTAINTY_SECONDS,
}) {
  if (typeof armCleanup !== "function") {
    throw new Error("Hammerspoon pointer start requires a cleanup arm callback");
  }
  if (typeof nodeNow !== "function") throw new Error("Node monotonic clock must be callable");
  armCleanup();
  const nodeBefore = nodeNow();
  let pointerStartReceipt;
  try {
    pointerStartReceipt = await invoke(
      osascriptPath,
      buildHammerspoonCaptureControl(browserPid, "start-pointer", { pointerOutput }),
      privateRoot,
    );
  } catch (error) {
    try {
      nodeNow();
    } catch {
      // Preserve the remote start failure as the primary error.
    }
    throw error;
  }
  const nodeAfter = nodeNow();
  return {
    receipt: pointerStartReceipt,
    uncertaintySeconds: (nodeAfter - nodeBefore) / 2,
    nodeToHammerspoonOffsetSeconds:
      pointerStartReceipt.monotonicSeconds - (nodeBefore + ((nodeAfter - nodeBefore) / 2)),
    monotonicNow: createHammerspoonAlignedMonotonicNow(
      pointerStartReceipt,
      { nodeBefore, nodeAfter },
      nodeNow,
      maximumUncertaintySeconds,
    ),
  };
}

export function assertBrowserApplicationWatcherResult(result, expectedPid, expectedStopped) {
  if (
    result?.expectedPid !== expectedPid
    || result?.stopped !== expectedStopped
    || !Array.isArray(result?.otherPids)
    || typeof result?.expectedTerminated !== "boolean"
  ) {
    throw new Error("Hammerspoon application watcher returned invalid ownership state");
  }
  if (result.expectedTerminated) {
    throw new Error(`Hammerspoon observed expected Chrome for Testing PID ${expectedPid} terminate`);
  }
  if (result.otherPids.length > 0) {
    throw new Error(
      `Hammerspoon observed another Chrome for Testing PID during capture: ${result.otherPids.join(", ")}`,
    );
  }
  return result;
}

export async function invokeBrowserApplicationWatcher({
  osascriptPath,
  browserPid,
  privateRoot,
  action,
  invoke = invokeHammerspoon,
}) {
  if (action !== "start-application-watcher" && action !== "stop-application-watcher") {
    throw new Error(`unsupported Hammerspoon application watcher action: ${action}`);
  }
  return invoke(
    osascriptPath,
    buildHammerspoonCaptureControl(browserPid, action),
    privateRoot,
  );
}

export function browserWindowIdentityCommand(osascriptPath, browserPid) {
  const applicationHint = Number.isInteger(browserPid)
    ? String(browserPid)
    : JSON.stringify(String(browserPid));
  const source = [
    `local app=hs.application.get(${applicationHint})`,
    'if not app then return hs.json.encode({found=false,reason="application"}) end',
    "local window=app:mainWindow() or app:focusedWindow()",
    'if not window then return hs.json.encode({found=false,reason="window",applicationPid=app:pid()}) end',
    "local frame=window:frame()",
    "return hs.json.encode({found=true,applicationPid=app:pid(),windowId=window:id(),frame={x=frame.x,y=frame.y,w=frame.w,h=frame.h},role=window:role(),subrole=window:subrole()})",
  ].join("; ");
  return {
    executable: osascriptPath,
    args: [
      path.join(moduleDir, "run_hammerspoon.applescript"),
      source,
    ],
  };
}

export function validateBrowserWindowIdentity(identity, browserPid) {
  const frame = identity?.frame;
  if (
    identity?.found !== true
    || identity?.applicationPid !== browserPid
    || identity?.role !== "AXWindow"
    || !Number.isInteger(identity?.windowId)
    || identity.windowId <= 0
    || ![frame?.x, frame?.y, frame?.w, frame?.h].every(Number.isFinite)
    || frame.w <= 0
    || frame.h <= 0
  ) return undefined;
  return {
    applicationPid: browserPid,
    windowId: identity.windowId,
    frame: { x: frame.x, y: frame.y, width: frame.w, height: frame.h },
    role: identity.role,
    subrole: identity.subrole,
  };
}

export async function readBrowserWindowIdentity(
  osascriptPath,
  browserPid,
  runCommand = commandOutput,
  {
    timeoutMs = MACOS_WINDOW_PREFLIGHT_TIMEOUT_MS,
    pollIntervalMs = 100,
    wait = delay,
  } = {},
) {
  if (!Number.isInteger(browserPid) || browserPid <= 0) {
    throw new Error("Hammerspoon browser-window preflight requires the launched Chrome PID");
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > MACOS_WINDOW_PREFLIGHT_TIMEOUT_MS) {
    throw new Error(`Hammerspoon browser-window preflight timeout must be between 1 and ${MACOS_WINDOW_PREFLIGHT_TIMEOUT_MS}ms`);
  }
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs < 0) {
    throw new Error("Hammerspoon browser-window preflight poll interval is invalid");
  }
  const command = browserWindowIdentityCommand(osascriptPath, browserPid);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let output;
    try {
      output = await runCommand(command.executable, command.args);
    } catch (error) {
      throw new Error(`Hammerspoon browser-window preflight failed: ${error.message}`, { cause: error });
    }
    const line = output.stdout.trim().split(/\r?\n/).at(-1);
    let identity;
    try {
      identity = JSON.parse(line);
    } catch (error) {
      throw new Error("Hammerspoon browser-window preflight returned invalid JSON", { cause: error });
    }
    const validated = validateBrowserWindowIdentity(identity, browserPid);
    if (validated) return validated;
    const remainingMs = deadline - Date.now();
    if (remainingMs > 0) await wait(Math.min(pollIntervalMs, remainingMs));
  }
  throw new Error(
    `launched Chrome PID ${browserPid} did not expose an exact nonzero CGWindowID and positive AX frame within ${timeoutMs}ms`,
  );
}

export async function captureMacos(config) {
  const doctor = await doctorMacos(config);
  if (config.dryRun) {
    return {
      platform: "darwin",
      nativeBrowser: true,
      dryRun: true,
      commands: buildMacosDryRun(config),
      prerequisites: doctor,
    };
  }
  const failed = doctor.checks.filter((check) => !check.ok && !check.manual);
  if (failed.length > 0) {
    throw new Error(`native macOS capture prerequisites failed: ${failed.map((item) => item.name).join(", ")}`);
  }

  const extension = await verifyExtensionArtifact({
    extensionArtifact: config.extensionArtifact,
    expectedSha256: config.extensionSha256,
    extensionDir: config.extensionDir,
    expectedExtensionId: config.extensionId,
    extensionLockPath: config.extensionLockPath,
    repoRoot: config.repoRoot,
  });
  const browserPath = doctor.checks.find((check) => check.name === "chrome-for-testing").path;
  const osascriptPath = doctor.checks.find((check) => check.name === "hammerspoon-applescript").path;
  const obsPath = doctor.checks.find((check) => check.name === "obs").path;
  const ffmpegPath = doctor.checks.find((check) => check.name === "ffmpeg").path;
  if (obsPath !== OBS_EXECUTABLE_PATH) {
    throw new Error(`native macOS capture requires OBS at ${OBS_EXECUTABLE_PATH}`);
  }
  const previousObsPids = await refuseRunningObs();
  await refuseRunningChromeForTesting(browserPath);
  const privateRoot = await makePrivateTempDir();
  const profileDir = path.join(privateRoot, "chrome-profile");
  const pointerRawOutput = path.join(config.outputDir, "pointer-events.raw.jsonl");
  const pointerOutput = path.join(config.outputDir, "pointer-events.jsonl");
  const rawDir = path.join(config.outputDir, "raw");
  await mkdir(profileDir, { recursive: true, mode: 0o700 });
  await mkdir(rawDir, { recursive: true });

  let browser;
  let browserPid;
  let obs;
  let applicationWatcherStarted = false;
  let pointerStarted = false;
  let succeeded = false;
  let result;
  let primaryError;
  try {
    await seedPinnedExtensionPreferences(profileDir, extension.extensionId);
    browser = spawnCommand(
      browserPath,
      chromeLaunchArgs({
        ...config,
        extraBrowserArgs: [...config.extraBrowserArgs, "--force-renderer-accessibility"],
      }, profileDir),
      { env: sanitizedInheritedEnv(), stdio: "ignore" },
    );
    browserPid = browser.pid;
    const browserSpawn = createSpawnGuard(browser, "Chrome for Testing");
    const port = await browserSpawn.race(waitForDevToolsPort(profileDir));
    const assertBrowserExclusive = () => assertExclusiveBrowserBundle(
      osascriptPath,
      browserPid,
      config.browserBundleId,
    );
    await assertBrowserExclusive();
    applicationWatcherStarted = true;
    const watcherStart = await invokeBrowserApplicationWatcher({
      osascriptPath,
      browserPid,
      privateRoot,
      action: "start-application-watcher",
    });
    assertBrowserApplicationWatcherResult(watcherStart, browserPid, false);
    await browserSpawn.race(waitForExtensionWorker(port, extension.extensionId));

    const obsHome = path.join(privateRoot, "obs-home");
    const browserWindow = await readBrowserWindowIdentity(osascriptPath, browserPid);
    await writeObsConfiguration({
      obsHome,
      outputDir: rawDir,
      width: config.width,
      height: config.height,
      fps: config.fps,
      bundleId: config.browserBundleId,
      windowId: browserWindow.windowId,
    });
    const obsEnvironment = buildObsEnvironment(obsHome);
    await Promise.all([
      mkdir(obsEnvironment.TMPDIR, { recursive: true, mode: 0o700 }),
      mkdir(obsEnvironment.XDG_CONFIG_HOME, { recursive: true, mode: 0o700 }),
      mkdir(obsEnvironment.XDG_CACHE_HOME, { recursive: true, mode: 0o700 }),
      mkdir(obsEnvironment.XDG_DATA_HOME, { recursive: true, mode: 0o700 }),
    ]);
    const obsLauncher = spawnCommand(
      OPEN_EXECUTABLE_PATH,
      buildObsLaunchServicesArgs({ environment: obsEnvironment }),
      {
        env: obsEnvironment,
        stdio: "ignore",
      },
    );
    obs = { launcher: obsLauncher, pid: undefined, previousPids: previousObsPids };
    const obsSpawn = createSpawnGuard(obsLauncher, "OBS LaunchServices launcher");
    obs.pid = await obsSpawn.race(waitForNewObsProcess({
      child: obsLauncher,
      previousPids: previousObsPids,
    }));
    await obsSpawn.race(waitForObsRecordingReady({ child: obsLauncher, rawDir, obsHome }));
    const captureStartedAtSeconds = monotonicSeconds();

    const {
      monotonicNow: alignedMonotonicNow,
      nodeToHammerspoonOffsetSeconds,
    } = await startHammerspoonPointerCapture({
      osascriptPath,
      browserPid,
      pointerOutput: pointerRawOutput,
      privateRoot,
      armCleanup: () => { pointerStarted = true; },
    });
    const beforeTargets = await readCdpTargets(port);
    const accessibility = await invokeHammerspoon(osascriptPath, buildHammerspoonCaptureControl(browserPid, "open", {
      extensionName: config.extensionName,
      extensionId: extension.extensionId,
      pointerOutput: pointerRawOutput,
    }), privateRoot);

    const panelTarget = await waitForNativePanelTarget({
      port,
      beforeTargets,
      extensionId: extension.extensionId,
      panelUrlPattern: config.panelUrlPattern,
      toolbarPressProof: accessibility,
    });
    const needsConnectionRegistry = config.panelActions.some((action) => action.action === "uploadConnection");
    const connectionRegistryPath = needsConnectionRegistry
      ? await createTemporaryConnectionRegistry(privateRoot, config.connectionRegistry)
      : undefined;
    let panel;
    try {
      panel = await attachNativePanel({
        port,
        target: panelTarget,
        actions: config.panelActions,
        actionOptions: {
          scenarioDir: config.scenarioDir,
          connectionRegistryPath,
          captureWidth: config.browserWidth,
          captureHeight: config.browserHeight,
          keepProfile: config.keepProfile,
          monotonicNow: alignedMonotonicNow,
          recordPointer: (event) => appendPointerEvent(pointerRawOutput, event),
        },
      });
    } finally {
      if (connectionRegistryPath) await rm(connectionRegistryPath, { force: true });
    }
    await delay(remainingCaptureHoldMilliseconds(
      config.durationSeconds,
      captureStartedAtSeconds,
      monotonicSeconds(),
    ));

    await invokeHammerspoon(
      osascriptPath,
      buildHammerspoonCaptureControl(browserPid, "stop-pointer"),
      privateRoot,
    );
    pointerStarted = false;
    const rawVideo = await finalizeObsRecording({
      obs,
      rawDir,
      browser,
      expectedBrowserPid: browserPid,
      stopAndAssertApplicationWatcher: async () => {
        const watcherStop = await invokeBrowserApplicationWatcher({
          osascriptPath,
          browserPid,
          privateRoot,
          action: "stop-application-watcher",
        });
        applicationWatcherStarted = false;
        assertBrowserApplicationWatcherResult(watcherStop, browserPid, true);
      },
    });
    obs = undefined;
    const visualValidation = await validateMacosRecordingLuma(rawVideo, ffmpegPath);
    await finalizePointerEvents(pointerRawOutput, pointerOutput, {
      captureStartedAtSeconds: captureStartedAtSeconds + nodeToHammerspoonOffsetSeconds,
      durationSeconds: config.durationSeconds,
    });
    succeeded = true;
    result = {
      platform: "darwin",
      nativeBrowser: true,
      rawVideo,
      pointerEvents: pointerOutput,
      pointerEventsRaw: pointerRawOutput,
      extension,
      panel,
      accessibility,
      visualValidation,
      isolatedProfile: true,
      profileRetained: config.keepProfile,
    };
  } catch (error) {
    primaryError = error;
    const diagnosticErrors = [];
    if (obs) {
      try {
        await stopObsLaunch(obs);
        obs = undefined;
      } catch (stopError) {
        diagnosticErrors.push(stopError);
      }
    }
    try {
      await preserveObsFailureDiagnostics({
        obsHome: path.join(privateRoot, "obs-home"),
        outputDir: config.outputDir,
        error,
      });
    } catch (diagnosticError) {
      diagnosticErrors.push(diagnosticError);
    }
    if (diagnosticErrors.length > 0) primaryError.diagnosticErrors = diagnosticErrors;
  } finally {
    await cleanupMacosCapture({
      pointerStarted,
      applicationWatcherStarted,
      osascriptPath,
      privateRoot,
      obs,
      browser,
      browserPid,
      rawDir,
      succeeded,
      keepProfile: config.keepProfile,
      primaryError,
    });
  }
  return result;
}

export async function waitForObsRecordingReady({
  child,
  rawDir,
  obsHome,
  timeoutMs = 30_000,
}) {
  const deadline = Date.now() + timeoutMs;
  const logsDir = path.join(obsHome, "Library/Application Support/obs-studio/logs");
  let recordingLogSeen = false;
  while (Date.now() < deadline) {
    if (child?.exitCode !== null) {
      throw new Error(`OBS exited ${child?.exitCode} before recording readiness was proved`);
    }
    const logEntries = await readdir(logsDir, { withFileTypes: true }).catch((error) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    for (const entry of logEntries) {
      if (!entry.isFile() || !entry.name.endsWith(".txt")) continue;
      const text = await readBoundedTail(path.join(logsDir, entry.name));
      if (/Permission for screen capture denied/i.test(text)) {
        throw new Error(
          "OBS does not have macOS Screen Recording permission; grant it, quit OBS, and rerun capture",
        );
      }
      if (/Failed to start recording|recording failed/i.test(text)) {
        throw new Error("OBS isolated log reports that recording failed");
      }
      if (
        /Invalid target (?:display|window) ID/i.test(text)
        || /init_[a-z_]*screen[a-z_]*stream\s*:[^\r\n]*(?:failed|unable|invalid|error)/i.test(text)
      ) {
        throw new Error("OBS isolated log reports that the ScreenCaptureKit source failed to initialize");
      }
      if (/==== Recording Start|Recording started/i.test(text)) recordingLogSeen = true;
    }
    const recordings = await readdir(rawDir, { withFileTypes: true }).catch((error) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    for (const recording of recordings) {
      if (!recording.isFile() || !/^raw-browser.*\.(mkv|mp4|mov)$/.test(recording.name)) continue;
      const recordingPath = path.join(rawDir, recording.name);
      const details = await stat(recordingPath);
      if (details.size > 0) {
        return {
          ready: true,
          proof: "non-empty-isolated-recording",
          recordingPath,
          sizeBytes: details.size,
          recordingLogSeen,
        };
      }
    }
    await delay(100);
  }
  throw new Error(
    `OBS recording readiness was not proved: no non-empty isolated output${recordingLogSeen ? " despite a recording-start log" : " or recording-start log"}`,
  );
}

export async function deleteObsCaptureRecordings(rawDir) {
  if (!rawDir) return [];
  const entries = await readdir(rawDir, { withFileTypes: true }).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const recordings = entries
    .filter((entry) => (
      entry.isFile()
      && /^(?:raw-browser.*|browser)\.(mkv|mp4|mov)$/.test(entry.name)
    ))
    .map((entry) => path.join(rawDir, entry.name));
  await Promise.all(recordings.map((recordingPath) => rm(recordingPath, { force: true })));
  return recordings;
}

export function macosSignalstatsArgs(
  rawVideo,
  maximumFrames = MACOS_LUMA_SAMPLE_LIMIT,
) {
  if (!Number.isInteger(maximumFrames) || maximumFrames <= 0 || maximumFrames > MACOS_LUMA_SAMPLE_LIMIT) {
    throw new Error(`macOS luma validation samples between 1 and ${MACOS_LUMA_SAMPLE_LIMIT} frames`);
  }
  return [
    "-hide_banner",
    "-nostats",
    "-nostdin",
    "-v",
    "error",
    "-i",
    rawVideo,
    "-map",
    "0:v:0",
    "-vf",
    "fps=2,signalstats,metadata=mode=print:file=-",
    "-frames:v",
    String(maximumFrames),
    "-an",
    "-sn",
    "-f",
    "null",
    "-",
  ];
}

export function parseSignalstatsLuma(output) {
  const samples = [];
  let sample;
  const finishSample = () => {
    if (!sample) return;
    if ([sample.ymin, sample.yavg, sample.ymax].every(Number.isFinite)) samples.push(sample);
  };
  for (const line of String(output).split(/\r?\n/)) {
    if (/^frame:\d+\s/.test(line)) {
      finishSample();
      sample = {};
      continue;
    }
    const match = line.match(/^lavfi\.signalstats\.Y(MIN|AVG|MAX)=([0-9]+(?:\.[0-9]+)?)$/);
    if (!match) continue;
    sample ??= {};
    sample[`y${match[1].toLowerCase()}`] = Number(match[2]);
  }
  finishSample();
  return samples;
}

export function assertMeaningfulLumaSamples(
  samples,
  minimumRange = MINIMUM_MEANINGFUL_LUMA_RANGE,
  minimumAverage = MINIMUM_VISIBLE_LUMA_AVERAGE,
) {
  if (!Array.isArray(samples) || samples.length === 0) {
    throw new Error("FFmpeg signalstats returned no complete luma samples for the OBS recording");
  }
  if (!Number.isFinite(minimumRange) || minimumRange <= 0) {
    throw new Error("macOS luma validation requires a positive minimum range");
  }
  if (!Number.isFinite(minimumAverage) || minimumAverage < 0) {
    throw new Error("macOS luma validation requires a non-negative minimum average");
  }
  const ranges = samples.map((sample) => {
    const values = [sample?.ymin, sample?.yavg, sample?.ymax];
    if (
      !values.every((value) => Number.isFinite(value) && value >= 0 && value <= 255)
      || sample.ymin > sample.yavg
      || sample.yavg > sample.ymax
    ) {
      throw new Error("FFmpeg signalstats returned an invalid luma sample");
    }
    return sample.ymax - sample.ymin;
  });
  const meaningfulFrameCount = ranges.filter((range, index) => (
    (range >= minimumRange && samples[index].yavg > minimumAverage)
    || samples[index].yavg >= minimumAverage + minimumRange
  )).length;
  if (meaningfulFrameCount === 0) {
    throw new Error(
      `OBS capture visual validation failed: no sampled frame had meaningful luma range and brightness (uniform-black capture; range ${minimumRange}, average ${minimumAverage})`,
    );
  }
  return {
    sampleCount: samples.length,
    meaningfulFrameCount,
    minimumRequiredRange: minimumRange,
    minimumRequiredAverage: minimumAverage,
    maximumObservedRange: Math.max(...ranges),
  };
}

export async function validateMacosRecordingLuma(
  rawVideo,
  ffmpegPath,
  runCommand = commandOutput,
) {
  if (!ffmpegPath) throw new Error("FFmpeg is required for macOS capture visual validation");
  const { stdout, stderr } = await runCommand(ffmpegPath, macosSignalstatsArgs(rawVideo));
  return assertMeaningfulLumaSamples(parseSignalstatsLuma(`${stdout}\n${stderr}`));
}

async function readBoundedTail(filePath, maximumBytes = MAX_OBS_DIAGNOSTIC_BYTES) {
  const details = await stat(filePath);
  const length = Math.min(maximumBytes, details.size);
  const handle = await open(filePath, "r");
  try {
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, Math.max(0, details.size - length));
    return buffer.toString("utf8");
  } finally {
    await handle.close();
  }
}

function redactObsDiagnostic(text, environment = process.env) {
  let redacted = redactText(String(text));
  for (const [name, value] of Object.entries(environment)) {
    if (!name.startsWith("ACP_") || typeof value !== "string" || value.length === 0) continue;
    redacted = redacted.split(value).join(`[REDACTED_${name}]`);
  }
  return redacted;
}

function boundedUtf8(text, maximumBytes) {
  const encoded = Buffer.from(String(text), "utf8");
  if (encoded.length <= maximumBytes) return encoded.toString("utf8");
  return encoded.subarray(encoded.length - maximumBytes).toString("utf8");
}

export async function preserveObsFailureDiagnostics({
  obsHome,
  outputDir,
  error,
  environment = process.env,
}) {
  const logsDir = path.join(obsHome, "Library/Application Support/obs-studio/logs");
  const diagnosticsDir = path.join(outputDir, "diagnostics", "obs");
  await mkdir(diagnosticsDir, { recursive: true, mode: 0o700 });
  await chmod(diagnosticsDir, 0o700);
  const retainedLogPath = path.join(diagnosticsDir, "latest.log");
  await rm(retainedLogPath, { force: true });

  const entries = await readdir(logsDir, { withFileTypes: true }).catch((readError) => {
    if (readError.code === "ENOENT") return [];
    throw readError;
  });
  const logs = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".txt")) continue;
    const filePath = path.join(logsDir, entry.name);
    logs.push({ filePath, details: await stat(filePath) });
  }
  logs.sort((left, right) => right.details.mtimeMs - left.details.mtimeMs);

  let retainedLog;
  if (logs[0]) {
    retainedLog = retainedLogPath;
    const tail = await readBoundedTail(logs[0].filePath);
    await writeFile(retainedLog, boundedUtf8(
      redactObsDiagnostic(tail, environment),
      MAX_OBS_DIAGNOSTIC_BYTES,
    ), {
      encoding: "utf8",
      mode: 0o600,
    });
    await chmod(retainedLog, 0o600);
  }

  const summaryPath = path.join(diagnosticsDir, "summary.json");
  await writePrivateJson(summaryPath, {
    schemaVersion: 1,
    error: boundedUtf8(
      redactObsDiagnostic(error?.message ?? String(error), environment),
      4 * 1024,
    ),
    logFound: Boolean(retainedLog),
    retainedLog: retainedLog ? "latest.log" : null,
    retainedBytes: retainedLog ? (await stat(retainedLog)).size : 0,
    maximumLogBytes: MAX_OBS_DIAGNOSTIC_BYTES,
    checkedLocation: "obs-home/Library/Application Support/obs-studio/logs",
    chromeProfileRetained: false,
  });
  return { diagnosticsDir, summaryPath, retainedLog };
}

export async function cleanupMacosCapture({
  pointerStarted,
  applicationWatcherStarted,
  osascriptPath,
  privateRoot,
  obs,
  browser,
  browserPid,
  rawDir,
  succeeded,
  keepProfile,
  primaryError,
  invokePointer = invokeHammerspoon,
  invokeApplicationWatcher = invokeHammerspoon,
  stopObs = stopObsLaunch,
  deleteRecordings = deleteObsCaptureRecordings,
  stopBrowser = stopProcess,
  cleanupProfile = cleanupPrivateProfile,
}) {
  const cleanupErrors = [];
  const attempt = async (operation) => {
    try {
      await operation();
    } catch (error) {
      cleanupErrors.push(error);
    }
  };
  if (pointerStarted) {
    await attempt(async () => {
      await invokePointer(
        osascriptPath,
        buildHammerspoonCaptureControl(browserPid, "stop-pointer"),
        privateRoot,
      );
    });
  }
  await attempt(() => stopObs(obs));
  if (applicationWatcherStarted) {
    await attempt(async () => {
      const watcherStop = await invokeBrowserApplicationWatcher({
        osascriptPath,
        browserPid,
        privateRoot,
        action: "stop-application-watcher",
        invoke: invokeApplicationWatcher,
      });
      assertBrowserApplicationWatcherResult(watcherStop, browserPid, true);
    });
  }
  if (!succeeded) await attempt(() => deleteRecordings(rawDir));
  await attempt(() => stopBrowser(browser));
  await attempt(() => cleanupProfile(privateRoot, succeeded ? keepProfile : false));
  const failure = cleanupFailure(primaryError, cleanupErrors);
  if (failure) throw failure;
}

async function waitForExtensionWorker(port, extensionId, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const targets = await readCdpTargets(port, globalThis.fetch, {
      timeoutMs: Math.max(1, deadline - Date.now()),
    });
    if (targets.some((target) => String(target.url ?? "").startsWith(`chrome-extension://${extensionId}/`))) return;
    await delay(100);
  }
  throw new Error("the expected extension did not load in the isolated profile");
}

async function invokeHammerspoon(osascriptPath, control, privateRoot) {
  const controlPath = path.join(privateRoot, `hammerspoon-${randomUUID()}.json`);
  await writePrivateJson(controlPath, control);
  const source = `local m=dofile(${JSON.stringify(path.join(moduleDir, "open_extension.lua"))}); return hs.json.encode(m.run(${JSON.stringify(controlPath)}))`;
  let output;
  try {
    output = await commandOutput(osascriptPath, [path.join(moduleDir, "run_hammerspoon.applescript"), source]);
  } catch (error) {
    throw new Error(`Hammerspoon browser automation failed: ${error.message}`, { cause: error });
  }
  const { stdout } = output;
  const line = stdout.trim().split(/\r?\n/).at(-1);
  return line ? JSON.parse(line) : {};
}

export async function writeObsConfiguration({ obsHome, outputDir, width, height, fps, bundleId, windowId }) {
  if (!Number.isInteger(windowId) || windowId <= 0) {
    throw new Error("OBS exact-window capture requires a positive CGWindowID");
  }
  const configRoot = path.join(obsHome, "Library/Application Support/obs-studio");
  const profileDir = path.join(configRoot, "basic/profiles/ACP Demo Creator");
  const scenesDir = path.join(configRoot, "basic/scenes");
  await mkdir(profileDir, { recursive: true, mode: 0o700 });
  await mkdir(scenesDir, { recursive: true, mode: 0o700 });
  await writeFile(path.join(configRoot, "global.ini"), [
    "[Basic]",
    "Profile=ACP Demo Creator",
    "ProfileDir=ACP Demo Creator",
    "SceneCollection=ACP Demo Creator",
    "SceneCollectionFile=ACP Demo Creator",
    "",
    "[General]",
    "FirstRun=false",
    "EnableAutoUpdates=false",
    "ConfirmOnExit=false",
    "MacOSPermissionsDialogLastShown=1",
    "",
  ].join("\n"));
  await writeFile(path.join(profileDir, "basic.ini"), [
    "[General]",
    "Name=ACP Demo Creator",
    "",
    "[Video]",
    `BaseCX=${width}`,
    `BaseCY=${height}`,
    `OutputCX=${width}`,
    `OutputCY=${height}`,
    `FPSCommon=${fps}`,
    "ScaleType=lanczos",
    "ColorFormat=NV12",
    "ColorSpace=709",
    "ColorRange=Partial",
    "",
    "[Output]",
    "Mode=Simple",
    "FilenameFormatting=raw-browser",
    "",
    "[SimpleOutput]",
    "RecEncoder=apple_h264",
    "RecQuality=Small",
    `FilePath=${outputDir}`,
    "RecFormat2=mkv",
    "FileNameWithoutSpace=true",
    "",
  ].join("\n"));

  const captureUuid = randomUUID();
  const sceneUuid = randomUUID();
  await writePrivateJson(path.join(scenesDir, "ACP Demo Creator.json"), {
    name: "ACP Demo Creator",
    current_scene: "Browser",
    current_program_scene: "Browser",
    current_transition: "Cut",
    transition_duration: 0,
    preview_locked: true,
    groups: [],
    quick_transitions: [],
    transitions: [],
    sources: [
      {
        name: "Chrome for Testing",
        uuid: captureUuid,
        id: "screen_capture",
        versioned_id: "screen_capture",
        settings: {
          application: bundleId,
          window: windowId,
          type: 1,
          show_cursor: false,
          show_hidden_windows: false,
        },
        muted: false,
        volume: 1,
        balance: 0.5,
        sync: 0,
        flags: 0,
        mixers: 0,
        monitoring_type: 0,
        hotkeys: {},
        private_settings: {},
      },
      {
        name: "Browser",
        uuid: sceneUuid,
        id: "scene",
        versioned_id: "scene",
        settings: {
          id_counter: 1,
          custom_size: false,
          items: [{
            name: "Chrome for Testing",
            source_uuid: captureUuid,
            visible: true,
            locked: true,
            rot: 0,
            scale_ref: { x: width, y: height },
            align: 5,
            bounds_type: 2,
            bounds_align: 0,
            bounds: { x: width, y: height },
            pos: { x: 0, y: 0 },
            scale: { x: 1, y: 1 },
            crop_left: 0,
            crop_top: 0,
            crop_right: 0,
            crop_bottom: 0,
            id: 1,
            scale_filter: "lanczos",
            blend_method: "default",
            blend_type: "normal",
            private_settings: {},
          }],
        },
        muted: false,
        volume: 1,
        balance: 0.5,
        sync: 0,
        flags: 0,
        mixers: 0,
        monitoring_type: 0,
        hotkeys: {},
        private_settings: {},
      },
    ],
  });
}

async function claimObsRecording(rawDir) {
  const entries = await readdir(rawDir, { withFileTypes: true });
  const recordings = entries.filter((entry) => entry.isFile() && /^raw-browser.*\.(mkv|mp4|mov)$/.test(entry.name));
  if (recordings.length !== 1) {
    throw new Error(`OBS produced ${recordings.length} browser recordings; expected exactly one`);
  }
  const source = path.join(rawDir, recordings[0].name);
  const destination = path.join(rawDir, `browser${path.extname(source)}`);
  await rename(source, destination);
  return destination;
}
