import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { runCommand } from "./ffmpeg.mjs";
import { androidSetupSensitiveValues } from "./security-values.mjs";
import { scanOutputSecrets, scanTextForSecrets } from "./secrets.mjs";
import {
  openDigestBoundArtifact,
  parsePointerEvents,
  validateAndroidPointerEvents,
  validatePointerEventsAgainstDuration,
  verifyOpenArtifactUnchanged,
  verifyManifestArtifact,
} from "./artifact-integrity.mjs";
import { assertAndroidApkLock } from "../core/android-apk-lock.mjs";
import { validateAndroidActions } from "../capture/android/actions.mjs";
import {
  ANDROID_AUTHORED_CAPTURE_MAX_SECONDS,
  ANDROID_ARTIFACT_DIGEST_NAMES,
  ANDROID_PUBLIC_VALIDATION_EVIDENCE_KEYS,
  ANDROID_TOOLCHAIN_NAMES,
  ANDROID_TOOLCHAIN_SPEC,
  isAndroidLaunchActivity,
  isAndroidResourceId,
} from "../core/android-contract.mjs";

const MOBILE_CAPTURE_DURATION_TOLERANCE_SECONDS = 1 / 30 + 0.02;
const MAX_POINTER_EVENTS_BYTES = 1024 * 1024;

function parseRate(value) {
  const [numerator, denominator = "1"] = String(value).split("/").map(Number);
  return numerator / denominator;
}

function hasExactMobileFrameRates(stream) {
  return [stream?.avg_frame_rate, stream?.r_frame_rate].every((value) => {
    const rate = parseRate(value);
    return Number.isFinite(rate) && Math.abs(rate - 30) < 0.001;
  });
}

function resolveReportPath(value, outputDir) {
  if (path.isAbsolute(value)) {
    throw new Error("Validation report path must be relative to outputDir");
  }
  const root = path.resolve(outputDir);
  const resolved = path.resolve(root, value);
  const relative = path.relative(root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Validation report path must remain inside outputDir");
  }
  return resolved;
}

async function assertDirectoryIdentity(file, handle, identity) {
  let held;
  let current;
  try {
    [held, current] = await Promise.all([handle.stat(), fs.stat(file)]);
  } catch {
    throw new Error("outputDir changed during validation report publication");
  }
  if (!held.isDirectory()
    || !current.isDirectory()
    || held.dev !== identity.dev
    || held.ino !== identity.ino
    || current.dev !== identity.dev
    || current.ino !== identity.ino) {
    throw new Error("outputDir changed during validation report publication");
  }
}

export async function writeValidationReport(outputDir, requestedPath, report, dependencies = {}) {
  const root = await fs.realpath(outputDir);
  const reportPath = resolveReportPath(requestedPath, root);
  if (path.dirname(reportPath) !== root) {
    throw new Error("Validation report must be written directly inside outputDir; nested or symbolic link parents are not supported");
  }
  const destination = path.join(root, path.basename(reportPath));
  try {
    if ((await fs.lstat(destination)).isSymbolicLink()) {
      throw new Error("Validation report destination must not be a symbolic link");
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const rootHandle = await fs.open(root, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  let rootIdentity;
  try {
    rootIdentity = await rootHandle.stat();
  } catch (error) {
    await rootHandle.close();
    throw error;
  }
  if (!rootIdentity.isDirectory()) {
    await rootHandle.close();
    throw new Error("Validation report outputDir must be a directory");
  }
  const temporary = path.join(root, `.validation-report-${randomUUID()}.tmp`);
  let handle;
  try {
    await assertDirectoryIdentity(root, rootHandle, rootIdentity);
    handle = await fs.open(
      temporary,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0),
      0o600,
    );
    await handle.writeFile(`${JSON.stringify(report, null, 2)}\n`, "utf8");
    await handle.close();
    handle = undefined;
    await dependencies.afterTemporaryWrite?.();
    await assertDirectoryIdentity(root, rootHandle, rootIdentity);
    await fs.rename(temporary, destination);
    await assertDirectoryIdentity(root, rootHandle, rootIdentity);
    return destination;
  } finally {
    if (handle) await handle.close().catch(() => {});
    try {
      let stable = false;
      try {
        await assertDirectoryIdentity(root, rootHandle, rootIdentity);
        stable = true;
      } catch {
        // Do not follow a replaced outputDir while cleaning a private temp file.
      }
      if (stable) await fs.rm(temporary, { force: true });
    } finally {
      await rootHandle.close();
    }
  }
}

function outside(root, target) {
  const relative = path.relative(root, target);
  return relative.startsWith("..") || path.isAbsolute(relative);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function pick(value, keys) {
  if (!isObject(value)) return undefined;
  return Object.fromEntries(keys
    .filter((key) => Object.hasOwn(value, key))
    .map((key) => [key, value[key]]));
}

function isHostAbsolutePath(value) {
  return path.posix.isAbsolute(value)
    || path.win32.isAbsolute(value)
    || /^\\\\(?:[?.]\\)?/u.test(value);
}

function isPortableMetadata(value) {
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return false;
  }
  if (serialized === undefined || serialized.length > 64 * 1024) return false;
  const visit = (candidate) => {
    if (candidate === null || typeof candidate === "boolean") return true;
    if (typeof candidate === "number") return Number.isFinite(candidate);
    if (typeof candidate === "string") {
      return !candidate.includes("\0") && !isHostAbsolutePath(candidate);
    }
    if (Array.isArray(candidate)) {
      return candidate.length <= 100 && candidate.every(visit);
    }
    if (!isObject(candidate)) return false;
    return Object.entries(candidate).every(([key, child]) => (
      !key.includes("\0") && !isHostAbsolutePath(key) && visit(child)
    ));
  };
  return visit(value);
}

function isPortableRepositoryReference(value) {
  if (typeof value !== "string" || !value.startsWith("repo:")) return false;
  const relative = value.slice("repo:".length);
  if (relative.length === 0
    || relative.includes(":")
    || relative.includes("\\")
    || relative.includes("\0")
    || path.posix.isAbsolute(relative)
    || path.win32.isAbsolute(relative)
    || path.posix.normalize(relative) !== relative) return false;
  return relative.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function isPortableRelativePath(value) {
  if (typeof value !== "string"
    || value.length === 0
    || value.includes(":")
    || value.includes("\\")
    || value.includes("\0")
    || path.posix.isAbsolute(value)
    || path.win32.isAbsolute(value)
    || path.posix.normalize(value) !== value) return false;
  return value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function portableAndroidMetadata(value) {
  if (!isObject(value)) return undefined;
  const apk = pick(value.apk, [
    "ref", "sha256", "lock", "applicationId", "versionName", "versionCode", "source", "apkanalyzer",
  ]);
  if (apk) {
    apk.lock = pick(apk.lock, ["ref", "sha256"]);
    apk.source = pick(apk.source, ["commit", "tree", "path"]);
    apk.apkanalyzer = pick(apk.apkanalyzer, ["identity", "version"]);
  }
  const toolchain = isObject(value.toolchain)
    ? Object.fromEntries(Object.entries(value.toolchain).map(([name, tool]) => [
      name,
      pick(tool, ["identity", "version"]),
    ]).filter(([, tool]) => tool !== undefined))
    : undefined;
  const result = {
    ...(apk ? { apk } : {}),
    ...(isObject(value.systemImage) ? {
      systemImage: pick(value.systemImage, ["package", "revision"]),
    } : {}),
    ...(toolchain ? { toolchain } : {}),
  };
  if (!isPortableMetadata(result)
    || !isPortableRepositoryReference(result.apk?.ref)
    || !isPortableRepositoryReference(result.apk?.lock?.ref)) return undefined;
  return result;
}

function portableLifecycle(value) {
  if (!isObject(value)) return undefined;
  const result = Object.fromEntries(["avd", "cluster", "acpReverse"]
    .filter((name) => isObject(value[name]))
    .map((name) => [name, pick(value[name], ["status", "ownershipVerified"])]));
  return Object.keys(result).length > 0 ? result : undefined;
}

function mediaReport(value, outputDir) {
  const { probe: _probe, ...media } = value;
  return { ...media, file: path.relative(outputDir, value.file) };
}

function redactedMediaReport(value, file) {
  const checks = isObject(value.checks)
    ? Object.fromEntries(Object.entries(value.checks)
      .filter(([, result]) => typeof result === "boolean"))
    : {};
  return {
    file,
    ok: value.ok === true,
    checks,
    ...(Number.isFinite(value.duration) ? { duration: value.duration } : {}),
  };
}

function pass(value) {
  return value ? "pass" : "fail";
}

function mobileSourceComplete(source) {
  return source?.type === "mobile"
    && Number.isInteger(source.width) && source.width > 0
    && Number.isInteger(source.height) && source.height > 0
    && Array.isArray(source.landmarks) && source.landmarks.length > 0
    && source.landmarks.every(isObject)
    && isObject(source.validationEvidence);
}

function androidValidationEvidenceExact(evidence) {
  return exactObjectKeys(evidence, ANDROID_PUBLIC_VALIDATION_EVIDENCE_KEYS)
    && exactObjectKeys(evidence.artifactSha256, ANDROID_ARTIFACT_DIGEST_NAMES);
}

function portableAndroidSource(source) {
  const result = pick(source, ["type", "width", "height", "landmarks", "validationEvidence"]);
  if (!result) return undefined;
  result.validationEvidence = pick(
    result.validationEvidence,
    ANDROID_PUBLIC_VALIDATION_EVIDENCE_KEYS,
  );
  if (result.validationEvidence) {
    result.validationEvidence.artifactSha256 = pick(
      result.validationEvidence.artifactSha256,
      ANDROID_ARTIFACT_DIGEST_NAMES,
    );
  }
  return isPortableMetadata(result) ? result : undefined;
}

const SHA256 = /^[0-9a-f]{64}$/u;
const ANDROID_SYSTEM_IMAGE = /^system-images;android-(?:[2-9][0-9]|[1-9][0-9]{2})(?:\.[0-9]+)?;(?:default|google_apis|google_apis_playstore|google_apis_ps16k);(?:arm64-v8a|x86_64)$/u;
const ANDROID_SDK_REVISION = /^[0-9]{1,6}(?:\.[0-9]{1,6}){0,3}$/u;

function authoredAndroidIdentityMatches(authoredAndroid, applicationId) {
  if (authoredAndroid === undefined) return true;
  const expectedApplicationId = authoredAndroid?.expectedApplicationId;
  const launchActivity = authoredAndroid?.launchActivity;
  return typeof expectedApplicationId === "string"
    && isAndroidLaunchActivity(launchActivity)
    && launchActivity.split("/")[0] === expectedApplicationId
    && applicationId === expectedApplicationId;
}

function authoredRecordedActions(authoredAndroid) {
  if (authoredAndroid === undefined) return undefined;
  try {
    return validateAndroidActions({
      setupActions: [],
      actions: authoredAndroid?.actions,
    }).actions;
  } catch {
    return null;
  }
}

function landmarksMatchAuthoredActions(landmarks, actions) {
  if (actions === undefined) return true;
  if (!Array.isArray(actions) || !Array.isArray(landmarks) || landmarks.length !== actions.length) {
    return false;
  }
  return actions.every((action, index) => {
    const landmark = landmarks[index];
    if (landmark?.action !== action.action) return false;
    if (action.selector === undefined) return !Object.hasOwn(landmark, "selector");
    return landmark.selector?.by === action.selector.by
      && landmark.selector?.value === action.selector.value;
  });
}

function androidSourceEvidenceComplete(source, android, authoredAndroid) {
  const actions = new Set(["wait", "expect", "tap", "fill", "back"]);
  const selectors = new Set(["resourceId", "text", "contentDescription"]);
  const validLandmarks = source?.landmarks?.every((landmark, index) => {
    if (!isObject(landmark)) return false;
    const keys = Object.keys(landmark).sort();
    const needsSelector = ["expect", "tap", "fill"].includes(landmark.action);
    const expectedKeys = (needsSelector
      ? ["action", "id", "ordinal", "selector"]
      : ["action", "id", "ordinal"]).sort();
    if (JSON.stringify(keys) !== JSON.stringify(expectedKeys)
      || landmark.id !== `recorded-action-${index + 1}`
      || landmark.ordinal !== index + 1
      || !actions.has(landmark.action)) return false;
    if (!needsSelector) return true;
    if (!isObject(landmark.selector)
      || JSON.stringify(Object.keys(landmark.selector).sort()) !== JSON.stringify(["by", "value"])
      || !selectors.has(landmark.selector.by)
      || typeof landmark.selector.value !== "string"
      || landmark.selector.value.length < 1
      || landmark.selector.value.length > 200
      || (landmark.selector.by === "resourceId"
        && !isAndroidResourceId(landmark.selector.value))) return false;
    return true;
  });
  const authoredActions = authoredRecordedActions(authoredAndroid);
  const evidence = source?.validationEvidence;
  const digests = source?.validationEvidence?.artifactSha256;
  const expectedActions = Array.isArray(authoredActions) ? authoredActions : source?.landmarks;
  const expectedPointerCount = expectedActions?.filter(
    (landmark) => landmark?.action === "tap" || landmark?.action === "fill",
  ).length;
  const expectedActionCount = Array.isArray(authoredActions)
    ? authoredActions.length
    : source?.landmarks?.length;
  return mobileSourceComplete(source)
    && isPortableMetadata(source)
    && androidValidationEvidenceExact(evidence)
    && source.height > source.width
    && validLandmarks === true
    && landmarksMatchAuthoredActions(source.landmarks, authoredActions)
    && authoredAndroidIdentityMatches(authoredAndroid, evidence.applicationId)
    && evidence.applicationId === android?.apk?.applicationId
    && evidence.versionName === android?.apk?.versionName
    && String(evidence.versionCode ?? "") === android?.apk?.versionCode
    && evidence.frameRate === 30
    && evidence.silent === true
    && Number.isFinite(evidence.durationSeconds)
    && evidence.durationSeconds > 0
    && evidence.durationSeconds <= ANDROID_AUTHORED_CAPTURE_MAX_SECONDS
    && Number.isInteger(evidence.actionCount)
    && evidence.actionCount === expectedActionCount
    && Number.isInteger(evidence.pointerEventCount)
    && evidence.pointerEventCount === expectedPointerCount
    && evidence.mediaValidated === true
    && isObject(digests)
    && ANDROID_ARTIFACT_DIGEST_NAMES
      .every((name) => SHA256.test(digests[name] ?? ""))
    && digests.androidApkLock === android?.apk?.lock?.sha256;
}

function androidProvenanceComplete(android) {
  const apk = android?.apk;
  return isObject(apk)
    && isPortableRepositoryReference(apk.ref)
    && SHA256.test(apk.sha256 ?? "")
    && isPortableRepositoryReference(apk.lock?.ref)
    && SHA256.test(apk.lock?.sha256 ?? "")
    && typeof apk.applicationId === "string" && apk.applicationId.length > 0
    && typeof apk.versionName === "string" && apk.versionName.length > 0
    && typeof apk.versionCode === "string" && apk.versionCode.length > 0
    && /^[0-9a-f]{40,64}$/u.test(apk.source?.commit ?? "")
    && /^[0-9a-f]{40,64}$/u.test(apk.source?.tree ?? "")
    && apk.source?.path === "components/mobile"
    && typeof apk.apkanalyzer?.identity === "string"
    && typeof apk.apkanalyzer?.version === "string";
}

function exactObjectKeys(value, expected) {
  return isObject(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

function androidApkMetadataExact(android) {
  return exactObjectKeys(android?.apk, [
    "applicationId", "apkanalyzer", "lock", "ref", "sha256", "source", "versionCode", "versionName",
  ])
    && exactObjectKeys(android.apk.lock, ["ref", "sha256"])
    && exactObjectKeys(android.apk.source, ["commit", "path", "tree"])
    && exactObjectKeys(android.apk.apkanalyzer, ["identity", "version"]);
}

function androidSystemImageComplete(systemImage, authoredPackage) {
  if (!isObject(systemImage)) return false;
  if (JSON.stringify(Object.keys(systemImage).sort()) !== JSON.stringify(["package", "revision"])) {
    return false;
  }
  return typeof systemImage.package === "string"
    && ANDROID_SYSTEM_IMAGE.test(systemImage.package)
    && typeof systemImage.revision === "string"
    && ANDROID_SDK_REVISION.test(systemImage.revision)
    && (authoredPackage === undefined || systemImage.package === authoredPackage);
}

function androidToolchainComplete(toolchain) {
  if (!exactObjectKeys(toolchain, ANDROID_TOOLCHAIN_NAMES)) return false;
  return ANDROID_TOOLCHAIN_NAMES.every((name) => {
    const expected = ANDROID_TOOLCHAIN_SPEC[name];
    return exactObjectKeys(toolchain[name], expected)
      && expected.every((key) => typeof toolchain[name][key] === "string" && toolchain[name][key].length > 0);
  });
}

function deletedLifecycle(value) {
  return value?.status === "deleted" && value.ownershipVerified === true;
}

function automatedGates({
  master,
  derivative,
  secretScan,
  reportPortable,
  source,
  android,
  androidProvenanceValid,
  androidExpected,
  androidSystemImageValid,
  androidToolchainValid,
  androidSourceEvidenceValid,
  lifecycle,
}) {
  const gates = [
    { id: "media.master", status: pass(master.ok), evidence: { file: master.file, checks: master.checks, duration: master.duration } },
    { id: "media.derivative", status: pass(derivative.ok), evidence: { file: derivative.file, checks: derivative.checks, duration: derivative.duration } },
    {
      id: "security.secret-scan",
      status: pass(secretScan.ok),
      evidence: {
        ...(Object.hasOwn(secretScan, "scannedFiles") ? { scannedFiles: secretScan.scannedFiles } : {}),
        ...(secretScan.visualScan ? { visualScan: secretScan.visualScan } : {}),
      },
    },
    {
      id: "security.report-portability",
      status: pass(reportPortable),
      evidence: { portable: reportPortable },
    },
  ];
  if (source?.type === "mobile") {
    gates.push({
      id: "mobile.capture-source",
      status: pass(mobileSourceComplete(source)),
      evidence: {
        width: source.width,
        height: source.height,
        landmarkCount: Array.isArray(source.landmarks) ? source.landmarks.length : 0,
      },
    });
  }
  if (androidExpected) {
    gates.push(
      {
        id: "android.apk-provenance",
        status: pass(androidProvenanceValid),
        evidence: {
          ref: android?.apk?.ref,
          sha256: android?.apk?.sha256,
          lock: android?.apk?.lock,
          source: android?.apk?.source,
        },
      },
      {
        id: "android.system-image",
        status: pass(androidSystemImageValid),
        evidence: android?.systemImage,
      },
      {
        id: "android.toolchain",
        status: pass(androidToolchainValid),
        evidence: android?.toolchain,
      },
      {
        id: "android.source-evidence",
        status: pass(androidSourceEvidenceValid),
        evidence: { artifactSha256: source?.validationEvidence?.artifactSha256 },
      },
      {
        id: "android.lifecycle.avd-deleted",
        status: pass(deletedLifecycle(lifecycle?.avd)),
        evidence: lifecycle?.avd,
      },
      {
        id: "android.lifecycle.cluster-deleted",
        status: pass(deletedLifecycle(lifecycle?.cluster)),
        evidence: lifecycle?.cluster,
      },
      {
        id: "android.lifecycle.acp-reverse-deleted",
        status: pass(deletedLifecycle(lifecycle?.acpReverse)),
        evidence: lifecycle?.acpReverse,
      },
    );
  }
  return gates;
}

function manualReview(master, derivative, manifest) {
  const requestedContactSheet = manifest?.artifacts?.contactSheet ?? "contact-sheet.png";
  const contactSheetPortable = isPortableRelativePath(requestedContactSheet);
  return {
    portable: isPortableRelativePath(master.file)
      && isPortableRelativePath(derivative.file)
      && contactSheetPortable,
    value: {
      required: true,
      status: "pending",
      gates: [
        { id: "manual.final-videos", status: "pending", artifacts: [master.file, derivative.file] },
        {
          id: "manual.contact-sheet",
          status: "pending",
          artifacts: [contactSheetPortable ? requestedContactSheet : "contact-sheet.png"],
        },
      ],
    },
  };
}

async function resolveMediaInputPath(value, outputDir, label) {
  const root = await fs.realpath(outputDir);
  const candidate = path.isAbsolute(value) ? path.resolve(value) : path.resolve(outputDir, value);
  const resolved = await fs.realpath(candidate);
  if (outside(root, resolved)) {
    throw new Error(`${label} must remain inside outputDir and must not escape through a symbolic link`);
  }
  return resolved;
}

export async function probeMedia(file, {
  ffprobe = "ffprobe",
  execute = runCommand,
  fileDescriptor,
} = {}) {
  const args = [
    "-v",
    "error",
    "-show_entries",
    "format=duration,format_name:format_tags:stream=index,codec_type,codec_name,width,height,pix_fmt,r_frame_rate,avg_frame_rate",
    "-of",
    "json",
    Number.isInteger(fileDescriptor) ? "/dev/fd/3" : file,
  ];
  const { stdout } = await execute(ffprobe, args, {
    inheritedFileDescriptors: Number.isInteger(fileDescriptor) ? [fileDescriptor] : [],
  });
  return JSON.parse(stdout);
}

export async function readFilePrefix(handle, sampleSize) {
  const buffer = Buffer.alloc(sampleSize);
  let position = 0;
  while (position < sampleSize) {
    const { bytesRead } = await handle.read(buffer, position, sampleSize - position, position);
    if (bytesRead === 0) break;
    position += bytesRead;
  }
  return buffer.subarray(0, position);
}

async function hasFastStart(file) {
  const handle = await fs.open(file, "r");
  try {
    const stat = await handle.stat();
    const sampleSize = Math.min(stat.size, 16 * 1024 * 1024);
    const buffer = await readFilePrefix(handle, sampleSize);
    const moov = buffer.indexOf(Buffer.from("moov"));
    const mdat = buffer.indexOf(Buffer.from("mdat"));
    return moov >= 0 && (mdat < 0 || moov < mdat);
  } finally {
    await handle.close();
  }
}

export async function validateVideoFile(
  file,
  { width, height, expectedDuration, ffprobe = "ffprobe", execute = runCommand },
) {
  if (expectedDuration !== undefined
    && (!Number.isFinite(expectedDuration) || expectedDuration <= 0)) {
    throw new Error("Media expected duration must be finite and positive");
  }
  const probe = await probeMedia(file, { ffprobe, execute });
  const video = probe.streams?.find((stream) => stream.codec_type === "video");
  const audio = probe.streams?.filter((stream) => stream.codec_type === "audio") ?? [];
  const checks = {
    exists: Boolean(video),
    dimensions: video?.width === width && video?.height === height,
    codec: video?.codec_name === "h264",
    pixelFormat: video?.pix_fmt === "yuv420p",
    frameRate: Math.abs(parseRate(video?.avg_frame_rate ?? video?.r_frame_rate) - 30) < 0.001,
    silent: audio.length === 0,
    mp4: String(probe.format?.format_name ?? "").split(",").includes("mp4"),
    fastStart: await hasFastStart(file),
  };
  const duration = Number(probe.format?.duration);
  checks.durationFinite = Number.isFinite(duration) && duration > 0;
  if (Number.isFinite(expectedDuration)) {
    checks.duration = Math.abs(duration - expectedDuration) <= 1 / 30 + 0.02;
  }
  return { file, ok: Object.values(checks).every(Boolean), checks, duration, probe };
}

function mobileStoryDuration(scenario) {
  const mobile = scenario?.story?.filter((segment) => segment?.type === "mobile") ?? [];
  const duration = mobile.reduce((sum, segment) => sum + Number(segment.durationSeconds), 0);
  return mobile.length > 0 && Number.isFinite(duration) && duration > 0 ? duration : undefined;
}

async function validateMobileCaptureArtifacts(context, { outputDir, ffprobe, execute }) {
  const source = context.manifest?.capture?.source;
  if (source?.type !== "mobile") return undefined;
  const artifacts = context.manifest?.artifacts;
  const digests = source.validationEvidence?.artifactSha256;
  const captureRoot = await fs.realpath(context.captureRoot ?? context.secretScanRoot ?? outputDir);
  const stage = await fs.mkdtemp(path.join(outputDir, ".capture-validation-"));
  try {
    const required = [
      ["mobileCapture", "verified-mobile-capture.mp4", Number.POSITIVE_INFINITY, false],
      ["pointerEvents", "verified-pointer-events.jsonl", MAX_POINTER_EVENTS_BYTES, true],
    ];
    if (context.manifest?.capture?.kind === "android-emulator"
      || isObject(context.manifest?.capture?.android)) {
      required.push(["androidApkLock", "verified-android-apk-lock.json", 64 * 1024, true]);
    }
    const verifiedEntries = [];
    for (const [name, file, maximumBytes, collectBytes] of required) {
      if (typeof artifacts?.[name] !== "string") {
        throw new Error(`Mobile validation requires manifest.artifacts.${name}`);
      }
      verifiedEntries.push([name, await verifyManifestArtifact({
        root: captureRoot,
        reference: artifacts[name],
        expectedSha256: digests?.[name],
        label: name,
        snapshotPath: path.join(stage, file),
        collectBytes,
        maximumBytes,
      })]);
    }
    const verified = Object.fromEntries(verifiedEntries);
    if (verified.androidApkLock) {
      let lock;
      try {
        lock = JSON.parse(verified.androidApkLock.bytes.toString("utf8"));
      } catch {
        throw new Error("Android APK lock evidence does not match capture provenance");
      }
      assertAndroidApkLock(
        lock,
        context.manifest.capture.android?.apk,
        "Android APK lock evidence does not match capture provenance",
      );
    }
    const openedMobile = await openDigestBoundArtifact(
      verified.mobileCapture.snapshotPath,
      digests.mobileCapture,
      "mobileCapture validation snapshot",
    );
    let probe;
    try {
      probe = await probeMedia(verified.mobileCapture.snapshotPath, {
        ffprobe,
        execute,
        fileDescriptor: openedMobile.handle.fd,
      });
      await verifyOpenArtifactUnchanged(openedMobile, "mobileCapture validation snapshot");
    } finally {
      await openedMobile.handle.close();
    }
    const videos = probe.streams?.filter((stream) => stream.codec_type === "video") ?? [];
    const audio = probe.streams?.filter((stream) => stream.codec_type === "audio") ?? [];
    const durationSeconds = Number(probe.format?.duration);
    if (videos.length !== 1
      || audio.length !== 0
      || videos[0].width !== source.width
      || videos[0].height !== source.height
      || !hasExactMobileFrameRates(videos[0])
      || !Number.isFinite(durationSeconds)
      || durationSeconds <= 0) {
      throw new Error("Verified mobile capture media does not match its manifest source metadata");
    }
    const evidenceDuration = Number(source.validationEvidence?.durationSeconds);
    if (!Number.isFinite(evidenceDuration)
      || Math.abs(evidenceDuration - durationSeconds) > MOBILE_CAPTURE_DURATION_TOLERANCE_SECONDS) {
      throw new Error("Verified mobile capture duration does not match capture validation evidence");
    }
    const authoredDuration = mobileStoryDuration(context.scenario);
    if (authoredDuration !== undefined
      && Math.abs(authoredDuration - durationSeconds) > MOBILE_CAPTURE_DURATION_TOLERANCE_SECONDS) {
      throw new Error(
        `Verified mobile capture duration does not match the authored mobile budget within ${MOBILE_CAPTURE_DURATION_TOLERANCE_SECONDS} seconds`,
      );
    }
    const pointerEvents = parsePointerEvents(verified.pointerEvents.bytes);
    if (context.manifest?.capture?.kind === "android-emulator"
      || isObject(context.manifest?.capture?.android)) {
      validateAndroidPointerEvents(pointerEvents);
    }
    validatePointerEventsAgainstDuration(pointerEvents, durationSeconds);
    if (Number.isInteger(source.validationEvidence?.pointerEventCount)
      && pointerEvents.length !== source.validationEvidence.pointerEventCount) {
      throw new Error("Verified pointerEvents count does not match capture validation evidence");
    }
    return { durationSeconds, pointerEventCount: pointerEvents.length };
  } finally {
    await fs.rm(stage, { recursive: true, force: true });
  }
}

export function buildValidationReport({
  master,
  derivative,
  secretScan,
  outputDir,
  manifest,
  scenario,
  sensitiveValues = [],
}) {
  const mobileSource = manifest?.capture?.source?.type === "mobile"
    ? manifest.capture.source
    : undefined;
  const android = portableAndroidMetadata(manifest?.capture?.android);
  const androidExpected = manifest?.capture?.kind === "android-emulator"
    || isObject(manifest?.capture?.android);
  const androidSystemImageValid = androidSystemImageComplete(
    manifest?.capture?.android?.systemImage,
    scenario?.capture?.android?.systemImage,
  );
  const androidToolchainValid = androidToolchainComplete(manifest?.capture?.android?.toolchain);
  const authoredAndroid = scenario?.capture?.android;
  const androidProvenanceValid = androidProvenanceComplete(android)
    && androidApkMetadataExact(manifest?.capture?.android)
    && authoredAndroidIdentityMatches(authoredAndroid, android?.apk?.applicationId);
  const androidSourceEvidenceValid = androidSourceEvidenceComplete(
    mobileSource,
    android,
    authoredAndroid,
  );
  const lifecycle = portableLifecycle(manifest?.capture?.lifecycle);
  const portableMaster = mediaReport(master, outputDir);
  const portableDerivative = mediaReport(derivative, outputDir);
  const selectedSource = mobileSource
    ? (androidExpected
      ? portableAndroidSource(mobileSource)
      : pick(mobileSource, ["type", "width", "height", "landmarks", "validationEvidence"]))
    : undefined;
  const portableSource = isPortableMetadata(selectedSource) ? selectedSource : undefined;
  const capture = mobileSource ? {
    ...(portableSource ? { source: portableSource } : {}),
    ...(android ? { android } : {}),
    ...(lifecycle ? { lifecycle } : {}),
  } : undefined;
  const review = manualReview(portableMaster, portableDerivative, manifest);
  const gates = automatedGates({
    master: portableMaster,
    derivative: portableDerivative,
    secretScan,
    reportPortable: review.portable,
    source: portableSource,
    android,
    androidProvenanceValid,
    androidExpected,
    androidSystemImageValid,
    androidToolchainValid,
    androidSourceEvidenceValid,
    lifecycle,
  });
  const report = {
    schemaVersion: 1,
    ok: gates.every((gate) => gate.status === "pass"),
    releaseReady: false,
    master: portableMaster,
    derivative: portableDerivative,
    secretScan,
    automatedGates: gates,
    manualReview: review.value,
    ...(capture ? { capture } : {}),
  };
  const reportFindings = scanTextForSecrets(
    JSON.stringify(report),
    "validation-report.json#metadata",
    { sensitiveValues },
  );
  if (reportFindings.length > 0) {
    report.master = redactedMediaReport(report.master, "demo-1080p.mp4");
    report.derivative = redactedMediaReport(report.derivative, "demo-720p.mp4");
    report.manualReview = manualReview(
      report.master,
      report.derivative,
      { artifacts: { contactSheet: "contact-sheet.png" } },
    ).value;
    delete report.capture;
    for (const gate of report.automatedGates) {
      gate.evidence = { redacted: true };
    }
    report.secretScan = {
      ok: false,
      findings: reportFindings,
      ...(Object.hasOwn(secretScan, "scannedFiles") ? { scannedFiles: secretScan.scannedFiles } : {}),
      ...(secretScan.visualScan ? { visualScan: secretScan.visualScan } : {}),
    };
    const securityGate = report.automatedGates.find((gate) => gate.id === "security.secret-scan");
    securityGate.status = "fail";
  }
  report.ok = report.automatedGates.every((gate) => gate.status === "pass");
  report.releaseReady = report.ok && report.manualReview.status === "pass";
  return report;
}

export async function validateMedia(context = {}) {
  const requestedOutputDir = path.resolve(
    context.outputDir ?? path.dirname(context.masterPath ?? context.outputs?.master ?? "."),
  );
  const outputDir = await fs.realpath(requestedOutputDir);
  const artifacts = context.manifest?.artifacts ?? {};
  const masterPath = await resolveMediaInputPath(
    context.masterPath ?? context.outputs?.master ?? artifacts.masterVideo ?? "demo-1080p.mp4",
    outputDir,
    "master video",
  );
  const derivativePath = await resolveMediaInputPath(
    context.derivativePath ?? context.outputs?.derivative ?? context.outputs?.video720p ?? artifacts.derivativeVideo ?? "demo-720p.mp4",
    outputDir,
    "derivative video",
  );
  const expectedDuration = context.expectedDuration ?? context.duration ?? context.manifest?.composition?.durationSeconds;
  if (expectedDuration !== undefined
    && (!Number.isFinite(expectedDuration) || expectedDuration <= 0)) {
    throw new Error("Media expected duration must be finite and positive");
  }
  const ffprobe = context.ffprobe ?? "ffprobe";
  const execute = context.execute ?? runCommand;
  await validateMobileCaptureArtifacts(context, { outputDir, ffprobe, execute });
  const [master, derivative] = await Promise.all([
    validateVideoFile(masterPath, { width: 1920, height: 1080, expectedDuration, ffprobe, execute }),
    validateVideoFile(derivativePath, { width: 1280, height: 720, expectedDuration, ffprobe, execute }),
  ]);
  const scanOutputs = context.scanOutputSecrets ?? scanOutputSecrets;
  const sensitiveValues = context.sensitiveValues
    ?? androidSetupSensitiveValues(context.scenario, context.environment ?? process.env);
  const secretScanRoot = await fs.realpath(context.secretScanRoot ?? outputDir);
  if (outside(secretScanRoot, outputDir)) {
    throw new Error("Media outputDir must remain inside the secret scan root");
  }
  const secretScan = await scanOutputs(secretScanRoot, {
    metadata: [
      { source: "master-metadata", value: master.probe.format?.tags ?? {} },
      { source: "derivative-metadata", value: derivative.probe.format?.tags ?? {} },
      ...(context.manifest ? [{ source: "manifest.lock.json#metadata", value: context.manifest }] : []),
    ],
    sensitiveValues,
  });
  const report = buildValidationReport({
    master,
    derivative,
    secretScan,
    outputDir,
    manifest: context.manifest,
    scenario: context.scenario,
    sensitiveValues,
  });
  const reportPath = await writeValidationReport(
    outputDir,
    context.reportPath ?? artifacts.validationReport ?? "validation-report.json",
    report,
  );
  if (!report.ok && context.throwOnFailure !== false) {
    if (!report.secretScan.ok) {
      throw new Error(`Secret-like data found in staged composition outputs: ${report.secretScan.findings.map((item) => item.source).join(", ")}`);
    }
    throw new Error(`Media validation failed; see ${reportPath}`);
  }
  return { ...report, reportPath };
}

export {
  hasFastStart,
  parseRate,
  resolveMediaInputPath,
  resolveReportPath,
  validateMobileCaptureArtifacts,
};
