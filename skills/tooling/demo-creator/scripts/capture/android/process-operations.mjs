import { execFile, spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import * as defaultFs from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

import {
  createHostProcessInspector,
  HOST_PROCESS_OUTPUT_BYTES,
} from "./host-process-identity.mjs";

const execFileAsync = promisify(execFile);
const KIND_ENVIRONMENT_KEYS = Object.freeze([
  "ACP_KIND_CONNECTIONS_FILE",
  "ACP_KIND_LEGACY_STATE_ROOT",
  "CONTAINER_ENGINE",
  "DOCKER_ONLY_KIND_CLUSTER",
  "EXPECTED_KIND_CONTAINER_IDS",
  "HOME",
  "KIND_CLUSTER_NAME",
  "KIND_CREATION_PROOF_FILE",
  "KIND_FWD_AMBIENT_UI_PORT",
  "KIND_FWD_API_SERVER_PORT",
  "KIND_FWD_BACKEND_PORT",
  "KIND_FWD_FRONTEND_PORT",
  "KIND_FWD_KEYCLOAK_PORT",
  "KIND_HTTP_PORT",
  "KIND_HTTPS_PORT",
  "KIND_PF_ROOT",
  "KUBECONFIG",
  "REQUIRE_NEW_KIND_CLUSTER",
  "TMPDIR",
  "XDG_CONFIG_HOME",
  "XDG_RUNTIME_DIR",
]);
const TOOL_ENVIRONMENT_KEYS = Object.freeze([
  "ANDROID_HOME",
  "ANDROID_SDK_ROOT",
  "HOME",
  "JAVA_HOME",
  "LANG",
  "LC_ALL",
  "PATH",
  "TEMP",
  "TMP",
  "TMPDIR",
]);
const KIND_TIMEOUT_MILLISECONDS = 15 * 60 * 1000;
const MAX_COMMAND_OUTPUT_BYTES = 4 * 1024 * 1024;
const DEFAULT_EMULATOR_DISCOVERY_TIMEOUT_MILLISECONDS = 60_000;
const DEFAULT_AVD_BOOT_TIMEOUT_MILLISECONDS = 120_000;
const DEFAULT_POLL_INTERVAL_MILLISECONDS = 250;
const DEFAULT_STOP_GRACE_MILLISECONDS = 2_000;
const DEFAULT_RECORDER_SIGNAL_GRACE_MILLISECONDS = 1_000;
const DEFAULT_RECORDER_READINESS_MILLISECONDS = 10_000;
const SHORT_COMMAND_TIMEOUT_MILLISECONDS = 5_000;
const MAX_H264_READINESS_BYTES = 1024 * 1024;
const MAX_RECORDER_STDERR_BYTES = 64 * 1024;
const MAX_KIND_CREATION_PROOF_BYTES = 4 * 1024;

function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function requirePositiveInteger(value, label) {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function requireBoundedString(value, label, maximumLength = 512) {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > maximumLength
    || value.trim() !== value
    || value.includes("\0")
  ) {
    throw new Error(`${label} must be one bounded non-empty string`);
  }
  return value;
}

function exactKindCreationEvidence(containerIdentities) {
  if (
    !Array.isArray(containerIdentities)
    || containerIdentities.length !== 1
    || containerIdentities.some((identity) => !/^[0-9a-f]{64}$/u.test(identity))
    || new Set(containerIdentities).size !== containerIdentities.length
    || JSON.stringify(containerIdentities) !== JSON.stringify([...containerIdentities].toSorted())
  ) {
    throw new Error("Kind-up creation proof contains invalid container identities");
  }
  return Object.freeze({
    containerIdentities: Object.freeze([...containerIdentities]),
  });
}

function attachKindCreationEvidence(error, evidence) {
  Object.defineProperty(error, "kindCreationEvidence", {
    configurable: false,
    enumerable: false,
    value: evidence,
    writable: false,
  });
  return error;
}

async function defaultRunCommand(executable, args, options = {}) {
  const result = await execFileAsync(executable, args, {
    cwd: options.cwd,
    encoding: "utf8",
    env: options.env,
    maxBuffer: options.maxOutputBytes,
    shell: false,
    timeout: options.timeoutMilliseconds,
  });
  return { ...result, exitCode: 0 };
}

function toolEnvironment(baseEnvironment, additions = {}) {
  const allowed = Object.fromEntries(
    TOOL_ENVIRONMENT_KEYS
      .filter((key) => typeof baseEnvironment[key] === "string")
      .map((key) => [key, baseEnvironment[key]]),
  );
  return { ...allowed, ...additions };
}

function commandOutput(result, label, maximumBytes = MAX_COMMAND_OUTPUT_BYTES) {
  const output = result?.stdout ?? result;
  if (typeof output !== "string" && !Buffer.isBuffer(output)) {
    throw new Error(`${label} did not return bounded stdout`);
  }
  const text = String(output);
  if (Buffer.byteLength(text, "utf8") > maximumBytes) {
    throw new Error(`${label} output exceeds ${maximumBytes} bytes`);
  }
  return text;
}

function validateProcessRegistry(value) {
  const registry = value ?? { emulators: new Map(), recorders: new Map() };
  if (!(registry.emulators instanceof Map) || !(registry.recorders instanceof Map)) {
    throw new Error("processRegistry must contain private emulators and recorders Maps");
  }
  return registry;
}

function liveProcessIdentity(value, pid, label, expectedCommand, requireCommandProof = false) {
  if (value === null || value === undefined || value.alive === false) {
    throw new Error(`${label} process ${pid} is not live`);
  }
  if (
    value.alive !== true
    || value.pid !== pid
    || typeof value.processStartIdentity !== "string"
    || value.processStartIdentity.trim() === ""
  ) {
    throw new Error(`${label} process identity is invalid`);
  }
  if (requireCommandProof && value.command !== expectedCommand) {
    throw new Error(`${label} process does not have the exact executable and arguments`);
  }
  return value.processStartIdentity;
}

function sameLiveProcess(
  value,
  pid,
  processStartIdentity,
  expectedCommand,
  requireCommandProof = false,
) {
  return value?.alive === true
    && value.pid === pid
    && value.processStartIdentity === processStartIdentity
    && (!requireCommandProof || value.command === expectedCommand);
}

function childExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

function requireExactDirectChild(child, pid, label, errorState) {
  if (!child || child.pid !== pid) {
    throw new Error(`${label} direct child identity changed`);
  }
  if (errorState?.failed === true) {
    throw new Error(`${label} direct child reported an asynchronous process error`);
  }
  if (childExited(child)) {
    throw new Error(`${label} direct child exited`);
  }
  return child;
}

function validateEmulatorLaunchPlan(plan) {
  requireObject(plan, "Owned emulator launch plan");
  if (!exactKeys(plan, ["args", "avdName", "executable"])) {
    throw new Error("Owned emulator launch plan fields are not exact");
  }
  const avdName = requireBoundedString(plan.avdName, "Owned emulator AVD name", 100);
  if (!/^acp-demo-[a-z0-9-]+$/u.test(avdName)) {
    throw new Error("Owned emulator AVD name must be generated with acp-demo-");
  }
  const expectedArgs = [
    "-avd",
    avdName,
    "-no-snapshot-save",
    "-no-audio",
    "-no-boot-anim",
    "-vsync-rate",
    "30",
  ];
  if (!Array.isArray(plan.args) || JSON.stringify(plan.args) !== JSON.stringify(expectedArgs)) {
    throw new Error("Owned emulator launch plan must contain the exact owned emulator arguments");
  }
  return { avdName, expectedArgs };
}

function adbEmulatorDevices(result) {
  const rows = commandOutput(result, "adb devices", 1024 * 1024).split(/\r?\n/u).slice(1);
  const serials = [];
  for (const row of rows) {
    if (!row.trim()) continue;
    const match = /^(\S+)\s+(\S+)\s*$/u.exec(row.trim());
    if (!match) throw new Error("adb devices returned an invalid row");
    if (match[2] === "device" && /^emulator-[1-9][0-9]{0,4}$/u.test(match[1])) {
      serials.push(match[1]);
    }
  }
  if (new Set(serials).size !== serials.length) {
    throw new Error("adb devices returned an ambiguous emulator serial");
  }
  return serials;
}

function adbEmulatorConsolePorts(result) {
  const rows = commandOutput(result, "adb devices", 1024 * 1024).split(/\r?\n/u).slice(1);
  const ports = [];
  for (const row of rows) {
    if (!row.trim()) continue;
    const match = /^(\S+)\s+(\S+)\s*$/u.exec(row.trim());
    if (!match) throw new Error("adb devices returned an invalid row");
    if (/^emulator-[1-9][0-9]{0,4}$/u.test(match[1])) {
      ports.push(consolePort(match[1]));
    }
  }
  if (new Set(ports).size !== ports.length) {
    throw new Error("adb devices returned an ambiguous emulator console port");
  }
  return ports;
}

function exactAvdName(result, serial) {
  const names = commandOutput(result, `adb AVD name for ${serial}`, 16 * 1024)
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line && line !== "OK");
  if (names.length !== 1) throw new Error(`adb returned an ambiguous AVD name for ${serial}`);
  return names[0];
}

function consolePort(serial) {
  const match = /^emulator-([1-9][0-9]{0,4})$/u.exec(serial);
  const port = Number(match?.[1]);
  if (!Number.isInteger(port) || port < 5554 || port > 5682 || port % 2 !== 0) {
    throw new Error(`Emulator serial has an invalid console port: ${serial}`);
  }
  return port;
}

function defaultIsPortAvailable(port) {
  return new Promise((resolve) => {
    const server = createServer();
    let settled = false;
    const finish = (available) => {
      if (settled) return;
      settled = true;
      resolve(available);
    };
    server.unref();
    server.once("error", () => finish(false));
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      server.close((error) => finish(!error));
    });
  });
}

function exactProcessBinding(value, label) {
  requireObject(value, label);
  if (!exactKeys(value, ["consolePort", "pid", "processStartIdentity", "serial"])) {
    throw new Error(`${label} fields are not exact`);
  }
  const serial = requireBoundedString(value.serial, `${label} serial`, 32);
  const port = consolePort(serial);
  if (value.consolePort !== port) throw new Error(`${label} serial and console port differ`);
  const pid = requirePositiveInteger(value.pid, `${label} PID`);
  const processStartIdentity = requireBoundedString(
    value.processStartIdentity,
    `${label} process start identity`,
    512,
  );
  return { serial, consolePort: port, pid, processStartIdentity };
}

function validateScreenrecordStep(step) {
  requireObject(step, "Android screenrecord step");
  if (!exactKeys(step, ["args", "executable", "rawOutputPath"])) {
    throw new Error("Android screenrecord step fields are not exact");
  }
  if (!Array.isArray(step.args) || step.args.length !== 12) {
    throw new Error("Android screenrecord step must contain exact bounded arguments");
  }
  const [
    serialFlag,
    serial,
    execOutCommand,
    screenrecordCommand,
    outputFormat,
    sizeFlag,
    size,
    bitRateFlag,
    bitRateText,
    timeLimitFlag,
    timeLimitText,
    stdoutTarget,
  ] = step.args;
  const port = consolePort(serial);
  if (
    serialFlag !== "-s"
    || execOutCommand !== "exec-out"
    || screenrecordCommand !== "screenrecord"
    || outputFormat !== "--output-format=h264"
    || sizeFlag !== "--size"
    || bitRateFlag !== "--bit-rate"
    || timeLimitFlag !== "--time-limit"
  ) {
    throw new Error("Android screenrecord step must contain exact bounded arguments");
  }
  const dimensions = /^(\d{1,4})x(\d{1,4})$/u.exec(size);
  if (
    !dimensions
    || Number(dimensions[1]) < 1
    || Number(dimensions[1]) > 8192
    || Number(dimensions[2]) < 1
    || Number(dimensions[2]) > 8192
  ) {
    throw new Error("Android screenrecord size is invalid");
  }
  const bitRate = Number(bitRateText);
  if (!Number.isSafeInteger(bitRate) || bitRate < 1 || bitRate > 100_000_000) {
    throw new Error("Android screenrecord bit rate is invalid");
  }
  const timeLimit = Number(timeLimitText);
  if (!Number.isSafeInteger(timeLimit) || timeLimit < 1 || timeLimit > 180) {
    throw new Error("Android screenrecord time limit is invalid");
  }
  if (stdoutTarget !== "-") {
    throw new Error("Android screenrecord must stream raw H.264 to stdout");
  }
  const rawOutputPath = validateRawRecordingPath(step.rawOutputPath);
  return { serial, consolePort: port, args: [...step.args], rawOutputPath };
}

function exactRecorderHandle(value) {
  requireObject(value, "Android screenrecord handle");
  if (!exactKeys(value, ["mediaStartMonotonicMilliseconds", "pid", "processStartIdentity"])) {
    throw new Error("Android screenrecord handle fields are not exact");
  }
  if (
    !Number.isFinite(value.mediaStartMonotonicMilliseconds)
    || value.mediaStartMonotonicMilliseconds < 0
  ) {
    throw new Error("Android screenrecord media clock origin is invalid");
  }
  return {
    mediaStartMonotonicMilliseconds: value.mediaStartMonotonicMilliseconds,
    pid: requirePositiveInteger(value.pid, "Android screenrecord PID"),
    processStartIdentity: requireBoundedString(
      value.processStartIdentity,
      "Android screenrecord process start identity",
      512,
    ),
  };
}

function validateRawRecordingPath(value) {
  if (
    typeof value !== "string"
    || !path.isAbsolute(value)
    || path.resolve(value) !== value
    || path.basename(value) !== "screenrecord.h264"
    || !/^\.adb-screenrecord-[A-Za-z0-9._-]+$/u.test(path.basename(path.dirname(value)))
  ) {
    throw new Error("Android raw screenrecord output must be exact private staging H.264");
  }
  return value;
}

function validateScreenrecordRemuxStep(step) {
  requireObject(step, "Android screenrecord remux plan");
  if (
    !exactKeys(step, [
      "args",
      "executable",
      "expectedDurationSeconds",
      "rawOutputPath",
      "stagedOutputPath",
      "targetFrames",
    ])
    || !Array.isArray(step.args)
    || step.args.length !== 20
  ) {
    throw new Error("Expected one exact canonical ffmpeg remux plan");
  }
  const rawOutputPath = validateRawRecordingPath(step.rawOutputPath);
  const stagedOutputPath = step.stagedOutputPath;
  if (
    typeof stagedOutputPath !== "string"
    || !path.isAbsolute(stagedOutputPath)
    || path.resolve(stagedOutputPath) !== stagedOutputPath
    || path.dirname(stagedOutputPath) !== path.dirname(rawOutputPath)
    || path.basename(stagedOutputPath) !== "screenrecord.mp4"
  ) {
    throw new Error("Expected one exact canonical ffmpeg remux plan");
  }
  const frameCountText = step.args[16];
  const expectedDurationSeconds = step.expectedDurationSeconds;
  const targetFrames = Number(frameCountText);
  const expectedDurationMilliseconds = Math.round(expectedDurationSeconds * 1_000);
  const durationTolerance = Number.EPSILON
    * Math.max(1, Math.abs(expectedDurationSeconds))
    * 8;
  const expectedTargetFrames = Math.ceil((expectedDurationMilliseconds * 30) / 1_000);
  if (
    !Number.isFinite(expectedDurationSeconds)
    || expectedDurationSeconds <= 0
    || expectedDurationSeconds > 180
    || !Number.isSafeInteger(expectedDurationMilliseconds)
    || Math.abs((expectedDurationMilliseconds / 1_000) - expectedDurationSeconds) > durationTolerance
    || typeof frameCountText !== "string"
    || !/^[1-9]\d*$/u.test(frameCountText)
    || !Number.isSafeInteger(targetFrames)
    || step.targetFrames !== targetFrames
    || targetFrames !== expectedTargetFrames
  ) {
    throw new Error("Expected one exact canonical ffmpeg remux plan");
  }
  const expectedArgs = [
    "-nostdin", "-hide_banner", "-loglevel", "error",
    "-f", "h264", "-framerate", "30", "-i", rawOutputPath,
    "-map", "0:v:0", "-an", "-c:v", "copy", "-frames:v", frameCountText,
    "-movflags", "+faststart", stagedOutputPath,
  ];
  if (JSON.stringify(step.args) !== JSON.stringify(expectedArgs)) {
    throw new Error("Expected one exact canonical ffmpeg remux plan");
  }
  return { args: [...step.args], rawOutputPath, stagedOutputPath };
}

function h264ReadinessState() {
  return {
    bytes: Buffer.alloc(0),
    chunks: [],
    firstIdrOffset: null,
    firstIdrObservedAt: null,
    sawSps: false,
    sawPps: false,
  };
}

function startCodeAt(bytes, index) {
  if (bytes[index] !== 0 || bytes[index + 1] !== 0) return 0;
  if (bytes[index + 2] === 1) return 3;
  if (bytes[index + 2] === 0 && bytes[index + 3] === 1) return 4;
  return 0;
}

function observationAtOffset(state, offset) {
  return state.chunks.find(({ start, end }) => offset >= start && offset < end)?.observedAt;
}

function observeH264Readiness(state, chunk, observedAt) {
  if (!Buffer.isBuffer(chunk) && !(chunk instanceof Uint8Array)) {
    throw new Error("Android screenrecord emitted non-binary H.264 data");
  }
  const bytes = Buffer.from(chunk);
  if (bytes.length === 0) return undefined;
  if (!Number.isFinite(observedAt) || observedAt < 0) {
    throw new Error("Android screenrecord media clock returned an invalid observation");
  }
  if (state.bytes.length + bytes.length > MAX_H264_READINESS_BYTES) {
    throw new Error("Android screenrecord exceeded bounded H.264 media readiness bytes");
  }
  const chunkStart = state.bytes.length;
  state.bytes = Buffer.concat([state.bytes, bytes]);
  state.chunks.push({ start: chunkStart, end: state.bytes.length, observedAt });
  for (let index = 0; index < state.bytes.length - 4; index += 1) {
    const startCodeLength = startCodeAt(state.bytes, index);
    if (startCodeLength === 0) continue;
    if (state.firstIdrOffset !== null && index > state.firstIdrOffset) {
      return state.firstIdrObservedAt;
    }
    const headerIndex = index + startCodeLength;
    if (headerIndex + 1 >= state.bytes.length) continue;
    const header = state.bytes[headerIndex];
    if ((header & 0x80) !== 0) {
      throw new Error("Android screenrecord emitted an invalid Annex-B H.264 NAL header");
    }
    const nalType = header & 0x1f;
    if (nalType === 7) state.sawSps = true;
    else if (nalType === 8 && state.sawSps) state.sawPps = true;
    else if (nalType >= 1 && nalType <= 4 && state.firstIdrOffset === null) {
      throw new Error("Android screenrecord emitted a non-IDR VCL NAL before its first validated IDR");
    }
    else if (nalType === 5 && state.firstIdrOffset === null) {
      if (!state.sawSps || !state.sawPps) {
        throw new Error("Android screenrecord emitted an IDR VCL NAL before ordered SPS and PPS");
      }
      state.firstIdrOffset = index;
      state.firstIdrObservedAt = observationAtOffset(state, index);
    }
  }
  return undefined;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function withRecorderQuiescenceProof(error) {
  let failure = error instanceof Error
    ? error
    : new Error("Android screenrecord became unpublishable after proven quiescence");
  if (!Object.isExtensible(failure) || Object.hasOwn(failure, "recorderQuiescenceProven")) {
    failure = new AggregateError([failure], failure.message);
  }
  Object.defineProperty(failure, "recorderQuiescenceProven", {
    configurable: false,
    enumerable: false,
    value: true,
    writable: false,
  });
  return failure;
}

function exactEmulatorRollback(value) {
  requireObject(value, "Emulator rollback identity");
  const keys = Object.keys(value).sort();
  const required = ["avdName", "consolePort", "pid", "processStartIdentity", "serial"].sort();
  const withChild = [...required, "child"].sort();
  if (
    JSON.stringify(keys) !== JSON.stringify(required)
    && JSON.stringify(keys) !== JSON.stringify(withChild)
  ) {
    throw new Error("Emulator rollback identity fields are not exact");
  }
  const avdName = requireBoundedString(value.avdName, "Emulator rollback AVD name", 100);
  if (!/^acp-demo-[a-z0-9-]+$/u.test(avdName)) {
    throw new Error("Emulator rollback requires a generated AVD name");
  }
  const binding = exactProcessBinding({
    serial: value.serial,
    consolePort: value.consolePort,
    pid: value.pid,
    processStartIdentity: value.processStartIdentity,
  }, "Emulator rollback binding");
  return { avdName, ...binding, callerChild: value.child };
}

async function canonicalPrivateParent(fs, pathname, label) {
  const details = await canonicalDirectory(fs, path.dirname(pathname), `${label} parent`);
  if ((details.mode & 0o077) !== 0) throw new Error(`${label} parent must be private`);
}

async function canonicalPrivateRegularFile(fs, pathname, label) {
  if (typeof pathname !== "string" || !path.isAbsolute(pathname) || path.resolve(pathname) !== pathname) {
    throw new Error(`${label} must be one normalized absolute path`);
  }
  let realPath;
  let details;
  try {
    [realPath, details] = await Promise.all([fs.realpath(pathname), fs.lstat(pathname)]);
  } catch {
    throw new Error(`${label} is unavailable`);
  }
  if (
    realPath !== pathname
    || details.isSymbolicLink()
    || !details.isFile()
  ) {
    throw new Error(`${label} must be one canonical regular file`);
  }
  await canonicalPrivateParent(fs, pathname, label);
  return pathname;
}

async function requireAbsent(fs, pathname, label) {
  try {
    await fs.lstat(pathname);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw new Error(`${label} must be absent`);
}

async function canonicalExecutable(fs, executable, expectedName) {
  if (
    typeof executable !== "string"
    || !path.isAbsolute(executable)
    || path.resolve(executable) !== executable
    || path.basename(executable) !== expectedName
  ) {
    throw new Error(`Plan must use one canonical absolute ${expectedName} executable`);
  }
  let realPath;
  let details;
  try {
    [realPath, details] = await Promise.all([fs.realpath(executable), fs.lstat(executable)]);
  } catch {
    throw new Error(`Plan ${expectedName} executable is unavailable`);
  }
  if (
    realPath !== executable
    || details.isSymbolicLink()
    || !details.isFile()
    || (details.mode & 0o111) === 0
  ) {
    throw new Error(`Plan must use the exact canonical ${expectedName} executable`);
  }
  return executable;
}

async function canonicalDirectory(fs, pathname, label) {
  if (typeof pathname !== "string" || !path.isAbsolute(pathname) || path.resolve(pathname) !== pathname) {
    throw new Error(`${label} must be a normalized absolute path`);
  }
  let realPath;
  let details;
  try {
    [realPath, details] = await Promise.all([fs.realpath(pathname), fs.lstat(pathname)]);
  } catch {
    throw new Error(`${label} is unavailable`);
  }
  if (realPath !== pathname || details.isSymbolicLink() || !details.isDirectory()) {
    throw new Error(`${label} must be one canonical directory`);
  }
  return details;
}

function exactKeys(value, expected) {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

async function validatePrivateKubeconfig(fs, kubeconfigPath) {
  if (
    typeof kubeconfigPath !== "string"
    || !path.isAbsolute(kubeconfigPath)
    || path.resolve(kubeconfigPath) !== kubeconfigPath
  ) {
    throw new Error("KUBECONFIG must be one normalized absolute path");
  }
  if (path.basename(kubeconfigPath) !== "kubeconfig") {
    throw new Error("KUBECONFIG must use the generated private kubeconfig filename");
  }
  const parent = path.dirname(kubeconfigPath);
  const parentDetails = await canonicalDirectory(fs, parent, "KUBECONFIG parent");
  if ((parentDetails.mode & 0o077) !== 0) {
    throw new Error("KUBECONFIG parent must be private");
  }
  try {
    const [realPath, details] = await Promise.all([
      fs.realpath(kubeconfigPath),
      fs.lstat(kubeconfigPath),
    ]);
    if (
      realPath !== kubeconfigPath
      || details.isSymbolicLink()
      || !details.isFile()
      || (details.mode & 0o077) !== 0
    ) {
      throw new Error("KUBECONFIG must be one private regular file");
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function validateKindMakePlan(plan, fs) {
  requireObject(plan, "Kind Make plan");
  if (!exactKeys(plan, ["args", "cwd", "environment", "executable"])) {
    throw new Error("Kind Make plan fields are not exact");
  }
  await canonicalExecutable(fs, plan.executable, "make");
  if (!Array.isArray(plan.args) || plan.args.length !== 1) {
    throw new Error("Kind Make plan must contain a single target");
  }
  if (!new Set(["kind-up", "kind-down"]).has(plan.args[0])) {
    throw new Error("Kind Make target must be kind-up or kind-down");
  }
  const environment = requireObject(plan.environment, "Kind Make environment");
  if (!exactKeys(environment, KIND_ENVIRONMENT_KEYS)) {
    throw new Error(`Kind Make environment must contain exactly ${KIND_ENVIRONMENT_KEYS.join(", ")}`);
  }
  await validatePrivateKubeconfig(fs, environment.KUBECONFIG);
  await canonicalDirectory(fs, plan.cwd, "Kind Make cwd");
  const runtimeRoot = path.dirname(environment.KUBECONFIG);
  if (plan.cwd !== path.join(runtimeRoot, "kind-workspace")) {
    throw new Error("Kind Make cwd must be the generated private runtime kind-workspace");
  }
  if (
    typeof environment.KIND_CLUSTER_NAME !== "string"
    || !/^acp-demo-[a-z0-9](?:[a-z0-9-]{0,52}[a-z0-9])?$/u.test(environment.KIND_CLUSTER_NAME)
    || environment.KIND_CLUSTER_NAME.length > 63
  ) {
    throw new Error("Kind Make plan requires a generated cluster name beginning acp-demo-");
  }
  if (environment.CONTAINER_ENGINE !== "docker") {
    throw new Error("Kind Make plan requires CONTAINER_ENGINE=docker");
  }
  if (environment.DOCKER_ONLY_KIND_CLUSTER !== "true") {
    throw new Error("Kind Make plan must forbid cross-provider cleanup");
  }
  if (environment.REQUIRE_NEW_KIND_CLUSTER !== "true") {
    throw new Error("Kind Make plan must require a newly created cluster");
  }
  const expectedContainerIds = environment.EXPECTED_KIND_CONTAINER_IDS;
  if (typeof expectedContainerIds !== "string") {
    throw new Error("Kind Make expected container identities must be a string");
  }
  if (plan.args[0] === "kind-up" && expectedContainerIds !== "") {
    throw new Error("Kind-up must not receive deletion container identities");
  }
  if (plan.args[0] === "kind-down") {
    const identities = expectedContainerIds.split(",");
    if (
      identities.length === 0
      || identities.some((identity) => !/^[0-9a-f]{64}$/u.test(identity))
      || new Set(identities).size !== identities.length
      || JSON.stringify(identities) !== JSON.stringify([...identities].toSorted())
    ) {
      throw new Error("Kind-down requires unique canonical exact Docker container identities");
    }
  }
  const exactPrivatePaths = {
    HOME: path.join(runtimeRoot, "home"),
    TMPDIR: path.join(runtimeRoot, "tmp"),
    XDG_CONFIG_HOME: path.join(runtimeRoot, "xdg-config"),
    XDG_RUNTIME_DIR: path.join(runtimeRoot, "xdg-runtime"),
    KIND_PF_ROOT: path.join(runtimeRoot, "kind-state"),
    ACP_KIND_LEGACY_STATE_ROOT: path.join(runtimeRoot, "kind-state", "legacy"),
  };
  for (const [name, expectedPath] of Object.entries(exactPrivatePaths)) {
    if (environment[name] !== expectedPath) {
      throw new Error(`Kind Make ${name} must remain inside the private runtime root`);
    }
    const details = await canonicalDirectory(fs, environment[name], `Kind Make ${name}`);
    if ((details.mode & 0o077) !== 0) {
      throw new Error(`Kind Make ${name} must be private`);
    }
  }
  if (environment.ACP_KIND_CONNECTIONS_FILE !== path.join(runtimeRoot, "kind-state", "connections.json")) {
    throw new Error("Kind Make connection registry must remain inside the private runtime root");
  }
  if (environment.KIND_CREATION_PROOF_FILE !== path.join(runtimeRoot, "kind-state", "creation-container-ids")) {
    throw new Error("Kind creation proof must remain inside the private runtime root");
  }
  const portKeys = [
    "KIND_FWD_FRONTEND_PORT",
    "KIND_FWD_BACKEND_PORT",
    "KIND_FWD_API_SERVER_PORT",
    "KIND_FWD_AMBIENT_UI_PORT",
    "KIND_FWD_KEYCLOAK_PORT",
    "KIND_HTTP_PORT",
    "KIND_HTTPS_PORT",
  ];
  const ports = portKeys.map((name) => Number(environment[name]));
  if (ports.some((port) => !Number.isInteger(port) || port < 1024 || port > 65535)) {
    throw new Error("Kind Make ports must be explicit unprivileged TCP ports");
  }
  if (new Set(ports).size !== ports.length) {
    throw new Error("Kind Make ports must be unique within the run");
  }
  return plan;
}

export function createAndroidProcessOperations(dependencies = {}) {
  const fs = dependencies.fs ?? defaultFs;
  const readKindCreationProof = dependencies.readKindCreationProof ?? (async (proofPath) => {
    const handle = await fs.open(proofPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try {
      const before = await handle.stat();
      const [canonical, pathBefore] = await Promise.all([
        fs.realpath(proofPath),
        fs.lstat(proofPath),
      ]);
      if (
        canonical !== proofPath
        || pathBefore.isSymbolicLink()
        || !pathBefore.isFile()
        || !before.isFile()
        || before.dev !== pathBefore.dev
        || before.ino !== pathBefore.ino
        || (before.mode & 0o777) !== 0o600
        || before.size < 1
        || before.size > MAX_KIND_CREATION_PROOF_BYTES
      ) {
        throw new Error("Kind creation proof must be one bounded canonical mode-0600 file");
      }
      const bytes = Buffer.alloc(before.size + 1);
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      const [after, canonicalAfter, pathAfter] = await Promise.all([
        handle.stat(),
        fs.realpath(proofPath),
        fs.lstat(proofPath),
      ]);
      if (
        offset !== before.size
        || canonicalAfter !== proofPath
        || pathAfter.isSymbolicLink()
        || !pathAfter.isFile()
        || after.dev !== before.dev
        || after.ino !== before.ino
        || after.size !== before.size
        || after.ctimeMs !== before.ctimeMs
        || after.mtimeMs !== before.mtimeMs
        || pathAfter.dev !== before.dev
        || pathAfter.ino !== before.ino
      ) {
        throw new Error("Kind creation proof changed while it was read");
      }
      return bytes.subarray(0, offset).toString("utf8")
        .split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
    } finally {
      await handle.close();
    }
  });
  const runCommand = dependencies.runCommand ?? defaultRunCommand;
  const spawnProcess = dependencies.spawnProcess ?? spawn;
  const nowMilliseconds = dependencies.nowMilliseconds ?? (() => performance.now());
  const sleep = dependencies.sleep ?? delay;
  const processRegistry = validateProcessRegistry(dependencies.processRegistry);
  const baseEnvironment = dependencies.toolEnvironment
    ?? dependencies.baseEnvironment
    ?? dependencies.environment
    ?? process.env;
  const commandEnvironment = toolEnvironment(baseEnvironment);
  const avdRoot = dependencies.avdRoot;
  const adbPath = dependencies.adbPath ?? "adb";
  const emulatorDiscoveryTimeoutMilliseconds = dependencies.emulatorDiscoveryTimeoutMilliseconds
    ?? DEFAULT_EMULATOR_DISCOVERY_TIMEOUT_MILLISECONDS;
  const emulatorPollIntervalMilliseconds = dependencies.emulatorPollIntervalMilliseconds
    ?? DEFAULT_POLL_INTERVAL_MILLISECONDS;
  const avdBootTimeoutMilliseconds = dependencies.avdBootTimeoutMilliseconds
    ?? DEFAULT_AVD_BOOT_TIMEOUT_MILLISECONDS;
  const avdBootPollIntervalMilliseconds = dependencies.avdBootPollIntervalMilliseconds
    ?? DEFAULT_POLL_INTERVAL_MILLISECONDS;
  const stopGraceMilliseconds = dependencies.stopGraceMilliseconds
    ?? DEFAULT_STOP_GRACE_MILLISECONDS;
  const recorderSignalGraceMilliseconds = dependencies.recorderSignalGraceMilliseconds
    ?? DEFAULT_RECORDER_SIGNAL_GRACE_MILLISECONDS;
  const recorderReadinessMilliseconds = dependencies.recorderReadinessMilliseconds
    ?? DEFAULT_RECORDER_READINESS_MILLISECONDS;
  const isPortAvailable = dependencies.isPortAvailable ?? defaultIsPortAvailable;
  const requireCommandProof = dependencies.inspectProcess === undefined;
  const childErrorStates = new WeakMap();
  requireObject(baseEnvironment, "baseEnvironment");
  if (typeof runCommand !== "function") throw new Error("runCommand must be a function");
  if (typeof spawnProcess !== "function") throw new Error("spawnProcess must be a function");
  if (typeof nowMilliseconds !== "function") throw new Error("nowMilliseconds must be a function");
  if (typeof sleep !== "function") throw new Error("sleep must be a function");
  if (typeof isPortAvailable !== "function") throw new Error("isPortAvailable must be a function");
  requirePositiveInteger(emulatorDiscoveryTimeoutMilliseconds, "emulatorDiscoveryTimeoutMilliseconds");
  requirePositiveInteger(emulatorPollIntervalMilliseconds, "emulatorPollIntervalMilliseconds");
  requirePositiveInteger(avdBootTimeoutMilliseconds, "avdBootTimeoutMilliseconds");
  requirePositiveInteger(avdBootPollIntervalMilliseconds, "avdBootPollIntervalMilliseconds");
  requirePositiveInteger(stopGraceMilliseconds, "stopGraceMilliseconds");
  requirePositiveInteger(recorderSignalGraceMilliseconds, "recorderSignalGraceMilliseconds");
  requirePositiveInteger(recorderReadinessMilliseconds, "recorderReadinessMilliseconds");

  const inspectProcess = dependencies.inspectProcess ?? createHostProcessInspector({
    runCommand,
    commandOptions: {
      env: commandEnvironment,
      maxOutputBytes: HOST_PROCESS_OUTPUT_BYTES,
      shell: false,
      timeoutMilliseconds: SHORT_COMMAND_TIMEOUT_MILLISECONDS,
    },
  });
  if (typeof inspectProcess !== "function") throw new Error("inspectProcess must be a function");

  function exactProcessCommand(executable, args) {
    const fields = [executable, ...args];
    if (fields.some((field) => typeof field !== "string" || /[\r\n\0]/u.test(field))) {
      throw new Error("Spawned process command contains an invalid field");
    }
    return fields.join(" ");
  }

  function trackChildErrors(child) {
    const state = { failed: false };
    if (typeof child?.once === "function") {
      child.once("error", () => {
        state.failed = true;
      });
    }
    if (child && typeof child === "object") childErrorStates.set(child, state);
    return state;
  }

  async function writeAll(fileHandle, bytes) {
    let offset = 0;
    while (offset < bytes.length) {
      const result = await fileHandle.write(bytes, offset, bytes.length - offset, null);
      if (!Number.isInteger(result?.bytesWritten) || result.bytesWritten <= 0) {
        throw new Error("Android raw H.264 staging write made no progress");
      }
      offset += result.bytesWritten;
    }
  }

  async function openRawRecorderOutput(rawOutputPath) {
    await canonicalPrivateParent(fs, rawOutputPath, "Android raw H.264 output");
    await requireAbsent(fs, rawOutputPath, "Android raw H.264 output");
    if (typeof fs.open !== "function") {
      throw new Error("Android raw H.264 output requires exclusive file creation");
    }
    const fileHandle = await fs.open(
      rawOutputPath,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
      0o600,
    );
    try {
      const details = await fs.lstat(rawOutputPath);
      if (
        details.isSymbolicLink()
        || !details.isFile()
        || (details.mode & 0o777) !== 0o600
        || await fs.realpath(rawOutputPath) !== rawOutputPath
      ) {
        throw new Error("Android raw H.264 output must be a canonical mode-0600 file");
      }
    } catch (error) {
      await fileHandle.close();
      throw error;
    }
    return {
      closed: false,
      childClose: deferred(),
      childClosed: false,
      cleanupRequested: false,
      failure: null,
      fileHandle,
      h264: h264ReadinessState(),
      mediaReady: deferred(),
      mediaReadySettled: false,
      rawOutputPath,
      stderrBytes: 0,
      streamEnd: deferred(),
      streamEnded: false,
      writeQueue: Promise.resolve(),
    };
  }

  function rejectRecorderIo(io, error) {
    const failure = error instanceof Error ? error : new Error("Android recorder stream failed");
    io.failure ??= failure;
    if (!io.mediaReadySettled) {
      io.mediaReadySettled = true;
      io.mediaReady.reject(failure);
    }
  }

  function attachRawRecorderStream(child, io) {
    const stdout = child?.stdout;
    const stderr = child?.stderr;
    if (
      !stdout
      || typeof stdout.on !== "function"
      || typeof stdout.pause !== "function"
      || typeof stdout.resume !== "function"
      || !stderr
      || typeof stderr.on !== "function"
    ) {
      throw new Error("Android screenrecord requires separate piped stdout and stderr streams");
    }
    stdout.on("data", (chunk) => {
      const applyBackpressure = io.mediaReadySettled;
      if (applyBackpressure) stdout.pause();
      let firstIdrAt;
      if (!io.mediaReadySettled) {
        try {
          const observedAt = nowMilliseconds();
          firstIdrAt = observeH264Readiness(io.h264, chunk, observedAt);
          if (firstIdrAt !== undefined && !io.mediaReadySettled) {
            io.mediaReadySettled = true;
            io.mediaReady.resolve(firstIdrAt);
            io.h264 = undefined;
          }
        } catch (error) {
          rejectRecorderIo(io, error);
        }
      }
      const bytes = Buffer.from(chunk);
      io.writeQueue = io.writeQueue
        .then(() => writeAll(io.fileHandle, bytes))
        .then(() => {
          void firstIdrAt;
        })
        .catch((error) => {
          rejectRecorderIo(io, error);
        })
        .finally(() => {
          if (applyBackpressure) stdout.resume();
        });
    });
    stdout.once("error", (error) => rejectRecorderIo(io, error));
    stderr.on("data", (chunk) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      io.stderrBytes += bytes.length;
      if (io.stderrBytes > MAX_RECORDER_STDERR_BYTES) {
        rejectRecorderIo(io, new Error("Android screenrecord stderr exceeded its bounded capture"));
      }
    });
    stderr.once("error", (error) => rejectRecorderIo(io, error));
    stdout.once("end", () => {
      io.streamEnded = true;
      io.streamEnd.resolve();
    });
    if (typeof child.once === "function") {
      child.once("close", () => {
        io.childClosed = true;
        io.childClose.resolve();
      });
      child.once("exit", () => {
        if (!io.mediaReadySettled && !io.cleanupRequested) {
          rejectRecorderIo(
            io,
            new Error("Android screenrecord exited before the first complete validated H.264 IDR NAL"),
          );
        }
      });
    }
  }

  async function waitForRecorderStreamEnd(io) {
    if (io.streamEnded) return;
    await new Promise((resolve) => setImmediate(resolve));
    if (io.streamEnded) return;
    const result = await Promise.race([
      io.streamEnd.promise.then(() => "ended"),
      sleep(recorderSignalGraceMilliseconds, undefined, { ref: false }).then(() => "timeout"),
    ]);
    if (result !== "ended" || !io.streamEnded) {
      throw new Error("Android screenrecord stdout did not reach bounded EOF");
    }
  }

  async function waitForRecorderChildClose(io) {
    if (io.childClosed) return;
    await new Promise((resolve) => setImmediate(resolve));
    if (io.childClosed) return;
    const result = await Promise.race([
      io.childClose.promise.then(() => "closed"),
      sleep(recorderSignalGraceMilliseconds, undefined, { ref: false }).then(() => "timeout"),
    ]);
    if (result !== "closed" || !io.childClosed) {
      throw new Error("Android screenrecord child did not reach bounded close");
    }
  }

  async function finalizeRawRecorderOutput(io, { requireMedia = true } = {}) {
    if (io.closed) {
      if (io.failure) throw io.failure;
      return;
    }
    try {
      await io.writeQueue;
      await waitForRecorderStreamEnd(io);
      await io.writeQueue;
      if (io.failure) throw io.failure;
      if (requireMedia && !io.mediaReadySettled) {
        throw new Error("Android raw H.264 output ended without media readiness");
      }
      await io.fileHandle.sync();
      await io.fileHandle.close();
      io.closed = true;
      const details = await fs.lstat(io.rawOutputPath);
      if (
        details.isSymbolicLink()
        || !details.isFile()
        || !Number.isSafeInteger(details.size)
        || (requireMedia && details.size <= 0)
        || (details.mode & 0o777) !== 0o600
        || await fs.realpath(io.rawOutputPath) !== io.rawOutputPath
      ) {
        throw new Error("Android raw H.264 output did not finalize as one private nonempty file");
      }
    } catch (error) {
      io.failure ??= error;
      if (!io.closed) {
        try {
          await io.fileHandle.close();
          io.closed = true;
        } catch {
          // Preserve the primary stream/finalization failure.
        }
      }
      throw error;
    }
  }

  async function closeUnattachedRawRecorderOutput(io) {
    if (io.closed) return;
    try {
      await io.writeQueue;
      await io.fileHandle.sync();
      await io.fileHandle.close();
      io.closed = true;
    } catch (error) {
      if (!io.closed) {
        try {
          await io.fileHandle.close();
          io.closed = true;
        } catch {
          // Preserve the first close/finalization failure.
        }
      }
      throw error;
    }
  }

  async function waitForChildExit(child, maximumMilliseconds) {
    const deadline = nowMilliseconds() + maximumMilliseconds;
    while (!childExited(child) && nowMilliseconds() < deadline) {
      const remaining = deadline - nowMilliseconds();
      await sleep(Math.min(DEFAULT_POLL_INTERVAL_MILLISECONDS, remaining));
    }
    return childExited(child);
  }

  async function cleanupExactSpawnedChild(
    child,
    pid,
    processStartIdentity,
    expectedCommand,
  ) {
    if (childExited(child)) return true;
    if (child?.pid !== pid) return false;
    const live = await inspectProcess(pid);
    if (!sameLiveProcess(
      live,
      pid,
      processStartIdentity,
      expectedCommand,
      requireCommandProof,
    )) return false;
    try {
      if (child.kill("SIGTERM") !== true) return false;
    } catch {
      return false;
    }
    if (await waitForChildExit(child, stopGraceMilliseconds)) return true;
    if (childErrorStates.get(child)?.failed === true) return false;
    if (child?.pid !== pid) return false;
    const stillLive = await inspectProcess(pid);
    if (!sameLiveProcess(
      stillLive,
      pid,
      processStartIdentity,
      expectedCommand,
      requireCommandProof,
    )) return false;
    try {
      if (child.kill("SIGKILL") !== true) return false;
    } catch {
      return false;
    }
    const exited = await waitForChildExit(child, stopGraceMilliseconds);
    return exited && childErrorStates.get(child)?.failed !== true;
  }

  async function cleanupExactDirectChild(child, pid) {
    if (childExited(child)) return true;
    if (child?.pid !== pid || childErrorStates.get(child)?.failed === true) return false;
    for (const signal of ["SIGTERM", "SIGKILL"]) {
      let delivered;
      try {
        delivered = child.kill(signal);
      } catch {
        return false;
      }
      if (delivered !== true) return childExited(child);
      if (await waitForChildExit(child, stopGraceMilliseconds)) {
        return childErrorStates.get(child)?.failed !== true;
      }
      if (child?.pid !== pid || childErrorStates.get(child)?.failed === true) return false;
    }
    return false;
  }

  async function allocateEmulatorConsolePort() {
    const devices = await runCommand(adbPath, ["devices"], {
      env: commandEnvironment,
      maxOutputBytes: 1024 * 1024,
      shell: false,
      timeoutMilliseconds: SHORT_COMMAND_TIMEOUT_MILLISECONDS,
    });
    const occupied = new Set(adbEmulatorConsolePorts(devices));
    for (const record of processRegistry.emulators.values()) {
      if (Number.isInteger(record?.consolePort)) occupied.add(record.consolePort);
    }
    for (let port = 5554; port <= 5682; port += 2) {
      if (occupied.has(port)) continue;
      if (await isPortAvailable(port) && await isPortAvailable(port + 1)) return port;
    }
    throw new Error("No unique even emulator console port is available");
  }

  async function launchOwnedEmulator(input) {
    const { avdName, expectedArgs } = validateEmulatorLaunchPlan(input);
    await canonicalExecutable(fs, input.executable, "emulator");
    await canonicalExecutable(fs, adbPath, "adb");
    if (avdRoot === undefined) {
      throw new Error("Owned emulator launch requires a private avdRoot");
    }
    const avdRootDetails = await canonicalDirectory(fs, avdRoot, "Owned emulator avdRoot");
    if ((avdRootDetails.mode & 0o077) !== 0) {
      throw new Error("Owned emulator avdRoot must be private");
    }
    if (processRegistry.emulators.has(avdName)) {
      throw new Error(`Owned emulator is already registered: ${avdName}`);
    }
    let child;
    let pid;
    let processStartIdentity;
    let record;
    let recordKey = avdName;
    let processCommand;
    try {
      const allocatedPort = await allocateEmulatorConsolePort();
      const serial = `emulator-${allocatedPort}`;
      const launchArgs = Object.freeze([...expectedArgs, "-port", String(allocatedPort)]);
      child = spawnProcess(input.executable, launchArgs, {
        detached: true,
        env: { ...commandEnvironment, ANDROID_AVD_HOME: avdRoot },
        shell: false,
        stdio: "ignore",
      });
      const childErrorState = trackChildErrors(child);
      pid = requirePositiveInteger(child?.pid, "Spawned emulator PID");
      requireExactDirectChild(child, pid, "Spawned emulator", childErrorState);
      processCommand = exactProcessCommand(input.executable, launchArgs);
      if (processRegistry.emulators.has(avdName)) {
        recordKey = Symbol(`emulator-collision-${pid}`);
      }
      record = Object.freeze({
        avdName,
        serial,
        consolePort: allocatedPort,
        pid,
        processStartIdentity: null,
        child,
        launchArgs,
        processCommand,
      });
      processRegistry.emulators.set(recordKey, record);
      processStartIdentity = liveProcessIdentity(
        await inspectProcess(pid),
        pid,
        "Spawned emulator",
        processCommand,
        requireCommandProof,
      );
      if (processRegistry.emulators.get(recordKey) !== record) {
        recordKey = Symbol(`emulator-collision-${pid}`);
        record = Object.freeze({ ...record, processStartIdentity });
        processRegistry.emulators.set(recordKey, record);
        throw new Error(`Owned emulator registry changed during launch: ${avdName}`);
      }
      record = Object.freeze({
        avdName,
        serial,
        consolePort: allocatedPort,
        pid,
        processStartIdentity,
        child,
        launchArgs,
        processCommand,
      });
      processRegistry.emulators.set(recordKey, record);
      if (typeof recordKey === "symbol") {
        throw new Error(`Owned emulator registry changed during launch: ${avdName}`);
      }
      const deadline = nowMilliseconds() + emulatorDiscoveryTimeoutMilliseconds;
      while (nowMilliseconds() <= deadline) {
        requireExactDirectChild(child, pid, "Spawned emulator", childErrorState);
        const live = await inspectProcess(pid);
        if (!sameLiveProcess(
          live,
          pid,
          processStartIdentity,
          processCommand,
          requireCommandProof,
        )) {
          throw new Error("Spawned emulator process identity changed during discovery");
        }
        if (processRegistry.emulators.get(recordKey) !== record) {
          throw new Error(`Owned emulator registry changed during launch: ${avdName}`);
        }
        const devices = await runCommand(adbPath, ["devices"], {
          env: commandEnvironment,
          maxOutputBytes: 1024 * 1024,
          shell: false,
          timeoutMilliseconds: SHORT_COMMAND_TIMEOUT_MILLISECONDS,
        });
        requireExactDirectChild(child, pid, "Spawned emulator", childErrorState);
        const afterDevices = await inspectProcess(pid);
        if (!sameLiveProcess(
          afterDevices,
          pid,
          processStartIdentity,
          processCommand,
          requireCommandProof,
        )) {
          throw new Error("Spawned emulator process identity changed after ADB discovery");
        }
        if (processRegistry.emulators.get(recordKey) !== record) {
          throw new Error(`Owned emulator registry changed during launch: ${avdName}`);
        }
        if (adbEmulatorDevices(devices).includes(serial)) {
          const result = await runCommand(adbPath, ["-s", serial, "emu", "avd", "name"], {
            env: commandEnvironment,
            maxOutputBytes: 16 * 1024,
            shell: false,
            timeoutMilliseconds: SHORT_COMMAND_TIMEOUT_MILLISECONDS,
          });
          requireExactDirectChild(child, pid, "Spawned emulator", childErrorState);
          const afterAvdName = await inspectProcess(pid);
          requireExactDirectChild(child, pid, "Spawned emulator", childErrorState);
          if (!sameLiveProcess(
            afterAvdName,
            pid,
            processStartIdentity,
            processCommand,
            requireCommandProof,
          )) {
            throw new Error("Spawned emulator process identity changed after AVD verification");
          }
          if (processRegistry.emulators.get(recordKey) !== record) {
            throw new Error(`Owned emulator registry changed during launch: ${avdName}`);
          }
          if (exactAvdName(result, serial) !== avdName) {
            throw new Error(`Exact emulator serial belongs to a different AVD: ${serial}`);
          }
          requireExactDirectChild(child, pid, "Spawned emulator", childErrorState);
          return Object.freeze({
            serial: record.serial,
            consolePort: record.consolePort,
            pid: record.pid,
            processStartIdentity: record.processStartIdentity,
          });
        }
        await sleep(emulatorPollIntervalMilliseconds);
      }
      throw new Error(`Timed out discovering exact emulator ${avdName}`);
    } catch (error) {
      let cleanupSucceeded = false;
      let cleanupFailure;
      if (child && pid) {
        try {
          cleanupSucceeded = processStartIdentity
            ? await cleanupExactSpawnedChild(child, pid, processStartIdentity, processCommand)
            : await cleanupExactDirectChild(child, pid);
        } catch {
          cleanupFailure = new Error(
            "Exact spawned emulator cleanup could not prove child exit because inspection failed",
          );
        }
      }
      if (cleanupSucceeded && processRegistry.emulators.get(recordKey)?.child === child) {
        processRegistry.emulators.delete(recordKey);
      }
      if (child && !cleanupSucceeded) {
        throw new AggregateError(
          [
            error,
            cleanupFailure ?? new Error("Exact spawned emulator cleanup could not prove child exit"),
          ],
          "Owned emulator launch failed and cleanup could not prove exact child exit",
        );
      }
      throw error;
    }
  }

  async function rollbackOwnedEmulator(input) {
    const binding = exactEmulatorRollback(input);
    const registryKey = binding.avdName;
    const record = processRegistry.emulators.get(registryKey);
    if (!record) throw new Error(`Exact launched emulator is not registered: ${binding.serial}`);
    for (const field of ["avdName", "serial", "consolePort", "pid", "processStartIdentity"]) {
      if (record[field] !== binding[field]) {
        throw new Error(`Exact launched emulator identity changed: ${binding.serial}`);
      }
    }
    if (binding.callerChild !== undefined && binding.callerChild !== record.child) {
      throw new Error(`Exact launched emulator direct child identity changed: ${binding.serial}`);
    }
    if (!record.child || record.child.pid !== binding.pid) {
      throw new Error(`Exact launched emulator child handle is missing: ${binding.serial}`);
    }
    if (childExited(record.child)) {
      if (processRegistry.emulators.get(registryKey) !== record) {
        throw new Error(`Exact launched emulator registry changed: ${binding.serial}`);
      }
      processRegistry.emulators.delete(registryKey);
      return Object.freeze({ rolledBack: true, pid: binding.pid, serial: binding.serial });
    }
    const live = await inspectProcess(binding.pid);
    if (!sameLiveProcess(
      live,
      binding.pid,
      binding.processStartIdentity,
      record.processCommand,
      requireCommandProof,
    )) {
      throw new Error(`Exact launched emulator process identity changed: ${binding.serial}`);
    }
    if (processRegistry.emulators.get(registryKey) !== record) {
      throw new Error(`Exact launched emulator registry changed: ${binding.serial}`);
    }
    const stopped = await cleanupExactSpawnedChild(
      record.child,
      binding.pid,
      binding.processStartIdentity,
      record.processCommand,
    );
    if (!stopped) throw new Error(`Exact launched emulator did not exit: ${binding.serial}`);
    if (processRegistry.emulators.get(registryKey) !== record) {
      throw new Error(`Exact launched emulator registry changed during rollback: ${binding.serial}`);
    }
    processRegistry.emulators.delete(registryKey);
    return Object.freeze({ rolledBack: true, pid: binding.pid, serial: binding.serial });
  }

  async function waitForOwnedAvdBoot(ownership, options = {}) {
    requireObject(ownership, "Owned AVD");
    requireObject(options, "AVD boot options");
    if (!exactKeys(options, ["adbPath"])) {
      throw new Error("AVD boot options must contain only adbPath");
    }
    const avdName = requireBoundedString(ownership.avdName, "Owned AVD name", 100);
    const binding = exactProcessBinding({
      serial: ownership.serial,
      consolePort: ownership.consolePort,
      pid: ownership.pid,
      processStartIdentity: ownership.processStartIdentity,
    }, "Owned AVD process binding");
    const record = processRegistry.emulators.get(avdName);
    if (!record) throw new Error(`Exact owned emulator is not registered: ${avdName}`);
    for (const field of ["serial", "consolePort", "pid", "processStartIdentity"]) {
      if (record[field] !== binding[field]) {
        throw new Error(`Exact owned emulator registry identity changed: ${binding.serial}`);
      }
    }
    const exactAdbPath = options.adbPath ?? adbPath;
    await canonicalExecutable(fs, exactAdbPath, "adb");
    const deadline = nowMilliseconds() + avdBootTimeoutMilliseconds;
    while (nowMilliseconds() <= deadline) {
      requireExactDirectChild(
        record.child,
        binding.pid,
        "Exact owned emulator",
        childErrorStates.get(record.child),
      );
      const live = await inspectProcess(binding.pid);
      if (!sameLiveProcess(
        live,
        binding.pid,
        binding.processStartIdentity,
        record.processCommand,
        requireCommandProof,
      )) {
        throw new Error(`Exact owned emulator process identity changed: ${binding.serial}`);
      }
      if (processRegistry.emulators.get(avdName) !== record) {
        throw new Error(`Exact owned emulator registry changed during boot: ${binding.serial}`);
      }
      const result = await runCommand(exactAdbPath, [
        "-s",
        binding.serial,
        "shell",
        "getprop",
        "sys.boot_completed",
      ], {
        env: commandEnvironment,
        maxOutputBytes: 16 * 1024,
        shell: false,
        timeoutMilliseconds: SHORT_COMMAND_TIMEOUT_MILLISECONDS,
      });
      requireExactDirectChild(
        record.child,
        binding.pid,
        "Exact owned emulator",
        childErrorStates.get(record.child),
      );
      const afterAdb = await inspectProcess(binding.pid);
      requireExactDirectChild(
        record.child,
        binding.pid,
        "Exact owned emulator",
        childErrorStates.get(record.child),
      );
      if (!sameLiveProcess(
        afterAdb,
        binding.pid,
        binding.processStartIdentity,
        record.processCommand,
        requireCommandProof,
      )) {
        throw new Error(`Exact owned emulator process identity changed after ADB boot probe: ${binding.serial}`);
      }
      if (processRegistry.emulators.get(avdName) !== record) {
        throw new Error(`Exact owned emulator registry changed during boot: ${binding.serial}`);
      }
      if (commandOutput(result, `adb boot readiness for ${binding.serial}`, 16 * 1024).trim() === "1") {
        requireExactDirectChild(
          record.child,
          binding.pid,
          "Exact owned emulator",
          childErrorStates.get(record.child),
        );
        return Object.freeze({ ready: true, serial: binding.serial });
      }
      await sleep(avdBootPollIntervalMilliseconds);
    }
    throw new Error(`Timed out waiting for exact owned AVD boot: ${binding.serial}`);
  }

  async function startAndroidScreenrecord(input) {
    const step = validateScreenrecordStep(input);
    await canonicalExecutable(fs, input.executable, "adb");
    const io = await openRawRecorderOutput(step.rawOutputPath);
    const readinessOutcome = io.mediaReady.promise.then(
      (mediaStartMonotonicMilliseconds) => ({ mediaStartMonotonicMilliseconds }),
      (failure) => ({ failure }),
    );
    let child;
    let pid;
    let processStartIdentity;
    let record;
    let recordKey;
    let processCommand;
    let streamAttached = false;
    try {
      child = spawnProcess(input.executable, step.args, {
        detached: false,
        env: commandEnvironment,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const childErrorState = trackChildErrors(child);
      pid = requirePositiveInteger(child?.pid, "Spawned Android screenrecord PID");
      requireExactDirectChild(child, pid, "Spawned Android screenrecord", childErrorState);
      processCommand = exactProcessCommand(input.executable, step.args);
      attachRawRecorderStream(child, io);
      streamAttached = true;
      recordKey = pid;
      if (processRegistry.recorders.has(pid)) {
        recordKey = Symbol(`recorder-collision-${pid}`);
      }
      record = Object.freeze({
        args: Object.freeze([...step.args]),
        child,
        executable: input.executable,
        handle: null,
        pid,
        processStartIdentity: null,
        processCommand,
        rawOutputPath: step.rawOutputPath,
        serial: step.serial,
        stream: io,
      });
      processRegistry.recorders.set(recordKey, record);
      processStartIdentity = liveProcessIdentity(
        await inspectProcess(pid),
        pid,
        "Spawned Android screenrecord",
        processCommand,
        requireCommandProof,
      );
      if (processRegistry.recorders.get(recordKey) !== record) {
        recordKey = Symbol(`recorder-collision-${pid}`);
        record = Object.freeze({ ...record, processStartIdentity });
        processRegistry.recorders.set(recordKey, record);
        throw new Error(`Android screenrecord registry changed before registration: ${pid}`);
      }
      await new Promise((resolve) => setImmediate(resolve));
      const readiness = await Promise.race([
        readinessOutcome,
        sleep(recorderReadinessMilliseconds, undefined, { ref: false })
          .then(() => ({ timeout: true })),
      ]);
      if (readiness.failure) throw readiness.failure;
      if (readiness.timeout) {
        throw new Error("Android screenrecord media readiness timed out waiting for SPS, PPS, and a complete IDR NAL");
      }
      const handle = Object.freeze({
        pid,
        processStartIdentity,
        mediaStartMonotonicMilliseconds: readiness.mediaStartMonotonicMilliseconds,
      });
      record = Object.freeze({
        args: Object.freeze([...step.args]),
        child,
        executable: input.executable,
        handle,
        pid,
        processStartIdentity,
        processCommand,
        rawOutputPath: step.rawOutputPath,
        serial: step.serial,
        stream: io,
      });
      processRegistry.recorders.set(recordKey, record);
      if (typeof recordKey === "symbol") {
        throw new Error(`Android screenrecord PID is already registered: ${pid}`);
      }
      requireExactDirectChild(child, pid, "Spawned Android screenrecord", childErrorState);
      const readyProcess = await inspectProcess(pid);
      requireExactDirectChild(child, pid, "Spawned Android screenrecord", childErrorState);
      if (!sameLiveProcess(
        readyProcess,
        pid,
        processStartIdentity,
        processCommand,
        requireCommandProof,
      )) {
        throw new Error("Spawned Android screenrecord process identity changed at readiness");
      }
      if (processRegistry.recorders.get(recordKey) !== record) {
        throw new Error(`Android screenrecord registry changed at readiness: ${pid}`);
      }
      requireExactDirectChild(child, pid, "Spawned Android screenrecord", childErrorState);
      return handle;
    } catch (error) {
      let cleanupSucceeded = false;
      let cleanupFailure;
      let writerQuiescenceProven = false;
      io.cleanupRequested = true;
      if (child && pid) {
        try {
          cleanupSucceeded = processStartIdentity
            ? await cleanupExactSpawnedChild(child, pid, processStartIdentity, processCommand)
            : await cleanupExactDirectChild(child, pid);
        } catch {
          cleanupFailure = new Error(
            "Exact Android screenrecord cleanup could not prove child exit because inspection failed",
          );
        }
      } else if (!child) {
        cleanupSucceeded = true;
      }
      if (cleanupSucceeded && streamAttached) {
        try {
          await waitForRecorderChildClose(io);
          await finalizeRawRecorderOutput(io, { requireMedia: false });
        } catch (failure) {
          cleanupFailure = failure;
        }
        writerQuiescenceProven = io.childClosed && io.streamEnded && io.closed;
      } else if (!streamAttached) {
        try {
          await closeUnattachedRawRecorderOutput(io);
        } catch (failure) {
          cleanupFailure = failure;
        }
        writerQuiescenceProven = io.closed;
      }
      if (
        cleanupSucceeded
        && writerQuiescenceProven
        && processRegistry.recorders.get(recordKey)?.child === child
      ) {
        processRegistry.recorders.delete(recordKey);
      }
      if (child && (!cleanupSucceeded || !writerQuiescenceProven)) {
        const failure = new AggregateError(
          [
            error,
            cleanupFailure ?? new Error("Exact Android screenrecord cleanup could not prove child exit"),
          ],
          "Android screenrecord start failed and cleanup could not prove exact child exit",
        );
        Object.defineProperty(failure, "recorderExitUnproved", {
          configurable: false,
          enumerable: false,
          value: true,
          writable: false,
        });
        throw failure;
      }
      if (cleanupFailure && cleanupFailure !== error) {
        throw new AggregateError(
          [error, cleanupFailure],
          "Android screenrecord start failed and raw output cleanup failed",
        );
      }
      throw error;
    }
  }

  async function stopAndroidScreenrecord(input) {
    const handle = exactRecorderHandle(input);
    const record = processRegistry.recorders.get(handle.pid);
    if (!record || record.handle !== input) {
      throw new Error(`Refusing anything except the exact tracked recorder handle: ${handle.pid}`);
    }
    if (
      record.pid !== handle.pid
      || record.processStartIdentity !== handle.processStartIdentity
      || record.handle.mediaStartMonotonicMilliseconds !== handle.mediaStartMonotonicMilliseconds
      || record.child?.pid !== handle.pid
    ) {
      throw new Error(`Exact tracked recorder identity changed: ${handle.pid}`);
    }
    let stopSignal;
    if (!childExited(record.child)) {
      let live = await inspectProcess(handle.pid);
      if (!sameLiveProcess(
        live,
        handle.pid,
        handle.processStartIdentity,
        record.processCommand,
        requireCommandProof,
      )) {
        throw new Error(`Exact tracked recorder process identity changed: ${handle.pid}`);
      }
      let exited = false;
      for (const signal of ["SIGINT", "SIGTERM", "SIGKILL"]) {
        if (processRegistry.recorders.get(handle.pid) !== record) {
          throw new Error(`Exact tracked recorder registry changed: ${handle.pid}`);
        }
        let delivered;
        try {
          delivered = record.child.kill(signal);
        } catch {
          throw new Error(`Exact tracked recorder could not signal its direct child: ${handle.pid}`);
        }
        if (delivered !== true) {
          if (await waitForChildExit(record.child, recorderSignalGraceMilliseconds)) {
            exited = true;
            break;
          }
          throw new Error(`Exact tracked recorder could not signal its direct child: ${handle.pid}`);
        }
        if (await waitForChildExit(record.child, recorderSignalGraceMilliseconds)) {
          stopSignal = signal;
          exited = true;
          break;
        }
        if (childErrorStates.get(record.child)?.failed === true) {
          throw new Error(`Exact tracked recorder direct child reported a process error: ${handle.pid}`);
        }
        live = await inspectProcess(handle.pid);
        if (!sameLiveProcess(
          live,
          handle.pid,
          handle.processStartIdentity,
          record.processCommand,
          requireCommandProof,
        )) {
          throw new Error(`Exact tracked recorder process identity changed: ${handle.pid}`);
        }
      }
      if (!exited) {
        throw new Error(`Exact tracked recorder did not exit after bounded signal escalation: ${handle.pid}`);
      }
    }
    if (record.child.pid !== handle.pid) {
      throw new Error(`Exact tracked recorder direct child identity changed: ${handle.pid}`);
    }
    if (processRegistry.recorders.get(handle.pid) !== record) {
      throw new Error(`Exact tracked recorder registry changed during stop: ${handle.pid}`);
    }
    try {
      await waitForRecorderChildClose(record.stream);
      await finalizeRawRecorderOutput(record.stream);
      const cleanNaturalExit = stopSignal === undefined
        && record.child.exitCode === 0
        && record.child.signalCode === null;
      const cleanRequestedInterrupt = stopSignal === "SIGINT" && (
        (record.child.exitCode === 0 && record.child.signalCode === null)
        || (record.child.exitCode === null && record.child.signalCode === "SIGINT")
      );
      if (!cleanNaturalExit && !cleanRequestedInterrupt) {
        throw new Error(
          "Android screenrecord required or received forced termination or nonzero status; raw media is unpublishable",
        );
      }
      if (processRegistry.recorders.get(handle.pid) !== record) {
        throw new Error(`Exact tracked recorder registry changed during stream finalization: ${handle.pid}`);
      }
      processRegistry.recorders.delete(handle.pid);
      return Object.freeze({ stopped: true, pid: handle.pid });
    } catch (error) {
      if (
        record.stream.childClosed
        && record.stream.streamEnded
        && record.stream.closed
      ) {
        if (processRegistry.recorders.get(handle.pid) === record) {
          processRegistry.recorders.delete(handle.pid);
        }
        throw withRecorderQuiescenceProof(error);
      }
      throw error;
    }
  }

  async function remuxAndroidScreenrecord(input) {
    const step = validateScreenrecordRemuxStep(input);
    await canonicalExecutable(fs, input.executable, "ffmpeg");
    await canonicalPrivateRegularFile(fs, step.rawOutputPath, "Android raw H.264 remux input");
    const raw = await fs.lstat(step.rawOutputPath);
    if ((raw.mode & 0o777) !== 0o600 || !Number.isSafeInteger(raw.size) || raw.size <= 0) {
      throw new Error("Android raw H.264 remux input must be one private nonempty file");
    }
    await canonicalPrivateParent(fs, step.stagedOutputPath, "Android remux output");
    await requireAbsent(fs, step.stagedOutputPath, "Android remux output");
    return runCommand(input.executable, step.args, {
      env: commandEnvironment,
      maxOutputBytes: 1024 * 1024,
      shell: false,
      timeoutMilliseconds: 120_000,
    });
  }

  async function probeAndroidRecording(options) {
    requireObject(options, "Android recording probe options");
    if (!exactKeys(options, ["ffprobePath", "path"])) {
      throw new Error("Android recording probe options must contain only ffprobePath and path");
    }
    await canonicalExecutable(fs, options.ffprobePath, "ffprobe");
    const recordingPath = await canonicalPrivateRegularFile(
      fs,
      options.path,
      "Android recording probe path",
    );
    const result = await runCommand(options.ffprobePath, [
      "-v",
      "error",
      "-print_format",
      "json",
      "-show_format",
      "-show_streams",
      "-show_packets",
      "-count_frames",
      "-count_packets",
      "--",
      recordingPath,
    ], {
      env: commandEnvironment,
      maxOutputBytes: MAX_COMMAND_OUTPUT_BYTES,
      shell: false,
      timeoutMilliseconds: 15_000,
    });
    const source = commandOutput(result, "ffprobe", MAX_COMMAND_OUTPUT_BYTES);
    let parsed;
    try {
      parsed = JSON.parse(source);
    } catch {
      throw new Error("ffprobe did not return valid JSON");
    }
    if (
      !parsed
      || typeof parsed !== "object"
      || Array.isArray(parsed)
      || !Array.isArray(parsed.streams)
      || !Array.isArray(parsed.packets)
      || !parsed.format
      || typeof parsed.format !== "object"
      || Array.isArray(parsed.format)
    ) {
      throw new Error("ffprobe must return an object with streams, packets, and format");
    }
    return Object.freeze(parsed);
  }

  async function runKindMakePlan(input, lifecycle = {}) {
    const plan = await validateKindMakePlan(input, fs);
    if (!lifecycle || typeof lifecycle !== "object" || Array.isArray(lifecycle)) {
      throw new Error("Kind Make lifecycle boundary must be an object");
    }
    if (
      plan.args[0] === "kind-up"
      && (
        !exactKeys(lifecycle, ["completeKindCreation"])
        || typeof lifecycle.completeKindCreation !== "function"
      )
    ) {
      throw new Error("Kind-up requires an exact creation witness callback");
    }
    if (plan.args[0] === "kind-down" && Object.keys(lifecycle).length !== 0) {
      throw new Error("Kind-down does not accept a creation witness callback");
    }
    let commandResult;
    try {
      commandResult = await runCommand(plan.executable, [...plan.args], {
        cwd: plan.cwd,
        env: toolEnvironment(baseEnvironment, plan.environment),
        maxOutputBytes: MAX_COMMAND_OUTPUT_BYTES,
        shell: false,
        timeoutMilliseconds: KIND_TIMEOUT_MILLISECONDS,
      });
      if (Object.hasOwn(commandResult ?? {}, "exitCode") && commandResult.exitCode !== 0) {
        throw new Error("Kind Make returned a nonzero exit status");
      }
    } catch {
      const failure = new Error(`Kind Make target ${plan.args[0]} failed`);
      if (plan.args[0] === "kind-up") {
        try {
          const evidence = exactKindCreationEvidence(await readKindCreationProof(
            plan.environment.KIND_CREATION_PROOF_FILE,
          ));
          attachKindCreationEvidence(failure, evidence);
        } catch {
          // No exact completed creation proof means cleanup must remain
          // unbound and non-destructive.
        }
      }
      throw failure;
    }
    if (plan.args[0] === "kind-down") return commandResult;
    const evidence = exactKindCreationEvidence(await readKindCreationProof(
      plan.environment.KIND_CREATION_PROOF_FILE,
    ));
    let creationWitness;
    try {
      creationWitness = await lifecycle.completeKindCreation(evidence);
      if (!creationWitness || typeof creationWitness !== "object") {
        throw new Error("Kind-up did not return an exact creation witness");
      }
    } catch {
      throw attachKindCreationEvidence(
        new Error("Kind-up creation witness completion failed"),
        evidence,
      );
    }
    return Object.freeze({ ...commandResult, creationWitness });
  }

  return Object.freeze({
    launchOwnedEmulator,
    probeAndroidRecording,
    remuxAndroidScreenrecord,
    rollbackOwnedEmulator,
    runKindMakePlan,
    startAndroidScreenrecord,
    stopAndroidScreenrecord,
    waitForOwnedAvdBoot,
  });
}
