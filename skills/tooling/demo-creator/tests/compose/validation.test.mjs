import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildValidationReport,
  readFilePrefix,
  resolveMediaInputPath,
  resolveReportPath,
  validateMedia,
  validateVideoFile,
  writeValidationReport,
} from "../../scripts/compose/validation.mjs";

const SHA256_A = "a".repeat(64);
const SHA256_B = "b".repeat(64);
const SHA256_C = "c".repeat(64);
const SYSTEM_IMAGE_PACKAGE = "system-images;android-36.1;google_apis_playstore;arm64-v8a";
const ANDROID_TOOL_NAMES = [
  "adb", "emulator", "sdkmanager", "avdmanager", "apkanalyzer",
  "kind", "kubectl", "docker", "git", "make", "ffmpeg", "ffprobe",
];

test("file-prefix reads consume bounded partial reads", async () => {
  const source = Buffer.from("moov-before-mdat");
  const handle = {
    async read(target, offset, length, position) {
      const bytesRead = Math.min(2, length, source.length - position);
      if (bytesRead <= 0) return { bytesRead: 0, buffer: target };
      source.copy(target, offset, position, position + bytesRead);
      return { bytesRead, buffer: target };
    },
  };
  assert.deepEqual(await readFilePrefix(handle, source.length), source);
});

test("media duration validation rejects invalid expectations and non-finite probes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "demo-duration-contract-"));
  const file = path.join(root, "video.mp4");
  const probe = (duration) => async () => ({ stdout: JSON.stringify({
    streams: [{
      codec_type: "video",
      codec_name: "h264",
      width: 1920,
      height: 1080,
      pix_fmt: "yuv420p",
      avg_frame_rate: "30/1",
    }],
    format: { duration, format_name: "mp4" },
  }) });
  try {
    await fs.writeFile(file, "moov-before-mdat");
    await assert.rejects(
      validateVideoFile(file, {
        width: 1920,
        height: 1080,
        expectedDuration: "18",
        execute: probe("18"),
      }),
      /expected duration must be finite and positive/,
    );
    const invalid = await validateVideoFile(file, {
      width: 1920,
      height: 1080,
      execute: probe("not-a-duration"),
    });
    assert.equal(invalid.ok, false);
    assert.equal(invalid.checks.durationFinite, false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

function completeAndroidManifest(overrides = {}) {
  const portableAndroid = {
    apk: {
      ref: "repo:components/mobile/dist/ambient-mobile.apk",
      sha256: SHA256_A,
      lock: {
        ref: "repo:components/mobile/dist/ambient-mobile.apk.lock.json",
        sha256: SHA256_B,
      },
      applicationId: "dev.ambientcode.mobile",
      versionName: "1.0.0",
      versionCode: "1",
      source: {
        commit: "d".repeat(40),
        tree: "e".repeat(40),
        path: "components/mobile",
      },
      apkanalyzer: { identity: "apkanalyzer", version: "cmdline-tools 19.0" },
    },
    systemImage: {
      package: SYSTEM_IMAGE_PACKAGE,
      revision: "2",
    },
    toolchain: Object.fromEntries(ANDROID_TOOL_NAMES.map((name) => [name, {
      identity: `${name}-identity`,
      ...(["sdkmanager", "avdmanager", "apkanalyzer"].includes(name)
        ? { version: "cmdline-tools 19.0" }
        : {}),
    }])),
  };
  return {
    artifacts: { contactSheet: "contact-sheet.png" },
    capture: {
      kind: "android-emulator",
      source: {
        type: "mobile",
        width: 1080,
        height: 2400,
        landmarks: [
          {
            id: "recorded-action-1",
            ordinal: 1,
            action: "expect",
            selector: { by: "text", value: "Onboard cluster" },
          },
          {
            id: "recorded-action-2",
            ordinal: 2,
            action: "tap",
            selector: { by: "contentDescription", value: "Connect to ACP" },
          },
          {
            id: "recorded-action-3",
            ordinal: 3,
            action: "expect",
            selector: { by: "text", value: "Connected" },
          },
        ],
        validationEvidence: {
          applicationId: "dev.ambientcode.mobile",
          versionName: "1.0.0",
          versionCode: "1",
          frameRate: 30,
          silent: true,
          durationSeconds: 14.9,
          actionCount: 3,
          pointerEventCount: 1,
          mediaValidated: true,
          artifactSha256: {
            mobileCapture: SHA256_A,
            pointerEvents: SHA256_C,
            androidApkLock: SHA256_B,
          },
        },
      },
      android: {
        ...portableAndroid,
        avdName: "private-owned-avd",
        markerPath: "/private/runtime/avd-marker.json",
        process: { pid: 4812, start: "private-process-start" },
      },
      lifecycle: {
        avd: { status: "deleted", ownershipVerified: true, avdName: "private-owned-avd" },
        cluster: { status: "deleted", ownershipVerified: true, clusterName: "private-owned-kind" },
        acpReverse: {
          status: "deleted",
          ownershipVerified: true,
          serial: "private-owned-emulator",
          hostPort: 4812,
        },
      },
    },
    ...overrides,
  };
}

function completeAndroidScenario(android = {}) {
  return {
    capture: {
      kind: "android-emulator",
      android: {
        expectedApplicationId: "dev.ambientcode.mobile",
        launchActivity: "dev.ambientcode.mobile/.MainActivity",
        systemImage: SYSTEM_IMAGE_PACKAGE,
        setupActions: [{
          action: "fillFromEnvironment",
          selector: { by: "resourceId", value: "endpoint-field" },
          environment: "ACP_URL",
        }],
        actions: [
          { action: "expect", selector: { by: "text", value: "Onboard cluster" } },
          { action: "tap", selector: { by: "contentDescription", value: "Connect to ACP" } },
          { action: "expect", selector: { by: "text", value: "Connected" } },
        ],
        ...android,
      },
    },
  };
}

test("mobile capture landmarks and validation evidence are carried into the report", () => {
  const master = { ok: true, file: "/tmp/out/demo-1080p.mp4", probe: {} };
  const derivative = { ok: true, file: "/tmp/out/demo-720p.mp4", probe: {} };
  const secretScan = { ok: true, findings: [] };
  const report = buildValidationReport({
    master,
    derivative,
    secretScan,
    outputDir: "/tmp/out",
    manifest: {
      capture: {
        source: {
          type: "mobile",
          width: 1080,
          height: 2400,
          landmarks: [{ id: "launch-complete", frame: 20 }],
          validationEvidence: { package: "com.example.demo", orientation: "portrait" },
        },
      },
    },
  });
  assert.deepEqual(report.capture, {
    source: {
      type: "mobile",
      width: 1080,
      height: 2400,
      landmarks: [{ id: "launch-complete", frame: 20 }],
      validationEvidence: { package: "com.example.demo", orientation: "portrait" },
    },
  });
  assert.equal(report.ok, true);
  assert.equal(report.master.probe, undefined);

  const browserReport = buildValidationReport({
    master,
    derivative,
    secretScan,
    outputDir: "/tmp/out",
    manifest: { capture: { source: { type: "browser", width: 1920, height: 1080 } } },
  });
  assert.equal("capture" in browserReport, false);

  const unsafeValue = "access_token=abcdefghijklmnop";
  const unsafeReport = buildValidationReport({
    master,
    derivative,
    secretScan,
    outputDir: "/tmp/out",
    manifest: {
      capture: {
        source: {
          type: "mobile",
          width: 1080,
          height: 2400,
          validationEvidence: { note: unsafeValue },
        },
      },
    },
  });
  assert.equal(unsafeReport.ok, false);
  assert.equal(unsafeReport.secretScan.ok, false);
  assert.equal(unsafeReport.secretScan.findings.length, 1);
  assert.doesNotMatch(unsafeReport.secretScan.findings[0].evidence, /abcdefghijklmnop/);
  assert.equal(JSON.stringify(unsafeReport).includes(unsafeValue), false);
});

test("Android validation report retains portable provenance and deletion proof without private runtime identity", () => {
  const master = { ok: true, file: "/tmp/out/demo-1080p.mp4", checks: { dimensions: true }, duration: 18, probe: {} };
  const derivative = { ok: true, file: "/tmp/out/demo-720p.mp4", checks: { dimensions: true }, duration: 18, probe: {} };
  const report = buildValidationReport({
    master,
    derivative,
    secretScan: { ok: true, findings: [] },
    outputDir: "/tmp/out",
    manifest: completeAndroidManifest(),
  });

  assert.deepEqual(report.capture.source, completeAndroidManifest().capture.source);
  assert.deepEqual(report.capture.android, {
    apk: completeAndroidManifest().capture.android.apk,
    systemImage: completeAndroidManifest().capture.android.systemImage,
    toolchain: completeAndroidManifest().capture.android.toolchain,
  });
  assert.deepEqual(report.capture.lifecycle, {
    avd: { status: "deleted", ownershipVerified: true },
    cluster: { status: "deleted", ownershipVerified: true },
    acpReverse: { status: "deleted", ownershipVerified: true },
  });
  const serialized = JSON.stringify(report);
  assert.doesNotMatch(serialized, /private-owned|private-process|markerPath|process|4812|\/private\//u);
  assert.deepEqual(JSON.parse(serialized), report);
});

test("validation report publishes stable automated gates while manual release review remains pending", () => {
  const report = buildValidationReport({
    master: { ok: true, file: "/tmp/out/demo-1080p.mp4", checks: { dimensions: true }, duration: 18, probe: {} },
    derivative: { ok: true, file: "/tmp/out/demo-720p.mp4", checks: { dimensions: true }, duration: 18, probe: {} },
    secretScan: { ok: true, findings: [] },
    outputDir: "/tmp/out",
    manifest: completeAndroidManifest(),
  });

  assert.deepEqual(
    report.automatedGates.map(({ id, status }) => ({ id, status })),
    [
      { id: "media.master", status: "pass" },
      { id: "media.derivative", status: "pass" },
      { id: "security.secret-scan", status: "pass" },
      { id: "security.report-portability", status: "pass" },
      { id: "mobile.capture-source", status: "pass" },
      { id: "android.apk-provenance", status: "pass" },
      { id: "android.system-image", status: "pass" },
      { id: "android.toolchain", status: "pass" },
      { id: "android.source-evidence", status: "pass" },
      { id: "android.lifecycle.avd-deleted", status: "pass" },
      { id: "android.lifecycle.cluster-deleted", status: "pass" },
      { id: "android.lifecycle.acp-reverse-deleted", status: "pass" },
    ],
  );
  assert.deepEqual(report.manualReview, {
    required: true,
    status: "pending",
    gates: [
      {
        id: "manual.final-videos",
        status: "pending",
        artifacts: ["demo-1080p.mp4", "demo-720p.mp4"],
      },
      {
        id: "manual.contact-sheet",
        status: "pending",
        artifacts: ["contact-sheet.png"],
      },
    ],
  });
  assert.equal(report.ok, true);
  assert.equal(report.releaseReady, false);
});

test("Android reverse-tunnel deletion is a required automated gate", () => {
  for (const lifecycle of [
    undefined,
    { status: "active", ownershipVerified: true },
    { status: "deleted", ownershipVerified: false },
  ]) {
    const manifest = completeAndroidManifest();
    if (lifecycle === undefined) delete manifest.capture.lifecycle.acpReverse;
    else manifest.capture.lifecycle.acpReverse = lifecycle;
    const report = buildValidationReport({
      master: { ok: true, file: "/tmp/out/demo-1080p.mp4", checks: {}, probe: {} },
      derivative: { ok: true, file: "/tmp/out/demo-720p.mp4", checks: {}, probe: {} },
      secretScan: { ok: true, findings: [] },
      outputDir: "/tmp/out",
      manifest,
    });
    assert.equal(
      report.automatedGates.find(({ id }) => id === "android.lifecycle.acp-reverse-deleted").status,
      "fail",
    );
    assert.equal(report.ok, false);
  }
});

test("mobile validation reopens digest-bound source artifacts and bounds pointer timing", async () => {
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "demo-mobile-validation-integrity-"));
  const rawDir = path.join(outputDir, "raw");
  const masterPath = path.join(outputDir, "demo-1080p.mp4");
  const derivativePath = path.join(outputDir, "demo-720p.mp4");
  const mobilePath = path.join(rawDir, "mobile.mp4");
  const pointerPath = path.join(outputDir, "pointer-events.jsonl");
  const lockPath = path.join(rawDir, "android-apk-lock.json");
  const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
  try {
    await fs.mkdir(rawDir, { recursive: true });
    const mobile = Buffer.from("verified-mobile-capture");
    const pointer = Buffer.from(`${JSON.stringify({ type: "click", time: 1, x: 0.5, y: 0.5 })}\n`);
    const lock = Buffer.from(`${JSON.stringify({
      schemaVersion: 1,
      source: {
        commit: "d".repeat(40),
        tree: "e".repeat(40),
        path: "components/mobile",
      },
      apk: {
        ref: "repo:components/mobile/dist/ambient-mobile.apk",
        sha256: SHA256_A,
        applicationId: "dev.ambientcode.mobile",
        versionName: "1.0.0",
        versionCode: "1",
      },
      apkanalyzer: { identity: "apkanalyzer", version: "cmdline-tools 19.0" },
    })}\n`);
    await Promise.all([
      fs.writeFile(masterPath, "moov-master-mdat"),
      fs.writeFile(derivativePath, "moov-derivative-mdat"),
      fs.writeFile(mobilePath, mobile),
      fs.writeFile(pointerPath, pointer),
      fs.writeFile(lockPath, lock),
    ]);
    const manifest = completeAndroidManifest();
    Object.assign(manifest.artifacts, {
      mobileCapture: "raw/mobile.mp4",
      pointerEvents: "pointer-events.jsonl",
      androidApkLock: "raw/android-apk-lock.json",
    });
    Object.assign(manifest.capture.source.validationEvidence.artifactSha256, {
      mobileCapture: digest(mobile),
      pointerEvents: digest(pointer),
      androidApkLock: digest(lock),
    });
    manifest.capture.android.apk.lock.sha256 = digest(lock);
    let mobileAverageFrameRate = "30/1";
    let mobileRealFrameRate = "30/1";
    let mobileAudio = false;
    const execute = async (_command, args) => {
      const file = args.at(-1);
      const basename = path.basename(file);
      const dimensions = basename === "demo-1080p.mp4"
        ? [1920, 1080]
        : basename === "demo-720p.mp4"
          ? [1280, 720]
          : [1080, 2400];
      const streams = [{
          codec_type: "video",
          codec_name: "h264",
          width: dimensions[0],
          height: dimensions[1],
          pix_fmt: "yuv420p",
          avg_frame_rate: basename.startsWith("demo-") ? "30/1" : mobileAverageFrameRate,
          r_frame_rate: basename.startsWith("demo-") ? "30/1" : mobileRealFrameRate,
        }];
      if (!basename.startsWith("demo-") && mobileAudio) streams.push({ codec_type: "audio", codec_name: "aac" });
      return { stdout: JSON.stringify({
        streams,
        format: { duration: basename.startsWith("demo-") ? "18" : "14.95", format_name: "mp4" },
      }) };
    };
    const invoke = () => validateMedia({
      outputDir,
      captureRoot: outputDir,
      masterPath,
      derivativePath,
      expectedDuration: 18,
      execute,
      manifest,
      scenario: { story: [{ type: "mobile", durationSeconds: 15 }] },
      scanOutputSecrets: async () => ({ ok: true, findings: [] }),
    });
    assert.equal((await invoke()).ok, true);

    mobileAverageFrameRate = "29/1";
    await assert.rejects(invoke(), /mobile capture media does not match/i);
    mobileAverageFrameRate = "30/1";
    mobileRealFrameRate = "29/1";
    await assert.rejects(invoke(), /mobile capture media does not match/i);
    mobileRealFrameRate = undefined;
    await assert.rejects(invoke(), /mobile capture media does not match/i);
    mobileRealFrameRate = "30/1";
    mobileAudio = true;
    await assert.rejects(invoke(), /mobile capture media does not match/i);
    mobileAudio = false;

    const wrongPointer = Buffer.from(`${JSON.stringify({ type: "move", time: 1, x: 0.5, y: 0.5 })}\n`);
    await fs.writeFile(pointerPath, wrongPointer);
    manifest.capture.source.validationEvidence.artifactSha256.pointerEvents = digest(wrongPointer);
    await assert.rejects(invoke(), /canonical normalized click/);
    await fs.writeFile(pointerPath, pointer);
    manifest.capture.source.validationEvidence.artifactSha256.pointerEvents = digest(pointer);

    const unrelatedLock = Buffer.from('{"unrelated":true}\n');
    await fs.writeFile(lockPath, unrelatedLock);
    manifest.capture.source.validationEvidence.artifactSha256.androidApkLock = digest(unrelatedLock);
    manifest.capture.android.apk.lock.sha256 = digest(unrelatedLock);
    await assert.rejects(invoke(), /Android APK lock evidence does not match capture provenance/);
    await fs.writeFile(lockPath, lock);
    manifest.capture.source.validationEvidence.artifactSha256.androidApkLock = digest(lock);
    manifest.capture.android.apk.lock.sha256 = digest(lock);

    const lockWithPrivateExtra = Buffer.from(`${JSON.stringify({
      ...JSON.parse(lock.toString("utf8")),
      privatePath: "/Users/private/credential",
    })}\n`);
    await fs.writeFile(lockPath, lockWithPrivateExtra);
    manifest.capture.source.validationEvidence.artifactSha256.androidApkLock = digest(lockWithPrivateExtra);
    manifest.capture.android.apk.lock.sha256 = digest(lockWithPrivateExtra);
    await assert.rejects(invoke(), /Android APK lock evidence does not match capture provenance/);
    await fs.writeFile(lockPath, lock);
    manifest.capture.source.validationEvidence.artifactSha256.androidApkLock = digest(lock);
    manifest.capture.android.apk.lock.sha256 = digest(lock);

    await fs.writeFile(pointerPath, `${JSON.stringify({ type: "click", time: 1, x: 0.4, y: 0.4 })}\n`);
    await assert.rejects(invoke(), /pointerEvents digest does not match/i);

    const beyond = Buffer.from(`${JSON.stringify({ type: "click", time: 14.95, x: 0.5, y: 0.5 })}\n`);
    await fs.writeFile(pointerPath, beyond);
    manifest.capture.source.validationEvidence.artifactSha256.pointerEvents = digest(beyond);
    await assert.rejects(invoke(), /pointer event.*verified mobile capture duration/i);
  } finally {
    await fs.rm(outputDir, { recursive: true, force: true });
  }
});

test("mobile source gate rejects empty landmarks instead of treating a placeholder as evidence", () => {
  const manifest = completeAndroidManifest();
  manifest.capture.source.landmarks = [];
  const report = buildValidationReport({
    master: { ok: true, file: "/tmp/out/demo-1080p.mp4", checks: {}, probe: {} },
    derivative: { ok: true, file: "/tmp/out/demo-720p.mp4", checks: {}, probe: {} },
    secretScan: { ok: true, findings: [] },
    outputDir: "/tmp/out",
    manifest,
  });

  assert.equal(report.automatedGates.find(({ id }) => id === "mobile.capture-source").status, "fail");
  assert.equal(report.automatedGates.find(({ id }) => id === "android.source-evidence").status, "fail");
  assert.equal(report.ok, false);
});

test("Android source-evidence gate rejects fabricated runtime evidence", () => {
  const mutations = [
    (source) => { source.landmarks = [null]; source.validationEvidence.actionCount = 1; },
    (source) => { source.validationEvidence.frameRate = 29; },
    (source) => { source.validationEvidence.silent = false; },
    (source) => { source.validationEvidence.durationSeconds = 0; },
    (source) => { source.validationEvidence.durationSeconds = 179.001; },
    (source) => { source.validationEvidence.mediaValidated = false; },
    (source) => { source.validationEvidence.actionCount = 2; },
    (source) => { source.validationEvidence.pointerEventCount = -1; },
    (source) => { source.validationEvidence.pointerEventCount = 0; },
    (source) => { source.landmarks[0].ordinal = 2; },
    (source) => { source.landmarks[0].selector.value = "/private/device/state"; },
    (source) => { [source.width, source.height] = [2400, 1080]; },
    (source) => { source.validationEvidence.applicationId = "dev.ambientcode.other"; },
    (source) => { source.validationEvidence.versionName = "2.0.0"; },
    (source) => { source.validationEvidence.versionCode = "2"; },
    (source) => { source.validationEvidence.artifactSha256.androidApkLock = SHA256_C; },
  ];
  for (const mutate of mutations) {
    const manifest = completeAndroidManifest();
    mutate(manifest.capture.source);
    const report = buildValidationReport({
      master: { ok: true, file: "/tmp/out/demo-1080p.mp4", checks: {}, probe: {} },
      derivative: { ok: true, file: "/tmp/out/demo-720p.mp4", checks: {}, probe: {} },
      secretScan: { ok: true, findings: [] },
      outputDir: "/tmp/out",
      manifest,
    });
    assert.equal(
      report.automatedGates.find(({ id }) => id === "android.source-evidence").status,
      "fail",
    );
    assert.equal(report.ok, false);
    assert.doesNotMatch(JSON.stringify(report), /\/private\/device\/state/u);
  }
});

test("Android source-evidence resourceId landmarks use the shared Android selector grammar", () => {
  for (const resourceId of [
    "onboard-button",
    "dev.ambientcode.mobile:id/onboard_button",
  ]) {
    const manifest = completeAndroidManifest();
    manifest.capture.source.landmarks[0].selector = { by: "resourceId", value: resourceId };
    const scenario = completeAndroidScenario();
    scenario.capture.android.actions[0].selector = { by: "resourceId", value: resourceId };
    const report = buildValidationReport({
      master: { ok: true, file: "/tmp/out/demo-1080p.mp4", checks: {}, probe: {} },
      derivative: { ok: true, file: "/tmp/out/demo-720p.mp4", checks: {}, probe: {} },
      secretScan: { ok: true, findings: [] },
      outputDir: "/tmp/out",
      manifest,
      scenario,
    });
    assert.equal(
      report.automatedGates.find(({ id }) => id === "android.source-evidence").status,
      "pass",
      resourceId,
    );
  }

  for (const resourceId of ["bad id", "pkg:id/foo-bar", "1invalid-test-id"]) {
    const manifest = completeAndroidManifest();
    manifest.capture.source.landmarks[0].selector = { by: "resourceId", value: resourceId };
    const scenario = completeAndroidScenario();
    scenario.capture.android.actions[0].selector = { by: "resourceId", value: resourceId };
    const report = buildValidationReport({
      master: { ok: true, file: "/tmp/out/demo-1080p.mp4", checks: {}, probe: {} },
      derivative: { ok: true, file: "/tmp/out/demo-720p.mp4", checks: {}, probe: {} },
      secretScan: { ok: true, findings: [] },
      outputDir: "/tmp/out",
      manifest,
      scenario,
    });
    assert.equal(
      report.automatedGates.find(({ id }) => id === "android.source-evidence").status,
      "fail",
      resourceId,
    );
    assert.equal(report.ok, false);
  }
});

test("Android validation binds APK and source application IDs to the authored launch contract", () => {
  const cases = [
    completeAndroidScenario({
      expectedApplicationId: "dev.ambientcode.other",
      launchActivity: "dev.ambientcode.other/.MainActivity",
    }),
    completeAndroidScenario({
      launchActivity: "dev.ambientcode.other/.MainActivity",
    }),
  ];
  for (const scenario of cases) {
    const report = buildValidationReport({
      master: { ok: true, file: "/tmp/out/demo-1080p.mp4", checks: {}, probe: {} },
      derivative: { ok: true, file: "/tmp/out/demo-720p.mp4", checks: {}, probe: {} },
      secretScan: { ok: true, findings: [] },
      outputDir: "/tmp/out",
      manifest: completeAndroidManifest(),
      scenario,
    });
    assert.equal(
      report.automatedGates.find(({ id }) => id === "android.apk-provenance").status,
      "fail",
    );
    assert.equal(
      report.automatedGates.find(({ id }) => id === "android.source-evidence").status,
      "fail",
    );
    assert.equal(report.ok, false);
  }
});

test("Android source evidence must exactly match the authored recorded action sequence", () => {
  const cases = [
    (source) => {
      source.landmarks[0].action = "tap";
      source.validationEvidence.pointerEventCount = 2;
    },
    (source) => {
      source.landmarks[1].selector.value = "A different valid control";
    },
    (source) => {
      source.landmarks.splice(1, 1);
      source.landmarks[1].id = "recorded-action-2";
      source.landmarks[1].ordinal = 2;
      source.validationEvidence.actionCount = 2;
      source.validationEvidence.pointerEventCount = 0;
    },
    (source) => {
      const firstSelector = source.landmarks[0].selector;
      source.landmarks[0].selector = source.landmarks[2].selector;
      source.landmarks[2].selector = firstSelector;
    },
  ];

  for (const mutate of cases) {
    const manifest = completeAndroidManifest();
    mutate(manifest.capture.source);
    const report = buildValidationReport({
      master: { ok: true, file: "/tmp/out/demo-1080p.mp4", checks: {}, probe: {} },
      derivative: { ok: true, file: "/tmp/out/demo-720p.mp4", checks: {}, probe: {} },
      secretScan: { ok: true, findings: [] },
      outputDir: "/tmp/out",
      manifest,
      scenario: completeAndroidScenario(),
    });

    assert.equal(
      report.automatedGates.find(({ id }) => id === "android.source-evidence").status,
      "fail",
    );
    assert.equal(report.ok, false);
  }
});

test("Android authored action binding preserves the exact portable runtime emission contract", () => {
  const scenario = completeAndroidScenario({
    actions: [
      { action: "wait", ms: 250 },
      { action: "expect", selector: { by: "text", value: "Ready" } },
      { action: "tap", selector: { by: "resourceId", value: "connect-button" } },
      {
        action: "fill",
        selector: { by: "contentDescription", value: "Project name" },
        value: "demo-project",
      },
      { action: "back" },
    ],
  });
  const manifest = completeAndroidManifest();
  manifest.capture.source.landmarks = [
    { id: "recorded-action-1", ordinal: 1, action: "wait" },
    {
      id: "recorded-action-2",
      ordinal: 2,
      action: "expect",
      selector: { by: "text", value: "Ready" },
    },
    {
      id: "recorded-action-3",
      ordinal: 3,
      action: "tap",
      selector: { by: "resourceId", value: "connect-button" },
    },
    {
      id: "recorded-action-4",
      ordinal: 4,
      action: "fill",
      selector: { by: "contentDescription", value: "Project name" },
    },
    { id: "recorded-action-5", ordinal: 5, action: "back" },
  ];
  manifest.capture.source.validationEvidence.actionCount = 5;
  manifest.capture.source.validationEvidence.pointerEventCount = 2;

  const report = buildValidationReport({
    master: { ok: true, file: "/tmp/out/demo-1080p.mp4", checks: {}, probe: {} },
    derivative: { ok: true, file: "/tmp/out/demo-720p.mp4", checks: {}, probe: {} },
    secretScan: { ok: true, findings: [] },
    outputDir: "/tmp/out",
    manifest,
    scenario,
  });

  assert.equal(
    report.automatedGates.find(({ id }) => id === "android.source-evidence").status,
    "pass",
  );
  assert.equal(report.ok, true);
});

test("Android validation rejects and omits private validation-evidence fields from public reports", () => {
  for (const mutate of [
    (manifest) => { manifest.capture.source.validationEvidence.runtimeSessionId = "private-runtime-session"; },
    (manifest) => { manifest.capture.source.validationEvidence.artifactSha256.privateStage = SHA256_C; },
  ]) {
    const manifest = completeAndroidManifest();
    mutate(manifest);
    const report = buildValidationReport({
      master: { ok: true, file: "/tmp/out/demo-1080p.mp4", checks: {}, probe: {} },
      derivative: { ok: true, file: "/tmp/out/demo-720p.mp4", checks: {}, probe: {} },
      secretScan: { ok: true, findings: [] },
      outputDir: "/tmp/out",
      manifest,
    });

    assert.equal(
      report.automatedGates.find(({ id }) => id === "android.source-evidence").status,
      "fail",
    );
    assert.equal(report.ok, false);
    assert.equal(JSON.stringify(report).includes("private-runtime-session"), false);
    assert.equal(JSON.stringify(report).includes("privateStage"), false);
  }
});

test("Android system-image gate rejects missing or unbounded installed revision evidence", () => {
  for (const revision of ["", "1234567", "1.2.3.4.5", "private/revision"]) {
    const manifest = completeAndroidManifest();
    manifest.capture.android.systemImage.revision = revision;
    const report = buildValidationReport({
      master: { ok: true, file: "/tmp/out/demo-1080p.mp4", checks: {}, probe: {} },
      derivative: { ok: true, file: "/tmp/out/demo-720p.mp4", checks: {}, probe: {} },
      secretScan: { ok: true, findings: [] },
      outputDir: "/tmp/out",
      manifest,
    });

    assert.equal(report.automatedGates.find(({ id }) => id === "android.system-image").status, "fail");
    assert.equal(report.ok, false);
  }
});

test("Android system-image gate validates original exact keys, package grammar, and authored binding", () => {
  const scenario = { capture: { android: { systemImage: SYSTEM_IMAGE_PACKAGE } } };
  const cases = [
    (manifest) => { manifest.capture.android.systemImage.package = "not-an-android-system-image"; },
    (manifest) => { manifest.capture.android.systemImage.installed = true; },
    (manifest) => { manifest.capture.android.systemImage.sdkPath = "/private/android-sdk"; },
  ];

  for (const mutate of cases) {
    const manifest = completeAndroidManifest();
    mutate(manifest);
    const report = buildValidationReport({
      master: { ok: true, file: "/tmp/out/demo-1080p.mp4", checks: {}, probe: {} },
      derivative: { ok: true, file: "/tmp/out/demo-720p.mp4", checks: {}, probe: {} },
      secretScan: { ok: true, findings: [] },
      outputDir: "/tmp/out",
      manifest,
      scenario,
    });

    assert.equal(report.automatedGates.find(({ id }) => id === "android.system-image").status, "fail");
    assert.equal(report.ok, false);
    assert.deepEqual(Object.keys(report.capture.android.systemImage).sort(), ["package", "revision"]);
    assert.equal(JSON.stringify(report).includes("/private/android-sdk"), false);
  }

  const mismatchedScenario = { capture: { android: {
    systemImage: "system-images;android-35;google_apis;arm64-v8a",
  } } };
  const mismatch = buildValidationReport({
    master: { ok: true, file: "/tmp/out/demo-1080p.mp4", checks: {}, probe: {} },
    derivative: { ok: true, file: "/tmp/out/demo-720p.mp4", checks: {}, probe: {} },
    secretScan: { ok: true, findings: [] },
    outputDir: "/tmp/out",
    manifest: completeAndroidManifest(),
    scenario: mismatchedScenario,
  });
  assert.equal(mismatch.automatedGates.find(({ id }) => id === "android.system-image").status, "fail");
  assert.equal(mismatch.ok, false);
});

test("Android manifests cannot pass validation without Android metadata", () => {
  const manifest = completeAndroidManifest();
  delete manifest.capture.android;
  const report = buildValidationReport({
    master: { ok: true, file: "/tmp/out/demo-1080p.mp4", checks: {}, probe: {} },
    derivative: { ok: true, file: "/tmp/out/demo-720p.mp4", checks: {}, probe: {} },
    secretScan: { ok: true, findings: [] },
    outputDir: "/tmp/out",
    manifest,
  });

  assert.equal(report.automatedGates.find(({ id }) => id === "android.apk-provenance").status, "fail");
  assert.equal(report.automatedGates.find(({ id }) => id === "android.system-image").status, "fail");
  assert.equal(report.ok, false);
});

test("Android toolchain gate requires the exact capture tool set and field shapes", () => {
  for (const mutate of [
    (toolchain) => { delete toolchain.git; },
    (toolchain) => { toolchain.unexpected = { identity: "unexpected" }; },
    (toolchain) => { toolchain.adb.version = "not-allowed"; },
    (toolchain) => { toolchain.sdkmanager.version = ""; },
  ]) {
    const manifest = completeAndroidManifest();
    mutate(manifest.capture.android.toolchain);
    const report = buildValidationReport({
      master: { ok: true, file: "/tmp/out/demo-1080p.mp4", checks: {}, probe: {} },
      derivative: { ok: true, file: "/tmp/out/demo-720p.mp4", checks: {}, probe: {} },
      secretScan: { ok: true, findings: [] },
      outputDir: "/tmp/out",
      manifest,
    });
    assert.equal(report.automatedGates.find(({ id }) => id === "android.toolchain").status, "fail");
    assert.equal(report.ok, false);
  }
});

test("Android provenance gate rejects and omits nonportable refs and host paths", () => {
  const cases = [
    {
      privateValue: "repo:/Users/private/mobile.apk",
      mutate: (android) => { android.apk.ref = "repo:/Users/private/mobile.apk"; },
    },
    {
      privateValue: "repo:../private.apk",
      mutate: (android) => { android.apk.ref = "repo:../private.apk"; },
    },
    {
      privateValue: "repo:C:/private.apk",
      mutate: (android) => { android.apk.lock.ref = "repo:C:/private.apk"; },
    },
    {
      privateValue: "repo:components/mobile:private.apk",
      mutate: (android) => { android.apk.ref = "repo:components/mobile:private.apk"; },
    },
    {
      privateValue: "/private/tools/adb",
      mutate: (android) => { android.toolchain.adb.identity = "/private/tools/adb"; },
    },
    {
      privateValue: "/Users/private/source",
      mutate: (android) => { android.apk.source.privatePath = "/Users/private/source"; },
    },
  ];
  for (const { privateValue, mutate } of cases) {
    const manifest = completeAndroidManifest();
    mutate(manifest.capture.android);
    const report = buildValidationReport({
      master: { ok: true, file: "/tmp/out/demo-1080p.mp4", checks: {}, probe: {} },
      derivative: { ok: true, file: "/tmp/out/demo-720p.mp4", checks: {}, probe: {} },
      secretScan: { ok: true, findings: [] },
      outputDir: "/tmp/out",
      manifest,
    });
    assert.equal(
      report.automatedGates.find(({ id }) => id === "android.apk-provenance").status,
      "fail",
    );
    assert.equal(report.ok, false);
    assert.equal(JSON.stringify(report).includes(privateValue), false);
  }
});

test("report portability gate rejects and omits a host-private contact-sheet path", () => {
  const manifest = completeAndroidManifest();
  manifest.artifacts.contactSheet = "/Users/private/contact-sheet.png";
  const report = buildValidationReport({
    master: { ok: true, file: "/tmp/out/demo-1080p.mp4", checks: {}, probe: {} },
    derivative: { ok: true, file: "/tmp/out/demo-720p.mp4", checks: {}, probe: {} },
    secretScan: { ok: true, findings: [] },
    outputDir: "/tmp/out",
    manifest,
  });

  assert.equal(
    report.automatedGates.find(({ id }) => id === "security.report-portability").status,
    "fail",
  );
  assert.equal(report.ok, false);
  assert.equal(JSON.stringify(report).includes("/Users/private"), false);
  assert.deepEqual(report.manualReview.gates[1].artifacts, ["contact-sheet.png"]);
});

test("report-wide secret scan removes a selected value used as a portable artifact name", () => {
  const configuredValue = "exact-password-4812";
  const manifest = completeAndroidManifest();
  manifest.artifacts.contactSheet = configuredValue;
  const report = buildValidationReport({
    master: { ok: true, file: "/tmp/out/demo-1080p.mp4", checks: {}, probe: {} },
    derivative: { ok: true, file: "/tmp/out/demo-720p.mp4", checks: {}, probe: {} },
    secretScan: { ok: true, findings: [] },
    outputDir: "/tmp/out",
    manifest,
    sensitiveValues: [configuredValue],
  });

  assert.equal(report.ok, false);
  assert.equal(report.secretScan.ok, false);
  assert.equal(report.automatedGates.find(({ id }) => id === "security.secret-scan").status, "fail");
  assert.equal(JSON.stringify(report).includes(configuredValue), false);
  assert.deepEqual(report.manualReview.gates[1].artifacts, ["contact-sheet.png"]);
});

test("Android provenance is included in the validation report secret scan", () => {
  const manifest = completeAndroidManifest();
  manifest.capture.android.apk.apkanalyzer.identity = "access_token=abcdefghijklmnop";
  const report = buildValidationReport({
    master: { ok: true, file: "/tmp/out/demo-1080p.mp4", checks: {}, probe: {} },
    derivative: { ok: true, file: "/tmp/out/demo-720p.mp4", checks: {}, probe: {} },
    secretScan: { ok: true, findings: [] },
    outputDir: "/tmp/out",
    manifest,
  });

  assert.equal(report.ok, false);
  assert.equal(report.secretScan.ok, false);
  assert.equal(report.automatedGates.find(({ id }) => id === "security.secret-scan").status, "fail");
  assert.doesNotMatch(JSON.stringify(report.secretScan.findings), /abcdefghijklmnop/u);
});

test("exact selected setup values are rejected and removed from report metadata", () => {
  const configuredValue = "exact-oidc-user-4812";
  const manifest = completeAndroidManifest();
  manifest.capture.android.apk.apkanalyzer.identity = configuredValue;
  const report = buildValidationReport({
    master: { ok: true, file: "/tmp/out/demo-1080p.mp4", checks: {}, probe: {} },
    derivative: { ok: true, file: "/tmp/out/demo-720p.mp4", checks: {}, probe: {} },
    secretScan: { ok: true, findings: [] },
    outputDir: "/tmp/out",
    manifest,
    sensitiveValues: [configuredValue],
  });

  assert.equal(report.ok, false);
  assert.equal(report.secretScan.ok, false);
  assert.equal(report.automatedGates.find(({ id }) => id === "security.secret-scan").status, "fail");
  assert.equal(JSON.stringify(report).includes(configuredValue), false);
});

test("validation report writes are constrained to outputDir", () => {
  assert.equal(
    resolveReportPath("reports/validation.json", "/tmp/demo-output"),
    "/tmp/demo-output/reports/validation.json",
  );
  assert.throws(
    () => resolveReportPath("../validation.json", "/tmp/demo-output"),
    /remain inside outputDir/,
  );
  assert.throws(
    () => resolveReportPath("/tmp/validation.json", "/tmp/demo-output"),
    /must be relative to outputDir/,
  );
});

test("validation report publication rejects symlinked parents and destinations", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "demo-validation-report-symlink-"));
  const outputDir = path.join(root, "output");
  const outside = path.join(root, "outside");
  try {
    await Promise.all([
      fs.mkdir(outputDir),
      fs.mkdir(outside),
    ]);
    await fs.symlink(outside, path.join(outputDir, "reports"));
    await assert.rejects(
      writeValidationReport(outputDir, "reports/validation.json", { ok: true }),
      /symbolic link/,
    );
    await assert.rejects(fs.access(path.join(outside, "validation.json")), { code: "ENOENT" });

    await fs.rm(path.join(outputDir, "reports"));
    const outsideFile = path.join(outside, "existing.json");
    await fs.writeFile(outsideFile, "sentinel");
    await fs.symlink(outsideFile, path.join(outputDir, "validation-report.json"));
    await assert.rejects(
      writeValidationReport(outputDir, "validation-report.json", { ok: true }),
      /symbolic link/,
    );
    assert.equal(await fs.readFile(outsideFile, "utf8"), "sentinel");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("validation report publication fails closed if outputDir identity changes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "demo-validation-report-root-swap-"));
  const outputDir = path.join(root, "output");
  const movedOutput = path.join(root, "moved-output");
  const outside = path.join(root, "outside");
  try {
    await Promise.all([fs.mkdir(outputDir), fs.mkdir(outside)]);
    await assert.rejects(
      writeValidationReport(outputDir, "validation-report.json", { ok: true }, {
        afterTemporaryWrite: async () => {
          await fs.rename(outputDir, movedOutput);
          await fs.symlink(outside, outputDir);
        },
      }),
      /outputDir changed during validation report publication/,
    );
    await assert.rejects(fs.access(path.join(outside, "validation-report.json")), { code: "ENOENT" });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("media inputs, including manifest-derived paths, cannot escape outputDir", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "demo-media-path-"));
  const outputDir = path.join(root, "output");
  const inside = path.join(outputDir, "demo-1080p.mp4");
  const outside = path.join(root, "outside.mp4");
  try {
    await fs.mkdir(outputDir);
    await fs.writeFile(inside, "inside");
    await fs.writeFile(outside, "outside");
    const realInside = await fs.realpath(inside);
    assert.equal(await resolveMediaInputPath("demo-1080p.mp4", outputDir, "master video"), realInside);
    assert.equal(await resolveMediaInputPath(inside, outputDir, "master video"), realInside);
    await assert.rejects(
      resolveMediaInputPath(outside, outputDir, "master video"),
      /remain inside outputDir/,
    );
    await assert.rejects(
      resolveMediaInputPath("../outside.mp4", outputDir, "master video"),
      /remain inside outputDir/,
    );
    await fs.symlink(outside, path.join(outputDir, "linked.mp4"));
    await assert.rejects(
      resolveMediaInputPath("linked.mp4", outputDir, "master video"),
      /symbolic link/,
    );
    await assert.rejects(
      validateMedia({
        outputDir,
        manifest: { artifacts: { masterVideo: outside, derivativeVideo: "demo-1080p.mp4" } },
      }),
      /master video must remain inside outputDir/,
    );
    await assert.rejects(
      validateMedia({
        outputDir,
        manifest: { artifacts: { masterVideo: "demo-1080p.mp4", derivativeVideo: "../outside.mp4" } },
      }),
      /derivative video must remain inside outputDir/,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("media validation forwards transient configured values to the output secret scanner", async () => {
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "demo-sensitive-forwarding-"));
  const masterPath = path.join(outputDir, "demo-1080p.mp4");
  const derivativePath = path.join(outputDir, "demo-720p.mp4");
  const sensitiveValues = ["exact-mobile-password-4812"];
  let received;
  try {
    await Promise.all([
      fs.writeFile(masterPath, "moov-master-mdat"),
      fs.writeFile(derivativePath, "moov-derivative-mdat"),
    ]);
    const execute = async (_command, args) => {
      const file = args.at(-1);
      const master = path.basename(file) === "demo-1080p.mp4";
      return {
        stdout: JSON.stringify({
          streams: [{
            codec_type: "video",
            codec_name: "h264",
            width: master ? 1920 : 1280,
            height: master ? 1080 : 720,
            pix_fmt: "yuv420p",
            avg_frame_rate: "30/1",
          }],
          format: { duration: "18", format_name: "mp4" },
        }),
      };
    };
    const scanOutputSecrets = async (root, options) => {
      received = { root, options };
      return { ok: true, findings: [] };
    };
    await validateMedia({
      outputDir,
      masterPath,
      derivativePath,
      execute,
      manifest: { capture: { source: { validationEvidence: { note: "portable-evidence" } } } },
      scenario: {
        capture: {
          kind: "android-emulator",
          android: {
            setupActions: [{
              action: "fillFromEnvironment",
              environment: "ACP_BEARER_TOKEN",
            }],
          },
        },
      },
      environment: { ACP_BEARER_TOKEN: sensitiveValues[0] },
      scanOutputSecrets,
    });
    assert.equal(received.root, await fs.realpath(outputDir));
    assert.deepEqual(received.options.sensitiveValues, sensitiveValues);
    assert.deepEqual(received.options.metadata.at(-1), {
      source: "manifest.lock.json#metadata",
      value: { capture: { source: { validationEvidence: { note: "portable-evidence" } } } },
    });
    assert.equal(JSON.stringify(received).includes(sensitiveValues[0]), true);
  } finally {
    await fs.rm(outputDir, { recursive: true, force: true });
  }
});
