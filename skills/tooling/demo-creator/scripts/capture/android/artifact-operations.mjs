import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import * as nodeFs from "node:fs/promises";
import path from "node:path";

const defaultSha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const MAX_POINTER_EVENTS = 10_000;
const MAX_POINTER_TIME_SECONDS = 180;
const POINTER_KEYS = Object.freeze(["time", "type", "x", "y"]);

function validateOutputPath(outputPath, expectedBasename) {
  if (
    typeof outputPath !== "string"
    || !path.isAbsolute(outputPath)
    || path.resolve(outputPath) !== outputPath
    || path.basename(outputPath) !== expectedBasename
  ) {
    throw new Error(`Android artifact output must be exact ${expectedBasename} path`);
  }
  return path.dirname(outputPath);
}

async function assertCanonicalDirectory(fs, directory, label) {
  let canonical;
  try {
    canonical = await fs.realpath(directory);
  } catch (error) {
    throw new Error(`${label} does not exist`, { cause: error });
  }
  if (canonical !== directory) {
    throw new Error(`${label} must be canonical and must not use symlinks`);
  }
  const details = await fs.stat(directory);
  if (!details.isDirectory()) throw new Error(`${label} must be a directory`);
}

function canonicalPointerEvents(events) {
  if (!Array.isArray(events) || events.length > MAX_POINTER_EVENTS) {
    throw new Error(`pointer events must be an array of at most ${MAX_POINTER_EVENTS} events`);
  }
  let previousTime = 0;
  return events.map((event) => {
    if (
      event === null
      || typeof event !== "object"
      || Array.isArray(event)
      || Object.getPrototypeOf(event) !== Object.prototype
    ) {
      throw new Error("pointer event must be a plain object");
    }
    const keys = Object.keys(event).sort();
    if (keys.length !== POINTER_KEYS.length || keys.some((key, index) => key !== POINTER_KEYS[index])) {
      throw new Error("pointer event must contain only type, time, x, and y");
    }
    for (const key of POINTER_KEYS) {
      if (!("value" in Object.getOwnPropertyDescriptor(event, key))) {
        throw new Error("pointer event fields must be plain data properties");
      }
    }
    if (event.type !== "click") throw new Error("pointer event type must be click");
    if (
      !Number.isFinite(event.time)
      || event.time < 0
      || event.time > MAX_POINTER_TIME_SECONDS
      || event.time < previousTime
    ) {
      throw new Error("pointer event time must be finite, bounded, and nondecreasing");
    }
    if (
      !Number.isFinite(event.x)
      || !Number.isFinite(event.y)
      || event.x < 0
      || event.x > 1
      || event.y < 0
      || event.y > 1
    ) {
      throw new Error("pointer event coordinates must be finite normalized values");
    }
    previousTime = event.time;
    return { type: "click", time: event.time, x: event.x, y: event.y };
  });
}

function validateSha256(value, label) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function resolveRepoReference(repoRoot, sourceRef) {
  if (
    typeof sourceRef !== "string"
    || !/^repo:[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/u.test(sourceRef)
  ) {
    throw new Error("Android APK lock sourceRef must be a canonical repo: reference");
  }
  const segments = sourceRef.slice("repo:".length).split("/");
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw new Error("Android APK lock sourceRef must be a canonical repo: reference");
  }
  const sourcePath = path.resolve(repoRoot, ...segments);
  const relative = path.relative(repoRoot, sourcePath);
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Android APK lock sourceRef escapes repoRoot");
  }
  return sourcePath;
}

async function readExactRegularFile(fs, pathname, label) {
  const canonical = await fs.realpath(pathname).catch((error) => {
    throw new Error(`${label} does not exist`, { cause: error });
  });
  if (canonical !== pathname) throw new Error(`${label} must be exact and must not use symlinks`);
  const handle = await fs.open(pathname, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const details = await handle.stat();
    if (!details.isFile()) throw new Error(`${label} must be a regular file`);
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

async function publishExclusive(fs, outputPath, bytes, beforePublish = async () => {}) {
  const outputParent = path.dirname(outputPath);
  const temporaryPath = path.join(
    outputParent,
    `.${path.basename(outputPath)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
  );
  let handle;
  let temporaryExists = false;
  try {
    handle = await fs.open(temporaryPath, "wx", 0o600);
    temporaryExists = true;
    await handle.writeFile(bytes);
    await handle.chmod(0o600);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await beforePublish();
    await assertCanonicalDirectory(fs, outputParent, "Android artifact output parent");
    await fs.link(temporaryPath, outputPath);
  } finally {
    if (handle) await handle.close().catch(() => {});
    if (temporaryExists) await fs.unlink(temporaryPath).catch(() => {});
  }
}

function validateAbsoluteDirectoryPath(value, label) {
  if (typeof value !== "string" || !path.isAbsolute(value) || path.resolve(value) !== value) {
    throw new Error(`${label} must be one normalized absolute path`);
  }
}

async function inspectPrivateDirectory(fs, directory, label) {
  const details = await fs.lstat(directory);
  if (details.isSymbolicLink() || !details.isDirectory()) {
    throw new Error(`${label} must be an exact directory and must not be a symlink`);
  }
  if ((details.mode & 0o777) !== 0o700) {
    throw new Error(`${label} must already be private mode 0700`);
  }
  if (
    typeof process.getuid === "function"
    && Number.isInteger(details.uid)
    && details.uid !== process.getuid()
  ) {
    throw new Error(`${label} must be owned by the current user`);
  }
  await assertCanonicalDirectory(fs, directory, label);
}

async function ensurePrivateDirectory(fs, directory, label) {
  try {
    await inspectPrivateDirectory(fs, directory, label);
    return false;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await assertCanonicalDirectory(fs, path.dirname(directory), `${label} parent`);
  await fs.mkdir(directory, { mode: 0o700 });
  await inspectPrivateDirectory(fs, directory, label);
  return true;
}

export async function prepareAndroidRunDirectories({
  markerRoot,
  outputDir,
  fs = nodeFs,
} = {}) {
  validateAbsoluteDirectoryPath(markerRoot, "markerRoot");
  validateAbsoluteDirectoryPath(outputDir, "outputDir");
  const avdRoot = path.join(markerRoot, "avds");
  const homeRoot = path.join(markerRoot, "home");
  const tmpRoot = path.join(markerRoot, "tmp");
  const xdgConfigRoot = path.join(markerRoot, "xdg-config");
  const xdgRuntimeRoot = path.join(markerRoot, "xdg-runtime");
  const kindStateRoot = path.join(markerRoot, "kind-state");
  const kindLegacyRoot = path.join(kindStateRoot, "legacy");
  const rawOutputDir = path.join(outputDir, "raw");
  const created = [];
  try {
    for (const [directory, label] of [
      [markerRoot, "markerRoot"],
      [outputDir, "outputDir"],
      [avdRoot, "avdRoot"],
      [homeRoot, "homeRoot"],
      [tmpRoot, "tmpRoot"],
      [xdgConfigRoot, "xdgConfigRoot"],
      [xdgRuntimeRoot, "xdgRuntimeRoot"],
      [kindStateRoot, "kindStateRoot"],
      [kindLegacyRoot, "kindLegacyRoot"],
      [rawOutputDir, "rawOutputDir"],
    ]) {
      if (await ensurePrivateDirectory(fs, directory, label)) created.push(directory);
    }
    for (const [directory, label] of [
      [markerRoot, "markerRoot"],
      [outputDir, "outputDir"],
      [avdRoot, "avdRoot"],
      [homeRoot, "homeRoot"],
      [tmpRoot, "tmpRoot"],
      [xdgConfigRoot, "xdgConfigRoot"],
      [xdgRuntimeRoot, "xdgRuntimeRoot"],
      [kindStateRoot, "kindStateRoot"],
      [kindLegacyRoot, "kindLegacyRoot"],
      [rawOutputDir, "rawOutputDir"],
    ]) {
      await inspectPrivateDirectory(fs, directory, label);
    }
    return Object.freeze({
      markerRoot,
      avdRoot,
      homeRoot,
      tmpRoot,
      xdgConfigRoot,
      xdgRuntimeRoot,
      kindStateRoot,
      kindLegacyRoot,
      outputDir,
      rawOutputDir,
      stagingParent: outputDir,
    });
  } catch (error) {
    for (const directory of created.reverse()) {
      await fs.rmdir(directory).catch(() => {});
    }
    throw error;
  }
}

export function createAndroidArtifactOperations(deps = {}) {
  const fs = deps.fs ?? nodeFs;
  const digest = deps.hash ?? deps.sha256 ?? defaultSha256;

  return Object.freeze({
    async writeAndroidPointerEvents({ events, outputPath }) {
      const outputParent = validateOutputPath(outputPath, "pointer-events.jsonl");
      await assertCanonicalDirectory(fs, outputParent, "Android artifact output parent");
      const normalizedEvents = canonicalPointerEvents(events);
      const bytes = normalizedEvents.length === 0
        ? ""
        : `${normalizedEvents.map((event) => JSON.stringify(event)).join("\n")}\n`;
      const expectedDigest = validateSha256(
        digest(bytes),
        "computed pointer event SHA-256",
      );
      await publishExclusive(fs, outputPath, bytes);
      const published = await readExactRegularFile(fs, outputPath, "Android pointer event output");
      if (published.toString("utf8") !== bytes) {
        throw new Error("Android pointer event output differs from staged JSONL");
      }
      return {
        path: outputPath,
        sha256: expectedDigest,
      };
    },
    async copyAndroidApkLockEvidence({
      repoRoot,
      sourceRef,
      expectedSha256,
      outputPath,
    }) {
      if (typeof repoRoot !== "string" || !path.isAbsolute(repoRoot) || path.resolve(repoRoot) !== repoRoot) {
        throw new Error("repoRoot must be one normalized absolute path");
      }
      await assertCanonicalDirectory(fs, repoRoot, "repoRoot");
      const sourcePath = resolveRepoReference(repoRoot, sourceRef);
      const outputParent = validateOutputPath(outputPath, "android-apk-lock.json");
      if (path.basename(outputParent) !== "raw") {
        throw new Error("Android APK lock output must be beneath exact raw output directory");
      }
      await assertCanonicalDirectory(fs, outputParent, "Android artifact output parent");
      const expected = validateSha256(expectedSha256, "expectedSha256");
      const before = await readExactRegularFile(fs, sourcePath, "Android APK lock source");
      if (validateSha256(digest(before), "computed source SHA-256") !== expected) {
        throw new Error("Android APK lock source SHA-256 does not match expectedSha256");
      }
      await publishExclusive(fs, outputPath, before, async () => {
        const after = await readExactRegularFile(fs, sourcePath, "Android APK lock source");
        if (validateSha256(digest(after), "computed source SHA-256") !== expected) {
          throw new Error("Android APK lock source changed while copying");
        }
      });
      const published = await readExactRegularFile(fs, outputPath, "Android APK lock output");
      if (validateSha256(digest(published), "computed output SHA-256") !== expected) {
        throw new Error("Android APK lock output SHA-256 does not match expectedSha256");
      }
      return { path: outputPath, sha256: expected };
    },
  });
}
