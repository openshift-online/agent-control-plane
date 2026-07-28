import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as realFs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import * as apkGateModule from "../../../scripts/capture/android/apk-gate.mjs";
import {
  ANDROID_APK_LOCK_SCHEMA_VERSION,
  verifyAndroidApkGate,
} from "../../../scripts/capture/android/apk-gate.mjs";

const REPO_ROOT = "/workspace/agent-control-plane";
const APK_REF = "repo:artifacts/artoo-debug.apk";
const APK_PATH = `${REPO_ROOT}/artifacts/artoo-debug.apk`;
const LOCK_REF = "repo:artifacts/artoo-debug.apk.lock.json";
const LOCK_PATH = `${REPO_ROOT}/artifacts/artoo-debug.apk.lock.json`;
const APKANALYZER_PATH = "/opt/android-sdk/cmdline-tools/19.0/bin/apkanalyzer";
const APK_BYTES = Buffer.from("Android application package built from the locked source");
const APK_SHA256 = createHash("sha256").update(APK_BYTES).digest("hex");
const COMMIT = "a".repeat(40);
const TREE = "b".repeat(40);
const SOURCE_PATH = "components/mobile";
const EXAMPLE_APPLICATION_ID = "dev.ambientcode.mobile";
const APKANALYZER_IDENTITY = Object.freeze({
  identity: "apkanalyzer",
  version: "cmdline-tools 19.0",
});
const SOURCE_COMMIT_METADATA_NAME = "dev.ambientcode.sourceCommit";
const SOURCE_TREE_METADATA_NAME = "dev.ambientcode.sourceTree";
const LOCK_SCHEMA_METADATA_NAME = "dev.ambientcode.apkLockSchemaVersion";

function manifestPrint(
  commit = COMMIT,
  schemaVersion = ANDROID_APK_LOCK_SCHEMA_VERSION,
  tree = TREE,
) {
  return [
    '<manifest xmlns:android="http://schemas.android.com/apk/res/android">',
    "  <application>",
    `    <meta-data android:value="${commit}" android:name="${SOURCE_COMMIT_METADATA_NAME}" />`,
    `    <meta-data android:name="${SOURCE_TREE_METADATA_NAME}" android:value="${tree}" />`,
    `    <meta-data android:name="${LOCK_SCHEMA_METADATA_NAME}" android:value="${schemaVersion}" />`,
    "  </application>",
    "</manifest>",
  ].join("\n");
}

function lockDocument(overrides = {}) {
  const lock = {
    schemaVersion: ANDROID_APK_LOCK_SCHEMA_VERSION,
    source: { commit: COMMIT, tree: TREE, path: SOURCE_PATH },
    apk: {
      ref: APK_REF,
      sha256: APK_SHA256,
      applicationId: EXAMPLE_APPLICATION_ID,
      versionName: "1.4.2",
      versionCode: "10402",
    },
    apkanalyzer: {
      identity: "apkanalyzer",
      version: "cmdline-tools 19.0",
    },
  };
  return {
    ...lock,
    ...overrides,
    source: { ...lock.source, ...overrides.source },
    apk: { ...lock.apk, ...overrides.apk },
    apkanalyzer: { ...lock.apkanalyzer, ...overrides.apkanalyzer },
  };
}

function createHarness(overrides = {}) {
  const calls = [];
  const openCounts = new Map();
  const heads = [...(overrides.heads ?? [COMMIT, COMMIT])];
  const trees = [...(overrides.trees ?? [TREE, TREE])];
  const sourceStats = new Map([
    [APK_PATH, { dev: 1, ino: 10, mode: 0o100600 }],
    [LOCK_PATH, { dev: 1, ino: 11, mode: 0o100600 }],
  ]);
  let snapshotDirectory;
  let snapshotPath;
  let snapshotBytes;
  let snapshotMode;
  let snapshotExists = false;
  let snapshotDirectoryExists = false;
  const metadata = {
    applicationId: EXAMPLE_APPLICATION_ID,
    versionName: "1.4.2",
    versionCode: "10402",
    manifestPrint: manifestPrint(),
    ...overrides.metadata,
  };
  const lockBytes = overrides.lockBytes ?? Buffer.from(
    `${JSON.stringify(lockDocument(overrides.lock), null, 2)}\n`,
  );
  const fileDetails = (pathname, bytes) => ({
    ...sourceStats.get(pathname),
    size: bytes.length,
    mtimeMs: 100,
    ctimeMs: 100,
    isDirectory: () => false,
    isFile: () => true,
    isSymbolicLink: () => false,
  });
  const directoryDetails = () => ({
    dev: 2,
    ino: 20,
    mode: 0o40700,
    size: 96,
    mtimeMs: 200,
    ctimeMs: 200,
    isDirectory: () => true,
    isFile: () => false,
    isSymbolicLink: () => false,
  });
  const sourceBytes = (pathname) => (
    pathname === APK_PATH ? (overrides.apkBytes ?? APK_BYTES) : lockBytes
  );
  const filesystem = {
    async chmod(requestedPath, mode) {
      assert.equal(requestedPath, snapshotDirectory);
      assert.equal(mode, 0o700);
    },
    async mkdtemp(prefix) {
      assert.match(prefix, /acp-demo-creator-apk-$/u);
      snapshotDirectory = "/private/tmp/acp-demo-creator-apk-fixture";
      snapshotPath = `${snapshotDirectory}/verified.apk`;
      snapshotDirectoryExists = true;
      return snapshotDirectory;
    },
    async realpath(requestedPath) {
      if (requestedPath === REPO_ROOT) return REPO_ROOT;
      if (requestedPath === APK_PATH) return overrides.apkRealpath ?? APK_PATH;
      if (requestedPath === LOCK_PATH) return overrides.lockRealpath ?? LOCK_PATH;
      if (requestedPath === APKANALYZER_PATH) return APKANALYZER_PATH;
      if (requestedPath === snapshotDirectory && snapshotDirectoryExists) return snapshotDirectory;
      if (requestedPath === snapshotPath && snapshotExists) return snapshotPath;
      throw Object.assign(new Error(`unexpected realpath: ${requestedPath}`), { code: "ENOENT" });
    },
    async lstat(requestedPath) {
      if ([APK_PATH, LOCK_PATH].includes(requestedPath)) {
        return fileDetails(requestedPath, sourceBytes(requestedPath));
      }
      if (requestedPath === snapshotDirectory && snapshotDirectoryExists) {
        return directoryDetails();
      }
      if (requestedPath === snapshotPath && snapshotExists) {
        return {
          ...fileDetails(snapshotPath, snapshotBytes),
          dev: 2,
          ino: 21,
          mode: 0o100000 | snapshotMode,
        };
      }
      throw Object.assign(new Error(`unexpected lstat: ${requestedPath}`), { code: "ENOENT" });
    },
    async open(requestedPath, _flags, mode) {
      openCounts.set(requestedPath, (openCounts.get(requestedPath) ?? 0) + 1);
      if ([APK_PATH, LOCK_PATH].includes(requestedPath)) {
        const bytes = sourceBytes(requestedPath);
        return {
          async close() {},
          async readFile() { return bytes; },
          async stat() { return fileDetails(requestedPath, bytes); },
        };
      }
      assert.equal(requestedPath, snapshotPath);
      if (mode !== undefined) {
        assert.equal(mode, 0o600);
        snapshotBytes = Buffer.alloc(0);
        snapshotMode = 0o600;
        snapshotExists = true;
        return {
          async chmod(value) { snapshotMode = value; },
          async close() {},
          async stat() {
            return {
              ...fileDetails(snapshotPath, snapshotBytes),
              dev: 2,
              ino: 21,
              mode: 0o100000 | snapshotMode,
            };
          },
          async sync() {},
          async writeFile(bytes) { snapshotBytes = Buffer.from(bytes); },
        };
      }
      return {
        async close() {},
        async readFile() { return Buffer.from(snapshotBytes); },
        async stat() {
          return {
            ...fileDetails(snapshotPath, snapshotBytes),
            dev: 2,
            ino: 21,
            mode: 0o100000 | snapshotMode,
          };
        },
      };
    },
    async stat(requestedPath) {
      if ([APK_PATH, LOCK_PATH, APKANALYZER_PATH].includes(requestedPath)) {
        return { isFile: () => true };
      }
      throw Object.assign(new Error(`unexpected stat: ${requestedPath}`), { code: "ENOENT" });
    },
    async readFile(requestedPath) {
      if (requestedPath === APK_PATH) return overrides.apkBytes ?? APK_BYTES;
      if (requestedPath === LOCK_PATH) return lockBytes;
      assert.fail(`unexpected readFile: ${requestedPath}`);
    },
    async unlink(requestedPath) {
      assert.equal(requestedPath, snapshotPath);
      snapshotExists = false;
    },
    async rmdir(requestedPath) {
      assert.equal(requestedPath, snapshotDirectory);
      assert.equal(snapshotExists, false);
      snapshotDirectoryExists = false;
    },
  };
  const runCommand = async (executable, args, options) => {
    assert.equal(typeof executable, "string");
    assert.ok(Array.isArray(args), "commands must receive an argument array");
    calls.push({ executable, args: [...args], options: { ...options } });

    if (executable === "git") {
      assert.deepEqual(args.slice(0, 2), ["-C", REPO_ROOT]);
      const command = args.slice(2);
      if (command[0] === "rev-parse" && command[1] === "--show-toplevel") {
        return { stdout: `${REPO_ROOT}\n`, stderr: "" };
      }
      if (command[0] === "rev-parse" && command[1] === "--verify" && command[2] === "HEAD") {
        return { stdout: `${heads.shift() ?? COMMIT}\n`, stderr: "" };
      }
      if (
        command[0] === "rev-parse"
        && command[1] === "--verify"
        && command[2] === "HEAD^{tree}"
      ) {
        return { stdout: `${trees.shift() ?? TREE}\n`, stderr: "" };
      }
      if (command[0] === "status") {
        assert.deepEqual(command, ["status", "--porcelain=v1", "--untracked-files=all"]);
        return { stdout: overrides.status ?? "", stderr: "" };
      }
      assert.fail(`unexpected git command: ${JSON.stringify(command)}`);
    }

    assert.equal(executable, APKANALYZER_PATH);
    assert.notEqual(args[0], "--version", "apkanalyzer usage output must not be treated as a version");
    assert.equal(args[0], "manifest");
    assert.equal(args.at(-1), snapshotPath, "apkanalyzer must inspect the private APK snapshot");
    if (args[1] === "print") {
      assert.deepEqual(args, ["manifest", "print", snapshotPath]);
      return { stdout: metadata.manifestPrint, stderr: "" };
    }
    const configuredValue = {
      "application-id": metadata.applicationId,
      "version-name": metadata.versionName,
      "version-code": metadata.versionCode,
    }[args[1]];
    const value = typeof configuredValue === "function"
      ? configuredValue(snapshotPath)
      : configuredValue;
    if (value === undefined) assert.fail(`unexpected apkanalyzer command: ${JSON.stringify(args)}`);
    return { stdout: `${value}\n`, stderr: "" };
  };

  return {
    calls,
    filesystem,
    lockBytes,
    sourceOpenCount: () => openCounts.get(APK_PATH) ?? 0,
    runCommand,
    snapshotPath: () => snapshotPath,
  };
}

function gateOptions(harness, overrides = {}) {
  return {
    repoRoot: REPO_ROOT,
    apk: APK_REF,
    apkLock: LOCK_REF,
    expectedApplicationId: EXAMPLE_APPLICATION_ID,
    expectedVersionName: "1.4.2",
    expectedVersionCode: 10402,
    apkanalyzerPath: APKANALYZER_PATH,
    apkanalyzerIdentity: APKANALYZER_IDENTITY,
    filesystem: harness.filesystem,
    runCommand: harness.runCommand,
    ...overrides,
  };
}

test("default command capture rejects stdout while it crosses the configured bound", async () => {
  assert.equal(typeof apkGateModule.runBoundedCommand, "function");
  await assert.rejects(
    apkGateModule.runBoundedCommand(process.execPath, [
      "-e",
      'process.stdout.write("x".repeat(4096))',
    ], { maxOutputBytes: 1024 }),
    /command output exceeds 1024 bytes/,
  );
});

test("default command capture bounds argv and strips ACP secrets from child processes", async () => {
  const secret = "must-not-reach-apk-tools";
  const previous = process.env.ACP_BEARER_TOKEN;
  process.env.ACP_BEARER_TOKEN = secret;
  try {
    const result = await apkGateModule.runBoundedCommand(process.execPath, [
      "-e",
      "process.stdout.write(process.env.ACP_BEARER_TOKEN || '')",
    ]);
    assert.equal(result.stdout, "");
  } finally {
    if (previous === undefined) delete process.env.ACP_BEARER_TOKEN;
    else process.env.ACP_BEARER_TOKEN = previous;
  }
  await assert.rejects(
    apkGateModule.runBoundedCommand(process.execPath, ["x".repeat(4_097)]),
    /bounded argument strings/,
  );
  await assert.rejects(
    apkGateModule.runBoundedCommand(process.execPath, [
      "-e",
      "setInterval(() => {}, 1000)",
    ], { timeoutMilliseconds: 25 }),
    /timed out or was cancelled/,
  );
});

test("binds portable APK and lock identities to one clean source commit", async () => {
  const harness = createHarness();
  const lockSha256 = createHash("sha256").update(harness.lockBytes).digest("hex");

  const result = await verifyAndroidApkGate(gateOptions(harness));

  assert.deepEqual(result, {
    capture: {
      android: {
        apk: {
          ref: APK_REF,
          sha256: APK_SHA256,
          lock: { ref: LOCK_REF, sha256: lockSha256 },
          applicationId: EXAMPLE_APPLICATION_ID,
          versionName: "1.4.2",
          versionCode: "10402",
          source: { commit: COMMIT, tree: TREE, path: SOURCE_PATH },
          apkanalyzer: {
            identity: "apkanalyzer",
            version: "cmdline-tools 19.0",
          },
        },
      },
    },
  });
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.capture));
  assert.ok(Object.isFrozen(result.capture.android));
  assert.ok(Object.isFrozen(result.capture.android.apk));
  assert.ok(Object.isFrozen(result.capture.android.apk.lock));
  assert.ok(Object.isFrozen(result.capture.android.apk.source));
  assert.ok(Object.isFrozen(result.capture.android.apk.apkanalyzer));
  assert.doesNotMatch(JSON.stringify(result), /\/workspace|\/opt\/android-sdk/);
  assert.equal(harness.sourceOpenCount(), 1, "the source APK must stay bound to one FD");

  const analyzerCalls = harness.calls.filter(({ executable }) => executable === APKANALYZER_PATH);
  assert.deepEqual(analyzerCalls.map(({ args }) => args), [
    ["manifest", "application-id", harness.snapshotPath()],
    ["manifest", "version-name", harness.snapshotPath()],
    ["manifest", "version-code", harness.snapshotPath()],
    ["manifest", "print", harness.snapshotPath()],
  ]);
});

test("requires one bounded embedded source commit independent of XML attribute order", async () => {
  const duplicate = [
    "<manifest><application>",
    `<meta-data android:name="${SOURCE_COMMIT_METADATA_NAME}" android:value="${COMMIT}" />`,
    `<meta-data android:value="${COMMIT}" android:name="${SOURCE_COMMIT_METADATA_NAME}" />`,
    "</application></manifest>",
  ].join("");
  const malformed = [
    "<manifest><application>",
    `<meta-data android:name="${SOURCE_COMMIT_METADATA_NAME}" android:value=${COMMIT} />`,
    "</application></manifest>",
  ].join("");
  const cases = [
    ["<manifest><application /></manifest>", /embedded source commit metadata is absent/],
    [[
      "<manifest><application>",
      `<!-- <meta-data android:name="${SOURCE_COMMIT_METADATA_NAME}" android:value="${COMMIT}" /> -->`,
      "</application></manifest>",
    ].join(""), /embedded source commit metadata is absent/],
    [duplicate, /embedded source commit metadata is duplicated/],
    [malformed, /manifest print contains malformed meta-data/],
    [manifestPrint("b".repeat(40)), /embedded source commit mismatch/],
    [manifestPrint(COMMIT, 2), /embedded APK lock schema version mismatch/],
    [`<manifest>${" ".repeat(1024 * 1024)}</manifest>`, /manifest print output exceeds/],
  ];
  for (const [output, expectedError] of cases) {
    const harness = createHarness({ metadata: { manifestPrint: output } });
    await assert.rejects(verifyAndroidApkGate(gateOptions(harness)), expectedError);
  }
});

test("uses the lock as the version contract when explicit expectations are absent", async () => {
  const harness = createHarness();
  const options = gateOptions(harness);
  delete options.expectedVersionName;
  delete options.expectedVersionCode;

  const result = await verifyAndroidApkGate(options);

  assert.equal(result.capture.android.apk.versionName, "1.4.2");
  assert.equal(result.capture.android.apk.versionCode, "10402");
});

test("accepts any bounded scenario application ID when analyzer and lock match", async () => {
  const applicationId = "com.example.mobile_demo";
  const harness = createHarness({
    metadata: { applicationId },
    lock: { apk: { applicationId } },
  });

  const result = await verifyAndroidApkGate(gateOptions(harness, {
    expectedApplicationId: applicationId,
  }));

  assert.equal(result.capture.android.apk.applicationId, applicationId);
});

test("requires a bounded scenario application ID and exact analyzer match", async () => {
  for (const expectedApplicationId of [undefined, "Not An Application", "a", `a.${"b".repeat(199)}`]) {
    const harness = createHarness();
    const options = gateOptions(harness, { expectedApplicationId });
    if (expectedApplicationId === undefined) delete options.expectedApplicationId;
    await assert.rejects(
      verifyAndroidApkGate(options),
      /expectedApplicationId must be a bounded Android application ID/,
    );
    assert.equal(harness.calls.length, 0);
  }

  const harness = createHarness();

  await assert.rejects(
    verifyAndroidApkGate(gateOptions(harness, {
      expectedApplicationId: "dev.example.mobile",
    })),
    /application ID mismatch/,
  );
});

test("rejects APK bytes that do not match the lock digest", async () => {
  const harness = createHarness({ apkBytes: Buffer.from("replacement APK") });

  await assert.rejects(verifyAndroidApkGate(gateOptions(harness)), /APK digest mismatch/);
  assert.equal(harness.calls.some(({ executable }) => executable === APKANALYZER_PATH), false);
});

test("analyzes only one private locked-byte snapshot when the repo APK path is replaced", async (t) => {
  const temporaryRoot = await realFs.mkdtemp(path.join(os.tmpdir(), "apk-gate-swap-test-"));
  const repositoryRoot = await realFs.realpath(temporaryRoot);
  t.after(async () => realFs.rm(repositoryRoot, { force: true, recursive: true }));
  const artifactsDirectory = path.join(repositoryRoot, "artifacts");
  const toolsDirectory = path.join(repositoryRoot, "tools");
  await realFs.mkdir(artifactsDirectory);
  await realFs.mkdir(toolsDirectory);
  const apkPath = path.join(artifactsDirectory, "artoo-debug.apk");
  const displacedApkPath = `${apkPath}.original`;
  const lockPath = path.join(artifactsDirectory, "artoo-debug.apk.lock.json");
  const analyzerPath = path.join(toolsDirectory, "apkanalyzer");
  const lockBytes = Buffer.from(`${JSON.stringify(lockDocument(), null, 2)}\n`);
  await realFs.writeFile(apkPath, APK_BYTES, { mode: 0o600 });
  await realFs.writeFile(lockPath, lockBytes, { mode: 0o600 });
  await realFs.writeFile(analyzerPath, "analyzer\n", { mode: 0o700 });

  const analyzerPaths = [];
  const analyzedBytes = [];
  let replaced = false;
  const runCommand = async (executable, args) => {
    if (executable === "git") {
      assert.deepEqual(args.slice(0, 2), ["-C", repositoryRoot]);
      const command = args.slice(2);
      if (command[0] === "rev-parse" && command[1] === "--show-toplevel") {
        return { stdout: `${repositoryRoot}\n`, stderr: "" };
      }
      if (
        command[0] === "rev-parse"
        && command[1] === "--verify"
        && command[2] === "HEAD^{tree}"
      ) {
        return { stdout: `${TREE}\n`, stderr: "" };
      }
      if (command[0] === "rev-parse" && command[1] === "--verify") {
        return { stdout: `${COMMIT}\n`, stderr: "" };
      }
      if (command[0] === "status") return { stdout: "", stderr: "" };
      assert.fail(`unexpected git command: ${JSON.stringify(command)}`);
    }
    assert.equal(executable, analyzerPath);
    const inspectedPath = args.at(-1);
    analyzerPaths.push(inspectedPath);
    analyzedBytes.push(await realFs.readFile(inspectedPath));
    if (!replaced) {
      replaced = true;
      await realFs.rename(apkPath, displacedApkPath);
      await realFs.writeFile(apkPath, Buffer.from("attacker replacement APK"));
    }
    if (args[1] === "print") return { stdout: manifestPrint(), stderr: "" };
    const value = {
      "application-id": EXAMPLE_APPLICATION_ID,
      "version-name": "1.4.2",
      "version-code": "10402",
    }[args[1]];
    return { stdout: `${value}\n`, stderr: "" };
  };

  await assert.rejects(verifyAndroidApkGate({
    repoRoot: repositoryRoot,
    apk: APK_REF,
    apkLock: LOCK_REF,
    expectedApplicationId: EXAMPLE_APPLICATION_ID,
    expectedVersionName: "1.4.2",
    expectedVersionCode: 10402,
    apkanalyzerPath: analyzerPath,
    apkanalyzerIdentity: APKANALYZER_IDENTITY,
    runCommand,
  }), /APK changed while private snapshot was in use/);

  assert.equal(analyzerPaths.length, 4);
  assert.equal(new Set(analyzerPaths).size, 1);
  assert.notEqual(analyzerPaths[0], apkPath);
  assert.equal(analyzedBytes.every((bytes) => bytes.equals(APK_BYTES)), true);
  await assert.rejects(realFs.lstat(analyzerPaths[0]), { code: "ENOENT" });
});

test("removes a partially-created private snapshot when snapshot writing fails", async (t) => {
  const sourceRoot = await realFs.realpath(
    await realFs.mkdtemp(path.join(os.tmpdir(), "apk-snapshot-source-test-")),
  );
  const sourcePath = path.join(sourceRoot, "source.apk");
  await realFs.writeFile(sourcePath, APK_BYTES, { mode: 0o600 });
  let createdDirectory;
  const filesystem = {
    ...realFs,
    async mkdtemp(prefix) {
      createdDirectory = await realFs.mkdtemp(prefix);
      return createdDirectory;
    },
    async open(requestedPath, flags, mode) {
      const handle = await realFs.open(requestedPath, flags, mode);
      if (path.basename(requestedPath) !== "verified.apk" || mode === undefined) return handle;
      return {
        chmod: handle.chmod.bind(handle),
        close: handle.close.bind(handle),
        stat: handle.stat.bind(handle),
        sync: handle.sync.bind(handle),
        async writeFile() { throw new Error("synthetic snapshot write failure"); },
      };
    },
  };
  t.after(async () => {
    await realFs.rm(sourceRoot, { force: true, recursive: true });
    if (createdDirectory) await realFs.rm(createdDirectory, { force: true, recursive: true });
  });

  await assert.rejects(apkGateModule.withPrivateAndroidApkSnapshot({
    filesystem,
    sourcePath,
    expectedSha256: APK_SHA256,
    useSnapshot: async () => assert.fail("consumer must not run"),
  }), (error) => {
    assert.equal(error.message, "Private APK snapshot creation failed");
    assert.equal(error.cause, undefined);
    return true;
  });
  await assert.rejects(realFs.lstat(createdDirectory), { code: "ENOENT" });
});

test("removes its newly-created private directory when permission hardening fails", async (t) => {
  const sourceRoot = await realFs.realpath(
    await realFs.mkdtemp(path.join(os.tmpdir(), "apk-snapshot-chmod-test-")),
  );
  const sourcePath = path.join(sourceRoot, "source.apk");
  await realFs.writeFile(sourcePath, APK_BYTES, { mode: 0o600 });
  let createdDirectory;
  const filesystem = {
    ...realFs,
    async mkdtemp(prefix) {
      createdDirectory = await realFs.mkdtemp(prefix);
      return createdDirectory;
    },
    async chmod() { throw new Error("synthetic chmod failure"); },
  };
  t.after(async () => {
    await realFs.rm(sourceRoot, { force: true, recursive: true });
    if (createdDirectory) await realFs.rm(createdDirectory, { force: true, recursive: true });
  });

  await assert.rejects(apkGateModule.withPrivateAndroidApkSnapshot({
    filesystem,
    sourcePath,
    expectedSha256: APK_SHA256,
    useSnapshot: async () => assert.fail("consumer must not run"),
  }), /Private APK snapshot creation failed/);
  await assert.rejects(realFs.lstat(createdDirectory), { code: "ENOENT" });
});

test("removes its newly-created private directory when canonicalization fails", async (t) => {
  const sourceRoot = await realFs.realpath(
    await realFs.mkdtemp(path.join(os.tmpdir(), "apk-snapshot-realpath-test-")),
  );
  const sourcePath = path.join(sourceRoot, "source.apk");
  await realFs.writeFile(sourcePath, APK_BYTES, { mode: 0o600 });
  let createdDirectory;
  const filesystem = {
    ...realFs,
    async mkdtemp(prefix) {
      createdDirectory = await realFs.mkdtemp(prefix);
      return createdDirectory;
    },
    async realpath(requestedPath) {
      if (requestedPath === createdDirectory) throw new Error("synthetic realpath failure");
      return realFs.realpath(requestedPath);
    },
  };
  t.after(async () => {
    await realFs.rm(sourceRoot, { force: true, recursive: true });
    if (createdDirectory) await realFs.rm(createdDirectory, { force: true, recursive: true });
  });

  await assert.rejects(apkGateModule.withPrivateAndroidApkSnapshot({
    filesystem,
    sourcePath,
    expectedSha256: APK_SHA256,
    useSnapshot: async () => assert.fail("consumer must not run"),
  }), /Private APK snapshot creation failed/);
  await assert.rejects(realFs.lstat(createdDirectory), { code: "ENOENT" });
});

test("rejects private snapshot paths in callback result values or keys and still cleans", async (t) => {
  const sourceRoot = await realFs.realpath(
    await realFs.mkdtemp(path.join(os.tmpdir(), "apk-snapshot-result-test-")),
  );
  const sourcePath = path.join(sourceRoot, "source.apk");
  await realFs.writeFile(sourcePath, APK_BYTES, { mode: 0o600 });
  const privatePaths = [];
  t.after(async () => realFs.rm(sourceRoot, { force: true, recursive: true }));

  for (const publicResult of [
    (snapshotPath) => ({ accidentallyPublic: snapshotPath }),
    (snapshotPath) => ({ [snapshotPath]: true }),
  ]) {
    await assert.rejects(apkGateModule.withPrivateAndroidApkSnapshot({
      sourcePath,
      expectedSha256: APK_SHA256,
      useSnapshot: async (consume) => consume(async (snapshotPath) => {
        privatePaths.push(snapshotPath);
        return publicResult(snapshotPath);
      }),
    }), (error) => {
      assert.equal(error.message, "Private APK snapshot result is not portable");
      assert.equal(error.cause, undefined);
      return true;
    });
  }
  for (const privatePath of privatePaths) {
    await assert.rejects(realFs.lstat(privatePath), { code: "ENOENT" });
  }
});

test("reports cleanup failure when a consumer moves the verified snapshot inode", async (t) => {
  const sourceRoot = await realFs.realpath(
    await realFs.mkdtemp(path.join(os.tmpdir(), "apk-snapshot-escape-test-")),
  );
  const sourcePath = path.join(sourceRoot, "source.apk");
  const escapedPath = path.join(sourceRoot, "escaped.apk");
  await realFs.writeFile(sourcePath, APK_BYTES, { mode: 0o600 });
  let privateDirectory;
  t.after(async () => {
    await realFs.rm(sourceRoot, { force: true, recursive: true });
    if (privateDirectory) {
      await realFs.rm(privateDirectory, { force: true, recursive: true });
    }
  });

  await assert.rejects(apkGateModule.withPrivateAndroidApkSnapshot({
    sourcePath,
    expectedSha256: APK_SHA256,
    useSnapshot: async (consume) => consume(async (snapshotPath) => {
      privateDirectory = path.dirname(snapshotPath);
      await realFs.rename(snapshotPath, escapedPath);
      return undefined;
    }),
  }), (error) => {
    assert.equal(error.message, "Private APK snapshot cleanup failed");
    return true;
  });
  assert.deepEqual(await realFs.readFile(escapedPath), APK_BYTES);
});

test("rejects analyzed application ID and expected version mismatches", async () => {
  const cases = [
    [{ applicationId: "dev.example.mobile" }, /application ID mismatch/],
    [{ versionName: "1.4.3" }, /versionName mismatch/],
    [{ versionCode: "10403" }, /versionCode mismatch/],
  ];
  for (const [metadata, expectedError] of cases) {
    const harness = createHarness({ metadata });
    await assert.rejects(verifyAndroidApkGate(gateOptions(harness)), expectedError);
  }
});

test("does not reflect analyzer-controlled private paths in identity errors", async () => {
  const harness = createHarness({
    metadata: { applicationId: (snapshotPath) => snapshotPath },
  });
  let failure;
  try {
    await verifyAndroidApkGate(gateOptions(harness));
    assert.fail("private-path analyzer output must fail identity validation");
  } catch (error) {
    failure = error;
  }
  assert.equal(failure.message, "Private APK snapshot result is not portable");
  assert.doesNotMatch(failure.message, /acp-demo-creator-apk/u);
  assert.equal(failure.cause, undefined);
});

test("rejects source, requested APK, metadata, and analyzer lock mismatches", async () => {
  const cases = [
    [{ source: { commit: "b".repeat(40) } }, /lock source commit mismatch/],
    [{ source: { tree: "c".repeat(40) } }, /lock source tree mismatch/],
    [{ source: { path: "components/not-mobile" } }, /lock source path mismatch/],
    [{ apk: { ref: "repo:artifacts/other.apk" } }, /lock APK ref mismatch/],
    [{ apk: { applicationId: "dev.example.mobile" } }, /lock application ID mismatch/],
    [{ apk: { versionName: "1.4.3" } }, /lock versionName mismatch/],
    [{ apk: { versionCode: "10403" } }, /lock versionCode mismatch/],
    [{ apkanalyzer: { identity: "other-analyzer" } }, /lock apkanalyzer identity mismatch/],
    [{ apkanalyzer: { version: "cmdline-tools 18.0" } }, /lock apkanalyzer version mismatch/],
  ];
  for (const [lock, expectedError] of cases) {
    const harness = createHarness({ lock });
    await assert.rejects(verifyAndroidApkGate(gateOptions(harness)), expectedError);
  }
});

test("requires exact source tree, path, and embedded tree/schema provenance", async () => {
  for (const missingField of ["tree", "path"]) {
    const malformed = lockDocument();
    delete malformed.source[missingField];
    const harness = createHarness({
      lockBytes: Buffer.from(`${JSON.stringify(malformed)}\n`),
    });
    await assert.rejects(verifyAndroidApkGate(gateOptions(harness)), /APK lock has an invalid schema/);
  }
  const malformedTree = lockDocument({ source: { tree: "c".repeat(41) } });
  await assert.rejects(verifyAndroidApkGate(gateOptions(createHarness({
    lockBytes: Buffer.from(`${JSON.stringify(malformedTree)}\n`),
  }))), /APK lock has an invalid schema/);

  const withoutTree = manifestPrint().replace(
    /^\s*<meta-data android:name="dev\.ambientcode\.sourceTree"[^\n]*\n/mu,
    "",
  );
  const withoutSchema = manifestPrint().replace(
    /^\s*<meta-data android:name="dev\.ambientcode\.apkLockSchemaVersion"[^\n]*\n/mu,
    "",
  );
  const duplicateTree = manifestPrint().replace(
    "  </application>",
    `    <meta-data android:name="${SOURCE_TREE_METADATA_NAME}" android:value="${TREE}" />\n  </application>`,
  );
  for (const [manifest, expectedError] of [
    [withoutTree, /embedded source tree metadata is absent/],
    [withoutSchema, /embedded APK lock schema version is absent/],
    [duplicateTree, /embedded source tree metadata is duplicated/],
    [manifestPrint(COMMIT, ANDROID_APK_LOCK_SCHEMA_VERSION, "c".repeat(40)), /embedded source tree mismatch/],
  ]) {
    const harness = createHarness({ metadata: { manifestPrint: manifest } });
    await assert.rejects(verifyAndroidApkGate(gateOptions(harness)), expectedError);
  }
});

test("requires a closed APK lock schema at every authority boundary", async () => {
  const cases = [
    { unexpectedTopLevelAuthority: true },
    { apk: { unexpectedApkPolicy: true } },
    { apkanalyzer: { unexpectedToolProof: true } },
  ];
  for (const lock of cases) {
    const harness = createHarness({ lock });
    await assert.rejects(
      verifyAndroidApkGate(gateOptions(harness)),
      /APK lock has an invalid schema/,
    );
  }
});

test("refuses a dirty source worktree before inspecting the APK", async () => {
  const harness = createHarness({ status: " M components/mobile/app/build.gradle.kts\n" });

  await assert.rejects(verifyAndroidApkGate(gateOptions(harness)), /source worktree is dirty/);
  assert.equal(harness.calls.some(({ executable }) => executable === APKANALYZER_PATH), false);
});

test("refuses a HEAD change during verification", async () => {
  const movedCommit = "b".repeat(40);
  const harness = createHarness({ heads: [COMMIT, movedCommit] });

  await assert.rejects(
    verifyAndroidApkGate(gateOptions(harness)),
    new RegExp(`HEAD changed during APK verification: ${COMMIT} -> ${movedCommit}`),
  );
});

test("refuses a HEAD tree change during verification", async () => {
  const movedTree = "c".repeat(40);
  const harness = createHarness({ trees: [TREE, movedTree] });

  await assert.rejects(
    verifyAndroidApkGate(gateOptions(harness)),
    new RegExp(`HEAD tree changed during APK verification: ${TREE} -> ${movedTree}`),
  );
});

test("accepts only canonical repo references for APK and lock", async () => {
  const harness = createHarness();
  for (const [field, value] of [
    ["apk", APK_PATH],
    ["apk", "repo:../artoo.apk"],
    ["apk", "repo:C:/artoo.apk"],
    ["apk", "repo:artifacts\\artoo.apk"],
    ["apkLock", "repo:artifacts/./artoo.lock.json"],
    ["apkLock", "repo:"],
  ]) {
    await assert.rejects(
      verifyAndroidApkGate(gateOptions(harness, { [field]: value })),
      new RegExp(`${field} must be a canonical repo: reference`),
    );
  }
});

test("refuses requested APK or lock references that resolve through symlinks", async () => {
  for (const [overrides, expectedError] of [
    [{ apkRealpath: `${REPO_ROOT}/artifacts/other.apk` }, /apk must name the exact file without symlinks/],
    [{ lockRealpath: `${REPO_ROOT}/artifacts/other.lock.json` }, /apkLock must name the exact file without symlinks/],
  ]) {
    const harness = createHarness(overrides);
    await assert.rejects(verifyAndroidApkGate(gateOptions(harness)), expectedError);
    assert.equal(harness.calls.some(({ executable }) => executable === APKANALYZER_PATH), false);
  }
});

test("requires a valid lock document and bounded doctor-derived apkanalyzer identity", async () => {
  const malformedLock = createHarness({ lockBytes: Buffer.from("not JSON") });
  await assert.rejects(
    verifyAndroidApkGate(gateOptions(malformedLock)),
    /APK lock is not valid JSON/,
  );

  for (const apkanalyzerIdentity of [
    undefined,
    { identity: "apkanalyzer", version: "" },
    { identity: "apkanalyzer", version: "Usage: apkanalyzer [global options]" },
  ]) {
    const harness = createHarness();
    await assert.rejects(
      verifyAndroidApkGate(gateOptions(harness, { apkanalyzerIdentity })),
      /apkanalyzerIdentity must contain a bounded cmdline-tools identity and version/,
    );
    assert.equal(harness.calls.some(({ executable }) => executable === APKANALYZER_PATH), false);
  }

  const wrongExecutableIdentity = createHarness();
  await assert.rejects(
    verifyAndroidApkGate(gateOptions(wrongExecutableIdentity, {
      apkanalyzerIdentity: { identity: "other-analyzer", version: "cmdline-tools 19.0" },
    })),
    /apkanalyzerIdentity does not match canonical executable apkanalyzer/,
  );
});
