import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import {
  cleanupAdbScreenrecordStage,
  createAdbScreenrecordPlan,
  createAdbScreenrecordStage,
} from "../../../scripts/capture/android/recording.mjs";
import { createAndroidProcessOperations } from "../../../scripts/capture/android/process-operations.mjs";

const SERIAL = "emulator-5554";
const ADB = "/sdk/adb";
const FFMPEG = "/usr/bin/ffmpeg";
const STAGING_DIR = "/private/output/.adb-screenrecord-media-clock";
const RAW_OUTPUT_PATH = `${STAGING_DIR}/screenrecord.h264`;
const STAGED_OUTPUT_PATH = `${STAGING_DIR}/screenrecord.mp4`;
const EXPECTED_DURATION_SECONDS = 42;
const MINIMUM_DURATION_SECONDS = EXPECTED_DURATION_SECONDS - (1 / 30);
const MAXIMUM_DURATION_SECONDS = EXPECTED_DURATION_SECONDS + (1 / 30);

const RECORD_ARGS = Object.freeze([
  "-s",
  SERIAL,
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
]);

const REMUX_ARGS = Object.freeze([
  "-nostdin",
  "-hide_banner",
  "-loglevel",
  "error",
  "-f",
  "h264",
  "-framerate",
  "30",
  "-i",
  RAW_OUTPUT_PATH,
  "-map",
  "0:v:0",
  "-an",
  "-c:v",
  "copy",
  "-frames:v",
  String(EXPECTED_DURATION_SECONDS * 30),
  "-movflags",
  "+faststart",
  STAGED_OUTPUT_PATH,
]);

function recordingPlanInput(overrides = {}) {
  return {
    adbPath: ADB,
    ffmpegPath: FFMPEG,
    serial: SERIAL,
    width: 1080,
    height: 2400,
    bitRate: 12_000_000,
    durationSeconds: 43,
    minimumDurationSeconds: MINIMUM_DURATION_SECONDS,
    expectedDurationSeconds: EXPECTED_DURATION_SECONDS,
    maxDurationSeconds: MAXIMUM_DURATION_SECONDS,
    stagingDir: STAGING_DIR,
    rawOutputPath: RAW_OUTPUT_PATH,
    stagedOutputPath: STAGED_OUTPUT_PATH,
    outputDir: "/private/output",
    localOutputPath: "/private/output/session-01.mp4",
    ...overrides,
  };
}

function recordStep(overrides = {}) {
  return {
    executable: ADB,
    args: [...RECORD_ARGS],
    rawOutputPath: RAW_OUTPUT_PATH,
    ...overrides,
  };
}

function remuxStep(overrides = {}) {
  return {
    executable: FFMPEG,
    args: [...REMUX_ARGS],
    expectedDurationSeconds: EXPECTED_DURATION_SECONDS,
    rawOutputPath: RAW_OUTPUT_PATH,
    stagedOutputPath: STAGED_OUTPUT_PATH,
    targetFrames: EXPECTED_DURATION_SECONDS * 30,
    ...overrides,
  };
}

function fakeStat({ type, mode, dev = 7, ino = 11, size = 0 }) {
  return {
    dev,
    ino,
    mode,
    size,
    ctimeMs: 1,
    mtimeMs: 1,
    isDirectory: () => type === "directory",
    isFile: () => type === "file",
    isSymbolicLink: () => type === "symlink",
  };
}

function missing(pathname) {
  const error = new Error(`missing ${pathname}`);
  error.code = "ENOENT";
  return error;
}

function fakeFileSystem({ rawExists = false } = {}) {
  const entries = new Map([
    [ADB, fakeStat({ type: "file", mode: 0o755, ino: 20 })],
    [FFMPEG, fakeStat({ type: "file", mode: 0o755, ino: 21 })],
    ["/private/output", fakeStat({ type: "directory", mode: 0o700, ino: 30 })],
    [STAGING_DIR, fakeStat({ type: "directory", mode: 0o700, ino: 31 })],
  ]);
  const rawFile = {
    bytes: Buffer.alloc(0),
    closed: false,
    synced: false,
    mode: undefined,
  };
  if (rawExists) {
    rawFile.bytes = Buffer.from("raw annex-b bytes");
    rawFile.closed = true;
    rawFile.synced = true;
    rawFile.mode = 0o600;
    entries.set(RAW_OUTPUT_PATH, fakeStat({
      type: "file",
      mode: 0o600,
      ino: 40,
      size: rawFile.bytes.length,
    }));
  }
  const openCalls = [];

  const updateRawStat = () => {
    entries.set(RAW_OUTPUT_PATH, fakeStat({
      type: "file",
      mode: rawFile.mode ?? 0o600,
      ino: 40,
      size: rawFile.bytes.length,
    }));
  };

  return {
    entries,
    openCalls,
    rawFile,
    async lstat(pathname) {
      const entry = entries.get(pathname);
      if (!entry) throw missing(pathname);
      return entry;
    },
    async realpath(pathname) {
      if (!entries.has(pathname)) throw missing(pathname);
      return pathname;
    },
    async open(pathname, flags, mode) {
      openCalls.push([pathname, flags, mode]);
      if (pathname !== RAW_OUTPUT_PATH || rawExists || entries.has(pathname)) {
        const error = new Error(`refusing open ${pathname}`);
        error.code = entries.has(pathname) ? "EEXIST" : "ENOENT";
        throw error;
      }
      rawFile.mode = mode;
      updateRawStat();
      return {
        async write(value, offset = 0, length, _position) {
          const source = Buffer.isBuffer(value) ? value : Buffer.from(value);
          const count = length ?? source.length;
          const bytes = source.subarray(offset, offset + count);
          rawFile.bytes = Buffer.concat([rawFile.bytes, bytes]);
          updateRawStat();
          return { bytesWritten: bytes.length, buffer: value };
        },
        async sync() {
          rawFile.synced = true;
        },
        async datasync() {
          rawFile.synced = true;
        },
        async stat() {
          return entries.get(RAW_OUTPUT_PATH);
        },
        async close() {
          rawFile.closed = true;
        },
      };
    },
  };
}

class FakeRecorderChild extends EventEmitter {
  constructor(pid) {
    super();
    this.pid = pid;
    this.exitCode = null;
    this.signalCode = null;
    this.kills = [];
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
  }

  kill(signal) {
    this.kills.push(signal);
    this.finish(0, null);
    return true;
  }

  finish(exitCode, signalCode) {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.exitCode = exitCode;
    this.signalCode = signalCode;
    this.stdout.end();
    this.stderr.end();
    this.emit("exit", exitCode, signalCode);
    this.emit("close", exitCode, signalCode);
  }
}

function fakeClock(initialMilliseconds = 1_000) {
  let now = initialMilliseconds;
  return {
    nowMilliseconds: () => now,
    set(milliseconds) {
      now = milliseconds;
    },
    sleep: async (milliseconds) => {
      now += milliseconds;
      await new Promise((resolve) => queueMicrotask(resolve));
    },
  };
}

function annexBNal(header, ...payload) {
  return Buffer.from([0x00, 0x00, 0x00, 0x01, header, ...payload]);
}

const SPS = annexBNal(0x67, 0x42, 0x00, 0x1f);
const PPS = annexBNal(0x68, 0xce, 0x06, 0xe2);
const IDR = annexBNal(0x65, 0x88, 0x84, 0x21);
const NEXT_FRAME = annexBNal(0x41, 0x9a, 0x10, 0x22);

function recorderHarness({
  delayInitialInspection = false,
  emissions = [],
  exitBeforeMedia = false,
  pid = 6200,
  readinessMilliseconds = 10,
} = {}) {
  const clock = fakeClock();
  const child = new FakeRecorderChild(pid);
  const fakeFs = fakeFileSystem();
  const registry = { emulators: new Map(), recorders: new Map() };
  const spawnCalls = [];
  const operations = createAndroidProcessOperations({
    fs: fakeFs,
    processRegistry: registry,
    baseEnvironment: { PATH: "/usr/bin", ACP_SECRET: "must-not-reach-child" },
    nowMilliseconds: clock.nowMilliseconds,
    sleep: clock.sleep,
    recorderReadinessMilliseconds: readinessMilliseconds,
    recorderSignalGraceMilliseconds: 5,
    stopGraceMilliseconds: 5,
    spawnProcess: (...args) => {
      spawnCalls.push(args);
      queueMicrotask(() => {
        for (const emission of emissions) {
          clock.set(emission.at);
          child.stdout.write(emission.bytes);
        }
        if (exitBeforeMedia) child.finish(1, null);
      });
      return child;
    },
    inspectProcess: async (inspectedPid) => {
      if (delayInitialInspection) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      return {
        alive: child.exitCode === null && child.signalCode === null,
        pid: inspectedPid,
        processStartIdentity: "recorder-start",
      };
    },
  });
  return { child, clock, fakeFs, operations, registry, spawnCalls };
}

test("the owned recording stage reserves exact raw H.264 and staged MP4 paths", async () => {
  const canonicalTemporaryRoot = await fs.realpath(os.tmpdir());
  const parent = await fs.mkdtemp(path.join(canonicalTemporaryRoot, "demo-creator-media-clock-"));
  let stage;
  try {
    stage = await createAdbScreenrecordStage({ stagingParent: parent });
    assert.deepEqual(Object.keys(stage).sort(), [
      "rawOutputPath",
      "stagedOutputPath",
      "stagingDir",
    ]);
    assert.equal(stage.rawOutputPath, path.join(stage.stagingDir, "screenrecord.h264"));
    assert.equal(stage.stagedOutputPath, path.join(stage.stagingDir, "screenrecord.mp4"));
    assert.equal(Object.isFrozen(stage), true);
  } finally {
    if (stage) await cleanupAdbScreenrecordStage({ stage });
    await fs.rm(parent, { force: true, recursive: true });
  }
});

test("the plan streams raw Annex-B H.264 from one exact adb serial and remuxes locally", () => {
  const plan = createAdbScreenrecordPlan(recordingPlanInput());

  assert.deepEqual(plan.record, {
    executable: ADB,
    args: [...RECORD_ARGS],
    rawOutputPath: RAW_OUTPUT_PATH,
  });
  assert.deepEqual(Object.keys(plan.record).sort(), ["args", "executable", "rawOutputPath"]);
  assert.equal("remoteOutputPath" in plan, false);
  assert.equal("pull" in plan, false);
  assert.equal("remove" in plan, false);
  assert.deepEqual(plan.remux, {
    executable: FFMPEG,
    args: [...REMUX_ARGS],
    expectedDurationSeconds: EXPECTED_DURATION_SECONDS,
    rawOutputPath: RAW_OUTPUT_PATH,
    stagedOutputPath: STAGED_OUTPUT_PATH,
    targetFrames: EXPECTED_DURATION_SECONDS * 30,
  });
});

test("start waits for SPS, PPS, and the first complete IDR NAL and timestamps its first byte", async () => {
  const harness = recorderHarness({
    emissions: [
      { at: 1_010, bytes: SPS },
      { at: 1_020, bytes: PPS },
      { at: 1_042, bytes: IDR },
      { at: 1_050, bytes: NEXT_FRAME },
    ],
  });

  const handle = await harness.operations.startAndroidScreenrecord(recordStep());

  assert.deepEqual(handle, {
    pid: 6200,
    processStartIdentity: "recorder-start",
    mediaStartMonotonicMilliseconds: 1_042,
  });
  assert.deepEqual(Object.keys(handle).sort(), [
    "mediaStartMonotonicMilliseconds",
    "pid",
    "processStartIdentity",
  ]);
  assert.equal(Object.isFrozen(handle), true);
  assert.equal(harness.spawnCalls.length, 1);
  assert.equal(harness.spawnCalls[0][0], ADB);
  assert.deepEqual(harness.spawnCalls[0][1], [...RECORD_ARGS]);
  assert.equal(harness.spawnCalls[0][2].stdio[1], "pipe");
  assert.deepEqual(harness.spawnCalls[0][2].env, { PATH: "/usr/bin" });

  await assert.rejects(
    harness.operations.stopAndroidScreenrecord({ ...handle }),
    /exact tracked recorder handle/i,
  );
  const stopped = await harness.operations.stopAndroidScreenrecord(handle);
  assert.deepEqual(stopped, { stopped: true, pid: 6200 });
  assert.deepEqual(harness.child.kills, ["SIGINT"]);
  assert.deepEqual(harness.fakeFs.rawFile.bytes, Buffer.concat([SPS, PPS, IDR, NEXT_FRAME]));
  assert.equal(harness.fakeFs.rawFile.mode, 0o600);
  assert.equal(harness.fakeFs.rawFile.synced, true);
  assert.equal(harness.fakeFs.rawFile.closed, true);
  assert.equal(harness.registry.recorders.size, 0);
});

test("readiness survives split Annex-B start codes and retains the first IDR-byte timestamp", async () => {
  const harness = recorderHarness({
    emissions: [
      { at: 1_001, bytes: SPS.subarray(0, 2) },
      { at: 1_002, bytes: SPS.subarray(2) },
      { at: 1_010, bytes: PPS.subarray(0, 3) },
      { at: 1_011, bytes: PPS.subarray(3) },
      { at: 1_100, bytes: IDR.subarray(0, 2) },
      { at: 1_110, bytes: IDR.subarray(2) },
      { at: 1_120, bytes: NEXT_FRAME },
    ],
    pid: 6209,
  });

  const handle = await harness.operations.startAndroidScreenrecord(recordStep());
  assert.equal(handle.mediaStartMonotonicMilliseconds, 1_100);
  await harness.operations.stopAndroidScreenrecord(handle);
});

test("post-readiness streaming retains more than the bounded readiness prefix", async () => {
  const harness = recorderHarness({
    emissions: [{
      at: 1_001,
      bytes: Buffer.concat([SPS, PPS, IDR, NEXT_FRAME]),
    }],
    pid: 6221,
  });
  const handle = await harness.operations.startAndroidScreenrecord(recordStep());
  const postReadinessBytes = Buffer.alloc((1024 * 1024) + 1, 0x11);

  harness.child.stdout.write(postReadinessBytes);
  const stopped = await harness.operations.stopAndroidScreenrecord(handle);

  assert.deepEqual(stopped, { stopped: true, pid: 6221 });
  assert.deepEqual(
    harness.fakeFs.rawFile.bytes,
    Buffer.concat([SPS, PPS, IDR, NEXT_FRAME, postReadinessBytes]),
  );
  assert.equal(harness.fakeFs.rawFile.synced, true);
  assert.equal(harness.fakeFs.rawFile.closed, true);
});

test("media rejection is observed while initial process inspection is pending", async () => {
  const invalidNalHeader = Buffer.from([0x00, 0x00, 0x00, 0x01, 0xe7, 0x01]);
  const harness = recorderHarness({
    delayInitialInspection: true,
    emissions: [{ at: 1_001, bytes: invalidNalHeader }],
    pid: 6222,
  });

  await assert.rejects(
    harness.operations.startAndroidScreenrecord(recordStep()),
    /invalid Annex-B H\.264 NAL header/i,
  );
});

test("a live adb child without a complete Annex-B media prefix times out", { timeout: 1_000 }, async () => {
  const harness = recorderHarness({ readinessMilliseconds: 5, pid: 6201 });

  await assert.rejects(
    harness.operations.startAndroidScreenrecord(recordStep()),
    /timed out.*SPS.*PPS.*IDR|media readiness.*timed out/i,
  );
});

test("start rejects non-H.264 or incomplete Annex-B prefixes", { timeout: 2_000 }, async () => {
  const cases = [
    ["garbage", Buffer.from("not an annex-b stream")],
    ["SPS without PPS", Buffer.concat([SPS, IDR, NEXT_FRAME])],
    ["PPS without SPS", Buffer.concat([PPS, IDR, NEXT_FRAME])],
    ["parameter sets without VCL", Buffer.concat([SPS, PPS])],
    ["non-IDR VCL before IDR", Buffer.concat([SPS, PPS, NEXT_FRAME, IDR, NEXT_FRAME])],
    ["IDR before SPS and PPS", Buffer.concat([IDR, SPS, PPS, IDR, NEXT_FRAME])],
  ];

  let pid = 6210;
  for (const [label, bytes] of cases) {
    const harness = recorderHarness({
      emissions: [{ at: 1_001, bytes }],
      pid,
      readinessMilliseconds: 5,
    });
    await assert.rejects(
      harness.operations.startAndroidScreenrecord(recordStep()),
      /H\.264|Annex-B|SPS|PPS|IDR|media readiness/i,
      label,
    );
    pid += 1;
  }
});

test("start rejects an adb child that exits before the first complete IDR NAL", { timeout: 1_000 }, async () => {
  const harness = recorderHarness({
    emissions: [
      { at: 1_001, bytes: SPS },
      { at: 1_002, bytes: PPS },
    ],
    exitBeforeMedia: true,
    pid: 6220,
  });

  await assert.rejects(
    harness.operations.startAndroidScreenrecord(recordStep()),
    /exit|closed.*before.*media|before.*IDR/i,
  );
});

test("externally forced recorder termination is never publishable", async (context) => {
  for (const signal of ["SIGINT", "SIGTERM", "SIGKILL"]) {
    await context.test(signal, async () => {
      const harness = recorderHarness({
        emissions: [{
          at: 1_001,
          bytes: Buffer.concat([SPS, PPS, IDR, NEXT_FRAME]),
        }],
        pid: signal === "SIGINT" ? 6223 : signal === "SIGTERM" ? 6224 : 6225,
      });
      const handle = await harness.operations.startAndroidScreenrecord(recordStep());
      harness.child.finish(null, signal);

      await assert.rejects(
        harness.operations.stopAndroidScreenrecord(handle),
        (error) => {
          const descriptor = Object.getOwnPropertyDescriptor(
            error,
            "recorderQuiescenceProven",
          );
          return /forced termination.*unpublishable/i.test(error.message)
            && descriptor?.value === true
            && descriptor.enumerable === false
            && descriptor.configurable === false
            && descriptor.writable === false;
        },
      );
      assert.equal(harness.registry.recorders.has(handle.pid), false);
    });
  }
});

test("a nonzero recorder exit after readiness is never publishable", async () => {
  const harness = recorderHarness({
    emissions: [{
      at: 1_001,
      bytes: Buffer.concat([SPS, PPS, IDR, NEXT_FRAME]),
    }],
    pid: 6226,
  });
  const handle = await harness.operations.startAndroidScreenrecord(recordStep());
  harness.child.finish(17, null);

  await assert.rejects(
    harness.operations.stopAndroidScreenrecord(handle),
    (error) => {
      const descriptor = Object.getOwnPropertyDescriptor(
        error,
        "recorderQuiescenceProven",
      );
      return /nonzero|status|unpublishable/i.test(error.message)
        && descriptor?.value === true;
    },
  );
  assert.equal(harness.registry.recorders.has(handle.pid), false);
});

test("remux invokes the exact canonical raw-H.264-to-MP4 ffmpeg command", async () => {
  const calls = [];
  const fakeFs = fakeFileSystem({ rawExists: true });
  const operations = createAndroidProcessOperations({
    fs: fakeFs,
    baseEnvironment: { PATH: "/usr/bin", ACP_SECRET: "must-not-reach-ffmpeg" },
    runCommand: async (...args) => {
      calls.push(args);
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  });

  const result = await operations.remuxAndroidScreenrecord(remuxStep());

  assert.deepEqual(result, { exitCode: 0, stdout: "", stderr: "" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], FFMPEG);
  assert.deepEqual(calls[0][1], [...REMUX_ARGS]);
  assert.equal(calls[0][2].shell, false);
  assert.deepEqual(calls[0][2].env, { PATH: "/usr/bin" });
});

test("remux rejects any ffmpeg argument drift before execution", async () => {
  const mutations = [
    ["overwrite", ["-y", ...REMUX_ARGS]],
    ["wrong frame rate", REMUX_ARGS.map((value, index) => index === 7 ? "29.97" : value)],
    ["audio enabled", REMUX_ARGS.map((value) => value === "-an" ? "-sn" : value)],
    ["transcode", REMUX_ARGS.map((value) => value === "copy" ? "libx264" : value)],
    ["wrong duration", REMUX_ARGS.map((value, index) => index === 16 ? "41" : value)],
    ["foreign input", REMUX_ARGS.map((value) => value === RAW_OUTPUT_PATH ? "/tmp/foreign.h264" : value)],
    ["foreign output", REMUX_ARGS.map((value) => value === STAGED_OUTPUT_PATH ? "/tmp/foreign.mp4" : value)],
  ];

  for (const [label, args] of mutations) {
    let called = false;
    const operations = createAndroidProcessOperations({
      fs: fakeFileSystem({ rawExists: true }),
      runCommand: async () => {
        called = true;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });
    await assert.rejects(
      operations.remuxAndroidScreenrecord(remuxStep({ args: [...args] })),
      /exact.*ffmpeg|canonical.*remux|remux.*plan/i,
      label,
    );
    assert.equal(called, false, label);
  }
});
