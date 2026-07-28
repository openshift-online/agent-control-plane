import assert from "node:assert/strict";
import { spawn as realSpawn } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import * as realFs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";
import { ANDROID_LAUNCH_ACTIVITY_MAX_CHARACTERS } from "../../../scripts/core/android-contract.mjs";

let deviceOperations = {};
try {
  deviceOperations = await import("../../../scripts/capture/android/device-operations.mjs");
} catch (error) {
  if (error?.code !== "ERR_MODULE_NOT_FOUND") throw error;
}

test("exports the closed Android device operation boundary", () => {
  assert.equal(typeof deviceOperations.createAndroidDeviceOperations, "function");

  const operations = deviceOperations.createAndroidDeviceOperations();
  assert.deepEqual(Object.keys(operations).sort(), [
    "createAndroidDriver",
    "createOwnedAvd",
    "disableAndroidPointerOverlays",
    "establishOwnedAcpReverse",
    "installVerifiedAndroidApk",
    "launchAndroidApplication",
    "removeOwnedAcpReverse",
    "verifyAndroidDisplayGeometry",
    "verifyInstalledAndroidApp",
  ]);
  assert.equal(Object.isFrozen(operations), true);
  for (const operation of Object.values(operations)) {
    assert.equal(typeof operation, "function");
  }
});

test("establishes and removes one exact serial-bound loopback ACP reverse with fresh proofs", async () => {
  const calls = [];
  let present = false;
  const operations = deviceOperations.createAndroidDeviceOperations({
    runCommand: async (executable, args, options) => {
      calls.push({ executable, args, options });
      if (args.at(-1) === "--list") {
        return { stdout: present ? "emulator-5580 tcp:38217 tcp:42101\n" : "", stderr: "" };
      }
      if (args.includes("--remove")) present = false;
      else present = true;
      return { stdout: "", stderr: "" };
    },
  });

  const reverse = await operations.establishOwnedAcpReverse({
    serial: "emulator-5580",
    adbPath: "/sdk/adb",
    devicePort: 38217,
    hostPort: 42101,
  });
  assert.deepEqual(reverse, {
    serial: "emulator-5580",
    devicePort: 38217,
    hostPort: 42101,
    acpUrl: "http://127.0.0.1:38217",
  });
  assert.deepEqual(
    await operations.removeOwnedAcpReverse(reverse, { adbPath: "/sdk/adb" }),
    { action: "deleted", devicePort: 38217 },
  );
  assert.deepEqual(
    await operations.removeOwnedAcpReverse(reverse, { adbPath: "/sdk/adb" }),
    { action: "absent", devicePort: 38217 },
  );
  assert.deepEqual(calls.map(({ args }) => args), [
    ["-s", "emulator-5580", "reverse", "--list"],
    ["-s", "emulator-5580", "reverse", "tcp:38217", "tcp:42101"],
    ["-s", "emulator-5580", "reverse", "--list"],
    ["-s", "emulator-5580", "reverse", "--list"],
    ["-s", "emulator-5580", "reverse", "--remove", "tcp:38217"],
    ["-s", "emulator-5580", "reverse", "--list"],
    ["-s", "emulator-5580", "reverse", "--list"],
  ]);
  assert.ok(calls.every(({ options }) => options.shell === false));
});

test("fails closed on ambiguous reverse proof and preserves a changed mapping during cleanup", async () => {
  let mutated = false;
  const create = deviceOperations.createAndroidDeviceOperations({
    runCommand: async (_executable, args) => {
      if (args.at(-1) !== "--list") mutated = true;
      return {
        stdout: args.at(-1) === "--list"
          ? "emulator-5580 tcp:38217 tcp:42101\nemulator-5580 tcp:38217 tcp:49999\n"
          : "",
        stderr: "",
      };
    },
  });
  await assert.rejects(create.establishOwnedAcpReverse({
    serial: "emulator-5580",
    adbPath: "/sdk/adb",
    devicePort: 38217,
    hostPort: 42101,
  }), /reverse.*mapping.*refus|ambiguous|conflict/i);
  assert.equal(mutated, false);

  let removed = false;
  const cleanup = deviceOperations.createAndroidDeviceOperations({
    runCommand: async (_executable, args) => {
      if (args.includes("--remove")) removed = true;
      return {
        stdout: args.at(-1) === "--list" ? "emulator-5580 tcp:38217 tcp:49999\n" : "",
        stderr: "",
      };
    },
  });
  await assert.rejects(cleanup.removeOwnedAcpReverse({
    serial: "emulator-5580",
    devicePort: 38217,
    hostPort: 42101,
    acpUrl: "http://127.0.0.1:38217",
  }, { adbPath: "/sdk/adb" }), /mapping changed/i);
  assert.equal(removed, false);
});

test("preflights and reproves an already exact reverse mapping", async () => {
  const calls = [];
  const operations = deviceOperations.createAndroidDeviceOperations({
    runCommand: async (_executable, args) => {
      calls.push([...args]);
      return {
        stdout: args.at(-1) === "--list"
          ? "emulator-5580 tcp:38217 tcp:42101\n"
          : "",
        stderr: "",
      };
    },
  });

  assert.deepEqual(await operations.establishOwnedAcpReverse({
    serial: "emulator-5580",
    adbPath: "/sdk/adb",
    devicePort: 38217,
    hostPort: 42101,
  }), {
    serial: "emulator-5580",
    devicePort: 38217,
    hostPort: 42101,
    acpUrl: "http://127.0.0.1:38217",
  });
  assert.deepEqual(calls, [
    ["-s", "emulator-5580", "reverse", "--list"],
    ["-s", "emulator-5580", "reverse", "tcp:38217", "tcp:42101"],
    ["-s", "emulator-5580", "reverse", "--list"],
  ]);
});

const AVD_ROOT = "/private/run/demo/android/avd";
const SDK_ROOT = "/opt/android-sdk";
const AVDMANAGER = `${SDK_ROOT}/cmdline-tools/19.0/bin/avdmanager`;
const SYSTEM_IMAGE = "system-images;android-36.1;google_apis_playstore;arm64-v8a";

function slug(value, maximumLength) {
  return value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maximumLength)
    .replace(/-+$/g, "") || "id";
}

function avdOwnership(overrides = {}) {
  const scenarioId = "android-onboarding";
  const runId = "run-20260717";
  const nonce = "test-nonce";
  const digest = createHash("sha256")
    .update(JSON.stringify([scenarioId, runId, nonce]))
    .digest("hex")
    .slice(0, 12);
  const avdName = [
    "acp-demo",
    slug(scenarioId, 12),
    slug(runId, 12),
    slug(nonce, 8),
    digest,
  ].join("-");
  return {
    version: 1,
    toolNamespace: "acp.demo-creator.android-avd",
    scenarioId,
    runId,
    nonce,
    avdName,
    avdPath: `${AVD_ROOT}/${avdName}.avd`,
    systemImage: SYSTEM_IMAGE,
    markerPath: `/private/run/demo/markers/${avdName}.owner.json`,
    ...overrides,
  };
}

function avdMarker(ownership) {
  return Object.fromEntries([
    "version",
    "toolNamespace",
    "scenarioId",
    "runId",
    "nonce",
    "avdName",
    "avdPath",
    "systemImage",
  ].map((field) => [field, ownership[field]]));
}

function missing(pathname) {
  return Object.assign(new Error(`missing ${pathname}`), { code: "ENOENT" });
}

function createAvdHarness() {
  const ownership = avdOwnership();
  const calls = [];
  const reads = [];
  let created = false;
  const definitionPath = `${AVD_ROOT}/${ownership.avdName}.ini`;
  const configPath = `${ownership.avdPath}/config.ini`;
  const fs = {
    async realpath(pathname) {
      if ([AVD_ROOT, SDK_ROOT].includes(pathname)) return pathname;
      if (created && pathname === ownership.avdPath) return pathname;
      throw missing(pathname);
    },
    async lstat(pathname) {
      if ([AVD_ROOT, SDK_ROOT].includes(pathname)) {
        return { isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false };
      }
      if (pathname === ownership.markerPath) {
        return {
          ctimeMs: 100,
          dev: 1,
          ino: 2,
          isDirectory: () => false,
          isFile: () => true,
          isSymbolicLink: () => false,
          mode: 0o100600,
        };
      }
      if (created && pathname === ownership.avdPath) {
        return { isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false };
      }
      if (created && [definitionPath, configPath].includes(pathname)) {
        return { isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false };
      }
      throw missing(pathname);
    },
    async readFile(pathname, encoding) {
      assert.equal(encoding, "utf8");
      reads.push(pathname);
      if (pathname === definitionPath) {
        return `path=${ownership.avdPath}\ntarget=android-36.1\n`;
      }
      if (pathname === configPath) {
        return [
          `AvdId=${ownership.avdName}`,
          "image.sysdir.1=system-images/android-36.1/google_apis_playstore/arm64-v8a/",
          "",
        ].join("\n");
      }
      assert.equal(pathname, ownership.markerPath);
      return `${JSON.stringify(avdMarker(ownership))}\n`;
    },
  };
  const runCommand = async (executable, args, options) => {
    calls.push({ executable, args: [...args], options });
    created = true;
    return { stdout: "", stderr: "" };
  };
  return { calls, configPath, definitionPath, fs, ownership, reads, runCommand };
}

async function createRealAvdFailureHarness(t, name) {
  const createdRoot = await realFs.mkdtemp(path.join(os.tmpdir(), `demo-creator-${name}-`));
  const root = await realFs.realpath(createdRoot);
  t.after(() => realFs.rm(root, { recursive: true, force: true }));
  const avdRoot = path.join(root, "avds");
  const markerRoot = path.join(root, "markers");
  const sdkRoot = path.join(root, "sdk");
  await Promise.all([
    realFs.mkdir(avdRoot, { mode: 0o700 }),
    realFs.mkdir(markerRoot, { mode: 0o700 }),
    realFs.mkdir(sdkRoot, { mode: 0o700 }),
  ]);
  const ownership = avdOwnership({
    avdPath: path.join(avdRoot, `${avdOwnership().avdName}.avd`),
    markerPath: path.join(markerRoot, `${avdOwnership().avdName}.owner.json`),
  });
  await realFs.writeFile(
    ownership.markerPath,
    `${JSON.stringify(avdMarker(ownership))}\n`,
    { mode: 0o600 },
  );
  return {
    avdRoot,
    configPath: path.join(ownership.avdPath, "config.ini"),
    definitionPath: path.join(avdRoot, `${ownership.avdName}.ini`),
    ownership,
    sdkRoot,
  };
}

function closingAvdCreator(createArtifacts, exitCode) {
  return () => {
    const child = new EventEmitter();
    child.stdin = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    setImmediate(async () => {
      try {
        await createArtifacts();
        child.stdout.end();
        child.stderr.end();
        child.emit("close", exitCode);
      } catch {
        child.emit("error", new Error("fixture failed"));
        child.emit("close", 1);
      }
    });
    return child;
  };
}

async function writePartialAvd(fixture, { validConfig = false } = {}) {
  await realFs.mkdir(fixture.ownership.avdPath, { mode: 0o700 });
  await realFs.writeFile(
    fixture.definitionPath,
    `path=${fixture.ownership.avdPath}\ntarget=android-36.1\n`,
    { mode: 0o600 },
  );
  if (validConfig) {
    await realFs.writeFile(fixture.configPath, [
      `AvdId=${fixture.ownership.avdName}`,
      "image.sysdir.1=system-images/android-36.1/google_apis_playstore/arm64-v8a/",
      "",
    ].join("\n"), { mode: 0o600 });
  }
}

async function assertMissing(pathname) {
  await assert.rejects(realFs.lstat(pathname), { code: "ENOENT" });
}

test("cleans exact partial AVD artifacts after a nonzero creator exit", async (t) => {
  const fixture = await createRealAvdFailureHarness(t, "partial-create");
  const operations = deviceOperations.createAndroidDeviceOperations({
    fs: realFs,
    spawnProcess: closingAvdCreator(() => writePartialAvd(fixture), 1),
  });

  let failure;
  try {
    await operations.createOwnedAvd(fixture.ownership, {
      avdmanagerPath: path.join(fixture.sdkRoot, "avdmanager"),
      sdkRoot: fixture.sdkRoot,
      systemImage: SYSTEM_IMAGE,
    });
  } catch (error) {
    failure = error;
  }

  assert.match(failure?.message ?? "", /Android command failed/);
  assert.equal(Object.hasOwn(failure, "avdCreationCleanupBlocked"), false);
  await assertMissing(fixture.ownership.avdPath);
  await assertMissing(fixture.definitionPath);
  assert.match(await realFs.readFile(fixture.ownership.markerPath, "utf8"), /android-avd/);
});

test("cleans exact AVD artifacts when post-create verification fails after creator exit", async (t) => {
  const fixture = await createRealAvdFailureHarness(t, "verify-failure");
  const operations = deviceOperations.createAndroidDeviceOperations({
    fs: realFs,
    spawnProcess: closingAvdCreator(
      async () => {
        await writePartialAvd(fixture, { validConfig: true });
        await realFs.writeFile(
          fixture.configPath,
          `AvdId=wrong-name\nimage.sysdir.1=wrong/image/\n`,
          { mode: 0o600 },
        );
      },
      0,
    ),
  });

  await assert.rejects(
    operations.createOwnedAvd(fixture.ownership, {
      avdmanagerPath: path.join(fixture.sdkRoot, "avdmanager"),
      sdkRoot: fixture.sdkRoot,
      systemImage: SYSTEM_IMAGE,
    }),
    /config name does not match ownership/,
  );
  await assertMissing(fixture.ownership.avdPath);
  await assertMissing(fixture.definitionPath);
  assert.match(await realFs.readFile(fixture.ownership.markerPath, "utf8"), /android-avd/);
});

test("refuses AVD failure cleanup when the exact generated path is ambiguous or replaced", async (t) => {
  await t.test("symlink path is ambiguous", async (st) => {
    const fixture = await createRealAvdFailureHarness(st, "ambiguous-create");
    const foreign = path.join(path.dirname(fixture.avdRoot), "foreign");
    const operations = deviceOperations.createAndroidDeviceOperations({
      fs: realFs,
      spawnProcess: closingAvdCreator(async () => {
        await realFs.mkdir(foreign, { mode: 0o700 });
        await realFs.symlink(foreign, fixture.ownership.avdPath);
      }, 1),
    });
    let failure;
    try {
      await operations.createOwnedAvd(fixture.ownership, {
        avdmanagerPath: path.join(fixture.sdkRoot, "avdmanager"),
        sdkRoot: fixture.sdkRoot,
        systemImage: SYSTEM_IMAGE,
      });
    } catch (error) {
      failure = error;
    }
    assert.equal(failure?.avdCreationCleanupBlocked, true);
    assert.equal((await realFs.lstat(fixture.ownership.avdPath)).isSymbolicLink(), true);
    assert.match(await realFs.readFile(fixture.ownership.markerPath, "utf8"), /android-avd/);
  });

  await t.test("path identity replacement is preserved", async (st) => {
    const fixture = await createRealAvdFailureHarness(st, "changed-create");
    let presentReads = 0;
    const fs = {
      ...realFs,
      async lstat(pathname) {
        if (pathname === fixture.ownership.avdPath) {
          try {
            const details = await realFs.lstat(pathname);
            presentReads += 1;
            if (presentReads === 2) {
              await realFs.rm(pathname, { recursive: true });
              await realFs.mkdir(pathname, { mode: 0o700 });
              return realFs.lstat(pathname);
            }
            return details;
          } catch (error) {
            throw error;
          }
        }
        return realFs.lstat(pathname);
      },
    };
    const operations = deviceOperations.createAndroidDeviceOperations({
      fs,
      spawnProcess: closingAvdCreator(() => writePartialAvd(fixture), 1),
    });
    let failure;
    try {
      await operations.createOwnedAvd(fixture.ownership, {
        avdmanagerPath: path.join(fixture.sdkRoot, "avdmanager"),
        sdkRoot: fixture.sdkRoot,
        systemImage: SYSTEM_IMAGE,
      });
    } catch (error) {
      failure = error;
    }
    assert.equal(failure?.avdCreationCleanupBlocked, true);
    assert.equal((await realFs.lstat(fixture.ownership.avdPath)).isDirectory(), true);
    assert.match(await realFs.readFile(fixture.ownership.markerPath, "utf8"), /android-avd/);
  });
});

test("preserves partial AVD artifacts when creator exit is unproved", async (t) => {
  const fixture = await createRealAvdFailureHarness(t, "unproved-create");
  const operations = deviceOperations.createAndroidDeviceOperations({
    fs: realFs,
    runCommand: async () => {
      await writePartialAvd(fixture);
      throw Object.freeze(new Error("transport lost before creator exit proof"));
    },
  });
  let failure;
  try {
    await operations.createOwnedAvd(fixture.ownership, {
      avdmanagerPath: path.join(fixture.sdkRoot, "avdmanager"),
      sdkRoot: fixture.sdkRoot,
      systemImage: SYSTEM_IMAGE,
    });
  } catch (error) {
    failure = error;
  }
  assert.equal(failure?.avdCreationCleanupBlocked, true);
  assert.equal((await realFs.lstat(fixture.ownership.avdPath)).isDirectory(), true);
  assert.equal((await realFs.lstat(fixture.definitionPath)).isFile(), true);
  assert.match(await realFs.readFile(fixture.ownership.markerPath, "utf8"), /android-avd/);
});

test("creates only the marker-owned generated AVD with exact non-shell argv and static stdin", async () => {
  const harness = createAvdHarness();
  const secret = "sentinel-avd-secret-never-forward";
  const operations = deviceOperations.createAndroidDeviceOperations({
    fs: harness.fs,
    runCommand: harness.runCommand,
    baseEnvironment: {
      PATH: "/usr/bin:/bin",
      JAVA_HOME: "/opt/java",
      ANDROID_AVD_HOME: "/shared/avds",
      ACP_BEARER_TOKEN: secret,
    },
  });

  const result = await operations.createOwnedAvd(harness.ownership, {
    avdmanagerPath: AVDMANAGER,
    sdkRoot: SDK_ROOT,
    systemImage: SYSTEM_IMAGE,
  });

  assert.deepEqual(result, {
    avdName: harness.ownership.avdName,
    created: true,
  });
  assert.deepEqual(harness.calls.map(({ executable, args }) => ({ executable, args })), [{
    executable: AVDMANAGER,
    args: [
      "create",
      "avd",
      "-n",
      harness.ownership.avdName,
      "-k",
      SYSTEM_IMAGE,
      "--path",
      harness.ownership.avdPath,
    ],
  }]);
  const [{ options }] = harness.calls;
  assert.equal(options.input, "no\n");
  assert.equal(options.shell, false);
  assert.equal(options.env.ANDROID_AVD_HOME, AVD_ROOT);
  assert.equal(options.env.ANDROID_SDK_ROOT, SDK_ROOT);
  assert.equal(options.env.PATH, "/usr/bin:/bin");
  assert.equal(options.env.JAVA_HOME, "/opt/java");
  assert.equal(Object.hasOwn(options.env, "ACP_BEARER_TOKEN"), false);
  assert.deepEqual(harness.reads.filter((pathname) => pathname !== harness.ownership.markerPath), [
    harness.definitionPath,
    harness.configPath,
  ]);
  assert.equal(JSON.stringify({ result, calls: harness.calls }).includes(secret), false);
});

test("refuses shared, caller-authored, symlinked, and pre-existing AVD identities", async () => {
  const cases = [
    {
      mutate(harness) { harness.ownership.toolNamespace = "shared.android-avd"; },
      error: /shared or foreign AVD ownership/,
    },
    {
      mutate(harness) { harness.ownership.avdName = "shared-avd"; },
      error: /caller-authored AVD name/,
    },
    {
      mutate(harness) {
        const original = harness.fs.realpath;
        harness.fs.realpath = async (pathname) => (
          pathname === AVD_ROOT ? `${AVD_ROOT}-canonical` : original(pathname)
        );
      },
      error: /symlink aliases/,
    },
    {
      mutate(harness) {
        const original = harness.fs.lstat;
        harness.fs.lstat = async (pathname) => (
          pathname === harness.ownership.avdPath
            ? { isFile: () => false, isDirectory: () => true, isSymbolicLink: () => false }
            : original(pathname)
        );
      },
      error: /replace an existing AVD path/,
    },
  ];

  for (const example of cases) {
    const harness = createAvdHarness();
    example.mutate(harness);
    const operations = deviceOperations.createAndroidDeviceOperations({
      fs: harness.fs,
      runCommand: harness.runCommand,
    });
    await assert.rejects(
      operations.createOwnedAvd(harness.ownership, {
        avdmanagerPath: AVDMANAGER,
        sdkRoot: SDK_ROOT,
        systemImage: SYSTEM_IMAGE,
      }),
      example.error,
    );
    assert.equal(harness.calls.length, 0);
  }
});

const REPO_ROOT = "/workspace/agent-control-plane";
const APK_REF = "repo:components/mobile/dist/ambient-mobile.apk";
const APK_PATH = `${REPO_ROOT}/components/mobile/dist/ambient-mobile.apk`;
const ADB = "/opt/android-sdk/platform-tools/adb";
const SERIAL = "emulator-5554";
const APK_BYTES = Buffer.from("verified repository APK bytes");
const APK_SHA256 = createHash("sha256").update(APK_BYTES).digest("hex");

test("proves exact portrait display geometry on the selected emulator before recording", async () => {
  const calls = [];
  const secret = "must-not-reach-adb-display-proof";
  const operations = deviceOperations.createAndroidDeviceOperations({
    baseEnvironment: {
      HOME: "/safe/home",
      PATH: "/safe/bin",
      ACP_BEARER_TOKEN: secret,
      RANDOM_SECRET: secret,
    },
    runCommand: async (executable, args, options) => {
      calls.push({ executable, args: [...args], options });
      if (args.at(-2) === "wm") {
        return {
          stdout: "Physical size: 1080x2400\nOverride size: 1080x1920\n",
          stderr: "",
        };
      }
      return {
        stdout: "Input Reader State:\n  Device 1:\n    SurfaceOrientation: 0\n",
        stderr: "",
      };
    },
  });

  const geometry = await operations.verifyAndroidDisplayGeometry({
    serial: SERIAL,
    adbPath: ADB,
    width: 1080,
    height: 1920,
  });

  assert.deepEqual(geometry, {
    physical: { width: 1080, height: 2400 },
    recording: { width: 1080, height: 1920 },
    rotation: 0,
  });
  assert.equal(Object.isFrozen(geometry), true);
  assert.equal(Object.isFrozen(geometry.physical), true);
  assert.equal(Object.isFrozen(geometry.recording), true);
  assert.deepEqual(calls.map(({ executable, args }) => ({ executable, args })), [
    {
      executable: ADB,
      args: ["-s", SERIAL, "shell", "wm", "size"],
    },
    {
      executable: ADB,
      args: ["-s", SERIAL, "shell", "dumpsys", "input"],
    },
  ]);
  for (const { options } of calls) {
    assert.equal(options.shell, false);
    assert.ok(options.timeoutMilliseconds <= 10_000);
    assert.ok(options.maxOutputBytes <= 256 * 1024);
    assert.deepEqual(options.env, { HOME: "/safe/home", PATH: "/safe/bin" });
  }
  assert.equal(JSON.stringify(calls).includes(secret), false);
});

test("uses physical size when no display override exists", async () => {
  const operations = deviceOperations.createAndroidDeviceOperations({
    runCommand: async (_executable, args) => (
      args.at(-2) === "wm"
        ? { stdout: "Physical size: 1080x1920\n", stderr: "" }
        : { stdout: "SurfaceOrientation: 0\n", stderr: "" }
    ),
  });

  assert.deepEqual(await operations.verifyAndroidDisplayGeometry({
    serial: SERIAL,
    adbPath: ADB,
    width: 1080,
    height: 1920,
  }), {
    physical: { width: 1080, height: 1920 },
    recording: { width: 1080, height: 1920 },
    rotation: 0,
  });
});

test("refuses rotated, mismatched, ambiguous, or malformed display proofs", async () => {
  const cases = [
    {
      size: "Physical size: 1080x1920\n",
      orientation: "SurfaceOrientation: 1\n",
      error: /rotation must be zero/,
    },
    {
      size: "Physical size: 1080x2400\nOverride size: 720x1280\n",
      orientation: "SurfaceOrientation: 0\n",
      error: /recording dimensions mismatch/,
    },
    {
      size: "Physical size: 1080x1920\nPhysical size: 1080x1920\n",
      orientation: "SurfaceOrientation: 0\n",
      error: /display-size proof/,
    },
    {
      size: "Physical size: 1080x1920\n",
      orientation: "SurfaceOrientation: 0\nSurfaceOrientation: 0\n",
      error: /orientation proof/,
    },
    {
      size: "Physical size: 1080x1920\n",
      orientation: "SurfaceOrientation: 4\n",
      error: /orientation proof/,
    },
  ];

  for (const example of cases) {
    const operations = deviceOperations.createAndroidDeviceOperations({
      runCommand: async (_executable, args) => (
        args.at(-2) === "wm"
          ? { stdout: example.size, stderr: "" }
          : { stdout: example.orientation, stderr: "" }
      ),
    });
    await assert.rejects(operations.verifyAndroidDisplayGeometry({
      serial: SERIAL,
      adbPath: ADB,
      width: 1080,
      height: 1920,
    }), example.error);
  }

  const noisy = deviceOperations.createAndroidDeviceOperations({
    runCommand: async (_executable, args) => (
      args.at(-2) === "wm"
        ? { stdout: "Physical size: 1080x1920\n", stderr: "warning\n" }
        : { stdout: "SurfaceOrientation: 0\n", stderr: "" }
    ),
  });
  await assert.rejects(noisy.verifyAndroidDisplayGeometry({
    serial: SERIAL,
    adbPath: ADB,
    width: 1080,
    height: 1920,
  }), /display-size proof/);
});

test("disables and verifies both Android pointer overlays on the exact owned serial", async () => {
  const calls = [];
  const secret = "must-not-reach-adb-pointer-settings";
  const operations = deviceOperations.createAndroidDeviceOperations({
    baseEnvironment: {
      HOME: "/safe/home",
      PATH: "/safe/bin",
      ACP_BEARER_TOKEN: secret,
      RANDOM_SECRET: secret,
    },
    runCommand: async (executable, args, options) => {
      calls.push({ executable, args: [...args], options });
      return {
        stdout: args.includes("get") ? "0\n" : "",
        stderr: "",
      };
    },
  });

  assert.deepEqual(
    await operations.disableAndroidPointerOverlays({ serial: SERIAL, adbPath: ADB }),
    { disabled: true },
  );
  assert.deepEqual(calls.map(({ executable, args }) => ({ executable, args })), [
    {
      executable: ADB,
      args: ["-s", SERIAL, "shell", "settings", "put", "system", "show_touches", "0"],
    },
    {
      executable: ADB,
      args: ["-s", SERIAL, "shell", "settings", "get", "system", "show_touches"],
    },
    {
      executable: ADB,
      args: ["-s", SERIAL, "shell", "settings", "put", "system", "pointer_location", "0"],
    },
    {
      executable: ADB,
      args: ["-s", SERIAL, "shell", "settings", "get", "system", "pointer_location"],
    },
  ]);
  for (const { options } of calls) {
    assert.equal(options.shell, false);
    assert.ok(options.timeoutMilliseconds <= 10_000);
    assert.ok(options.maxOutputBytes <= 64 * 1024);
    assert.deepEqual(options.env, { HOME: "/safe/home", PATH: "/safe/bin" });
  }
  assert.equal(JSON.stringify(calls).includes(secret), false);
});

test("fails closed on nonexact pointer-setting output or caller-authored command plans", async () => {
  for (const result of [
    { stdout: "1\n", stderr: "" },
    { stdout: "0", stderr: "" },
    { stdout: "0\nextra\n", stderr: "" },
    { stdout: "0\n", stderr: "warning\n" },
  ]) {
    let callCount = 0;
    const operations = deviceOperations.createAndroidDeviceOperations({
      runCommand: async (_executable, args) => {
        callCount += 1;
        return args.includes("get") ? result : { stdout: "", stderr: "" };
      },
    });
    await assert.rejects(
      operations.disableAndroidPointerOverlays({ serial: SERIAL, adbPath: ADB }),
      /pointer overlay setting verification failed/,
    );
    assert.equal(callCount, 2, "must stop after the first unverifiable setting");
  }

  const calls = [];
  const operations = deviceOperations.createAndroidDeviceOperations({
    runCommand: async (...args) => {
      calls.push(args);
      return { stdout: "", stderr: "" };
    },
  });
  await assert.rejects(
    operations.disableAndroidPointerOverlays({
      serial: SERIAL,
      adbPath: ADB,
      commands: [["shell", "settings", "put", "system", "show_touches", "1"]],
    }),
    /must contain only adbPath, serial/,
  );
  assert.equal(calls.length, 0);
});

function createApkHarness(overrides = {}) {
  const calls = [];
  const sourceBytes = overrides.apkBytes ?? APK_BYTES;
  const snapshotDirectory = "/private/tmp/acp-demo-creator-apk-device-fixture";
  const snapshotPath = `${snapshotDirectory}/verified.apk`;
  let snapshotBytes;
  let snapshotMode;
  let snapshotExists = false;
  let snapshotDirectoryExists = false;
  const fileDetails = (bytes, mode = 0o600, dev = 7, ino = 42) => ({
    isDirectory: () => false,
    isFile: () => true,
    isSymbolicLink: () => false,
    dev,
    ino,
    mode: 0o100000 | mode,
    size: bytes.length,
    mtimeMs: 1234,
    ctimeMs: 1234,
  });
  const directoryDetails = () => ({
    isDirectory: () => true,
    isFile: () => false,
    isSymbolicLink: () => false,
    dev: 8,
    ino: 50,
    mode: 0o40700,
    size: 96,
    mtimeMs: 5678,
    ctimeMs: 5678,
  });
  const fs = {
    async chmod(pathname, mode) {
      assert.equal(pathname, snapshotDirectory);
      assert.equal(mode, 0o700);
    },
    async mkdtemp(prefix) {
      assert.match(prefix, /acp-demo-creator-apk-$/u);
      snapshotDirectoryExists = true;
      return snapshotDirectory;
    },
    async realpath(pathname) {
      if (pathname === REPO_ROOT) return overrides.repoRealpath ?? REPO_ROOT;
      if (pathname === APK_PATH) return overrides.apkRealpath ?? APK_PATH;
      if (pathname === snapshotDirectory && snapshotDirectoryExists) return snapshotDirectory;
      if (pathname === snapshotPath && snapshotExists) return snapshotPath;
      throw missing(pathname);
    },
    async lstat(pathname) {
      if (pathname === REPO_ROOT) {
        return { isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false };
      }
      if (pathname === APK_PATH) {
        return {
          ...fileDetails(sourceBytes),
          isSymbolicLink: () => overrides.apkSymlink ?? false,
        };
      }
      if (pathname === snapshotDirectory && snapshotDirectoryExists) return directoryDetails();
      if (pathname === snapshotPath && snapshotExists) {
        return fileDetails(snapshotBytes, snapshotMode, 8, 51);
      }
      throw missing(pathname);
    },
    async open(pathname, _flags, mode) {
      if (pathname === APK_PATH) {
        return {
          async close() {},
          async readFile() { return sourceBytes; },
          async stat() { return fileDetails(sourceBytes); },
        };
      }
      assert.equal(pathname, snapshotPath);
      if (mode !== undefined) {
        assert.equal(mode, 0o600);
        snapshotBytes = Buffer.alloc(0);
        snapshotMode = 0o600;
        snapshotExists = true;
        return {
          async chmod(value) { snapshotMode = value; },
          async close() {},
          async stat() { return fileDetails(snapshotBytes, snapshotMode, 8, 51); },
          async sync() {},
          async writeFile(bytes) { snapshotBytes = Buffer.from(bytes); },
        };
      }
      return {
        fd: 91,
        async close() {},
        async read(buffer, offset, length, position) {
          const descriptorBytes = overrides.snapshotDescriptorBytes ?? snapshotBytes;
          const bytes = descriptorBytes.subarray(position, position + length);
          bytes.copy(buffer, offset);
          return { buffer, bytesRead: bytes.length };
        },
        async readFile() { return Buffer.from(snapshotBytes); },
        async stat() { return fileDetails(snapshotBytes, snapshotMode, 8, 51); },
      };
    },
    async readFile(pathname) {
      assert.equal(pathname, APK_PATH);
      return sourceBytes;
    },
    async unlink(pathname) {
      assert.equal(pathname, snapshotPath);
      snapshotExists = false;
    },
    async rmdir(pathname) {
      assert.equal(pathname, snapshotDirectory);
      assert.equal(snapshotExists, false);
      snapshotDirectoryExists = false;
    },
  };
  const runCommand = async (executable, args, options) => {
    calls.push({ executable, args: [...args], options });
    return { stdout: "Success\n", stderr: "" };
  };
  return { calls, fs, runCommand, snapshotPath };
}

test("installs only the exact digest-bound regular repo APK on the selected serial", async () => {
  const harness = createApkHarness();
  const operations = deviceOperations.createAndroidDeviceOperations(harness);

  const result = await operations.installVerifiedAndroidApk({
    repoRoot: REPO_ROOT,
    apk: { ref: APK_REF, sha256: APK_SHA256 },
    serial: SERIAL,
    adbPath: ADB,
  });

  assert.deepEqual(result, { installed: true });
  assert.deepEqual(harness.calls.map(({ executable, args }) => ({ executable, args })), [{
    executable: ADB,
    args: [
      "-s", SERIAL, "shell", "-T", "cmd", "package", "install", "-r", "-S",
      String(APK_BYTES.length),
    ],
  }]);
  assert.equal(harness.calls[0].options.shell, false);
  assert.equal(harness.calls[0].options.inputFileDescriptor, 91);
  assert.equal(harness.calls[0].options.inputByteLength, APK_BYTES.length);
  assert.equal(JSON.stringify(harness.calls[0].args).includes(".apk"), false);

  for (const [options, expectedError] of [
    [{ apkRealpath: `${REPO_ROOT}/elsewhere.apk` }, /exact file without symlinks/],
    [{ apkSymlink: true }, /regular file without symlinks/],
    [{ apkBytes: Buffer.from("replaced APK") }, /APK digest mismatch/],
  ]) {
    const rejectedHarness = createApkHarness(options);
    const rejectedOperations = deviceOperations.createAndroidDeviceOperations(rejectedHarness);
    await assert.rejects(
      rejectedOperations.installVerifiedAndroidApk({
        repoRoot: REPO_ROOT,
        apk: { ref: APK_REF, sha256: APK_SHA256 },
        serial: SERIAL,
        adbPath: ADB,
      }),
      expectedError,
    );
    assert.equal(rejectedHarness.calls.length, 0);
  }

  const missingDigestHarness = createApkHarness();
  await assert.rejects(
    deviceOperations.createAndroidDeviceOperations(missingDigestHarness)
      .installVerifiedAndroidApk({
        repoRoot: REPO_ROOT,
        apk: { ref: APK_REF },
        serial: SERIAL,
        adbPath: ADB,
      }),
    /APK sha256 is required/,
  );
  assert.equal(missingDigestHarness.calls.length, 0);
});

test("rejects when the exact inherited APK descriptor bytes diverge from the verified snapshot", async () => {
  const harness = createApkHarness({
    snapshotDescriptorBytes: Buffer.alloc(APK_BYTES.length, 0x78),
  });
  const operations = deviceOperations.createAndroidDeviceOperations(harness);

  await assert.rejects(
    operations.installVerifiedAndroidApk({
      repoRoot: REPO_ROOT,
      apk: { ref: APK_REF, sha256: APK_SHA256 },
      serial: SERIAL,
      adbPath: ADB,
    }),
    /Private APK snapshot consumer failed/,
  );
  assert.equal(harness.calls.length, 0, "ADB must not receive an unhashed descriptor");
});

test("installs locked bytes from a private snapshot when the repo APK path is replaced", async (t) => {
  const temporaryRoot = await realFs.mkdtemp(path.join(os.tmpdir(), "apk-install-swap-test-"));
  const repoRoot = await realFs.realpath(temporaryRoot);
  t.after(async () => realFs.rm(repoRoot, { force: true, recursive: true }));
  const apkPath = path.join(repoRoot, "components/mobile/dist/ambient-mobile.apk");
  await realFs.mkdir(path.dirname(apkPath), { recursive: true });
  await realFs.writeFile(apkPath, APK_BYTES, { mode: 0o600 });

  let inheritedFd;
  let installedBytes;
  const operations = deviceOperations.createAndroidDeviceOperations({
    runCommand: async (executable, args, options) => {
      assert.equal(executable, ADB);
      assert.deepEqual(args, [
        "-s", SERIAL, "shell", "-T", "cmd", "package", "install", "-r", "-S",
        String(APK_BYTES.length),
      ]);
      assert.equal(options.shell, false);
      inheritedFd = options.inputFileDescriptor;
      assert.equal(options.inputByteLength, APK_BYTES.length);
      assert.equal(JSON.stringify({ args, options: { ...options, inputFileDescriptor: 0 } }).includes(".apk"), false);
      await realFs.rename(apkPath, `${apkPath}.original`);
      await realFs.writeFile(apkPath, Buffer.from("attacker replacement APK"));
      installedBytes = await realFs.readFile(`/dev/fd/${inheritedFd}`);
      return { stdout: "Success\n", stderr: "" };
    },
  });

  await assert.rejects(operations.installVerifiedAndroidApk({
    repoRoot,
    apk: { ref: APK_REF, sha256: APK_SHA256 },
    serial: SERIAL,
    adbPath: ADB,
  }), /APK changed while private snapshot was in use/);

  assert.equal(Number.isInteger(inheritedFd), true);
  assert.deepEqual(installedBytes, APK_BYTES);
});

test("cleans the private APK snapshot and keeps its path out of install failures", async (t) => {
  const temporaryRoot = await realFs.mkdtemp(path.join(os.tmpdir(), "apk-install-failure-test-"));
  const repoRoot = await realFs.realpath(temporaryRoot);
  t.after(async () => realFs.rm(repoRoot, { force: true, recursive: true }));
  const apkPath = path.join(repoRoot, "components/mobile/dist/ambient-mobile.apk");
  await realFs.mkdir(path.dirname(apkPath), { recursive: true });
  await realFs.writeFile(apkPath, APK_BYTES, { mode: 0o600 });

  const operations = deviceOperations.createAndroidDeviceOperations({
    runCommand: async (_executable, args, options) => {
      assert.equal(args.some((argument) => argument.endsWith(".apk")), false);
      assert.equal(Number.isInteger(options.inputFileDescriptor), true);
      throw new Error("adb install failed");
    },
  });
  let failure;
  try {
    await operations.installVerifiedAndroidApk({
      repoRoot,
      apk: { ref: APK_REF, sha256: APK_SHA256 },
      serial: SERIAL,
      adbPath: ADB,
    });
    assert.fail("install must fail");
  } catch (error) {
    failure = error;
  }

  assert.equal(failure.message, "Private APK snapshot consumer failed");
  assert.equal(failure.cause, undefined);
  assert.doesNotMatch(failure.message, new RegExp(repoRoot.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")));
});

const APPLICATION_ID = "dev.ambientcode.mobile";

function installedPackageDump(overrides = {}) {
  const applicationId = overrides.applicationId ?? APPLICATION_ID;
  const versionName = overrides.versionName ?? "1.4.2";
  const versionCode = overrides.versionCode ?? "10402";
  return [
    "Packages:",
    `  Package [${applicationId}] (8f10f6e):`,
    `    versionCode=${versionCode} minSdk=26 targetSdk=36`,
    `    versionName=${versionName}`,
  ].join("\n");
}

test("parses one bounded exact installed package identity from the selected serial", async () => {
  const calls = [];
  const runCommand = async (executable, args, options) => {
    calls.push({ executable, args: [...args], options });
    return { stdout: installedPackageDump(), stderr: "" };
  };
  const operations = deviceOperations.createAndroidDeviceOperations({ runCommand });

  const installed = await operations.verifyInstalledAndroidApp({
    serial: SERIAL,
    adbPath: ADB,
    expectedApplicationId: APPLICATION_ID,
    expectedVersionName: "1.4.2",
    expectedVersionCode: "10402",
  });

  assert.deepEqual(installed, {
    applicationId: APPLICATION_ID,
    versionName: "1.4.2",
    versionCode: "10402",
  });
  assert.deepEqual(calls.map(({ executable, args }) => ({ executable, args })), [{
    executable: ADB,
    args: ["-s", SERIAL, "shell", "dumpsys", "package", APPLICATION_ID],
  }]);
  assert.equal(calls[0].options.shell, false);
  assert.ok(calls[0].options.maxOutputBytes <= 512 * 1024);
});

test("refuses ambiguous, oversized, or mismatched installed-package output", async () => {
  const examples = [
    [`${installedPackageDump()}\n${installedPackageDump()}`, /exactly one package record/],
    [installedPackageDump({ versionName: "1.4.3" }), /installed versionName mismatch/],
    [installedPackageDump({ versionCode: "10403" }), /installed versionCode mismatch/],
    [`${installedPackageDump()}\n${"x".repeat(512 * 1024)}`, /package output exceeds/],
  ];
  for (const [stdout, expectedError] of examples) {
    const operations = deviceOperations.createAndroidDeviceOperations({
      runCommand: async () => ({ stdout, stderr: "" }),
    });
    await assert.rejects(
      operations.verifyInstalledAndroidApp({
        serial: SERIAL,
        adbPath: ADB,
        expectedApplicationId: APPLICATION_ID,
        expectedVersionName: "1.4.2",
        expectedVersionCode: "10402",
      }),
      expectedError,
    );
  }
});

test("launches only one bounded exact package activity on the selected serial", async () => {
  const calls = [];
  const operations = deviceOperations.createAndroidDeviceOperations({
    runCommand: async (executable, args, options) => {
      calls.push({ executable, args: [...args], options });
      return { stdout: "Status: ok\n", stderr: "" };
    },
  });
  const activity = `${APPLICATION_ID}/.MainActivity`;

  const result = await operations.launchAndroidApplication({
    serial: SERIAL,
    adbPath: ADB,
    applicationId: APPLICATION_ID,
    activity,
  });

  assert.deepEqual(result, { launched: true });
  assert.deepEqual(calls.map(({ executable, args }) => ({ executable, args })), [{
    executable: ADB,
    args: ["-s", SERIAL, "shell", "am", "start", "-W", "-n", activity],
  }]);
  assert.equal(calls[0].options.shell, false);

  for (const rejectedActivity of [
    ".MainActivity",
    "dev.example.mobile/.MainActivity",
    `${APPLICATION_ID}/.MainActivity;id`,
    `${APPLICATION_ID}/Main Activity`,
  ]) {
    await assert.rejects(
      operations.launchAndroidApplication({
        serial: SERIAL,
        adbPath: ADB,
        applicationId: APPLICATION_ID,
        activity: rejectedActivity,
      }),
      /activity must be a bounded component for applicationId/,
    );
  }
  assert.equal(calls.length, 1);

  const exactMaximum = `${APPLICATION_ID}/.${"A".repeat(
    ANDROID_LAUNCH_ACTIVITY_MAX_CHARACTERS - APPLICATION_ID.length - 2,
  )}`;
  assert.equal(exactMaximum.length, 300);
  await operations.launchAndroidApplication({
    serial: SERIAL,
    adbPath: ADB,
    applicationId: APPLICATION_ID,
    activity: exactMaximum,
  });
  await assert.rejects(
    operations.launchAndroidApplication({
      serial: SERIAL,
      adbPath: ADB,
      applicationId: APPLICATION_ID,
      activity: `${exactMaximum}A`,
    }),
    /activity must be a bounded component for applicationId/,
  );
});

const UI_DUMP = `<?xml version="1.0"?><hierarchy><node text="Ready" bounds="[0,0][10,10]" /></hierarchy>`;

test("the Android driver uses the selected serial and bounded static UI, tap, and back argv", async () => {
  const calls = [];
  const driver = deviceOperations.createAndroidDeviceOperations({
    runCommand: async (executable, args, options) => {
      calls.push({ executable, args: [...args], options });
      return { stdout: args.includes("uiautomator") ? UI_DUMP : "", stderr: "" };
    },
  }).createAndroidDriver({ serial: SERIAL, adbPath: ADB });

  assert.deepEqual(Object.keys(driver).sort(), [
    "back",
    "dumpUiHierarchy",
    "fill",
    "openSecretInput",
    "tap",
  ]);
  assert.equal(Object.isFrozen(driver), true);
  assert.equal(await driver.dumpUiHierarchy(), UI_DUMP);
  await driver.tap({ x: 12, y: 34 });
  await driver.back();

  assert.deepEqual(calls.map(({ executable, args }) => ({ executable, args })), [
    {
      executable: ADB,
      args: ["-s", SERIAL, "exec-out", "uiautomator", "dump", "/dev/tty"],
    },
    {
      executable: ADB,
      args: ["-s", SERIAL, "shell", "input", "tap", "12", "34"],
    },
    {
      executable: ADB,
      args: ["-s", SERIAL, "shell", "input", "keyevent", "BACK"],
    },
  ]);
  assert.ok(calls[0].options.maxOutputBytes <= 2 * 1024 * 1024);
  assert.equal(calls.every(({ options }) => options.shell === false), true);

  const oversized = deviceOperations.createAndroidDeviceOperations({
    runCommand: async () => ({ stdout: "x".repeat((2 * 1024 * 1024) + 1), stderr: "" }),
  }).createAndroidDriver({ serial: SERIAL, adbPath: ADB });
  await assert.rejects(oversized.dumpUiHierarchy(), /UI hierarchy output exceeds/);
});

function createSpawnHarness(options = {}) {
  const calls = [];
  const privateWrites = [];
  const children = [];
  const spawnProcess = (executable, args, spawnOptions) => {
    const child = new EventEmitter();
    child.kills = [];
    child.kill = (signal) => {
      child.kills.push(signal);
      if (options.ignoredSignals?.includes(signal)) return true;
      queueMicrotask(() => child.emit("close", null, signal));
      return true;
    };
    const childWrites = [];
    child.stdin = new Writable({
      write(chunk, encoding, callback) {
        childWrites.push(Buffer.from(chunk).toString("utf8"));
        privateWrites.push(Buffer.from(chunk).toString("utf8"));
        callback();
        if (options.stdinErrorMessage) {
          queueMicrotask(() => child.stdin.emit("error", new Error(options.stdinErrorMessage)));
        }
      },
    });
    if (!options.hang) {
      child.stdin.once("finish", () => {
        queueMicrotask(() => child.emit("close", options.exitCode ?? 0, null));
      });
    }
    calls.push({ executable, args: [...args], options: spawnOptions });
    children.push({ child, writes: childWrites });
    return child;
  };
  return { calls, children, privateWrites, spawnProcess };
}

test("literal and secret fills cross only one fixed private-stdin helper", async () => {
  const runCalls = [];
  const spawn = createSpawnHarness();
  const literal = "literal;$(id) & more";
  const secret = "sentinel-secret;$(id)-never-serialize";
  const operations = deviceOperations.createAndroidDeviceOperations({
    runCommand: async (executable, args, options) => {
      runCalls.push({ executable, args: [...args], options });
      return { stdout: "", stderr: "" };
    },
    spawnProcess: spawn.spawnProcess,
    baseEnvironment: {
      PATH: "/usr/bin:/bin",
      ACP_BEARER_TOKEN: secret,
    },
  });
  const driver = operations.createAndroidDriver({ serial: SERIAL, adbPath: ADB });

  await driver.fill({ x: 10, y: 20, value: literal });
  const channel = await driver.openSecretInput({
    x: 30,
    y: 40,
    environmentName: "ACP_BEARER_TOKEN",
  });
  assert.deepEqual(Object.keys(channel).sort(), ["completed", "stdin"]);
  channel.stdin.write(secret);
  channel.stdin.end();
  assert.equal(await channel.completed, undefined);

  assert.deepEqual(runCalls.map(({ executable, args }) => ({ executable, args })), [
    { executable: ADB, args: ["-s", SERIAL, "shell", "input", "tap", "10", "20"] },
    { executable: ADB, args: ["-s", SERIAL, "shell", "input", "tap", "30", "40"] },
  ]);
  assert.equal(spawn.calls.length, 2);
  assert.deepEqual(spawn.calls[0].args.slice(0, 5), [
    "-s",
    SERIAL,
    "shell",
    "sh",
    "-c",
  ]);
  assert.deepEqual(spawn.calls[1].args, spawn.calls[0].args);
  assert.equal(spawn.calls.every(({ options }) => (
    options.shell === false
    && JSON.stringify(options.stdio) === JSON.stringify(["pipe", "ignore", "ignore"])
    && options.env.PATH === "/usr/bin:/bin"
    && !Object.hasOwn(options.env, "ACP_BEARER_TOKEN")
  )), true);
  const publicDiagnostics = JSON.stringify({ runCalls, spawnCalls: spawn.calls });
  assert.equal(publicDiagnostics.includes(literal), false);
  assert.equal(publicDiagnostics.includes(secret), false);
  assert.deepEqual(spawn.privateWrites, [literal, secret]);
});

test("secret-input failures and cancellation remain static and secret-free", async () => {
  const secret = "sentinel-secret-never-in-errors";
  const failedSpawn = createSpawnHarness({ exitCode: 7 });
  const failedDriver = deviceOperations.createAndroidDeviceOperations({
    runCommand: async () => ({ stdout: "", stderr: "" }),
    spawnProcess: failedSpawn.spawnProcess,
  }).createAndroidDriver({ serial: SERIAL, adbPath: ADB });
  const failedChannel = await failedDriver.openSecretInput({
    x: 1,
    y: 2,
    environmentName: "ACP_BEARER_TOKEN",
  });
  failedChannel.stdin.write(secret);
  failedChannel.stdin.end();
  await assert.rejects(failedChannel.completed, (error) => {
    assert.equal(error.message.includes(secret), false);
    assert.equal("cause" in error, false);
    assert.match(error.message, /private Android input failed/);
    return true;
  });

  const stdinErrorSpawn = createSpawnHarness({
    hang: true,
    stdinErrorMessage: `stdin leaked ${secret}`,
  });
  const stdinErrorDriver = deviceOperations.createAndroidDeviceOperations({
    runCommand: async () => ({ stdout: "", stderr: "" }),
    spawnProcess: stdinErrorSpawn.spawnProcess,
  }).createAndroidDriver({ serial: SERIAL, adbPath: ADB });
  const stdinErrorChannel = await stdinErrorDriver.openSecretInput({
    x: 2,
    y: 3,
    environmentName: "ACP_BEARER_TOKEN",
  });
  stdinErrorChannel.stdin.write(secret);
  stdinErrorChannel.stdin.end();
  await assert.rejects(stdinErrorChannel.completed, (error) => {
    assert.equal(error.message.includes(secret), false);
    assert.equal("cause" in error, false);
    assert.match(error.message, /private Android input failed/);
    return true;
  });

  const hangingSpawn = createSpawnHarness({ hang: true });
  const controller = new AbortController();
  const hangingDriver = deviceOperations.createAndroidDeviceOperations({
    runCommand: async () => ({ stdout: "", stderr: "" }),
    spawnProcess: hangingSpawn.spawnProcess,
  }).createAndroidDriver({ serial: SERIAL, adbPath: ADB });
  const cancelledChannel = await hangingDriver.openSecretInput({
    x: 3,
    y: 4,
    environmentName: "ACP_BEARER_TOKEN",
  }, { signal: controller.signal });
  controller.abort();
  await assert.rejects(cancelledChannel.completed, /private Android input was cancelled/);
  assert.deepEqual(hangingSpawn.children[0].child.kills, ["SIGTERM"]);
  assert.equal(JSON.stringify({
    failedCalls: failedSpawn.calls,
    hangingCalls: hangingSpawn.calls,
  }).includes(secret), false);
});

test("secret-input cancellation waits for exit and escalates a hung child to SIGKILL", async () => {
  const stubbornSpawn = createSpawnHarness({
    hang: true,
    ignoredSignals: ["SIGTERM"],
  });
  const controller = new AbortController();
  const driver = deviceOperations.createAndroidDeviceOperations({
    runCommand: async () => ({ stdout: "", stderr: "" }),
    spawnProcess: stubbornSpawn.spawnProcess,
    commandTerminationGraceMilliseconds: 1,
  }).createAndroidDriver({ serial: SERIAL, adbPath: ADB });
  const channel = await driver.openSecretInput({
    x: 3,
    y: 4,
    environmentName: "ACP_BEARER_TOKEN",
  }, { signal: controller.signal });

  controller.abort();
  await assert.rejects(channel.completed, /private Android input was cancelled/);
  assert.deepEqual(stubbornSpawn.children[0].child.kills, ["SIGTERM", "SIGKILL"]);
});

test("secret-input cancellation fails closed and retains exit listeners when SIGKILL is unproved", async () => {
  const stubbornSpawn = createSpawnHarness({
    hang: true,
    ignoredSignals: ["SIGTERM", "SIGKILL"],
  });
  const controller = new AbortController();
  const driver = deviceOperations.createAndroidDeviceOperations({
    runCommand: async () => ({ stdout: "", stderr: "" }),
    spawnProcess: stubbornSpawn.spawnProcess,
    commandTerminationGraceMilliseconds: 1,
  }).createAndroidDriver({ serial: SERIAL, adbPath: ADB });
  const channel = await driver.openSecretInput({
    x: 3,
    y: 4,
    environmentName: "ACP_BEARER_TOKEN",
  }, { signal: controller.signal });

  controller.abort();
  await assert.rejects(channel.completed, /cleanup could not prove child exit/);
  const child = stubbornSpawn.children[0].child;
  assert.deepEqual(child.kills, ["SIGTERM", "SIGKILL"]);
  assert.ok(child.listenerCount("close") > 0);
  assert.ok(child.listenerCount("error") > 0);
});

test("the built-in bounded runner uses the injected executable-plus-argv spawn seam", async () => {
  const calls = [];
  const spawnProcess = (executable, args, options) => {
    const child = new EventEmitter();
    child.stdin = typeof options.stdio[0] === "number" ? null : new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    calls.push({ executable, args: [...args], options });
    const complete = () => {
      child.stdout.end(typeof options.stdio[0] === "number" ? "Success\n" : "");
      child.stderr.end();
      queueMicrotask(() => child.emit("close", 0, null));
    };
    if (child.stdin) child.stdin.once("finish", complete);
    else queueMicrotask(complete);
    return child;
  };
  const apkHarness = createApkHarness();
  const operations = deviceOperations.createAndroidDeviceOperations({
    fs: apkHarness.fs,
    spawnProcess,
    toolEnvironment: {
      PATH: "/tools/bin",
      ACP_BEARER_TOKEN: "sentinel-tool-secret-never-forward",
    },
    baseEnvironment: {
      PATH: "/usr/bin:/bin",
      ACP_BEARER_TOKEN: "sentinel-runner-secret-never-forward",
    },
  });
  const driver = operations.createAndroidDriver({ serial: SERIAL, adbPath: ADB });

  await driver.back();
  await operations.installVerifiedAndroidApk({
    repoRoot: REPO_ROOT,
    apk: { ref: APK_REF, sha256: APK_SHA256 },
    serial: SERIAL,
    adbPath: ADB,
  });

  assert.deepEqual(calls.map(({ executable, args }) => ({ executable, args })), [
    {
      executable: ADB,
      args: ["-s", SERIAL, "shell", "input", "keyevent", "BACK"],
    },
    {
      executable: ADB,
      args: [
        "-s", SERIAL, "shell", "-T", "cmd", "package", "install", "-r", "-S",
        String(APK_BYTES.length),
      ],
    },
  ]);
  assert.equal(calls[0].options.shell, false);
  assert.deepEqual(calls[0].options.stdio, ["pipe", "pipe", "pipe"]);
  assert.deepEqual(calls[0].options.env, { PATH: "/tools/bin" });
  assert.deepEqual(calls[1].options.stdio, [91, "pipe", "pipe"]);
  assert.deepEqual(calls[1].options.env, { PATH: "/tools/bin" });
});

test("the built-in bounded runner rejects after a post-SIGKILL settlement deadline", async () => {
  const kills = [];
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = (signal) => {
    kills.push(signal);
    return true;
  };
  const operations = deviceOperations.createAndroidDeviceOperations({
    commandTerminationGraceMilliseconds: 2,
    spawnProcess: () => child,
  });
  const driver = operations.createAndroidDriver({ serial: SERIAL, adbPath: ADB });
  const controller = new AbortController();
  const command = driver.back({ signal: controller.signal });
  controller.abort();

  await assert.rejects(
    Promise.race([
      command,
      new Promise((_, reject) => setTimeout(
        () => reject(new Error("test guard: bounded runner remained pending after SIGKILL")),
        100,
      )),
    ]),
    /cleanup could not prove child exit/i,
  );
  assert.deepEqual(kills, ["SIGTERM", "SIGKILL"]);
  assert.ok(child.listenerCount("close") > 0);
  assert.ok(child.listenerCount("error") > 0);
});

test("the inherited-FD install timeout waits for a real child exit before cleanup", async (t) => {
  const temporaryRoot = await realFs.mkdtemp(path.join(os.tmpdir(), "apk-install-timeout-test-"));
  const repoRoot = await realFs.realpath(temporaryRoot);
  const apkPath = path.join(repoRoot, "components/mobile/dist/ambient-mobile.apk");
  await realFs.mkdir(path.dirname(apkPath), { recursive: true });
  await realFs.writeFile(apkPath, APK_BYTES, { mode: 0o600 });
  t.after(async () => realFs.rm(repoRoot, { force: true, recursive: true }));

  let child;
  let childClosed = false;
  const kills = [];
  const spawnProcess = (_executable, _args, options) => {
    child = realSpawn(process.execPath, [
      "-e",
      [
        "process.on('SIGTERM', () => {});",
        "setTimeout(() => process.stdout.write('x'.repeat(300000)), 350);",
        "setInterval(() => {}, 1000);",
      ].join(""),
    ], options);
    const nativeKill = child.kill.bind(child);
    child.kill = (signal) => {
      kills.push(signal);
      return nativeKill(signal);
    };
    child.once("close", () => { childClosed = true; });
    return child;
  };
  t.after(() => {
    if (child && !childClosed) child.kill("SIGKILL");
  });

  const operations = deviceOperations.createAndroidDeviceOperations({
    apkInstallTimeoutMilliseconds: 150,
    commandTerminationGraceMilliseconds: 15,
    fs: realFs,
    spawnProcess,
    toolEnvironment: { PATH: process.env.PATH },
  });
  await assert.rejects(
    operations.installVerifiedAndroidApk({
      repoRoot,
      apk: { ref: "repo:components/mobile/dist/ambient-mobile.apk", sha256: APK_SHA256 },
      serial: SERIAL,
      adbPath: ADB,
    }),
    /Private APK snapshot consumer failed/,
  );

  assert.equal(childClosed, true, "snapshot cleanup must wait for the installer process to exit");
  assert.equal(kills[0], "SIGTERM");
  assert.equal(kills.every((signal) => ["SIGTERM", "SIGKILL"].includes(signal)), true);
});

test("the inherited-FD install timeout escalates a delayed child to SIGKILL", async () => {
  const apkHarness = createApkHarness();
  let childClosed = false;
  const kills = [];
  const spawnProcess = (_executable, _args, options) => {
    assert.equal(typeof options.stdio[0], "number");
    const child = new EventEmitter();
    child.stdin = null;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = (signal) => {
      kills.push(signal);
      if (signal === "SIGKILL") {
        queueMicrotask(() => {
          childClosed = true;
          child.emit("close", null, signal);
        });
      }
      return true;
    };
    return child;
  };
  const operations = deviceOperations.createAndroidDeviceOperations({
    apkInstallTimeoutMilliseconds: 5,
    commandTerminationGraceMilliseconds: 5,
    fs: apkHarness.fs,
    spawnProcess,
  });

  await assert.rejects(
    operations.installVerifiedAndroidApk({
      repoRoot: REPO_ROOT,
      apk: { ref: APK_REF, sha256: APK_SHA256 },
      serial: SERIAL,
      adbPath: ADB,
    }),
    /Private APK snapshot consumer failed/,
  );
  assert.equal(childClosed, true);
  assert.deepEqual(kills, ["SIGTERM", "SIGKILL"]);
});

test("cancelling an inherited-FD install waits for the child close proof", async () => {
  const apkHarness = createApkHarness();
  const controller = new AbortController();
  let releaseSpawned;
  const spawned = new Promise((resolve) => { releaseSpawned = resolve; });
  let childClosed = false;
  const kills = [];
  const spawnProcess = (_executable, _args, options) => {
    assert.equal(typeof options.stdio[0], "number");
    const child = new EventEmitter();
    child.stdin = null;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = (signal) => {
      kills.push(signal);
      setImmediate(() => {
        childClosed = true;
        child.emit("close", null, signal);
      });
      return true;
    };
    releaseSpawned();
    return child;
  };
  const operations = deviceOperations.createAndroidDeviceOperations({
    commandTerminationGraceMilliseconds: 100,
    fs: apkHarness.fs,
    spawnProcess,
  });
  const installation = operations.installVerifiedAndroidApk({
    repoRoot: REPO_ROOT,
    apk: { ref: APK_REF, sha256: APK_SHA256 },
    serial: SERIAL,
    adbPath: ADB,
    signal: controller.signal,
  });
  const state = await Promise.race([
    spawned.then(() => "spawned"),
    installation.then(() => "resolved", () => "rejected"),
  ]);
  assert.equal(state, "spawned");
  controller.abort();
  await assert.rejects(installation, /Private APK snapshot consumer failed/);
  assert.equal(childClosed, true);
  assert.deepEqual(kills, ["SIGTERM"]);
});

test("the device boundary rejects implicit devices and open-ended scenario commands", async () => {
  const calls = [];
  const operations = deviceOperations.createAndroidDeviceOperations({
    runCommand: async (...args) => {
      calls.push(args);
      return { stdout: UI_DUMP, stderr: "" };
    },
  });
  for (const serial of [undefined, "", "device", "-d", "emulator-any", "emulator-70000"]) {
    assert.throws(
      () => operations.createAndroidDriver({ serial, adbPath: ADB }),
      /serial/,
    );
  }

  const driver = operations.createAndroidDriver({ serial: SERIAL, adbPath: ADB });
  await assert.rejects(driver.dumpUiHierarchy({ query: "//*" }), /must contain only signal/);
  await assert.rejects(
    driver.tap({ x: 1, y: 2, shell: "id" }),
    /must contain only x, y/,
  );
  await assert.rejects(
    driver.fill({ x: 1, y: 2, value: "safe", query: "//*" }),
    /must contain only value, x, y/,
  );
  await assert.rejects(
    driver.openSecretInput({
      x: 1,
      y: 2,
      environmentName: "ACP_BEARER_TOKEN",
      shell: "id",
    }),
    /must contain only environmentName, x, y/,
  );
  assert.equal(calls.length, 0);
});
