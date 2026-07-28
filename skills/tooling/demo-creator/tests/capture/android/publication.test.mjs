import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawn } from "node:child_process";

import {
  androidCapturePublicationWitnessPaths,
  publishAndroidCaptureBundle,
} from "../../../scripts/capture/android/publication.mjs";

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function fixture(context) {
  const outputDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "android-bundle-")));
  const rawDir = path.join(outputDir, "raw");
  await fs.mkdir(rawDir, { mode: 0o700 });
  context.after(() => fs.rm(outputDir, { recursive: true, force: true }));
  return {
    outputDir,
    recordingPath: path.join(rawDir, "android.mp4"),
    pointerPath: path.join(outputDir, "pointer-events.jsonl"),
    lockPath: path.join(rawDir, "android-apk-lock.json"),
  };
}

function publisher(destinationPath, bytes, { resultPathKey, fail = false } = {}) {
  return async ({ witnessPath }) => {
    if (fail) throw new Error("injected publication failure");
    await fs.writeFile(witnessPath, bytes, { flag: "wx", mode: 0o600 });
    return {
      [resultPathKey]: witnessPath,
      sha256: digest(bytes),
      ...(resultPathKey === "outputPath" ? { sizeBytes: bytes.length } : {}),
    };
  };
}

function bundleOptions(paths, { failLock = false } = {}) {
  const recordingBytes = Buffer.from("recording");
  const pointerBytes = Buffer.from('{"type":"click"}\n');
  const lockBytes = Buffer.from('{"schemaVersion":1}\n');
  return {
    outputDir: paths.outputDir,
    recordingDestinationPath: paths.recordingPath,
    pointerDestinationPath: paths.pointerPath,
    lockDestinationPath: paths.lockPath,
    expectedRecordingSha256: digest(recordingBytes),
    expectedPointerSha256: digest(pointerBytes),
    expectedLockSha256: digest(lockBytes),
    publishRecording: publisher(paths.recordingPath, recordingBytes, { resultPathKey: "outputPath" }),
    publishPointerEvents: publisher(paths.pointerPath, pointerBytes, { resultPathKey: "path" }),
    publishApkLock: publisher(paths.lockPath, lockBytes, {
      resultPathKey: "path",
      fail: failLock,
    }),
  };
}

test("capture-bundle publication rolls back every exact prior artifact and permits a clean retry", async (context) => {
  const paths = await fixture(context);

  await assert.rejects(
    publishAndroidCaptureBundle(bundleOptions(paths, { failLock: true })),
    /injected publication failure/,
  );
  for (const destination of [paths.recordingPath, paths.pointerPath, paths.lockPath]) {
    await assert.rejects(fs.lstat(destination), { code: "ENOENT" });
  }

  const result = await publishAndroidCaptureBundle(bundleOptions(paths));
  assert.deepEqual(Object.keys(result).sort(), ["lockArtifact", "pointerArtifact", "publishedRecording"]);
  assert.equal(result.publishedRecording.outputPath, paths.recordingPath);
  assert.equal(result.pointerArtifact.path, paths.pointerPath);
  assert.equal(result.lockArtifact.path, paths.lockPath);
});

test("a pre-existing destination preserves the preparation error and removes the publication lock", async (context) => {
  const paths = await fixture(context);
  await fs.writeFile(paths.recordingPath, "pre-existing recording", {
    flag: "wx",
    mode: 0o600,
  });

  const failure = await publishAndroidCaptureBundle(bundleOptions(paths)).then(
    () => undefined,
    (error) => error,
  );
  assert.ok(failure instanceof Error);
  const publicationLock = path.join(paths.outputDir, ".android-capture-publication");
  const lockState = await fs.lstat(publicationLock).then(
    () => "present",
    (error) => error?.code === "ENOENT" ? "absent" : Promise.reject(error),
  );
  assert.deepEqual(
    { message: failure.message, lockState },
    {
      message: "capture-bundle destination already exists",
      lockState: "absent",
    },
  );
  assert.equal(await fs.readFile(paths.recordingPath, "utf8"), "pre-existing recording");
});

test("preparation reports the primary and exact witness cleanup failures separately", async (context) => {
  const paths = await fixture(context);
  await fs.writeFile(paths.recordingPath, "pre-existing recording", {
    flag: "wx",
    mode: 0o600,
  });
  const options = bundleOptions(paths);
  const witnessRawDir = path.dirname(
    androidCapturePublicationWitnessPaths(paths.outputDir).recording,
  );
  options.fs = {
    ...fs,
    async rmdir(directory, ...args) {
      if (directory === witnessRawDir) {
        throw new Error("injected witness cleanup failure");
      }
      return fs.rmdir(directory, ...args);
    },
  };

  await assert.rejects(
    publishAndroidCaptureBundle(options),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.match(error.message, /preparation failed and exact cleanup failed/i);
      assert.deepEqual(
        error.errors.map(({ message }) => message),
        [
          "capture-bundle destination already exists",
          "injected witness cleanup failure",
        ],
      );
      assert.equal(error.cause, error.errors[0]);
      return true;
    },
  );
  const publicationLock = path.join(paths.outputDir, ".android-capture-publication");
  const ownerPath = path.join(publicationLock, "owner.json");
  const [lockDetails, ownerDetails] = await Promise.all([
    fs.lstat(publicationLock),
    fs.lstat(ownerPath),
  ]);
  assert.equal(lockDetails.isDirectory(), true);
  assert.equal(lockDetails.isSymbolicLink(), false);
  assert.equal(lockDetails.mode & 0o777, 0o700);
  assert.equal(await fs.realpath(publicationLock), publicationLock);
  assert.equal(ownerDetails.isFile(), true);
  assert.equal(ownerDetails.isSymbolicLink(), false);
  assert.equal(ownerDetails.mode & 0o777, 0o600);
  assert.equal(await fs.realpath(ownerPath), ownerPath);
  const owner = JSON.parse(await fs.readFile(ownerPath, "utf8"));
  assert.deepEqual(Object.keys(owner).sort(), ["nonce", "pid", "processStartIdentity"]);
  assert.equal(owner.pid, process.pid);
  assert.match(owner.nonce, /^[0-9a-f-]{36}$/u);
  assert.equal(typeof owner.processStartIdentity, "string");
  assert.notEqual(owner.processStartIdentity.length, 0);
});

test("preparation cleanup refuses to remove a replacement witness directory", async (context) => {
  const paths = await fixture(context);
  await fs.writeFile(paths.recordingPath, "pre-existing recording", {
    flag: "wx",
    mode: 0o600,
  });
  const options = bundleOptions(paths);
  const witnessRawDir = path.dirname(
    androidCapturePublicationWitnessPaths(paths.outputDir).recording,
  );
  const displacedRawDir = path.join(paths.outputDir, "displaced-owned-witness-raw");
  let replacementIdentity;
  options.fs = {
    ...fs,
    async readdir(directory, ...args) {
      if (directory === witnessRawDir && replacementIdentity === undefined) {
        await fs.rename(witnessRawDir, displacedRawDir);
        await fs.mkdir(witnessRawDir, { mode: 0o700 });
        const replacement = await fs.lstat(witnessRawDir);
        replacementIdentity = { dev: replacement.dev, ino: replacement.ino };
      }
      return fs.readdir(directory, ...args);
    },
  };

  await assert.rejects(
    publishAndroidCaptureBundle(options),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(
        error.errors.map(({ message }) => message),
        [
          "capture-bundle destination already exists",
          "capture-bundle witness directory identity changed",
        ],
      );
      return true;
    },
  );
  assert.ok(replacementIdentity);
  const replacementAfterCleanup = await fs.lstat(witnessRawDir);
  assert.deepEqual(
    { dev: replacementAfterCleanup.dev, ino: replacementAfterCleanup.ino },
    replacementIdentity,
  );
  assert.equal(replacementAfterCleanup.isDirectory(), true);
});

test("capture-bundle rollback refuses to remove a destination whose exact inode changed", async (context) => {
  const paths = await fixture(context);
  const options = bundleOptions(paths);
  options.publishApkLock = async () => {
    await fs.unlink(paths.recordingPath);
    await fs.writeFile(paths.recordingPath, "replacement", { flag: "wx", mode: 0o600 });
    throw new Error("late failure");
  };

  await assert.rejects(
    publishAndroidCaptureBundle(options),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.match(error.message, /rollback failed/i);
      return true;
    },
  );
  assert.equal(await fs.readFile(paths.recordingPath, "utf8"), "replacement");
  await assert.rejects(fs.lstat(paths.pointerPath), { code: "ENOENT" });
});

test("capture-bundle rollback rechecks the exact inode after hashing and before unlink", async (context) => {
  const paths = await fixture(context);
  const options = bundleOptions(paths, { failLock: true });
  const displaced = `${paths.recordingPath}.displaced`;
  let recordingOpens = 0;
  options.fs = {
    ...fs,
    async open(filePath, ...args) {
      const handle = await fs.open(filePath, ...args);
      if (filePath !== paths.recordingPath) return handle;
      recordingOpens += 1;
      if (recordingOpens !== 2) return handle;
      return {
        read: (...readArgs) => handle.read(...readArgs),
        async close() {
          await handle.close();
          await fs.rename(paths.recordingPath, displaced);
          await fs.writeFile(paths.recordingPath, "replacement-after-hash", {
            flag: "wx",
            mode: 0o600,
          });
        },
      };
    },
  };

  await assert.rejects(
    publishAndroidCaptureBundle(options),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.match(error.message, /rollback failed/i);
      return true;
    },
  );
  assert.equal(await fs.readFile(paths.recordingPath, "utf8"), "replacement-after-hash");
});

test("capture-bundle rolls back the current destination when its publisher returns a bad proof", async (context) => {
  const paths = await fixture(context);
  const options = bundleOptions(paths);
  options.publishPointerEvents = async ({ witnessPath }) => {
    await fs.writeFile(witnessPath, '{"type":"click"}\n', {
      flag: "wx",
      mode: 0o600,
    });
    return { path: witnessPath, sha256: "f".repeat(64) };
  };

  await assert.rejects(
    publishAndroidCaptureBundle(options),
    /artifact identity|unbound artifact proof/i,
  );
  for (const destination of [paths.recordingPath, paths.pointerPath, paths.lockPath]) {
    await assert.rejects(fs.lstat(destination), { code: "ENOENT" });
  }
});

test("capture-bundle adopts and rolls back an expected current destination when its publisher throws", async (context) => {
  const paths = await fixture(context);
  const options = bundleOptions(paths);
  options.publishRecording = async ({ witnessPath }) => {
    await fs.writeFile(witnessPath, "recording", { flag: "wx", mode: 0o600 });
    throw new Error("post-publication verification failed");
  };

  await assert.rejects(
    publishAndroidCaptureBundle(options),
    /post-publication verification failed/,
  );
  await assert.rejects(fs.lstat(paths.recordingPath), { code: "ENOENT" });
});

test("a dead publisher journal rolls back exact partial destinations before retry", async (context) => {
  const paths = await fixture(context);
  const moduleUrl = new URL(
    "../../../scripts/capture/android/publication.mjs",
    import.meta.url,
  ).href;
  const recordingBytes = "old-recording";
  const pointerBytes = '{"type":"click"}\n';
  const lockBytes = '{"schemaVersion":1}\n';
  const childScript = `
    import fs from "node:fs/promises";
    import { publishAndroidCaptureBundle } from ${JSON.stringify(moduleUrl)};
    const paths = ${JSON.stringify(paths)};
    await publishAndroidCaptureBundle({
      outputDir: paths.outputDir,
      recordingDestinationPath: paths.recordingPath,
      pointerDestinationPath: paths.pointerPath,
      lockDestinationPath: paths.lockPath,
      expectedRecordingSha256: ${JSON.stringify(digest(recordingBytes))},
      expectedPointerSha256: ${JSON.stringify(digest(pointerBytes))},
      expectedLockSha256: ${JSON.stringify(digest(lockBytes))},
      publishRecording: async ({ witnessPath }) => {
        await fs.writeFile(witnessPath, ${JSON.stringify(recordingBytes)}, { flag: "wx", mode: 0o600 });
        return { outputPath: witnessPath, sha256: ${JSON.stringify(digest(recordingBytes))} };
      },
      publishPointerEvents: async ({ witnessPath }) => {
        await fs.writeFile(witnessPath, ${JSON.stringify(pointerBytes)}, { flag: "wx", mode: 0o600 });
        process.stdout.write("POINTER_READY\\n");
        setInterval(() => {}, 1_000);
        await new Promise(() => {});
      },
      publishApkLock: async () => { throw new Error("unreachable"); },
    });
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", childScript], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const childExitPromise = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  await new Promise((resolve, reject) => {
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
      if (stdout.includes("POINTER_READY\n")) resolve();
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (!stdout.includes("POINTER_READY\n")) {
        reject(new Error(`publication child exited before readiness: ${code ?? signal}`));
      }
    });
  });
  await assert.rejects(
    publishAndroidCaptureBundle(bundleOptions(paths)),
    /owned by a live process/i,
  );
  child.kill("SIGKILL");
  const childExit = await childExitPromise;
  assert.equal(childExit.signal, "SIGKILL");
  assert.equal(childExit.code, null);
  assert.equal(await fs.readFile(paths.recordingPath, "utf8"), recordingBytes);
  await assert.rejects(fs.lstat(paths.pointerPath), { code: "ENOENT" });
  const witnesses = androidCapturePublicationWitnessPaths(paths.outputDir);
  assert.equal(await fs.readFile(witnesses.pointerEvents, "utf8"), pointerBytes);

  const retryOptions = bundleOptions(paths);
  retryOptions.inspectProcessIdentity = async (pid) => ({
    alive: true,
    pid,
    processStartIdentity: pid === child.pid ? "reused-pid-start" : "retry-owner-start",
  });
  const result = await publishAndroidCaptureBundle(retryOptions);
  assert.equal(result.publishedRecording.outputPath, paths.recordingPath);
  assert.equal(result.pointerArtifact.path, paths.pointerPath);
  assert.equal(result.lockArtifact.path, paths.lockPath);
});
