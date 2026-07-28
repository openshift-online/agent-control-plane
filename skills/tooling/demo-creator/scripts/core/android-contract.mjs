const IDENTITY_ONLY = Object.freeze(["identity"]);
const VERSIONED_IDENTITY = Object.freeze(["identity", "version"]);

export const ANDROID_AUTHORED_CAPTURE_MAX_MILLISECONDS = 179_000;
export const ANDROID_AUTHORED_CAPTURE_MAX_SECONDS = 179;
export const ANDROID_LAUNCH_ACTIVITY_MAX_CHARACTERS = 300;
export const ANDROID_RESOURCE_ID_MAX_CHARACTERS = 200;

const ANDROID_LAUNCH_ACTIVITY = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+\/(?:\.[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)*|[a-z][a-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+)$/u;
const ANDROID_REACT_NATIVE_TEST_ID = /^[A-Za-z][A-Za-z0-9_-]*$/u;
const ANDROID_COMPILED_RESOURCE_ID = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*:id\/[A-Za-z][A-Za-z0-9_]*$/u;

export function isAndroidLaunchActivity(value) {
  return typeof value === "string"
    && value.length >= 5
    && value.length <= ANDROID_LAUNCH_ACTIVITY_MAX_CHARACTERS
    && ANDROID_LAUNCH_ACTIVITY.test(value);
}

export function isAndroidResourceId(value) {
  return typeof value === "string"
    && value.length >= 1
    && value.length <= ANDROID_RESOURCE_ID_MAX_CHARACTERS
    && (ANDROID_REACT_NATIVE_TEST_ID.test(value) || ANDROID_COMPILED_RESOURCE_ID.test(value));
}

export const ANDROID_TOOLCHAIN_SPEC = Object.freeze({
  adb: IDENTITY_ONLY,
  emulator: IDENTITY_ONLY,
  sdkmanager: VERSIONED_IDENTITY,
  avdmanager: VERSIONED_IDENTITY,
  apkanalyzer: VERSIONED_IDENTITY,
  kind: IDENTITY_ONLY,
  kubectl: IDENTITY_ONLY,
  docker: IDENTITY_ONLY,
  git: IDENTITY_ONLY,
  make: IDENTITY_ONLY,
  ffmpeg: IDENTITY_ONLY,
  ffprobe: IDENTITY_ONLY,
});

export const ANDROID_TOOLCHAIN_NAMES = Object.freeze(Object.keys(ANDROID_TOOLCHAIN_SPEC));

export const ANDROID_RUNTIME_VALIDATION_EVIDENCE_KEYS = Object.freeze([
  "applicationId",
  "versionName",
  "versionCode",
  "frameRate",
  "silent",
  "durationSeconds",
  "actionCount",
  "pointerEventCount",
  "mediaValidated",
]);

export const ANDROID_ARTIFACT_DIGEST_NAMES = Object.freeze([
  "mobileCapture",
  "pointerEvents",
  "androidApkLock",
]);

export const ANDROID_PUBLIC_VALIDATION_EVIDENCE_KEYS = Object.freeze([
  ...ANDROID_RUNTIME_VALIDATION_EVIDENCE_KEYS,
  "artifactSha256",
]);
