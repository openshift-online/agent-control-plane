import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { captureScenario, doctorCapture } from "../../scripts/capture/index.mjs";
import { buildValidationReport } from "../../scripts/compose/validation.mjs";

const DIGEST = createHash("sha256").update("fixture").digest("hex");
const SOURCE_COMMIT = "c".repeat(40);
const SOURCE_TREE = "d".repeat(40);
const SOURCE_PATH = "components/mobile";
// Synthetic, non-secret fixture value built at runtime so secret scanners do not flag it.
const FAKE_BEARER = ["private", "bearer", "token"].join("-");
const APK_LOCK_BYTES = Buffer.from(`${JSON.stringify({
  schemaVersion: 1,
  source: { commit: SOURCE_COMMIT, tree: SOURCE_TREE, path: SOURCE_PATH },
  apk: {
    ref: "repo:artifacts/mobile.apk",
    sha256: DIGEST,
    applicationId: "dev.example.mobile",
    versionName: "1.2.3",
    versionCode: "123",
  },
  apkanalyzer: { identity: "apkanalyzer", version: "cmdline-tools 19.0" },
}, null, 2)}\n`);
const APK_LOCK_DIGEST = createHash("sha256").update(APK_LOCK_BYTES).digest("hex");
const ANDROID_TOOLS = [
  "adb", "emulator", "sdkmanager", "avdmanager", "apkanalyzer",
  "kind", "kubectl", "docker", "git", "make", "ffmpeg", "ffprobe",
];

function androidScenario(setupActions, { includeOwnedUrl = true } = {}) {
  const authoredSetupActions = includeOwnedUrl
    && !setupActions.some((action) => action?.action === "fillFromEnvironment" && action.environment === "ACP_URL")
    ? [ownedUrlAction(), ...setupActions]
    : setupActions;
  return {
    id: "android-onboarding",
    acp: { project: "demo-android-onboarding" },
    story: [
      { type: "title", durationSeconds: 3 },
      { type: "mobile", durationSeconds: 12 },
      { type: "end", durationSeconds: 3 },
    ],
    capture: {
      kind: "android-emulator",
      cluster: { kind: "disposable-kind" },
      android: {
        expectedApplicationId: "dev.example.mobile",
        launchActivity: "dev.example.mobile/.MainActivity",
        apk: "repo:artifacts/mobile.apk",
        apkLock: "repo:artifacts/mobile.apk.lock.json",
        systemImage: "system-images;android-35;google_apis;arm64-v8a",
        actionSettlingMilliseconds: 900,
        setupActions: authoredSetupActions,
        actions: [{ action: "tap", selector: { by: "text", value: "Continue" } }],
      },
    },
  };
}

function ownedUrlAction() {
  return {
    action: "fillFromEnvironment",
    selector: { by: "text", value: "Server" },
    environment: "ACP_URL",
  };
}

async function outputFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "demo-android-routing-"));
  const scenarioDir = path.join(root, "scenario");
  const outputDir = path.join(root, "output");
  await mkdir(path.join(outputDir, "raw"), { recursive: true });
  await mkdir(path.join(outputDir, "evidence"), { recursive: true });
  await mkdir(path.join(root, "artifacts"), { recursive: true });
  await mkdir(scenarioDir, { recursive: true });
  const paths = {
    mobileCapture: path.join(outputDir, "raw", "android.mp4"),
    pointerEvents: path.join(outputDir, "pointer-events.jsonl"),
    androidApkLock: path.join(outputDir, "evidence", "android-apk.lock.json"),
  };
  await Promise.all([
    writeFile(paths.mobileCapture, "fixture"),
    writeFile(paths.pointerEvents, "fixture"),
    writeFile(paths.androidApkLock, APK_LOCK_BYTES),
    writeFile(path.join(root, "artifacts", "mobile.apk"), "fixture"),
    writeFile(path.join(root, "artifacts", "mobile.apk.lock.json"), APK_LOCK_BYTES),
  ]);
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, scenarioDir, outputDir, paths };
}

function portableAndroidResult(paths) {
  return {
    source: {
      type: "mobile",
      width: 1080,
      height: 1920,
      landmarks: [{
        id: "recorded-action-1",
        ordinal: 1,
        action: "tap",
        selector: { by: "text", value: "Continue" },
      }],
      validationEvidence: {
        applicationId: "dev.example.mobile",
        versionName: "1.2.3",
        versionCode: "123",
        frameRate: 30,
        silent: true,
        durationSeconds: 11.95,
        actionCount: 1,
        pointerEventCount: 1,
        mediaValidated: true,
      },
    },
    android: {
      apk: {
        ref: "repo:artifacts/mobile.apk",
        sha256: DIGEST,
        lock: { ref: "repo:artifacts/mobile.apk.lock.json", sha256: APK_LOCK_DIGEST },
        applicationId: "dev.example.mobile",
        versionName: "1.2.3",
        versionCode: "123",
        source: { commit: SOURCE_COMMIT, tree: SOURCE_TREE, path: SOURCE_PATH },
        apkanalyzer: { identity: "apkanalyzer", version: "cmdline-tools 19.0" },
      },
      systemImage: {
        package: "system-images;android-35;google_apis;arm64-v8a",
        revision: "14.0",
      },
      toolchain: Object.fromEntries(ANDROID_TOOLS.map((name) => [name, {
        identity: `${name}-identity`,
        ...(["sdkmanager", "avdmanager", "apkanalyzer"].includes(name)
          ? { version: "cmdline-tools 19.0" }
          : {}),
      }])),
    },
    artifacts: {
      mobileCapture: { path: paths.mobileCapture, sha256: DIGEST },
      pointerEvents: { path: paths.pointerEvents, sha256: DIGEST },
      androidApkLock: { path: paths.androidApkLock, sha256: APK_LOCK_DIGEST },
    },
    lifecycle: {
      cluster: { status: "deleted", ownershipVerified: true },
      avd: { status: "deleted", ownershipVerified: true },
      acpReverse: { status: "deleted", ownershipVerified: true },
    },
  };
}

test("routes Android capture without invoking browser extension or ACP project lifecycle", async (t) => {
  const fixture = await outputFixture(t);
  const setupActions = [
    { action: "fillFromEnvironment", selector: { by: "text", value: "Token" }, environment: "ACP_BEARER_TOKEN" },
  ];
  const environment = {
    ACP_PROJECT: "demo-android-onboarding",
    ACP_BEARER_TOKEN: FAKE_BEARER,
    UNRELATED_SECRET: "must-not-be-forwarded-either",
  };
  let received;
  const forbidden = async () => { throw new Error("browser-only operation was invoked"); };

  const result = await captureScenario({
    repoRoot: fixture.root,
    scenarioDir: fixture.scenarioDir,
    outputDir: fixture.outputDir,
    captureOptions: { runId: "run-123" },
    scenario: androidScenario(setupActions),
  }, {
    environment,
    captureAndroid: async (config, dependencies) => {
      received = { config, dependencies };
      return portableAndroidResult(fixture.paths);
    },
    buildExtensionGate: forbidden,
    seedAcpProject: forbidden,
    verifyAcpProject: forbidden,
    cleanupAcpProject: forbidden,
    captureLinux: forbidden,
    captureMacos: forbidden,
  });

  assert.equal(received.config.scenarioId, "android-onboarding");
  assert.equal(received.config.scenarioDir, fixture.scenarioDir);
  assert.equal(received.config.outputDir, fixture.outputDir);
  assert.equal(received.config.repoRoot, fixture.root);
  assert.equal(received.config.authoredDurationMs, 12_000);
  assert.deepEqual(received.config.capture, androidScenario(setupActions).capture);
  assert.deepEqual(received.config.captureOptions, { runId: "run-123" });
  assert.equal(received.config.dryRun, false);
  assert.deepEqual(received.dependencies.environment, {
    ACP_BEARER_TOKEN: FAKE_BEARER,
  });
  assert.equal(JSON.stringify(received).includes("UNRELATED_SECRET"), false);
  assert.deepEqual(result, {
    capture: {
      schemaVersion: 1,
      kind: "android-emulator",
      platform: "android-emulator",
      source: {
        ...portableAndroidResult(fixture.paths).source,
        validationEvidence: {
          ...portableAndroidResult(fixture.paths).source.validationEvidence,
          artifactSha256: {
            mobileCapture: DIGEST,
            pointerEvents: DIGEST,
            androidApkLock: APK_LOCK_DIGEST,
          },
        },
      },
      android: portableAndroidResult(fixture.paths).android,
      lifecycle: portableAndroidResult(fixture.paths).lifecycle,
    },
    artifacts: {
      mobileCapture: "raw/android.mp4",
      pointerEvents: "pointer-events.jsonl",
      androidApkLock: "evidence/android-apk.lock.json",
    },
  });
  assert.equal(JSON.stringify(result).includes(fixture.root), false);
  assert.equal(JSON.stringify(result).includes("private-password"), false);
  const validationReport = buildValidationReport({
    master: { ok: true, file: path.join(fixture.outputDir, "demo-1080p.mp4"), checks: {}, probe: {} },
    derivative: { ok: true, file: path.join(fixture.outputDir, "demo-720p.mp4"), checks: {}, probe: {} },
    secretScan: { ok: true, findings: [] },
    outputDir: fixture.outputDir,
    manifest: result,
  });
  assert.equal(
    validationReport.automatedGates.find(({ id }) => id === "android.toolchain").status,
    "pass",
  );
});

test("requires the authored Android environment keys but not an unrelated bearer token", async (t) => {
  const fixture = await outputFixture(t);
  const scenario = androidScenario([
    {
      action: "fillFromEnvironment",
      selector: { by: "text", value: "Project" },
      environment: "ACP_PROJECT",
    },
    {
      action: "fillFromEnvironment",
      selector: { by: "text", value: "Token" },
      environment: "ACP_BEARER_TOKEN",
    },
  ]);
  let calls = 0;
  const invoke = (environment) => captureScenario({
    repoRoot: fixture.root,
    scenarioDir: fixture.scenarioDir,
    outputDir: fixture.outputDir,
    scenario,
  }, {
    environment,
    captureAndroid: async () => { calls += 1; return portableAndroidResult(fixture.paths); },
  });

  await assert.rejects(
    invoke({ ACP_PROJECT: "wrong-project", ACP_BEARER_TOKEN: "token" }),
    /ACP_PROJECT must match the authored nonsecret acp\.project/,
  );
  await assert.rejects(
    invoke({ ACP_PROJECT: "demo-android-onboarding" }),
    /ACP_BEARER_TOKEN is required by capture\.android\.setupActions/,
  );
  assert.equal(calls, 0);

  const bearerScenario = androidScenario([
    { action: "fillFromEnvironment", selector: { by: "text", value: "Token" }, environment: "ACP_BEARER_TOKEN" },
  ]);
  await captureScenario({
    repoRoot: fixture.root,
    scenarioDir: fixture.scenarioDir,
    outputDir: fixture.outputDir,
    scenario: bearerScenario,
  }, {
    environment: {
      ACP_PROJECT: "demo-android-onboarding",
      ACP_BEARER_TOKEN: FAKE_BEARER,
    },
    captureAndroid: async () => { calls += 1; return portableAndroidResult(fixture.paths); },
  });
  assert.equal(calls, 1);
});

test("rejects the Android setup contract before dry-run capture or doctor operations", async () => {
  const cases = [
    {
      label: "missing owned URL",
      scenario: androidScenario([], { includeOwnedUrl: false }),
      expected: /configure ACP_URL exactly once from the owned endpoint/,
    },
    {
      label: "duplicate owned URL",
      scenario: androidScenario([ownedUrlAction(), ownedUrlAction()]),
      expected: /configure ACP_URL exactly once from the owned endpoint/,
    },
    {
      label: "empty recorded actions",
      scenario: (() => {
        const scenario = androidScenario([ownedUrlAction()]);
        scenario.capture.android.actions = [];
        return scenario;
      })(),
      expected: /at least one recorded action/,
    },
    {
      label: "unsafe authored project",
      scenario: (() => {
        const scenario = androidScenario([{
          action: "fillFromEnvironment",
          selector: { by: "text", value: "Project" },
          environment: "ACP_PROJECT",
        }]);
        scenario.acp.project = "Authorization: Bearer private-project-value";
        return scenario;
      })(),
      expected: /authored nonsecret acp\.project is invalid/,
    },
    {
      label: "sub-millisecond overlong mobile duration",
      scenario: (() => {
        const scenario = androidScenario([]);
        scenario.story = [{ type: "mobile", durationSeconds: 179.0004 }];
        return scenario;
      })(),
      expected: /no more than 179 seconds/,
    },
    {
      label: "malformed story collection",
      scenario: (() => {
        const scenario = androidScenario([]);
        scenario.story = {};
        return scenario;
      })(),
      expected: /scenario\.story must be an array/,
    },
    {
      label: "numeric-string mobile duration",
      scenario: (() => {
        const scenario = androidScenario([]);
        scenario.story = [{ type: "mobile", durationSeconds: "12" }];
        return scenario;
      })(),
      expected: /positive numeric duration/,
    },
    {
      label: "symbol mobile duration",
      scenario: (() => {
        const scenario = androidScenario([]);
        scenario.story = [{ type: "mobile", durationSeconds: Symbol("private-duration") }];
        return scenario;
      })(),
      expected: /positive numeric duration/,
    },
  ];

  for (const { label, scenario, expected } of cases) {
    let captureCalls = 0;
    await assert.rejects(captureScenario({
      repoRoot: "/repo-does-not-need-to-exist",
      scenarioDir: "/scenario-does-not-need-to-exist",
      outputDir: "/output-does-not-need-to-exist",
      captureOptions: { dryRun: true },
      scenario,
    }, {
      environment: {},
      captureAndroid: async () => { captureCalls += 1; return { dryRun: true }; },
    }), expected, label);
    assert.equal(captureCalls, 0, label);

    let doctorCalls = 0;
    await assert.rejects(doctorCapture({ scenario }, {
      doctorAndroid: async () => { doctorCalls += 1; return { ok: true }; },
    }), expected, label);
    assert.equal(doctorCalls, 0, label);
  }
});

test("derives ACP_URL internally and requires ACP_PROJECT only when the scenario authors it", async (t) => {
  const fixture = await outputFixture(t);
  const bearerAction = {
    action: "fillFromEnvironment",
    selector: { by: "text", value: "Token" },
    environment: "ACP_BEARER_TOKEN",
  };
  let receivedEnvironment;
  await captureScenario({
    repoRoot: fixture.root,
    scenarioDir: fixture.scenarioDir,
    outputDir: fixture.outputDir,
    scenario: androidScenario([ownedUrlAction(), bearerAction]),
  }, {
    environment: {
      ACP_URL: "https://caller-controlled.example.test",
      ACP_BEARER_TOKEN: "private-token",
    },
    captureAndroid: async (_config, dependencies) => {
      receivedEnvironment = dependencies.environment;
      return portableAndroidResult(fixture.paths);
    },
  });
  assert.deepEqual(receivedEnvironment, { ACP_BEARER_TOKEN: "private-token" });

  const projectAction = {
    action: "fillFromEnvironment",
    selector: { by: "text", value: "Project" },
    environment: "ACP_PROJECT",
  };
  let calls = 0;
  await assert.rejects(captureScenario({
    repoRoot: fixture.root,
    scenarioDir: fixture.scenarioDir,
    outputDir: fixture.outputDir,
    captureOptions: { dryRun: true },
    scenario: androidScenario([ownedUrlAction(), projectAction]),
  }, {
    environment: { ACP_PROJECT: "wrong-project" },
    captureAndroid: async () => { calls += 1; return { dryRun: true }; },
  }), /ACP_PROJECT must match the authored nonsecret acp\.project/);
  assert.equal(calls, 0);

  await assert.rejects(captureScenario({
    repoRoot: fixture.root,
    scenarioDir: fixture.scenarioDir,
    outputDir: fixture.outputDir,
    scenario: androidScenario([ownedUrlAction(), projectAction, bearerAction]),
  }, {
    environment: { ACP_PROJECT: "wrong-project", ACP_BEARER_TOKEN: "private-token" },
    captureAndroid: async () => { calls += 1; return portableAndroidResult(fixture.paths); },
  }), /ACP_PROJECT must match the authored nonsecret acp\.project/);
  assert.equal(calls, 0);

  const shortSecret = "Q";
  const shortSecretError = await captureScenario({
      repoRoot: fixture.root,
      scenarioDir: fixture.scenarioDir,
      outputDir: fixture.outputDir,
      scenario: androidScenario([ownedUrlAction(), bearerAction]),
    }, {
      environment: { ACP_BEARER_TOKEN: shortSecret },
      captureAndroid: async () => { calls += 1; return portableAndroidResult(fixture.paths); },
    })
    .then(() => undefined, (failure) => failure);
  assert.match(shortSecretError.message, /too short for reliable exact-value redaction/);
  assert.equal(shortSecretError.message.includes(shortSecret), false);
  assert.equal(calls, 0);

  const unsafeProjectScenario = androidScenario([ownedUrlAction(), projectAction]);
  unsafeProjectScenario.acp.project = "Authorization: Bearer private-project-value";
  await assert.rejects(captureScenario({
    repoRoot: fixture.root,
    scenarioDir: fixture.scenarioDir,
    outputDir: fixture.outputDir,
    scenario: unsafeProjectScenario,
  }, {
    environment: { ACP_PROJECT: unsafeProjectScenario.acp.project },
    captureAndroid: async () => { calls += 1; return portableAndroidResult(fixture.paths); },
  }), /authored nonsecret acp\.project is invalid/);
  assert.equal(calls, 0);
});

test("rejects successful Android capture metadata without portable landmarks", async (t) => {
  const fixture = await outputFixture(t);
  const result = portableAndroidResult(fixture.paths);
  result.source.landmarks = [];
  await assert.rejects(captureScenario({
    repoRoot: fixture.root,
    scenarioDir: fixture.scenarioDir,
    outputDir: fixture.outputDir,
    scenario: androidScenario([ownedUrlAction()]),
  }, {
    environment: {},
    captureAndroid: async () => result,
  }), /source\.landmarks must contain at least one portable landmark/);
});

test("rejects private Android validation-evidence fields before routing public capture metadata", async (t) => {
  const fixture = await outputFixture(t);
  for (const mutate of [
    (result) => { result.source.validationEvidence.runtimeSessionId = "private-runtime-session"; },
    (result) => { result.source.validationEvidence.artifactSha256 = { privateStage: DIGEST }; },
  ]) {
    const result = portableAndroidResult(fixture.paths);
    mutate(result);
    await assert.rejects(captureScenario({
      repoRoot: fixture.root,
      scenarioDir: fixture.scenarioDir,
      outputDir: fixture.outputDir,
      scenario: androidScenario([ownedUrlAction()]),
    }, {
      environment: {},
      captureAndroid: async () => result,
    }), /source\.validationEvidence must contain exactly/);
  }
});

test("Android dry-run needs no credentials or files and remains explicitly unmergeable", async () => {
  const scenario = androidScenario([{
    action: "fillFromEnvironment",
    selector: { by: "text", value: "Token" },
    environment: "ACP_BEARER_TOKEN",
  }]);
  let received;
  const result = await captureScenario({
    repoRoot: "/repo",
    scenarioDir: "/scenario",
    outputDir: "/output-does-not-need-to-exist",
    captureOptions: { dryRun: true, runId: "dry-run" },
    scenario,
  }, {
    environment: {},
    captureAndroid: async (config, dependencies) => {
      received = { config, dependencies };
      return { dryRun: true, platform: "android-emulator", commands: [] };
    },
  });

  assert.equal(received.config.dryRun, true);
  assert.deepEqual(received.dependencies.environment, {});
  assert.deepEqual(result, { dryRun: true, platform: "android-emulator", commands: [] });
});

test("injected live Android context is not changed by an ambient dry-run variable", async (t) => {
  const fixture = await outputFixture(t);
  const previous = process.env.DEMO_CAPTURE_DRY_RUN;
  process.env.DEMO_CAPTURE_DRY_RUN = "1";
  t.after(() => {
    if (previous === undefined) delete process.env.DEMO_CAPTURE_DRY_RUN;
    else process.env.DEMO_CAPTURE_DRY_RUN = previous;
  });
  let receivedDryRun;
  await captureScenario({
    repoRoot: fixture.root,
    scenarioDir: fixture.scenarioDir,
    outputDir: fixture.outputDir,
    captureOptions: { dryRun: false },
    scenario: androidScenario([]),
  }, {
    environment: { ACP_PROJECT: "demo-android-onboarding" },
    captureAndroid: async (config) => {
      receivedDryRun = config.dryRun;
      return portableAndroidResult(fixture.paths);
    },
  });
  assert.equal(receivedDryRun, false);
});

test("requires runtime dry-run status to match the requested mode", async (t) => {
  const fixture = await outputFixture(t);
  let liveRoot;
  await assert.rejects(captureScenario({
    repoRoot: fixture.root,
    scenarioDir: fixture.scenarioDir,
    outputDir: fixture.outputDir,
    scenario: androidScenario([]),
  }, {
    environment: { ACP_PROJECT: "demo-android-onboarding" },
    captureAndroid: async (config) => {
      liveRoot = config.markerRoot;
      return { dryRun: true };
    },
  }), /runtime returned dry-run output for a live capture/);
  assert.equal((await stat(liveRoot)).isDirectory(), true);
  await rm(liveRoot, { recursive: true, force: true });

  await assert.rejects(captureScenario({
    repoRoot: fixture.root,
    scenarioDir: fixture.scenarioDir,
    outputDir: fixture.outputDir,
    captureOptions: { dryRun: true },
    scenario: androidScenario([]),
  }, {
    environment: {},
    captureAndroid: async () => portableAndroidResult(fixture.paths),
  }), /dry-run capture must return dryRun true/);
});

test("validates Android setup environment names even for dry-run", async () => {
  const unsupportedName = "AWS_SECRET_ACCESS_KEY-private-value";
  const scenario = androidScenario([{
    action: "fillFromEnvironment",
    selector: { by: "text", value: "Credential" },
    environment: unsupportedName,
  }]);
  let called = false;
  const error = await captureScenario({
      repoRoot: "/repo",
      scenarioDir: "/scenario",
      outputDir: "/output-does-not-need-to-exist",
      captureOptions: { dryRun: true },
      scenario,
    }, {
      environment: {},
      captureAndroid: async () => { called = true; },
    })
    .then(() => undefined, (failure) => failure);
  assert.match(error.message, /Unsupported Android setup environment key/);
  assert.equal(error.message.includes(unsupportedName), false);
  assert.equal(called, false);
});

test("rejects authored OIDC credentials because Android uses system-browser PKCE", async (t) => {
  const fixture = await outputFixture(t);
  for (const environmentName of ["ACP_OIDC_USERNAME", "ACP_OIDC_PASSWORD"]) {
    const scenario = androidScenario([{
      action: "fillFromEnvironment",
      selector: { by: "text", value: "OIDC credential" },
      environment: environmentName,
    }]);
    let called = false;
    await assert.rejects(captureScenario({
      repoRoot: fixture.root,
      scenarioDir: fixture.scenarioDir,
      outputDir: fixture.outputDir,
      scenario,
    }, {
      environment: { [environmentName]: "must-not-be-collected" },
      captureAndroid: async () => { called = true; },
    }), /Unsupported Android setup environment key/);
    assert.equal(called, false);
  }
});

test("bounds Android run IDs before deriving private paths", async () => {
  await assert.rejects(captureScenario({
    repoRoot: "/repo",
    scenarioDir: "/scenario",
    outputDir: "/output",
    captureOptions: { dryRun: true, runId: "../../escape" },
    scenario: androidScenario([]),
  }, {
    environment: {},
    captureAndroid: async () => ({ dryRun: true }),
  }), /captureOptions\.runId must be a bounded identifier/);
});

test("refuses caller-selected Android marker roots before capture", async (t) => {
  const fixture = await outputFixture(t);
  let called = false;
  const error = await captureScenario({
      repoRoot: fixture.root,
      scenarioDir: fixture.scenarioDir,
      outputDir: fixture.outputDir,
      captureOptions: { markerRoot: path.join(fixture.root, "caller-selected-root") },
      scenario: androidScenario([]),
    }, {
      environment: { ACP_PROJECT: "demo-android-onboarding" },
      captureAndroid: async () => { called = true; },
    })
    .then(() => undefined, (failure) => failure);
  assert.match(error.message, /captureOptions contains an unsupported field/);
  assert.equal(error.message.includes("markerRoot"), false);
  assert.equal(called, false);
});

test("owns a private Android runtime root and purges it after proved lifecycle cleanup", async (t) => {
  const fixture = await outputFixture(t);
  let markerRoot;
  let avdRoot;
  await captureScenario({
    repoRoot: fixture.root,
    scenarioDir: fixture.scenarioDir,
    outputDir: fixture.outputDir,
    scenario: androidScenario([]),
  }, {
    environment: { ACP_PROJECT: "demo-android-onboarding" },
    captureAndroid: async (config, dependencies) => {
      markerRoot = config.markerRoot;
      avdRoot = dependencies.avdRoot;
      assert.equal((await stat(markerRoot)).isDirectory(), true);
      assert.equal((await stat(avdRoot)).isDirectory(), true);
      assert.equal(markerRoot, await realpath(markerRoot));
      assert.equal(avdRoot, await realpath(avdRoot));
      await writeFile(path.join(markerRoot, "private-diagnostic"), "must be purged");
      return portableAndroidResult(fixture.paths);
    },
  });

  await assert.rejects(stat(markerRoot), /ENOENT/);
  await assert.rejects(stat(avdRoot), /ENOENT/);
});

test("rejects malformed, unowned, secret-bearing, or escaping Android results", async (t) => {
  const fixture = await outputFixture(t);
  const outside = path.join(fixture.root, "outside.mp4");
  await writeFile(outside, "outside");
  const scenario = androidScenario([]);
  const context = {
    repoRoot: fixture.root,
    scenarioDir: fixture.scenarioDir,
    outputDir: fixture.outputDir,
    scenario,
  };
  const environment = { ACP_PROJECT: "demo-android-onboarding" };
  const cases = [
    [(result) => { result.artifacts.mobileCapture.path = outside; }, /escapes outputDir/],
    [(result) => { result.artifacts.pointerEvents.sha256 = "short"; }, /pointerEvents\.sha256/],
    [(result) => { result.artifacts.pointerEvents.sha256 = "b".repeat(64); }, /pointerEvents digest does not match/],
    [(result) => { result.source.width = 0; }, /source\.width/],
    [(result) => { result.source.validationEvidence.durationSeconds = 10; }, /duration.*authored mobile budget/i],
    [(result) => { delete result.android.systemImage; }, /capture\.android must contain exactly/],
    [(result) => { result.android.apk.ref = "repo:../escape.apk"; }, /portable ref and digest evidence/],
    [(result) => { result.android.apk.source.tree = "e".repeat(40); }, /does not match the repository lock/],
    [(result) => { result.android.apk.source.path = "components/not-mobile"; }, /source identity is malformed/],
    [(result) => { result.android.apk.source.extra = true; }, /source must contain exactly/],
    [(result) => { result.lifecycle.avd.ownershipVerified = false; }, /lifecycle\.avd/],
    [(result) => { result.lifecycle.acpReverse.status = "active"; }, /lifecycle\.acpReverse/],
    [(result) => { result.android.toolchain.adb.path = "/opt/android-sdk/adb"; }, /host-absolute path/],
  ];

  for (const [mutate, expected] of cases) {
    const candidate = portableAndroidResult(fixture.paths);
    mutate(candidate);
    await assert.rejects(captureScenario(context, {
      environment: { ...environment, ACP_BEARER_TOKEN: "secret-value" },
      captureAndroid: async () => candidate,
    }), expected);
  }
});

test("purges its private root when capture or publication fails after safe cleanup", async (t) => {
  const fixture = await outputFixture(t);
  let captureFailureRoot;
  await assert.rejects(captureScenario({
    repoRoot: fixture.root,
    scenarioDir: fixture.scenarioDir,
    outputDir: fixture.outputDir,
    scenario: androidScenario([]),
  }, {
    environment: { ACP_PROJECT: "demo-android-onboarding" },
    captureAndroid: async (config) => {
      captureFailureRoot = config.markerRoot;
      const error = new Error("capture failed after owned cleanup");
      Object.defineProperty(error, "ownedCleanupCompleted", { value: true });
      throw error;
    },
  }), /capture failed after owned cleanup/);
  await assert.rejects(stat(captureFailureRoot), /ENOENT/);

  let publicationFailureRoot;
  const malformed = portableAndroidResult(fixture.paths);
  malformed.source.width = 0;
  await assert.rejects(captureScenario({
    repoRoot: fixture.root,
    scenarioDir: fixture.scenarioDir,
    outputDir: fixture.outputDir,
    scenario: androidScenario([]),
  }, {
    environment: { ACP_PROJECT: "demo-android-onboarding" },
    captureAndroid: async (config) => {
      publicationFailureRoot = config.markerRoot;
      return malformed;
    },
  }), /source\.width/);
  await assert.rejects(stat(publicationFailureRoot), /ENOENT/);
});

test("retains its private root unless a failed runtime positively proves cleanup", async (t) => {
  const fixture = await outputFixture(t);
  let markerRoot;
  await assert.rejects(captureScenario({
    repoRoot: fixture.root,
    scenarioDir: fixture.scenarioDir,
    outputDir: fixture.outputDir,
    scenario: androidScenario([]),
  }, {
    environment: { ACP_PROJECT: "demo-android-onboarding" },
    captureAndroid: async (config) => {
      markerRoot = config.markerRoot;
      throw new Error("capture failed without cleanup proof");
    },
  }), /capture failed without cleanup proof/);
  assert.equal((await stat(markerRoot)).isDirectory(), true);
  await rm(markerRoot, { recursive: true, force: true });
});

test("binds Android result identity to the authored scenario and repository APK", async (t) => {
  const fixture = await outputFixture(t);
  const context = {
    repoRoot: fixture.root,
    scenarioDir: fixture.scenarioDir,
    outputDir: fixture.outputDir,
    scenario: androidScenario([]),
  };
  for (const mutate of [
    (result) => { result.android.apk.applicationId = "dev.different.mobile"; },
    (result) => { result.android.apk.ref = "repo:artifacts/different.apk"; },
    (result) => { result.android.apk.sha256 = "b".repeat(64); },
    (result) => { result.android.systemImage.package = "system-images;android-36;google_apis;arm64-v8a"; },
  ]) {
    const candidate = portableAndroidResult(fixture.paths);
    mutate(candidate);
    await assert.rejects(captureScenario(context, {
      environment: { ACP_PROJECT: "demo-android-onboarding" },
      captureAndroid: async () => candidate,
    }), /does not match the authored scenario|repository APK digest does not match captured bytes/);
  }
});

test("requires exact portable package and revision evidence for the installed Android system image", async (t) => {
  const fixture = await outputFixture(t);
  const context = {
    repoRoot: fixture.root,
    scenarioDir: fixture.scenarioDir,
    outputDir: fixture.outputDir,
    scenario: androidScenario([]),
  };
  const cases = [
    [(systemImage) => { delete systemImage.package; }, /systemImage must contain exactly/],
    [(systemImage) => { delete systemImage.revision; }, /systemImage must contain exactly/],
    [(systemImage) => { systemImage.installed = true; }, /systemImage must contain exactly/],
    [(systemImage) => { systemImage.revision = ""; }, /systemImage is malformed/],
    [(systemImage) => { systemImage.revision = "/private/sdk/image"; }, /host-absolute path|systemImage is malformed/],
    [(systemImage) => { systemImage.revision = "1234567"; }, /systemImage is malformed/],
    [(systemImage) => { systemImage.revision = "1.2.3.4.5"; }, /systemImage is malformed/],
  ];

  for (const [mutate, expected] of cases) {
    const candidate = portableAndroidResult(fixture.paths);
    mutate(candidate.android.systemImage);
    await assert.rejects(captureScenario(context, {
      environment: { ACP_PROJECT: "demo-android-onboarding" },
      captureAndroid: async () => candidate,
    }), expected);
  }
});

test("rejects Windows-absolute payloads in portable repository references", async (t) => {
  const fixture = await outputFixture(t);
  for (const ref of ["repo:C:/outside.apk", "repo:C:outside.apk", "repo://server/share.apk", "repo:\\\\server\\share.apk"]) {
    const candidate = portableAndroidResult(fixture.paths);
    candidate.android.apk.ref = ref;
    await assert.rejects(captureScenario({
      repoRoot: fixture.root,
      scenarioDir: fixture.scenarioDir,
      outputDir: fixture.outputDir,
      scenario: androidScenario([]),
    }, {
      environment: { ACP_PROJECT: "demo-android-onboarding" },
      captureAndroid: async () => candidate,
    }), /portable ref and digest evidence/, ref);
  }
});

test("rejects an output path swap while hashing Android evidence", async (t) => {
  const fixture = await outputFixture(t);
  const candidate = portableAndroidResult(fixture.paths);
  let swapped = false;
  await assert.rejects(captureScenario({
    repoRoot: fixture.root,
    scenarioDir: fixture.scenarioDir,
    outputDir: fixture.outputDir,
    scenario: androidScenario([]),
  }, {
    environment: { ACP_PROJECT: "demo-android-onboarding" },
    hashArtifact: async ({ handle, label }) => {
      const contents = await handle.readFile();
      if (label === "Android pointerEvents") {
        await rename(fixture.paths.pointerEvents, `${fixture.paths.pointerEvents}.replaced`);
        await writeFile(fixture.paths.pointerEvents, contents);
        swapped = true;
      }
      return createHash("sha256").update(contents).digest("hex");
    },
    captureAndroid: async () => candidate,
  }), /pointerEvents changed identity during hashing/);
  assert.equal(swapped, true);
});

test("rejects every selected Android setup value from portable metadata", async (t) => {
  const fixture = await outputFixture(t);
  const selectedEnvironment = {
    ACP_PROJECT: "demo-android-onboarding",
    ACP_URL: "https://private-acp.example.test",
    ACP_BEARER_TOKEN: "private\"bearer\\token\nnext-line",
  };
  const scenario = androidScenario([
    { action: "fillFromEnvironment", selector: { by: "text", value: "Server" }, environment: "ACP_URL" },
    { action: "fillFromEnvironment", selector: { by: "text", value: "Token" }, environment: "ACP_BEARER_TOKEN" },
  ]);

  const candidate = portableAndroidResult(fixture.paths);
  candidate.android.toolchain.adb.identity = selectedEnvironment.ACP_BEARER_TOKEN;
  await assert.rejects(captureScenario({
    repoRoot: fixture.root,
    scenarioDir: fixture.scenarioDir,
    outputDir: fixture.outputDir,
    scenario,
  }, {
    environment: selectedEnvironment,
    captureAndroid: async () => candidate,
  }), /environment secret/);

  const keyCandidate = portableAndroidResult(fixture.paths);
  keyCandidate.source.validationEvidence[selectedEnvironment.ACP_BEARER_TOKEN] = true;
  await assert.rejects(captureScenario({
    repoRoot: fixture.root,
    scenarioDir: fixture.scenarioDir,
    outputDir: fixture.outputDir,
    scenario,
  }, {
    environment: selectedEnvironment,
    captureAndroid: async () => keyCandidate,
  }), /source\.validationEvidence must contain exactly/);

  const escapedCandidate = portableAndroidResult(fixture.paths);
  escapedCandidate.source.validationEvidence.versionName = JSON.stringify(
    selectedEnvironment.ACP_BEARER_TOKEN,
  ).slice(1, -1);
  await assert.rejects(captureScenario({
    repoRoot: fixture.root,
    scenarioDir: fixture.scenarioDir,
    outputDir: fixture.outputDir,
    scenario,
  }, {
    environment: selectedEnvironment,
    captureAndroid: async () => escapedCandidate,
  }), /environment secret/);

  const base64urlCandidate = portableAndroidResult(fixture.paths);
  base64urlCandidate.source.validationEvidence.versionCode = Buffer.from(
    selectedEnvironment.ACP_BEARER_TOKEN,
    "utf8",
  ).toString("base64url");
  await assert.rejects(captureScenario({
    repoRoot: fixture.root,
    scenarioDir: fixture.scenarioDir,
    outputDir: fixture.outputDir,
    scenario,
  }, {
    environment: selectedEnvironment,
    captureAndroid: async () => base64urlCandidate,
  }), /environment secret/);

  const diagnosticCandidate = portableAndroidResult(fixture.paths);
  diagnosticCandidate.source.landmarks = [{
    [selectedEnvironment.ACP_BEARER_TOKEN]: "/host-private-landmark",
  }];
  const diagnosticError = await captureScenario({
      repoRoot: fixture.root,
      scenarioDir: fixture.scenarioDir,
      outputDir: fixture.outputDir,
      scenario,
    }, {
      environment: selectedEnvironment,
      captureAndroid: async () => diagnosticCandidate,
    })
    .then(() => undefined, (failure) => failure);
  assert.match(diagnosticError.message, /contains a host-absolute path/);
  assert.equal(diagnosticError.message.includes(selectedEnvironment.ACP_BEARER_TOKEN), false);
});

test("Android doctor receives only the authored capture block", async () => {
  const scenario = androidScenario([]);
  let received;
  const report = await doctorCapture({ scenario }, {
    doctorAndroid: async (capture) => {
      received = capture;
      return {
        ok: true,
        capture: { kind: capture.kind },
        sdk: {
          systemImage: {
            package: capture.android.systemImage,
            revision: "14.0.1",
            installed: true,
          },
        },
        tools: {},
      };
    },
  });
  assert.equal(received, scenario.capture);
  assert.equal(report.ok, true);
  assert.equal(report.capture.kind, "android-emulator");
  assert.deepEqual(report.sdk.systemImage, {
    package: scenario.capture.android.systemImage,
    revision: "14.0.1",
    installed: true,
  });
});

test("keeps browser macOS and Linux routing on their native adapters", async () => {
  for (const [platform, dependencyName] of [["macos", "captureMacos"], ["linux", "captureLinux"]]) {
    const calls = [];
    const result = await captureScenario({
      scenarioDir: "/scenario",
      outputDir: "/output",
      captureOptions: { platform, dryRun: true },
      scenario: { story: [{ type: "browser", durationSeconds: 1 }] },
    }, {
      captureAndroid: async () => { throw new Error("Android adapter was invoked"); },
      [dependencyName]: async () => {
        calls.push(platform);
        return { dryRun: true, platform, nativeBrowser: true, commands: [] };
      },
    });
    assert.deepEqual(calls, [platform]);
    assert.equal(result.platform, platform);
    assert.equal(result.nativeBrowser, true);
  }
});

test("injected browser environment is not overridden by ambient dry-run state", async (t) => {
  const fixture = await outputFixture(t);
  const previous = process.env.DEMO_CAPTURE_DRY_RUN;
  process.env.DEMO_CAPTURE_DRY_RUN = "1";
  t.after(() => {
    if (previous === undefined) delete process.env.DEMO_CAPTURE_DRY_RUN;
    else process.env.DEMO_CAPTURE_DRY_RUN = previous;
  });
  const browserFiles = {
    rawVideo: path.join(fixture.outputDir, "raw", "browser.mp4"),
    pointerEvents: path.join(fixture.outputDir, "pointer-events-browser.jsonl"),
    pointerEventsRaw: path.join(fixture.outputDir, "pointer-events-browser.raw.jsonl"),
    extensionLock: path.join(fixture.outputDir, "evidence", "extension.lock.json"),
    extensionZip: path.join(fixture.outputDir, "evidence", "browser-extension.zip"),
  };
  await Promise.all(Object.values(browserFiles).map((pathname) => writeFile(pathname, "fixture")));
  let receivedDryRun;
  const injectedEnvironment = { DEMO_CAPTURE_DRY_RUN: "0", ACP_URL: "http://127.0.0.1:7777" };
  const lifecycleOptions = [];
  const result = await captureScenario({
    repoRoot: fixture.root,
    scenarioDir: fixture.scenarioDir,
    outputDir: fixture.outputDir,
    captureOptions: { platform: "linux", dryRun: false },
    scenario: { id: "browser-demo", acp: { project: "demo-browser-demo" }, story: [{ type: "browser", durationSeconds: 1 }] },
  }, {
    environment: injectedEnvironment,
    seedAcpProject: async (_scenario, options) => {
      lifecycleOptions.push(["seed", options]);
      return { action: "created" };
    },
    verifyAcpProject: async (_scenario, options) => {
      lifecycleOptions.push(["verify", options]);
      return { action: "verified" };
    },
    cleanupAcpProject: async (_scenario, options) => {
      lifecycleOptions.push(["cleanup", options]);
      return { action: "deleted" };
    },
    buildExtensionGate: async () => ({
      lock: { artifact: { sha256: DIGEST }, extension: { id: "a".repeat(32), name: "ACP Sessions" } },
      lockPath: browserFiles.extensionLock,
      zipPath: browserFiles.extensionZip,
      unpackedPath: path.join(fixture.root, "unpacked"),
    }),
    captureLinux: async (config) => {
      receivedDryRun = config.dryRun;
      return {
        platform: "linux",
        rawVideo: browserFiles.rawVideo,
        pointerEvents: browserFiles.pointerEvents,
        pointerEventsRaw: browserFiles.pointerEventsRaw,
        profileRetained: false,
        extension: { extensionId: "a".repeat(32), sha256: DIGEST },
        panel: { driver: "playwright", type: "page", actionCount: 1 },
      };
    },
  });
  assert.equal(receivedDryRun, false);
  assert.equal(result.capture.lifecycle.cleanup, "deleted");
  assert.deepEqual(lifecycleOptions, [
    ["seed", { environment: injectedEnvironment }],
    ["verify", { environment: injectedEnvironment }],
    ["cleanup", {
      environment: injectedEnvironment,
      expectPresent: true,
      keepProject: false,
    }],
  ]);
});

test("browser publication also requires contained, stable, hash-bound artifacts", async (t) => {
  const fixture = await outputFixture(t);
  const browserFiles = {
    rawVideo: path.join(fixture.outputDir, "raw", "browser.mp4"),
    pointerEvents: path.join(fixture.outputDir, "pointer-events-browser.jsonl"),
    pointerEventsRaw: path.join(fixture.outputDir, "pointer-events-browser.raw.jsonl"),
    extensionLock: path.join(fixture.outputDir, "extension", "extension.lock.json"),
    extensionZip: path.join(fixture.outputDir, "extension", "browser-extension.zip"),
    unpacked: path.join(fixture.outputDir, "extension", "unpacked"),
  };
  await mkdir(browserFiles.unpacked, { recursive: true });
  await Promise.all(Object.entries(browserFiles)
    .filter(([name]) => name !== "unpacked")
    .map(([, pathname]) => writeFile(pathname, "fixture")));
  const extensionId = "a".repeat(32);
  const scenario = {
    id: "browser-demo",
    fps: 30,
    acp: { project: "demo-browser-demo" },
    story: [{ type: "browser", durationSeconds: 1 }],
    extension: { expectedId: extensionId },
  };
  const invoke = (overrides = {}) => captureScenario({
    repoRoot: fixture.root,
    scenarioDir: fixture.scenarioDir,
    outputDir: fixture.outputDir,
    captureOptions: { platform: "linux" },
    scenario,
  }, {
    seedAcpProject: async () => ({ action: "created" }),
    verifyAcpProject: async () => ({ action: "verified" }),
    cleanupAcpProject: async () => ({ action: "deleted" }),
    buildExtensionGate: async () => ({
      lock: {
        artifact: { sha256: overrides.extensionSha256 ?? DIGEST },
        extension: { id: extensionId, name: "ACP Sessions" },
      },
      lockPath: browserFiles.extensionLock,
      zipPath: browserFiles.extensionZip,
      unpackedPath: browserFiles.unpacked,
    }),
    captureLinux: async () => ({
      platform: "linux",
      rawVideo: overrides.rawVideo ?? browserFiles.rawVideo,
      pointerEvents: browserFiles.pointerEvents,
      pointerEventsRaw: browserFiles.pointerEventsRaw,
      profileRetained: false,
      extension: { extensionId, sha256: overrides.extensionSha256 ?? DIGEST },
      panel: { driver: "playwright", type: "page", actionCount: 1 },
    }),
  });

  const result = await invoke();
  assert.deepEqual(result.artifacts, {
    browserCapture: "raw/browser.mp4",
    pointerEvents: "pointer-events-browser.jsonl",
    pointerEventsRaw: "pointer-events-browser.raw.jsonl",
    extensionLock: "extension/extension.lock.json",
    extensionZip: "extension/browser-extension.zip",
  });
  const outside = path.join(fixture.root, "outside-browser.mp4");
  await writeFile(outside, "fixture");
  await assert.rejects(invoke({ rawVideo: outside }), /browserCapture\.path escapes outputDir/);
  await assert.rejects(invoke({ extensionSha256: "b".repeat(64) }), /extensionZip digest does not match captured bytes/);
});
