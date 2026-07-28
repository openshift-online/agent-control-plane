import { createHash } from "node:crypto";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import {
  ANDROID_ACTION_SETTLING_MILLISECONDS,
  auditAndroidSetupUiForSecrets,
  executeAndroidActions,
  validateAndroidActions,
} from "./actions.mjs";
import { verifyAndroidApkGate } from "./apk-gate.mjs";
import {
  assertOwnedAvdReady,
  bindAvdProcess,
  createOwnedEmulatorLaunchPlan,
  reserveAvdOwnership,
  teardownOwnedAvd,
} from "./avd-lifecycle.mjs";
import { doctorAndroid } from "./doctor.mjs";
import {
  assertOwnedKindClusterReady,
  beginKindClusterCreation,
  bindKindCluster,
  completeKindClusterCreation,
  reserveKindClusterOwnership,
  teardownOwnedKindCluster,
  verifyOwnedKindAcpEndpoint,
} from "./kind-lifecycle.mjs";
import { prepareIsolatedKindWorkspace } from "./kind-workspace.mjs";
import {
  createAndroidOperations,
  createAndroidProcessRegistry,
  createAvdLifecycleDeps,
  createKindLifecycleDeps,
  prepareAndroidRunDirectories,
} from "./operations.mjs";
import { createAndroidPointerRecorder } from "./pointer-events.mjs";
import {
  publishAndroidCaptureBundle,
  sha256CanonicalAndroidPointerEvents,
} from "./publication.mjs";
import {
  cleanupAdbScreenrecordStage,
  createAdbScreenrecordPlan,
  createAdbScreenrecordStage,
  publishAdbScreenrecordOutput,
  validateStagedAdbScreenrecordOutput,
} from "./recording.mjs";

const MAX_CAPTURE_DURATION_MILLISECONDS = 179_000;
const ANDROID_RECORDING_FRAME_SECONDS = 1 / 30;
const FORBIDDEN_RESOURCE_KEYS = new Set([
  "avdName",
  "avdPath",
  "clusterName",
  "context",
  "kubeContext",
  "markerPath",
  "serial",
]);
const CONFIG_KEYS = new Set([
  "repoRoot",
  "scenarioId",
  "runId",
  "markerRoot",
  "outputDir",
  "width",
  "height",
  "authoredDurationMs",
  "capture",
  "scenarioDir",
  "captureOptions",
  "dryRun",
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

const defaultOperations = Object.freeze({
  assertOwnedAvdReady,
  assertOwnedKindClusterReady,
  auditAndroidSetupUiForSecrets,
  beginKindClusterCreation,
  bindAvdProcess,
  bindKindCluster,
  completeKindClusterCreation,
  createAdbScreenrecordPlan,
  createAdbScreenrecordStage,
  cleanupAdbScreenrecordStage,
  createAndroidPointerRecorder,
  createOwnedEmulatorLaunchPlan,
  doctorAndroid,
  executeAndroidActions,
  prepareAndroidRunDirectories,
  prepareIsolatedKindWorkspace,
  publishAdbScreenrecordOutput,
  publishAndroidCaptureBundle,
  reserveAvdOwnership,
  reserveKindClusterOwnership,
  teardownOwnedAvd,
  teardownOwnedKindCluster,
  verifyOwnedKindAcpEndpoint,
  validateStagedAdbScreenrecordOutput,
  validateAndroidActions,
  verifyAndroidApkGate,
});

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKindDeletionProof(value, ownership) {
  if (!isObject(value)) throw new Error("Kind deletion requires exact bound ownership proof");
  const keys = Object.keys(value).sort();
  const expectedKeys = [
    "clusterName",
    "containerIdentities",
    "kubeContext",
    "kubeServer",
  ].sort();
  if (JSON.stringify(keys) !== JSON.stringify(expectedKeys)) {
    throw new Error("Kind deletion proof fields are not exact");
  }
  if (
    value.clusterName !== ownership.clusterName
    || value.kubeContext !== ownership.kubeContext
    || value.kubeServer !== ownership.kubeServer
    || !Array.isArray(value.containerIdentities)
    || JSON.stringify(value.containerIdentities) !== JSON.stringify(ownership.containerIdentities)
  ) {
    throw new Error("Kind deletion proof does not match the exact bound cluster identity");
  }
  return value;
}

function exactRecoveredBoundOwnership(error, reservation, kind) {
  const descriptor = Object.getOwnPropertyDescriptor(error, "recoveredBoundOwnership");
  if (descriptor === undefined) return undefined;
  if (descriptor.enumerable || !("value" in descriptor) || !isObject(descriptor.value)) {
    throw new Error(`Recovered bound ${kind} ownership proof is invalid`);
  }
  const recovered = descriptor.value;
  for (const [field, value] of Object.entries(reservation)) {
    if (recovered[field] !== value) {
      throw new Error(`Recovered bound ${kind} ownership changed ${field}`);
    }
  }
  if (kind === "Kind") {
    if (
      typeof recovered.kubeServer !== "string"
      || recovered.kubeServer.length === 0
      || !Array.isArray(recovered.containerIdentities)
      || recovered.containerIdentities.length === 0
      || recovered.containerIdentities.some((identity) => (
        typeof identity !== "string" || identity.length === 0
      ))
      || new Set(recovered.containerIdentities).size !== recovered.containerIdentities.length
    ) {
      throw new Error("Recovered bound Kind ownership proof is incomplete");
    }
  } else {
    const serialMatch = /^emulator-([1-9][0-9]{0,4})$/u.exec(recovered.serial);
    if (
      !serialMatch
      || Number(serialMatch[1]) !== recovered.consolePort
      || !Number.isInteger(recovered.pid)
      || recovered.pid < 1
      || typeof recovered.processStartIdentity !== "string"
      || recovered.processStartIdentity.length === 0
    ) {
      throw new Error("Recovered bound AVD ownership proof is incomplete");
    }
  }
  return recovered;
}

function exactFailedKindCreationEvidence(error) {
  const descriptor = Object.getOwnPropertyDescriptor(error, "kindCreationEvidence");
  if (descriptor === undefined) return undefined;
  if (
    descriptor.enumerable
    || descriptor.configurable
    || descriptor.writable
    || !("value" in descriptor)
    || !isObject(descriptor.value)
    || !Object.isFrozen(descriptor.value)
    || JSON.stringify(Object.keys(descriptor.value)) !== JSON.stringify(["containerIdentities"])
  ) {
    throw new Error("Failed Kind creation evidence is not an exact static proof");
  }
  const identities = descriptor.value.containerIdentities;
  if (
    !Array.isArray(identities)
    || !Object.isFrozen(identities)
    || identities.length !== 1
    || identities.some((identity) => !/^[0-9a-f]{64}$/u.test(identity))
    || JSON.stringify(identities) !== JSON.stringify([...identities].toSorted())
  ) {
    throw new Error("Failed Kind creation evidence has invalid container identities");
  }
  return descriptor.value;
}

function bindOwnershipIndeterminate(error) {
  const descriptor = Object.getOwnPropertyDescriptor(error, "bindOwnershipIndeterminate");
  if (descriptor === undefined) return false;
  return descriptor.enumerable === false && descriptor.value === true;
}

function recorderExitUnproved(error) {
  const descriptor = Object.getOwnPropertyDescriptor(error, "recorderExitUnproved");
  if (descriptor === undefined) return false;
  if (
    descriptor.enumerable
    || descriptor.configurable
    || descriptor.writable
    || descriptor.value !== true
  ) {
    throw new Error("Recorder exit proof marker is not an exact static proof");
  }
  return true;
}

function recorderQuiescenceProven(error) {
  const descriptor = Object.getOwnPropertyDescriptor(error, "recorderQuiescenceProven");
  if (descriptor === undefined) return false;
  if (
    descriptor.enumerable
    || descriptor.configurable
    || descriptor.writable
    || descriptor.value !== true
  ) {
    throw new Error("Recorder quiescence proof marker is not an exact static proof");
  }
  return true;
}

function androidMutationQuiescenceUnproved(error) {
  const descriptor = Object.getOwnPropertyDescriptor(error, "androidMutationQuiescenceUnproved");
  if (descriptor === undefined) return false;
  if (
    descriptor.enumerable
    || descriptor.configurable
    || descriptor.writable
    || descriptor.value !== true
  ) {
    throw new Error("Android mutation quiescence marker is not an exact static proof");
  }
  return true;
}

function avdCreationCleanupBlocked(error) {
  const descriptor = Object.getOwnPropertyDescriptor(error, "avdCreationCleanupBlocked");
  if (descriptor === undefined) return false;
  if (
    descriptor.enumerable
    || descriptor.configurable
    || descriptor.writable
    || descriptor.value !== true
  ) {
    throw new Error("AVD creation cleanup marker is not an exact static proof");
  }
  return true;
}

function assertAbsolutePath(value, label) {
  if (typeof value !== "string" || !path.isAbsolute(value) || path.resolve(value) !== value) {
    throw new Error(`${label} must be one normalized absolute path`);
  }
}

function assertBoundedIdentifier(value, label) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u.test(value)) {
    throw new Error(`${label} must be a bounded identifier`);
  }
}

function assertNoAuthoredResourceIdentity(config) {
  const authoredObjects = [
    config,
    config.capture,
    config.capture?.cluster,
    config.capture?.android,
  ];
  if (authoredObjects.some((value) => (
    isObject(value) && Object.keys(value).some((key) => FORBIDDEN_RESOURCE_KEYS.has(key))
  ))) {
    throw new Error("Android capture refuses authored resource identity");
  }
  const clusterKeys = Object.keys(config.capture?.cluster ?? {});
  if (clusterKeys.some((key) => key !== "kind")) {
    throw new Error("Android capture refuses authored resource identity");
  }
}

function validateConfig(config) {
  if (!isObject(config)) throw new Error("captureAndroid requires a config object");
  for (const key of Object.keys(config)) {
    if (!CONFIG_KEYS.has(key)) throw new Error(`captureAndroid config.${key} is not supported`);
  }
  assertNoAuthoredResourceIdentity(config);
  assertAbsolutePath(config.repoRoot, "repoRoot");
  assertAbsolutePath(config.markerRoot, "markerRoot");
  assertAbsolutePath(config.outputDir, "outputDir");
  assertBoundedIdentifier(config.scenarioId, "scenarioId");
  assertBoundedIdentifier(config.runId, "runId");
  if (!Number.isInteger(config.width) || config.width <= 0) {
    throw new Error("Android capture width must be a positive integer");
  }
  if (!Number.isInteger(config.height) || config.height <= 0) {
    throw new Error("Android capture height must be a positive integer");
  }
  if (
    !Number.isInteger(config.authoredDurationMs)
    || config.authoredDurationMs <= 0
    || config.authoredDurationMs > MAX_CAPTURE_DURATION_MILLISECONDS
  ) {
    throw new Error("authoredDurationMs must be an integer from 1 through 179000");
  }
  if (!isObject(config.capture) || !isObject(config.capture.android)) {
    throw new Error("captureAndroid requires capture.android config");
  }
}

function minimumRecordedActionMilliseconds(actions) {
  return actions.reduce((total, action) => (
    total
    + (action.action === "wait" ? action.ms : ANDROID_ACTION_SETTLING_MILLISECONDS)
  ), 0);
}

function requireOperation(operations, name) {
  if (typeof operations[name] !== "function") {
    throw new Error(`captureAndroid requires injected ${name}`);
  }
  return operations[name];
}

async function runWithOwnedAvdReady(operations, ownership, lifecycleDeps, operation) {
  if (typeof operation !== "function") throw new Error("Owned AVD operation must be a function");
  await operations.assertOwnedAvdReady(ownership, lifecycleDeps);
  return operation();
}

function kindNetworkBoundary(clusterName) {
  const bucket = createHash("sha256").update(clusterName).digest().readUInt16BE(0) % 3_000;
  const firstPort = 30_000 + (bucket * 8);
  return Object.freeze({
    frontendPort: firstPort,
    backendPort: firstPort + 1,
    apiServerPort: firstPort + 2,
    ambientUiPort: firstPort + 3,
    keycloakPort: firstPort + 4,
    httpPort: firstPort + 5,
    httpsPort: firstPort + 6,
    devicePort: firstPort + 7,
  });
}

function makeKindPlan({
  target,
  makePath,
  workspaceRoot,
  clusterName,
  kubeconfigPath,
  prepared,
  network,
  containerIdentities = [],
}) {
  return {
    executable: makePath,
    args: [target],
    cwd: workspaceRoot,
    environment: {
      ACP_KIND_CONNECTIONS_FILE: path.join(prepared.kindStateRoot, "connections.json"),
      ACP_KIND_LEGACY_STATE_ROOT: prepared.kindLegacyRoot,
      KIND_CLUSTER_NAME: clusterName,
      CONTAINER_ENGINE: "docker",
      DOCKER_ONLY_KIND_CLUSTER: "true",
      EXPECTED_KIND_CONTAINER_IDS: target === "kind-down"
        ? [...containerIdentities].toSorted().join(",")
        : "",
      HOME: prepared.homeRoot,
      KIND_FWD_AMBIENT_UI_PORT: String(network.ambientUiPort),
      KIND_FWD_API_SERVER_PORT: String(network.apiServerPort),
      KIND_FWD_BACKEND_PORT: String(network.backendPort),
      KIND_FWD_FRONTEND_PORT: String(network.frontendPort),
      KIND_FWD_KEYCLOAK_PORT: String(network.keycloakPort),
      KIND_CREATION_PROOF_FILE: path.join(prepared.kindStateRoot, "creation-container-ids"),
      KIND_HTTP_PORT: String(network.httpPort),
      KIND_HTTPS_PORT: String(network.httpsPort),
      KIND_PF_ROOT: prepared.kindStateRoot,
      KUBECONFIG: kubeconfigPath,
      REQUIRE_NEW_KIND_CLUSTER: "true",
      TMPDIR: prepared.tmpRoot,
      XDG_CONFIG_HOME: prepared.xdgConfigRoot,
      XDG_RUNTIME_DIR: prepared.xdgRuntimeRoot,
    },
  };
}

function assertEmulatorLaunchPlan(plan, { emulatorPath, avdName }) {
  if (!isObject(plan) || plan.executable !== emulatorPath || plan.avdName !== avdName) {
    throw new Error("owned emulator launch plan identity is invalid");
  }
  const vsyncIndexes = plan.args
    .map((argument, index) => argument === "-vsync-rate" ? index : -1)
    .filter((index) => index >= 0);
  if (
    vsyncIndexes.length !== 1
    || plan.args[vsyncIndexes[0] + 1] !== "30"
    || !plan.args.includes("-no-audio")
  ) {
    throw new Error("owned emulator launch must use exact -vsync-rate 30 and no audio");
  }
}

function assertRecordingPlan(plan, {
  adbPath,
  ffmpegPath,
  serial,
  width,
  height,
  durationSeconds,
  authoredDurationMilliseconds,
  minimumDurationSeconds,
  expectedDurationSeconds,
  maxDurationSeconds,
  rawOutputPath,
}) {
  if (
    !isObject(plan)
    || !isObject(plan.record)
    || !isObject(plan.remux)
    || !isObject(plan.validation)
    || !isObject(plan.publish)
  ) {
    throw new Error("Android screenrecord plan is incomplete");
  }
  const args = plan.record.args ?? [];
  const stagedOutputPath = plan.validation.expectedOutputPath;
  const targetFrames = Math.ceil((authoredDurationMilliseconds * 30) / 1_000);
  const expectedRecordArgs = [
    "-s",
    serial,
    "exec-out",
    "screenrecord",
    "--output-format=h264",
    "--size",
    `${width}x${height}`,
    "--bit-rate",
    "8000000",
    "--time-limit",
    String(durationSeconds),
    "-",
  ];
  const expectedRemuxArgs = [
    "-nostdin", "-hide_banner", "-loglevel", "error",
    "-f", "h264", "-framerate", "30", "-i", rawOutputPath,
    "-map", "0:v:0", "-an", "-c:v", "copy", "-frames:v",
    String(targetFrames), "-movflags", "+faststart", stagedOutputPath,
  ];
  if (
    plan.record.executable !== adbPath
    || !Number.isSafeInteger(authoredDurationMilliseconds)
    || authoredDurationMilliseconds < 1
    || expectedDurationSeconds !== authoredDurationMilliseconds / 1_000
    || JSON.stringify(args) !== JSON.stringify(expectedRecordArgs)
    || plan.record.rawOutputPath !== rawOutputPath
    || plan.remux.executable !== ffmpegPath
    || JSON.stringify(plan.remux.args) !== JSON.stringify(expectedRemuxArgs)
    || plan.remux.expectedDurationSeconds !== expectedDurationSeconds
    || plan.remux.rawOutputPath !== rawOutputPath
    || plan.remux.stagedOutputPath !== stagedOutputPath
    || plan.remux.targetFrames !== targetFrames
    || args.some((argument) => ["--fps", "--frame-rate", "--audio"].includes(argument))
    || plan.emulatorLaunch?.frameRate !== 30
    || JSON.stringify(plan.emulatorLaunch?.requiredArgs) !== JSON.stringify(["-vsync-rate", "30"])
    || plan.validation.frameRate !== 30
    || plan.validation.audioStreams !== 0
    || plan.validation.width !== width
    || plan.validation.height !== height
    || plan.validation.minimumDurationSeconds !== minimumDurationSeconds
    || plan.validation.expectedDurationSeconds !== expectedDurationSeconds
    || plan.validation.maxDurationSeconds !== maxDurationSeconds
    || plan.validation.targetFrames !== targetFrames
    || plan.publish.stagedOutputPath !== plan.validation.expectedOutputPath
  ) {
    throw new Error("Android screenrecord plan must stage silent exact 30 FPS media");
  }
}

function assertInstalledIdentity(installed, apk) {
  if (
    installed?.applicationId !== apk.applicationId
    || installed?.versionName !== apk.versionName
    || String(installed?.versionCode) !== String(apk.versionCode)
  ) {
    throw new Error("installed Android application identity does not match the verified APK");
  }
}

function assertStablePortraitGeometry(before, after, width, height) {
  const exactGeometry = (value) => (
    isObject(value)
    && isObject(value.physical)
    && isObject(value.recording)
    && Number.isInteger(value.physical.width)
    && Number.isInteger(value.physical.height)
    && value.recording.width === width
    && value.recording.height === height
    && value.recording.height > value.recording.width
    && value.rotation === 0
  );
  if (
    !exactGeometry(before)
    || !exactGeometry(after)
    || before.physical.width !== after.physical.width
    || before.physical.height !== after.physical.height
    || before.recording.width !== after.recording.width
    || before.recording.height !== after.recording.height
    || before.rotation !== after.rotation
  ) {
    throw new Error("Android display geometry changed during capture");
  }
}

function outputPath(outputDir, relativePath) {
  const candidate = path.resolve(outputDir, relativePath);
  const relative = path.relative(outputDir, candidate);
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Android capture artifact must remain inside outputDir");
  }
  return candidate;
}

function portableToolchain(tools) {
  return Object.fromEntries(Object.entries(tools).map(([name, tool]) => [name, {
    identity: tool.identity,
    ...(tool.version === undefined ? {} : { version: tool.version }),
  }]));
}

function assertArtifactBinding(artifact, expectedPath, label, expectedSha256) {
  if (artifact?.path !== expectedPath && artifact?.outputPath !== expectedPath) {
    throw new Error(`Android capture requires exact ${label} path`);
  }
  if (typeof artifact?.sha256 !== "string" || !/^[0-9a-f]{64}$/u.test(artifact.sha256)) {
    throw new Error(`Android capture requires exact ${label} digest`);
  }
  if (expectedSha256 !== undefined && artifact.sha256 !== expectedSha256) {
    throw new Error(`Android capture requires exact ${label} digest`);
  }
}

function cleanupMessage(error, sensitiveValues = []) {
  let message = error instanceof Error && error.message ? error.message : "cleanup failed";
  for (const value of sensitiveValues) {
    if (typeof value === "string" && value.length > 0) {
      message = message.replaceAll(value, "<redacted>");
    }
  }
  return message;
}

function attachCleanupDiagnostics(primaryError, cleanupDiagnostics) {
  if (cleanupDiagnostics.length === 0) {
    try {
      Object.defineProperty(primaryError, "ownedCleanupCompleted", {
        configurable: true,
        enumerable: false,
        value: true,
      });
      return primaryError;
    } catch {
      const aggregate = new AggregateError(
        [primaryError],
        "Android capture failed after owned cleanup completed",
        { cause: primaryError },
      );
      Object.defineProperty(aggregate, "ownedCleanupCompleted", {
        enumerable: false,
        value: true,
      });
      return aggregate;
    }
  }
  try {
    Object.defineProperty(primaryError, "cleanupDiagnostics", {
      configurable: true,
      enumerable: false,
      value: cleanupDiagnostics,
    });
    return primaryError;
  } catch {
    const aggregate = new AggregateError(
      [primaryError],
      "Android capture failed and cleanup diagnostics could not be attached",
      { cause: primaryError },
    );
    aggregate.cleanupDiagnostics = cleanupDiagnostics;
    return aggregate;
  }
}

function exactSetupEnvironment(setupActions, environment) {
  if (environment !== undefined && !isObject(environment)) {
    throw new Error("Android setup environment must be an object");
  }
  const names = new Set(setupActions
    .filter(({ action }) => action === "fillFromEnvironment")
    .map(({ environment: name }) => name));
  const selected = {};
  for (const name of names) {
    if (name === "ACP_URL") continue;
    const value = environment?.[name];
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`Android setup requires configured environment ${name}`);
    }
    selected[name] = value;
  }
  return selected;
}

function exactToolEnvironment(environment) {
  if (environment === undefined) return undefined;
  if (!isObject(environment)) throw new Error("Android tool environment must be an object");
  return Object.fromEntries(TOOL_ENVIRONMENT_KEYS
    .filter((name) => typeof environment[name] === "string")
    .map((name) => [name, environment[name]]));
}

function completedActionLandmarks(actions, result) {
  if (
    !isObject(result)
    || !Array.isArray(result.completedActions)
    || !Number.isInteger(result.count)
    || result.count !== actions.length
    || result.completedActions.length !== actions.length
    || result.completedActions.some((action, index) => action !== actions[index].action)
  ) {
    throw new Error("recorded Android action results do not prove the authored sequence completed");
  }
  return actions.map((action, index) => ({
    id: `recorded-action-${index + 1}`,
    ordinal: index + 1,
    action: action.action,
    ...(action.selector ? {
      selector: { by: action.selector.by, value: action.selector.value },
    } : {}),
  }));
}

function portableInstalledSystemImage(doctor, expectedPackage) {
  const systemImage = doctor?.sdk?.systemImage;
  if (
    !isObject(systemImage)
    || systemImage.installed !== true
    || systemImage.package !== expectedPackage
    || typeof systemImage.revision !== "string"
    || !/^[0-9]{1,6}(?:\.[0-9]{1,6}){0,3}$/u.test(systemImage.revision)
  ) {
    throw new Error("Android doctor did not prove the exact installed system-image package and revision");
  }
  return Object.freeze({
    package: systemImage.package,
    revision: systemImage.revision,
  });
}

function defaultRegisterInterruptHandlers(handler) {
  process.on("SIGINT", handler);
  process.on("SIGTERM", handler);
  return () => {
    process.off("SIGINT", handler);
    process.off("SIGTERM", handler);
  };
}

function createInterruptController({ registerInterruptHandlers, hardExitOnSecondSignal } = {}) {
  const deliverMutationResults = new Set([
    "beginKindClusterCreation",
    "bindAvdProcess",
    "bindKindCluster",
    "completeKindClusterCreation",
    "createAdbScreenrecordStage",
    "createOwnedAvd",
    "establishOwnedAcpReverse",
    "launchOwnedEmulator",
    "publishAndroidCaptureBundle",
    "reserveAvdOwnership",
    "reserveKindClusterOwnership",
    "runKindMakePlan",
    "startAndroidScreenrecord",
  ]);
  const finishOwnershipBinding = new Set([
    "bindAvdProcess",
    "bindKindCluster",
    "completeKindClusterCreation",
  ]);
  const register = registerInterruptHandlers ?? defaultRegisterInterruptHandlers;
  if (typeof register !== "function") {
    throw new Error("registerInterruptHandlers must be a function");
  }
  const hardExit = hardExitOnSecondSignal ?? ((signal) => {
    process.kill(process.pid, signal);
  });
  if (typeof hardExit !== "function") {
    throw new Error("hardExitOnSecondSignal must be a function");
  }
  let requestedSignal;
  let committedResult = false;
  let cleanupStarted = false;
  let disposed = false;
  let unregister = () => {};
  const handler = (signal) => {
    if (signal !== "SIGINT" && signal !== "SIGTERM") return;
    if (requestedSignal === undefined) {
      requestedSignal = signal;
      return;
    }
    unregister();
    disposed = true;
    hardExit(signal);
  };
  const registered = register(handler);
  if (typeof registered !== "function") {
    throw new Error("registerInterruptHandlers must return an unregister function");
  }
  unregister = registered;

  const interruptionError = () => {
    const error = new Error(`Android capture interrupted by ${requestedSignal}`);
    error.name = "AndroidCaptureInterruptedError";
    return error;
  };
  const throwIfRequested = () => {
    if (!committedResult && !cleanupStarted && requestedSignal !== undefined) throw interruptionError();
  };
  return Object.freeze({
    acceptCommittedResult() {
      committedResult = true;
      requestedSignal = undefined;
    },
    beginCleanup() { cleanupStarted = true; },
    dispose() {
      if (!disposed) unregister();
      disposed = true;
    },
    errorIfRequested() {
      return committedResult || requestedSignal === undefined ? undefined : interruptionError();
    },
    guardOperations(target) {
      return new Proxy(target, {
        get(object, property, receiver) {
          const value = Reflect.get(object, property, receiver);
          if (typeof value !== "function") return value;
          return (...args) => {
            if (!finishOwnershipBinding.has(property)) throwIfRequested();
            const result = Reflect.apply(value, object, args);
            if (result && typeof result.then === "function") {
              return result.then((resolved) => {
                if (!deliverMutationResults.has(property)) throwIfRequested();
                return resolved;
              });
            }
            if (!deliverMutationResults.has(property)) throwIfRequested();
            return result;
          };
        },
      });
    },
  });
}

export async function captureAndroid(config, dependencies = {}) {
  validateConfig(config);
  let operations = { ...defaultOperations, ...dependencies };
  const actionConfig = operations.validateAndroidActions({
    setupActions: config.capture.android.setupActions ?? [],
    actions: config.capture.android.actions ?? [],
  });
  const acpUrlSetupActions = actionConfig.setupActions.filter((action) => (
    action.action === "fillFromEnvironment" && action.environment === "ACP_URL"
  ));
  if (acpUrlSetupActions.length !== 1) {
    throw new Error("Android setupActions must configure ACP_URL exactly once from the owned endpoint");
  }
  if (minimumRecordedActionMilliseconds(actionConfig.actions) >= config.authoredDurationMs) {
    throw new Error("recorded Android actions require less than the authored duration");
  }
  if (config.dryRun === true) {
    return {
      dryRun: true,
      source: {
        type: "mobile",
        width: config.width,
        height: config.height,
        landmarks: [],
        validationEvidence: {
          plannedActionCount: actionConfig.actions.length,
          plannedSetupActionCount: actionConfig.setupActions.length,
          frameRate: 30,
          silent: true,
        },
      },
      artifacts: {},
      plan: {
        tools: [
          "adb",
          "emulator",
          "sdkmanager",
          "avdmanager",
          "apkanalyzer",
          "kind",
          "kubectl",
          "docker",
          "git",
          "ffmpeg",
          "ffprobe",
          "make",
        ],
        kindTargets: ["kind-up", "kind-down"],
        emulator: { vsyncRate: 30, audio: false },
        recording: {
          durationSeconds: Math.min(
            180,
            Math.ceil((config.authoredDurationMs / 1_000) + ANDROID_RECORDING_FRAME_SECONDS),
          ),
          frameRate: 30,
          audio: false,
        },
      },
    };
  }

  const required = [
    "copyAndroidApkLockEvidence",
    "cleanupAdbScreenrecordStage",
    "createAndroidDriver",
    "createOwnedAvd",
    "disableAndroidPointerOverlays",
    "establishOwnedAcpReverse",
    "installVerifiedAndroidApk",
    "launchAndroidApplication",
    "launchOwnedEmulator",
    "probeAndroidRecording",
    "publishAndroidCaptureBundle",
    "remuxAndroidScreenrecord",
    "rollbackOwnedEmulator",
    "removeOwnedAcpReverse",
    "runKindMakePlan",
    "startAndroidScreenrecord",
    "stopAndroidScreenrecord",
    "verifyInstalledAndroidApp",
    "verifyAndroidDisplayGeometry",
    "waitForOwnedAvdBoot",
    "writeAndroidPointerEvents",
  ];
  let setupEnvironment = exactSetupEnvironment(actionConfig.setupActions, dependencies.environment);
  const sensitiveValues = Object.values(setupEnvironment);
  const nowMilliseconds = dependencies.nowMilliseconds ?? (() => performance.now());
  const sleep = dependencies.sleep ?? delay;
  const kubeconfigPath = path.join(config.markerRoot, "kubeconfig");
  const localOutputPath = outputPath(config.outputDir, "raw/android.mp4");
  const pointerOutputPath = outputPath(config.outputDir, "pointer-events.jsonl");
  const lockOutputPath = outputPath(config.outputDir, "raw/android-apk-lock.json");
  let kindLifecycleDeps = dependencies.kindLifecycleDeps;
  let avdLifecycleDeps = dependencies.avdLifecycleDeps;
  let avdRoot = dependencies.avdRoot;
  let preparedDirectories;
  let kindWorkspace;
  let kindNetwork;
  let ownedAcpEndpoint;
  let ownedAcpReverse;
  let processRegistry = dependencies.processRegistry;

  let primaryError;
  let captureResult;
  let makePath;
  let adbPath;
  let kindOwnership;
  let kindOwnershipBound = false;
  let kindCleanupBlocked = false;
  let avdOwnership;
  let avdCreationProof;
  let avdOwnershipBound = false;
  let avdCleanupBlocked = false;
  let mutationQuiescenceBlocked = false;
  let recordingHandle;
  let recordingExitUnproved = false;
  let recordingStopped = false;
  let recordingStage;
  let recordingPlan;
  const cleanupDiagnostics = [];
  const lifecycle = {};
  const interruption = createInterruptController({
    registerInterruptHandlers: dependencies.registerInterruptHandlers,
    hardExitOnSecondSignal: dependencies.hardExitOnSecondSignal,
  });
  operations = interruption.guardOperations(operations);

  try {
    const doctor = await operations.doctorAndroid(config.capture, dependencies.doctorDeps);
    const portableSystemImage = portableInstalledSystemImage(
      doctor,
      config.capture.android.systemImage,
    );
    makePath = doctor.tools.make.path;
    adbPath = doctor.tools.adb.path;
    const gate = await operations.verifyAndroidApkGate({
      repoRoot: config.repoRoot,
      apk: config.capture.android.apk,
      apkLock: config.capture.android.apkLock,
      expectedApplicationId: config.capture.android.expectedApplicationId,
      apkanalyzerPath: doctor.tools.apkanalyzer.path,
      apkanalyzerIdentity: {
        identity: doctor.tools.apkanalyzer.identity,
        version: doctor.tools.apkanalyzer.version,
      },
      ...(dependencies.apkGateDeps ?? {}),
    });
    const apk = gate.capture.android.apk;
    preparedDirectories = await operations.prepareAndroidRunDirectories({
      markerRoot: config.markerRoot,
      outputDir: config.outputDir,
      ...(dependencies.directoryFs === undefined ? {} : { fs: dependencies.directoryFs }),
    });
    kindWorkspace = await operations.prepareIsolatedKindWorkspace({
      repoRoot: config.repoRoot,
      runtimeRoot: config.markerRoot,
      expectedCommit: apk.source.commit,
      gitPath: doctor.tools.git.path,
    }, {
      fs: dependencies.operationDeps?.fs,
      runCommand: dependencies.operationDeps?.runCommand,
      toolEnvironment: exactToolEnvironment(
        dependencies.toolEnvironment ?? dependencies.operationDeps?.toolEnvironment,
      ),
    });
    avdRoot ??= preparedDirectories.avdRoot;
    processRegistry ??= (
      dependencies.createAndroidProcessRegistry ?? createAndroidProcessRegistry
    )();
    const createDefaultOperations = dependencies.createDefaultOperations ?? createAndroidOperations;
    const {
      environment: _secretEnvironment,
      baseEnvironment: legacyToolEnvironment,
      ...operationDeps
    } = dependencies.operationDeps ?? {};
    const toolEnvironment = exactToolEnvironment(
      dependencies.toolEnvironment ?? legacyToolEnvironment,
    );
    const concreteDefaults = required.some((name) => typeof dependencies[name] !== "function")
      ? createDefaultOperations({
        ...operationDeps,
        avdRoot,
        toolEnvironment,
        processRegistry,
      })
      : {};
    operations = interruption.guardOperations({
      ...defaultOperations,
      ...concreteDefaults,
      ...dependencies,
    });
    for (const name of required) requireOperation(operations, name);
    const kindLifecycleConfig = {
        kubeconfigPath,
        dockerPath: doctor.tools.docker.path,
        kindPath: doctor.tools.kind.path,
        kubectlPath: doctor.tools.kubectl.path,
      };
    kindLifecycleDeps ??= (dependencies.createKindLifecycleDeps ?? createKindLifecycleDeps)(
      kindLifecycleConfig,
      {
        runCommand: dependencies.operationDeps?.runCommand,
        toolEnvironment,
      },
    );
    avdLifecycleDeps ??= (dependencies.createAvdLifecycleDeps ?? createAvdLifecycleDeps)(
      {
        avdRoot,
        adbPath: doctor.tools.adb.path,
        emulatorPath: doctor.tools.emulator.path,
        avdmanagerPath: doctor.tools.avdmanager.path,
      },
      {
        runCommand: dependencies.operationDeps?.runCommand,
        fs: dependencies.operationDeps?.fs,
        inspectProcess: dependencies.operationDeps?.inspectProcess,
        stopEmulator: operations.rollbackOwnedEmulator,
        processRegistry,
        toolEnvironment,
      },
    );
    if (typeof avdLifecycleDeps?.recordCreatedAvd !== "function") {
      throw new Error("AVD lifecycle requires exact creation-provenance recording");
    }

    kindOwnership = await operations.reserveKindClusterOwnership({
      scenarioId: config.scenarioId,
      runId: config.runId,
      markerRoot: config.markerRoot,
      ...(dependencies.kindNonce === undefined ? {} : { nonce: dependencies.kindNonce }),
    }, kindLifecycleDeps);
    const kindCreationTransaction = await operations.beginKindClusterCreation(
      kindOwnership,
      kindLifecycleDeps,
    );
    kindNetwork = kindNetworkBoundary(kindOwnership.clusterName);
    kindLifecycleConfig.kindStateRoot = preparedDirectories.kindStateRoot;
    kindLifecycleConfig.backendPort = kindNetwork.backendPort;
    const kindUpPlan = makeKindPlan({
      target: "kind-up",
      makePath: doctor.tools.make.path,
      workspaceRoot: kindWorkspace.workspaceRoot,
      clusterName: kindOwnership.clusterName,
      kubeconfigPath,
      prepared: preparedDirectories,
      network: kindNetwork,
    });
    const completeKindCreationFromEvidence = (creationEvidence) => (
      operations.completeKindClusterCreation(
        kindOwnership,
        {
          ...kindLifecycleDeps,
          creationTransaction: kindCreationTransaction,
          createdContainerIdentities: creationEvidence.containerIdentities,
        },
      )
    );
    let kindUpResult;
    try {
      kindUpResult = await operations.runKindMakePlan(kindUpPlan, {
        completeKindCreation: completeKindCreationFromEvidence,
      });
    } catch (error) {
      let failedCreationEvidence;
      try {
        failedCreationEvidence = exactFailedKindCreationEvidence(error);
      } catch {
        kindCleanupBlocked = true;
        throw error;
      }
      if (failedCreationEvidence !== undefined) {
        try {
          const failedCreationWitness = await completeKindCreationFromEvidence(
            failedCreationEvidence,
          );
          try {
            kindOwnership = await operations.bindKindCluster(kindOwnership, {
              ...kindLifecycleDeps,
              creationTransaction: failedCreationWitness,
            });
            kindOwnershipBound = true;
          } catch (bindError) {
            const recovered = exactRecoveredBoundOwnership(bindError, kindOwnership, "Kind");
            if (recovered) {
              kindOwnership = recovered;
              kindOwnershipBound = true;
            } else {
              kindCleanupBlocked = true;
            }
          }
        } catch {
          kindCleanupBlocked = true;
        }
      }
      throw error;
    }
    const kindCreationWitness = kindUpResult?.creationWitness;
    try {
      kindOwnership = await operations.bindKindCluster(kindOwnership, {
        ...kindLifecycleDeps,
        creationTransaction: kindCreationWitness,
      });
      kindOwnershipBound = true;
    } catch (error) {
      try {
        const recovered = exactRecoveredBoundOwnership(error, kindOwnership, "Kind");
        if (recovered) {
          kindOwnership = recovered;
          kindOwnershipBound = true;
        } else if (bindOwnershipIndeterminate(error)) {
          kindCleanupBlocked = true;
        }
      } catch {
        kindCleanupBlocked = true;
      }
      throw error;
    }
    kindOwnership = await operations.assertOwnedKindClusterReady(kindOwnership, kindLifecycleDeps);
    ownedAcpEndpoint = await operations.verifyOwnedKindAcpEndpoint(
      kindOwnership,
      kindLifecycleDeps,
    );

    avdOwnership = await operations.reserveAvdOwnership({
      scenarioId: config.scenarioId,
      runId: config.runId,
      markerRoot: config.markerRoot,
      avdRoot,
      systemImage: config.capture.android.systemImage,
      ...(dependencies.avdNonce === undefined ? {} : { nonce: dependencies.avdNonce }),
    }, avdLifecycleDeps);
    try {
      await operations.createOwnedAvd(avdOwnership, {
        avdmanagerPath: doctor.tools.avdmanager.path,
        sdkRoot: doctor.sdk.root,
        systemImage: config.capture.android.systemImage,
      });
    } catch (error) {
      try {
        if (avdCreationCleanupBlocked(error)) avdCleanupBlocked = true;
      } catch {
        avdCleanupBlocked = true;
      }
      throw error;
    }
    avdCreationProof = await avdLifecycleDeps.recordCreatedAvd(avdOwnership);
    const emulatorPlan = operations.createOwnedEmulatorLaunchPlan(avdOwnership, {
      emulatorBinary: doctor.tools.emulator.path,
    });
    assertEmulatorLaunchPlan(emulatorPlan, {
      emulatorPath: doctor.tools.emulator.path,
      avdName: avdOwnership.avdName,
    });
    const binding = await operations.launchOwnedEmulator(emulatorPlan);
    try {
      avdOwnership = await operations.bindAvdProcess(
        avdOwnership,
        binding,
        avdLifecycleDeps,
      );
      avdOwnershipBound = true;
    } catch (error) {
      try {
        const recovered = exactRecoveredBoundOwnership(error, avdOwnership, "AVD");
        if (recovered) {
          avdOwnership = recovered;
          avdOwnershipBound = true;
        } else if (bindOwnershipIndeterminate(error)) {
          avdCleanupBlocked = true;
        }
      } catch {
        avdCleanupBlocked = true;
      }
      if (!avdOwnershipBound && !avdCleanupBlocked) {
        try {
          await operations.rollbackOwnedEmulator({
            avdName: avdOwnership.avdName,
            ...binding,
          });
        } catch (cleanupError) {
          cleanupDiagnostics.push({
            phase: "emulator-launch",
            message: cleanupMessage(cleanupError, sensitiveValues),
          });
        }
      }
      throw error;
    }
    await operations.waitForOwnedAvdBoot(avdOwnership, {
      adbPath: doctor.tools.adb.path,
    });
    // Readiness returns a private verification snapshot, not the durable bound
    // ownership token. Keep the exact marker-bound identity for every later
    // mutation and for teardown.
    await runWithOwnedAvdReady(
      operations,
      avdOwnership,
      avdLifecycleDeps,
      () => operations.verifyAndroidDisplayGeometry({
        serial: avdOwnership.serial,
        adbPath: doctor.tools.adb.path,
        width: config.width,
        height: config.height,
      }),
    );
    ownedAcpReverse = await runWithOwnedAvdReady(
      operations,
      avdOwnership,
      avdLifecycleDeps,
      () => operations.establishOwnedAcpReverse({
      serial: avdOwnership.serial,
      adbPath: doctor.tools.adb.path,
      devicePort: kindNetwork.devicePort,
      hostPort: ownedAcpEndpoint.hostPort,
      }),
    );
    setupEnvironment = { ...setupEnvironment, ACP_URL: ownedAcpReverse.acpUrl };
    await runWithOwnedAvdReady(operations, avdOwnership, avdLifecycleDeps, () => (
      operations.disableAndroidPointerOverlays({
        serial: avdOwnership.serial,
        adbPath: doctor.tools.adb.path,
      })
    ));

    await runWithOwnedAvdReady(operations, avdOwnership, avdLifecycleDeps, () => (
      operations.installVerifiedAndroidApk({
        repoRoot: config.repoRoot,
        apk,
        serial: avdOwnership.serial,
        adbPath: doctor.tools.adb.path,
      })
    ));
    const installed = await operations.verifyInstalledAndroidApp({
      serial: avdOwnership.serial,
      adbPath: doctor.tools.adb.path,
      expectedApplicationId: apk.applicationId,
      expectedVersionName: apk.versionName,
      expectedVersionCode: apk.versionCode,
    });
    assertInstalledIdentity(installed, apk);
    await runWithOwnedAvdReady(operations, avdOwnership, avdLifecycleDeps, () => (
      operations.launchAndroidApplication({
        serial: avdOwnership.serial,
        adbPath: doctor.tools.adb.path,
        applicationId: apk.applicationId,
        activity: config.capture.android.launchActivity,
      })
    ));

    const driver = operations.createAndroidDriver({
      serial: avdOwnership.serial,
      adbPath: doctor.tools.adb.path,
    });
    await runWithOwnedAvdReady(operations, avdOwnership, avdLifecycleDeps, () => (
      operations.executeAndroidActions(actionConfig.setupActions, {
        driver,
        phase: "pre-recording",
        nowMilliseconds,
        sleep,
        ...(setupEnvironment === undefined ? {} : { environment: setupEnvironment }),
      })
    ));
    await operations.auditAndroidSetupUiForSecrets({
      driver,
      environment: setupEnvironment ?? {},
    });

    recordingStage = await operations.createAdbScreenrecordStage({
      stagingParent: preparedDirectories.stagingParent,
    });
    const expectedDurationSeconds = config.authoredDurationMs / 1_000;
    const durationSeconds = Math.min(
      180,
      Math.ceil(expectedDurationSeconds + ANDROID_RECORDING_FRAME_SECONDS),
    );
    const minimumDurationSeconds = Math.max(
      Number.EPSILON,
      expectedDurationSeconds - ANDROID_RECORDING_FRAME_SECONDS,
    );
    const maxDurationSeconds = Math.min(
      durationSeconds,
      expectedDurationSeconds + ANDROID_RECORDING_FRAME_SECONDS,
    );
    recordingPlan = operations.createAdbScreenrecordPlan({
      adbPath: doctor.tools.adb.path,
      ffmpegPath: doctor.tools.ffmpeg.path,
      serial: avdOwnership.serial,
      width: config.width,
      height: config.height,
      durationSeconds,
      minimumDurationSeconds,
      expectedDurationSeconds,
      maxDurationSeconds,
      stagingDir: recordingStage.stagingDir,
      rawOutputPath: recordingStage.rawOutputPath,
      stagedOutputPath: recordingStage.stagedOutputPath,
      outputDir: config.outputDir,
      localOutputPath,
    });
    assertRecordingPlan(recordingPlan, {
      adbPath: doctor.tools.adb.path,
      ffmpegPath: doctor.tools.ffmpeg.path,
      serial: avdOwnership.serial,
      width: config.width,
      height: config.height,
      durationSeconds,
      authoredDurationMilliseconds: config.authoredDurationMs,
      minimumDurationSeconds,
      expectedDurationSeconds,
      maxDurationSeconds,
      rawOutputPath: recordingStage.rawOutputPath,
    });
    const recordingGeometry = await runWithOwnedAvdReady(
      operations,
      avdOwnership,
      avdLifecycleDeps,
      () => operations.verifyAndroidDisplayGeometry({
        serial: avdOwnership.serial,
        adbPath: doctor.tools.adb.path,
        width: config.width,
        height: config.height,
      }),
    );
    recordingHandle = await runWithOwnedAvdReady(
      operations,
      avdOwnership,
      avdLifecycleDeps,
      () => operations.startAndroidScreenrecord(recordingPlan.record),
    );
    const recordingStartedAt = recordingHandle.mediaStartMonotonicMilliseconds;
    if (!Number.isFinite(recordingStartedAt) || recordingStartedAt < 0) {
      throw new Error("Android recording clock returned an invalid origin");
    }
    const deadlineMilliseconds = recordingStartedAt + config.authoredDurationMs;
    const pointerRecorder = operations.createAndroidPointerRecorder({
      displayGeometry: recordingGeometry,
      startMonotonicSeconds: recordingStartedAt / 1_000,
      durationSeconds: config.authoredDurationMs / 1_000,
    });
    const recordedActions = await runWithOwnedAvdReady(
      operations,
      avdOwnership,
      avdLifecycleDeps,
      () => operations.executeAndroidActions(actionConfig.actions, {
        driver,
        phase: "recording",
        nowMilliseconds,
        sleep,
        deadlineMilliseconds,
        recordPointer: pointerRecorder.record,
      }),
    );
    const remainingMilliseconds = deadlineMilliseconds - nowMilliseconds();
    if (remainingMilliseconds <= 0) {
      throw new Error("recorded Android actions exhausted the authored duration");
    }
    await sleep(remainingMilliseconds);
    await operations.stopAndroidScreenrecord(recordingHandle);
    recordingStopped = true;
    const postCaptureGeometry = await runWithOwnedAvdReady(
      operations,
      avdOwnership,
      avdLifecycleDeps,
      () => operations.verifyAndroidDisplayGeometry({
        serial: avdOwnership.serial,
        adbPath: doctor.tools.adb.path,
        width: config.width,
        height: config.height,
      }),
    );
    assertStablePortraitGeometry(
      recordingGeometry,
      postCaptureGeometry,
      config.width,
      config.height,
    );
    await operations.remuxAndroidScreenrecord(recordingPlan.remux);
    const validatedRecording = await operations.validateStagedAdbScreenrecordOutput({
      ...recordingPlan.validation,
      outputDir: recordingPlan.publish.outputDir,
      destinationPath: recordingPlan.publish.destinationPath,
      probeFile: async (stagedOutputPath) => operations.probeAndroidRecording({
        path: stagedOutputPath,
        ffprobePath: doctor.tools.ffprobe.path,
      }),
    });
    const pointerEvents = pointerRecorder.snapshot();
    const landmarks = completedActionLandmarks(actionConfig.actions, recordedActions);
    const {
      publishedRecording,
      pointerArtifact,
      lockArtifact,
    } = await operations.publishAndroidCaptureBundle({
      outputDir: config.outputDir,
      recordingDestinationPath: localOutputPath,
      pointerDestinationPath: pointerOutputPath,
      lockDestinationPath: lockOutputPath,
      expectedRecordingSha256: validatedRecording.sha256,
      expectedPointerSha256: sha256CanonicalAndroidPointerEvents(pointerEvents),
      expectedLockSha256: apk.lock.sha256,
      publishRecording: ({ witnessPath }) => operations.publishAdbScreenrecordOutput({
        validatedOutput: validatedRecording,
        ...recordingPlan.publish,
        publicationPath: witnessPath,
      }),
      publishPointerEvents: ({ witnessPath }) => operations.writeAndroidPointerEvents({
        events: pointerEvents,
        outputPath: witnessPath,
      }),
      publishApkLock: ({ witnessPath }) => operations.copyAndroidApkLockEvidence({
        repoRoot: config.repoRoot,
        sourceRef: apk.lock.ref,
        expectedSha256: apk.lock.sha256,
        outputPath: witnessPath,
      }),
    });
    interruption.acceptCommittedResult();
    assertArtifactBinding(
      publishedRecording,
      localOutputPath,
      "mobile capture",
      validatedRecording.sha256,
    );
    assertArtifactBinding(pointerArtifact, pointerOutputPath, "pointer events");
    assertArtifactBinding(lockArtifact, lockOutputPath, "APK lock", apk.lock.sha256);

    captureResult = {
      source: {
        type: "mobile",
        width: validatedRecording.width,
        height: validatedRecording.height,
        landmarks,
        validationEvidence: {
          applicationId: installed.applicationId,
          versionName: installed.versionName,
          versionCode: String(installed.versionCode),
          frameRate: validatedRecording.frameRate,
          silent: validatedRecording.audioStreams === 0,
          durationSeconds: validatedRecording.durationSeconds,
          actionCount: recordedActions.count,
          pointerEventCount: pointerEvents.length,
          mediaValidated: validatedRecording.ok === true,
        },
      },
      android: {
        apk,
        systemImage: portableSystemImage,
        toolchain: portableToolchain(doctor.tools),
      },
      artifacts: {
        mobileCapture: {
          path: publishedRecording.outputPath,
          sha256: publishedRecording.sha256,
        },
        pointerEvents: {
          path: pointerArtifact.path,
          sha256: pointerArtifact.sha256,
        },
        androidApkLock: {
          path: lockArtifact.path,
          sha256: lockArtifact.sha256,
        },
      },
    };
  } catch (error) {
    primaryError = error;
    try {
      if (androidMutationQuiescenceUnproved(error)) {
        mutationQuiescenceBlocked = true;
        avdCleanupBlocked = true;
        kindCleanupBlocked = true;
      }
    } catch {
      mutationQuiescenceBlocked = true;
      avdCleanupBlocked = true;
      kindCleanupBlocked = true;
    }
    try {
      recordingExitUnproved = recorderExitUnproved(error);
    } catch {
      // An invalid marker is indeterminate, so preserve private staging fail-closed.
      recordingExitUnproved = true;
    }
    try {
      if (!recordingStopped) {
        recordingStopped = recorderQuiescenceProven(error);
      }
    } catch {
      recordingExitUnproved = true;
    }
  } finally {
    interruption.beginCleanup();
    if (recordingHandle && !recordingStopped) {
      try {
        await operations.stopAndroidScreenrecord(recordingHandle);
        recordingStopped = true;
      } catch (error) {
        try {
          recordingStopped = recorderQuiescenceProven(error);
        } catch {
          recordingExitUnproved = true;
        }
        cleanupDiagnostics.push({
          phase: "screenrecord",
          message: cleanupMessage(error, sensitiveValues),
        });
      }
    }
    if (
      recordingStage
      && !recordingExitUnproved
      && (!recordingHandle || recordingStopped)
    ) {
      try {
        await operations.cleanupAdbScreenrecordStage({ stage: recordingStage });
      } catch (error) {
        cleanupDiagnostics.push({
          phase: "screenrecord-stage",
          message: cleanupMessage(error, sensitiveValues),
        });
      }
    } else if (recordingStage) {
      cleanupDiagnostics.push({
        phase: "screenrecord-stage",
        message: "Recorder exit was not proven; preserving its private staging files",
      });
    }
    if (ownedAcpReverse) {
      if (avdCleanupBlocked) {
        cleanupDiagnostics.push({
          phase: "acp-reverse",
          message: "Android mutation quiescence is unproved; preserving the owned reverse mapping",
        });
      } else {
        try {
          await runWithOwnedAvdReady(
            operations,
            avdOwnership,
            avdLifecycleDeps,
            () => operations.removeOwnedAcpReverse(ownedAcpReverse, { adbPath }),
          );
          lifecycle.acpReverse = { status: "deleted", ownershipVerified: true };
        } catch (error) {
          cleanupDiagnostics.push({
            phase: "acp-reverse",
            message: cleanupMessage(error, sensitiveValues),
          });
        }
      }
    }
    if (avdOwnership) {
      try {
        if (avdCleanupBlocked) {
          throw new Error(mutationQuiescenceBlocked
            ? "Android mutation quiescence is unproved; preserving the AVD and marker"
            : "AVD bind ownership is indeterminate; preserving the resource and marker");
        } else if (avdOwnershipBound) {
          await operations.teardownOwnedAvd(avdOwnership, avdLifecycleDeps);
          lifecycle.avd = { status: "deleted", ownershipVerified: true };
        } else {
          if (typeof avdLifecycleDeps?.rollbackUnboundAvd !== "function") {
            throw new Error("Unbound AVD rollback dependency is required");
          }
          try {
            await avdLifecycleDeps.rollbackUnboundAvd(
              avdOwnership,
              avdCreationProof === undefined ? {} : { creationProof: avdCreationProof },
            );
          } catch (unboundError) {
            try {
              await operations.teardownOwnedAvd(avdOwnership, avdLifecycleDeps);
            } catch (boundError) {
              throw new AggregateError(
                [unboundError, boundError],
                "Unable to verify bound or unbound AVD cleanup",
              );
            }
          }
        }
      } catch (error) {
        cleanupDiagnostics.push({ phase: "avd", message: cleanupMessage(error, sensitiveValues) });
      }
    }
    if (kindOwnership) {
      try {
        if (kindCleanupBlocked) {
          throw new Error(mutationQuiescenceBlocked
            ? "Android mutation quiescence is unproved; preserving Kind and its marker"
            : "Kind bind ownership is indeterminate; preserving the resource and marker");
        }
        const boundKindCleanup = () => {
          if (!kindNetwork || !kindWorkspace || !preparedDirectories || !makePath) {
            throw new Error("Bound Kind cleanup requires a complete network allocation");
          }
          const kindDownPlan = makeKindPlan({
            target: "kind-down",
            makePath,
            workspaceRoot: kindWorkspace.workspaceRoot,
            clusterName: kindOwnership.clusterName,
            kubeconfigPath,
            prepared: preparedDirectories,
            network: kindNetwork,
            containerIdentities: kindOwnership.containerIdentities,
          });
          return async (identity) => {
            exactKindDeletionProof(identity, kindOwnership);
            await operations.runKindMakePlan({
              ...kindDownPlan,
              executable: kindDownPlan.executable,
            });
          };
        };
        if (kindOwnershipBound) {
          const deleteKindCluster = boundKindCleanup();
          await operations.teardownOwnedKindCluster(kindOwnership, {
            ...kindLifecycleDeps,
            deleteKindCluster,
          });
          lifecycle.cluster = { status: "deleted", ownershipVerified: true };
        } else {
          if (typeof kindLifecycleDeps?.rollbackUnboundKindCluster !== "function") {
            throw new Error("Unbound Kind rollback dependency is required");
          }
          try {
            await kindLifecycleDeps.rollbackUnboundKindCluster(kindOwnership);
          } catch (unboundError) {
            if (!kindNetwork) throw unboundError;
            try {
              const deleteKindCluster = boundKindCleanup();
              await operations.teardownOwnedKindCluster(kindOwnership, {
                ...kindLifecycleDeps,
                deleteKindCluster,
              });
            } catch (boundError) {
              throw new AggregateError(
                [unboundError, boundError],
                "Unable to verify bound or unbound Kind cleanup",
              );
            }
          }
        }
      } catch (error) {
        cleanupDiagnostics.push({ phase: "kind", message: cleanupMessage(error, sensitiveValues) });
      }
    }
    if (!primaryError) primaryError = interruption.errorIfRequested();
    interruption.dispose();
  }

  if (primaryError) throw attachCleanupDiagnostics(primaryError, cleanupDiagnostics);
  if (cleanupDiagnostics.length > 0) {
    const error = new AggregateError([], "Android capture cleanup failed");
    error.cleanupDiagnostics = cleanupDiagnostics;
    throw error;
  }
  return { ...captureResult, lifecycle };
}
