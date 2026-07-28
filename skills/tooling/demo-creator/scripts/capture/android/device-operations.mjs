import { createHash } from "node:crypto";
import { spawn as defaultSpawn } from "node:child_process";
import * as defaultFs from "node:fs/promises";
import path from "node:path";

import { withPrivateAndroidApkSnapshot } from "./apk-gate.mjs";
import { isAndroidLaunchActivity } from "../../core/android-contract.mjs";

const AVD_OWNERSHIP_VERSION = 1;
const AVD_TOOL_NAMESPACE = "acp.demo-creator.android-avd";
const BASE_OWNERSHIP_FIELDS = Object.freeze([
  "version",
  "toolNamespace",
  "scenarioId",
  "runId",
  "nonce",
  "avdName",
  "avdPath",
  "systemImage",
  "markerPath",
]);
const MARKER_FIELDS = Object.freeze(BASE_OWNERSHIP_FIELDS.filter((field) => field !== "markerPath"));
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
const SYSTEM_IMAGE_PATTERN = /^system-images;[A-Za-z0-9._-]{1,64};[A-Za-z0-9._-]{1,64};[A-Za-z0-9._-]{1,64}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const EMULATOR_SERIAL_PATTERN = /^emulator-([1-9][0-9]{0,4})$/u;
const APPLICATION_ID_PATTERN = /^(?=.{3,200}$)[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/u;
const PACKAGE_OUTPUT_MAX_BYTES = 512 * 1024;
const UI_DUMP_MAX_BYTES = 2 * 1024 * 1024;
const POINTER_SETTING_OUTPUT_MAX_BYTES = 64 * 1024;
const POINTER_SETTING_TIMEOUT_MILLISECONDS = 10_000;
const MAX_APK_STDIN_BYTES = 512 * 1024 * 1024;
const APK_INSTALL_TIMEOUT_MILLISECONDS = 120_000;
const COMMAND_TERMINATION_GRACE_MILLISECONDS = 1_000;
const COMMAND_LIFECYCLE_STATE = Symbol("androidCommandLifecycleState");
const COMMAND_EXITED = "exited";
const COMMAND_NEVER_STARTED = "never-started";
const DISPLAY_PROOF_OUTPUT_MAX_BYTES = 256 * 1024;
const DISPLAY_PROOF_TIMEOUT_MILLISECONDS = 10_000;
const REVERSE_OUTPUT_MAX_BYTES = 64 * 1024;
const REVERSE_TIMEOUT_MILLISECONDS = 10_000;
const POINTER_OVERLAY_SETTINGS = Object.freeze([
  "show_touches",
  "pointer_location",
]);
const PRIVATE_INPUT_SCRIPT = [
  "IFS= read -r value || [ -n \"$value\" ]",
  "input text \"$value\"",
].join("\n");
const APPROVED_SECRET_ENVIRONMENTS = new Set([
  "ACP_URL",
  "ACP_PROJECT",
  "ACP_BEARER_TOKEN",
]);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertExactKeys(value, expected, label) {
  if (!isObject(value)) throw new Error(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} must contain only ${wanted.join(", ")}`);
  }
}

function requiredString(value, label, maximumLength = 512) {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > maximumLength
    || value.trim() !== value
    || value.includes("\0")
  ) {
    throw new Error(`${label} must be a bounded non-empty string`);
  }
  return value;
}

function slug(value, maximumLength) {
  return value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maximumLength)
    .replace(/-+$/g, "") || "id";
}

function generatedAvdName({ scenarioId, runId, nonce }) {
  const digest = createHash("sha256")
    .update(JSON.stringify([scenarioId, runId, nonce]))
    .digest("hex")
    .slice(0, 12);
  return [
    "acp-demo",
    slug(scenarioId, 12),
    slug(runId, 12),
    slug(nonce, 8),
    digest,
  ].join("-");
}

function isWithin(parentPath, candidatePath) {
  const relative = path.relative(parentPath, candidatePath);
  return relative === "" || (
    relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

async function canonicalDirectory(fs, pathname, label) {
  const authored = requiredString(pathname, label);
  const resolved = path.resolve(authored);
  if (authored !== resolved) throw new Error(`${label} must be canonical and absolute`);
  const canonical = await fs.realpath(resolved);
  if (canonical !== resolved || path.resolve(canonical) !== canonical) {
    throw new Error(`${label} must not use symlink aliases`);
  }
  const stat = await fs.lstat(canonical);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a regular directory`);
  }
  return canonical;
}

async function pathExists(fs, pathname) {
  try {
    await fs.lstat(pathname);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function sameFlatObject(actual, expected) {
  if (!isObject(actual)) return false;
  const actualKeys = Object.keys(actual).sort();
  const expectedKeys = Object.keys(expected).sort();
  return actualKeys.length === expectedKeys.length
    && actualKeys.every((key, index) => key === expectedKeys[index])
    && expectedKeys.every((key) => actual[key] === expected[key]);
}

function exactFileIdentity(details, label) {
  if (
    !Number.isSafeInteger(details?.dev)
    || details.dev < 0
    || !Number.isSafeInteger(details?.ino)
    || details.ino < 1
    || !Number.isFinite(details?.ctimeMs)
  ) throw new Error(`${label} file identity is unavailable`);
  return `${details.dev}:${details.ino}:${details.ctimeMs}`;
}

function defineHiddenValue(target, property, value) {
  if ((typeof target !== "object" && typeof target !== "function") || target === null) return;
  Object.defineProperty(target, property, {
    value,
    enumerable: false,
    writable: false,
    configurable: false,
  });
}

function markCommandLifecycle(target, state) {
  defineHiddenValue(target, COMMAND_LIFECYCLE_STATE, state);
  return target;
}

function commandLifecycleState(target) {
  return target?.[COMMAND_LIFECYCLE_STATE];
}

function markAvdCreationCleanupBlocked(error) {
  const failure = error instanceof Error && Object.isExtensible(error)
    ? error
    : new Error("Android AVD creation failed");
  if (!Object.hasOwn(failure, "avdCreationCleanupBlocked")) {
    defineHiddenValue(failure, "avdCreationCleanupBlocked", true);
  }
  return failure;
}

async function assertOwnedAvdEnvelope(fs, ownership) {
  assertExactKeys(ownership, BASE_OWNERSHIP_FIELDS, "AVD ownership");
  if (
    ownership.version !== AVD_OWNERSHIP_VERSION
    || ownership.toolNamespace !== AVD_TOOL_NAMESPACE
  ) {
    throw new Error("Refusing shared or foreign AVD ownership");
  }
  const scenarioId = requiredString(ownership.scenarioId, "ownership.scenarioId", 200);
  const runId = requiredString(ownership.runId, "ownership.runId", 200);
  const nonce = requiredString(ownership.nonce, "ownership.nonce", 200);
  const expectedName = generatedAvdName({ scenarioId, runId, nonce });
  if (ownership.avdName !== expectedName) {
    throw new Error("Refusing caller-authored AVD name");
  }
  if (!SYSTEM_IMAGE_PATTERN.test(ownership.systemImage)) {
    throw new Error("Owned AVD system image is invalid");
  }

  const avdPath = path.resolve(requiredString(ownership.avdPath, "ownership.avdPath"));
  const markerPath = path.resolve(requiredString(ownership.markerPath, "ownership.markerPath"));
  if (
    avdPath !== ownership.avdPath
    || path.basename(avdPath) !== `${expectedName}.avd`
    || markerPath !== ownership.markerPath
    || path.basename(markerPath) !== `${expectedName}.owner.json`
    || isWithin(avdPath, markerPath)
  ) {
    throw new Error("Refusing caller-authored AVD paths");
  }

  const markerStat = await fs.lstat(markerPath);
  if (
    !markerStat.isFile()
    || markerStat.isSymbolicLink()
    || (markerStat.mode & 0o777) !== 0o600
  ) {
    throw new Error("Owned AVD marker must be a private regular file");
  }
  let marker;
  try {
    marker = JSON.parse(await fs.readFile(markerPath, "utf8"));
  } catch {
    throw new Error("Owned AVD marker is unreadable");
  }
  const expectedMarker = Object.fromEntries(MARKER_FIELDS.map((field) => [field, ownership[field]]));
  if (!sameFlatObject(marker, expectedMarker)) {
    throw new Error("Owned AVD marker does not match the requested AVD");
  }

  return {
    avdPath,
    avdRoot: path.dirname(avdPath),
    markerFileIdentity: exactFileIdentity(markerStat, "Owned AVD marker"),
  };
}

async function exactGeneratedArtifactSnapshot(fs, ownership, avdRoot) {
  const definitionPath = path.join(avdRoot, `${ownership.avdName}.ini`);
  const artifacts = [];
  for (const [kind, pathname] of [
    ["directory", ownership.avdPath],
    ["definition", definitionPath],
  ]) {
    let details;
    try {
      details = await fs.lstat(pathname);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    const expectedType = kind === "directory" ? details.isDirectory() : details.isFile();
    if (!expectedType || details.isSymbolicLink()) {
      throw new Error(`Generated AVD ${kind} is ambiguous during failed creation cleanup`);
    }
    if (await fs.realpath(pathname) !== pathname) {
      throw new Error(`Generated AVD ${kind} changed canonical path during failed creation cleanup`);
    }
    artifacts.push(Object.freeze({
      kind,
      pathname,
      fileIdentity: exactFileIdentity(details, `Generated AVD ${kind}`),
    }));
  }
  return Object.freeze(artifacts);
}

function sameArtifactSnapshot(actual, expected) {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

async function assertExactGeneratedArtifactsAbsent(fs, ownership, avdRoot) {
  const present = await exactGeneratedArtifactSnapshot(fs, ownership, avdRoot);
  if (present.length !== 0) {
    throw new Error("Generated AVD artifacts remain after failed creation cleanup");
  }
}

async function cleanupFailedOwnedAvdCreation(fs, ownership, context) {
  const captured = await exactGeneratedArtifactSnapshot(fs, ownership, context.avdRoot);
  const markerBeforeCleanup = await assertOwnedAvdEnvelope(fs, ownership);
  if (markerBeforeCleanup.markerFileIdentity !== context.markerFileIdentity) {
    throw new Error("Owned AVD marker identity changed during failed creation cleanup");
  }
  const immediatelyBeforeCleanup = await exactGeneratedArtifactSnapshot(
    fs,
    ownership,
    context.avdRoot,
  );
  if (!sameArtifactSnapshot(immediatelyBeforeCleanup, captured)) {
    throw new Error("Generated AVD artifact identity changed during failed creation cleanup");
  }
  for (const artifact of [...captured].reverse()) {
    if (artifact.kind === "directory") {
      await fs.rm(artifact.pathname, { recursive: true, force: false });
    } else {
      await fs.unlink(artifact.pathname);
    }
  }
  await assertExactGeneratedArtifactsAbsent(fs, ownership, context.avdRoot);
  const markerAfterCleanup = await assertOwnedAvdEnvelope(fs, ownership);
  if (markerAfterCleanup.markerFileIdentity !== context.markerFileIdentity) {
    throw new Error("Owned AVD marker identity changed after failed creation cleanup");
  }
}

function toolEnvironment(baseEnvironment, overrides) {
  const environment = {};
  for (const key of TOOL_ENVIRONMENT_FIELDS) {
    if (typeof baseEnvironment?.[key] === "string") environment[key] = baseEnvironment[key];
  }
  return { ...environment, ...overrides };
}

function exactEmulatorSerial(value) {
  const serial = requiredString(value, "serial", 32);
  const match = EMULATOR_SERIAL_PATTERN.exec(serial);
  const port = Number(match?.[1]);
  if (!match || !Number.isInteger(port) || port > 65535) {
    throw new Error("serial must name one exact emulator serial");
  }
  return serial;
}

function exactTcpPort(value, label) {
  if (!Number.isInteger(value) || value < 1024 || value > 65535) {
    throw new Error(`${label} must be an unprivileged TCP port`);
  }
  return value;
}

function exactDisplayDimension(value, label) {
  if (!Number.isInteger(value) || value < 1 || value > 16_384) {
    throw new Error(`${label} must be a bounded positive integer`);
  }
  return value;
}

function boundedDisplayProof(result, label) {
  if (
    typeof result?.stdout !== "string"
    || typeof result?.stderr !== "string"
    || Buffer.byteLength(result.stdout, "utf8") > DISPLAY_PROOF_OUTPUT_MAX_BYTES
    || result.stderr !== ""
  ) {
    throw new Error(`${label} is invalid`);
  }
  return result.stdout;
}

function parseDisplaySizeProof(result) {
  const stdout = boundedDisplayProof(result, "Android display-size proof");
  const match = /^Physical size: ([1-9][0-9]{0,4})x([1-9][0-9]{0,4})\r?\n(?:Override size: ([1-9][0-9]{0,4})x([1-9][0-9]{0,4})\r?\n)?$/u.exec(stdout);
  if (!match) throw new Error("Android display-size proof is invalid");
  const physical = Object.freeze({
    width: exactDisplayDimension(Number(match[1]), "physical display width"),
    height: exactDisplayDimension(Number(match[2]), "physical display height"),
  });
  const recording = match[3] === undefined
    ? physical
    : Object.freeze({
      width: exactDisplayDimension(Number(match[3]), "recording display width"),
      height: exactDisplayDimension(Number(match[4]), "recording display height"),
    });
  return { physical, recording };
}

function parseDisplayOrientationProof(result) {
  const stdout = boundedDisplayProof(result, "Android display-orientation proof");
  const matches = [...stdout.matchAll(/^[ \t]*SurfaceOrientation: ([0-3])\r?$/gmu)];
  if (matches.length !== 1) {
    throw new Error("Android display-orientation proof is invalid");
  }
  return Number(matches[0][1]);
}

function reverseMappings(output, serial) {
  if (typeof output !== "string" || Buffer.byteLength(output, "utf8") > REVERSE_OUTPUT_MAX_BYTES) {
    throw new Error("Android reverse proof must be bounded text");
  }
  return output.split(/\r?\n/u).filter(Boolean).map((line) => {
    const match = /^(emulator-[1-9][0-9]{0,4}) tcp:([1-9][0-9]{0,4}) tcp:([1-9][0-9]{0,4})$/u.exec(line);
    if (!match) throw new Error("Android reverse proof contains an invalid mapping");
    const mapping = {
      serial: exactEmulatorSerial(match[1]),
      devicePort: exactTcpPort(Number(match[2]), "reverse devicePort"),
      hostPort: exactTcpPort(Number(match[3]), "reverse hostPort"),
    };
    if (mapping.serial !== serial) {
      throw new Error("Android reverse proof contains a foreign emulator serial");
    }
    return mapping;
  });
}

function executable(value, label) {
  return requiredString(value, label, 4_096);
}

function canonicalRepoReference(value, label) {
  const ref = requiredString(value, label, 1_024);
  if (!ref.startsWith("repo:")) {
    throw new Error(`${label} must be a canonical repo: reference`);
  }
  const relative = ref.slice("repo:".length);
  if (
    relative.length === 0
    || relative.startsWith("/")
    || relative.includes("\\")
    || relative.includes(":")
    || relative.includes("//")
    || path.posix.normalize(relative) !== relative
    || relative.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error(`${label} must be a canonical repo: reference`);
  }
  return { ref, relative };
}

async function resolveRepoFile(fs, repoRootInput, refInput, label) {
  const repoRoot = await canonicalDirectory(fs, repoRootInput, "repoRoot");
  const { ref, relative } = canonicalRepoReference(refInput, label);
  const pathname = path.join(repoRoot, ...relative.split("/"));
  if (!isWithin(repoRoot, pathname) || pathname === repoRoot) {
    throw new Error(`${label} escaped repoRoot`);
  }
  return { ref, pathname, repoRoot };
}

function applicationId(value, label = "applicationId") {
  if (typeof value !== "string" || !APPLICATION_ID_PATTERN.test(value)) {
    throw new Error(`${label} must be a bounded Android application ID`);
  }
  return value;
}

function expectedVersionName(value) {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > 100
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) throw new Error("expectedVersionName must be bounded text");
  return value;
}

function expectedVersionCode(value) {
  const normalized = typeof value === "number" ? String(value) : value;
  if (typeof normalized !== "string" || !/^[1-9][0-9]{0,19}$/u.test(normalized)) {
    throw new Error("expectedVersionCode must be a bounded positive integer");
  }
  return normalized;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function oneLineValue(section, pattern, label) {
  const matches = [...section.matchAll(pattern)];
  if (matches.length !== 1) throw new Error(`installed package must contain exactly one ${label}`);
  return matches[0][1];
}

function parseInstalledPackage(stdout, expected) {
  if (typeof stdout !== "string") throw new Error("installed package output is not text");
  if (Buffer.byteLength(stdout, "utf8") > PACKAGE_OUTPUT_MAX_BYTES) {
    throw new Error(`installed package output exceeds ${PACKAGE_OUTPUT_MAX_BYTES} bytes`);
  }
  const escapedId = escapeRegExp(expected.applicationId);
  const headerPattern = new RegExp(
    `^\\s*Package \\[${escapedId}\\] \\([^\\r\\n]{1,128}\\):\\s*$`,
    "gmu",
  );
  const headers = [...stdout.matchAll(headerPattern)];
  if (headers.length !== 1) {
    throw new Error("installed package output must contain exactly one package record");
  }
  const sectionStart = headers[0].index + headers[0][0].length;
  const remainder = stdout.slice(sectionStart);
  const nextHeader = /^\s*Package \[[^\]\r\n]{1,200}\] \([^\r\n]{1,128}\):\s*$/mu.exec(remainder);
  const section = nextHeader ? remainder.slice(0, nextHeader.index) : remainder;
  const versionName = oneLineValue(
    section,
    /^\s*versionName=([^\r\n]{1,100})\s*$/gmu,
    "versionName",
  );
  const versionCode = oneLineValue(
    section,
    /^\s*versionCode=([1-9][0-9]{0,19})(?:\s+[^\r\n]{0,512})?\s*$/gmu,
    "versionCode",
  );
  if (versionName !== expected.versionName) throw new Error("installed versionName mismatch");
  if (versionCode !== expected.versionCode) throw new Error("installed versionCode mismatch");
  return {
    applicationId: expected.applicationId,
    versionName,
    versionCode,
  };
}

async function readPrivateRegularTextFile(fs, pathname, label, maximumBytes = 64 * 1024) {
  const stat = await fs.lstat(pathname);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a regular file without symlinks`);
  }
  const value = await fs.readFile(pathname, "utf8");
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > maximumBytes) {
    throw new Error(`${label} must be bounded text`);
  }
  return value;
}

function exactConfigValue(source, key, label) {
  const prefix = `${key}=`;
  const values = source
    .split(/\r?\n/u)
    .filter((line) => line.startsWith(prefix))
    .map((line) => line.slice(prefix.length));
  if (values.length !== 1 || values[0].length === 0) {
    throw new Error(`${label} must contain exactly one ${key}`);
  }
  return values[0];
}

function operationSignal(options, label) {
  if (options === undefined) return undefined;
  assertExactKeys(options, ["signal"], label);
  const { signal } = options;
  if (
    signal !== undefined
    && (
      typeof signal !== "object"
      || typeof signal.aborted !== "boolean"
      || typeof signal.addEventListener !== "function"
      || typeof signal.removeEventListener !== "function"
    )
  ) throw new Error(`${label}.signal must be an AbortSignal`);
  return signal;
}

function exactCoordinates(value, label) {
  if (!isObject(value)) throw new Error(`${label} must contain bounded coordinates`);
  for (const coordinate of ["x", "y"]) {
    if (
      !Number.isInteger(value[coordinate])
      || value[coordinate] < 0
      || value[coordinate] > 100_000
    ) throw new Error(`${label} must contain bounded coordinates`);
  }
  return { x: value.x, y: value.y };
}

async function verifyCreatedAvd(fs, ownership, avdRoot) {
  const canonicalAvdPath = await fs.realpath(ownership.avdPath);
  const avdStat = await fs.lstat(ownership.avdPath);
  if (
    canonicalAvdPath !== ownership.avdPath
    || !avdStat.isDirectory()
    || avdStat.isSymbolicLink()
  ) throw new Error("Created AVD path does not match the owned path");

  const definitionPath = path.join(avdRoot, `${ownership.avdName}.ini`);
  const definition = await readPrivateRegularTextFile(
    fs,
    definitionPath,
    "Created AVD definition",
  );
  if (exactConfigValue(definition, "path", "Created AVD definition") !== ownership.avdPath) {
    throw new Error("Created AVD definition path does not match ownership");
  }
  const imageParts = ownership.systemImage.split(";");
  if (exactConfigValue(definition, "target", "Created AVD definition") !== imageParts[1]) {
    throw new Error("Created AVD definition target does not match ownership");
  }

  const config = await readPrivateRegularTextFile(
    fs,
    path.join(ownership.avdPath, "config.ini"),
    "Created AVD config",
  );
  if (exactConfigValue(config, "AvdId", "Created AVD config") !== ownership.avdName) {
    throw new Error("Created AVD config name does not match ownership");
  }
  const expectedImageDirectory = `${imageParts.join("/")}/`;
  if (
    exactConfigValue(config, "image.sysdir.1", "Created AVD config")
    !== expectedImageDirectory
  ) throw new Error("Created AVD config system image does not match ownership");
}

function createBoundedRunner(spawnProcess, baseEnvironment, terminationGraceMilliseconds) {
  return async function runBoundedCommand(executablePath, commandArgs, options = {}) {
    const exactExecutable = executable(executablePath, "command executable");
    if (
      !Array.isArray(commandArgs)
      || commandArgs.length > 128
      || commandArgs.some((argument) => (
        typeof argument !== "string"
        || argument.length > 4_096
        || argument.includes("\0")
      ))
    ) throw new Error("Android command requires bounded argument strings");
    if (!isObject(options)) throw new Error("Android command options must be an object");
    const maximumOutputBytes = options.maxOutputBytes ?? 1024 * 1024;
    const timeoutMilliseconds = options.timeoutMilliseconds ?? 30_000;
    if (!Number.isInteger(maximumOutputBytes) || maximumOutputBytes < 1) {
      throw new Error("Android command output bound is invalid");
    }
    if (!Number.isInteger(timeoutMilliseconds) || timeoutMilliseconds < 1) {
      throw new Error("Android command timeout is invalid");
    }
    if (options.shell !== undefined && options.shell !== false) {
      throw new Error("Android commands cannot use a shell");
    }
    const signal = options.signal;
    if (signal?.aborted) throw new Error("Android command was cancelled");
    const inputFileDescriptor = options.inputFileDescriptor;
    const usesInputFileDescriptor = inputFileDescriptor !== undefined;
    let input = options.input ?? "";
    if (usesInputFileDescriptor) {
      if (
        !Number.isSafeInteger(inputFileDescriptor)
        || inputFileDescriptor < 0
        || options.input !== undefined
        || !Number.isSafeInteger(options.inputByteLength)
        || options.inputByteLength < 1
        || options.inputByteLength > MAX_APK_STDIN_BYTES
      ) throw new Error("Android command inherited stdin is invalid");
      input = undefined;
    } else if (
      !(typeof input === "string" || Buffer.isBuffer(input) || input instanceof Uint8Array)
      || Buffer.byteLength(input) > 1024 * 1024
    ) throw new Error("Android command stdin is invalid");

    return new Promise((resolve, reject) => {
      let child;
      try {
        child = spawnProcess(exactExecutable, [...commandArgs], {
          env: options.env ?? toolEnvironment(baseEnvironment, {}),
          shell: false,
          stdio: [usesInputFileDescriptor ? inputFileDescriptor : "pipe", "pipe", "pipe"],
        });
      } catch {
        reject(markCommandLifecycle(
          new Error("Android command failed to start"),
          COMMAND_NEVER_STARTED,
        ));
        return;
      }
      if (
        !isObject(child)
        || (!usesInputFileDescriptor && !isObject(child.stdin))
        || !isObject(child.stdout)
        || !isObject(child.stderr)
        || typeof child.once !== "function"
        || typeof child.stdout.on !== "function"
        || typeof child.stderr.on !== "function"
      ) {
        try { child?.kill?.("SIGTERM"); } catch { /* keep failure static */ }
        reject(new Error("Android command failed to start"));
        return;
      }

      const stdout = [];
      const stderr = [];
      let outputBytes = 0;
      let settled = false;
      let timer;
      let terminationTimer;
      let settlementTimer;
      let terminationError;
      const finish = (error, result, retainExitProofListeners = false) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(terminationTimer);
        clearTimeout(settlementTimer);
        signal?.removeEventListener?.("abort", onAbort);
        if (!retainExitProofListeners) {
          child.removeListener?.("error", onError);
          child.removeListener?.("close", onClose);
        }
        if (error) reject(error);
        else resolve(result);
      };
      const stop = (error) => {
        if (settled || terminationError) return;
        terminationError = error;
        clearTimeout(timer);
        try { child.stdin?.destroy?.(); } catch { /* keep failure static */ }
        try { child.kill?.("SIGTERM"); } catch { /* keep failure static */ }
        terminationTimer = setTimeout(() => {
          if (settled) return;
          try { child.kill?.("SIGKILL"); } catch { /* close remains the proof of exit */ }
          if (settled) return;
          settlementTimer = setTimeout(() => {
            if (settled) return;
            finish(
              new Error("Android command cleanup could not prove child exit"),
              undefined,
              true,
            );
          }, terminationGraceMilliseconds);
        }, terminationGraceMilliseconds);
      };
      const collect = (target) => (chunk) => {
        if (settled || terminationError) return;
        const bytes = Buffer.from(chunk);
        outputBytes += bytes.length;
        if (outputBytes > maximumOutputBytes) {
          stop(new Error(`Android command output exceeds ${maximumOutputBytes} bytes`));
          return;
        }
        target.push(bytes);
      };
      const onAbort = () => stop(new Error("Android command was cancelled"));
      const onError = () => stop(new Error("Android command failed"));
      const onClose = (code) => {
        if (terminationError) {
          finish(markCommandLifecycle(terminationError, COMMAND_EXITED));
          return;
        }
        if (code !== 0) {
          finish(markCommandLifecycle(new Error("Android command failed"), COMMAND_EXITED));
          return;
        }
        finish(undefined, markCommandLifecycle({
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
        }, COMMAND_EXITED));
      };
      child.stdout.on("data", collect(stdout));
      child.stderr.on("data", collect(stderr));
      child.once("error", onError);
      child.once("close", onClose);
      timer = setTimeout(
        () => stop(new Error("Android command timed out")),
        timeoutMilliseconds,
      );
      signal?.addEventListener?.("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
      if (!usesInputFileDescriptor) {
        try {
          child.stdin.end(input);
        } catch {
          stop(new Error("Android command failed"));
        }
      }
    });
  };
}

export function createAndroidDeviceOperations(dependencies = {}) {
  const fs = dependencies.fs ?? defaultFs;
  const spawnProcess = dependencies.spawnProcess ?? defaultSpawn;
  const baseEnvironment = dependencies.toolEnvironment
    ?? dependencies.baseEnvironment
    ?? dependencies.environment
    ?? process.env;
  const terminationGraceMilliseconds = dependencies.commandTerminationGraceMilliseconds
    ?? COMMAND_TERMINATION_GRACE_MILLISECONDS;
  const apkInstallTimeoutMilliseconds = dependencies.apkInstallTimeoutMilliseconds
    ?? APK_INSTALL_TIMEOUT_MILLISECONDS;
  if (
    !Number.isInteger(terminationGraceMilliseconds)
    || terminationGraceMilliseconds < 1
    || terminationGraceMilliseconds > 30_000
  ) throw new Error("Android command termination grace is invalid");
  if (
    !Number.isInteger(apkInstallTimeoutMilliseconds)
    || apkInstallTimeoutMilliseconds < 1
    || apkInstallTimeoutMilliseconds > APK_INSTALL_TIMEOUT_MILLISECONDS
  ) throw new Error("Android APK install timeout is invalid");
  const runCommand = dependencies.runCommand ?? createBoundedRunner(
    spawnProcess,
    baseEnvironment,
    terminationGraceMilliseconds,
  );

  const reverseOptions = () => ({
    env: toolEnvironment(baseEnvironment, {}),
    maxOutputBytes: REVERSE_OUTPUT_MAX_BYTES,
    shell: false,
    timeoutMilliseconds: REVERSE_TIMEOUT_MILLISECONDS,
  });

  async function listOwnedReverse(adbPath, serial) {
    const result = await runCommand(
      adbPath,
      ["-s", serial, "reverse", "--list"],
      reverseOptions(),
    );
    if (result?.stderr !== "") throw new Error("Android reverse proof produced unexpected stderr");
    return reverseMappings(result?.stdout, serial);
  }

  async function establishOwnedAcpReverse(input) {
    assertExactKeys(input, ["serial", "adbPath", "devicePort", "hostPort"], "establishOwnedAcpReverse input");
    const serial = exactEmulatorSerial(input.serial);
    const adbPath = executable(input.adbPath, "adbPath");
    const devicePort = exactTcpPort(input.devicePort, "devicePort");
    const hostPort = exactTcpPort(input.hostPort, "hostPort");
    if (devicePort === hostPort) throw new Error("Android reverse ports must be distinct");
    const before = (await listOwnedReverse(adbPath, serial)).filter((mapping) => (
      mapping.devicePort === devicePort
    ));
    if (before.length > 1 || (before.length === 1 && before[0].hostPort !== hostPort)) {
      throw new Error("Android reverse preflight found a conflicting mapping; refusing mutation");
    }
    const result = await runCommand(
      adbPath,
      ["-s", serial, "reverse", `tcp:${devicePort}`, `tcp:${hostPort}`],
      reverseOptions(),
    );
    if (result?.stdout !== "" || result?.stderr !== "") {
      throw new Error("Android reverse mutation produced unexpected output");
    }
    const deviceMappings = (await listOwnedReverse(adbPath, serial)).filter((mapping) => (
      mapping.devicePort === devicePort
    ));
    if (deviceMappings.length !== 1 || deviceMappings[0].hostPort !== hostPort) {
      throw new Error("Android reverse proof did not contain exactly one owned mapping");
    }
    return Object.freeze({
      serial,
      devicePort,
      hostPort,
      acpUrl: `http://127.0.0.1:${devicePort}`,
    });
  }

  async function removeOwnedAcpReverse(reverse, options) {
    assertExactKeys(reverse, ["serial", "devicePort", "hostPort", "acpUrl"], "owned ACP reverse");
    assertExactKeys(options, ["adbPath"], "removeOwnedAcpReverse options");
    const serial = exactEmulatorSerial(reverse.serial);
    const adbPath = executable(options.adbPath, "adbPath");
    const devicePort = exactTcpPort(reverse.devicePort, "devicePort");
    const hostPort = exactTcpPort(reverse.hostPort, "hostPort");
    if (reverse.acpUrl !== `http://127.0.0.1:${devicePort}`) {
      throw new Error("Owned ACP reverse URL changed");
    }
    const before = (await listOwnedReverse(adbPath, serial)).filter((mapping) => (
      mapping.devicePort === devicePort
    ));
    if (before.length === 0) {
      return Object.freeze({ action: "absent", devicePort });
    }
    if (before.length !== 1 || before[0].hostPort !== hostPort) {
      throw new Error("Owned ACP reverse mapping changed; refusing removal");
    }
    const result = await runCommand(
      adbPath,
      ["-s", serial, "reverse", "--remove", `tcp:${devicePort}`],
      reverseOptions(),
    );
    if (result?.stdout !== "" || result?.stderr !== "") {
      throw new Error("Android reverse removal produced unexpected output");
    }
    const after = (await listOwnedReverse(adbPath, serial)).filter((mapping) => (
      mapping.devicePort === devicePort
    ));
    if (after.length !== 0) throw new Error("Android reverse removal did not prove absence");
    return Object.freeze({ action: "deleted", devicePort });
  }

  async function disableAndroidPointerOverlays(input) {
    assertExactKeys(
      input,
      ["serial", "adbPath"],
      "disableAndroidPointerOverlays input",
    );
    const serial = exactEmulatorSerial(input.serial);
    const adbPath = executable(input.adbPath, "adbPath");
    const commandOptions = {
      env: toolEnvironment(baseEnvironment, {}),
      maxOutputBytes: POINTER_SETTING_OUTPUT_MAX_BYTES,
      shell: false,
      timeoutMilliseconds: POINTER_SETTING_TIMEOUT_MILLISECONDS,
    };

    for (const setting of POINTER_OVERLAY_SETTINGS) {
      const mutation = await runCommand(adbPath, [
        "-s",
        serial,
        "shell",
        "settings",
        "put",
        "system",
        setting,
        "0",
      ], commandOptions);
      if (mutation?.stdout !== "" || mutation?.stderr !== "") {
        throw new Error("Android pointer overlay setting mutation produced unexpected output");
      }
      const verification = await runCommand(adbPath, [
        "-s",
        serial,
        "shell",
        "settings",
        "get",
        "system",
        setting,
      ], commandOptions);
      if (verification?.stdout !== "0\n" || verification?.stderr !== "") {
        throw new Error("Android pointer overlay setting verification failed");
      }
    }
    return { disabled: true };
  }

  async function verifyAndroidDisplayGeometry(input) {
    assertExactKeys(
      input,
      ["serial", "adbPath", "width", "height"],
      "verifyAndroidDisplayGeometry input",
    );
    const serial = exactEmulatorSerial(input.serial);
    const adbPath = executable(input.adbPath, "adbPath");
    const expectedWidth = exactDisplayDimension(input.width, "recording width");
    const expectedHeight = exactDisplayDimension(input.height, "recording height");
    const commandOptions = {
      env: toolEnvironment(baseEnvironment, {}),
      maxOutputBytes: DISPLAY_PROOF_OUTPUT_MAX_BYTES,
      shell: false,
      timeoutMilliseconds: DISPLAY_PROOF_TIMEOUT_MILLISECONDS,
    };
    const size = parseDisplaySizeProof(await runCommand(adbPath, [
      "-s",
      serial,
      "shell",
      "wm",
      "size",
    ], commandOptions));
    const rotation = parseDisplayOrientationProof(await runCommand(adbPath, [
      "-s",
      serial,
      "shell",
      "dumpsys",
      "input",
    ], commandOptions));
    if (rotation !== 0) {
      throw new Error("Android display rotation must be zero for portrait recording");
    }
    if (
      size.recording.width !== expectedWidth
      || size.recording.height !== expectedHeight
    ) {
      throw new Error("Android display recording dimensions mismatch authored capture dimensions");
    }
    return Object.freeze({
      physical: size.physical,
      recording: size.recording,
      rotation,
    });
  }

  async function createOwnedAvd(ownership, options) {
    assertExactKeys(
      options,
      ["avdmanagerPath", "sdkRoot", "systemImage"],
      "createOwnedAvd options",
    );
    const context = await assertOwnedAvdEnvelope(fs, ownership);
    const avdRoot = await canonicalDirectory(fs, context.avdRoot, "ANDROID_AVD_HOME");
    const sdkRoot = await canonicalDirectory(fs, options.sdkRoot, "sdkRoot");
    const avdmanagerPath = requiredString(options.avdmanagerPath, "avdmanagerPath");
    if (options.systemImage !== ownership.systemImage) {
      throw new Error("Refusing an AVD system image outside the ownership marker");
    }
    if (await pathExists(fs, context.avdPath)) {
      throw new Error("Refusing to replace an existing AVD path");
    }
    if (await pathExists(fs, path.join(avdRoot, `${ownership.avdName}.ini`))) {
      throw new Error("Refusing to replace an existing AVD definition");
    }

    let creatorState;
    try {
      const creatorResult = await runCommand(avdmanagerPath, [
        "create",
        "avd",
        "-n",
        ownership.avdName,
        "-k",
        ownership.systemImage,
        "--path",
        ownership.avdPath,
      ], {
        env: toolEnvironment(baseEnvironment, {
          ANDROID_AVD_HOME: avdRoot,
          ANDROID_SDK_ROOT: sdkRoot,
        }),
        input: "no\n",
        maxOutputBytes: 256 * 1024,
        shell: false,
        timeoutMilliseconds: 120_000,
      });
      creatorState = commandLifecycleState(creatorResult);
      await verifyCreatedAvd(fs, ownership, avdRoot);
      await assertOwnedAvdEnvelope(fs, ownership);
      return { avdName: ownership.avdName, created: true };
    } catch (error) {
      creatorState ??= commandLifecycleState(error);
      try {
        if (creatorState === COMMAND_NEVER_STARTED) {
          await assertExactGeneratedArtifactsAbsent(fs, ownership, avdRoot);
          const marker = await assertOwnedAvdEnvelope(fs, ownership);
          if (marker.markerFileIdentity !== context.markerFileIdentity) {
            throw new Error("Owned AVD marker identity changed after creator failed to start");
          }
        } else if (creatorState === COMMAND_EXITED) {
          await cleanupFailedOwnedAvdCreation(fs, ownership, context);
        } else {
          throw new Error("AVD creator exit is unproved");
        }
      } catch {
        throw markAvdCreationCleanupBlocked(error);
      }
      throw error;
    }
  }

  async function installVerifiedAndroidApk(input) {
    const hasSignal = isObject(input)
      && Object.prototype.hasOwnProperty.call(input, "signal");
    assertExactKeys(
      input,
      hasSignal
        ? ["repoRoot", "apk", "serial", "adbPath", "signal"]
        : ["repoRoot", "apk", "serial", "adbPath"],
      "installVerifiedAndroidApk input",
    );
    if (hasSignal && (
      typeof input.signal?.aborted !== "boolean"
      || typeof input.signal?.addEventListener !== "function"
      || typeof input.signal?.removeEventListener !== "function"
    )) throw new Error("installVerifiedAndroidApk signal is invalid");
    if (!isObject(input.apk)) throw new Error("apk must be verified metadata");
    const serial = exactEmulatorSerial(input.serial);
    const adbPath = executable(input.adbPath, "adbPath");
    const resolved = await resolveRepoFile(fs, input.repoRoot, input.apk.ref, "apk.ref");
    if (input.apk.sha256 === undefined) throw new Error("APK sha256 is required");
    if (!SHA256_PATTERN.test(input.apk.sha256)) {
      throw new Error("APK sha256 must be a lowercase digest");
    }
    return withPrivateAndroidApkSnapshot({
      filesystem: fs,
      sourcePath: resolved.pathname,
      expectedSha256: input.apk.sha256,
      useSnapshot: async (_consumePath, consumeFileDescriptor) => {
        await consumeFileDescriptor(async (fileDescriptor, byteLength) => {
          const result = await runCommand(
          adbPath,
          [
            "-s",
            serial,
            "shell",
            "-T",
            "cmd",
            "package",
            "install",
            "-r",
            "-S",
            String(byteLength),
          ],
          {
            inputByteLength: byteLength,
            inputFileDescriptor: fileDescriptor,
            maxOutputBytes: 256 * 1024,
            shell: false,
            ...(hasSignal ? { signal: input.signal } : {}),
            timeoutMilliseconds: apkInstallTimeoutMilliseconds,
          },
          );
          if (result?.stdout !== "Success\n" || result?.stderr !== "") {
            throw new Error("Android package install produced unexpected output");
          }
        });
        return { installed: true };
      },
    });
  }

  async function verifyInstalledAndroidApp(input) {
    assertExactKeys(input, [
      "serial",
      "adbPath",
      "expectedApplicationId",
      "expectedVersionName",
      "expectedVersionCode",
    ], "verifyInstalledAndroidApp input");
    const serial = exactEmulatorSerial(input.serial);
    const adbPath = executable(input.adbPath, "adbPath");
    const expected = {
      applicationId: applicationId(input.expectedApplicationId, "expectedApplicationId"),
      versionName: expectedVersionName(input.expectedVersionName),
      versionCode: expectedVersionCode(input.expectedVersionCode),
    };
    const result = await runCommand(adbPath, [
      "-s",
      serial,
      "shell",
      "dumpsys",
      "package",
      expected.applicationId,
    ], {
      maxOutputBytes: PACKAGE_OUTPUT_MAX_BYTES,
      shell: false,
      timeoutMilliseconds: 15_000,
    });
    return parseInstalledPackage(result?.stdout, expected);
  }

  async function launchAndroidApplication(input) {
    assertExactKeys(
      input,
      ["serial", "adbPath", "applicationId", "activity"],
      "launchAndroidApplication input",
    );
    const serial = exactEmulatorSerial(input.serial);
    const adbPath = executable(input.adbPath, "adbPath");
    const exactApplicationId = applicationId(input.applicationId);
    if (
      !isAndroidLaunchActivity(input.activity)
      || input.activity.split("/", 1)[0] !== exactApplicationId
    ) throw new Error("activity must be a bounded component for applicationId");

    await runCommand(adbPath, [
      "-s",
      serial,
      "shell",
      "am",
      "start",
      "-W",
      "-n",
      input.activity,
    ], {
      maxOutputBytes: 256 * 1024,
      shell: false,
      timeoutMilliseconds: 30_000,
    });
    return { launched: true };
  }

  function createAndroidDriver(input) {
    assertExactKeys(input, ["serial", "adbPath"], "createAndroidDriver input");
    const serial = exactEmulatorSerial(input.serial);
    const adbPath = executable(input.adbPath, "adbPath");

    async function runAdb(args, options, maximumOutputBytes = 256 * 1024) {
      const result = await runCommand(adbPath, ["-s", serial, ...args], {
        maxOutputBytes: maximumOutputBytes,
        shell: false,
        signal: options?.signal,
        timeoutMilliseconds: 15_000,
      });
      return result;
    }

    async function dumpUiHierarchy(options) {
      const signal = operationSignal(options, "dumpUiHierarchy options");
      const result = await runAdb(
        ["exec-out", "uiautomator", "dump", "/dev/tty"],
        { signal },
        UI_DUMP_MAX_BYTES,
      );
      if (typeof result?.stdout !== "string") {
        throw new Error("UI hierarchy output is not text");
      }
      if (Buffer.byteLength(result.stdout, "utf8") > UI_DUMP_MAX_BYTES) {
        throw new Error(`UI hierarchy output exceeds ${UI_DUMP_MAX_BYTES} bytes`);
      }
      return result.stdout;
    }

    async function tap(request, options) {
      assertExactKeys(request, ["x", "y"], "tap request");
      const position = exactCoordinates(request, "tap request");
      const signal = operationSignal(options, "tap options");
      await runAdb([
        "shell",
        "input",
        "tap",
        String(position.x),
        String(position.y),
      ], { signal });
    }

    async function back(options) {
      const signal = operationSignal(options, "back options");
      await runAdb(["shell", "input", "keyevent", "BACK"], { signal });
    }

    async function openPrivateInput(request, options) {
      const signal = operationSignal(options, "private input options");
      if (signal?.aborted) throw new Error("private Android input was cancelled");
      await tap({ x: request.x, y: request.y }, { signal });
      if (signal?.aborted) throw new Error("private Android input was cancelled");

      let child;
      try {
        child = spawnProcess(adbPath, [
          "-s",
          serial,
          "shell",
          "sh",
          "-c",
          PRIVATE_INPUT_SCRIPT,
        ], {
          env: toolEnvironment(baseEnvironment, {}),
          shell: false,
          stdio: ["pipe", "ignore", "ignore"],
        });
      } catch {
        throw new Error("private Android input failed to start");
      }
      if (
        !isObject(child)
        || !isObject(child.stdin)
        || typeof child.stdin.write !== "function"
        || typeof child.stdin.end !== "function"
        || typeof child.stdin.once !== "function"
        || typeof child.once !== "function"
      ) {
        try { child?.kill?.("SIGTERM"); } catch { /* static failure below */ }
        throw new Error("private Android input failed to start");
      }

      const completed = new Promise((resolve, reject) => {
        let settled = false;
        let closed = false;
        let terminationError;
        let sigkillTimer;
        let exitProofTimer;
        const removeChildListeners = () => {
          child.removeListener?.("error", onError);
          child.removeListener?.("close", onClose);
        };
        const finish = (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(sigkillTimer);
          clearTimeout(exitProofTimer);
          signal?.removeEventListener("abort", onAbort);
          child.stdin.removeListener?.("error", onStdinError);
          if (closed) removeChildListeners();
          if (error) reject(error);
          else resolve(undefined);
        };
        const stop = (error) => {
          if (terminationError || closed) return;
          terminationError = error;
          try { child.stdin.destroy?.(); } catch { /* keep failure static */ }
          try { child.kill?.("SIGTERM"); } catch { /* close remains the exit proof */ }
          sigkillTimer = setTimeout(() => {
            if (closed) return;
            try { child.kill?.("SIGKILL"); } catch { /* close remains the exit proof */ }
            exitProofTimer = setTimeout(() => {
              if (closed) return;
              finish(new Error("private Android input cleanup could not prove child exit"));
            }, terminationGraceMilliseconds);
          }, terminationGraceMilliseconds);
        };
        const onError = () => stop(new Error("private Android input failed"));
        const onStdinError = () => stop(new Error("private Android input failed"));
        const onClose = (code) => {
          closed = true;
          clearTimeout(sigkillTimer);
          clearTimeout(exitProofTimer);
          if (settled) {
            removeChildListeners();
            return;
          }
          if (terminationError) finish(terminationError);
          else if (signal?.aborted) finish(new Error("private Android input was cancelled"));
          else if (code === 0) finish();
          else finish(new Error("private Android input failed"));
        };
        const onAbort = () => stop(new Error("private Android input was cancelled"));
        child.once("error", onError);
        child.once("close", onClose);
        child.stdin.once("error", onStdinError);
        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted) onAbort();
      });
      return Object.freeze({ stdin: child.stdin, completed });
    }

    async function fill(request, options) {
      assertExactKeys(request, ["x", "y", "value"], "fill request");
      const position = exactCoordinates(request, "fill request");
      if (
        typeof request.value !== "string"
        || request.value.length > 500
        || /[\u0000\r\n]/u.test(request.value)
      ) throw new Error("fill value must be bounded literal text");
      let channel;
      try {
        channel = await openPrivateInput(position, options);
        channel.stdin.write(request.value);
        channel.stdin.end();
        await channel.completed;
      } catch {
        try { channel?.stdin?.destroy?.(); } catch { /* keep failure static */ }
        throw new Error("Android literal fill failed");
      }
    }

    async function openSecretInput(request, options) {
      assertExactKeys(
        request,
        ["x", "y", "environmentName"],
        "openSecretInput request",
      );
      const position = exactCoordinates(request, "openSecretInput request");
      if (!APPROVED_SECRET_ENVIRONMENTS.has(request.environmentName)) {
        throw new Error("private Android input requires an approved environment name");
      }
      try {
        return await openPrivateInput(position, options);
      } catch (error) {
        if (error?.message === "private Android input was cancelled") {
          throw new Error("private Android input was cancelled");
        }
        throw new Error("private Android input failed to start");
      }
    }

    return Object.freeze({
      back,
      dumpUiHierarchy,
      fill,
      openSecretInput,
      tap,
    });
  }

  return Object.freeze({
    createAndroidDriver,
    createOwnedAvd,
    disableAndroidPointerOverlays,
    establishOwnedAcpReverse,
    installVerifiedAndroidApk,
    launchAndroidApplication,
    removeOwnedAcpReverse,
    verifyAndroidDisplayGeometry,
    verifyInstalledAndroidApp,
  });
}
