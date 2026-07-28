import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  access,
  appendFile,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { assertCaptureExtensionMatches } from "../extension/gate.mjs";

const CHROME_ID_ALPHABET = "abcdefghijklmnop";
const PROTECTED_BROWSER_SWITCHES = new Set([
  "--disable-extensions",
  "--disable-extensions-except",
  "--disable-gpu-sandbox",
  "--disable-namespace-sandbox",
  "--disable-sandbox",
  "--disable-seccomp-filter-sandbox",
  "--disable-setuid-sandbox",
  "--load-extension",
  "--no-sandbox",
  "--password-store",
  "--profile-directory",
  "--remote-allow-origins",
  "--remote-debugging-address",
  "--remote-debugging-pipe",
  "--remote-debugging-port",
  "--remote-debugging-socket-fd",
  "--user-data-dir",
  "--use-mock-keychain",
]);
export const PINNED_CHROME_FOR_TESTING_VERSION = "151.0.7922.34";
export const MACOS_CHROME_FOR_TESTING_BUNDLE_ID = "com.google.chrome.for.testing";

export function resolveCaptureConfig(context, platform = process.platform) {
  const scenario = context.scenario ?? {};
  const capture = context.captureOptions ?? {};
  const extension = context.captureExtension ?? {};
  const environment = context.environment ?? process.env;
  const scenarioDir = context.scenarioDir ?? path.dirname(context.scenarioPath ?? process.cwd());
  const resolveFromScenario = (value) =>
    value ? path.resolve(scenarioDir, value) : undefined;
  const captureDuration = Array.isArray(scenario.story)
    ? scenario.story
      .filter((segment) => !["title", "end"].includes(segment.type))
      .reduce((total, segment) => total + Number(segment.durationSeconds ?? 0), 0)
    : 0;
  const dryRun = capture.dryRun === true || environment.DEMO_CAPTURE_DRY_RUN === "1";

  return {
    platform: capture.platform ?? platform,
    dryRun,
    browserPath: capture.browserPath,
    ffmpegPath: capture.ffmpegPath ?? environment.DEMO_FFMPEG,
    browserBundleId: capture.browserBundleId ?? MACOS_CHROME_FOR_TESTING_BUNDLE_ID,
    extensionDir: extension.unpackedPath ?? resolveFromScenario(capture.extensionDir) ?? (dryRun ? "<verified-unpacked-extension>" : undefined),
    extensionArtifact: extension.zipPath ?? resolveFromScenario(capture.extensionArtifact),
    extensionLockPath: extension.lockPath ?? resolveFromScenario(capture.extensionLockPath),
    extensionSha256: extension.lock?.artifact?.sha256 ?? capture.extensionSha256,
    extensionId: extension.lock?.extension?.id ?? scenario.extension?.expectedId ?? capture.extensionId,
    extensionName: extension.lock?.extension?.name ?? "ACP Sessions (OpenShell-as-a-Service)",
    panelUrlPattern: capture.panelUrlPattern ?? "index.html",
    panelActions: scenario.extension?.actions ?? [],
    scenarioDir,
    connectionRegistry: {
      apiUrl: environment.ACP_URL,
      project: environment.ACP_PROJECT,
      name: scenario.id,
    },
    startUrl: capture.startUrl ?? "about:blank",
    width: Number(capture.width ?? 1920),
    height: Number(capture.height ?? 1080),
    browserWidth: Number(capture.browserWidth ?? 1280),
    browserHeight: Number(capture.browserHeight ?? 720),
    fps: Number(scenario.fps ?? capture.fps ?? 30),
    durationSeconds: Number(capture.durationSeconds ?? (captureDuration > 0 ? captureDuration : 15)),
    outputDir: path.resolve(context.outputDir ?? path.join(scenarioDir, "output")),
    repoRoot: context.repoRoot,
    keepProfile: capture.keepProfile === true,
    extraBrowserArgs: Array.isArray(capture.extraBrowserArgs)
      ? capture.extraBrowserArgs.map(String)
      : [],
  };
}

export function validateCaptureConfig(config, { live = !config.dryRun } = {}) {
  const protectedArgument = (config.extraBrowserArgs ?? []).find((argument) =>
    PROTECTED_BROWSER_SWITCHES.has(String(argument).split("=", 1)[0]));
  if (protectedArgument) {
    throw new Error(`native browser capture refuses protected browser argument: ${protectedArgument}`);
  }
  let startUrlProtocol;
  try {
    startUrlProtocol = new URL(String(config.startUrl ?? "")).protocol.toLowerCase();
  } catch {
    // Invalid start URLs are left to Chrome; only direct extension navigation is forbidden here.
  }
  const extensionArgument = (config.extraBrowserArgs ?? [])
    .find((value) => /chrome-extension:/i.test(String(value ?? "")));
  if (startUrlProtocol === "chrome-extension:" || extensionArgument) {
    throw new Error("native browser capture refuses direct chrome-extension URL navigation");
  }
  if (
    (config.platform === "darwin" || config.platform === "macos") &&
    config.browserBundleId !== MACOS_CHROME_FOR_TESTING_BUNDLE_ID
  ) {
    throw new Error(
      `macOS capture requires Chrome for Testing bundle ${MACOS_CHROME_FOR_TESTING_BUNDLE_ID}`,
    );
  }
  if (!Number.isInteger(config.width) || config.width < 640) {
    throw new Error("capture width must be an integer of at least 640 pixels");
  }
  if (!Number.isInteger(config.height) || config.height < 480) {
    throw new Error("capture height must be an integer of at least 480 pixels");
  }
  if (!Number.isInteger(config.browserWidth) || config.browserWidth < 640) {
    throw new Error("browser width must be an integer of at least 640 pixels");
  }
  if (!Number.isInteger(config.browserHeight) || config.browserHeight < 480) {
    throw new Error("browser height must be an integer of at least 480 pixels");
  }
  if (config.browserWidth * config.height !== config.browserHeight * config.width) {
    throw new Error("browser window and recording canvas must use the same aspect ratio");
  }
  if (!Number.isFinite(config.fps) || config.fps <= 0 || config.fps > 60) {
    throw new Error("capture fps must be greater than 0 and no greater than 60");
  }
  if (!Number.isFinite(config.durationSeconds) || config.durationSeconds <= 0) {
    throw new Error("capture durationSeconds must be greater than 0");
  }
  if (live && (
    !config.extensionDir ||
    !config.extensionArtifact ||
    !config.extensionLockPath ||
    !config.extensionSha256 ||
    !config.repoRoot
  )) {
    throw new Error(
      "live native capture requires repoRoot, extensionDir, extensionArtifact, extensionLockPath, and extensionSha256",
    );
  }
}

export async function findExecutable(candidates, env = process.env) {
  const pathEntries = (env.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const candidate of candidates.filter(Boolean)) {
    const paths = path.isAbsolute(candidate)
      ? [candidate]
      : pathEntries.map((entry) => path.join(entry, candidate));
    for (const executablePath of paths) {
      try {
        await access(executablePath, fsConstants.X_OK);
        return executablePath;
      } catch {
        // Try the next candidate.
      }
    }
  }
  return undefined;
}

export async function makePrivateTempDir(prefix = "acp-demo-capture-") {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  await chmod(directory, 0o700);
  return directory;
}

export async function writePrivateJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await chmod(filePath, 0o600);
}

export function validatePinnedExtensionPreferences(preferences, expectedExtensionId) {
  if (!/^[a-p]{32}$/.test(expectedExtensionId ?? "")) {
    throw new Error("pinned extension preferences require the verified extension ID");
  }
  const expected = [expectedExtensionId];
  const localPins = preferences?.extensions?.pinned_extensions;
  const accountPins = preferences?.account_values?.extensions?.pinned_extensions;
  if (
    JSON.stringify(localPins) !== JSON.stringify(expected)
    || JSON.stringify(accountPins) !== JSON.stringify(expected)
  ) {
    throw new Error("pinned extension preferences must contain only the verified extension ID");
  }
  return preferences;
}

export async function seedPinnedExtensionPreferences(profileDir, expectedExtensionId) {
  const preferences = validatePinnedExtensionPreferences({
    account_values: {
      extensions: { pinned_extensions: [expectedExtensionId] },
    },
    extensions: { pinned_extensions: [expectedExtensionId] },
  }, expectedExtensionId);
  const preferencesPath = path.join(profileDir, "Default", "Preferences");
  await writePrivateJson(preferencesPath, preferences);
  return { preferencesPath, preferences };
}

export async function sha256File(filePath) {
  const hash = createHash("sha256");
  hash.update(await readFile(filePath));
  return hash.digest("hex");
}

export async function verifyExtensionArtifact({
  extensionArtifact,
  expectedSha256,
  extensionDir,
  expectedExtensionId,
  extensionLockPath,
  repoRoot,
  verifyExtensionTree = assertCaptureExtensionMatches,
}) {
  if (!repoRoot || !extensionLockPath) {
    throw new Error("extension artifact verification requires repoRoot and extensionLockPath");
  }
  const gate = await verifyExtensionTree({
    repoRoot,
    lockPath: extensionLockPath,
    extensionDir,
  });
  if (path.resolve(gate.zipPath) !== path.resolve(extensionArtifact)) {
    throw new Error("extensionArtifact does not match the ZIP bound by extensionLockPath");
  }
  if (path.resolve(gate.unpackedPath) !== path.resolve(extensionDir)) {
    throw new Error("extensionDir does not match the unpacked tree bound by extensionLockPath");
  }
  const artifactInfo = await stat(extensionArtifact);
  if (!artifactInfo.isFile()) {
    throw new Error("extensionArtifact must be a file built for this capture");
  }
  const actualSha256 = await sha256File(extensionArtifact);
  if (!/^[a-f0-9]{64}$/i.test(expectedSha256 ?? "")) {
    throw new Error("extensionSha256 must be a 64-character hexadecimal digest");
  }
  if (actualSha256.toLowerCase() !== expectedSha256.toLowerCase()) {
    throw new Error("extension artifact digest does not match extensionSha256");
  }

  const manifestPath = path.join(extensionDir, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const derivedExtensionId = manifest.key ? extensionIdFromManifestKey(manifest.key) : undefined;
  if (expectedExtensionId && derivedExtensionId && expectedExtensionId !== derivedExtensionId) {
    throw new Error("extensionId does not match the key in the captured manifest");
  }
  const extensionId = expectedExtensionId ?? derivedExtensionId;
  if (!extensionId) {
    throw new Error("extensionId is required when manifest.json has no key");
  }

  return {
    artifactPath: extensionArtifact,
    sha256: actualSha256,
    extensionId,
    name: manifest.name,
    version: manifest.version,
  };
}

export function extensionIdFromManifestKey(base64Key) {
  const publicKey = Buffer.from(base64Key, "base64");
  const digest = createHash("sha256").update(publicKey).digest().subarray(0, 16);
  let id = "";
  for (const byte of digest) {
    id += CHROME_ID_ALPHABET[byte >> 4];
    id += CHROME_ID_ALPHABET[byte & 0x0f];
  }
  return id;
}

export function chromeLaunchArgs(config, profileDir, remoteDebuggingPort = 0) {
  if (!config.extensionDir) {
    throw new Error("extensionDir is required to build Chrome for Testing arguments");
  }
  return [
    `--user-data-dir=${profileDir}`,
    `--remote-debugging-port=${remoteDebuggingPort}`,
    `--window-size=${config.browserWidth},${config.browserHeight}`,
    "--window-position=0,0",
    "--force-device-scale-factor=1",
    "--no-first-run",
    "--no-default-browser-check",
    "--password-store=basic",
    "--use-mock-keychain",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-sync",
    "--disable-features=Translate",
    `--disable-extensions-except=${config.extensionDir}`,
    `--load-extension=${config.extensionDir}`,
    ...config.extraBrowserArgs,
    config.startUrl,
  ];
}

// The bearer token lives in this parent Node process only so the native-panel
// driver can inject it over CDP; no capture subprocess (Chrome, Xvfb, ffmpeg,
// xdotool, the AT-SPI Python helper, osascript/Hammerspoon, or `ps`) needs it.
// Strip caller credentials from any inherited environment before it reaches a
// child, enforcing the "pass credentials only to the process that needs them"
// boundary. Mirrors render's sanitizedInheritedEnv and compose's
// sanitizedSubprocessEnvironment so the boundary is uniform across the skill.
// Scrubbing runs on the final merged environment, so a generic override
// (e.g. {env: process.env}) can never reintroduce a sensitive value.
export const CALLER_SENSITIVE_ENVIRONMENT = new Set(["ACP_BEARER_TOKEN"]);

export function sanitizedInheritedEnv(base = process.env, overrides = {}) {
  const environment = { ...base, ...overrides };
  for (const name of CALLER_SENSITIVE_ENVIRONMENT) {
    delete environment[name];
  }
  return environment;
}

export function spawnCommand(executable, args, options = {}) {
  if (!executable || !Array.isArray(args)) {
    throw new Error("commands must use an executable and an argument array");
  }
  return spawn(executable, args, {
    stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
    // Secure by default: caller credentials are stripped whether the child
    // inherits the host environment or a caller supplies an explicit env, so an
    // explicit env can never bypass scrubbing.
    env: sanitizedInheritedEnv(options.env ?? process.env),
    cwd: options.cwd,
    detached: options.detached ?? false,
  });
}

export async function commandOutput(executable, args, options = {}) {
  const child = spawnCommand(executable, args, options);
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk) => { stdout += chunk; });
  child.stderr?.on("data", (chunk) => { stderr += chunk; });
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  if (exitCode !== 0) {
    throw new Error(`${path.basename(executable)} failed: ${stderr.trim() || `exit ${exitCode}`}`);
  }
  return { stdout, stderr };
}

export function chromeForTestingVersion(output) {
  const match = String(output).match(/(?:Google Chrome for Testing|Chromium)\s+(\d+\.\d+\.\d+\.\d+)/i);
  return match?.[1];
}

export async function verifyPinnedChromeForTesting(executable) {
  const result = await commandOutput(executable, ["--version"]);
  const actual = chromeForTestingVersion(`${result.stdout}\n${result.stderr}`);
  if (actual !== PINNED_CHROME_FOR_TESTING_VERSION) {
    throw new Error(
      `Chrome for Testing must be ${PINNED_CHROME_FOR_TESTING_VERSION}; found ${actual ?? "an unrecognized version"}`,
    );
  }
  return actual;
}

export async function waitForDevToolsPort(profileDir, timeoutMs = 15_000) {
  const activePortPath = path.join(profileDir, "DevToolsActivePort");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const [portLine] = (await readFile(activePortPath, "utf8")).trim().split(/\r?\n/);
      const port = Number(portLine);
      if (Number.isInteger(port) && port > 0) return port;
    } catch {
      // Chrome writes this file after the debugging endpoint is ready.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Chrome for Testing did not publish DevToolsActivePort");
}

const SIGKILL_EXIT_TIMEOUT_MS = 5_000;

export async function stopProcess(child, signal = "SIGINT", timeoutMs = 5_000) {
  if (!child || child.exitCode !== null) return;
  child.kill(signal);
  const exited = await waitForProcessExit(child, timeoutMs);
  if (!exited && child.exitCode === null) {
    child.kill("SIGKILL");
    await waitForProcessExit(child, SIGKILL_EXIT_TIMEOUT_MS);
  }
}

function waitForProcessExit(child, timeoutMs) {
  if (child.exitCode !== null) return Promise.resolve(true);
  return new Promise((resolve, reject) => {
    let timer;
    const cleanup = () => {
      child.off("exit", onExit);
      child.off("error", onError);
      if (timer) clearTimeout(timer);
    };
    const onExit = () => {
      cleanup();
      resolve(true);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    child.once("exit", onExit);
    child.once("error", onError);
    if (timeoutMs !== undefined) {
      timer = setTimeout(() => {
        cleanup();
        resolve(false);
      }, timeoutMs);
    }
  });
}

export async function cleanupPrivateProfile(profileRoot, keepProfile) {
  if (!keepProfile && profileRoot) {
    await rm(profileRoot, { recursive: true, force: true });
  }
}

export function monotonicSeconds() {
  return Number(process.hrtime.bigint()) / 1e9;
}

export function remainingCaptureHoldMilliseconds(
  durationSeconds,
  captureStartedAtSeconds,
  nowSeconds,
) {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new Error("native capture duration budget must be positive");
  }
  if (
    !Number.isFinite(captureStartedAtSeconds)
    || captureStartedAtSeconds < 0
    || !Number.isFinite(nowSeconds)
    || nowSeconds < captureStartedAtSeconds
  ) {
    throw new Error("native capture duration budget requires valid monotonic timestamps");
  }
  const elapsedSeconds = nowSeconds - captureStartedAtSeconds;
  const remainingSeconds = durationSeconds - elapsedSeconds;
  if (remainingSeconds <= 0) {
    throw new Error(
      `native capture actions exhausted the ${durationSeconds}s authored recording budget after ${elapsedSeconds.toFixed(3)}s`,
    );
  }
  return remainingSeconds * 1_000;
}

export function cleanupFailure(primaryError, errors) {
  const failures = errors.filter(Boolean);
  if (primaryError) {
    if (failures.length > 0) {
      Object.defineProperty(primaryError, "cleanupErrors", {
        configurable: true,
        enumerable: false,
        value: failures,
      });
    }
    return primaryError;
  }
  if (failures.length === 0) return undefined;
  if (failures.length === 1) return failures[0];
  return new AggregateError(failures, "capture cleanup failed");
}

export async function finalizePointerEvents(
  rawPath,
  outputPath,
  { captureStartedAtSeconds, durationSeconds } = {},
) {
  let source = "";
  try {
    source = await readFile(rawPath, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const events = source.split(/\r?\n/).filter(Boolean).map((line, index) => {
    try {
      return { event: JSON.parse(line), inputIndex: index };
    } catch {
      throw new Error(`pointer event line ${index + 1} is not valid JSON`);
    }
  });
  const boundedToCapture = captureStartedAtSeconds !== undefined || durationSeconds !== undefined;
  if (boundedToCapture && (
    !Number.isFinite(captureStartedAtSeconds)
    || captureStartedAtSeconds < 0
    || !Number.isFinite(durationSeconds)
    || durationSeconds <= 0
  )) {
    throw new Error("pointer event capture bounds require a valid start and positive duration");
  }
  const validated = events.map(({ event, inputIndex }) => {
    const timestamp = event.monotonicSeconds;
    if (!Number.isFinite(timestamp)) {
      throw new Error(`pointer event ${inputIndex + 1} does not have a finite monotonic timestamp`);
    }
    if (!Number.isFinite(event.x) || !Number.isFinite(event.y) || event.x < 0 || event.x > 1 || event.y < 0 || event.y > 1) {
      throw new Error(`pointer event ${inputIndex + 1} is outside normalized browser coordinates`);
    }
    return { event, inputIndex, timestamp };
  });
  validated.sort((left, right) => (
    left.timestamp - right.timestamp || left.inputIndex - right.inputIndex
  ));
  const origin = boundedToCapture
    ? captureStartedAtSeconds
    : (validated[0]?.timestamp ?? 0);
  const normalized = validated.map(({ event, inputIndex, timestamp }) => {
    const time = timestamp - origin;
    if (boundedToCapture && (time < 0 || time >= durationSeconds)) {
      throw new Error(`pointer event ${inputIndex + 1} falls outside the authored capture duration`);
    }
    return { ...event, time };
  });
  await mkdir(path.dirname(outputPath), { recursive: true, mode: 0o700 });
  const jsonl = normalized.map((event) => JSON.stringify(event)).join("\n");
  await writeFile(outputPath, jsonl ? `${jsonl}\n` : "", {
    encoding: "utf8",
    mode: 0o600,
  });
  await chmod(outputPath, 0o600);
  return normalized;
}

export async function appendPointerEvent(rawPath, event) {
  await mkdir(path.dirname(rawPath), { recursive: true, mode: 0o700 });
  await appendFile(rawPath, `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(rawPath, 0o600);
}

export async function createTemporaryConnectionRegistry(root, connection) {
  const parsed = new URL(connection.apiUrl);
  const isLoopback = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
  if (parsed.protocol !== "http:" || !isLoopback) {
    throw new Error("uploadConnection requires ACP_URL to use a loopback HTTP origin");
  }
  if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(connection.name ?? "")) {
    throw new Error("uploadConnection requires a DNS-style scenario id");
  }
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(connection.project ?? "")) {
    throw new Error("uploadConnection requires a DNS-style ACP project");
  }
  const now = new Date().toISOString();
  const registryPath = path.join(root, "kind-connections.json");
  await writePrivateJson(registryPath, {
    version: 1,
    generated_at: now,
    connections: [{
      id: `kind:${connection.name}`,
      name: connection.name,
      context: `kind-${connection.name}`,
      api_url: parsed.origin,
      ui_url: parsed.origin,
      default_project: connection.project,
      ready: true,
      updated_at: now,
    }],
  });
  return registryPath;
}

export function normalizePoint(x, y, bounds) {
  if (!bounds || bounds.width <= 0 || bounds.height <= 0) {
    throw new Error("pointer bounds must have positive width and height");
  }
  return {
    x: Math.min(1, Math.max(0, (x - bounds.x) / bounds.width)),
    y: Math.min(1, Math.max(0, (y - bounds.y) / bounds.height)),
  };
}
