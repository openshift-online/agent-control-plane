import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { mkdir, mkdtemp, open, readFile, realpath, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PINNED_CHROME_FOR_TESTING_VERSION,
  cleanupFailure,
  resolveCaptureConfig,
  validateCaptureConfig,
} from "./common.mjs";
import { captureLinux, doctorLinux } from "./linux/index.mjs";
import { captureMacos, doctorMacos } from "./macos/index.mjs";
import { captureAndroid, doctorAndroid } from "./android/index.mjs";
import { buildExtensionGate } from "../extension/gate.mjs";
import { cleanupAcpProject, seedAcpProject, verifyAcpProject } from "../acp/index.mjs";
import { assertAndroidApkLock } from "../core/android-apk-lock.mjs";
import {
  ANDROID_AUTHORED_CAPTURE_MAX_MILLISECONDS,
  ANDROID_AUTHORED_CAPTURE_MAX_SECONDS,
  ANDROID_PUBLIC_VALIDATION_EVIDENCE_KEYS,
  ANDROID_RUNTIME_VALIDATION_EVIDENCE_KEYS,
  ANDROID_TOOLCHAIN_NAMES,
  ANDROID_TOOLCHAIN_SPEC,
} from "../core/android-contract.mjs";

const captureDir = path.dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = path.resolve(captureDir, "../../../../..");

const ANDROID_CAPTURE_KIND = "android-emulator";
const ANDROID_ENVIRONMENT_KEYS = new Set([
  "ACP_URL",
  "ACP_PROJECT",
  "ACP_BEARER_TOKEN",
]);
const ANDROID_CAPTURE_OPTION_KEYS = new Set(["dryRun", "runId"]);
const ANDROID_PROJECT = /^demo-[a-z][a-z0-9-]{2,57}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const GIT_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const ANDROID_SOURCE_PATH = "components/mobile";
const ANDROID_SDK_REVISION = /^[0-9]{1,6}(?:\.[0-9]{1,6}){0,3}$/u;
const MIN_REDACTABLE_ENVIRONMENT_VALUE_LENGTH = 8;
const MOBILE_CAPTURE_DURATION_TOLERANCE_SECONDS = 1 / 30 + 0.02;

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isHostAbsolutePath(value) {
  return path.isAbsolute(value) || path.win32.isAbsolute(value);
}

function isPortableRepositoryReference(value) {
  if (typeof value !== "string" || !value.startsWith("repo:") || value.length > 505) return false;
  const relative = value.slice("repo:".length);
  if (relative === "" || relative.includes("\\") || relative.includes(":")
    || path.posix.isAbsolute(relative) || path.win32.isAbsolute(relative)
    || path.posix.normalize(relative) !== relative) return false;
  return relative.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function exactKeys(value, expected, label) {
  if (!isObject(value)) throw new Error(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new Error(`${label} must contain exactly ${wanted.join(", ")}`);
  }
}

function assertPortableJson(value, label, { allowArrays = true } = {}) {
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new Error(`${label} must be JSON-compatible`);
  }
  if (serialized === undefined || serialized.length > 64 * 1024) {
    throw new Error(`${label} exceeds the portable metadata bound`);
  }
  const inspect = (candidate, location) => {
    if (["string", "number", "boolean"].includes(typeof candidate) || candidate === null) {
      if (typeof candidate === "number" && !Number.isFinite(candidate)) {
        throw new Error(`${location} must contain only finite numbers`);
      }
      if (typeof candidate === "string" && isHostAbsolutePath(candidate)) {
        throw new Error(`${location} contains a host-absolute path`);
      }
      return;
    }
    if (Array.isArray(candidate)) {
      if (!allowArrays) throw new Error(`${location} must not inline artifact arrays`);
      if (candidate.length > 100) throw new Error(`${location} contains too many entries`);
      candidate.forEach((child, index) => inspect(child, `${location}[${index}]`));
      return;
    }
    if (!isObject(candidate)) throw new Error(`${location} contains an unsupported value`);
    for (const child of Object.values(candidate)) inspect(child, `${location}.field`);
  };
  inspect(value, label);
  return serialized;
}

function androidDurationMilliseconds(scenario) {
  if (!Array.isArray(scenario?.story)) {
    throw new Error("Android scenario.story must be an array");
  }
  const mobileSegments = scenario.story.filter((segment) => segment?.type === "mobile");
  if (mobileSegments.length === 0 || mobileSegments.some((segment) => (
    typeof segment.durationSeconds !== "number"
    || !Number.isFinite(segment.durationSeconds)
    || segment.durationSeconds <= 0
  ))) {
    throw new Error("Android capture requires each mobile story segment to have a positive numeric duration");
  }
  const durationSeconds = mobileSegments.reduce((sum, segment) => sum + segment.durationSeconds, 0);
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new Error("Android capture requires a positive authored mobile duration budget");
  }
  const durationMilliseconds = Math.ceil(durationSeconds * 1000);
  if (durationMilliseconds > ANDROID_AUTHORED_CAPTURE_MAX_MILLISECONDS) {
    throw new Error(`Android authored mobile duration must be no more than ${ANDROID_AUTHORED_CAPTURE_MAX_SECONDS} seconds`);
  }
  return durationMilliseconds;
}

function boundedAndroidCaptureOptions(value) {
  if (value === undefined) return {};
  if (!isObject(value)) throw new Error("Android captureOptions must be an object");
  for (const key of Object.keys(value)) {
    if (!ANDROID_CAPTURE_OPTION_KEYS.has(key)) {
      throw new Error("Android captureOptions contains an unsupported field");
    }
  }
  if (value.dryRun !== undefined && typeof value.dryRun !== "boolean") {
    throw new Error("Android captureOptions.dryRun must be boolean");
  }
  if (value.runId !== undefined && (
    typeof value.runId !== "string"
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u.test(value.runId)
  )) {
    throw new Error("Android captureOptions.runId must be a bounded identifier");
  }
  return { ...value };
}

function validateAndroidScenarioContract(scenario) {
  const setupActions = scenario?.capture?.android?.setupActions;
  const recordedActions = scenario?.capture?.android?.actions;
  if (!Array.isArray(setupActions)) {
    throw new Error("Android capture.android.setupActions must be an array");
  }
  if (!Array.isArray(recordedActions) || recordedActions.length === 0) {
    throw new Error("Android capture.android.actions must contain at least one recorded action for portable landmarks");
  }
  const required = new Set();
  let ownedUrlActions = 0;
  for (const action of setupActions) {
    if (action?.action !== "fillFromEnvironment") continue;
    if (!ANDROID_ENVIRONMENT_KEYS.has(action.environment)) {
      throw new Error("Unsupported Android setup environment key");
    }
    if (action.environment === "ACP_URL") ownedUrlActions += 1;
    required.add(action.environment);
  }
  if (ownedUrlActions !== 1) {
    throw new Error("Android setupActions must configure ACP_URL exactly once from the owned endpoint");
  }
  if (required.has("ACP_PROJECT") && (
    typeof scenario.acp?.project !== "string"
    || scenario.acp.project.length > 63
    || !ANDROID_PROJECT.test(scenario.acp.project)
  )) {
    throw new Error("Android authored nonsecret acp.project is invalid");
  }
  return required;
}

function androidEnvironment(scenario, sourceEnvironment, dryRun) {
  const required = validateAndroidScenarioContract(scenario);
  if (required.has("ACP_PROJECT")
    && sourceEnvironment.ACP_PROJECT !== undefined
    && sourceEnvironment.ACP_PROJECT !== scenario.acp?.project) {
    throw new Error("ACP_PROJECT must match the authored nonsecret acp.project");
  }
  const selected = {};
  for (const name of required) {
    if (name === "ACP_URL") continue;
    const value = sourceEnvironment[name];
    if (dryRun && value === undefined) continue;
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`${name} is required by capture.android.setupActions`);
    }
    if (name !== "ACP_PROJECT" && value.length < MIN_REDACTABLE_ENVIRONMENT_VALUE_LENGTH) {
      throw new Error("Android setup environment value is too short for reliable exact-value redaction");
    }
    if (!dryRun) selected[name] = value;
  }
  return dryRun ? {} : selected;
}

function assertNoEnvironmentSecrets(value, environment) {
  const secrets = Object.entries(environment)
    .filter(([name, secret]) => name !== "ACP_PROJECT" && typeof secret === "string" && secret.length > 0)
    .map(([, secret]) => secret);
  const secretRepresentations = secrets.flatMap((secret) => [
    secret,
    JSON.stringify(secret).slice(1, -1),
    encodeURIComponent(secret),
    Buffer.from(secret, "utf8").toString("base64"),
    Buffer.from(secret, "utf8").toString("base64url"),
  ]).filter((secret, index, values) => secret.length > 0 && values.indexOf(secret) === index);
  const seen = new WeakSet();
  const inspect = (candidate) => {
    if (typeof candidate === "string") {
      if (secretRepresentations.some((secret) => candidate.includes(secret))) {
        throw new Error("Android capture metadata contains an environment secret");
      }
      return;
    }
    if (candidate === null || typeof candidate !== "object" || seen.has(candidate)) return;
    seen.add(candidate);
    if (Array.isArray(candidate)) {
      for (const child of candidate) inspect(child);
    } else {
      for (const [key, child] of Object.entries(candidate)) {
        inspect(key);
        inspect(child);
      }
    }
  };
  inspect(value);
}

async function androidRuntimeRoot({ dryRun, runId }) {
  if (dryRun) {
    const markerRoot = path.join(os.tmpdir(), `acp-demo-android-dry-${runId}`);
    return { markerRoot, avdRoot: path.join(markerRoot, "avds"), owned: false };
  }
  const createdRoot = await mkdtemp(path.join(os.tmpdir(), "acp-demo-android-"));
  try {
    const markerRoot = await realpath(createdRoot);
    const avdRoot = path.join(markerRoot, "avds");
    await mkdir(avdRoot, { mode: 0o700 });
    return { markerRoot, avdRoot, owned: true };
  } catch (error) {
    await rm(createdRoot, { recursive: true, force: true });
    throw error;
  }
}

async function defaultHashArtifact({ handle }) {
  const hash = createHash("sha256");
  for await (const chunk of handle.createReadStream({ autoClose: false, start: 0 })) hash.update(chunk);
  return hash.digest("hex");
}

function sameOpenIdentity(before, after) {
  return before.dev === after.dev
    && before.ino === after.ino
    && before.size === after.size
    && before.mtimeMs === after.mtimeMs
    && before.ctimeMs === after.ctimeMs;
}

async function verifiedOutputFile(outputDir, filePath, label, dependencies, expectedSha256) {
  if (typeof filePath !== "string" || filePath.length === 0 || filePath.includes("\0")) {
    throw new Error(`${label}.path must be a non-empty path`);
  }
  if (path.win32.isAbsolute(filePath) && !path.isAbsolute(filePath)) {
    throw new Error(`${label}.path contains a host-absolute path`);
  }
  if (expectedSha256 !== undefined && !SHA256.test(expectedSha256)) {
    throw new Error(`${label}.sha256 must be a SHA-256 digest`);
  }
  const outputRoot = await realpath(outputDir);
  const requested = path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(outputRoot, filePath);
  let canonical;
  try {
    canonical = await realpath(requested);
  } catch {
    throw new Error(`${label}.path does not name a captured file`);
  }
  const relative = path.relative(outputRoot, canonical);
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${label}.path escapes outputDir`);
  }
  const handle = await open(canonical, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error(`${label}.path must name a regular file`);
    const digest = await (dependencies.hashArtifact ?? defaultHashArtifact)({ handle, label, canonicalPath: canonical });
    if (!SHA256.test(digest)) throw new Error(`${label} hasher returned an invalid digest`);
    const [after, currentPath, currentIdentity] = await Promise.all([
      handle.stat(),
      realpath(requested),
      stat(canonical),
    ]);
    if (currentPath !== canonical || !sameOpenIdentity(before, after) || !sameOpenIdentity(before, currentIdentity)) {
      throw new Error(`${label} changed identity during hashing`);
    }
    if (expectedSha256 !== undefined && digest !== expectedSha256) {
      throw new Error(`${label} digest does not match captured bytes`);
    }
    return { path: relative.split(path.sep).join("/"), sha256: digest };
  } finally {
    await handle.close();
  }
}

async function portableArtifact(outputDir, artifact, label, dependencies) {
  exactKeys(artifact, ["path", "sha256"], `Android ${label} artifact`);
  return verifiedOutputFile(
    outputDir,
    artifact.path,
    `Android ${label}`,
    dependencies,
    artifact.sha256,
  );
}

async function verifiedRepositoryArtifact(repoRoot, reference, label, dependencies, expectedSha256) {
  if (!isPortableRepositoryReference(reference)) {
    throw new Error(`${label} must be a portable repository reference`);
  }
  const canonicalRoot = await realpath(repoRoot);
  const requested = path.resolve(canonicalRoot, reference.slice("repo:".length));
  const canonical = await realpath(requested);
  if (canonical !== requested) throw new Error(`${label} must not resolve through symlinks`);
  return verifiedOutputFile(canonicalRoot, canonical, label, dependencies, expectedSha256);
}

async function verifiedAndroidLock(repoRoot, android, dependencies) {
  const artifact = await verifiedRepositoryArtifact(
    repoRoot,
    android.apk.lock.ref,
    "Android repository APK lock",
    dependencies,
    android.apk.lock.sha256,
  );
  const lockPath = path.resolve(await realpath(repoRoot), artifact.path);
  const bytes = await readFile(lockPath);
  if (bytes.length === 0 || bytes.length > 64 * 1024
    || createHash("sha256").update(bytes).digest("hex") !== android.apk.lock.sha256) {
    throw new Error("Android repository APK lock changed while it was validated");
  }
  let lock;
  try {
    lock = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("Android repository APK lock is not valid JSON");
  }
  assertAndroidApkLock(lock, android.apk, "Android capture APK identity does not match the repository lock");
}

function validateAndroidMetadata(android, authoredAndroid) {
  exactKeys(android, ["apk", "systemImage", "toolchain"], "Android capture.android");
  exactKeys(android.apk, ["applicationId", "apkanalyzer", "lock", "ref", "sha256", "source", "versionCode", "versionName"], "Android capture.android.apk");
  if (!isPortableRepositoryReference(android.apk.ref) || !SHA256.test(android.apk.sha256)) {
    throw new Error("Android capture.android.apk must contain portable ref and digest evidence");
  }
  exactKeys(android.apk.lock, ["ref", "sha256"], "Android capture.android.apk.lock");
  if (!isPortableRepositoryReference(android.apk.lock.ref) || !SHA256.test(android.apk.lock.sha256)) {
    throw new Error("Android capture.android.apk.lock must contain portable ref and digest evidence");
  }
  if (typeof android.apk.applicationId !== "string" || android.apk.applicationId.length === 0
    || typeof android.apk.versionName !== "string" || android.apk.versionName.length === 0
    || typeof android.apk.versionCode !== "string" || !/^[1-9][0-9]*$/u.test(android.apk.versionCode)) {
    throw new Error("Android capture.android.apk application and version identity is malformed");
  }
  exactKeys(android.apk.source, ["commit", "path", "tree"], "Android capture.android.apk.source");
  if (!GIT_OBJECT_ID.test(android.apk.source.commit ?? "")
    || !GIT_OBJECT_ID.test(android.apk.source.tree ?? "")
    || android.apk.source.path !== ANDROID_SOURCE_PATH) {
    throw new Error("Android capture.android.apk.source identity is malformed");
  }
  exactKeys(android.apk.apkanalyzer, ["identity", "version"], "Android capture.android.apk.apkanalyzer");
  for (const field of ["identity", "version"]) {
    if (typeof android.apk.apkanalyzer[field] !== "string" || android.apk.apkanalyzer[field].length === 0) {
      throw new Error("Android capture.android.apk.apkanalyzer identity is malformed");
    }
  }
  exactKeys(android.systemImage, ["package", "revision"], "Android capture.android.systemImage");
  if (typeof android.systemImage.package !== "string" || android.systemImage.package.length === 0
    || typeof android.systemImage.revision !== "string"
    || !ANDROID_SDK_REVISION.test(android.systemImage.revision)) {
    throw new Error("Android capture.android.systemImage is malformed");
  }
  exactKeys(android.toolchain, ANDROID_TOOLCHAIN_NAMES, "Android capture.android.toolchain");
  for (const [name, tool] of Object.entries(android.toolchain)) {
    const keys = ANDROID_TOOLCHAIN_SPEC[name];
    exactKeys(tool, keys, `Android capture.android.toolchain.${name}`);
    if (keys.some((key) => typeof tool[key] !== "string" || tool[key].length === 0)) {
      throw new Error(`Android capture.android.toolchain.${name} identity is malformed`);
    }
  }
  if (android.apk.ref !== authoredAndroid.apk
    || android.apk.lock.ref !== authoredAndroid.apkLock
    || android.apk.applicationId !== authoredAndroid.expectedApplicationId
    || android.systemImage.package !== authoredAndroid.systemImage) {
    throw new Error("Android capture identity does not match the authored scenario");
  }
}

async function mapAndroidResult(result, outputDir, repoRoot, scenario, environment, dependencies) {
  exactKeys(result, ["source", "android", "artifacts", "lifecycle"], "Android capture result");
  exactKeys(result.source, ["type", "width", "height", "landmarks", "validationEvidence"], "Android source");
  if (result.source.type !== "mobile") throw new Error("Android source.type must be mobile");
  for (const dimension of ["width", "height"]) {
    if (!Number.isInteger(result.source[dimension]) || result.source[dimension] <= 0) {
      throw new Error(`Android source.${dimension} must be a positive integer`);
    }
  }
  if (!Array.isArray(result.source.landmarks) || result.source.landmarks.length === 0) {
    throw new Error("Android source.landmarks must contain at least one portable landmark");
  }
  assertPortableJson(result.source.landmarks, "Android source.landmarks");
  assertPortableJson(result.source.validationEvidence, "Android source.validationEvidence", { allowArrays: false });
  exactKeys(
    result.source.validationEvidence,
    ANDROID_RUNTIME_VALIDATION_EVIDENCE_KEYS,
    "Android source.validationEvidence",
  );
  const authoredDurationSeconds = androidDurationMilliseconds(scenario) / 1000;
  const capturedDurationSeconds = result.source.validationEvidence.durationSeconds;
  if (!Number.isFinite(capturedDurationSeconds)
    || capturedDurationSeconds <= 0
    || Math.abs(capturedDurationSeconds - authoredDurationSeconds) > MOBILE_CAPTURE_DURATION_TOLERANCE_SECONDS) {
    throw new Error(
      `Android source duration must match the authored mobile budget within ${MOBILE_CAPTURE_DURATION_TOLERANCE_SECONDS} seconds`,
    );
  }
  assertPortableJson(result.android, "Android capture.android");
  validateAndroidMetadata(result.android, scenario.capture.android);
  await verifiedRepositoryArtifact(
    repoRoot,
    result.android.apk.ref,
    "Android repository APK",
    dependencies,
    result.android.apk.sha256,
  );
  await verifiedAndroidLock(repoRoot, result.android, dependencies);
  exactKeys(result.lifecycle, ["acpReverse", "avd", "cluster"], "Android lifecycle");
  for (const name of ["cluster", "avd", "acpReverse"]) {
    exactKeys(result.lifecycle[name], ["ownershipVerified", "status"], `Android lifecycle.${name}`);
    if (result.lifecycle[name].status !== "deleted" || result.lifecycle[name].ownershipVerified !== true) {
      throw new Error(`Android lifecycle.${name} must prove owned deletion`);
    }
  }
  assertNoEnvironmentSecrets(result, environment);
  exactKeys(result.artifacts, ["androidApkLock", "mobileCapture", "pointerEvents"], "Android artifacts");
  const [mobileCapture, pointerEvents, androidApkLock] = await Promise.all([
    portableArtifact(outputDir, result.artifacts.mobileCapture, "mobileCapture", dependencies),
    portableArtifact(outputDir, result.artifacts.pointerEvents, "pointerEvents", dependencies),
    portableArtifact(outputDir, result.artifacts.androidApkLock, "androidApkLock", dependencies),
  ]);
  if (androidApkLock.sha256 !== result.android.apk.lock.sha256) {
    throw new Error("Android androidApkLock digest does not match capture.android.apk.lock");
  }
  const source = {
    ...result.source,
    validationEvidence: {
      ...result.source.validationEvidence,
      artifactSha256: {
        mobileCapture: mobileCapture.sha256,
        pointerEvents: pointerEvents.sha256,
        androidApkLock: androidApkLock.sha256,
      },
    },
  };
  exactKeys(
    source.validationEvidence,
    ANDROID_PUBLIC_VALIDATION_EVIDENCE_KEYS,
    "Android public source.validationEvidence",
  );
  return {
    capture: {
      schemaVersion: 1,
      kind: ANDROID_CAPTURE_KIND,
      platform: ANDROID_CAPTURE_KIND,
      source,
      android: result.android,
      lifecycle: result.lifecycle,
    },
    artifacts: {
      mobileCapture: mobileCapture.path,
      pointerEvents: pointerEvents.path,
      androidApkLock: androidApkLock.path,
    },
  };
}

function provesOwnedAndroidCleanup(result) {
  return result?.lifecycle?.cluster?.status === "deleted"
    && result.lifecycle.cluster.ownershipVerified === true
    && result?.lifecycle?.avd?.status === "deleted"
    && result.lifecycle.avd.ownershipVerified === true
    && result?.lifecycle?.acpReverse?.status === "deleted"
    && result.lifecycle.acpReverse.ownershipVerified === true;
}

async function captureAndroidScenario(context, dependencies) {
  const captureOptions = boundedAndroidCaptureOptions(context.captureOptions);
  const dryRun = captureOptions.dryRun === true;
  const sourceEnvironment = dependencies.environment ?? process.env;
  const environment = androidEnvironment(context.scenario, sourceEnvironment, dryRun);
  const runId = captureOptions.runId ?? randomUUID();
  const authoredDurationMs = androidDurationMilliseconds(context.scenario);
  const runtimeRoot = await androidRuntimeRoot({ dryRun, runId });
  const repoRoot = context.repoRoot ?? defaultRepoRoot;
  const config = {
    repoRoot,
    scenarioId: context.scenario.id,
    scenarioDir: context.scenarioDir,
    runId,
    markerRoot: runtimeRoot.markerRoot,
    outputDir: context.outputDir,
    width: 1080,
    height: 1920,
    authoredDurationMs,
    capture: context.scenario.capture,
    captureOptions,
    dryRun,
  };
  let cleanupPrivateRoot = false;
  try {
    const result = await (dependencies.captureAndroid ?? captureAndroid)(config, {
      ...dependencies.androidCaptureDependencies,
      avdRoot: runtimeRoot.avdRoot,
      environment,
    });
    if (result?.dryRun === true) {
      if (!dryRun) throw new Error("Android runtime returned dry-run output for a live capture");
      assertNoEnvironmentSecrets(result, environment);
      return result;
    }
    if (dryRun) throw new Error("Android dry-run capture must return dryRun true");
    cleanupPrivateRoot = provesOwnedAndroidCleanup(result);
    const mapped = await mapAndroidResult(
      result,
      context.outputDir,
      repoRoot,
      context.scenario,
      environment,
      dependencies,
    );
    cleanupPrivateRoot = true;
    return mapped;
  } catch (error) {
    if (error?.ownedCleanupCompleted === true) {
      cleanupPrivateRoot = true;
    }
    throw error;
  } finally {
    if (runtimeRoot.owned && cleanupPrivateRoot) {
      await rm(runtimeRoot.markerRoot, { recursive: true, force: true });
    }
  }
}

export async function captureScenario(context, dependencies = {}) {
  if (!context?.scenario || !context.outputDir) {
    throw new Error("captureScenario requires scenario and outputDir context");
  }
  if (context.scenario.capture?.kind === ANDROID_CAPTURE_KIND) {
    return captureAndroidScenario(context, dependencies);
  }
  const operations = {
    buildExtensionGate,
    captureLinux,
    captureMacos,
    cleanupAcpProject,
    seedAcpProject,
    verifyAcpProject,
    ...dependencies,
  };
  const sourceEnvironment = dependencies.environment ?? process.env;
  const dryRun = context.captureOptions?.dryRun === true || sourceEnvironment.DEMO_CAPTURE_DRY_RUN === "1";
  const hasAcpEnvironment = ["ACP_URL", "ACP_PROJECT", "ACP_BEARER_TOKEN"].every((name) => sourceEnvironment[name]);
  let lifecycle;
  let seeded = false;
  let result;
  let captureExtension;
  let primaryError;
  const repoRoot = context.repoRoot ?? defaultRepoRoot;
  if (dryRun) {
    lifecycle = hasAcpEnvironment
      ? { seed: (await operations.seedAcpProject(context.scenario, { dryRun: true, environment: sourceEnvironment })).action }
      : { seed: "skipped-dry-run-no-environment" };
  } else {
    lifecycle = {};
  }
  try {
    if (!dryRun) {
      const seed = await operations.seedAcpProject(context.scenario, { environment: sourceEnvironment });
      seeded = true;
      const verified = await operations.verifyAcpProject(context.scenario, { environment: sourceEnvironment });
      lifecycle = { seed: seed.action, verify: verified.action };
      captureExtension = await operations.buildExtensionGate({
        repoRoot,
        outputRoot: path.join(context.outputDir, "extension"),
        expectedExtensionId: context.scenario.extension?.expectedId,
      });
    }
    const config = resolveCaptureConfig({
      ...context,
      repoRoot,
      captureExtension,
      environment: sourceEnvironment,
    });
    validateCaptureConfig(config);
    if (config.platform === "darwin" || config.platform === "macos") {
      result = await operations.captureMacos(config);
    } else if (config.platform === "linux") {
      result = await operations.captureLinux(config);
    } else {
      throw new Error(`native browser capture is unsupported on ${config.platform}`);
    }
    if (dryRun !== Boolean(result.dryRun)) {
      throw new Error(`capture dry-run contract violated: expected dryRun=${dryRun} but capture returned dryRun=${Boolean(result.dryRun)}`);
    }
    if (dryRun) return { ...result, lifecycle };
  } catch (error) {
    primaryError = error;
  } finally {
    if (seeded) {
      const keepProject = context.keepProject === true;
      try {
        const cleanup = await operations.cleanupAcpProject(context.scenario, {
          environment: sourceEnvironment,
          expectPresent: true,
          keepProject,
        });
        lifecycle.cleanup = cleanup.action;
      } catch (error) {
        const failure = cleanupFailure(primaryError, [error]);
        if (failure) primaryError = failure;
      }
    }
  }
  if (primaryError) throw primaryError;
  const config = resolveCaptureConfig({
    ...context,
    repoRoot,
    captureExtension,
    environment: sourceEnvironment,
  });
  if (result.extension?.sha256 !== captureExtension.lock?.artifact?.sha256) {
    throw new Error("captured extension digest does not match the extension lock");
  }
  const [browserCapture, pointerEvents, pointerEventsRaw, extensionLock, extensionZip] = await Promise.all([
    verifiedOutputFile(config.outputDir, result.rawVideo, "browserCapture", dependencies),
    verifiedOutputFile(config.outputDir, result.pointerEvents, "pointerEvents", dependencies),
    verifiedOutputFile(config.outputDir, result.pointerEventsRaw, "pointerEventsRaw", dependencies),
    verifiedOutputFile(config.outputDir, captureExtension.lockPath, "extensionLock", dependencies),
    verifiedOutputFile(
      config.outputDir,
      captureExtension.zipPath,
      "extensionZip",
      dependencies,
      captureExtension.lock.artifact.sha256,
    ),
  ]);
  return {
    capture: {
      schemaVersion: 1,
      platform: result.platform,
      nativeBrowser: true,
      isolatedProfile: true,
      profileRetained: result.profileRetained,
      extensionId: result.extension.extensionId,
      extensionSha256: result.extension.sha256,
      panelDriver: result.panel.driver,
      panelTargetType: result.panel.type ?? "other",
      actionCount: result.panel.actionCount ?? 0,
      browserVersion: PINNED_CHROME_FOR_TESTING_VERSION,
      lifecycle,
    },
    artifacts: {
      browserCapture: browserCapture.path,
      pointerEvents: pointerEvents.path,
      pointerEventsRaw: pointerEventsRaw.path,
      extensionLock: extensionLock.path,
      extensionZip: extensionZip.path,
    },
  };
}

export async function doctorCapture(context = {}, dependencies = {}) {
  if (context.scenario?.capture?.kind === ANDROID_CAPTURE_KIND) {
    validateAndroidScenarioContract(context.scenario);
    androidDurationMilliseconds(context.scenario);
    return (dependencies.doctorAndroid ?? doctorAndroid)(
      context.scenario.capture,
      dependencies.androidDoctorDependencies,
    );
  }
  const config = resolveCaptureConfig(context);
  validateCaptureConfig(config, { live: false });
  if (config.platform === "darwin" || config.platform === "macos") return doctorMacos(config);
  if (config.platform === "linux") return doctorLinux(config);
  return {
    platform: config.platform,
    ok: false,
    checks: [{ name: "platform", ok: false, detail: "native capture requires macOS or Linux" }],
  };
}
