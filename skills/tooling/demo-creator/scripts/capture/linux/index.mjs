import { mkdir, rm, stat } from "node:fs/promises";
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
} from "../common.mjs";
import {
  attachNativePanel,
  readCdpTargets,
  waitForNativePanelTarget,
} from "../native-panel.mjs";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

export async function doctorLinux(config, env = process.env) {
  const specs = [
    ["chrome-for-testing", config.browserPath, "google-chrome-for-testing", "chrome-for-testing", "chrome"],
    ["xvfb", "Xvfb"],
    ["xdotool", "xdotool"],
    ["ffmpeg", "ffmpeg"],
    ["python3", "python3"],
  ];
  const checks = await Promise.all(specs.map(async ([name, ...candidates]) => {
    const executablePath = await findExecutable(candidates, env);
    return { name, ok: Boolean(executablePath), path: executablePath, detail: executablePath ? undefined : `missing ${name}` };
  }));
  const pythonPath = checks.find((check) => check.name === "python3")?.path;
  if (pythonPath) {
    try {
      await runCommand(pythonPath, ["-c", "import pyatspi"], sanitizedInheritedEnv(env));
      checks.push({ name: "pyatspi", ok: true, detail: "Python AT-SPI bindings available" });
    } catch {
      checks.push({ name: "pyatspi", ok: false, detail: "Python AT-SPI bindings are not importable" });
    }
  } else {
    checks.push({ name: "pyatspi", ok: false, detail: "Python 3 is unavailable" });
  }
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
    name: "at-spi-session-bus",
    ok: Boolean(env.DBUS_SESSION_BUS_ADDRESS),
    detail: env.DBUS_SESSION_BUS_ADDRESS
      ? undefined
      : "run capture under dbus-run-session so Chrome and pyatspi share an accessibility bus",
  });
  return { platform: "linux", ok: checks.every((check) => check.ok), checks };
}

export function buildLinuxDryRun(config, paths = {}) {
  const display = paths.display ?? ":99";
  const browserPath = paths.browserPath ?? config.browserPath ?? "<chrome-for-testing>";
  const profileDir = paths.profileDir ?? "<private-profile>";
  return [
    {
      executable: paths.xvfbPath ?? "<Xvfb>",
      args: [display, "-screen", "0", `${config.width}x${config.height}x24`, "-nolisten", "tcp"],
    },
    {
      executable: browserPath,
      args: [...chromeLaunchArgs(config, profileDir), "--force-renderer-accessibility"],
      env: { DISPLAY: display },
    },
    {
      executable: paths.ffmpegPath ?? "<ffmpeg>",
      args: ffmpegArgs(config, display, "<raw-browser.mp4>"),
    },
    {
      // Mirror the live invokeAtSpi contract so the plan is runnable and faithful:
      // open_extension_atspi.py marks the name, pointer output, xdotool, and window
      // geometry as required. Runtime-only values that cannot exist before the
      // Chrome window is measured are explicit placeholders, matching the sibling
      // macOS dry run's placeholder convention.
      executable: paths.pythonPath ?? "<python3>",
      args: [
        path.join(moduleDir, "open_extension_atspi.py"),
        "--application-name",
        "Google Chrome for Testing",
        "--extension-name",
        config.extensionName ?? "<extension-name>",
        "--extension-id",
        config.extensionId ?? "<extension-id>",
        "--pointer-output",
        "<pointer-events.raw.jsonl>",
        "--xdotool",
        paths.xdotoolPath ?? "<xdotool>",
        "--window-x",
        "<window-x>",
        "--window-y",
        "<window-y>",
        "--window-width",
        "<window-width>",
        "--window-height",
        "<window-height>",
      ],
    },
  ];
}

// The X11/AT-SPI toolchain (Xvfb, Chrome, ffmpeg x11grab, xdotool, pyatspi)
// needs a rich inherited desktop environment, so this is a credential denylist
// rather than an allowlist: keep everything except the caller bearer token, then
// pin the display and accessibility-bus variables the capture depends on.
export function linuxCaptureEnvironment(display, base = process.env) {
  return sanitizedInheritedEnv(base, { DISPLAY: display, NO_AT_BRIDGE: "0" });
}

export async function captureLinux(config) {
  const doctor = await doctorLinux(config);
  if (config.dryRun) {
    return {
      platform: "linux",
      nativeBrowser: true,
      dryRun: true,
      commands: buildLinuxDryRun(config),
      prerequisites: doctor,
    };
  }
  const failed = doctor.checks.filter((check) => !check.ok);
  if (failed.length > 0) {
    throw new Error(`native Linux capture prerequisites failed: ${failed.map((item) => item.name).join(", ")}`);
  }

  const extension = await verifyExtensionArtifact({
    extensionArtifact: config.extensionArtifact,
    expectedSha256: config.extensionSha256,
    extensionDir: config.extensionDir,
    expectedExtensionId: config.extensionId,
    extensionLockPath: config.extensionLockPath,
    repoRoot: config.repoRoot,
  });
  const executable = (name) => doctor.checks.find((check) => check.name === name).path;
  const privateRoot = await makePrivateTempDir();
  const profileDir = path.join(privateRoot, "chrome-profile");
  const rawDir = path.join(config.outputDir, "raw");
  const rawVideo = path.join(rawDir, "browser.mp4");
  const pointerRawOutput = path.join(config.outputDir, "pointer-events.raw.jsonl");
  const pointerOutput = path.join(config.outputDir, "pointer-events.jsonl");
  await mkdir(profileDir, { recursive: true, mode: 0o700 });
  await mkdir(rawDir, { recursive: true });

  const display = await chooseDisplay();
  const captureEnv = linuxCaptureEnvironment(display);
  let xvfb;
  let browser;
  let ffmpeg;
  let ffmpegStderr = "";
  let ffmpegSpawnError;
  let xvfbSpawnError;
  let browserSpawnError;
  let succeeded = false;
  let result;
  let primaryError;
  try {
    xvfb = spawnCommand(executable("xvfb"), [
      display,
      "-screen",
      "0",
      `${config.width}x${config.height}x24`,
      "-nolisten",
      "tcp",
    ], { env: captureEnv, stdio: "ignore" });
    xvfb.once("error", (error) => {
      xvfbSpawnError = error;
    });
    await delay(500);
    if (xvfbSpawnError) throw xvfbSpawnError;
    if (xvfb.exitCode !== null) throw new Error("Xvfb exited before native capture started");

    await seedPinnedExtensionPreferences(profileDir, extension.extensionId);
    browser = spawnCommand(
      executable("chrome-for-testing"),
      [...chromeLaunchArgs(config, profileDir), "--force-renderer-accessibility"],
      { env: captureEnv, stdio: "ignore" },
    );
    browser.once("error", (error) => {
      browserSpawnError = error;
    });
    let port;
    try {
      port = await waitForDevToolsPort(profileDir);
    } catch (error) {
      throw browserSpawnError ?? error;
    }
    await waitForExtensionTarget(port, extension.extensionId);

    const windowId = await findChromeWindow(executable("xdotool"), captureEnv);
    await runCommand(executable("xdotool"), ["windowmove", windowId, "0", "0"], captureEnv);
    await runCommand(executable("xdotool"), ["windowsize", windowId, String(config.browserWidth), String(config.browserHeight)], captureEnv);
    await runCommand(executable("xdotool"), ["windowactivate", "--sync", windowId], captureEnv);
    const bounds = await windowGeometry(executable("xdotool"), windowId, captureEnv);

    ffmpeg = spawnCommand(executable("ffmpeg"), ffmpegArgs(config, display, rawVideo), {
      env: captureEnv,
      stdio: ["ignore", "ignore", "pipe"],
    });
    ffmpeg.stderr?.on("data", (chunk) => {
      ffmpegStderr = `${ffmpegStderr}${chunk}`.slice(-4_096);
    });
    ffmpeg.once("error", (error) => {
      ffmpegSpawnError = error;
    });
    await delay(500);
    if (ffmpegSpawnError || ffmpeg.exitCode !== null) {
      throw recorderError(ffmpeg, ffmpegStderr, ffmpegSpawnError);
    }
    const captureStartedAtSeconds = monotonicSeconds();

    const beforeTargets = await readCdpTargets(port);
    const accessibility = await invokeAtSpi({
      pythonPath: executable("python3"),
      xdotoolPath: executable("xdotool"),
      extension,
      extensionName: config.extensionName,
      pointerOutput: pointerRawOutput,
      bounds,
      env: captureEnv,
    });
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

    const completedRecorder = ffmpeg;
    await stopProcess(completedRecorder, "SIGINT", 10_000);
    ffmpeg = undefined;
    await validateLinuxRecording({
      child: completedRecorder,
      stderr: ffmpegStderr,
      spawnError: ffmpegSpawnError,
      outputPath: rawVideo,
    });
    await finalizePointerEvents(pointerRawOutput, pointerOutput, {
      captureStartedAtSeconds,
      durationSeconds: config.durationSeconds,
    });
    succeeded = true;
    result = {
      platform: "linux",
      nativeBrowser: true,
      rawVideo,
      pointerEvents: pointerOutput,
      pointerEventsRaw: pointerRawOutput,
      extension,
      panel,
      accessibility,
      isolatedProfile: true,
      profileRetained: config.keepProfile,
    };
  } catch (error) {
    primaryError = error;
  } finally {
    await cleanupLinuxCapture({
      ffmpeg,
      browser,
      xvfb,
      privateRoot,
      succeeded,
      keepProfile: config.keepProfile,
      primaryError,
    });
  }
  return result;
}

export async function cleanupLinuxCapture({
  ffmpeg,
  browser,
  xvfb,
  privateRoot,
  succeeded,
  keepProfile,
  primaryError,
  stop = stopProcess,
  cleanupProfile = cleanupPrivateProfile,
}) {
  const cleanupErrors = [];
  for (const cleanup of [
    () => stop(ffmpeg),
    () => stop(browser),
    () => stop(xvfb),
    () => cleanupProfile(privateRoot, succeeded ? keepProfile : false),
  ]) {
    try {
      await cleanup();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  const failure = cleanupFailure(primaryError, cleanupErrors);
  if (failure) throw failure;
}

function recorderError(child, stderr, spawnError) {
  const detail = spawnError?.message ?? stderr.trim() ?? "";
  const status = child?.exitCode === null ? "did not exit cleanly" : `exited ${child?.exitCode}`;
  return new Error(`ffmpeg recorder ${status}: ${detail || "no diagnostic output"}`);
}

export async function validateLinuxRecording({ child, stderr = "", spawnError, outputPath }) {
  if (spawnError || child?.exitCode !== 0) {
    throw recorderError(child, stderr, spawnError);
  }
  let details;
  try {
    details = await stat(outputPath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error("ffmpeg recorder produced no output file");
    }
    throw error;
  }
  if (!details.isFile() || details.size === 0) {
    throw new Error("ffmpeg recorder produced an empty output file");
  }
  return { exitCode: child.exitCode, sizeBytes: details.size };
}

export function ffmpegArgs(config, display, outputPath) {
  return [
    "-hide_banner",
    "-loglevel",
    "warning",
    "-f",
    "x11grab",
    "-framerate",
    String(config.fps),
    "-video_size",
    `${config.browserWidth}x${config.browserHeight}`,
    "-draw_mouse",
    "0",
    "-i",
    `${display}.0+0,0`,
    "-vf",
    `scale=${config.width}:${config.height}:flags=lanczos,setsar=1`,
    "-an",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-pix_fmt",
    "yuv420p",
    "-y",
    outputPath,
  ];
}

async function chooseDisplay() {
  for (let number = 90; number <= 199; number += 1) {
    const socket = `/tmp/.X11-unix/X${number}`;
    try {
      await import("node:fs/promises").then(({ access }) => access(socket));
    } catch {
      return `:${number}`;
    }
  }
  throw new Error("no free X display is available for native capture");
}

async function waitForExtensionTarget(port, extensionId, timeoutMs = 10_000) {
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

async function findChromeWindow(xdotoolPath, env) {
  const result = await runCommand(xdotoolPath, ["search", "--onlyvisible", "--name", "Chrome for Testing"], env);
  const windowId = result.stdout.trim().split(/\s+/)[0];
  if (!windowId) throw new Error("xdotool could not find the Chrome for Testing window");
  return windowId;
}

async function windowGeometry(xdotoolPath, windowId, env) {
  const result = await runCommand(xdotoolPath, ["getwindowgeometry", "--shell", windowId], env);
  const values = Object.fromEntries(result.stdout.trim().split(/\r?\n/).map((line) => line.split("=", 2)));
  const bounds = {
    x: Number(values.X),
    y: Number(values.Y),
    width: Number(values.WIDTH),
    height: Number(values.HEIGHT),
  };
  if (Object.values(bounds).some((value) => !Number.isFinite(value))) {
    throw new Error("xdotool returned invalid Chrome window geometry");
  }
  if (!(bounds.width > 0) || !(bounds.height > 0)) {
    throw new Error("xdotool returned a non-positive Chrome window size");
  }
  return bounds;
}

async function invokeAtSpi({ pythonPath, xdotoolPath, extension, extensionName, pointerOutput, bounds, env }) {
  const result = await runCommand(pythonPath, [
    path.join(moduleDir, "open_extension_atspi.py"),
    "--application-name",
    "Google Chrome for Testing",
    "--extension-name",
    extensionName,
    "--extension-id",
    extension.extensionId,
    "--pointer-output",
    pointerOutput,
    "--xdotool",
    xdotoolPath,
    "--window-x",
    String(bounds.x),
    "--window-y",
    String(bounds.y),
    "--window-width",
    String(bounds.width),
    "--window-height",
    String(bounds.height),
  ], env);
  return JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
}

async function runCommand(executable, args, env) {
  return commandOutput(executable, args, { env });
}
