import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import defaultFs from "node:fs/promises";
import path from "node:path";

export const ANDROID_EMULATOR_VSYNC_ARGS = Object.freeze(["-vsync-rate", "30"]);

const ANDROID_CAPTURE_FRAME_RATE = 30;
const MAX_SCREENRECORD_SECONDS = 180;
const DEFAULT_BIT_RATE = 8_000_000;
const MAX_BIT_RATE = 100_000_000;
const MAX_DIMENSION = 8192;
const ENCODER_DURATION_TOLERANCE_SECONDS = 1 / ANDROID_CAPTURE_FRAME_RATE;
const RAW_RECORDING_FILENAME = "screenrecord.h264";
const STAGED_RECORDING_FILENAME = "screenrecord.mp4";
const VALIDATION_SNAPSHOT_FILENAME = ".validated-screenrecord.mp4";
const STAGING_DIRECTORY_PATTERN = /^\.adb-screenrecord-[A-Za-z0-9._-]+$/;
const ownedStages = new WeakMap();
const ownedStagesByOutputPath = new Map();
const validatedOutputs = new WeakMap();

function assertSafeSerial(serial) {
  if (
    typeof serial !== "string"
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(serial)
  ) {
    throw new Error("ADB serial must be one exact, safe device identifier");
  }
}

function assertDimension(value, label) {
  if (!Number.isInteger(value) || value <= 0 || value > MAX_DIMENSION) {
    throw new Error(`${label} must be a positive integer no greater than ${MAX_DIMENSION}`);
  }
}

function assertPortraitDimensions(width, height) {
  assertDimension(width, "width");
  assertDimension(height, "height");
  if (height <= width) {
    throw new Error("ADB screenrecord dimensions must describe a portrait canvas");
  }
}

function isOutside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}

function assertLocalOutputPath(outputDir, localOutputPath) {
  if (
    typeof outputDir !== "string"
    || !path.isAbsolute(outputDir)
    || path.resolve(outputDir) !== outputDir
    || typeof localOutputPath !== "string"
    || !path.isAbsolute(localOutputPath)
    || path.resolve(localOutputPath) !== localOutputPath
    || isOutside(outputDir, localOutputPath)
    || localOutputPath === outputDir
    || path.extname(localOutputPath).toLowerCase() !== ".mp4"
  ) {
    throw new Error("local output path must be a normalized MP4 inside outputDir");
  }
}

function assertStagedOutputPath(stagingDir, stagedOutputPath) {
  if (
    typeof stagingDir !== "string"
    || !path.isAbsolute(stagingDir)
    || path.resolve(stagingDir) !== stagingDir
    || typeof stagedOutputPath !== "string"
    || !path.isAbsolute(stagedOutputPath)
    || path.resolve(stagedOutputPath) !== stagedOutputPath
    || path.dirname(stagedOutputPath) !== stagingDir
    || path.basename(stagedOutputPath) !== STAGED_RECORDING_FILENAME
  ) {
    throw new Error("staged output path must be the generated screenrecord.mp4 inside stagingDir");
  }
}

function assertRawOutputPath(stagingDir, rawOutputPath) {
  if (
    typeof stagingDir !== "string"
    || !path.isAbsolute(stagingDir)
    || path.resolve(stagingDir) !== stagingDir
    || typeof rawOutputPath !== "string"
    || !path.isAbsolute(rawOutputPath)
    || path.resolve(rawOutputPath) !== rawOutputPath
    || path.dirname(rawOutputPath) !== stagingDir
    || path.basename(rawOutputPath) !== RAW_RECORDING_FILENAME
  ) {
    throw new Error("raw output path must be generated screenrecord.h264 inside stagingDir");
  }
}

async function requireCanonicalDirectory(directory, label, fs) {
  if (
    typeof directory !== "string"
    || !path.isAbsolute(directory)
    || path.resolve(directory) !== directory
  ) {
    throw new Error(`${label} must be a normalized absolute canonical parent`);
  }
  const details = await fs.lstat(directory);
  const real = await fs.realpath(directory);
  if (details.isSymbolicLink() || !details.isDirectory() || real !== directory) {
    throw new Error(`${label} must be a canonical parent directory, not a symbolic link`);
  }
  return real;
}

async function requireAbsent(filePath, label, fs) {
  try {
    const details = await fs.lstat(filePath);
    if (details.isSymbolicLink()) {
      throw new Error(`${label} symbolic link already exists`);
    }
    throw new Error(`${label} already exists`);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
}

async function sha256File(filePath, fs) {
  const handle = await fs.open(filePath, "r");
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  try {
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    await handle.close();
  }
  return hash.digest("hex");
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs
    && left.mode === right.mode;
}

function sameNodeIdentity(details, expected) {
  return details.dev === expected.dev && details.ino === expected.ino;
}

async function requireOwnedParentIdentity(metadata) {
  const details = await metadata.fs.lstat(metadata.parent);
  if (
    details.isSymbolicLink()
    || !details.isDirectory()
    || !sameNodeIdentity(details, metadata.parentIdentity)
    || await metadata.fs.realpath(metadata.parent) !== metadata.parent
  ) {
    throw new Error("ADB recording stage canonical parent identity changed");
  }
}

async function requireOwnedStageIdentity(metadata, stagingDir) {
  await requireOwnedParentIdentity(metadata);
  if (
    path.dirname(stagingDir) !== metadata.parent
    || !STAGING_DIRECTORY_PATTERN.test(path.basename(stagingDir))
  ) {
    throw new Error("ADB recording stage path no longer matches its owned canonical parent");
  }
  const details = await metadata.fs.lstat(stagingDir);
  if (
    details.isSymbolicLink()
    || !details.isDirectory()
    || !sameNodeIdentity(details, metadata.stagingIdentity)
    || (details.mode & 0o777) !== 0o700
    || await metadata.fs.realpath(stagingDir) !== stagingDir
  ) {
    throw new Error("ADB recording stage identity changed");
  }
}

export async function createAdbScreenrecordStage({
  stagingParent,
  fs = defaultFs,
} = {}) {
  const parent = await requireCanonicalDirectory(stagingParent, "staging canonical parent", fs);
  const parentIdentity = await fs.lstat(parent);
  const stagingDir = await fs.mkdtemp(path.join(parent, ".adb-screenrecord-"));
  if (
    !path.isAbsolute(stagingDir)
    || path.resolve(stagingDir) !== stagingDir
    || path.dirname(stagingDir) !== parent
  ) {
    throw new Error("generated staging directory escaped its canonical parent");
  }
  const generated = await fs.lstat(stagingDir);
  if (generated.isSymbolicLink() || !generated.isDirectory()) {
    throw new Error("generated staging path must be a private directory");
  }
  await fs.chmod(stagingDir, 0o700);
  const secured = await fs.lstat(stagingDir);
  if (
    secured.isSymbolicLink()
    || !secured.isDirectory()
    || (secured.mode & 0o777) !== 0o700
    || await fs.realpath(stagingDir) !== stagingDir
  ) {
    throw new Error("generated staging directory must be canonical and mode 0700");
  }
  const rawOutputPath = path.join(stagingDir, RAW_RECORDING_FILENAME);
  const stagedOutputPath = path.join(stagingDir, STAGED_RECORDING_FILENAME);
  await requireAbsent(rawOutputPath, "raw staged filename must be absent;", fs);
  await requireAbsent(stagedOutputPath, "staged filename must be absent;", fs);
  const stage = Object.freeze({ stagingDir, rawOutputPath, stagedOutputPath });
  const metadata = Object.freeze({
    fs,
    parent,
    parentIdentity: Object.freeze({ dev: parentIdentity.dev, ino: parentIdentity.ino }),
    stagingIdentity: Object.freeze({ dev: secured.dev, ino: secured.ino }),
  });
  await requireOwnedParentIdentity(metadata);
  ownedStages.set(stage, metadata);
  if (ownedStagesByOutputPath.has(stagedOutputPath)) {
    throw new Error("generated staging output path collides with an active owned stage");
  }
  ownedStagesByOutputPath.set(stagedOutputPath, metadata);
  return stage;
}

export async function cleanupAdbScreenrecordStage({ stage } = {}) {
  const metadata = stage && typeof stage === "object" ? ownedStages.get(stage) : undefined;
  if (!metadata) {
    throw new Error("ADB recording cleanup requires the exact owned stage token");
  }
  const { fs, parent, stagingIdentity } = metadata;
  const { stagingDir, rawOutputPath, stagedOutputPath } = stage;
  assertRawOutputPath(stagingDir, rawOutputPath);
  assertStagedOutputPath(stagingDir, stagedOutputPath);
  if (
    path.dirname(stagingDir) !== parent
    || !STAGING_DIRECTORY_PATTERN.test(path.basename(stagingDir))
  ) {
    throw new Error("ADB recording stage path no longer matches its owned canonical parent");
  }
  await requireOwnedParentIdentity(metadata);

  let stagingDetails;
  try {
    stagingDetails = await fs.lstat(stagingDir);
  } catch (error) {
    if (error?.code === "ENOENT") {
      ownedStagesByOutputPath.delete(stagedOutputPath);
      return Object.freeze({ removed: false });
    }
    throw error;
  }
  if (
    stagingDetails.isSymbolicLink()
    || !stagingDetails.isDirectory()
    || !sameNodeIdentity(stagingDetails, stagingIdentity)
    || (stagingDetails.mode & 0o777) !== 0o700
    || await fs.realpath(stagingDir) !== stagingDir
  ) {
    throw new Error("ADB recording stage identity changed before cleanup");
  }

  const entries = await fs.readdir(stagingDir);
  const allowedEntries = new Set([
    RAW_RECORDING_FILENAME,
    STAGED_RECORDING_FILENAME,
    VALIDATION_SNAPSHOT_FILENAME,
  ]);
  if (entries.some((entry) => !allowedEntries.has(entry))) {
    throw new Error("ADB recording stage contains unexpected contents; refusing cleanup");
  }
  for (const entry of entries) {
    const ownedFilePath = path.join(stagingDir, entry);
    const ownedFileDetails = await fs.lstat(ownedFilePath);
    if (
      ownedFileDetails.isSymbolicLink()
      || !ownedFileDetails.isFile()
      || await fs.realpath(ownedFilePath) !== ownedFilePath
    ) {
      throw new Error("ADB recording staged file identity changed before cleanup");
    }
    await fs.unlink(ownedFilePath);
  }

  const beforeRemove = await fs.lstat(stagingDir);
  if (
    beforeRemove.isSymbolicLink()
    || !beforeRemove.isDirectory()
    || !sameNodeIdentity(beforeRemove, stagingIdentity)
    || (await fs.readdir(stagingDir)).length !== 0
  ) {
    throw new Error("ADB recording stage identity changed during cleanup");
  }
  await requireOwnedParentIdentity(metadata);
  await fs.rmdir(stagingDir);
  ownedStagesByOutputPath.delete(stagedOutputPath);
  try {
    await fs.lstat(stagingDir);
  } catch (error) {
    if (error?.code === "ENOENT") return Object.freeze({ removed: true });
    throw error;
  }
  throw new Error("ADB recording stage still exists after cleanup");
}

function adbStep(adbPath, serial, args) {
  return Object.freeze({
    executable: adbPath,
    args: Object.freeze(["-s", serial, ...args]),
  });
}

export function createAdbScreenrecordPlan({
  adbPath = "adb",
  ffmpegPath = "ffmpeg",
  serial,
  width,
  height,
  bitRate = DEFAULT_BIT_RATE,
  durationSeconds,
  minimumDurationSeconds,
  expectedDurationSeconds,
  maxDurationSeconds,
  stagingDir,
  rawOutputPath,
  stagedOutputPath,
  outputDir,
  localOutputPath,
} = {}) {
  if (typeof adbPath !== "string" || adbPath.length === 0 || adbPath.includes("\0")) {
    throw new Error("adbPath must identify one executable");
  }
  if (typeof ffmpegPath !== "string" || ffmpegPath.length === 0 || ffmpegPath.includes("\0")) {
    throw new Error("ffmpegPath must identify one executable");
  }
  assertSafeSerial(serial);
  assertPortraitDimensions(width, height);
  if (!Number.isInteger(bitRate) || bitRate <= 0 || bitRate > MAX_BIT_RATE) {
    throw new Error(`bitRate must be a positive integer no greater than ${MAX_BIT_RATE}`);
  }
  if (
    !Number.isInteger(durationSeconds)
    || durationSeconds < 1
    || durationSeconds > MAX_SCREENRECORD_SECONDS
  ) {
    throw new Error(`durationSeconds must be an integer from 1 to ${MAX_SCREENRECORD_SECONDS}`);
  }
  assertDurationContract({
    minimumDurationSeconds,
    expectedDurationSeconds,
    maxDurationSeconds,
  });
  const expectedMaximum = Math.min(
    durationSeconds,
    expectedDurationSeconds + ENCODER_DURATION_TOLERANCE_SECONDS,
  );
  if (Math.abs(maxDurationSeconds - expectedMaximum) > Number.EPSILON * 8) {
    throw new Error("authored maximum duration must match the one-frame window within the screenrecord time limit");
  }
  assertRawOutputPath(stagingDir, rawOutputPath);
  assertStagedOutputPath(stagingDir, stagedOutputPath);
  assertLocalOutputPath(outputDir, localOutputPath);
  const targetFrames = targetFramesForDuration(expectedDurationSeconds);

  return Object.freeze({
    emulatorLaunch: Object.freeze({
      requiredArgs: Object.freeze([...ANDROID_EMULATOR_VSYNC_ARGS]),
      frameRate: ANDROID_CAPTURE_FRAME_RATE,
    }),
    record: Object.freeze({
      ...adbStep(adbPath, serial, [
      "exec-out",
      "screenrecord",
      "--output-format=h264",
      "--size",
      `${width}x${height}`,
      "--bit-rate",
      String(bitRate),
      "--time-limit",
      String(durationSeconds),
      "-",
      ]),
      rawOutputPath,
    }),
    remux: Object.freeze({
      executable: ffmpegPath,
      args: Object.freeze([
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "h264",
        "-framerate",
        String(ANDROID_CAPTURE_FRAME_RATE),
        "-i",
        rawOutputPath,
        "-map",
        "0:v:0",
        "-an",
        "-c:v",
        "copy",
        "-frames:v",
        String(targetFrames),
        "-movflags",
        "+faststart",
        stagedOutputPath,
      ]),
      expectedDurationSeconds,
      rawOutputPath,
      stagedOutputPath,
      targetFrames,
    }),
    validation: Object.freeze({
      expectedOutputPath: stagedOutputPath,
      minimumDurationSeconds,
      expectedDurationSeconds,
      maxDurationSeconds,
      targetFrames,
      width,
      height,
      frameRate: ANDROID_CAPTURE_FRAME_RATE,
      videoStreams: 1,
      audioStreams: 0,
    }),
    publish: Object.freeze({
      stagedOutputPath,
      outputDir,
      destinationPath: localOutputPath,
    }),
  });
}

function parseFrameRate(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : Number.NaN;
  if (typeof value !== "string" || value.trim() !== value || value.length === 0) {
    return Number.NaN;
  }
  const match = /^([+-]?(?:\d+(?:\.\d+)?|\.\d+))(?:\/([+-]?(?:\d+(?:\.\d+)?|\.\d+)))?$/.exec(value);
  if (!match) return Number.NaN;
  const numerator = Number(match[1]);
  const denominator = Number(match[2] ?? "1");
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) {
    return Number.NaN;
  }
  return numerator / denominator;
}

function exactAuthoredDurationMilliseconds(expectedDurationSeconds) {
  if (!Number.isFinite(expectedDurationSeconds) || expectedDurationSeconds <= 0) {
    throw new Error("ADB screenrecord authored duration must be a positive millisecond value");
  }
  const milliseconds = Math.round(expectedDurationSeconds * 1_000);
  const tolerance = Number.EPSILON * Math.max(1, Math.abs(expectedDurationSeconds)) * 8;
  if (
    !Number.isSafeInteger(milliseconds)
    || milliseconds < 1
    || Math.abs((milliseconds / 1_000) - expectedDurationSeconds) > tolerance
  ) {
    throw new Error("ADB screenrecord authored duration must have exact millisecond precision");
  }
  return milliseconds;
}

function targetFramesForDuration(expectedDurationSeconds) {
  const milliseconds = exactAuthoredDurationMilliseconds(expectedDurationSeconds);
  return Math.ceil((milliseconds * ANDROID_CAPTURE_FRAME_RATE) / 1_000);
}

function parseExactInteger(value, label) {
  if (Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value !== "string" || !/^-?(?:0|[1-9]\d*)$/u.test(value)) {
    throw new Error(`${label} must be one exact integer`);
  }
  const parsed = BigInt(value);
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER) || parsed < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new Error(`${label} exceeds the safe integer bound`);
  }
  return parsed;
}

function parsePositiveTimeBase(value) {
  const match = /^(?:([1-9]\d*)\/([1-9]\d*))$/u.exec(value ?? "");
  if (!match) throw new Error("ADB screenrecord packet time base must be one positive rational");
  const numerator = BigInt(match[1]);
  const denominator = BigInt(match[2]);
  if (
    numerator > BigInt(Number.MAX_SAFE_INTEGER)
    || denominator > BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    throw new Error("ADB screenrecord packet time base exceeds the safe integer bound");
  }
  return { numerator, denominator };
}

function validatePacketCadence(probe, video, targetFrames) {
  if (!Array.isArray(probe?.packets) || probe.packets.length !== targetFrames) {
    throw new Error("ADB screenrecord output must contain the exact authored packet count");
  }
  if (parseExactInteger(
    video.nb_read_packets,
    "ADB screenrecord stream packet count",
  ) !== BigInt(targetFrames)) {
    throw new Error("ADB screenrecord stream packet count does not match the authored frame count");
  }
  if (!Number.isSafeInteger(video.index) || video.index < 0) {
    throw new Error("ADB screenrecord video stream requires one exact packet stream index");
  }
  const timeBase = parsePositiveTimeBase(video.time_base);
  const cadenceDenominator = timeBase.numerator * BigInt(ANDROID_CAPTURE_FRAME_RATE);
  if (timeBase.denominator % cadenceDenominator !== 0n) {
    throw new Error("ADB screenrecord packet time base cannot represent exact 30 FPS cadence");
  }
  const expectedDuration = timeBase.denominator / cadenceDenominator;
  if (expectedDuration <= 0n) {
    throw new Error("ADB screenrecord packet duration must represent exact 30 FPS cadence");
  }

  for (let index = 0; index < probe.packets.length; index += 1) {
    const packet = probe.packets[index];
    if (
      !packet
      || typeof packet !== "object"
      || Array.isArray(packet)
      || packet.codec_type !== "video"
      || packet.stream_index !== video.index
    ) {
      throw new Error("ADB screenrecord packet is not bound to the exact video stream");
    }
    const pts = parseExactInteger(packet.pts, "ADB screenrecord packet PTS");
    const dts = parseExactInteger(packet.dts, "ADB screenrecord packet DTS");
    const duration = parseExactInteger(packet.duration, "ADB screenrecord packet duration");
    const expectedTimestamp = BigInt(index) * expectedDuration;
    if (pts !== expectedTimestamp || dts !== expectedTimestamp) {
      throw new Error("ADB screenrecord packet timestamps must begin at zero and follow exact 30 FPS cadence");
    }
    if (duration !== expectedDuration) {
      throw new Error("ADB screenrecord packet duration must follow exact 30 FPS cadence");
    }
    if (index === 0 && (typeof packet.flags !== "string" || !packet.flags.includes("K"))) {
      throw new Error("ADB screenrecord first packet must be a keyframe at media zero");
    }
  }
}

function assertExpectedOutputPath(expectedOutputPath) {
  if (
    typeof expectedOutputPath !== "string"
    || !path.isAbsolute(expectedOutputPath)
    || path.resolve(expectedOutputPath) !== expectedOutputPath
    || path.extname(expectedOutputPath).toLowerCase() !== ".mp4"
  ) {
    throw new Error("expected output path must be one normalized absolute MP4 path");
  }
}

function assertExpectedStagedOutputPath(expectedOutputPath) {
  assertExpectedOutputPath(expectedOutputPath);
  if (
    path.basename(expectedOutputPath) !== STAGED_RECORDING_FILENAME
    || !STAGING_DIRECTORY_PATTERN.test(path.basename(path.dirname(expectedOutputPath)))
  ) {
    throw new Error("expected staged output path must identify generated screenrecord.mp4 staging");
  }
}

function assertDurationContract({
  expectedDurationSeconds,
  minimumDurationSeconds,
  maxDurationSeconds,
}) {
  exactAuthoredDurationMilliseconds(expectedDurationSeconds);
  const derivedMinimum = Math.max(
    Number.EPSILON,
    expectedDurationSeconds - ENCODER_DURATION_TOLERANCE_SECONDS,
  );
  if (
    !Number.isFinite(minimumDurationSeconds)
    || minimumDurationSeconds <= 0
    || !Number.isFinite(expectedDurationSeconds)
    || expectedDurationSeconds < minimumDurationSeconds
    || !Number.isFinite(maxDurationSeconds)
    || maxDurationSeconds < expectedDurationSeconds
    || maxDurationSeconds > expectedDurationSeconds + ENCODER_DURATION_TOLERANCE_SECONDS
    || Math.abs(minimumDurationSeconds - derivedMinimum) > Number.EPSILON * 8
  ) {
    throw new Error("ADB screenrecord duration contract must bind minimum, authored expected, and maximum durations");
  }
}

export function validateAdbScreenrecordOutput({
  expectedOutputPath,
  fileIdentity,
  probe,
  expectedDurationSeconds,
  minimumDurationSeconds,
  maxDurationSeconds,
  targetFrames,
  width,
  height,
} = {}) {
  assertExpectedStagedOutputPath(expectedOutputPath);
  if (!fileIdentity || fileIdentity.isSymbolicLink !== false) {
    throw new Error("ADB screenrecord output must not be a symbolic link");
  }
  if (fileIdentity.isFile !== true) {
    throw new Error("ADB screenrecord output must be a regular file");
  }
  if (
    fileIdentity.requestedPath !== expectedOutputPath
    || fileIdentity.realPath !== expectedOutputPath
  ) {
    throw new Error("ADB screenrecord output path identity does not match the requested file");
  }
  if (!Number.isSafeInteger(fileIdentity.sizeBytes) || fileIdentity.sizeBytes <= 0) {
    throw new Error("ADB screenrecord output must be a nonempty file");
  }
  if (!/^[a-f0-9]{64}$/.test(fileIdentity.sha256 ?? "")) {
    throw new Error("ADB screenrecord output must have a lowercase SHA-256 digest");
  }

  if (!Array.isArray(probe?.streams)) {
    throw new Error("ADB screenrecord output requires ffprobe stream metadata");
  }
  const videos = probe.streams.filter((stream) => stream?.codec_type === "video");
  const audios = probe.streams.filter((stream) => stream?.codec_type === "audio");
  if (videos.length !== 1) {
    throw new Error("ADB screenrecord output must contain exactly one video stream");
  }
  if (audios.length !== 0) {
    throw new Error("ADB screenrecord output must contain no audio streams");
  }

  assertDurationContract({ expectedDurationSeconds, minimumDurationSeconds, maxDurationSeconds });
  const video = videos[0];
  const expectedTargetFrames = targetFramesForDuration(expectedDurationSeconds);
  const suppliedRates = [video.avg_frame_rate, video.r_frame_rate];
  if (
    suppliedRates.some((rate) => rate === undefined || rate === null)
    || suppliedRates.some((rate) => parseFrameRate(rate) !== ANDROID_CAPTURE_FRAME_RATE)
  ) {
    throw new Error("ADB screenrecord output must be exactly 30 FPS");
  }
  const exactTargetFrames = targetFrames ?? expectedTargetFrames;
  const readFrameCount = parseExactInteger(
    video.nb_read_frames,
    "ADB screenrecord decoded frame count",
  );
  if (
    !Number.isSafeInteger(exactTargetFrames)
    || exactTargetFrames < 1
    || exactTargetFrames !== expectedTargetFrames
    || video.codec_name !== "h264"
    || readFrameCount !== BigInt(exactTargetFrames)
  ) {
    throw new Error("ADB screenrecord output must contain the exact authored H.264 frame count");
  }
  validatePacketCadence(probe, video, exactTargetFrames);

  assertPortraitDimensions(width, height);
  if (
    !Number.isInteger(video.width)
    || !Number.isInteger(video.height)
    || video.width !== width
    || video.height !== height
  ) {
    throw new Error("ADB screenrecord output dimensions do not match the capture plan");
  }

  const durationSeconds = Number(probe?.format?.duration);
  const frameDurationSeconds = exactTargetFrames / ANDROID_CAPTURE_FRAME_RATE;
  if (
    !Number.isFinite(durationSeconds)
    || durationSeconds <= 0
    || durationSeconds < minimumDurationSeconds
    || durationSeconds > maxDurationSeconds
    || Math.abs(durationSeconds - frameDurationSeconds) > 0.000_001
  ) {
    throw new Error("ADB screenrecord output duration is outside the authored duration contract");
  }

  return Object.freeze({
    ok: true,
    outputPath: expectedOutputPath,
    sizeBytes: fileIdentity.sizeBytes,
    sha256: fileIdentity.sha256,
    durationSeconds,
    width: video.width,
    height: video.height,
    frameRate: ANDROID_CAPTURE_FRAME_RATE,
    frameCount: exactTargetFrames,
    packetCount: probe.packets.length,
    videoStreams: videos.length,
    audioStreams: audios.length,
  });
}

export async function validateStagedAdbScreenrecordOutput({
  expectedOutputPath,
  outputDir,
  destinationPath,
  probeFile,
  expectedDurationSeconds,
  minimumDurationSeconds,
  maxDurationSeconds,
  targetFrames,
  width,
  height,
  fs = defaultFs,
  hashFile,
} = {}) {
  assertExpectedStagedOutputPath(expectedOutputPath);
  const stageMetadata = ownedStagesByOutputPath.get(expectedOutputPath);
  if (!stageMetadata || stageMetadata.fs !== fs) {
    throw new Error("staged ADB validation requires the exact active owned stage");
  }
  const stagingDir = path.dirname(expectedOutputPath);
  await requireOwnedStageIdentity(stageMetadata, stagingDir);
  const canonicalOutputDir = await requireCanonicalDirectory(
    outputDir,
    "validation outputDir canonical parent",
    fs,
  );
  assertLocalOutputPath(canonicalOutputDir, destinationPath);
  await requireCanonicalDirectory(
    path.dirname(destinationPath),
    "validation destination parent canonical directory",
    fs,
  );
  const snapshotPath = path.join(
    path.dirname(expectedOutputPath),
    VALIDATION_SNAPSHOT_FILENAME,
  );
  await requireAbsent(snapshotPath, "validation snapshot", fs);
  const before = await fs.lstat(expectedOutputPath);
  if (before.isSymbolicLink()) {
    throw new Error("staged ADB screenrecord output must not be a symbolic link");
  }
  if (!before.isFile() || before.size <= 0) {
    throw new Error("staged ADB screenrecord output must be a nonempty regular file");
  }
  const realPath = await fs.realpath(expectedOutputPath);
  if (realPath !== expectedOutputPath) {
    throw new Error("staged ADB screenrecord output path identity does not match its canonical file");
  }
  if (typeof probeFile !== "function") {
    throw new Error("staged ADB screenrecord validation requires an injected ffprobe function");
  }
  await fs.copyFile(expectedOutputPath, snapshotPath, fsConstants.COPYFILE_EXCL);
  await fs.chmod(snapshotPath, 0o400);
  const snapshotBefore = await fs.lstat(snapshotPath);
  if (
    snapshotBefore.isSymbolicLink()
    || !snapshotBefore.isFile()
    || snapshotBefore.size <= 0
    || (snapshotBefore.mode & 0o777) !== 0o400
    || await fs.realpath(snapshotPath) !== snapshotPath
  ) {
    throw new Error("staged ADB validation snapshot must be one private immutable regular file");
  }
  const sourceAfterCopy = await fs.lstat(expectedOutputPath);
  if (
    sourceAfterCopy.isSymbolicLink()
    || !sourceAfterCopy.isFile()
    || !sameFileIdentity(before, sourceAfterCopy)
  ) {
    throw new Error("staged ADB screenrecord output identity changed while snapshotting");
  }
  await requireOwnedStageIdentity(stageMetadata, stagingDir);

  const probe = await probeFile(snapshotPath);
  const sha256 = await (hashFile
    ? hashFile(snapshotPath, { fs })
    : sha256File(snapshotPath, fs));
  const after = await fs.lstat(snapshotPath);
  if (
    after.isSymbolicLink()
    || !after.isFile()
    || !sameFileIdentity(snapshotBefore, after)
  ) {
    throw new Error("staged ADB screenrecord validation snapshot identity changed during validation");
  }
  await requireOwnedStageIdentity(stageMetadata, stagingDir);
  const validatedOutput = validateAdbScreenrecordOutput({
    expectedOutputPath,
    fileIdentity: {
      requestedPath: expectedOutputPath,
      realPath,
      isFile: true,
      isSymbolicLink: false,
      sizeBytes: after.size,
      sha256,
    },
    probe,
    expectedDurationSeconds,
    minimumDurationSeconds,
    maxDurationSeconds,
    targetFrames,
    width,
    height,
  });
  validatedOutputs.set(validatedOutput, {
    sourcePath: expectedOutputPath,
    snapshotPath,
    snapshotIdentity: after,
    outputDir: canonicalOutputDir,
    destinationPath,
    stageMetadata,
    state: "ready",
  });
  return validatedOutput;
}

async function removeMismatchedPublication(destinationPath, publishedIdentity, fs) {
  const current = await fs.lstat(destinationPath);
  if (
    current.isSymbolicLink()
    || !current.isFile()
    || !sameNodeIdentity(current, publishedIdentity)
  ) {
    throw new Error("mismatched publish destination identity changed before rollback");
  }
  await fs.unlink(destinationPath);
  try {
    await fs.lstat(destinationPath);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw new Error("mismatched publish destination remains after rollback");
}

export async function publishAdbScreenrecordOutput({
  validatedOutput,
  stagedOutputPath,
  outputDir,
  destinationPath,
  publicationPath = destinationPath,
  fs = defaultFs,
  hashFile,
} = {}) {
  if (validatedOutput?.ok !== true) {
    throw new Error("exclusive publish requires a validated staged recording");
  }
  const validationMetadata = validatedOutputs.get(validatedOutput);
  if (!validationMetadata) {
    throw new Error("exclusive publish requires the exact validation token");
  }
  if (stagedOutputPath !== validatedOutput.outputPath) {
    throw new Error("exclusive publish staged path does not match the validation token");
  }
  if (stagedOutputPath !== validationMetadata.sourcePath) {
    throw new Error("exclusive publish staged path does not match its owned validation source");
  }
  if (
    outputDir !== validationMetadata.outputDir
    || destinationPath !== validationMetadata.destinationPath
  ) {
    throw new Error("exclusive publish destination does not match the validation token");
  }
  if (validationMetadata.state !== "ready") {
    throw new Error(`exclusive publish validation token is ${validationMetadata.state}`);
  }
  validationMetadata.state = "publishing";
  assertExpectedStagedOutputPath(stagedOutputPath);
  let publicationLinked = false;
  try {
    const publishSourcePath = validationMetadata.snapshotPath;
    await requireOwnedStageIdentity(
      validationMetadata.stageMetadata,
      path.dirname(stagedOutputPath),
    );
    const canonicalOutputDir = await requireCanonicalDirectory(
      outputDir,
      "publish outputDir canonical parent",
      fs,
    );
    assertLocalOutputPath(canonicalOutputDir, publicationPath);
    await requireCanonicalDirectory(
      path.dirname(publicationPath),
      "publish destination parent canonical directory",
      fs,
    );

    const before = await fs.lstat(publishSourcePath);
    if (before.isSymbolicLink() || !before.isFile() || before.size <= 0) {
      throw new Error("exclusive publish source must remain a nonempty regular staged file");
    }
    if (
      !sameFileIdentity(before, validationMetadata.snapshotIdentity)
      || await fs.realpath(publishSourcePath) !== publishSourcePath
    ) {
      throw new Error("exclusive publish source path identity changed after validation");
    }
    const sha256 = await (hashFile
      ? hashFile(publishSourcePath, { fs })
      : sha256File(publishSourcePath, fs));
    const after = await fs.lstat(publishSourcePath);
    if (
      after.isSymbolicLink()
      || !after.isFile()
      || !sameFileIdentity(before, after)
      || after.size !== validatedOutput.sizeBytes
      || sha256 !== validatedOutput.sha256
    ) {
      throw new Error("exclusive publish source no longer matches the validated staged recording");
    }
    await requireOwnedStageIdentity(
      validationMetadata.stageMetadata,
      path.dirname(stagedOutputPath),
    );

    await requireAbsent(publicationPath, "publish destination", fs);
    try {
      await fs.link(publishSourcePath, publicationPath);
      publicationLinked = true;
    } catch (error) {
      if (error?.code === "EEXIST") {
        throw new Error("exclusive publish failed because destination already exists", { cause: error });
      }
      if (error?.code === "EXDEV") {
        throw new Error("exclusive publish requires staging and output on the same filesystem", { cause: error });
      }
      throw error;
    }

    let published;
    try {
      published = await fs.lstat(publicationPath);
      const sourceAfterLink = await fs.lstat(publishSourcePath);
      const publishedSha256 = await (hashFile
        ? hashFile(publicationPath, { fs })
        : sha256File(publicationPath, fs));
      const publishedAfterHash = await fs.lstat(publicationPath);
      const sourceAfterHash = await fs.lstat(publishSourcePath);
      if (
        published.isSymbolicLink()
        || !published.isFile()
        || sourceAfterLink.isSymbolicLink()
        || !sourceAfterLink.isFile()
        || sourceAfterLink.dev !== validationMetadata.snapshotIdentity.dev
        || sourceAfterLink.ino !== validationMetadata.snapshotIdentity.ino
        || sourceAfterLink.size !== validationMetadata.snapshotIdentity.size
        || sourceAfterLink.mode !== validationMetadata.snapshotIdentity.mode
        || published.dev !== validationMetadata.snapshotIdentity.dev
        || published.ino !== validationMetadata.snapshotIdentity.ino
        || published.size !== validationMetadata.snapshotIdentity.size
        || published.mode !== validationMetadata.snapshotIdentity.mode
        || !sameFileIdentity(published, sourceAfterLink)
        || !sameFileIdentity(published, publishedAfterHash)
        || !sameFileIdentity(sourceAfterLink, sourceAfterHash)
        || !sameFileIdentity(publishedAfterHash, sourceAfterHash)
        || publishedSha256 !== validatedOutput.sha256
      ) {
        throw new Error("exclusive publish result does not match the validated staged recording");
      }
    } catch (error) {
      try {
        await removeMismatchedPublication(
          publicationPath,
          published ?? validationMetadata.snapshotIdentity,
          fs,
        );
        const refreshedSnapshot = await fs.lstat(publishSourcePath);
        const refreshedSha256 = await (hashFile
          ? hashFile(publishSourcePath, { fs })
          : sha256File(publishSourcePath, fs));
        const refreshedSnapshotAfterHash = await fs.lstat(publishSourcePath);
        if (
          refreshedSnapshot.isSymbolicLink()
          || !refreshedSnapshot.isFile()
          || refreshedSnapshot.dev !== validationMetadata.snapshotIdentity.dev
          || refreshedSnapshot.ino !== validationMetadata.snapshotIdentity.ino
          || refreshedSnapshot.size !== validationMetadata.snapshotIdentity.size
          || refreshedSnapshot.mode !== validationMetadata.snapshotIdentity.mode
          || !sameFileIdentity(refreshedSnapshot, refreshedSnapshotAfterHash)
          || refreshedSha256 !== validatedOutput.sha256
          || await fs.realpath(publishSourcePath) !== publishSourcePath
        ) {
          throw new Error("validated publication snapshot changed during exact rollback");
        }
        validationMetadata.snapshotIdentity = refreshedSnapshotAfterHash;
        publicationLinked = false;
      } catch (cleanupError) {
        validationMetadata.state = "poisoned";
        throw new AggregateError(
          [error, cleanupError],
          "exclusive publish verification and exact rollback failed",
        );
      }
      throw error;
    }
    validationMetadata.state = "consumed";
    return Object.freeze({
      outputPath: publicationPath,
      stagedOutputPath,
      sizeBytes: published.size,
      sha256,
    });
  } catch (error) {
    if (validationMetadata.state === "publishing") {
      validationMetadata.state = publicationLinked ? "poisoned" : "ready";
    }
    throw error;
  }
}
