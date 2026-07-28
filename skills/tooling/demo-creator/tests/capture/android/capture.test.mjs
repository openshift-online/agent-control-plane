import assert from "node:assert/strict";
import test from "node:test";

import { captureAndroid } from "../../../scripts/capture/android/capture.mjs";

const SECRET = "must-never-leave-private-stdin";

function captureConfig(overrides = {}) {
  return {
    repoRoot: "/workspace/acp",
    scenarioId: "android-onboarding",
    runId: "run-123",
    markerRoot: "/private/run-123",
    outputDir: "/output",
    width: 1080,
    height: 1920,
    authoredDurationMs: 5_000,
    capture: {
      kind: "android-emulator",
      cluster: { kind: "disposable-kind" },
      android: {
        expectedApplicationId: "dev.example.mobile",
        apk: "repo:artifacts/mobile.apk",
        apkLock: "repo:artifacts/mobile.apk.lock.json",
        launchActivity: "dev.example.mobile/.MainActivity",
        systemImage: "system-images;android-35;google_apis;arm64-v8a",
        actionSettlingMilliseconds: 900,
        setupActions: [{
          action: "fillFromEnvironment",
          selector: { by: "resourceId", value: "endpoint" },
          environment: "ACP_URL",
        }, {
          action: "fillFromEnvironment",
          selector: { by: "resourceId", value: "project" },
          environment: "ACP_PROJECT",
        }, {
          action: "fillFromEnvironment",
          selector: { by: "resourceId", value: "token" },
          environment: "ACP_BEARER_TOKEN",
        }],
        actions: [
          { action: "expect", selector: { by: "text", value: "Onboard cluster" } },
          { action: "tap", selector: { by: "contentDescription", value: "Connect to ACP" } },
          { action: "expect", selector: { by: "text", value: "Connected" } },
        ],
      },
    },
    ...overrides,
  };
}

function createHarness({
  failAt,
  cleanupFailures = new Map(),
  recordedActionsResult,
  doctorSystemImage,
  readyAvdResult,
  displayGeometries,
} = {}) {
  const calls = [];
  let clock = 10_000;
  const primaryError = new Error(`primary failure at ${failAt}`);
  const fail = (name) => {
    if (failAt === name) throw primaryError;
  };
  const called = (name, details) => {
    calls.push({ name, details });
    fail(name);
  };

  const doctor = {
    ok: true,
    tools: Object.fromEntries([
      "adb", "emulator", "avdmanager", "apkanalyzer", "kind", "kubectl",
      "docker", "git", "ffmpeg", "ffprobe", "make",
    ].map((name) => [name, {
      path: `/tools/${name}`,
      identity: `${name}-identity`,
      ...(name === "apkanalyzer" ? { version: "cmdline-tools 19.0" } : {}),
    }])),
    sdk: {
      root: "/android-sdk",
      systemImage: doctorSystemImage ?? {
        package: "system-images;android-35;google_apis;arm64-v8a",
        revision: "14.0",
        installed: true,
      },
    },
  };
  const apk = {
    ref: "repo:artifacts/mobile.apk",
    sha256: "a".repeat(64),
    lock: {
      ref: "repo:artifacts/mobile.apk.lock.json",
      sha256: "b".repeat(64),
    },
    applicationId: "dev.example.mobile",
    versionName: "1.2.3",
    versionCode: "123",
    source: {
      commit: "c".repeat(40),
      tree: "d".repeat(40),
      path: "components/mobile",
    },
    apkanalyzer: { identity: "apkanalyzer", version: "cmdline-tools 19.0" },
  };
  const kindReservation = {
    markerPath: "/private/run-123/kind-ownership.json",
    clusterName: "acp-demo-android-onboarding-run-123-generated",
    kubeContext: "kind-acp-demo-android-onboarding-run-123-generated",
  };
  const boundKind = {
    ...kindReservation,
    kubeServer: "https://127.0.0.1:54443",
    containerIdentities: ["a".repeat(64)],
    ready: true,
  };
  const kindCreationTransaction = Object.freeze({ opaque: true });
  const avdReservation = {
    markerPath: "/private/run-123/avd-ownership.json",
    avdName: "acp-demo-android-onboarding-run-123-generated",
    avdPath: "/private/avds/acp-demo-android-onboarding-run-123-generated.avd",
    systemImage: "system-images;android-35;google_apis;arm64-v8a",
  };
  const binding = {
    serial: "emulator-5580",
    consolePort: 5580,
    pid: 4242,
    processStartIdentity: "4242:987654",
  };
  const boundAvd = { ...avdReservation, ...binding };
  const avdCreationProof = Object.freeze({ opaqueAvdCreation: true });
  const displayGeometry = Object.freeze({
    physical: Object.freeze({ width: 1080, height: 2400 }),
    recording: Object.freeze({ width: 1080, height: 1920 }),
    rotation: 0,
  });
  let displayGeometryIndex = 0;
  const recordingPlan = {
    emulatorLaunch: { requiredArgs: ["-vsync-rate", "30"], frameRate: 30 },
    record: {
      executable: "/tools/adb",
      args: [
        "-s", binding.serial, "exec-out", "screenrecord", "--output-format=h264",
        "--size", "1080x1920", "--bit-rate", "8000000", "--time-limit", "6", "-",
      ],
      rawOutputPath: "/output/.capture-stage/screenrecord.h264",
    },
    remux: {
      executable: "/tools/ffmpeg",
      args: [
        "-nostdin", "-hide_banner", "-loglevel", "error", "-f", "h264",
        "-framerate", "30", "-i", "/output/.capture-stage/screenrecord.h264",
        "-map", "0:v:0", "-an", "-c:v", "copy", "-frames:v", "150",
        "-movflags", "+faststart", "/output/.capture-stage/screenrecord.mp4",
      ],
      expectedDurationSeconds: 5,
      rawOutputPath: "/output/.capture-stage/screenrecord.h264",
      stagedOutputPath: "/output/.capture-stage/screenrecord.mp4",
      targetFrames: 150,
    },
    validation: {
      expectedOutputPath: "/output/.capture-stage/screenrecord.mp4",
      expectedDurationSeconds: 5,
      minimumDurationSeconds: 5 - (1 / 30),
      maxDurationSeconds: 5 + (1 / 30),
      targetFrames: 150,
      width: 1080,
      height: 1920,
      frameRate: 30,
      videoStreams: 1,
      audioStreams: 0,
    },
    publish: {
      stagedOutputPath: "/output/.capture-stage/screenrecord.mp4",
      outputDir: "/output",
      destinationPath: "/output/raw/android.mp4",
    },
  };
  const pointerEvents = [];
  let recordedAvdCreation = false;
  const driver = Object.freeze({ secret: "driver-is-opaque" });
  const processRegistry = { emulators: new Map(), recorders: new Map() };

  const deps = {
    avdRoot: "/private/avds",
    environment: {
      ACP_PROJECT: "demo-android-onboarding",
      ACP_BEARER_TOKEN: SECRET,
    },
    toolEnvironment: {
      PATH: "/usr/bin:/bin",
      JAVA_HOME: "/opt/java",
      RANDOM_SECRET: SECRET,
    },
    prepareAndroidRunDirectories: async (options) => {
      called("prepareDirectories", options);
      return {
        markerRoot: "/private/run-123",
        avdRoot: "/private/avds",
        homeRoot: "/private/run-123/home",
        tmpRoot: "/private/run-123/tmp",
        xdgConfigRoot: "/private/run-123/xdg-config",
        xdgRuntimeRoot: "/private/run-123/xdg-runtime",
        kindStateRoot: "/private/run-123/kind-state",
        kindLegacyRoot: "/private/run-123/kind-state/legacy",
        outputDir: "/output",
        rawOutputDir: "/output/raw",
        stagingParent: "/output",
      };
    },
    prepareIsolatedKindWorkspace: async (input) => {
      called("prepareKindWorkspace", input);
      return { workspaceRoot: "/private/run-123/kind-workspace", sourceCommit: apk.source.commit };
    },
    createAndroidProcessRegistry: () => {
      called("processRegistry");
      return processRegistry;
    },
    createKindLifecycleDeps: (config, lowLevel) => {
      called("kindLifecycleDeps", { config, lowLevel });
      assert.deepEqual(lowLevel.toolEnvironment, {
        PATH: "/usr/bin:/bin",
        JAVA_HOME: "/opt/java",
      });
      return {
        kindLifecycle: true,
        async rollbackUnboundKindCluster(reservation, lifecycleDeps) {
          calls.push({ name: "rollbackUnboundKind", details: reservation });
          const cleanupError = cleanupFailures.get("rollbackUnboundKind");
          if (cleanupError) throw cleanupError;
          assert.equal(lifecycleDeps, undefined);
          return { action: "rolled-back", clusterName: reservation.clusterName, resourceDeleted: false };
        },
      };
    },
    createAvdLifecycleDeps: (config, lowLevel) => {
      called("avdLifecycleDeps", { config, lowLevel });
      assert.equal(lowLevel.processRegistry, processRegistry);
      assert.deepEqual(lowLevel.toolEnvironment, {
        PATH: "/usr/bin:/bin",
        JAVA_HOME: "/opt/java",
      });
      return {
        avdLifecycle: true,
        async recordCreatedAvd(reservation) {
          calls.push({ name: "recordAvdCreation", details: reservation });
          recordedAvdCreation = true;
          return avdCreationProof;
        },
        async rollbackUnboundAvd(reservation, options) {
          calls.push({ name: "rollbackUnboundAvd", details: { reservation, options } });
          assert.deepEqual(
            options,
            recordedAvdCreation ? { creationProof: avdCreationProof } : {},
          );
          const cleanupError = cleanupFailures.get("rollbackUnboundAvd");
          if (cleanupError) throw cleanupError;
          return { action: "rolled-back", avdName: reservation.avdName, resourceDeleted: true };
        },
      };
    },
    doctorAndroid: async (config) => {
      called("doctor", config);
      return doctor;
    },
    verifyAndroidApkGate: async (options) => {
      called("apkGate", options);
      return { capture: { android: { apk } } };
    },
    reserveKindClusterOwnership: async (input) => {
      called("reserveKind", input);
      return kindReservation;
    },
    beginKindClusterCreation: async (reservation) => {
      called("beginKindCreate", reservation);
      return kindCreationTransaction;
    },
    completeKindClusterCreation: async (reservation, lifecycleDeps) => {
      called("completeKindCreate", reservation);
      assert.equal(lifecycleDeps.creationTransaction, kindCreationTransaction);
      assert.deepEqual(lifecycleDeps.createdContainerIdentities, ["a".repeat(64)]);
      return kindCreationTransaction;
    },
    runKindMakePlan: async (plan, lifecycle = {}) => {
      called(plan.args[0] === "kind-up" ? "kindUp" : "kindDown", plan);
      if (plan.args[0] === "kind-up") {
        if (failAt === "kindUpAfterCreation" || failAt === "kindUpAfterAmbiguousCreation") {
          Object.defineProperty(primaryError, "kindCreationEvidence", {
            enumerable: false,
            value: Object.freeze({
              containerIdentities: Object.freeze(failAt === "kindUpAfterCreation"
                ? ["a".repeat(64)]
                : ["a".repeat(64), "b".repeat(64)]),
            }),
          });
          throw primaryError;
        }
        return {
          ok: true,
          creationWitness: await lifecycle.completeKindCreation({
            containerIdentities: ["a".repeat(64)],
          }),
        };
      }
      return { ok: true };
    },
    bindKindCluster: async (reservation, lifecycleDeps) => {
      assert.equal(lifecycleDeps.creationTransaction, kindCreationTransaction);
      if (failAt === "bindKindAfterCommit") {
        calls.push({ name: "bindKind", details: reservation });
        Object.defineProperty(primaryError, "recoveredBoundOwnership", {
          enumerable: false,
          value: boundKind,
        });
        throw primaryError;
      }
      if (failAt === "bindKindIndeterminate") {
        calls.push({ name: "bindKind", details: reservation });
        Object.defineProperty(primaryError, "bindOwnershipIndeterminate", {
          enumerable: false,
          value: true,
        });
        throw primaryError;
      }
      called("bindKind", reservation);
      return boundKind;
    },
    assertOwnedKindClusterReady: async (ownership) => {
      called("readyKind", ownership);
      return boundKind;
    },
    verifyOwnedKindAcpEndpoint: async (ownership) => {
      called("verifyOwnedAcpEndpoint", ownership);
      return { hostPort: 42101 };
    },
    reserveAvdOwnership: async (input) => {
      called("reserveAvd", input);
      return avdReservation;
    },
    createOwnedAvd: async (ownership, options) => {
      called("createAvd", { ownership, options });
    },
    createOwnedEmulatorLaunchPlan: (ownership, options) => {
      called("emulatorPlan", { ownership, options });
      return {
        executable: "/tools/emulator",
        args: [
          "-avd", ownership.avdName, "-no-snapshot-save", "-no-audio",
          "-no-boot-anim", "-vsync-rate", "30",
        ],
        avdName: ownership.avdName,
      };
    },
    launchOwnedEmulator: async (plan) => {
      called("launchEmulator", plan);
      return binding;
    },
    rollbackOwnedEmulator: async (actualBinding) => {
      called("rollbackEmulator", actualBinding);
      assert.deepEqual(actualBinding, {
        avdName: avdReservation.avdName,
        ...binding,
      });
      const cleanupError = cleanupFailures.get("rollbackEmulator");
      if (cleanupError) throw cleanupError;
    },
    bindAvdProcess: async (ownership, actualBinding) => {
      if (failAt === "bindAvdAfterCommit") {
        calls.push({ name: "bindAvd", details: { ownership, binding: actualBinding } });
        Object.defineProperty(primaryError, "recoveredBoundOwnership", {
          enumerable: false,
          value: boundAvd,
        });
        throw primaryError;
      }
      if (failAt === "bindAvdIndeterminate") {
        calls.push({ name: "bindAvd", details: { ownership, binding: actualBinding } });
        Object.defineProperty(primaryError, "bindOwnershipIndeterminate", {
          enumerable: false,
          value: true,
        });
        throw primaryError;
      }
      called("bindAvd", { ownership, binding: actualBinding });
      return boundAvd;
    },
    waitForOwnedAvdBoot: async (ownership) => {
      called("waitBoot", ownership);
      return { ready: true };
    },
    assertOwnedAvdReady: async (ownership) => {
      called("readyAvd", ownership);
      return readyAvdResult ?? boundAvd;
    },
    establishOwnedAcpReverse: async (input) => {
      called("establishAcpReverse", input);
      return {
        serial: binding.serial,
        devicePort: input.devicePort,
        hostPort: input.hostPort,
        acpUrl: `http://127.0.0.1:${input.devicePort}`,
      };
    },
    removeOwnedAcpReverse: async (reverse, options) => {
      called("removeAcpReverse", { reverse, options });
      const cleanupError = cleanupFailures.get("removeAcpReverse");
      if (cleanupError) throw cleanupError;
      return { action: "deleted", devicePort: reverse.devicePort };
    },
    disableAndroidPointerOverlays: async (options) => {
      called("disablePointerOverlays", options);
      return { disabled: true };
    },
    verifyAndroidDisplayGeometry: async (options) => {
      called("verifyDisplayGeometry", options);
      const geometry = displayGeometries?.[
        Math.min(displayGeometryIndex, displayGeometries.length - 1)
      ] ?? displayGeometry;
      displayGeometryIndex += 1;
      return geometry;
    },
    installVerifiedAndroidApk: async (options) => {
      called("installApk", options);
      return { installed: true };
    },
    verifyInstalledAndroidApp: async (options) => {
      called("verifyInstalled", options);
      return {
        applicationId: apk.applicationId,
        versionName: apk.versionName,
        versionCode: apk.versionCode,
      };
    },
    launchAndroidApplication: async (options) => {
      called("launchApp", options);
      return { launched: true };
    },
    createAndroidDriver: (options) => {
      called("createDriver", options);
      return driver;
    },
    executeAndroidActions: async (actions, options) => {
      called(options.phase === "pre-recording" ? "setupActions" : "recordedActions", {
        actions,
        options: { ...options, environment: options.environment ? "<private>" : undefined },
      });
      assert.equal(options.driver, driver);
      if (options.phase === "pre-recording") {
        const { ACP_URL, ...configured } = options.environment;
        assert.match(ACP_URL, /^http:\/\/127\.0\.0\.1:\d+$/u);
        assert.deepEqual(configured, deps.environment);
      } else {
        assert.equal(Object.hasOwn(options, "environment"), false);
      }
      if (options.phase === "recording") {
        options.recordPointer({
          type: "tap",
          monotonicSeconds: (clock + 100) / 1_000,
          x: 99,
          y: 199,
        });
        clock += 1_000;
      }
      return options.phase === "recording" && recordedActionsResult
        ? recordedActionsResult
        : { phase: options.phase, completedActions: actions.map(({ action }) => action), count: actions.length };
    },
    auditAndroidSetupUiForSecrets: async ({ driver: actualDriver, environment }) => {
      assert.equal(actualDriver, driver);
      const { ACP_URL, ...configured } = environment;
      assert.match(ACP_URL, /^http:\/\/127\.0\.0\.1:\d+$/u);
      assert.deepEqual(configured, deps.environment);
      called("auditSetupUi", { driver: "<opaque>", environment: "<private>" });
    },
    createAdbScreenrecordStage: async (options) => {
      called("recordingStage", options);
      return Object.freeze({
        stagingDir: "/output/.capture-stage",
        rawOutputPath: "/output/.capture-stage/screenrecord.h264",
        stagedOutputPath: "/output/.capture-stage/screenrecord.mp4",
      });
    },
    cleanupAdbScreenrecordStage: async ({ stage }) => {
      called("cleanupRecordingStage", stage);
      return { removed: true };
    },
    createAdbScreenrecordPlan: (options) => {
      called("recordingPlan", options);
      return recordingPlan;
    },
    createAndroidPointerRecorder: (options) => {
      called("pointerRecorder", options);
      return {
        record(event) {
          pointerEvents.push({
            type: "click",
            time: event.monotonicSeconds - options.startMonotonicSeconds,
            x: (event.x + 0.5) / options.displayGeometry.recording.width,
            y: (event.y + 0.5) / options.displayGeometry.recording.height,
          });
        },
        snapshot() { return [...pointerEvents]; },
      };
    },
    startAndroidScreenrecord: async (step) => {
      if (failAt === "startRecordingExitUnproved") {
        calls.push({ name: "startRecording", details: step });
        Object.defineProperty(primaryError, "recorderExitUnproved", {
          configurable: false,
          enumerable: false,
          value: true,
          writable: false,
        });
        throw primaryError;
      }
      called("startRecording", step);
      return { pid: 5252, mediaStartMonotonicMilliseconds: clock };
    },
    stopAndroidScreenrecord: async (handle) => {
      called("stopRecording", handle);
    },
    remuxAndroidScreenrecord: async (step) => {
      called("remuxRecording", step);
    },
    probeAndroidRecording: async (options) => {
      called("probeRecording", options);
      return {
        streams: [{
          codec_type: "video",
          codec_name: "h264",
          nb_read_frames: "150",
          width: 1080,
          height: 1920,
          avg_frame_rate: "30/1",
          r_frame_rate: "30/1",
        }],
        format: { duration: "5" },
      };
    },
    validateStagedAdbScreenrecordOutput: async (options) => {
      called("validateStagedRecording", options);
      await options.probeFile(options.expectedOutputPath);
      return {
        ok: true,
        outputPath: "/output/.capture-stage/screenrecord.mp4",
        sizeBytes: 123_456,
        sha256: "d".repeat(64),
        durationSeconds: 5,
        width: 1080,
        height: 1920,
        frameRate: 30,
        frameCount: 150,
        videoStreams: 1,
        audioStreams: 0,
      };
    },
    publishAdbScreenrecordOutput: async (options) => {
      called("publishRecording", options);
      return {
        outputPath: "/output/raw/android.mp4",
        stagedOutputPath: "/output/.capture-stage/screenrecord.mp4",
        sizeBytes: 123_456,
        sha256: "d".repeat(64),
      };
    },
    writeAndroidPointerEvents: async (options) => {
      called("writePointerEvents", options);
      assert.equal(JSON.stringify(options).includes(SECRET), false);
      return { path: options.outputPath, sha256: "e".repeat(64) };
    },
    copyAndroidApkLockEvidence: async (options) => {
      called("copyApkLock", options);
      assert.equal(JSON.stringify(options).includes(SECRET), false);
      return { path: options.outputPath, sha256: apk.lock.sha256 };
    },
    publishAndroidCaptureBundle: async (options) => {
      called("publishBundle", {
        outputDir: options.outputDir,
        recordingDestinationPath: options.recordingDestinationPath,
        pointerDestinationPath: options.pointerDestinationPath,
        lockDestinationPath: options.lockDestinationPath,
      });
      const publishedRecording = await options.publishRecording({
        witnessPath: "/output/.android-capture-publication/witness/raw/android.mp4",
      });
      const pointerArtifact = await options.publishPointerEvents({
        witnessPath: "/output/.android-capture-publication/witness/pointer-events.jsonl",
      });
      const lockArtifact = await options.publishApkLock({
        witnessPath: "/output/.android-capture-publication/witness/raw/android-apk-lock.json",
      });
      return {
        publishedRecording: {
          ...publishedRecording,
          outputPath: publishedRecording.outputPath === "/output/.capture-stage/screenrecord.mp4"
            || publishedRecording.outputPath === "/output/raw/android.mp4"
            ? options.recordingDestinationPath
            : publishedRecording.outputPath,
        },
        pointerArtifact: {
          ...pointerArtifact,
          path: pointerArtifact.path.includes(".android-capture-publication")
            ? options.pointerDestinationPath
            : pointerArtifact.path,
        },
        lockArtifact: {
          ...lockArtifact,
          path: lockArtifact.path.includes(".android-capture-publication")
            ? options.lockDestinationPath
            : lockArtifact.path,
        },
      };
    },
    nowMilliseconds: () => clock,
    sleep: async (milliseconds) => {
      called("hold", milliseconds);
      clock += milliseconds;
    },
    teardownOwnedAvd: async (ownership) => {
      called("teardownAvd", ownership);
      const cleanupError = cleanupFailures.get("teardownAvd");
      if (cleanupError) throw cleanupError;
      return { action: "deleted", avdName: ownership.avdName, serial: ownership.serial };
    },
    teardownOwnedKindCluster: async (ownership, lifecycleDeps) => {
      called("teardownKind", ownership);
      const cleanupError = cleanupFailures.get("teardownKind");
      if (cleanupError) throw cleanupError;
      await lifecycleDeps.deleteKindCluster({
        clusterName: ownership.clusterName,
        kubeContext: ownership.kubeContext,
        kubeServer: ownership.kubeServer,
        containerIdentities: [...ownership.containerIdentities],
      });
      return { action: "deleted", clusterName: ownership.clusterName };
    },
  };

  if (cleanupFailures.has("stopRecording")) {
    deps.stopAndroidScreenrecord = async (handle) => {
      calls.push({ name: "stopRecording", details: handle });
      throw cleanupFailures.get("stopRecording");
    };
  }

  return {
    calls,
    deps,
    primaryError,
    apk,
    kindReservation,
    avdReservation,
    boundAvd,
    avdCreationProof,
  };
}

test("preserves the exact bound AVD ownership token when readiness returns a verification snapshot", async () => {
  const harness = createHarness({
    readyAvdResult: Object.freeze({
      marker: Object.freeze({ proof: "private-marker" }),
      avd: Object.freeze({ proof: "private-avd" }),
      emulator: Object.freeze({ ready: true }),
    }),
  });

  await captureAndroid(captureConfig(), harness.deps);

  const reverse = harness.calls.find(({ name }) => name === "establishAcpReverse");
  assert.equal(reverse.details.serial, harness.boundAvd.serial);
  const teardown = harness.calls.find(({ name }) => name === "teardownAvd");
  assert.deepEqual(teardown.details, harness.boundAvd);
});

test("reverifies exact bound AVD ownership immediately before every orchestrated ADB mutation", async () => {
  const harness = createHarness();
  await captureAndroid(captureConfig(), harness.deps);

  const names = harness.calls.map(({ name }) => name);
  for (const mutation of [
    "establishAcpReverse",
    "disablePointerOverlays",
    "installApk",
    "launchApp",
    "setupActions",
    "startRecording",
    "recordedActions",
    "removeAcpReverse",
  ]) {
    const index = names.indexOf(mutation);
    assert.ok(index > 0, `${mutation} must execute`);
    assert.equal(names[index - 1], "readyAvd", `${mutation} must have an immediate ownership gate`);
    assert.deepEqual(harness.calls[index - 1].details, harness.boundAvd);
  }
});

test("orchestrates exact owned Android capture order and returns only portable capture identity", async () => {
  const harness = createHarness();
  const result = await captureAndroid(captureConfig(), harness.deps);

  assert.deepEqual(harness.calls.map(({ name }) => name), [
    "doctor", "apkGate", "prepareDirectories", "prepareKindWorkspace", "processRegistry", "kindLifecycleDeps", "avdLifecycleDeps",
    "reserveKind", "beginKindCreate", "kindUp", "completeKindCreate", "bindKind", "readyKind", "verifyOwnedAcpEndpoint",
    "reserveAvd", "createAvd", "recordAvdCreation", "emulatorPlan", "launchEmulator", "bindAvd",
    "waitBoot", "readyAvd", "verifyDisplayGeometry", "readyAvd", "establishAcpReverse",
    "readyAvd", "disablePointerOverlays", "readyAvd", "installApk", "verifyInstalled",
    "readyAvd", "launchApp", "createDriver", "readyAvd", "setupActions", "auditSetupUi",
    "recordingStage", "recordingPlan", "readyAvd", "verifyDisplayGeometry", "readyAvd", "startRecording",
    "pointerRecorder", "readyAvd", "recordedActions", "hold", "stopRecording",
    "readyAvd", "verifyDisplayGeometry", "remuxRecording", "validateStagedRecording", "probeRecording", "publishBundle",
    "publishRecording", "writePointerEvents", "copyApkLock",
    "cleanupRecordingStage", "readyAvd", "removeAcpReverse", "teardownAvd", "teardownKind", "kindDown",
  ]);

  const kindUp = harness.calls.find(({ name }) => name === "kindUp").details;
  const kindDown = harness.calls.find(({ name }) => name === "kindDown").details;
  for (const [plan, target] of [[kindUp, "kind-up"], [kindDown, "kind-down"]]) {
    assert.equal(plan.executable, "/tools/make");
    assert.deepEqual(plan.args, [target]);
    assert.equal(plan.cwd, "/private/run-123/kind-workspace");
    assert.equal(plan.environment.KIND_CLUSTER_NAME, harness.kindReservation.clusterName);
    assert.equal(plan.environment.CONTAINER_ENGINE, "docker");
    assert.equal(plan.environment.DOCKER_ONLY_KIND_CLUSTER, "true");
    assert.equal(plan.environment.KUBECONFIG, "/private/run-123/kubeconfig");
    assert.equal(plan.environment.REQUIRE_NEW_KIND_CLUSTER, "true");
    assert.equal(plan.environment.HOME, "/private/run-123/home");
    assert.equal(plan.environment.KIND_PF_ROOT, "/private/run-123/kind-state");
    assert.equal(
      plan.environment.KIND_CREATION_PROOF_FILE,
      "/private/run-123/kind-state/creation-container-ids",
    );
  }
  assert.equal(kindUp.environment.EXPECTED_KIND_CONTAINER_IDS, "");
  assert.equal(kindDown.environment.EXPECTED_KIND_CONTAINER_IDS, "a".repeat(64));
  assert.equal(
    harness.calls.findIndex(({ name }) => name === "readyAvd") + 1,
    harness.calls.findIndex(({ name }) => name === "verifyDisplayGeometry"),
    "owned AVD readiness must be checked immediately before the first adb mutation",
  );
  assert.deepEqual(
    harness.calls.find(({ name }) => name === "disablePointerOverlays").details,
    { serial: "emulator-5580", adbPath: "/tools/adb" },
  );
  assert.ok(
    harness.calls.findIndex(({ name }) => name === "disablePointerOverlays")
      < harness.calls.findIndex(({ name }) => name === "setupActions"),
    "pointer overlays must be disabled before secret setup",
  );
  assert.ok(
    harness.calls.findIndex(({ name }) => name === "disablePointerOverlays")
      < harness.calls.findIndex(({ name }) => name === "startRecording"),
    "pointer overlays must be disabled before recording",
  );
  const launchPlan = harness.calls.find(({ name }) => name === "launchEmulator").details;
  assert.deepEqual(launchPlan.args.slice(-2), ["-vsync-rate", "30"]);
  const recordStep = harness.calls.find(({ name }) => name === "startRecording").details;
  assert.equal(recordStep.args.includes("--fps"), false);
  assert.equal(recordStep.args.includes("--audio"), false);
  assert.deepEqual(
    harness.calls.find(({ name }) => name === "recordingStage").details,
    { stagingParent: "/output" },
  );
  assert.equal(
    harness.calls.find(({ name }) => name === "remuxRecording").details.args.at(-1),
    "/output/.capture-stage/screenrecord.mp4",
  );
  assert.equal(
    harness.calls.find(({ name }) => name === "recordingPlan").details.expectedDurationSeconds,
    5,
  );
  assert.equal(
    harness.calls.find(({ name }) => name === "recordingPlan").details.minimumDurationSeconds,
    5 - (1 / 30),
  );
  assert.equal(
    harness.calls.find(({ name }) => name === "recordingPlan").details.maxDurationSeconds,
    5 + (1 / 30),
  );
  assert.equal(
    harness.calls.find(({ name }) => name === "pointerRecorder").details.displayGeometry.rotation,
    0,
  );
  assert.equal(
    harness.calls.find(({ name }) => name === "startRecording").details.rawOutputPath,
    "/output/.capture-stage/screenrecord.h264",
  );

  assert.deepEqual(result, {
    source: {
      type: "mobile",
      width: 1080,
      height: 1920,
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
        applicationId: "dev.example.mobile",
        versionName: "1.2.3",
        versionCode: "123",
        frameRate: 30,
        silent: true,
        durationSeconds: 5,
        actionCount: 3,
        pointerEventCount: 1,
        mediaValidated: true,
      },
    },
    android: {
      apk: harness.apk,
      systemImage: {
        package: harness.boundAvd.systemImage,
        revision: "14.0",
      },
      toolchain: Object.fromEntries([
        "adb", "emulator", "avdmanager", "apkanalyzer", "kind", "kubectl",
        "docker", "git", "ffmpeg", "ffprobe", "make",
      ].map((name) => [name, {
        identity: `${name}-identity`,
        ...(name === "apkanalyzer" ? { version: "cmdline-tools 19.0" } : {}),
      }])),
    },
    artifacts: {
      mobileCapture: { path: "/output/raw/android.mp4", sha256: "d".repeat(64) },
      pointerEvents: { path: "/output/pointer-events.jsonl", sha256: "e".repeat(64) },
      androidApkLock: {
        path: "/output/raw/android-apk-lock.json",
        sha256: "b".repeat(64),
      },
    },
    lifecycle: {
      cluster: { status: "deleted", ownershipVerified: true },
      avd: { status: "deleted", ownershipVerified: true },
      acpReverse: { status: "deleted", ownershipVerified: true },
    },
  });
  assert.equal(JSON.stringify(result).includes("/private/"), false);
  assert.equal(JSON.stringify(result).includes(SECRET), false);
  assert.equal(JSON.stringify(result.source.validationEvidence).includes("/output/"), false);
  for (const artifact of Object.values(result.artifacts)) {
    assert.ok(artifact.path.startsWith("/output/"));
  }

  const setupCall = harness.calls.find(({ name }) => name === "setupActions").details;
  assert.equal(setupCall.options.phase, "pre-recording");
  assert.equal(setupCall.options.environment, "<private>");
  assert.ok(
    harness.calls.findIndex(({ name }) => name === "setupActions")
      < harness.calls.findIndex(({ name }) => name === "auditSetupUi"),
  );
  assert.ok(
    harness.calls.findIndex(({ name }) => name === "auditSetupUi")
      < harness.calls.findIndex(({ name }) => name === "startRecording"),
  );
  const recordedCall = harness.calls.find(({ name }) => name === "recordedActions").details;
  assert.equal(recordedCall.options.phase, "recording");
  assert.equal(recordedCall.options.deadlineMilliseconds, 15_000);
  assert.equal(harness.calls.find(({ name }) => name === "hold").details, 4_000);
});

test("locks fresh portrait geometry immediately before recording and reproves it after capture", async () => {
  const stableGeometry = Object.freeze({
    physical: Object.freeze({ width: 1080, height: 2400 }),
    recording: Object.freeze({ width: 1080, height: 1920 }),
    rotation: 0,
  });
  const changedGeometry = Object.freeze({
    physical: Object.freeze({ width: 1080, height: 2400 }),
    recording: Object.freeze({ width: 1080, height: 1800 }),
    rotation: 0,
  });
  const harness = createHarness({
    displayGeometries: [stableGeometry, stableGeometry, changedGeometry],
  });

  await assert.rejects(
    captureAndroid(captureConfig(), harness.deps),
    /display geometry changed during capture/i,
  );
  const names = harness.calls.map(({ name }) => name);
  const start = names.indexOf("startRecording");
  assert.deepEqual(names.slice(start - 2, start + 1), [
    "verifyDisplayGeometry", "readyAvd", "startRecording",
  ]);
  assert.equal(names.filter((name) => name === "verifyDisplayGeometry").length, 3);
  assert.ok(names.lastIndexOf("verifyDisplayGeometry") > names.indexOf("stopRecording"));
  assert.equal(names.includes("publishBundle"), false);
});

test("rolls back a reserved Kind marker when preflight fails before network allocation", async () => {
  const harness = createHarness({ failAt: "beginKindCreate" });

  await assert.rejects(captureAndroid(captureConfig(), harness.deps), (error) => {
    assert.equal(error, harness.primaryError);
    assert.equal(error.ownedCleanupCompleted, true);
    return true;
  });
  const names = harness.calls.map(({ name }) => name);
  assert.deepEqual(names.slice(-3), ["reserveKind", "beginKindCreate", "rollbackUnboundKind"]);
  assert.equal(names.includes("kindDown"), false);
});

test("rejects unproved or unbounded installed system-image identity before device mutation", async () => {
  const expectedPackage = captureConfig().capture.android.systemImage;
  for (const doctorSystemImage of [
    { package: expectedPackage, revision: "14", installed: false },
    { package: "system-images;android-36;google_apis;arm64-v8a", revision: "14", installed: true },
    { package: expectedPackage, revision: "1234567", installed: true },
    { package: expectedPackage, revision: "1.2.3.4.5", installed: true },
  ]) {
    const harness = createHarness({ doctorSystemImage });
    await assert.rejects(
      captureAndroid(captureConfig(), harness.deps),
      /did not prove the exact installed system-image package and revision/,
    );
    assert.deepEqual(harness.calls.map(({ name }) => name), ["doctor"]);
  }
});

test("refuses to publish landmarks when execution results do not prove the authored action sequence", async () => {
  const harness = createHarness({
    recordedActionsResult: {
      phase: "recording",
      completedActions: ["expect", "tap", "back"],
      count: 3,
    },
  });
  await assert.rejects(
    captureAndroid(captureConfig(), harness.deps),
    /recorded Android action results do not prove the authored sequence completed/,
  );
  assert.equal(harness.calls.some(({ name }) => name === "publishBundle"), false);
  assert.ok(harness.calls.some(({ name }) => name === "teardownAvd"));
  assert.ok(harness.calls.some(({ name }) => name === "teardownKind"));
});

test("refuses an authored action budget at the duration boundary before external operations", async () => {
  const harness = createHarness();
  const config = captureConfig({ authoredDurationMs: 900 });
  await assert.rejects(
    captureAndroid(config, harness.deps),
    /recorded Android actions require less than the authored duration/i,
  );
  assert.deepEqual(harness.calls, []);
});

test("caps authored mobile capture at 179 seconds for recorder shutdown headroom", async () => {
  const accepted = await captureAndroid(captureConfig({
    authoredDurationMs: 179_000,
    dryRun: true,
  }));
  assert.equal(accepted.dryRun, true);
  await assert.rejects(
    captureAndroid(captureConfig({ authoredDurationMs: 179_001, dryRun: true })),
    /1 through 179000/,
  );
});

test("dry-run returns a bounded no-mutation plan without resolving tools or resources", async () => {
  const result = await captureAndroid(captureConfig({ dryRun: true }));
  assert.deepEqual(result, {
    dryRun: true,
    source: {
      type: "mobile",
      width: 1080,
      height: 1920,
      landmarks: [],
      validationEvidence: {
        plannedActionCount: 3,
        plannedSetupActionCount: 3,
        frameRate: 30,
        silent: true,
      },
    },
    artifacts: {},
    plan: {
      tools: [
        "adb", "emulator", "sdkmanager", "avdmanager", "apkanalyzer", "kind",
        "kubectl", "docker", "git", "ffmpeg", "ffprobe", "make",
      ],
      kindTargets: ["kind-up", "kind-down"],
      emulator: { vsyncRate: 30, audio: false },
      recording: { durationSeconds: 6, frameRate: 30, audio: false },
    },
  });
  assert.equal(JSON.stringify(result).includes("run-123"), false);
});

test("fills every live operation from the concrete default factory before applying overrides", async () => {
  const harness = createHarness();
  const operationNames = [
    "copyAndroidApkLockEvidence",
    "createAndroidDriver",
    "createOwnedAvd",
    "disableAndroidPointerOverlays",
    "establishOwnedAcpReverse",
    "installVerifiedAndroidApk",
    "launchAndroidApplication",
    "launchOwnedEmulator",
    "probeAndroidRecording",
    "remuxAndroidScreenrecord",
    "rollbackOwnedEmulator",
    "removeOwnedAcpReverse",
    "runKindMakePlan",
    "startAndroidScreenrecord",
    "stopAndroidScreenrecord",
    "verifyInstalledAndroidApp",
    "waitForOwnedAvdBoot",
    "writeAndroidPointerEvents",
  ];
  const concrete = Object.fromEntries(operationNames.map((name) => [name, harness.deps[name]]));
  for (const name of operationNames) delete harness.deps[name];
  let factoryCalls = 0;
  harness.deps.createDefaultOperations = (options) => {
    factoryCalls += 1;
    assert.equal(Object.hasOwn(options, "environment"), false);
    assert.deepEqual(options.toolEnvironment, {
      PATH: "/usr/bin:/bin",
      JAVA_HOME: "/opt/java",
    });
    assert.equal(JSON.stringify(options).includes(SECRET), false);
    assert.equal(options.avdRoot, "/private/avds");
    assert.ok(options.processRegistry?.emulators instanceof Map);
    assert.ok(options.processRegistry?.recorders instanceof Map);
    return concrete;
  };

  const result = await captureAndroid(captureConfig(), harness.deps);
  assert.equal(factoryCalls, 1);
  assert.equal(result.lifecycle.avd.status, "deleted");
  assert.equal(result.lifecycle.cluster.status, "deleted");
});

test("rejects authored cluster or emulator identity instead of touching it", async () => {
  const cases = [
    (config) => { config.capture.clusterName = "shared-cluster"; },
    (config) => { config.capture.cluster.name = "shared-cluster"; },
    (config) => { config.capture.android.avdName = "personal-avd"; },
  ];
  for (const mutate of cases) {
    const harness = createHarness();
    const config = captureConfig();
    mutate(config);
    await assert.rejects(captureAndroid(config, harness.deps), /authored resource identity/i);
    assert.deepEqual(harness.calls, []);
  }
});

test("refuses publisher results not bound to the exact output files and verified digests", async () => {
  const cases = [
    ["mobile capture path", (deps) => {
      deps.publishAdbScreenrecordOutput = async () => ({
        outputPath: "/tmp/foreign.mp4",
        sha256: "d".repeat(64),
      });
    }],
    ["pointer events path", (deps) => {
      deps.writeAndroidPointerEvents = async () => ({
        path: "/tmp/foreign.jsonl",
        sha256: "e".repeat(64),
      });
    }],
    ["APK lock digest", (deps) => {
      deps.copyAndroidApkLockEvidence = async (options) => ({
        path: options.outputPath,
        sha256: "f".repeat(64),
      });
    }],
  ];

  for (const [label, override] of cases) {
    const harness = createHarness();
    override(harness.deps);
    await assert.rejects(
      captureAndroid(captureConfig(), harness.deps),
      new RegExp(`exact ${label}`, "i"),
    );
  }
});

test("refuses a screenrecord plan that changes the owned serial, raw path, or duration window", async () => {
  const cases = [
    (plan) => { plan.record.args[1] = "emulator-5554"; },
    (plan) => { plan.remux.rawOutputPath = "/tmp/foreign.h264"; },
    (plan) => { plan.validation.minimumDurationSeconds = 1; },
    (plan) => { plan.validation.maxDurationSeconds = 180; },
  ];

  for (const mutate of cases) {
    const harness = createHarness();
    const createPlan = harness.deps.createAdbScreenrecordPlan;
    harness.deps.createAdbScreenrecordPlan = (options) => {
      const plan = structuredClone(createPlan(options));
      mutate(plan);
      return plan;
    };
    await assert.rejects(
      captureAndroid(captureConfig(), harness.deps),
      /screenrecord plan/i,
    );
  }
});

test("cleans only acquired owned resources in reverse order after staged failures", async () => {
  const cases = [
    ["kindUp", ["reserveKind", "beginKindCreate", "kindUp", "rollbackUnboundKind"]],
    ["bindKind", ["reserveKind", "beginKindCreate", "kindUp", "completeKindCreate", "bindKind", "rollbackUnboundKind"]],
    ["reserveAvd", ["readyKind", "reserveAvd", "teardownKind", "kindDown"]],
    ["createAvd", ["reserveAvd", "createAvd", "rollbackUnboundAvd", "teardownKind", "kindDown"]],
    ["launchEmulator", ["emulatorPlan", "launchEmulator", "rollbackUnboundAvd", "teardownKind", "kindDown"]],
    ["bindAvd", ["launchEmulator", "bindAvd", "rollbackEmulator", "rollbackUnboundAvd", "teardownKind", "kindDown"]],
    ["waitBoot", ["reserveAvd", "createAvd", "emulatorPlan", "launchEmulator", "bindAvd", "waitBoot", "teardownAvd", "teardownKind", "kindDown"]],
    ["disablePointerOverlays", ["readyAvd", "disablePointerOverlays", "teardownAvd", "teardownKind", "kindDown"]],
    ["installApk", ["readyAvd", "installApk", "teardownAvd", "teardownKind", "kindDown"]],
    ["setupActions", ["setupActions", "teardownAvd", "teardownKind", "kindDown"]],
    ["auditSetupUi", ["setupActions", "auditSetupUi", "teardownAvd", "teardownKind", "kindDown"]],
    ["startRecording", ["recordingPlan", "startRecording", "teardownAvd", "teardownKind", "kindDown"]],
    ["recordedActions", ["startRecording", "pointerRecorder", "recordedActions", "stopRecording", "teardownAvd", "teardownKind", "kindDown"]],
    ["remuxRecording", ["stopRecording", "remuxRecording", "teardownAvd", "teardownKind", "kindDown"]],
    ["validateStagedRecording", ["stopRecording", "remuxRecording", "validateStagedRecording", "teardownAvd", "teardownKind", "kindDown"]],
  ];

  for (const [failAt, requiredSubsequence] of cases) {
    const harness = createHarness({ failAt });
    await assert.rejects(captureAndroid(captureConfig(), harness.deps), (error) => {
      assert.equal(error, harness.primaryError);
      assert.equal(error.ownedCleanupCompleted, true);
      assert.equal(Object.keys(error).includes("ownedCleanupCompleted"), false);
      return true;
    });
    const names = harness.calls.map(({ name }) => name);
    let cursor = -1;
    for (const name of requiredSubsequence) {
      cursor = names.indexOf(name, cursor + 1);
      assert.notEqual(cursor, -1, `${failAt} must include ${requiredSubsequence.join(" -> ")}`);
    }
    if (names.includes("teardownAvd")) {
      assert.ok(names.indexOf("teardownAvd") < names.indexOf("teardownKind"));
    }
    if (names.includes("rollbackUnboundAvd")) {
      assert.ok(names.indexOf("rollbackUnboundAvd") < names.indexOf("teardownKind"));
      assert.equal(names.includes("teardownAvd"), false, failAt);
    }
    if (names.includes("rollbackUnboundKind")) {
      assert.equal(names.includes("teardownKind"), false);
      assert.equal(names.includes("kindDown"), false);
    }
  }
});

test("recovers exact Kind ownership after deployment fails following proven creation", async () => {
  const harness = createHarness({ failAt: "kindUpAfterCreation" });

  await assert.rejects(captureAndroid(captureConfig(), harness.deps), (error) => {
    assert.equal(error, harness.primaryError);
    assert.equal(error.ownedCleanupCompleted, true);
    assert.equal(error.cleanupDiagnostics, undefined);
    assert.equal(Object.keys(error).includes("kindCreationEvidence"), false);
    return true;
  });
  assert.deepEqual(harness.calls.map(({ name }) => name).slice(-6), [
    "beginKindCreate",
    "kindUp",
    "completeKindCreate",
    "bindKind",
    "teardownKind",
    "kindDown",
  ]);
  const kindDown = harness.calls.find(({ name }) => name === "kindDown").details;
  assert.equal(kindDown.environment.EXPECTED_KIND_CONTAINER_IDS, "a".repeat(64));
  assert.equal(harness.calls.some(({ name }) => name === "rollbackUnboundKind"), false);
});

test("preserves Kind resources when failed creation evidence is ambiguous", async () => {
  const harness = createHarness({ failAt: "kindUpAfterAmbiguousCreation" });

  await assert.rejects(captureAndroid(captureConfig(), harness.deps), (error) => {
    assert.equal(error, harness.primaryError);
    assert.ok(error.cleanupDiagnostics.some(({ phase, message }) => (
      phase === "kind" && /preserving the resource and marker/i.test(message)
    )));
    assert.equal(error.ownedCleanupCompleted, undefined);
    return true;
  });
  const names = harness.calls.map(({ name }) => name);
  for (const forbidden of ["completeKindCreate", "bindKind", "rollbackUnboundKind", "teardownKind", "kindDown"]) {
    assert.equal(names.includes(forbidden), false, forbidden);
  }
});

test("preserves the primary error when recorder and lifecycle cleanup also fail", async () => {
  const cleanupFailures = new Map([
    ["stopRecording", new Error("recorder cleanup failed")],
    ["teardownAvd", new Error("AVD cleanup failed")],
    ["teardownKind", new Error("Kind cleanup failed")],
  ]);
  const harness = createHarness({ failAt: "recordedActions", cleanupFailures });

  await assert.rejects(captureAndroid(captureConfig(), harness.deps), (error) => {
    assert.equal(error, harness.primaryError);
    assert.deepEqual(error.cleanupDiagnostics, [
      { phase: "screenrecord", message: "recorder cleanup failed" },
      {
        phase: "screenrecord-stage",
        message: "Recorder exit was not proven; preserving its private staging files",
      },
      { phase: "avd", message: "AVD cleanup failed" },
      { phase: "kind", message: "Kind cleanup failed" },
    ]);
    return true;
  });
  const cleanupNames = harness.calls.map(({ name }) => name);
  const cleanupStop = cleanupNames.indexOf("stopRecording");
  assert.equal(cleanupNames[cleanupStop - 1], "recordedActions");
  let cleanupCursor = cleanupNames.indexOf("recordedActions");
  for (const name of [
    "stopRecording",
    "removeAcpReverse",
    "teardownAvd",
    "teardownKind",
  ]) {
    cleanupCursor = cleanupNames.indexOf(name, cleanupCursor + 1);
    assert.notEqual(cleanupCursor, -1, `cleanup must include ${name}`);
  }
});

test("preserves private recording staging when failed start cannot prove child exit", async () => {
  const harness = createHarness({ failAt: "startRecordingExitUnproved" });

  await assert.rejects(captureAndroid(captureConfig(), harness.deps), (error) => {
    assert.equal(error, harness.primaryError);
    assert.ok(error.cleanupDiagnostics.some(({ phase, message }) => (
      phase === "screenrecord-stage"
      && /exit was not proven.*preserving.*staging/i.test(message)
    )));
    return true;
  });
  assert.equal(
    harness.calls.some(({ name }) => name === "cleanupRecordingStage"),
    false,
  );
});

test("cleans private recording staging after a quiescent but unpublishable stop", async () => {
  const stopFailure = new Error("recorder status made media unpublishable");
  Object.defineProperty(stopFailure, "recorderQuiescenceProven", {
    configurable: false,
    enumerable: false,
    value: true,
    writable: false,
  });
  const harness = createHarness({
    cleanupFailures: new Map([["stopRecording", stopFailure]]),
  });

  await assert.rejects(captureAndroid(captureConfig(), harness.deps), (error) => {
    assert.equal(error, stopFailure);
    assert.equal(error.cleanupDiagnostics, undefined);
    return true;
  });
  assert.equal(
    harness.calls.filter(({ name }) => name === "stopRecording").length,
    1,
  );
  assert.equal(
    harness.calls.filter(({ name }) => name === "cleanupRecordingStage").length,
    1,
  );
});

test("preserves an exact-child rollback failure after lifecycle cleanup recovers", async () => {
  const harness = createHarness({
    failAt: "bindAvd",
    cleanupFailures: new Map([
      ["rollbackEmulator", new Error("exact emulator rollback failed")],
      ["rollbackUnboundAvd", new Error("exact unbound AVD rollback failed")],
    ]),
  });

  await assert.rejects(captureAndroid(captureConfig(), harness.deps), (error) => {
    assert.equal(error, harness.primaryError);
    assert.deepEqual(error.cleanupDiagnostics, [
      { phase: "emulator-launch", message: "exact emulator rollback failed" },
    ]);
    return true;
  });
  assert.ok(harness.calls.some(({ name }) => name === "teardownAvd"));
});

test("recovers when a bind persists its bound marker before throwing", async () => {
  const cases = [
    {
      failAt: "bindKindAfterCommit",
      expectedTail: ["kindUp", "completeKindCreate", "bindKind", "teardownKind", "kindDown"],
    },
    {
      failAt: "bindAvdAfterCommit",
      expectedTail: [
        "launchEmulator", "bindAvd", "teardownAvd", "teardownKind", "kindDown",
      ],
    },
  ];

  for (const { failAt, expectedTail } of cases) {
    const harness = createHarness({ failAt });
    await assert.rejects(captureAndroid(captureConfig(), harness.deps), (error) => {
      assert.equal(error, harness.primaryError);
      assert.equal(error.ownedCleanupCompleted, true);
      assert.equal(error.cleanupDiagnostics, undefined);
      return true;
    });
    assert.deepEqual(
      harness.calls.map(({ name }) => name).slice(-expectedTail.length),
      expectedTail,
    );
  }
});

test("preserves the primary acquisition error when unbound lifecycle rollback fails", async () => {
  const harness = createHarness({
    failAt: "createAvd",
    cleanupFailures: new Map([
      ["rollbackUnboundAvd", new Error("exact unbound AVD rollback failed")],
      ["teardownAvd", new Error("bound AVD teardown refused")],
    ]),
  });

  await assert.rejects(captureAndroid(captureConfig(), harness.deps), (error) => {
    assert.equal(error, harness.primaryError);
    assert.deepEqual(error.cleanupDiagnostics, [
      { phase: "avd", message: "Unable to verify bound or unbound AVD cleanup" },
    ]);
    return true;
  });
});

test("fails closed without destructive cleanup when bind ownership is indeterminate", async () => {
  const cases = [
    {
      failAt: "bindKindIndeterminate",
      phase: "kind",
      message: "Kind bind ownership is indeterminate; preserving the resource and marker",
      forbidden: ["rollbackUnboundKind", "teardownKind", "kindDown"],
    },
    {
      failAt: "bindAvdIndeterminate",
      phase: "avd",
      message: "AVD bind ownership is indeterminate; preserving the resource and marker",
      forbidden: ["rollbackEmulator", "rollbackUnboundAvd", "teardownAvd"],
    },
  ];

  for (const { failAt, phase, message, forbidden } of cases) {
    const harness = createHarness({ failAt });
    await assert.rejects(captureAndroid(captureConfig(), harness.deps), (error) => {
      assert.equal(error, harness.primaryError);
      assert.ok(error.cleanupDiagnostics.some((entry) => (
        entry.phase === phase && entry.message === message
      )));
      assert.equal(error.ownedCleanupCompleted, undefined);
      return true;
    });
    const names = harness.calls.map(({ name }) => name);
    for (const name of forbidden) assert.equal(names.includes(name), false, `${failAt}: ${name}`);
  }
});

test("reports reverse cleanup failure but still tears down the independently exact-owned AVD", async () => {
  const reverseFailure = new Error("exact reverse cleanup failed");
  const harness = createHarness({
    cleanupFailures: new Map([["removeAcpReverse", reverseFailure]]),
  });

  await assert.rejects(captureAndroid(captureConfig(), harness.deps), (error) => {
    assert.deepEqual(error.cleanupDiagnostics, [
      { phase: "acp-reverse", message: "exact reverse cleanup failed" },
    ]);
    return true;
  });
  const names = harness.calls.map(({ name }) => name);
  assert.ok(names.indexOf("teardownAvd") > names.indexOf("removeAcpReverse"));
  assert.ok(names.indexOf("teardownKind") > names.indexOf("teardownAvd"));
});

test("preserves AVD and skips later ADB cleanup when Android mutation quiescence is unproved", async () => {
  const harness = createHarness({ failAt: "recordedActions" });
  Object.defineProperty(harness.primaryError, "androidMutationQuiescenceUnproved", {
    configurable: false,
    enumerable: false,
    value: true,
    writable: false,
  });

  await assert.rejects(captureAndroid(captureConfig(), harness.deps), (error) => {
    assert.equal(error, harness.primaryError);
    assert.ok(error.cleanupDiagnostics.some(({ phase, message }) => (
      phase === "acp-reverse" && /quiescence.*unproved.*preserving/i.test(message)
    )));
    assert.ok(error.cleanupDiagnostics.some(({ phase, message }) => (
      phase === "avd" && /quiescence.*unproved.*preserving/i.test(message)
    )));
    assert.ok(error.cleanupDiagnostics.some(({ phase, message }) => (
      phase === "kind" && /quiescence.*unproved.*preserving/i.test(message)
    )));
    return true;
  });
  const names = harness.calls.map(({ name }) => name);
  assert.equal(names.includes("removeAcpReverse"), false);
  assert.equal(names.includes("teardownAvd"), false);
  assert.equal(names.includes("teardownKind"), false);
  assert.equal(names.includes("kindDown"), false);
});

test("preserves an unbound AVD when creation cleanup is explicitly unproved", async () => {
  const harness = createHarness({ failAt: "createAvd" });
  Object.defineProperty(harness.primaryError, "avdCreationCleanupBlocked", {
    configurable: false,
    enumerable: false,
    value: true,
    writable: false,
  });

  await assert.rejects(captureAndroid(captureConfig(), harness.deps), (error) => {
    assert.equal(error, harness.primaryError);
    assert.ok(error.cleanupDiagnostics.some(({ phase, message }) => (
      phase === "avd" && /preserving the resource and marker/i.test(message)
    )));
    return true;
  });
  const names = harness.calls.map(({ name }) => name);
  assert.equal(names.includes("rollbackUnboundAvd"), false);
  assert.equal(names.includes("teardownAvd"), false);
  assert.equal(names.includes("teardownKind"), true);
});

test("first SIGINT stops new capture phases and reaches bounded owned cleanup without handler leaks", async () => {
  const harness = createHarness();
  let signalHandler;
  let disposed = 0;
  harness.deps.registerInterruptHandlers = (handler) => {
    signalHandler = handler;
    return () => { disposed += 1; };
  };
  const executeActions = harness.deps.executeAndroidActions;
  harness.deps.executeAndroidActions = async (actions, options) => {
    const result = await executeActions(actions, options);
    if (options.phase === "recording") signalHandler("SIGINT");
    return result;
  };

  await assert.rejects(captureAndroid(captureConfig(), harness.deps), (error) => {
    assert.equal(error.name, "AndroidCaptureInterruptedError");
    assert.match(error.message, /SIGINT/);
    assert.equal(error.ownedCleanupCompleted, true);
    return true;
  });
  const names = harness.calls.map(({ name }) => name);
  assert.equal(names.includes("hold"), false);
  assert.equal(names.includes("remuxRecording"), false);
  assert.equal(names.includes("publishBundle"), false);
  for (const cleanup of ["stopRecording", "removeAcpReverse", "teardownAvd", "teardownKind", "kindDown"]) {
    assert.equal(names.includes(cleanup), true, cleanup);
  }
  assert.equal(disposed, 1);
});

test("SIGTERM during AVD creation records creation proof before unbound rollback", async () => {
  const harness = createHarness();
  let signalHandler;
  harness.deps.registerInterruptHandlers = (handler) => {
    signalHandler = handler;
    return () => {};
  };
  const createOwnedAvd = harness.deps.createOwnedAvd;
  harness.deps.createOwnedAvd = async (...args) => {
    const result = await createOwnedAvd(...args);
    signalHandler("SIGTERM");
    return result;
  };

  await assert.rejects(captureAndroid(captureConfig(), harness.deps), {
    name: "AndroidCaptureInterruptedError",
  });
  const names = harness.calls.map(({ name }) => name);
  assert.ok(names.indexOf("recordAvdCreation") > names.indexOf("createAvd"));
  assert.ok(names.indexOf("rollbackUnboundAvd") > names.indexOf("recordAvdCreation"));
  assert.equal(names.includes("launchEmulator"), false);
});

test("SIGINT after Kind creation binds exact ownership before teardown", async () => {
  const harness = createHarness();
  let signalHandler;
  harness.deps.registerInterruptHandlers = (handler) => {
    signalHandler = handler;
    return () => {};
  };
  const runKindMakePlan = harness.deps.runKindMakePlan;
  harness.deps.runKindMakePlan = async (...args) => {
    const result = await runKindMakePlan(...args);
    if (args[0].args[0] === "kind-up") signalHandler("SIGINT");
    return result;
  };

  await assert.rejects(captureAndroid(captureConfig(), harness.deps), {
    name: "AndroidCaptureInterruptedError",
  });
  const names = harness.calls.map(({ name }) => name);
  assert.ok(names.indexOf("bindKind") > names.indexOf("kindUp"));
  assert.ok(names.indexOf("teardownKind") > names.indexOf("bindKind"));
  assert.ok(names.indexOf("kindDown") > names.indexOf("teardownKind"));
  assert.equal(names.includes("rollbackUnboundKind"), false);
});

test("a signal received during committed bundle publication returns the successful capture", async () => {
  const harness = createHarness();
  let signalHandler;
  harness.deps.registerInterruptHandlers = (handler) => {
    signalHandler = handler;
    return () => {};
  };
  const publishBundle = harness.deps.publishAndroidCaptureBundle;
  harness.deps.publishAndroidCaptureBundle = async (...args) => {
    const result = await publishBundle(...args);
    signalHandler("SIGTERM");
    return result;
  };

  const result = await captureAndroid(captureConfig(), harness.deps);
  assert.equal(result.artifacts.mobileCapture.path, "/output/raw/android.mp4");
  assert.equal(result.lifecycle.avd.status, "deleted");
  assert.equal(result.lifecycle.cluster.status, "deleted");
});

test("a first signal during cleanup cannot turn a committed capture into failure", async () => {
  const harness = createHarness();
  let signalHandler;
  harness.deps.registerInterruptHandlers = (handler) => {
    signalHandler = handler;
    return () => {};
  };
  const removeReverse = harness.deps.removeOwnedAcpReverse;
  harness.deps.removeOwnedAcpReverse = async (...args) => {
    signalHandler("SIGINT");
    return removeReverse(...args);
  };

  const result = await captureAndroid(captureConfig(), harness.deps);
  assert.equal(result.artifacts.mobileCapture.path, "/output/raw/android.mp4");
  assert.equal(result.lifecycle.acpReverse.status, "deleted");
  assert.equal(result.lifecycle.avd.status, "deleted");
});

test("redacts setup secrets from cleanup diagnostics while preserving the primary error", async () => {
  const harness = createHarness({
    failAt: "recordedActions",
    cleanupFailures: new Map([
      ["stopRecording", new Error(`recorder exposed ${SECRET}`)],
    ]),
  });

  await assert.rejects(captureAndroid(captureConfig(), harness.deps), (error) => {
    assert.equal(error, harness.primaryError);
    assert.deepEqual(error.cleanupDiagnostics, [
      { phase: "screenrecord", message: "recorder exposed <redacted>" },
      {
        phase: "screenrecord-stage",
        message: "Recorder exit was not proven; preserving its private staging files",
      },
    ]);
    assert.equal(JSON.stringify(error.cleanupDiagnostics).includes(SECRET), false);
    return true;
  });
});
