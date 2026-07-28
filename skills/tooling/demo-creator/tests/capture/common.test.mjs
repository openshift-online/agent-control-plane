import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  chromeLaunchArgs,
  chromeForTestingVersion,
  commandOutput,
  createTemporaryConnectionRegistry,
  extensionIdFromManifestKey,
  finalizePointerEvents,
  remainingCaptureHoldMilliseconds,
  normalizePoint,
  resolveCaptureConfig,
  sanitizedInheritedEnv,
  stopProcess,
  validateCaptureConfig,
  verifyExtensionArtifact,
} from "../../scripts/capture/common.mjs";

const ACP_MANIFEST_KEY = "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAs6ufH/8UK7mrllfN4zKCtqLlWXQwqW8bjg7oZJyf2nrtoPzmo2mogoKLi5qfraZSxtQ+CFqywjxuMPe9lqWuEIKuvNW8SWCqHxm6SkBGM1SjU4N3JdPoopo8R5EJORu5uUcoFvYTA34OIoKaD1EJ1YcRJh3NObzUqofNKXVHsJ4dbX5mDOlM0IuYuH8zSx373nX8BLSUtE2AI925jKkVXiIhvYr2Yn91w/hsqybkhNo4mjIi5/fFaLFAE+laYrUJaOOlonWLxL6hVemuRFtO8TJSD+jaFzDZxcUv90Rt86AyPf8m+CPArC8wxPnl1iobF6UFt/gqfDgS0aDbdx09kQIDAQAB";

test("derives the stable Chrome extension ID from manifest.key", () => {
  assert.equal(extensionIdFromManifestKey(ACP_MANIFEST_KEY), "bjlckanpiblmfadkmknbbpeenckfdgpi");
});

test("Chrome arguments isolate the profile and load only the target extension", () => {
  const args = chromeLaunchArgs({
    extensionDir: "/tmp/extension with spaces",
    width: 1920,
    height: 1080,
    browserWidth: 1280,
    browserHeight: 720,
    extraBrowserArgs: [],
    startUrl: "https://example.invalid/",
  }, "/tmp/private profile");
  assert.ok(args.includes("--disable-extensions-except=/tmp/extension with spaces"));
  assert.ok(args.includes("--load-extension=/tmp/extension with spaces"));
  assert.ok(args.includes("--user-data-dir=/tmp/private profile"));
  assert.ok(args.includes("--use-mock-keychain"));
  assert.ok(args.includes("--password-store=basic"));
  assert.ok(args.includes("--window-size=1280,720"));
  assert.equal(args.includes("--no-sandbox"), false);
  assert.equal(args.at(-1), "https://example.invalid/");
  assert.equal(args.some((arg) => arg.includes(";")), false);
});

test("native capture refuses sandbox and keychain overrides in extra arguments", () => {
  const protectedArguments = [
    "--no-sandbox",
    "--no-sandbox=true",
    "--disable-sandbox=true",
    "--disable-setuid-sandbox=1",
    "--disable-seccomp-filter-sandbox",
    "--password-store=keychain",
    "--use-mock-keychain=false",
    "--user-data-dir=/tmp/shared-profile",
    "--profile-directory=Default",
    "--load-extension=/tmp/other-extension",
    "--disable-extensions-except=/tmp/other-extension",
    "--remote-debugging-port=9222",
    "--remote-debugging-address=0.0.0.0",
    "--remote-debugging-pipe",
    "--remote-debugging-socket-fd=7",
    "--remote-allow-origins=*",
  ];
  for (const argument of protectedArguments) {
    assert.throws(
      () => validateCaptureConfig({
        width: 1920,
        height: 1080,
        fps: 30,
        durationSeconds: 1,
        dryRun: true,
        extraBrowserArgs: [argument],
      }),
      /refuses protected browser argument/,
    );
  }
});

test("native capture refuses every direct extension URL navigation path", () => {
  const base = {
    width: 1920,
    height: 1080,
    fps: 30,
    durationSeconds: 1,
    dryRun: true,
    extraBrowserArgs: [],
  };
  assert.throws(
    () => validateCaptureConfig({
      ...base,
      startUrl: "ChRoMe-ExTeNsIoN://bjlckanpiblmfadkmknbbpeenckfdgpi/index.html",
    }),
    /refuses direct chrome-extension URL navigation/,
  );
  assert.throws(
    () => validateCaptureConfig({
      ...base,
      startUrl: "about:blank",
      extraBrowserArgs: ["--app=ChRoMe-ExTeNsIoN://bjlckanpiblmfadkmknbbpeenckfdgpi/index.html"],
    }),
    /refuses direct chrome-extension URL navigation/,
  );
});

test("command output rejects child-process spawn errors", async () => {
  await assert.rejects(
    commandOutput("/definitely/missing/acp-demo-command", []),
    /ENOENT/,
  );
});

test("sanitizedInheritedEnv strips caller credentials but keeps the rest", () => {
  const base = {
    PATH: "/usr/bin",
    HOME: "/home/demo",
    DISPLAY: ":99",
    ACP_URL: "http://127.0.0.1:8080",
    ACP_PROJECT: "demo-example",
    ACP_BEARER_TOKEN: "synthetic-test-credential",
  };
  const sanitized = sanitizedInheritedEnv(base, {
    DISPLAY: ":123",
    NO_AT_BRIDGE: "0",
    ACP_BEARER_TOKEN: "override-attempt",
  });
  assert.equal(Object.hasOwn(sanitized, "ACP_BEARER_TOKEN"), false);
  assert.equal(sanitized.PATH, "/usr/bin");
  assert.equal(sanitized.HOME, "/home/demo");
  // Non-secret ACP inputs are retained; only the credential is removed.
  assert.equal(sanitized.ACP_URL, "http://127.0.0.1:8080");
  assert.equal(sanitized.ACP_PROJECT, "demo-example");
  // Non-secret overrides still apply; a sensitive override can never reintroduce
  // the credential, because scrubbing runs on the final merged environment.
  assert.equal(sanitized.DISPLAY, ":123");
  assert.equal(sanitized.NO_AT_BRIDGE, "0");
  // The base object is never mutated.
  assert.equal(base.ACP_BEARER_TOKEN, "synthetic-test-credential");
  assert.equal(JSON.stringify(sanitized).includes("synthetic-test-credential"), false);
});

test("commandOutput never leaks the bearer token into a spawned child", async () => {
  const priorToken = process.env.ACP_BEARER_TOKEN;
  const priorMarker = process.env.CAPTURE_ENV_MARKER;
  process.env.ACP_BEARER_TOKEN = "synthetic-test-credential";
  process.env.CAPTURE_ENV_MARKER = "inherited-non-secret";
  try {
    // No explicit env option: the child must inherit the sanitized default.
    const { stdout } = await commandOutput(process.execPath, [
      "-e",
      "process.stdout.write(JSON.stringify({token:process.env.ACP_BEARER_TOKEN??null,marker:process.env.CAPTURE_ENV_MARKER??null}))",
    ]);
    const seen = JSON.parse(stdout);
    assert.equal(seen.token, null, "child process must not receive ACP_BEARER_TOKEN");
    assert.equal(seen.marker, "inherited-non-secret", "non-secret env must still be inherited");
    assert.equal(stdout.includes("synthetic-test-credential"), false);
  } finally {
    if (priorToken === undefined) delete process.env.ACP_BEARER_TOKEN;
    else process.env.ACP_BEARER_TOKEN = priorToken;
    if (priorMarker === undefined) delete process.env.CAPTURE_ENV_MARKER;
    else process.env.CAPTURE_ENV_MARKER = priorMarker;
  }
});

test("commandOutput scrubs the bearer token even when an explicit env is supplied", async () => {
  // An explicit env option must not bypass scrubbing: a caller passing
  // {env: process.env} (or any env carrying the token) must not leak it.
  const { stdout } = await commandOutput(process.execPath, [
    "-e",
    "process.stdout.write(JSON.stringify({token:process.env.ACP_BEARER_TOKEN??null,marker:process.env.CAPTURE_ENV_MARKER??null}))",
  ], {
    env: { ACP_BEARER_TOKEN: "override-attempt", CAPTURE_ENV_MARKER: "explicit-non-secret" },
  });
  const seen = JSON.parse(stdout);
  assert.equal(seen.token, null, "explicit env must not deliver ACP_BEARER_TOKEN to the child");
  assert.equal(seen.marker, "explicit-non-secret", "non-secret explicit env must still be applied");
  assert.equal(stdout.includes("override-attempt"), false);
});

test("process cleanup waits for exit after escalating to SIGKILL", async () => {
  const child = new EventEmitter();
  child.exitCode = null;
  child.signals = [];
  child.kill = (signal) => {
    child.signals.push(signal);
    return true;
  };

  let settled = false;
  const stopping = stopProcess(child, "SIGINT", 1).then(() => { settled = true; });
  await delay(10);
  assert.deepEqual(child.signals, ["SIGINT", "SIGKILL"]);
  assert.equal(settled, false);

  child.exitCode = 137;
  child.emit("exit", 137, "SIGKILL");
  await stopping;
  assert.equal(settled, true);
});

test("parses the exact pinned Chrome for Testing build version", () => {
  assert.equal(
    chromeForTestingVersion("Google Chrome for Testing 151.0.7922.34"),
    "151.0.7922.34",
  );
  assert.equal(chromeForTestingVersion("Google Chrome 151.0.7922.34"), undefined);
});

test("exact extension artifact digest and manifest identity are verified", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "capture-test-"));
  const extensionDir = path.join(root, "extension");
  await mkdir(extensionDir);
  await writeFile(path.join(extensionDir, "manifest.json"), JSON.stringify({
    name: "ACP Sessions (OpenShell-as-a-Service)",
    version: "0.1.1",
    key: ACP_MANIFEST_KEY,
  }));
  const artifact = path.join(root, "extension.zip");
  const bytes = Buffer.from("synthetic extension artifact");
  await writeFile(artifact, bytes);
  const digest = createHash("sha256").update(bytes).digest("hex");
  const gateCalls = [];
  const gate = async (options) => {
    gateCalls.push(options);
    return { zipPath: artifact, unpackedPath: extensionDir };
  };
  const verification = {
    extensionArtifact: artifact,
    extensionDir,
    extensionLockPath: path.join(root, "extension.lock.json"),
    repoRoot: root,
    verifyExtensionTree: gate,
  };
  const verified = await verifyExtensionArtifact({
    ...verification,
    expectedSha256: digest,
    expectedExtensionId: "bjlckanpiblmfadkmknbbpeenckfdgpi",
  });
  assert.equal(verified.sha256, digest);
  assert.equal(verified.extensionId, "bjlckanpiblmfadkmknbbpeenckfdgpi");
  assert.deepEqual(gateCalls[0], {
    repoRoot: root,
    lockPath: verification.extensionLockPath,
    extensionDir,
  });
  await assert.rejects(
    verifyExtensionArtifact({
      ...verification,
      expectedSha256: "0".repeat(64),
    }),
    /digest does not match/,
  );
});

test("extension verification rejects a ZIP path not bound by the verified lock", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "capture-binding-"));
  const extensionDir = path.join(root, "extension");
  const artifact = path.join(root, "extension.zip");
  await mkdir(extensionDir);
  await writeFile(artifact, "replacement");
  await assert.rejects(
    verifyExtensionArtifact({
      extensionArtifact: artifact,
      expectedSha256: createHash("sha256").update("replacement").digest("hex"),
      extensionDir,
      extensionLockPath: path.join(root, "extension.lock.json"),
      repoRoot: root,
      verifyExtensionTree: async () => ({
        zipPath: path.join(root, "verified.zip"),
        unpackedPath: extensionDir,
      }),
    }),
    /ZIP bound by extensionLockPath/,
  );
});

test("normalizes pointer coordinates and clamps events outside the browser", () => {
  assert.deepEqual(normalizePoint(150, 250, { x: 100, y: 200, width: 200, height: 100 }), {
    x: 0.25,
    y: 0.5,
  });
  assert.deepEqual(normalizePoint(-10, 999, { x: 0, y: 0, width: 100, height: 100 }), {
    x: 0,
    y: 1,
  });
});

test("finalized pointer events use the documented JSONL contract", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "capture-pointer-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const rawPath = path.join(root, "pointer-events.raw.jsonl");
  const outputPath = path.join(root, "pointer-events.jsonl");
  await writeFile(rawPath, [
    JSON.stringify({ type: "move", monotonicSeconds: 10, x: 0.2, y: 0.3 }),
    JSON.stringify({ type: "click", monotonicSeconds: 10.5, x: 0.4, y: 0.5 }),
    "",
  ].join("\n"));
  await finalizePointerEvents(rawPath, outputPath);
  const lines = (await readFile(outputPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(lines.map((event) => event.time), [0, 0.5]);
  assert.deepEqual(lines.map((event) => event.type), ["move", "click"]);
});

test("finalized pointer events stably merge out-of-order concurrent writers", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "capture-pointer-merge-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const rawPath = path.join(root, "pointer-events.raw.jsonl");
  const outputPath = path.join(root, "pointer-events.jsonl");
  await writeFile(rawPath, [
    JSON.stringify({ type: "click", source: "lua", monotonicSeconds: 10.3, x: 0.4, y: 0.5 }),
    JSON.stringify({ type: "move", source: "delayed-lua", monotonicSeconds: 10.1, x: 0.2, y: 0.3 }),
    JSON.stringify({ type: "click", source: "node-1", monotonicSeconds: 10.3, x: 0.5, y: 0.6 }),
    JSON.stringify({ type: "click", source: "node-2", monotonicSeconds: 10.3, x: 0.6, y: 0.7 }),
    "",
  ].join("\n"));

  const events = await finalizePointerEvents(rawPath, outputPath);

  assert.deepEqual(events.map((event) => event.source), ["delayed-lua", "lua", "node-1", "node-2"]);
  assert.equal(events[0].time, 0);
  assert.ok(Math.abs(events[1].time - 0.2) < 1e-9);
  assert.equal(events[2].time, events[1].time);
  assert.equal(events[3].time, events[1].time);
  const persisted = (await readFile(outputPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(persisted, events);
});

test("native capture duration is a total recorder budget, not a post-action hold", () => {
  assert.equal(remainingCaptureHoldMilliseconds(54, 100, 110), 44_000);
  assert.throws(
    () => remainingCaptureHoldMilliseconds(54, 100, 154),
    /actions exhausted the 54s authored recording budget after 54\.000s/,
  );
  assert.throws(
    () => remainingCaptureHoldMilliseconds(54, 100, 155),
    /actions exhausted the 54s authored recording budget after 55\.000s/,
  );
});

test("capture-bounded pointer finalization rejects events at or beyond authored duration", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "capture-pointer-budget-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const rawPath = path.join(root, "pointer-events.raw.jsonl");
  const outputPath = path.join(root, "pointer-events.jsonl");
  await writeFile(rawPath, [
    JSON.stringify({ type: "move", monotonicSeconds: 101, x: 0.2, y: 0.3 }),
    JSON.stringify({ type: "click", monotonicSeconds: 153.999, x: 0.4, y: 0.5 }),
    "",
  ].join("\n"));
  const events = await finalizePointerEvents(rawPath, outputPath, {
    captureStartedAtSeconds: 100,
    durationSeconds: 54,
  });
  assert.equal(events[0].time, 1);
  assert.ok(Math.abs(events[1].time - 53.999) < 1e-9);

  await writeFile(rawPath, `${JSON.stringify({
    type: "click",
    monotonicSeconds: 154,
    x: 0.4,
    y: 0.5,
  })}\n`);
  await assert.rejects(
    finalizePointerEvents(rawPath, outputPath, {
      captureStartedAtSeconds: 100,
      durationSeconds: 54,
    }),
    /falls outside the authored capture duration/,
  );
});

test("live capture requires a repository and lock-bound extension artifact", () => {
  const config = resolveCaptureConfig({ scenario: {}, scenarioDir: "/tmp" });
  assert.deepEqual(
    { capture: [config.width, config.height], browser: [config.browserWidth, config.browserHeight] },
    { capture: [1920, 1080], browser: [1280, 720] },
  );
  assert.throws(() => validateCaptureConfig(config), /repoRoot, extensionDir, extensionArtifact, extensionLockPath/);
  const dry = resolveCaptureConfig({ scenario: {}, captureOptions: { dryRun: true }, scenarioDir: "/tmp" });
  assert.doesNotThrow(() => validateCaptureConfig(dry));
});

test("native capture validates browser dimensions independently from the recording canvas", () => {
  const config = resolveCaptureConfig({
    scenario: {},
    captureOptions: { dryRun: true, width: 1920, height: 1080, browserWidth: 639, browserHeight: 720 },
    scenarioDir: "/tmp",
  });
  assert.throws(() => validateCaptureConfig(config), /browser width must be an integer of at least 640/);
  assert.doesNotThrow(() => validateCaptureConfig({ ...config, browserWidth: 1280 }));
  assert.throws(
    () => validateCaptureConfig({ ...config, browserWidth: 1280, browserHeight: 800 }),
    /must use the same aspect ratio/,
  );
});

test("macOS capture targets Chrome for Testing by its exact bundle identity", () => {
  const config = resolveCaptureConfig({
    scenario: {},
    captureOptions: { dryRun: true },
    scenarioDir: "/tmp",
  }, "darwin");
  assert.equal(config.browserBundleId, "com.google.chrome.for.testing");
});

test("macOS capture rejects a Chrome bundle identity override", () => {
  const config = resolveCaptureConfig({
    scenario: {},
    captureOptions: {
      dryRun: true,
      browserBundleId: "com.google.ChromeForTesting",
    },
    scenarioDir: "/tmp",
  }, "darwin");
  assert.throws(
    () => validateCaptureConfig(config, { live: false }),
    /requires Chrome for Testing bundle com\.google\.chrome\.for\.testing/,
  );
});

test("generates a current token-free connection registry in private storage", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "capture-registry-"));
  const registryPath = await createTemporaryConnectionRegistry(root, {
    apiUrl: "http://127.0.0.1:8080",
    project: "demo-extension-flow",
    name: "extension-flow",
  });
  const registryText = await readFile(registryPath, "utf8");
  const registry = JSON.parse(registryText);
  assert.equal(registry.connections[0].api_url, "http://127.0.0.1:8080");
  assert.equal(registry.connections[0].default_project, "demo-extension-flow");
  assert.equal(/token|bearer|credential|password/i.test(registryText), false);
  assert.ok(Date.now() - Date.parse(registry.generated_at) < 5_000);
});
