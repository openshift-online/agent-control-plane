import {
  createAndroidArtifactOperations,
  prepareAndroidRunDirectories,
} from "./artifact-operations.mjs";
import { createAndroidDeviceOperations } from "./device-operations.mjs";
import {
  createAvdLifecycleDeps,
  createKindLifecycleDeps,
} from "./lifecycle-operations.mjs";
import { createAndroidProcessOperations } from "./process-operations.mjs";

export { createAvdLifecycleDeps, createKindLifecycleDeps, prepareAndroidRunDirectories };

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

export const ANDROID_DEFAULT_OPERATION_NAMES = Object.freeze([
  "copyAndroidApkLockEvidence",
  "createAndroidDriver",
  "createOwnedAvd",
  "disableAndroidPointerOverlays",
  "establishOwnedAcpReverse",
  "installVerifiedAndroidApk",
  "launchAndroidApplication",
  "launchOwnedEmulator",
  "probeAndroidRecording",
  "removeOwnedAcpReverse",
  "remuxAndroidScreenrecord",
  "rollbackOwnedEmulator",
  "runKindMakePlan",
  "startAndroidScreenrecord",
  "stopAndroidScreenrecord",
  "verifyAndroidDisplayGeometry",
  "verifyInstalledAndroidApp",
  "waitForOwnedAvdBoot",
  "writeAndroidPointerEvents",
]);

export function createAndroidProcessRegistry() {
  return Object.freeze({
    emulators: new Map(),
    recorders: new Map(),
  });
}

function assertCompleteOperations(operations) {
  const names = Object.keys(operations).sort();
  if (JSON.stringify(names) !== JSON.stringify(ANDROID_DEFAULT_OPERATION_NAMES)) {
    throw new Error(`Portable Android operation surface is incomplete: ${names.join(", ")}`);
  }
  for (const name of ANDROID_DEFAULT_OPERATION_NAMES) {
    if (typeof operations[name] !== "function") {
      throw new Error(`Portable Android operation ${name} must be a function`);
    }
  }
}

function safeToolEnvironment(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Android toolEnvironment must be an object");
  }
  return Object.freeze(Object.fromEntries(
    TOOL_ENVIRONMENT_KEYS
      .filter((name) => typeof value[name] === "string")
      .map((name) => [name, value[name]]),
  ));
}

export function createAndroidOperations(dependencies = {}) {
  if (!dependencies || typeof dependencies !== "object" || Array.isArray(dependencies)) {
    throw new Error("Android operation dependencies must be an object");
  }
  const processRegistry = dependencies.processRegistry ?? createAndroidProcessRegistry();
  if (
    !(processRegistry?.emulators instanceof Map)
    || !(processRegistry?.recorders instanceof Map)
  ) {
    throw new Error("Android processRegistry must contain emulators and recorders Maps");
  }
  const {
    baseEnvironment: _legacyBaseEnvironment,
    environment: _privateActionEnvironment,
    toolEnvironment = process.env,
    ...lowLevelDependencies
  } = dependencies;
  const sharedDependencies = {
    ...lowLevelDependencies,
    baseEnvironment: safeToolEnvironment(toolEnvironment),
    processRegistry,
  };
  const operations = {
    ...createAndroidProcessOperations(sharedDependencies),
    ...createAndroidDeviceOperations(sharedDependencies),
    ...createAndroidArtifactOperations(sharedDependencies),
  };
  assertCompleteOperations(operations);
  return Object.freeze(operations);
}
