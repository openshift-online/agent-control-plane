import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import {
  chmod,
  lstat,
  mkdtemp,
  open,
  readFile,
  realpath,
  rmdir,
  stat,
  unlink,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

export const ANDROID_APK_LOCK_SCHEMA_VERSION = 1;

const ANDROID_APPLICATION_ID_PATTERN = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/u;
const APKANALYZER_IDENTITY_PATTERN = /^[A-Za-z0-9._-]{1,64}$/u;
const CMDLINE_TOOLS_VERSION_PATTERN = /^cmdline-tools [1-9][0-9]*(?:\.[0-9]+){1,3}$/u;
const MANIFEST_PRINT_MAX_BYTES = 1024 * 1024;
const SOURCE_COMMIT_METADATA_NAME = "dev.ambientcode.sourceCommit";
const SOURCE_TREE_METADATA_NAME = "dev.ambientcode.sourceTree";
const LOCK_SCHEMA_METADATA_NAME = "dev.ambientcode.apkLockSchemaVersion";
const MOBILE_SOURCE_PATH = "components/mobile";
const GIT_OBJECT_ID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const DEFAULT_COMMAND_MAX_BYTES = 1024 * 1024;
const MAX_APK_BYTES = 512 * 1024 * 1024;
const PRIVATE_SNAPSHOT_DIRECTORY_MODE = 0o700;
const PRIVATE_SNAPSHOT_FILE_MODE = 0o400;
const TOOL_ENVIRONMENT_FIELDS = Object.freeze([
  "HOME",
  "JAVA_HOME",
  "LANG",
  "LC_ALL",
  "PATH",
  "TEMP",
  "TMP",
  "TMPDIR",
]);
const execFileAsync = promisify(execFile);

export class AndroidApkGateError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "AndroidApkGateError";
  }
}

const defaultFilesystem = Object.freeze({
  chmod,
  lstat,
  mkdtemp,
  open,
  readFile,
  realpath,
  rmdir,
  stat,
  unlink,
});

function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

async function sha256PositionedFile(handle, expectedSize) {
  if (
    typeof handle?.read !== "function"
    || !Number.isSafeInteger(expectedSize)
    || expectedSize < 0
    || expectedSize > MAX_APK_BYTES
  ) throw new Error("invalid snapshot descriptor");
  const digest = createHash("sha256");
  const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, Math.max(1, expectedSize)));
  let position = 0;
  while (position < expectedSize) {
    const length = Math.min(buffer.length, expectedSize - position);
    const result = await handle.read(buffer, 0, length, position);
    if (!Number.isSafeInteger(result?.bytesRead) || result.bytesRead < 1 || result.bytesRead > length) {
      throw new Error("invalid snapshot descriptor read");
    }
    digest.update(buffer.subarray(0, result.bytesRead));
    position += result.bytesRead;
  }
  const trailing = Buffer.allocUnsafe(1);
  const result = await handle.read(trailing, 0, 1, expectedSize);
  if (result?.bytesRead !== 0) throw new Error("snapshot descriptor grew during verification");
  return digest.digest("hex");
}

function isByteArray(value) {
  return Buffer.isBuffer(value) || value instanceof Uint8Array;
}

function stableFileIdentity(first, second) {
  return ["dev", "ino", "size", "mtimeMs", "ctimeMs"].every((field) => (
    first[field] === undefined
    || second[field] === undefined
    || first[field] === second[field]
  ));
}

function stableObjectIdentity(first, second) {
  return ["dev", "ino"].every((field) => (
    first[field] === undefined
    || second[field] === undefined
    || first[field] === second[field]
  ));
}

async function openStableRegularFile(filesystem, pathname, label, maximumBytes) {
  let canonical;
  let pathBefore;
  let handle;
  try {
    canonical = await filesystem.realpath(pathname);
    pathBefore = await filesystem.lstat(pathname);
    if (canonical !== pathname) {
      throw new AndroidApkGateError(`${label} must name the exact file without symlinks`);
    }
    if (!pathBefore.isFile() || pathBefore.isSymbolicLink()) {
      throw new AndroidApkGateError(`${label} must be a regular file without symlinks`);
    }
    handle = await filesystem.open(pathname, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const descriptorBefore = await handle.stat();
    if (!descriptorBefore.isFile() || !stableFileIdentity(pathBefore, descriptorBefore)) {
      throw new Error("unstable source");
    }
    if (
      !Number.isSafeInteger(descriptorBefore.size)
      || descriptorBefore.size < 0
      || descriptorBefore.size > maximumBytes
    ) throw new Error("oversized source");
    const bytes = await handle.readFile();
    if (!isByteArray(bytes) || bytes.byteLength > maximumBytes) {
      throw new Error("invalid source bytes");
    }
    const descriptorAfter = await handle.stat();
    const pathAfter = await filesystem.lstat(pathname);
    const canonicalAfter = await filesystem.realpath(pathname);
    if (
      canonicalAfter !== pathname
      || !pathAfter.isFile()
      || pathAfter.isSymbolicLink()
      || !stableFileIdentity(descriptorBefore, descriptorAfter)
      || !stableFileIdentity(descriptorAfter, pathAfter)
      || descriptorAfter.size !== bytes.byteLength
    ) throw new Error("unstable source");
    return {
      bytes: Buffer.from(bytes),
      handle,
      identity: descriptorAfter,
      pathname,
    };
  } catch (error) {
    try { await handle?.close(); } catch { /* the static read failure remains authoritative */ }
    if (error instanceof AndroidApkGateError) throw error;
    throw new AndroidApkGateError(`${label} changed while it was being read`, { cause: error });
  }
}

async function verifyStableRegularFile(filesystem, opened, label) {
  try {
    const descriptor = await opened.handle.stat();
    const pathDetails = await filesystem.lstat(opened.pathname);
    const canonical = await filesystem.realpath(opened.pathname);
    if (
      canonical !== opened.pathname
      || !descriptor.isFile()
      || !pathDetails.isFile()
      || pathDetails.isSymbolicLink()
      || !stableFileIdentity(opened.identity, descriptor)
      || !stableFileIdentity(descriptor, pathDetails)
    ) throw new Error("unstable source");
  } catch {
    throw new AndroidApkGateError(`${label} changed while private snapshot was in use`);
  }
}

async function readStableRegularFile(filesystem, pathname, label, maximumBytes) {
  const opened = await openStableRegularFile(filesystem, pathname, label, maximumBytes);
  try {
    return opened.bytes;
  } finally {
    try { await opened.handle.close(); } catch { /* the stable read already completed */ }
  }
}

async function assertPrivateDirectory(
  filesystem,
  directory,
  expectedIdentity,
  requireCanonical = true,
) {
  try {
    const canonical = requireCanonical ? await filesystem.realpath(directory) : directory;
    const details = await filesystem.lstat(directory);
    if (
      (requireCanonical && canonical !== directory)
      || !details.isDirectory()
      || details.isSymbolicLink()
      || (details.mode & 0o777) !== PRIVATE_SNAPSHOT_DIRECTORY_MODE
      || (expectedIdentity && !stableObjectIdentity(expectedIdentity, details))
    ) throw new Error("untrusted directory");
  } catch (error) {
    throw new AndroidApkGateError("Private APK snapshot directory verification failed");
  }
}

async function inspectPrivateSnapshot(filesystem, snapshot, expectedSha256) {
  await assertPrivateDirectory(filesystem, snapshot.directory, snapshot.directoryIdentity);
  let handle;
  try {
    const canonical = await filesystem.realpath(snapshot.pathname);
    const pathBefore = await filesystem.lstat(snapshot.pathname);
    if (
      canonical !== snapshot.pathname
      || !pathBefore.isFile()
      || pathBefore.isSymbolicLink()
      || (pathBefore.mode & 0o777) !== PRIVATE_SNAPSHOT_FILE_MODE
      || !stableFileIdentity(snapshot.fileIdentity, pathBefore)
    ) throw new Error("untrusted snapshot");
    handle = await filesystem.open(
      snapshot.pathname,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    );
    const descriptorBefore = await handle.stat();
    if (!descriptorBefore.isFile() || !stableFileIdentity(pathBefore, descriptorBefore)) {
      throw new Error("untrusted snapshot");
    }
    const bytes = await handle.readFile();
    const descriptorAfter = await handle.stat();
    if (
      !isByteArray(bytes)
      || bytes.byteLength > MAX_APK_BYTES
      || descriptorAfter.size !== bytes.byteLength
      || !stableFileIdentity(descriptorBefore, descriptorAfter)
      || sha256(bytes) !== expectedSha256
    ) throw new Error("untrusted snapshot");
  } catch (error) {
    throw new AndroidApkGateError("Private APK snapshot verification failed");
  } finally {
    try { await handle?.close(); } catch { /* the static verification failure remains authoritative */ }
  }
}

async function cleanupPrivateSnapshot(filesystem, snapshot) {
  await assertPrivateDirectory(
    filesystem,
    snapshot.directory,
    snapshot.directoryIdentity,
    snapshot.requireCanonical !== false,
  );
  try {
    let snapshotExists = true;
    try {
      const details = await filesystem.lstat(snapshot.pathname);
      if (details.isDirectory()) throw new Error("snapshot path became a directory");
      if (snapshot.fileIdentity && (
        !details.isFile()
        || details.isSymbolicLink()
        || (details.mode & 0o777) !== PRIVATE_SNAPSHOT_FILE_MODE
        || !stableFileIdentity(snapshot.fileIdentity, details)
      )) throw new Error("snapshot identity changed before cleanup");
    } catch (error) {
      if (error?.code === "ENOENT" && !snapshot.fileIdentity) snapshotExists = false;
      else throw error;
    }
    if (snapshotExists) {
      await filesystem.unlink(snapshot.pathname);
      try {
        await filesystem.lstat(snapshot.pathname);
        throw new Error("snapshot path still exists");
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
    await filesystem.rmdir(snapshot.directory);
    try {
      await filesystem.lstat(snapshot.directory);
      throw new Error("snapshot directory still exists");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  } catch (error) {
    throw new AndroidApkGateError("Private APK snapshot cleanup failed");
  }
}

function containsPrivateSnapshotPath(value, snapshot, seen = new Set(), depth = 0) {
  if (typeof value === "string") {
    return value.includes(snapshot.pathname) || value.includes(snapshot.directory);
  }
  if (value === null || typeof value !== "object") return false;
  if (depth > 20) return true;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) {
    return value.some((item) => containsPrivateSnapshotPath(item, snapshot, seen, depth + 1));
  }
  if (Object.getPrototypeOf(value) !== Object.prototype) return true;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return Object.entries(descriptors).some(([key, descriptor]) => (
    containsPrivateSnapshotPath(key, snapshot, seen, depth + 1)
    || typeof descriptor.get === "function"
    || typeof descriptor.set === "function"
    || containsPrivateSnapshotPath(descriptor.value, snapshot, seen, depth + 1)
  ));
}

export async function withPrivateAndroidApkSnapshot(options = {}) {
  if (
    typeof options.sourcePath !== "string"
    || !/^[0-9a-f]{64}$/u.test(options.expectedSha256 ?? "")
    || typeof options.useSnapshot !== "function"
  ) throw new AndroidApkGateError("Private APK snapshot input is invalid");
  const filesystem = options.filesystem ?? defaultFilesystem;
  const source = await openStableRegularFile(
    filesystem,
    options.sourcePath,
    "APK",
    MAX_APK_BYTES,
  );
  const sourceBytes = source.bytes;
  if (sha256(sourceBytes) !== options.expectedSha256) {
    try { await source.handle.close(); } catch { /* digest failure remains authoritative */ }
    throw new AndroidApkGateError("APK digest mismatch");
  }

  let snapshot;
  let creationComplete = false;
  let primaryError;
  let result;
  try {
    const createdDirectory = await filesystem.mkdtemp(
      path.join(os.tmpdir(), "acp-demo-creator-apk-"),
    );
    snapshot = {
      directory: createdDirectory,
      pathname: path.join(createdDirectory, "verified.apk"),
      requireCanonical: false,
    };
    const directory = await filesystem.realpath(createdDirectory);
    let directoryIdentity = await filesystem.lstat(directory);
    if (
      !directoryIdentity.isDirectory()
      || directoryIdentity.isSymbolicLink()
      || (directoryIdentity.mode & 0o777) !== PRIVATE_SNAPSHOT_DIRECTORY_MODE
    ) throw new AndroidApkGateError("Private APK snapshot directory creation failed");
    await filesystem.chmod(directory, PRIVATE_SNAPSHOT_DIRECTORY_MODE);
    const pathname = path.join(directory, "verified.apk");
    snapshot = {
      directory,
      directoryIdentity,
      pathname,
      requireCanonical: true,
    };
    let output;
    try {
      output = await filesystem.open(
        pathname,
        fsConstants.O_WRONLY
          | fsConstants.O_CREAT
          | fsConstants.O_EXCL
          | fsConstants.O_NOFOLLOW,
        0o600,
      );
      await output.writeFile(sourceBytes);
      await output.sync();
      await output.chmod(PRIVATE_SNAPSHOT_FILE_MODE);
      const fileIdentity = await output.stat();
      directoryIdentity = await filesystem.lstat(directory);
      snapshot = {
        directory,
        directoryIdentity,
        fileIdentity,
        pathname,
        requireCanonical: true,
      };
    } finally {
      try { await output?.close(); } catch { /* verification below fails closed */ }
    }
    await inspectPrivateSnapshot(filesystem, snapshot, options.expectedSha256);
    creationComplete = true;
    const consume = async (consumer) => {
      if (typeof consumer !== "function") {
        throw new AndroidApkGateError("Private APK snapshot consumer is invalid");
      }
      await inspectPrivateSnapshot(filesystem, snapshot, options.expectedSha256);
      let value;
      let consumerError;
      try {
        value = await consumer(snapshot.pathname);
      } catch (error) {
        consumerError = error;
      }
      try {
        await inspectPrivateSnapshot(filesystem, snapshot, options.expectedSha256);
      } catch (verificationError) {
        throw new AndroidApkGateError("Private APK snapshot verification failed");
      }
      if (consumerError) {
        throw new AndroidApkGateError("Private APK snapshot consumer failed");
      }
      return value;
    };
    const consumeFileDescriptor = async (consumer) => {
      if (typeof consumer !== "function") {
        throw new AndroidApkGateError("Private APK descriptor consumer is invalid");
      }
      await inspectPrivateSnapshot(filesystem, snapshot, options.expectedSha256);
      let handle;
      let value;
      let consumerError;
      try {
        handle = await filesystem.open(
          snapshot.pathname,
          fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
        );
        const details = await handle.stat();
        if (
          !details.isFile()
          || !stableFileIdentity(snapshot.fileIdentity, details)
          || !Number.isSafeInteger(handle.fd)
          || handle.fd < 0
        ) throw new Error("untrusted snapshot descriptor");
        if (await sha256PositionedFile(handle, details.size) !== options.expectedSha256) {
          throw new Error("snapshot descriptor digest mismatch");
        }
        const detailsAfterDigest = await handle.stat();
        if (!detailsAfterDigest.isFile() || !stableFileIdentity(details, detailsAfterDigest)) {
          throw new Error("snapshot descriptor changed during verification");
        }
        value = await consumer(handle.fd, details.size);
      } catch (error) {
        consumerError = error;
      } finally {
        try { await handle?.close(); } catch { /* static consumer failure remains authoritative */ }
      }
      try {
        await inspectPrivateSnapshot(filesystem, snapshot, options.expectedSha256);
      } catch {
        throw new AndroidApkGateError("Private APK snapshot verification failed");
      }
      if (consumerError) {
        throw new AndroidApkGateError("Private APK snapshot consumer failed");
      }
      return value;
    };
    result = await options.useSnapshot(consume, consumeFileDescriptor);
    if (containsPrivateSnapshotPath(result, snapshot)) {
      throw new AndroidApkGateError("Private APK snapshot result is not portable");
    }
  } catch (error) {
    primaryError = creationComplete
      ? error
      : new AndroidApkGateError("Private APK snapshot creation failed");
  }

  try {
    await verifyStableRegularFile(filesystem, source, "APK");
  } catch (sourceError) {
    primaryError = sourceError;
  } finally {
    try { await source.handle.close(); } catch { /* static validation remains authoritative */ }
  }

  if (snapshot) {
    try {
      await cleanupPrivateSnapshot(filesystem, snapshot);
    } catch (cleanupError) {
      const failure = new AndroidApkGateError("Private APK snapshot cleanup failed");
      if (primaryError) {
        throw new AggregateError([primaryError, failure], failure.message);
      }
      throw failure;
    }
  }
  if (primaryError) throw primaryError;
  return result;
}

export async function runBoundedCommand(executable, args, options = {}) {
  if (
    typeof executable !== "string"
    || executable.length === 0
    || executable.length > 4_096
    || /[\u0000-\u001f\u007f]/u.test(executable)
    || !Array.isArray(args)
  ) {
    throw new AndroidApkGateError("commands require an executable and an argument array");
  }
  if (
    args.length > 128
    || args.some((argument) => (
      typeof argument !== "string"
      || argument.length > 4_096
      || /[\u0000-\u001f\u007f]/u.test(argument)
    ))
  ) throw new AndroidApkGateError("commands require bounded argument strings");
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_COMMAND_MAX_BYTES;
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0) {
    throw new AndroidApkGateError("maxOutputBytes must be a positive safe integer");
  }
  const timeoutMilliseconds = options.timeoutMilliseconds ?? 30_000;
  if (
    !Number.isSafeInteger(timeoutMilliseconds)
    || timeoutMilliseconds < 1
    || timeoutMilliseconds > 300_000
  ) throw new AndroidApkGateError("timeoutMilliseconds must be bounded");
  const environment = {};
  const authoredEnvironment = options.env ?? process.env;
  for (const name of TOOL_ENVIRONMENT_FIELDS) {
    if (typeof authoredEnvironment?.[name] === "string") {
      environment[name] = authoredEnvironment[name];
    }
  }
  try {
    const { stdout, stderr } = await execFileAsync(executable, args, {
      cwd: options.cwd,
      env: environment,
      encoding: "utf8",
      killSignal: "SIGTERM",
      maxBuffer: maxOutputBytes,
      signal: options.signal,
      timeout: timeoutMilliseconds,
      windowsHide: true,
    });
    return { stdout, stderr };
  } catch (error) {
    if (
      error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
      || /maxBuffer length exceeded/u.test(error?.message ?? "")
    ) {
      throw new AndroidApkGateError(
        `command output exceeds ${maxOutputBytes} bytes`,
      );
    }
    if (error?.killed || error?.code === "ABORT_ERR" || error?.signal === "SIGTERM") {
      throw new AndroidApkGateError(`${path.basename(executable)} timed out or was cancelled`);
    }
    throw new AndroidApkGateError(
      `${path.basename(executable)} failed`,
    );
  }
}

function outputText(result) {
  const stdout = typeof result?.stdout === "string" ? result.stdout.trim() : "";
  return stdout;
}

function validateRepoReference(reference, label) {
  if (typeof reference !== "string" || !reference.startsWith("repo:")) {
    throw new AndroidApkGateError(`${label} must be a canonical repo: reference`);
  }
  const relativePath = reference.slice("repo:".length);
  const segments = relativePath.split("/");
  if (
    relativePath === ""
    || relativePath.startsWith("/")
    || relativePath.includes("\\")
    || relativePath.includes(":")
    || path.posix.isAbsolute(relativePath)
    || path.posix.normalize(relativePath) !== relativePath
    || segments.some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new AndroidApkGateError(`${label} must be a canonical repo: reference`);
  }
  return { ref: reference, relativePath, segments };
}

async function resolveRepoFile(repositoryRoot, reference, label, filesystem) {
  const parsed = validateRepoReference(reference, label);
  const resolvedPath = path.resolve(repositoryRoot, ...parsed.segments);
  if (!resolvedPath.startsWith(`${repositoryRoot}${path.sep}`)) {
    throw new AndroidApkGateError(`${label} must be a canonical repo: reference`);
  }
  let canonicalPath;
  try {
    canonicalPath = await filesystem.realpath(resolvedPath);
  } catch (error) {
    throw new AndroidApkGateError(`${label} does not exist: ${parsed.ref}`, { cause: error });
  }
  if (canonicalPath !== resolvedPath) {
    throw new AndroidApkGateError(`${label} must name the exact file without symlinks`);
  }
  const details = await filesystem.stat(resolvedPath);
  if (!details.isFile()) {
    throw new AndroidApkGateError(`${label} must name a regular file`);
  }
  return { ...parsed, absolutePath: resolvedPath };
}

function validateExpectedIdentity({
  expectedApplicationId,
  expectedVersionName,
  expectedVersionCode,
}) {
  if (!isBoundedApplicationId(expectedApplicationId)) {
    throw new AndroidApkGateError(
      "expectedApplicationId must be a bounded Android application ID",
    );
  }
  const versionName = expectedVersionName === undefined ? undefined : expectedVersionName;
  const versionCode = expectedVersionCode === undefined
    ? undefined
    : String(expectedVersionCode);
  if (versionName !== undefined && (
    typeof versionName !== "string" || versionName.trim() === ""
  )) {
    throw new AndroidApkGateError("expectedVersionName must be a nonempty string");
  }
  if (versionCode !== undefined && !/^[1-9][0-9]*$/.test(versionCode)) {
    throw new AndroidApkGateError("expectedVersionCode must be a positive integer");
  }
  return { applicationId: expectedApplicationId, versionName, versionCode };
}

function isBoundedApplicationId(value) {
  return typeof value === "string"
    && value.length >= 3
    && value.length <= 200
    && ANDROID_APPLICATION_ID_PATTERN.test(value);
}

function validateApkanalyzerIdentity(value) {
  if (
    value === null
    || typeof value !== "object"
    || Array.isArray(value)
    || typeof value.identity !== "string"
    || !APKANALYZER_IDENTITY_PATTERN.test(value.identity)
    || typeof value.version !== "string"
    || value.version.length > 100
    || !CMDLINE_TOOLS_VERSION_PATTERN.test(value.version)
  ) {
    throw new AndroidApkGateError(
      "apkanalyzerIdentity must contain a bounded cmdline-tools identity and version",
    );
  }
  return { identity: value.identity, version: value.version };
}

function parseXmlAttributes(source) {
  const attributes = new Map();
  let index = 0;
  while (index < source.length) {
    while (/\s/u.test(source[index] ?? "")) index += 1;
    if (index === source.length) break;
    if (source[index] === "/") {
      index += 1;
      while (/\s/u.test(source[index] ?? "")) index += 1;
      if (index === source.length) break;
      throw new AndroidApkGateError("manifest print contains malformed meta-data");
    }
    const name = source.slice(index).match(/^[A-Za-z_:][A-Za-z0-9_.:-]*/u)?.[0];
    if (!name || attributes.has(name)) {
      throw new AndroidApkGateError("manifest print contains malformed meta-data");
    }
    index += name.length;
    while (/\s/u.test(source[index] ?? "")) index += 1;
    if (source[index] !== "=") {
      throw new AndroidApkGateError("manifest print contains malformed meta-data");
    }
    index += 1;
    while (/\s/u.test(source[index] ?? "")) index += 1;
    const quote = source[index];
    if (quote !== '"' && quote !== "'") {
      throw new AndroidApkGateError("manifest print contains malformed meta-data");
    }
    const valueStart = index + 1;
    const valueEnd = source.indexOf(quote, valueStart);
    if (valueEnd < 0) {
      throw new AndroidApkGateError("manifest print contains malformed meta-data");
    }
    attributes.set(name, source.slice(valueStart, valueEnd));
    index = valueEnd + 1;
  }
  return attributes;
}

function manifestMetaData(xml) {
  const tags = [];
  let cursor = 0;
  while (cursor < xml.length) {
    const start = xml.indexOf("<", cursor);
    if (start < 0) break;
    if (xml.startsWith("<!--", start)) {
      const end = xml.indexOf("-->", start + 4);
      if (end < 0) throw new AndroidApkGateError("manifest print contains malformed XML");
      cursor = end + 3;
      continue;
    }
    if (xml.startsWith("<![CDATA[", start)) {
      const end = xml.indexOf("]]>", start + 9);
      if (end < 0) throw new AndroidApkGateError("manifest print contains malformed XML");
      cursor = end + 3;
      continue;
    }
    if (xml.startsWith("<?", start)) {
      const end = xml.indexOf("?>", start + 2);
      if (end < 0) throw new AndroidApkGateError("manifest print contains malformed XML");
      cursor = end + 2;
      continue;
    }
    if (xml.startsWith("<!", start)) {
      throw new AndroidApkGateError("manifest print contains an unsupported XML declaration");
    }
    let quote;
    let end = -1;
    for (let index = start + 1; index < xml.length; index += 1) {
      const character = xml[index];
      if (quote) {
        if (character === quote) quote = undefined;
      } else if (character === '"' || character === "'") {
        quote = character;
      } else if (character === ">") {
        end = index;
        break;
      }
    }
    if (end < 0) {
      throw new AndroidApkGateError("manifest print contains malformed XML");
    }
    const tag = xml.slice(start + 1, end).trim();
    if (!tag.startsWith("/")) {
      const name = tag.match(/^[A-Za-z_:][A-Za-z0-9_.:-]*/u)?.[0];
      if (!name) throw new AndroidApkGateError("manifest print contains malformed XML");
      if (name === "meta-data") {
        tags.push(parseXmlAttributes(tag.slice(name.length)));
      }
    }
    cursor = end + 1;
  }
  return tags;
}

function verifyEmbeddedSourceIdentity(result, expectedSource) {
  if (typeof result?.stdout !== "string") {
    throw new AndroidApkGateError("manifest print output is not text");
  }
  if (Buffer.byteLength(result.stdout, "utf8") > MANIFEST_PRINT_MAX_BYTES) {
    throw new AndroidApkGateError(
      `manifest print output exceeds ${MANIFEST_PRINT_MAX_BYTES} bytes`,
    );
  }
  const metadata = manifestMetaData(result.stdout);
  const sourceCommit = metadata.filter(
    (attributes) => attributes.get("android:name") === SOURCE_COMMIT_METADATA_NAME,
  );
  if (sourceCommit.length === 0) {
    throw new AndroidApkGateError("embedded source commit metadata is absent");
  }
  if (sourceCommit.length !== 1) {
    throw new AndroidApkGateError("embedded source commit metadata is duplicated");
  }
  const embeddedCommit = sourceCommit[0].get("android:value");
  if (!GIT_OBJECT_ID_PATTERN.test(embeddedCommit ?? "")) {
    throw new AndroidApkGateError("embedded source commit metadata is malformed");
  }
  if (embeddedCommit !== expectedSource.commit) {
    throw new AndroidApkGateError(
      `embedded source commit mismatch: expected ${expectedSource.commit}, got ${embeddedCommit}`,
    );
  }

  const sourceTree = metadata.filter(
    (attributes) => attributes.get("android:name") === SOURCE_TREE_METADATA_NAME,
  );
  if (sourceTree.length === 0) {
    throw new AndroidApkGateError("embedded source tree metadata is absent");
  }
  if (sourceTree.length !== 1) {
    throw new AndroidApkGateError("embedded source tree metadata is duplicated");
  }
  const embeddedTree = sourceTree[0].get("android:value");
  if (!GIT_OBJECT_ID_PATTERN.test(embeddedTree ?? "")) {
    throw new AndroidApkGateError("embedded source tree metadata is malformed");
  }
  if (embeddedTree !== expectedSource.tree) {
    throw new AndroidApkGateError("embedded source tree mismatch");
  }

  const schemaVersion = metadata.filter(
    (attributes) => attributes.get("android:name") === LOCK_SCHEMA_METADATA_NAME,
  );
  if (schemaVersion.length === 0) {
    throw new AndroidApkGateError("embedded APK lock schema version is absent");
  }
  if (schemaVersion.length !== 1) {
    throw new AndroidApkGateError("embedded APK lock schema version is duplicated");
  }
  if (schemaVersion[0].get("android:value") !== String(ANDROID_APK_LOCK_SCHEMA_VERSION)) {
    throw new AndroidApkGateError("embedded APK lock schema version mismatch");
  }
  return { commit: embeddedCommit, tree: embeddedTree };
}

function parseLock(data) {
  let lock;
  try {
    lock = JSON.parse(data.toString("utf8"));
  } catch (error) {
    throw new AndroidApkGateError("APK lock is not valid JSON", { cause: error });
  }
  if (
    lock?.schemaVersion !== ANDROID_APK_LOCK_SCHEMA_VERSION
    || JSON.stringify(Object.keys(lock ?? {}).sort()) !== JSON.stringify([
      "apk", "apkanalyzer", "schemaVersion", "source",
    ])
    || typeof lock?.source?.commit !== "string"
    || !GIT_OBJECT_ID_PATTERN.test(lock.source.commit)
    || typeof lock?.source?.tree !== "string"
    || !GIT_OBJECT_ID_PATTERN.test(lock.source.tree)
    || typeof lock?.source?.path !== "string"
    || JSON.stringify(Object.keys(lock.source).sort()) !== JSON.stringify(["commit", "path", "tree"])
    || typeof lock?.apk?.ref !== "string"
    || typeof lock?.apk?.sha256 !== "string"
    || !/^[0-9a-f]{64}$/.test(lock.apk.sha256)
    || !isBoundedApplicationId(lock?.apk?.applicationId)
    || typeof lock?.apk?.versionName !== "string"
    || typeof lock?.apk?.versionCode !== "string"
    || !/^[1-9][0-9]*$/.test(lock.apk.versionCode)
    || JSON.stringify(Object.keys(lock.apk).sort()) !== JSON.stringify([
      "applicationId", "ref", "sha256", "versionCode", "versionName",
    ])
    || typeof lock?.apkanalyzer?.identity !== "string"
    || !APKANALYZER_IDENTITY_PATTERN.test(lock.apkanalyzer.identity)
    || typeof lock?.apkanalyzer?.version !== "string"
    || !CMDLINE_TOOLS_VERSION_PATTERN.test(lock.apkanalyzer.version)
    || JSON.stringify(Object.keys(lock.apkanalyzer).sort()) !== JSON.stringify([
      "identity", "version",
    ])
  ) {
    throw new AndroidApkGateError("APK lock has an invalid schema");
  }
  validateRepoReference(lock.apk.ref, "lock APK ref");
  return lock;
}

async function gitOutput(runCommand, repositoryRoot, args) {
  return outputText(await runCommand(
    "git",
    ["-C", repositoryRoot, ...args],
    { cwd: repositoryRoot },
  ));
}

async function resolveRepositoryRoot(repoRoot, filesystem, runCommand) {
  if (typeof repoRoot !== "string" || repoRoot.trim() === "") {
    throw new AndroidApkGateError("repoRoot is required");
  }
  const requestedRoot = path.resolve(repoRoot);
  const canonicalRoot = await filesystem.realpath(requestedRoot);
  if (canonicalRoot !== requestedRoot) {
    throw new AndroidApkGateError("repoRoot must name the canonical worktree root");
  }
  const reportedRoot = await gitOutput(runCommand, canonicalRoot, ["rev-parse", "--show-toplevel"]);
  const canonicalReportedRoot = await filesystem.realpath(path.resolve(reportedRoot));
  if (canonicalReportedRoot !== canonicalRoot) {
    throw new AndroidApkGateError(`repoRoot must be the worktree root: ${canonicalReportedRoot}`);
  }
  return canonicalRoot;
}

async function requireCleanSource(runCommand, repositoryRoot) {
  const status = await gitOutput(runCommand, repositoryRoot, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ]);
  if (status !== "") {
    throw new AndroidApkGateError(`source worktree is dirty: ${status.split("\n", 1)[0]}`);
  }
}

async function resolveApkanalyzer(apkanalyzerPath, expectedIdentity, filesystem) {
  if (typeof apkanalyzerPath !== "string" || apkanalyzerPath.trim() === "") {
    throw new AndroidApkGateError("apkanalyzerPath is required");
  }
  const canonicalPath = await filesystem.realpath(path.resolve(apkanalyzerPath));
  const details = await filesystem.stat(canonicalPath);
  if (!details.isFile()) {
    throw new AndroidApkGateError("apkanalyzerPath must name a regular file");
  }
  const identity = path.basename(canonicalPath);
  if (identity !== expectedIdentity.identity) {
    throw new AndroidApkGateError(
      `apkanalyzerIdentity does not match canonical executable ${identity}`,
    );
  }
  return { absolutePath: canonicalPath, ...expectedIdentity };
}

function freezeResult(apk) {
  Object.freeze(apk.lock);
  Object.freeze(apk.source);
  Object.freeze(apk.apkanalyzer);
  Object.freeze(apk);
  const android = Object.freeze({ apk });
  const capture = Object.freeze({ android });
  return Object.freeze({ capture });
}

export async function verifyAndroidApkGate(options = {}) {
  const filesystem = options.filesystem ?? defaultFilesystem;
  const runCommand = options.runCommand ?? runBoundedCommand;
  const apkReference = validateRepoReference(options.apk, "apk");
  const lockReference = validateRepoReference(options.apkLock, "apkLock");
  const expected = validateExpectedIdentity(options);
  const expectedApkanalyzer = validateApkanalyzerIdentity(options.apkanalyzerIdentity);
  const repositoryRoot = await resolveRepositoryRoot(options.repoRoot, filesystem, runCommand);
  const commitBefore = await gitOutput(runCommand, repositoryRoot, [
    "rev-parse",
    "--verify",
    "HEAD",
  ]);
  const treeBefore = await gitOutput(runCommand, repositoryRoot, [
    "rev-parse",
    "--verify",
    "HEAD^{tree}",
  ]);
  if (!GIT_OBJECT_ID_PATTERN.test(commitBefore) || !GIT_OBJECT_ID_PATTERN.test(treeBefore)) {
    throw new AndroidApkGateError("source commit or tree identity is malformed");
  }
  await requireCleanSource(runCommand, repositoryRoot);

  const apkFile = await resolveRepoFile(repositoryRoot, apkReference.ref, "apk", filesystem);
  const lockFile = await resolveRepoFile(
    repositoryRoot,
    lockReference.ref,
    "apkLock",
    filesystem,
  );
  const lockData = await readStableRegularFile(
    filesystem,
    lockFile.absolutePath,
    "APK lock",
    DEFAULT_COMMAND_MAX_BYTES,
  );
  const lock = parseLock(lockData);
  const lockSha256 = sha256(lockData);

  if (lock.source.commit !== commitBefore) {
    throw new AndroidApkGateError(
      `lock source commit mismatch: expected ${commitBefore}, got ${lock.source.commit}`,
    );
  }
  if (lock.source.tree !== treeBefore) {
    throw new AndroidApkGateError("lock source tree mismatch");
  }
  if (lock.source.path !== MOBILE_SOURCE_PATH) {
    throw new AndroidApkGateError("lock source path mismatch");
  }
  if (lock.apk.ref !== apkReference.ref) {
    throw new AndroidApkGateError(
      `lock APK ref mismatch: expected ${apkReference.ref}, got ${lock.apk.ref}`,
    );
  }
  const apkSha256 = lock.apk.sha256;

  const apkanalyzer = await resolveApkanalyzer(
    options.apkanalyzerPath,
    expectedApkanalyzer,
    filesystem,
  );
  const analyzed = await withPrivateAndroidApkSnapshot({
    filesystem,
    sourcePath: apkFile.absolutePath,
    expectedSha256: apkSha256,
    useSnapshot: async (consume) => {
      const analyze = async (field) => outputText(await consume((snapshotPath) => runCommand(
        apkanalyzer.absolutePath,
        ["manifest", field, snapshotPath],
        { cwd: repositoryRoot },
      )));
      const applicationId = await analyze("application-id");
      const versionName = await analyze("version-name");
      const versionCode = await analyze("version-code");
      const manifest = await consume((snapshotPath) => runCommand(
        apkanalyzer.absolutePath,
        ["manifest", "print", snapshotPath],
        { cwd: repositoryRoot, maxOutputBytes: MANIFEST_PRINT_MAX_BYTES },
      ));
      return { applicationId, manifest, versionCode, versionName };
    },
  });
  const { applicationId, versionName, versionCode } = analyzed;

  if (applicationId !== expected.applicationId) {
    throw new AndroidApkGateError("application ID mismatch");
  }
  const requiredVersionName = expected.versionName ?? lock.apk.versionName;
  const requiredVersionCode = expected.versionCode ?? lock.apk.versionCode;
  if (versionName !== requiredVersionName) {
    throw new AndroidApkGateError("versionName mismatch");
  }
  if (versionCode !== requiredVersionCode) {
    throw new AndroidApkGateError("versionCode mismatch");
  }
  if (lock.apk.applicationId !== applicationId) {
    throw new AndroidApkGateError("lock application ID mismatch");
  }
  if (lock.apk.versionName !== versionName) {
    throw new AndroidApkGateError("lock versionName mismatch");
  }
  if (lock.apk.versionCode !== versionCode) {
    throw new AndroidApkGateError("lock versionCode mismatch");
  }
  if (lock.apkanalyzer.identity !== apkanalyzer.identity) {
    throw new AndroidApkGateError("lock apkanalyzer identity mismatch");
  }
  if (lock.apkanalyzer.version !== apkanalyzer.version) {
    throw new AndroidApkGateError("lock apkanalyzer version mismatch");
  }
  verifyEmbeddedSourceIdentity(analyzed.manifest, {
    commit: commitBefore,
    tree: treeBefore,
  });

  const finalLockData = await readStableRegularFile(
    filesystem,
    lockFile.absolutePath,
    "APK lock",
    DEFAULT_COMMAND_MAX_BYTES,
  );
  if (sha256(finalLockData) !== lockSha256) {
    throw new AndroidApkGateError("APK lock changed during verification");
  }
  const commitAfter = await gitOutput(runCommand, repositoryRoot, [
    "rev-parse",
    "--verify",
    "HEAD",
  ]);
  const treeAfter = await gitOutput(runCommand, repositoryRoot, [
    "rev-parse",
    "--verify",
    "HEAD^{tree}",
  ]);
  if (commitAfter !== commitBefore) {
    throw new AndroidApkGateError(
      `HEAD changed during APK verification: ${commitBefore} -> ${commitAfter}`,
    );
  }
  if (treeAfter !== treeBefore) {
    throw new AndroidApkGateError(
      `HEAD tree changed during APK verification: ${treeBefore} -> ${treeAfter}`,
    );
  }
  await requireCleanSource(runCommand, repositoryRoot);

  return freezeResult({
    ref: apkReference.ref,
    sha256: apkSha256,
    lock: { ref: lockReference.ref, sha256: lockSha256 },
    applicationId,
    versionName,
    versionCode,
    source: { commit: commitBefore, tree: treeBefore, path: MOBILE_SOURCE_PATH },
    apkanalyzer: { identity: apkanalyzer.identity, version: apkanalyzer.version },
  });
}
