import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ANDROID_EMULATOR_VSYNC_ARGS,
  cleanupAdbScreenrecordStage,
  createAdbScreenrecordPlan,
  createAdbScreenrecordStage,
  publishAdbScreenrecordOutput,
  validateAdbScreenrecordOutput,
  validateStagedAdbScreenrecordOutput,
} from "../../../scripts/capture/android/recording.mjs";

const OUTPUT_DIR = "/tmp/acp demo output";
const OUTPUT_PATH = `${OUTPUT_DIR}/session-01.mp4`;
const STAGING_DIR = `${OUTPUT_DIR}/.adb-screenrecord-test`;
const RAW_PATH = `${STAGING_DIR}/screenrecord.h264`;
const STAGED_PATH = `${STAGING_DIR}/screenrecord.mp4`;
const SHA256 = "a".repeat(64);
const ONE_FRAME_SECONDS = 1 / 30;
const MINIMUM_42_SECOND_RECORDING = 42 - ONE_FRAME_SECONDS;
const MAXIMUM_42_SECOND_RECORDING = 42 + ONE_FRAME_SECONDS;

function validPackets(count, overrides = {}) {
  return Array.from({ length: count }, (_, index) => ({
    codec_type: "video",
    stream_index: 0,
    pts: String(index * 512),
    dts: String(index * 512),
    duration: "512",
    flags: index === 0 ? "K__" : "___",
    ...overrides,
  }));
}

function validValidationInput(overrides = {}) {
  const base = {
    expectedOutputPath: STAGED_PATH,
    fileIdentity: {
      requestedPath: STAGED_PATH,
      realPath: STAGED_PATH,
      isFile: true,
      isSymbolicLink: false,
      sizeBytes: 4096,
      sha256: SHA256,
    },
    probe: {
      streams: [{
        index: 0,
        codec_type: "video",
        codec_name: "h264",
        nb_read_frames: "1260",
        nb_read_packets: "1260",
        time_base: "1/15360",
        width: 1080,
        height: 2400,
        avg_frame_rate: "30/1",
        r_frame_rate: "30/1",
      }],
      format: { duration: "42" },
      packets: validPackets(1260),
    },
    maxDurationSeconds: MAXIMUM_42_SECOND_RECORDING,
    expectedDurationSeconds: 42,
    minimumDurationSeconds: MINIMUM_42_SECOND_RECORDING,
    targetFrames: 1260,
    width: 1080,
    height: 2400,
  };
  return {
    ...base,
    ...overrides,
    fileIdentity: { ...base.fileIdentity, ...overrides.fileIdentity },
    probe: {
      ...base.probe,
      ...overrides.probe,
      format: { ...base.probe.format, ...overrides.probe?.format },
    },
  };
}

function validProbeFile(calls = []) {
  return async (filePath) => {
    calls.push(filePath);
    return validValidationInput().probe;
  };
}

test("ADB screenrecord plan binds every command to one device and the owned 30 FPS emulator", () => {
  const plan = createAdbScreenrecordPlan({
    adbPath: "/opt/android sdk/platform-tools/adb",
    ffmpegPath: "/opt/homebrew/bin/ffmpeg",
    serial: "emulator-5554",
    width: 1080,
    height: 2400,
    bitRate: 12_000_000,
    durationSeconds: 43,
    minimumDurationSeconds: MINIMUM_42_SECOND_RECORDING,
    expectedDurationSeconds: 42,
    maxDurationSeconds: MAXIMUM_42_SECOND_RECORDING,
    stagingDir: STAGING_DIR,
    rawOutputPath: RAW_PATH,
    stagedOutputPath: STAGED_PATH,
    outputDir: OUTPUT_DIR,
    localOutputPath: OUTPUT_PATH,
  });

  assert.deepEqual(ANDROID_EMULATOR_VSYNC_ARGS, ["-vsync-rate", "30"]);
  assert.deepEqual(plan, {
    emulatorLaunch: {
      requiredArgs: ["-vsync-rate", "30"],
      frameRate: 30,
    },
    record: {
      executable: "/opt/android sdk/platform-tools/adb",
      args: [
        "-s",
        "emulator-5554",
        "exec-out",
        "screenrecord",
        "--output-format=h264",
        "--size",
        "1080x2400",
        "--bit-rate",
        "12000000",
        "--time-limit",
        "43",
        "-",
      ],
      rawOutputPath: RAW_PATH,
    },
    remux: {
      executable: "/opt/homebrew/bin/ffmpeg",
      args: [
        "-nostdin", "-hide_banner", "-loglevel", "error",
        "-f", "h264", "-framerate", "30", "-i", RAW_PATH,
        "-map", "0:v:0", "-an", "-c:v", "copy", "-frames:v", "1260",
        "-movflags", "+faststart", STAGED_PATH,
      ],
      expectedDurationSeconds: 42,
      rawOutputPath: RAW_PATH,
      stagedOutputPath: STAGED_PATH,
      targetFrames: 1260,
    },
    validation: {
      expectedOutputPath: STAGED_PATH,
      maxDurationSeconds: MAXIMUM_42_SECOND_RECORDING,
      expectedDurationSeconds: 42,
      minimumDurationSeconds: MINIMUM_42_SECOND_RECORDING,
      targetFrames: 1260,
      width: 1080,
      height: 2400,
      frameRate: 30,
      videoStreams: 1,
      audioStreams: 0,
    },
    publish: {
      stagedOutputPath: STAGED_PATH,
      outputDir: OUTPUT_DIR,
      destinationPath: OUTPUT_PATH,
    },
  });

  assert.deepEqual(Object.keys(plan.record).sort(), ["args", "executable", "rawOutputPath"]);
  assert.deepEqual(Object.keys(plan.remux).sort(), [
    "args", "executable", "expectedDurationSeconds", "rawOutputPath", "stagedOutputPath", "targetFrames",
  ]);
  assert.equal(plan.record.args[1], "emulator-5554");
  const screenrecordArgs = plan.record.args.slice(
    plan.record.args.indexOf("screenrecord") + 1,
  );
  assert.deepEqual(screenrecordArgs, [
    "--output-format=h264",
    "--size",
    "1080x2400",
    "--bit-rate",
    "12000000",
    "--time-limit",
    "43",
    "-",
  ]);
  assert.equal(plan.record.args.includes("--fps"), false);
  assert.equal(plan.record.args.some((value) => /audio/i.test(value)), false);
});

test("ADB screenrecord plan rejects unsafe serials, paths, and recording bounds", () => {
  const valid = {
    serial: "emulator-5554",
    width: 1080,
    height: 2400,
    durationSeconds: 43,
    minimumDurationSeconds: MINIMUM_42_SECOND_RECORDING,
    expectedDurationSeconds: 42,
    maxDurationSeconds: MAXIMUM_42_SECOND_RECORDING,
    stagingDir: STAGING_DIR,
    rawOutputPath: RAW_PATH,
    stagedOutputPath: STAGED_PATH,
    outputDir: OUTPUT_DIR,
    localOutputPath: OUTPUT_PATH,
  };

  for (const serial of ["", "-d", "emulator 5554", "emulator-5554;rm", "../device"]) {
    assert.throws(
      () => createAdbScreenrecordPlan({ ...valid, serial }),
      /serial/,
    );
  }
  for (const rawOutputPath of [
    "relative.h264",
    `${STAGING_DIR}/../escape.h264`,
    `${STAGING_DIR}/screenrecord.mp4`,
    `${OUTPUT_DIR}/screenrecord.h264`,
    `${STAGING_DIR}/screen record.h264`,
  ]) {
    assert.throws(
      () => createAdbScreenrecordPlan({ ...valid, rawOutputPath }),
      /raw output path/,
    );
  }
  for (const localOutputPath of [
    "relative.mp4",
    "/tmp/outside.mp4",
    `${OUTPUT_DIR}/../escape.mp4`,
    `${OUTPUT_DIR}/session.webm`,
  ]) {
    assert.throws(
      () => createAdbScreenrecordPlan({ ...valid, localOutputPath }),
      /local output path/,
    );
  }
  for (const staging of [
    {
      stagingDir: "relative-stage",
      rawOutputPath: "relative-stage/screenrecord.h264",
      stagedOutputPath: "relative-stage/screenrecord.mp4",
    },
    { stagingDir: STAGING_DIR, stagedOutputPath: OUTPUT_PATH },
    { stagingDir: STAGING_DIR, stagedOutputPath: `${STAGING_DIR}/caller-name.mp4` },
  ]) {
    assert.throws(
      () => createAdbScreenrecordPlan({ ...valid, ...staging }),
      /output path/,
    );
  }
  for (const durationSeconds of [0, 181, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => createAdbScreenrecordPlan({ ...valid, durationSeconds }),
      /durationSeconds/,
    );
  }
  assert.equal(
    createAdbScreenrecordPlan({ ...valid, bitRate: 100_000_000 }).record.args.includes("100000000"),
    true,
  );
  assert.throws(
    () => createAdbScreenrecordPlan({ ...valid, bitRate: 100_000_001 }),
    /100000000/,
  );
});

test("ADB screenrecord plan rejects caller-controlled raw staging filenames", () => {
  const valid = {
    serial: "emulator-5554",
    width: 1080,
    height: 2400,
    durationSeconds: 43,
    minimumDurationSeconds: MINIMUM_42_SECOND_RECORDING,
    expectedDurationSeconds: 42,
    maxDurationSeconds: MAXIMUM_42_SECOND_RECORDING,
    stagingDir: STAGING_DIR,
    rawOutputPath: RAW_PATH,
    stagedOutputPath: STAGED_PATH,
    outputDir: OUTPUT_DIR,
    localOutputPath: OUTPUT_PATH,
  };
  for (const rawOutputPath of [
    `${STAGING_DIR}/session;id.h264`,
    `${STAGING_DIR}/session$(id).h264`,
    `${STAGING_DIR}/session'id.h264`,
    `${STAGING_DIR}/session\"id.h264`,
    `${STAGING_DIR}/session\`id\`.h264`,
    `${STAGING_DIR}/session\u0001id.h264`,
  ]) {
    assert.throws(
      () => createAdbScreenrecordPlan({ ...valid, rawOutputPath }),
      /raw output path/,
    );
  }
});

test("ADB screenrecord plan permits a normalized nested child of outputDir", () => {
  const nestedOutputPath = `${OUTPUT_DIR}/raw/android.mp4`;
  const plan = createAdbScreenrecordPlan({
    serial: "emulator-5554",
    width: 1080,
    height: 2400,
    durationSeconds: 43,
    minimumDurationSeconds: MINIMUM_42_SECOND_RECORDING,
    expectedDurationSeconds: 42,
    maxDurationSeconds: MAXIMUM_42_SECOND_RECORDING,
    stagingDir: STAGING_DIR,
    rawOutputPath: RAW_PATH,
    stagedOutputPath: STAGED_PATH,
    outputDir: OUTPUT_DIR,
    localOutputPath: nestedOutputPath,
  });
  assert.equal(plan.publish.destinationPath, nestedOutputPath);
  assert.equal(plan.remux.args.at(-1), STAGED_PATH);
});

test("raw ADB screenrecord validation accepts one exact 30 FPS silent video", () => {
  assert.deepEqual(validateAdbScreenrecordOutput(validValidationInput()), {
    ok: true,
    outputPath: STAGED_PATH,
    sizeBytes: 4096,
    sha256: SHA256,
    durationSeconds: 42,
    width: 1080,
    height: 2400,
    frameRate: 30,
    frameCount: 1260,
    packetCount: 1260,
    videoStreams: 1,
    audioStreams: 0,
  });
});

test("raw ADB screenrecord validation binds exact frames within the authored one-frame window", () => {
  const oneFrame = 1 / 30;
  const validated = validateAdbScreenrecordOutput(validValidationInput());
  assert.equal(validated.durationSeconds, 42);
  assert.equal(validated.frameCount, 1260);

  for (const duration of [42 - oneFrame, 42 + oneFrame]) {
    assert.throws(
      () => validateAdbScreenrecordOutput(validValidationInput({
        probe: { format: { duration: String(duration) } },
      })),
      /authored duration|duration/i,
    );
  }

  const fractional = validateAdbScreenrecordOutput(validValidationInput({
    expectedDurationSeconds: 41.2,
    minimumDurationSeconds: 41.2 - ONE_FRAME_SECONDS,
    maxDurationSeconds: 41.2 + ONE_FRAME_SECONDS,
    targetFrames: 1236,
    probe: {
      streams: [{
        ...validValidationInput().probe.streams[0],
        nb_read_frames: "1236",
        nb_read_packets: "1236",
      }],
      format: { duration: "41.2" },
      packets: validPackets(1236),
    },
  }));
  assert.equal(fractional.frameCount, 1236);
  assert.equal(fractional.packetCount, 1236);
});

test("frame targets derive from exact authored milliseconds without binary overcount", () => {
  const authoredMilliseconds = 8_300;
  const expectedDurationSeconds = authoredMilliseconds / 1_000;
  const targetFrames = Math.ceil((authoredMilliseconds * 30) / 1_000);
  const plan = createAdbScreenrecordPlan({
    serial: "emulator-5554",
    width: 1080,
    height: 2400,
    durationSeconds: 9,
    minimumDurationSeconds: expectedDurationSeconds - ONE_FRAME_SECONDS,
    expectedDurationSeconds,
    maxDurationSeconds: expectedDurationSeconds + ONE_FRAME_SECONDS,
    stagingDir: STAGING_DIR,
    rawOutputPath: RAW_PATH,
    stagedOutputPath: STAGED_PATH,
    outputDir: OUTPUT_DIR,
    localOutputPath: OUTPUT_PATH,
  });

  assert.equal(targetFrames, 249);
  assert.equal(plan.remux.targetFrames, 249);
  assert.equal(plan.validation.targetFrames, 249);
  assert.equal(plan.remux.args[16], "249");
});

test("raw ADB screenrecord validation proves exact packet count and 30 FPS cadence", () => {
  const base = validValidationInput();
  const mutations = [
    ["missing packets", { packets: undefined }],
    ["short packet list", { packets: base.probe.packets.slice(0, -1) }],
    ["wrong stream packet", {
      packets: base.probe.packets.map((packet, index) => (
        index === 1 ? { ...packet, stream_index: 1 } : packet
      )),
    }],
    ["non-key first packet", {
      packets: base.probe.packets.map((packet, index) => (
        index === 0 ? { ...packet, flags: "___" } : packet
      )),
    }],
    ["nonzero first timestamp", {
      packets: base.probe.packets.map((packet, index) => (
        index === 0 ? { ...packet, pts: "512", dts: "512" } : packet
      )),
    }],
    ["non-monotonic PTS", {
      packets: base.probe.packets.map((packet, index) => (
        index === 2 ? { ...packet, pts: "512" } : packet
      )),
    }],
    ["non-monotonic DTS", {
      packets: base.probe.packets.map((packet, index) => (
        index === 2 ? { ...packet, dts: "512" } : packet
      )),
    }],
    ["wrong packet duration", {
      packets: base.probe.packets.map((packet, index) => (
        index === 2 ? { ...packet, duration: "511" } : packet
      )),
    }],
  ];

  for (const [label, probe] of mutations) {
    assert.throws(
      () => validateAdbScreenrecordOutput(validValidationInput({ probe })),
      /packet|keyframe|timestamp|cadence|30 FPS/i,
      label,
    );
  }

  for (const streamMutation of [
    { nb_read_packets: undefined },
    { nb_read_packets: "1259" },
    { nb_read_packets: "1260.0" },
    { time_base: undefined },
    { time_base: "1/1000" },
  ]) {
    assert.throws(
      () => validateAdbScreenrecordOutput(validValidationInput({
        probe: {
          streams: [{ ...base.probe.streams[0], ...streamMutation }],
        },
      })),
      /packet|time base|cadence|30 FPS/i,
    );
  }

  for (const nb_read_frames of [undefined, "1259", "1260.0"]) {
    assert.throws(
      () => validateAdbScreenrecordOutput(validValidationInput({
        probe: {
          streams: [{ ...base.probe.streams[0], nb_read_frames }],
        },
      })),
      /frame count|exact integer/i,
    );
  }
});

test("raw ADB screenrecord validation rejects missing or inconsistent duration contracts", () => {
  for (const overrides of [
    { expectedDurationSeconds: undefined },
    { expectedDurationSeconds: 0 },
    { minimumDurationSeconds: undefined },
    { minimumDurationSeconds: 42.01 },
    { maxDurationSeconds: 41.99 },
  ]) {
    assert.throws(
      () => validateAdbScreenrecordOutput(validValidationInput(overrides)),
      /duration contract|duration/i,
    );
  }
});

test("ADB screenrecord plan requires a portrait canvas and explicit authored duration", () => {
  const valid = {
    serial: "emulator-5554",
    width: 1080,
    height: 2400,
    durationSeconds: 42,
    minimumDurationSeconds: 41.2 - ONE_FRAME_SECONDS,
    expectedDurationSeconds: 41.2,
    maxDurationSeconds: 41.2 + ONE_FRAME_SECONDS,
    stagingDir: STAGING_DIR,
    rawOutputPath: RAW_PATH,
    stagedOutputPath: STAGED_PATH,
    outputDir: OUTPUT_DIR,
    localOutputPath: OUTPUT_PATH,
  };

  assert.throws(
    () => createAdbScreenrecordPlan({ ...valid, expectedDurationSeconds: undefined }),
    /duration contract|expectedDurationSeconds|authored duration/i,
  );
  for (const dimensions of [
    { width: 1080, height: 1080 },
    { width: 2400, height: 1080 },
  ]) {
    assert.throws(
      () => createAdbScreenrecordPlan({ ...valid, ...dimensions }),
      /portrait/i,
    );
  }
  assert.throws(
    () => validateAdbScreenrecordOutput(validValidationInput({
      width: 2400,
      height: 1080,
      probe: { streams: [{
        ...validValidationInput().probe.streams[0],
        width: 2400,
        height: 1080,
      }] },
    })),
    /portrait/i,
  );
});

test("ADB screenrecord plan derives one-frame authored tolerance inside the command time limit", () => {
  const plan = createAdbScreenrecordPlan({
    serial: "emulator-5554",
    width: 1080,
    height: 2400,
    durationSeconds: 43,
    minimumDurationSeconds: MINIMUM_42_SECOND_RECORDING,
    expectedDurationSeconds: 42,
    maxDurationSeconds: MAXIMUM_42_SECOND_RECORDING,
    stagingDir: STAGING_DIR,
    rawOutputPath: RAW_PATH,
    stagedOutputPath: STAGED_PATH,
    outputDir: OUTPUT_DIR,
    localOutputPath: OUTPUT_PATH,
  });

  assert.deepEqual(
    {
      minimumDurationSeconds: plan.validation.minimumDurationSeconds,
      expectedDurationSeconds: plan.validation.expectedDurationSeconds,
      maxDurationSeconds: plan.validation.maxDurationSeconds,
    },
    {
      minimumDurationSeconds: MINIMUM_42_SECOND_RECORDING,
      expectedDurationSeconds: 42,
      maxDurationSeconds: MAXIMUM_42_SECOND_RECORDING,
    },
  );
});

test("raw ADB screenrecord validation rejects wrong frame and audio stream contracts", () => {
  for (const avg_frame_rate of ["30000/1001", "29/1", "0/0", "NaN", Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => validateAdbScreenrecordOutput(validValidationInput({
        probe: { streams: [{
          index: 0,
          codec_type: "video",
          width: 1080,
          height: 2400,
          avg_frame_rate,
          r_frame_rate: avg_frame_rate,
        }] },
      })),
      /30 FPS/,
    );
  }

  for (const incompleteRates of [
    { avg_frame_rate: undefined, r_frame_rate: "30/1" },
    { avg_frame_rate: "30/1", r_frame_rate: undefined },
  ]) {
    assert.throws(
      () => validateAdbScreenrecordOutput(validValidationInput({
        probe: { streams: [{
          ...validValidationInput().probe.streams[0],
          ...incompleteRates,
        }] },
      })),
      /30 FPS/,
    );
  }

  assert.throws(
    () => validateAdbScreenrecordOutput(validValidationInput({
      probe: { streams: [
        ...validValidationInput().probe.streams,
        { index: 1, codec_type: "audio" },
      ] },
    })),
    /no audio/,
  );
  assert.throws(
    () => validateAdbScreenrecordOutput(validValidationInput({
      probe: { streams: [
        ...validValidationInput().probe.streams,
        { ...validValidationInput().probe.streams[0], index: 1 },
      ] },
    })),
    /exactly one video/,
  );
});

test("raw ADB screenrecord validation rejects empty, linked, or mismatched files", () => {
  assert.throws(
    () => validateAdbScreenrecordOutput(validValidationInput({
      fileIdentity: { sizeBytes: 0 },
    })),
    /nonempty/,
  );
  assert.throws(
    () => validateAdbScreenrecordOutput(validValidationInput({
      fileIdentity: { isSymbolicLink: true },
    })),
    /symbolic link/,
  );
  assert.throws(
    () => validateAdbScreenrecordOutput(validValidationInput({
      fileIdentity: { isFile: false },
    })),
    /regular file/,
  );
  assert.throws(
    () => validateAdbScreenrecordOutput(validValidationInput({
      fileIdentity: { requestedPath: `${OUTPUT_DIR}/other.mp4` },
    })),
    /path identity/,
  );
  assert.throws(
    () => validateAdbScreenrecordOutput(validValidationInput({
      fileIdentity: { realPath: `${OUTPUT_DIR}/other.mp4` },
    })),
    /path identity/,
  );
  assert.throws(
    () => validateAdbScreenrecordOutput(validValidationInput({
      fileIdentity: { sha256: "not-a-digest" },
    })),
    /SHA-256/,
  );
});

test("ADB recording stage is a fresh mode-0700 directory under a canonical parent", async (context) => {
  const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "adb-stage-parent-")));
  context.after(() => fs.rm(parent, { recursive: true, force: true }));

  const stage = await createAdbScreenrecordStage({ stagingParent: parent });
  const details = await fs.lstat(stage.stagingDir);
  assert.equal(path.dirname(stage.stagingDir), parent);
  assert.equal(path.basename(stage.stagedOutputPath), "screenrecord.mp4");
  assert.equal(details.isDirectory(), true);
  assert.equal(details.isSymbolicLink(), false);
  assert.equal(details.mode & 0o777, 0o700);
  await assert.rejects(fs.lstat(stage.stagedOutputPath), { code: "ENOENT" });
});

test("ADB recording stage rejects a poisoned generated filename and noncanonical parent", async (context) => {
  const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "adb-stage-attack-")));
  const linkedParent = `${parent}-link`;
  context.after(async () => {
    await fs.rm(linkedParent, { force: true });
    await fs.rm(parent, { recursive: true, force: true });
  });
  await fs.symlink(parent, linkedParent);
  await assert.rejects(
    createAdbScreenrecordStage({ stagingParent: linkedParent }),
    /canonical parent/,
  );

  const poisonedDir = path.join(parent, ".adb-screenrecord-poisoned");
  const poisonedPath = path.join(poisonedDir, "screenrecord.mp4");
  await fs.mkdir(poisonedDir, { mode: 0o700 });
  await fs.writeFile(poisonedPath, "attacker-owned");
  const injectedFs = {
    ...fs,
    mkdtemp: async () => poisonedDir,
  };
  await assert.rejects(
    createAdbScreenrecordStage({ stagingParent: parent, fs: injectedFs }),
    /staged filename must be absent/,
  );
  assert.equal(await fs.readFile(poisonedPath, "utf8"), "attacker-owned");
});

test("ADB recording stage cleanup removes only its exact owned file and is idempotent", async (context) => {
  const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "adb-stage-cleanup-")));
  context.after(() => fs.rm(parent, { recursive: true, force: true }));
  const stage = await createAdbScreenrecordStage({ stagingParent: parent });
  await fs.writeFile(stage.stagedOutputPath, "private capture", { flag: "wx", mode: 0o600 });

  assert.deepEqual(await cleanupAdbScreenrecordStage({ stage }), { removed: true });
  await assert.rejects(fs.lstat(stage.stagingDir), { code: "ENOENT" });
  assert.deepEqual(await cleanupAdbScreenrecordStage({ stage }), { removed: false });
});

test("ADB recording stage cleanup rejects forged ownership and unexpected contents", async (context) => {
  const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "adb-stage-cleanup-refuse-")));
  context.after(() => fs.rm(parent, { recursive: true, force: true }));
  const stage = await createAdbScreenrecordStage({ stagingParent: parent });
  await fs.writeFile(path.join(stage.stagingDir, "unowned.txt"), "preserve", { flag: "wx" });

  await assert.rejects(
    cleanupAdbScreenrecordStage({ stage: { ...stage } }),
    /owned stage token/i,
  );
  await assert.rejects(
    cleanupAdbScreenrecordStage({ stage }),
    /unexpected contents/i,
  );
  assert.equal(await fs.readFile(path.join(stage.stagingDir, "unowned.txt"), "utf8"), "preserve");
});

test("staged ADB validation binds regular-file identity, ffprobe metadata, and SHA-256", async (context) => {
  const outputDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "adb-validate-stage-")));
  context.after(() => fs.rm(outputDir, { recursive: true, force: true }));
  const stage = await createAdbScreenrecordStage({ stagingParent: outputDir });
  const bytes = Buffer.from("diagnostic screenrecord bytes");
  await fs.writeFile(stage.stagedOutputPath, bytes, { flag: "wx", mode: 0o600 });
  const destinationPath = path.join(outputDir, "demo.mp4");
  const probedPaths = [];
  const hashedPaths = [];

  const validated = await validateStagedAdbScreenrecordOutput({
    expectedOutputPath: stage.stagedOutputPath,
    outputDir,
    destinationPath,
    probeFile: validProbeFile(probedPaths),
    hashFile: async (filePath) => {
      hashedPaths.push(filePath);
      return createHash("sha256").update(await fs.readFile(filePath)).digest("hex");
    },
    maxDurationSeconds: MAXIMUM_42_SECOND_RECORDING,
    expectedDurationSeconds: 42,
    minimumDurationSeconds: MINIMUM_42_SECOND_RECORDING,
    width: 1080,
    height: 2400,
  });
  assert.equal(validated.sha256, createHash("sha256").update(bytes).digest("hex"));
  assert.equal(validated.outputPath, stage.stagedOutputPath);
  assert.equal(validated.sizeBytes, bytes.length);
  assert.equal(probedPaths.length, 1);
  assert.equal(probedPaths[0], hashedPaths[0]);
  assert.notEqual(probedPaths[0], stage.stagedOutputPath);
  assert.equal(path.dirname(probedPaths[0]), stage.stagingDir);
});

test("staged validation hashes large media through bounded descriptor reads", async (context) => {
  const outputDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "adb-validate-chunked-")));
  context.after(() => fs.rm(outputDir, { recursive: true, force: true }));
  const readSizes = [];
  const chunkedFs = {
    ...fs,
    async readFile() {
      throw new Error("whole-file reads are forbidden for staged media hashing");
    },
    async open(filePath, ...args) {
      const handle = await fs.open(filePath, ...args);
      if (!filePath.endsWith(".validated-screenrecord.mp4")) return handle;
      return {
        async read(buffer, offset, length, position) {
          readSizes.push(length);
          return handle.read(buffer, offset, length, position);
        },
        close: () => handle.close(),
      };
    },
  };
  const stage = await createAdbScreenrecordStage({ stagingParent: outputDir, fs: chunkedFs });
  const bytes = Buffer.alloc((2 * 1024 * 1024) + 17, 0x5a);
  await fs.writeFile(stage.stagedOutputPath, bytes, { flag: "wx", mode: 0o600 });
  const destinationPath = path.join(outputDir, "demo.mp4");

  const validated = await validateStagedAdbScreenrecordOutput({
    expectedOutputPath: stage.stagedOutputPath,
    outputDir,
    destinationPath,
    probeFile: validProbeFile(),
    maxDurationSeconds: MAXIMUM_42_SECOND_RECORDING,
    expectedDurationSeconds: 42,
    minimumDurationSeconds: MINIMUM_42_SECOND_RECORDING,
    width: 1080,
    height: 2400,
    fs: chunkedFs,
  });
  assert.equal(validated.sha256, createHash("sha256").update(bytes).digest("hex"));
  assert.ok(readSizes.length > 2);
  assert.ok(readSizes.every((size) => size <= 64 * 1024));
});

test("exclusive publish rejects a pre-existing destination symlink and retains staged diagnostics", async (context) => {
  const outputDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "adb-publish-symlink-")));
  context.after(() => fs.rm(outputDir, { recursive: true, force: true }));
  const stage = await createAdbScreenrecordStage({ stagingParent: outputDir });
  const bytes = Buffer.from("validated staged diagnostics");
  await fs.writeFile(stage.stagedOutputPath, bytes, { flag: "wx", mode: 0o600 });
  const protectedPath = path.join(outputDir, "protected.mp4");
  const destinationPath = path.join(outputDir, "demo.mp4");
  const validatedOutput = await validateStagedAdbScreenrecordOutput({
    expectedOutputPath: stage.stagedOutputPath,
    outputDir,
    destinationPath,
    probeFile: validProbeFile(),
    maxDurationSeconds: MAXIMUM_42_SECOND_RECORDING,
    expectedDurationSeconds: 42,
    minimumDurationSeconds: MINIMUM_42_SECOND_RECORDING,
    width: 1080,
    height: 2400,
  });
  await fs.writeFile(protectedPath, "do-not-touch");
  await fs.symlink(protectedPath, destinationPath);

  await assert.rejects(
    publishAdbScreenrecordOutput({
      validatedOutput,
      stagedOutputPath: stage.stagedOutputPath,
      outputDir,
      destinationPath,
    }),
    /destination symbolic link/,
  );
  assert.equal(await fs.readlink(destinationPath), protectedPath);
  assert.equal(await fs.readFile(protectedPath, "utf8"), "do-not-touch");
  assert.deepEqual(await fs.readFile(stage.stagedOutputPath), bytes);
});

test("exclusive publish loses an EEXIST path-swap race without touching the winner", async (context) => {
  const outputDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "adb-publish-race-")));
  context.after(() => fs.rm(outputDir, { recursive: true, force: true }));
  const stage = await createAdbScreenrecordStage({ stagingParent: outputDir });
  const bytes = Buffer.from("retain these staged diagnostics");
  await fs.writeFile(stage.stagedOutputPath, bytes, { flag: "wx", mode: 0o600 });
  const destinationPath = path.join(outputDir, "demo.mp4");
  const validatedOutput = await validateStagedAdbScreenrecordOutput({
    expectedOutputPath: stage.stagedOutputPath,
    outputDir,
    destinationPath,
    probeFile: validProbeFile(),
    maxDurationSeconds: MAXIMUM_42_SECOND_RECORDING,
    expectedDurationSeconds: 42,
    minimumDurationSeconds: MINIMUM_42_SECOND_RECORDING,
    width: 1080,
    height: 2400,
  });
  const raceFs = {
    ...fs,
    link: async (source, destination) => {
      await fs.writeFile(destination, "race-winner", { flag: "wx" });
      return fs.link(source, destination);
    },
  };

  await assert.rejects(
    publishAdbScreenrecordOutput({
      validatedOutput,
      stagedOutputPath: stage.stagedOutputPath,
      outputDir,
      destinationPath,
      fs: raceFs,
    }),
    /exclusive publish.*already exists/,
  );
  assert.equal(await fs.readFile(destinationPath, "utf8"), "race-winner");
  assert.deepEqual(await fs.readFile(stage.stagedOutputPath), bytes);
});

test("exclusive publish rejects a symlinked nested destination parent", async (context) => {
  const outputDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "adb-publish-parent-link-")));
  context.after(() => fs.rm(outputDir, { recursive: true, force: true }));
  const stage = await createAdbScreenrecordStage({ stagingParent: outputDir });
  const bytes = Buffer.from("retain diagnostics when parent is linked");
  await fs.writeFile(stage.stagedOutputPath, bytes, { flag: "wx", mode: 0o600 });
  const protectedDir = path.join(outputDir, "protected");
  const linkedDir = path.join(outputDir, "raw");
  await fs.mkdir(protectedDir);
  await fs.symlink(protectedDir, linkedDir);
  const destinationPath = path.join(linkedDir, "demo.mp4");
  await assert.rejects(
    validateStagedAdbScreenrecordOutput({
      expectedOutputPath: stage.stagedOutputPath,
      outputDir,
      destinationPath,
      probeFile: validProbeFile(),
      maxDurationSeconds: MAXIMUM_42_SECOND_RECORDING,
      expectedDurationSeconds: 42,
      minimumDurationSeconds: MINIMUM_42_SECOND_RECORDING,
      width: 1080,
      height: 2400,
    }),
    /destination parent.*canonical/,
  );
  await assert.rejects(fs.lstat(path.join(protectedDir, "demo.mp4")), { code: "ENOENT" });
  assert.deepEqual(await fs.readFile(stage.stagedOutputPath), bytes);
});

test("exclusive publish rejects a staged path that differs from the validation token", async (context) => {
  const outputDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "adb-publish-binding-")));
  context.after(() => fs.rm(outputDir, { recursive: true, force: true }));
  const stage = await createAdbScreenrecordStage({ stagingParent: outputDir });
  await fs.writeFile(stage.stagedOutputPath, "validated bytes", { flag: "wx", mode: 0o600 });
  const destinationPath = path.join(outputDir, "demo.mp4");
  const validatedOutput = await validateStagedAdbScreenrecordOutput({
    expectedOutputPath: stage.stagedOutputPath,
    outputDir,
    destinationPath,
    probeFile: validProbeFile(),
    maxDurationSeconds: MAXIMUM_42_SECOND_RECORDING,
    expectedDurationSeconds: 42,
    minimumDurationSeconds: MINIMUM_42_SECOND_RECORDING,
    width: 1080,
    height: 2400,
  });

  await assert.rejects(
    publishAdbScreenrecordOutput({
      validatedOutput,
      stagedOutputPath: path.join(outputDir, "different.mp4"),
      outputDir,
      destinationPath,
    }),
    /staged path.*validation token/,
  );
  await assert.rejects(fs.lstat(path.join(outputDir, "demo.mp4")), { code: "ENOENT" });
});

test("exclusive publish atomically places the immutable validation snapshot without overwrite", async (context) => {
  const outputDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "adb-publish-success-")));
  context.after(() => fs.rm(outputDir, { recursive: true, force: true }));
  const stage = await createAdbScreenrecordStage({ stagingParent: outputDir });
  const bytes = Buffer.from("publish this validated recording");
  await fs.writeFile(stage.stagedOutputPath, bytes, { flag: "wx", mode: 0o600 });
  const destinationDir = path.join(outputDir, "raw");
  await fs.mkdir(destinationDir);
  const destinationPath = path.join(destinationDir, "demo.mp4");
  const validatedOutput = await validateStagedAdbScreenrecordOutput({
    expectedOutputPath: stage.stagedOutputPath,
    outputDir,
    destinationPath,
    probeFile: validProbeFile(),
    maxDurationSeconds: MAXIMUM_42_SECOND_RECORDING,
    expectedDurationSeconds: 42,
    minimumDurationSeconds: MINIMUM_42_SECOND_RECORDING,
    width: 1080,
    height: 2400,
  });

  const published = await publishAdbScreenrecordOutput({
    validatedOutput,
    stagedOutputPath: stage.stagedOutputPath,
    outputDir,
    destinationPath,
  });
  assert.deepEqual(published, {
    outputPath: destinationPath,
    stagedOutputPath: stage.stagedOutputPath,
    sizeBytes: bytes.length,
    sha256: validatedOutput.sha256,
  });
  assert.deepEqual(await fs.readFile(destinationPath), bytes);
  const [stagedDetails, publishedDetails] = await Promise.all([
    fs.lstat(stage.stagedOutputPath),
    fs.lstat(destinationPath),
  ]);
  assert.equal(publishedDetails.isFile(), true);
  assert.equal(publishedDetails.isSymbolicLink(), false);
  assert.notEqual(
    publishedDetails.ino,
    stagedDetails.ino,
    "publish must use the immutable validated snapshot rather than mutable pulled bytes",
  );
});

test("exclusive publish keeps the validation token bound to final while linking to a private witness", async (context) => {
  const outputDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "adb-publish-witness-")));
  context.after(() => fs.rm(outputDir, { recursive: true, force: true }));
  const stage = await createAdbScreenrecordStage({ stagingParent: outputDir });
  const bytes = Buffer.from("publish to transaction witness");
  await fs.writeFile(stage.stagedOutputPath, bytes, { flag: "wx", mode: 0o600 });
  const destinationDir = path.join(outputDir, "raw");
  const witnessDir = path.join(outputDir, ".android-capture-publication", "witness", "raw");
  await fs.mkdir(destinationDir);
  await fs.mkdir(witnessDir, { recursive: true, mode: 0o700 });
  const destinationPath = path.join(destinationDir, "android.mp4");
  const publicationPath = path.join(witnessDir, "android.mp4");
  const validatedOutput = await validateStagedAdbScreenrecordOutput({
    expectedOutputPath: stage.stagedOutputPath,
    outputDir,
    destinationPath,
    probeFile: validProbeFile(),
    maxDurationSeconds: MAXIMUM_42_SECOND_RECORDING,
    expectedDurationSeconds: 42,
    minimumDurationSeconds: MINIMUM_42_SECOND_RECORDING,
    width: 1080,
    height: 2400,
  });

  const published = await publishAdbScreenrecordOutput({
    validatedOutput,
    stagedOutputPath: stage.stagedOutputPath,
    outputDir,
    destinationPath,
    publicationPath,
  });
  assert.equal(published.outputPath, publicationPath);
  assert.deepEqual(await fs.readFile(publicationPath), bytes);
  await assert.rejects(fs.lstat(destinationPath), { code: "ENOENT" });
});

test("direct publication self-rolls back a first-inspection failure or poisons an unproved token", async (context) => {
  async function preparedPublication(label) {
    const outputDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), `adb-publish-${label}-`)));
    context.after(() => fs.rm(outputDir, { recursive: true, force: true }));
    const stage = await createAdbScreenrecordStage({ stagingParent: outputDir });
    await fs.writeFile(stage.stagedOutputPath, "validated bytes", { flag: "wx", mode: 0o600 });
    const destinationPath = path.join(outputDir, "demo.mp4");
    const validatedOutput = await validateStagedAdbScreenrecordOutput({
      expectedOutputPath: stage.stagedOutputPath,
      outputDir,
      destinationPath,
      probeFile: validProbeFile(),
      minimumDurationSeconds: MINIMUM_42_SECOND_RECORDING,
      expectedDurationSeconds: 42,
      maxDurationSeconds: MAXIMUM_42_SECOND_RECORDING,
      width: 1080,
      height: 2400,
    });
    return { outputDir, stage, destinationPath, validatedOutput };
  }

  const retryable = await preparedPublication("retryable-lstat");
  let retryableDestinationStats = 0;
  const retryableFs = {
    ...fs,
    lstat: async (filePath) => {
      if (filePath === retryable.destinationPath && ++retryableDestinationStats === 2) {
        throw new Error("injected first destination inspection failure");
      }
      return fs.lstat(filePath);
    },
  };
  await assert.rejects(
    publishAdbScreenrecordOutput({
      validatedOutput: retryable.validatedOutput,
      stagedOutputPath: retryable.stage.stagedOutputPath,
      outputDir: retryable.outputDir,
      destinationPath: retryable.destinationPath,
      fs: retryableFs,
    }),
    /first destination inspection failure/,
  );
  await assert.rejects(fs.lstat(retryable.destinationPath), { code: "ENOENT" });
  await publishAdbScreenrecordOutput({
    validatedOutput: retryable.validatedOutput,
    stagedOutputPath: retryable.stage.stagedOutputPath,
    outputDir: retryable.outputDir,
    destinationPath: retryable.destinationPath,
  });

  const poisoned = await preparedPublication("poisoned-lstat");
  let poisonedDestinationStats = 0;
  const poisonedFs = {
    ...fs,
    lstat: async (filePath) => {
      if (filePath === poisoned.destinationPath && ++poisonedDestinationStats >= 2) {
        throw new Error("injected unproved destination identity");
      }
      return fs.lstat(filePath);
    },
  };
  await assert.rejects(
    publishAdbScreenrecordOutput({
      validatedOutput: poisoned.validatedOutput,
      stagedOutputPath: poisoned.stage.stagedOutputPath,
      outputDir: poisoned.outputDir,
      destinationPath: poisoned.destinationPath,
      fs: poisonedFs,
    }),
    /rollback failed/i,
  );
  await assert.rejects(
    publishAdbScreenrecordOutput({
      validatedOutput: poisoned.validatedOutput,
      stagedOutputPath: poisoned.stage.stagedOutputPath,
      outputDir: poisoned.outputDir,
      destinationPath: poisoned.destinationPath,
    }),
    /poisoned/i,
  );
});

test("exclusive publish rejects a forged validation token", async (context) => {
  const outputDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "adb-publish-forged-token-")));
  context.after(() => fs.rm(outputDir, { recursive: true, force: true }));
  const stage = await createAdbScreenrecordStage({ stagingParent: outputDir });
  await fs.writeFile(stage.stagedOutputPath, "validated bytes", { flag: "wx", mode: 0o600 });
  const destinationPath = path.join(outputDir, "demo.mp4");
  const validatedOutput = await validateStagedAdbScreenrecordOutput({
    expectedOutputPath: stage.stagedOutputPath,
    outputDir,
    destinationPath,
    probeFile: validProbeFile(),
    minimumDurationSeconds: MINIMUM_42_SECOND_RECORDING,
    expectedDurationSeconds: 42,
    maxDurationSeconds: MAXIMUM_42_SECOND_RECORDING,
    width: 1080,
    height: 2400,
  });

  await assert.rejects(
    publishAdbScreenrecordOutput({
      validatedOutput: { ...validatedOutput },
      stagedOutputPath: stage.stagedOutputPath,
      outputDir,
      destinationPath,
    }),
    /exact validation token/i,
  );
  await assert.rejects(fs.lstat(destinationPath), { code: "ENOENT" });
});

test("exclusive publish removes only its mismatched destination after a source path race", async (context) => {
  const outputDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "adb-publish-source-race-")));
  context.after(() => fs.rm(outputDir, { recursive: true, force: true }));
  const stage = await createAdbScreenrecordStage({ stagingParent: outputDir });
  await fs.writeFile(stage.stagedOutputPath, "validated bytes", { flag: "wx", mode: 0o600 });
  const destinationPath = path.join(outputDir, "demo.mp4");
  const validatedOutput = await validateStagedAdbScreenrecordOutput({
    expectedOutputPath: stage.stagedOutputPath,
    outputDir,
    destinationPath,
    probeFile: validProbeFile(),
    minimumDurationSeconds: MINIMUM_42_SECOND_RECORDING,
    expectedDurationSeconds: 42,
    maxDurationSeconds: MAXIMUM_42_SECOND_RECORDING,
    width: 1080,
    height: 2400,
  });
  const raceFs = {
    ...fs,
    link: async (source, destination) => {
      await fs.unlink(source);
      await fs.writeFile(source, "path-race bytes", { flag: "wx", mode: 0o400 });
      return fs.link(source, destination);
    },
  };

  await assert.rejects(
    publishAdbScreenrecordOutput({
      validatedOutput,
      stagedOutputPath: stage.stagedOutputPath,
      outputDir,
      destinationPath,
      fs: raceFs,
    }),
    /validated|identity|source|rollback/i,
  );
  await assert.rejects(fs.lstat(destinationPath), { code: "ENOENT" });
  await assert.rejects(
    publishAdbScreenrecordOutput({
      validatedOutput,
      stagedOutputPath: stage.stagedOutputPath,
      outputDir,
      destinationPath,
    }),
    /poisoned/i,
  );
});

test("exclusive publish poisons a validation token when hashing mutates the published inode", async (context) => {
  const outputDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "adb-publish-hash-race-")));
  context.after(() => fs.rm(outputDir, { recursive: true, force: true }));
  const stage = await createAdbScreenrecordStage({ stagingParent: outputDir });
  await fs.writeFile(stage.stagedOutputPath, "validated bytes", { flag: "wx", mode: 0o600 });
  const destinationPath = path.join(outputDir, "demo.mp4");
  const validatedOutput = await validateStagedAdbScreenrecordOutput({
    expectedOutputPath: stage.stagedOutputPath,
    outputDir,
    destinationPath,
    probeFile: validProbeFile(),
    minimumDurationSeconds: MINIMUM_42_SECOND_RECORDING,
    expectedDurationSeconds: 42,
    maxDurationSeconds: MAXIMUM_42_SECOND_RECORDING,
    width: 1080,
    height: 2400,
  });
  const hashFile = async (filePath) => {
    if (filePath === destinationPath) {
      await fs.chmod(filePath, 0o600);
      await fs.writeFile(filePath, "corrupted bytes");
      await fs.chmod(filePath, 0o400);
      return validatedOutput.sha256;
    }
    return createHash("sha256").update(await fs.readFile(filePath)).digest("hex");
  };

  await assert.rejects(
    publishAdbScreenrecordOutput({
      validatedOutput,
      stagedOutputPath: stage.stagedOutputPath,
      outputDir,
      destinationPath,
      hashFile,
    }),
    /rollback failed/i,
  );
  await assert.rejects(fs.lstat(destinationPath), { code: "ENOENT" });
  await assert.rejects(
    publishAdbScreenrecordOutput({
      validatedOutput,
      stagedOutputPath: stage.stagedOutputPath,
      outputDir,
      destinationPath,
    }),
    /poisoned/i,
  );
});

test("validation tokens are destination-bound, single-use, and retryable after a failed publish", async (context) => {
  const outputDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "adb-publish-token-")));
  context.after(() => fs.rm(outputDir, { recursive: true, force: true }));
  const stage = await createAdbScreenrecordStage({ stagingParent: outputDir });
  await fs.writeFile(stage.stagedOutputPath, "validated bytes", { flag: "wx", mode: 0o600 });
  const destinationPath = path.join(outputDir, "demo.mp4");
  const validatedOutput = await validateStagedAdbScreenrecordOutput({
    expectedOutputPath: stage.stagedOutputPath,
    outputDir,
    destinationPath,
    probeFile: validProbeFile(),
    minimumDurationSeconds: MINIMUM_42_SECOND_RECORDING,
    expectedDurationSeconds: 42,
    maxDurationSeconds: MAXIMUM_42_SECOND_RECORDING,
    width: 1080,
    height: 2400,
  });

  await assert.rejects(
    publishAdbScreenrecordOutput({
      validatedOutput,
      stagedOutputPath: stage.stagedOutputPath,
      outputDir,
      destinationPath: path.join(outputDir, "other.mp4"),
    }),
    /destination.*validation token/i,
  );
  await fs.writeFile(destinationPath, "collision", { flag: "wx" });
  await assert.rejects(
    publishAdbScreenrecordOutput({
      validatedOutput,
      stagedOutputPath: stage.stagedOutputPath,
      outputDir,
      destinationPath,
    }),
    /destination.*exists/i,
  );
  await fs.unlink(destinationPath);
  await publishAdbScreenrecordOutput({
    validatedOutput,
    stagedOutputPath: stage.stagedOutputPath,
    outputDir,
    destinationPath,
  });
  await assert.rejects(
    publishAdbScreenrecordOutput({
      validatedOutput,
      stagedOutputPath: stage.stagedOutputPath,
      outputDir,
      destinationPath,
    }),
    /consumed/i,
  );
});

test("validation and publication reject a replaced owned stage directory inode", async (context) => {
  const outputDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "adb-stage-inode-")));
  context.after(() => fs.rm(outputDir, { recursive: true, force: true }));
  const stage = await createAdbScreenrecordStage({ stagingParent: outputDir });
  const destinationPath = path.join(outputDir, "demo.mp4");
  await fs.writeFile(stage.stagedOutputPath, "validated bytes", { flag: "wx", mode: 0o600 });
  const displaced = `${stage.stagingDir}.displaced`;
  const validatedOutput = await validateStagedAdbScreenrecordOutput({
    expectedOutputPath: stage.stagedOutputPath,
    outputDir,
    destinationPath,
    probeFile: validProbeFile(),
    minimumDurationSeconds: MINIMUM_42_SECOND_RECORDING,
    expectedDurationSeconds: 42,
    maxDurationSeconds: MAXIMUM_42_SECOND_RECORDING,
    width: 1080,
    height: 2400,
  });

  await fs.rename(stage.stagingDir, displaced);
  await fs.mkdir(stage.stagingDir, { mode: 0o700 });
  await fs.copyFile(path.join(displaced, ".validated-screenrecord.mp4"), path.join(stage.stagingDir, ".validated-screenrecord.mp4"));
  await fs.chmod(path.join(stage.stagingDir, ".validated-screenrecord.mp4"), 0o400);
  await assert.rejects(
    publishAdbScreenrecordOutput({
      validatedOutput,
      stagedOutputPath: stage.stagedOutputPath,
      outputDir,
      destinationPath,
    }),
    /stage identity changed/i,
  );
  await assert.rejects(fs.lstat(destinationPath), { code: "ENOENT" });
});

test("raw ADB screenrecord validation rejects nonfinite or out-of-contract media metadata", () => {
  for (const duration of ["NaN", "Infinity", "0", "42.04"] ) {
    assert.throws(
      () => validateAdbScreenrecordOutput(validValidationInput({
        probe: { format: { duration } },
      })),
      /duration/,
    );
  }
  assert.throws(
    () => validateAdbScreenrecordOutput(validValidationInput({
      probe: { streams: [{
        ...validValidationInput().probe.streams[0],
        width: Number.POSITIVE_INFINITY,
      }] },
    })),
    /dimensions/,
  );
  assert.throws(
    () => validateAdbScreenrecordOutput(validValidationInput({
      probe: { streams: [{
        ...validValidationInput().probe.streams[0],
        height: 2399,
      }] },
    })),
    /dimensions/,
  );
});
