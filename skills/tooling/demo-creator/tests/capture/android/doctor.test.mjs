import assert from "node:assert/strict";
import test from "node:test";
import { ANDROID_LAUNCH_ACTIVITY_MAX_CHARACTERS } from "../../../scripts/core/android-contract.mjs";

const SDK_ROOT = "/opt/android-sdk";
const SDK_TOOLS = Object.freeze({
  adb: `${SDK_ROOT}/platform-tools/adb`,
  emulator: `${SDK_ROOT}/emulator/emulator`,
  sdkmanager: `${SDK_ROOT}/cmdline-tools/19.0/bin/sdkmanager`,
  avdmanager: `${SDK_ROOT}/cmdline-tools/19.0/bin/avdmanager`,
  apkanalyzer: `${SDK_ROOT}/cmdline-tools/19.0/bin/apkanalyzer`,
});
const EXTERNAL_TOOLS = Object.freeze({
  kind: "/usr/local/bin/kind",
  kubectl: "/usr/local/bin/kubectl",
  docker: "/usr/local/bin/docker",
  git: "/usr/bin/git",
  make: "/usr/bin/make",
  ffmpeg: "/usr/local/bin/ffmpeg",
  ffprobe: "/usr/local/bin/ffprobe",
});
const TOOL_PATHS = Object.freeze({ ...SDK_TOOLS, ...EXTERNAL_TOOLS });
const SYSTEM_IMAGE = "system-images;android-35;google_apis;arm64-v8a";

const validConfig = Object.freeze({
  kind: "android-emulator",
  cluster: { kind: "disposable-kind" },
  android: {
    apk: "repo:components/mobile/dist/ambient-mobile.apk",
    apkLock: "repo:components/mobile/dist/ambient-mobile.apk.lock.json",
    expectedApplicationId: "dev.ambientcode.mobile",
    launchActivity: "dev.ambientcode.mobile/.MainActivity",
    systemImage: SYSTEM_IMAGE,
    setupActions: [{
      action: "fillFromEnvironment",
      selector: { by: "contentDescription", value: "Access token" },
      environment: "ACP_BEARER_TOKEN",
    }],
    actions: [{
      action: "fill",
      selector: { by: "contentDescription", value: "Demo field" },
      value: "visible-demo-input",
    }],
  },
});

async function loadDoctor() {
  try {
    return await import("../../../scripts/capture/android/doctor.mjs");
  } catch (error) {
    if (error?.code === "ERR_MODULE_NOT_FOUND") return {};
    throw error;
  }
}

function createHarness(overrides = {}) {
  const calls = [];
  const resolverCalls = [];
  const identities = {
    adb: { stdout: "Android Debug Bridge version 1.0.41\nVersion 35.0.2-12147458\n", stderr: "" },
    emulator: { stdout: "Android emulator version 35.4.9.0 (build_id 12790177)\n", stderr: "" },
    sdkmanager: { stdout: "19.0\n", stderr: "SDK metadata warning\n" },
    avdmanager: { stdout: "Usage:\n  avdmanager [global options] [action] [action options]\n", stderr: "" },
    apkanalyzer: { stdout: "", stderr: "Usage:\napkanalyzer [global options] <subject> <verb> [options] <apk>\n" },
    kind: { stdout: "kind v0.30.0 go1.24.0 darwin/arm64\n", stderr: "" },
    kubectl: { stdout: '{"clientVersion":{"gitVersion":"v1.33.3"}}\n', stderr: "" },
    docker: { stdout: "Docker version 28.3.2, build 578ccf6\n", stderr: "" },
    git: { stdout: "git version 2.50.1\n", stderr: "" },
    make: { stdout: "GNU Make 3.81\nCopyright (C) 2006 Free Software Foundation, Inc.\n", stderr: "" },
    ffmpeg: { stdout: "ffmpeg version 7.1.1 Copyright (c) the FFmpeg developers\n", stderr: "" },
    ffprobe: { stdout: "ffprobe version 7.1.1 Copyright (c) the FFmpeg developers\nbuilt with Apple clang\n", stderr: "" },
    ...overrides.identities,
  };
  const realpaths = {
    [SDK_ROOT]: SDK_ROOT,
    ...Object.fromEntries(Object.values(TOOL_PATHS).map((toolPath) => [toolPath, toolPath])),
    ...overrides.realpaths,
  };
  const filesystem = {
    async readdir(requestedPath) {
      assert.equal(requestedPath, `${SDK_ROOT}/cmdline-tools`);
      return (overrides.cmdlineToolVersions ?? []).map((name) => ({
        name,
        isDirectory: () => true,
        isSymbolicLink: () => false,
      }));
    },
    async realpath(requestedPath) {
      if (overrides.missingRealpaths?.includes(requestedPath)) {
        throw Object.assign(new Error(`missing path: ${requestedPath}`), { code: "ENOENT" });
      }
      const result = realpaths[requestedPath];
      if (result === undefined) {
        throw Object.assign(new Error(`missing path: ${requestedPath}`), { code: "ENOENT" });
      }
      return result;
    },
    async stat(requestedPath) {
      if (overrides.statKinds?.[requestedPath] === "directory") {
        return { isDirectory: () => true, isFile: () => false };
      }
      if (overrides.statKinds?.[requestedPath] === "file") {
        return { isDirectory: () => false, isFile: () => true };
      }
      if (overrides.statKinds?.[requestedPath] === "other") {
        return { isDirectory: () => false, isFile: () => false };
      }
      if (requestedPath === SDK_ROOT) return { isDirectory: () => true, isFile: () => false };
      if (Object.values(TOOL_PATHS).includes(requestedPath)) {
        return { isDirectory: () => false, isFile: () => true };
      }
      throw Object.assign(new Error(`missing path: ${requestedPath}`), { code: "ENOENT" });
    },
    async access(requestedPath) {
      if (overrides.nonExecutable?.includes(requestedPath)) {
        throw Object.assign(new Error(`not executable: ${requestedPath}`), { code: "EACCES" });
      }
      if (!Object.values(TOOL_PATHS).includes(requestedPath)
        && overrides.statKinds?.[requestedPath] !== "file") {
        throw Object.assign(new Error(`not executable: ${requestedPath}`), { code: "EACCES" });
      }
    },
  };
  const resolveExecutable = async (name, options = {}) => {
    resolverCalls.push({ name, options: { ...options } });
    return Object.hasOwn(overrides.toolPaths ?? {}, name) ? overrides.toolPaths[name] : TOOL_PATHS[name];
  };
  const runCommand = async (executable, args, options = {}) => {
    assert.equal(typeof executable, "string");
    assert.ok(Array.isArray(args), "commands must receive an argument array");
    assert.equal(options.shell, false, "doctor commands must explicitly disable shell execution");
    calls.push({ executable, args: [...args], options: { ...options } });
    const name = Object.keys(TOOL_PATHS).find((candidate) => {
      const overriddenPath = Object.hasOwn(overrides.toolPaths ?? {}, candidate)
        ? overrides.toolPaths[candidate]
        : TOOL_PATHS[candidate];
      return overriddenPath === executable;
    }) ?? Object.keys(TOOL_PATHS).find((candidate) => candidate === executable.split("/").at(-1));
    assert.ok(name, `unexpected executable: ${executable}`);
    if (Object.hasOwn(overrides.commandErrors ?? {}, name)) {
      throw overrides.commandErrors[name];
    }
    if (name === "sdkmanager" && args[0] === "--list_installed") {
      return overrides.systemImageResult ?? {
        stdout: [
          "Installed packages:",
          "Path | Version | Description | Location",
          "system-images;android-35;google_apis;x86_64 | 14 | near match | system-images/android-35/google_apis/x86_64",
          `${SYSTEM_IMAGE} | 14 | exact match | system-images/android-35/google_apis/arm64-v8a`,
          "",
        ].join("\n"),
        stderr: "",
      };
    }
    return identities[name];
  };
  return {
    calls,
    resolverCalls,
    deps: {
      env: overrides.env ?? { ANDROID_SDK_ROOT: SDK_ROOT },
      filesystem,
      resolveExecutable,
      runCommand,
    },
  };
}

test("accepts the installed avdmanager help contract even though it exits 1", async () => {
  const { doctorAndroid } = await loadDoctor();
  const helpExit = Object.assign(new Error("Command failed: avdmanager --help"), {
    code: 1,
    stdout: [
      "",
      "Usage:",
      "      avdmanager [global options] [action] [action options]",
      "      Global options:",
      "  -h --help       : Help on a specific command.",
      "",
    ].join("\n"),
    stderr: "",
  });
  const harness = createHarness({ commandErrors: { avdmanager: helpExit } });

  const result = await doctorAndroid(structuredClone(validConfig), harness.deps);

  assert.equal(result.tools.avdmanager.path, SDK_TOOLS.avdmanager);
  assert.deepEqual(
    harness.calls.filter(({ executable }) => executable === SDK_TOOLS.avdmanager)
      .map(({ executable, args, options }) => ({ executable, args, options })),
    [{
      executable: SDK_TOOLS.avdmanager,
      args: ["--help"],
      options: {
        env: { ANDROID_SDK_ROOT: SDK_ROOT },
        shell: false,
        timeout: 5000,
        maxBuffer: 4 * 1024 * 1024,
      },
    }],
  );
});

test("rejects an avdmanager command failure that only resembles help output", async () => {
  const { doctorAndroid } = await loadDoctor();
  const invalidCommand = Object.assign(new Error("Command failed: avdmanager invalid"), {
    code: 1,
    stdout: [
      "",
      "Usage:",
      "      avdmanager [global options] [action] [action options]",
      "",
    ].join("\n"),
    stderr: "Error: Expected verb after global parameters but found 'invalid' instead.\n",
  });

  await assert.rejects(
    doctorAndroid(
      structuredClone(validConfig),
      createHarness({ commandErrors: { avdmanager: invalidCommand } }).deps,
    ),
    /Command failed: avdmanager invalid/,
  );
});

test("discovers canonical Android and external tools without returning action secrets", async () => {
  const { doctorAndroid } = await loadDoctor();
  assert.equal(typeof doctorAndroid, "function", "doctorAndroid must be exported");
  const harness = createHarness();

  const result = await doctorAndroid(validConfig, harness.deps);

  assert.deepEqual(result, {
    ok: true,
    capture: {
      kind: "android-emulator",
      cluster: { kind: "disposable-kind" },
      android: {
        expectedApplicationId: "dev.ambientcode.mobile",
        apk: "repo:components/mobile/dist/ambient-mobile.apk",
        apkLock: "repo:components/mobile/dist/ambient-mobile.apk.lock.json",
        launchActivity: "dev.ambientcode.mobile/.MainActivity",
        systemImage: SYSTEM_IMAGE,
        actionSettlingMilliseconds: 900,
        setupActionCount: 1,
        actionCount: 1,
      },
    },
    sdk: {
      root: SDK_ROOT,
      systemImage: { package: SYSTEM_IMAGE, revision: "14", installed: true },
    },
    tools: {
      adb: { path: SDK_TOOLS.adb, identity: "Android Debug Bridge version 1.0.41" },
      emulator: { path: SDK_TOOLS.emulator, identity: "Android emulator version 35.4.9.0 (build_id 12790177)" },
      sdkmanager: { path: SDK_TOOLS.sdkmanager, identity: "sdkmanager", version: "cmdline-tools 19.0" },
      avdmanager: { path: SDK_TOOLS.avdmanager, identity: "avdmanager", version: "cmdline-tools 19.0" },
      apkanalyzer: { path: SDK_TOOLS.apkanalyzer, identity: "apkanalyzer", version: "cmdline-tools 19.0" },
      kind: { path: EXTERNAL_TOOLS.kind, identity: "kind v0.30.0 go1.24.0 darwin/arm64" },
      kubectl: { path: EXTERNAL_TOOLS.kubectl, identity: "kubectl v1.33.3" },
      docker: { path: EXTERNAL_TOOLS.docker, identity: "Docker version 28.3.2, build 578ccf6" },
      git: { path: EXTERNAL_TOOLS.git, identity: "git version 2.50.1" },
      make: { path: EXTERNAL_TOOLS.make, identity: "GNU Make 3.81" },
      ffmpeg: { path: EXTERNAL_TOOLS.ffmpeg, identity: "ffmpeg version 7.1.1 Copyright (c) the FFmpeg developers" },
      ffprobe: { path: EXTERNAL_TOOLS.ffprobe, identity: "ffprobe version 7.1.1 Copyright (c) the FFmpeg developers" },
    },
  });
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.capture.android));
  assert.ok(Object.isFrozen(result.tools.adb));
  assert.equal(JSON.stringify(result).includes("ACP_BEARER_TOKEN"), false);
  assert.equal(JSON.stringify(result).includes("visible-demo-input"), false);
  assert.equal(JSON.stringify(result).includes("Demo field"), false);
  assert.equal(JSON.stringify(result).includes("Access token"), false);
  assert.deepEqual(
    harness.resolverCalls.filter(({ name }) => Object.hasOwn(SDK_TOOLS, name)).map(({ name }) => name),
    Object.keys(SDK_TOOLS),
  );
  assert.deepEqual(
    harness.resolverCalls.filter(({ name }) => Object.hasOwn(EXTERNAL_TOOLS, name)).map(({ name }) => name),
    Object.keys(EXTERNAL_TOOLS),
  );
  assert.ok(
    harness.calls.some(({ executable, args }) => executable === SDK_TOOLS.sdkmanager
      && JSON.stringify(args) === JSON.stringify(["--list_installed"])),
    "doctor must query the exact installed system-image set",
  );
  assert.deepEqual(
    harness.calls.filter(({ executable }) => executable === SDK_TOOLS.avdmanager).map(({ args }) => args),
    [["--help"]],
  );
  assert.deepEqual(
    harness.calls.filter(({ executable }) => executable === SDK_TOOLS.apkanalyzer).map(({ args }) => args),
    [["--help"]],
  );
});

test("accepts the bounded parenthesized vendor suffix emitted by Apple Git", async () => {
  const { doctorAndroid } = await loadDoctor();
  const harness = createHarness({
    identities: {
      git: { stdout: "git version 2.50.1 (Apple Git-155)\n", stderr: "" },
    },
  });

  const result = await doctorAndroid(structuredClone(validConfig), harness.deps);

  assert.equal(result.tools.git.identity, "git version 2.50.1 (Apple Git-155)");
});

test("preserves unique Git identity proof when a vendor suffix is present", async () => {
  const { doctorAndroid } = await loadDoctor();
  const harness = createHarness({
    identities: {
      git: {
        stdout: "git version 2.50.1 (Apple Git-155)\ngit version 9.99.0\n",
        stderr: "",
      },
    },
  });

  await assert.rejects(
    doctorAndroid(structuredClone(validConfig), harness.deps),
    /git identity output is ambiguous/,
  );
});

test("rejects malformed or unbounded Git vendor suffixes", async () => {
  const { doctorAndroid } = await loadDoctor();
  const invalidOutputs = [
    "git version 2.50.1 Apple Git-155\n",
    "git version 2.50.1 (Apple Git-155) trailing\n",
    `git version 2.50.1 (${"A".repeat(65)})\n`,
  ];

  for (const stdout of invalidOutputs) {
    const harness = createHarness({ identities: { git: { stdout, stderr: "" } } });
    await assert.rejects(
      doctorAndroid(structuredClone(validConfig), harness.deps),
      /git identity output is ambiguous/,
    );
  }
});

test("passes only a closed tool environment to every doctor subprocess", async () => {
  const { doctorAndroid } = await loadDoctor();
  const harness = createHarness({
    env: {
      ANDROID_SDK_ROOT: SDK_ROOT,
      HOME: "/safe/home",
      JAVA_HOME: "/safe/java",
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      PATH: "/safe/bin",
      TEMP: "/safe/temp",
      TMP: "/safe/tmp",
      TMPDIR: "/safe/tmpdir",
      ACP_URL: "https://sentinel.invalid",
      ACP_PROJECT: "sentinel-project",
      ACP_BEARER_TOKEN: "sentinel-bearer",
      UNRELATED_SECRET: "sentinel-unrelated",
    },
  });

  await doctorAndroid(structuredClone(validConfig), harness.deps);

  assert.ok(harness.calls.length > 0);
  for (const { options } of harness.calls) {
    assert.deepEqual(options.env, {
      ANDROID_SDK_ROOT: SDK_ROOT,
      HOME: "/safe/home",
      JAVA_HOME: "/safe/java",
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      PATH: "/safe/bin",
      TEMP: "/safe/temp",
      TMP: "/safe/tmp",
      TMPDIR: "/safe/tmpdir",
    });
    const serialized = JSON.stringify(options.env);
    for (const sentinel of [
      "sentinel.invalid",
      "sentinel-project",
      "sentinel-bearer",
      "sentinel-unrelated",
    ]) {
      assert.equal(serialized.includes(sentinel), false, sentinel);
    }
  }
});

test("retains the exact portable installed system-image revision without its SDK location", async () => {
  const { doctorAndroid } = await loadDoctor();
  const privateLocation = "/Users/demo/private-sdk/system-images/android-35/google_apis/arm64-v8a";
  const harness = createHarness({
    systemImageResult: {
      stdout: `${SYSTEM_IMAGE} | 14.0.1 | exact match | ${privateLocation}\n`,
      stderr: "",
    },
  });

  const result = await doctorAndroid(structuredClone(validConfig), harness.deps);

  assert.deepEqual(result.sdk.systemImage, {
    package: SYSTEM_IMAGE,
    revision: "14.0.1",
    installed: true,
  });
  assert.equal(JSON.stringify(result.sdk.systemImage).includes(privateLocation), false);
});

test("refuses ambiguous or nonportable installed system-image revisions", async () => {
  const { doctorAndroid } = await loadDoctor();
  for (const systemImageResult of [
    {
      stdout: `${SYSTEM_IMAGE} | ../../private | invalid revision | private/location\n`,
      stderr: "",
    },
    {
      stdout: `${SYSTEM_IMAGE} | 1234567 | too long | private/location\n`,
      stderr: "",
    },
    {
      stdout: `${SYSTEM_IMAGE} | 1.2.3.4.5 | too many components | private/location\n`,
      stderr: "",
    },
    {
      stdout: [
        `${SYSTEM_IMAGE} | 14 | first revision | first/location`,
        `${SYSTEM_IMAGE} | 15 | conflicting revision | second/location`,
      ].join("\n"),
      stderr: "",
    },
  ]) {
    await assert.rejects(
      doctorAndroid(structuredClone(validConfig), createHarness({ systemImageResult }).deps),
      /system image revision (?:is invalid|is ambiguous)/,
    );
  }
});

test("accepts a bounded scenario application ID without hardcoding the example app", async () => {
  const { doctorAndroid } = await loadDoctor();
  const config = structuredClone(validConfig);
  config.android.expectedApplicationId = "com.example.mobile_demo";
  config.android.launchActivity = "com.example.mobile_demo/.DemoActivity";

  const result = await doctorAndroid(config, createHarness().deps);

  assert.equal(result.capture.android.expectedApplicationId, "com.example.mobile_demo");
  assert.equal(result.capture.android.launchActivity, "com.example.mobile_demo/.DemoActivity");
});

test("uses the shared 300-character launch activity boundary", async () => {
  const { doctorAndroid } = await loadDoctor();
  const applicationId = validConfig.android.expectedApplicationId;
  const exactMaximum = `${applicationId}/.${"A".repeat(
    ANDROID_LAUNCH_ACTIVITY_MAX_CHARACTERS - applicationId.length - 2,
  )}`;
  const accepted = structuredClone(validConfig);
  accepted.android.launchActivity = exactMaximum;
  assert.equal(exactMaximum.length, 300);
  assert.equal(
    (await doctorAndroid(accepted, createHarness().deps)).capture.android.launchActivity,
    exactMaximum,
  );

  const rejected = structuredClone(validConfig);
  rejected.android.launchActivity = `${exactMaximum}A`;
  await assert.rejects(
    doctorAndroid(rejected, createHarness().deps),
    /launchActivity is invalid/,
  );
});

test("accepts bounded integer and dotted Android SDK system-image identifiers", async () => {
  const { doctorAndroid } = await loadDoctor();
  for (const systemImage of [
    "system-images;android-36;google_apis;arm64-v8a",
    "system-images;android-36.1;google_apis_playstore;arm64-v8a",
  ]) {
    const config = structuredClone(validConfig);
    config.android.systemImage = systemImage;
    const harness = createHarness({
      systemImageResult: {
        stdout: `${systemImage} | 1 | exact match | ${systemImage.replaceAll(";", "/")}\n`,
        stderr: "",
      },
    });

    const result = await doctorAndroid(config, harness.deps);

    assert.equal(result.capture.android.systemImage, systemImage);
    assert.deepEqual(result.sdk.systemImage, { package: systemImage, revision: "1", installed: true });
  }
});

test("refuses malformed Android SDK system-image identifiers before tool discovery", async () => {
  const { doctorAndroid } = await loadDoctor();
  for (const systemImage of [
    "system-images;android-36.;google_apis;arm64-v8a",
    "system-images;android-36.1.2;google_apis;arm64-v8a",
    "system-images;android-.1;google_apis;arm64-v8a",
  ]) {
    const config = structuredClone(validConfig);
    config.android.systemImage = systemImage;
    const harness = createHarness();

    await assert.rejects(doctorAndroid(config, harness.deps), /systemImage is invalid/);
    assert.equal(harness.resolverCalls.length, 0, systemImage);
  }
});

test("refuses unsupported or unbounded Android capture config before tool discovery", async () => {
  const { doctorAndroid } = await loadDoctor();
  const cases = [
    [() => null, /config must be an object/],
    [(config) => { config.kind = "browser"; }, /kind must be android-emulator/],
    [(config) => { config.cluster.kind = "shared"; }, /cluster kind must be disposable-kind/],
    [(config) => { config.cluster.name = "shared"; }, /cluster\.name is not supported/],
    [(config) => { config.arbitrary = true; }, /config\.arbitrary is not supported/],
    [(config) => { config.android.expectedApplicationId = "Not An Application"; }, /expectedApplicationId/],
    [(config) => {
      config.android.expectedApplicationId = `a.${"b".repeat(201)}`;
      config.android.launchActivity = `${config.android.expectedApplicationId}/.MainActivity`;
    }, /expectedApplicationId/],
    [(config) => { delete config.android.launchActivity; }, /launchActivity/],
    [(config) => { config.android.launchActivity = "dev.ambientcode.mobile/.MainActivity; rm -rf /"; }, /launchActivity/],
    [(config) => { config.android.launchActivity = "dev.example.mobile/.MainActivity"; }, /launchActivity package must match/],
    [(config) => { config.android.apk = "components/mobile/app.apk"; }, /apk must be a canonical repo:/],
    [(config) => { config.android.apk = "repo:/components/mobile/app.apk"; }, /apk must be a canonical repo:/],
    [(config) => { config.android.apk = "repo:components/mobile/../app.apk"; }, /apk must be a canonical repo:/],
    [(config) => { config.android.apk = "repo:components//mobile/app.apk"; }, /apk must be a canonical repo:/],
    [(config) => { config.android.apk = "repo:components\\mobile\\app.apk"; }, /apk must be a canonical repo:/],
    [(config) => { config.android.apk = "repo:components/mobile/app.zip"; }, /apk must reference an \.apk/],
    [(config) => { delete config.android.apkLock; }, /apkLock must be a canonical repo:/],
    [(config) => { config.android.apkLock = "repo:components/mobile/./app.lock.json"; }, /apkLock must be a canonical repo:/],
    [(config) => { config.android.systemImage = "system-images;android-35;google_apis;armeabi-v7a"; }, /systemImage/],
    [(config) => { config.android.setupActions = {}; }, /setupActions must be an array/],
    [(config) => { config.android.setupActions = Array.from({ length: 101 }, () => ({ action: "wait", ms: 1 })); }, /setupActions must contain no more than 100/],
    [(config) => { delete config.android.actions; }, /actions must be an array/],
    [(config) => { config.android.actions = {}; }, /actions must be an array/],
    [(config) => { config.android.actions = Array.from({ length: 101 }, () => ({ action: "wait", ms: 1 })); }, /actions must contain no more than 100/],
    [(config) => { config.android.actions = [{ action: "back", arbitrary: true }]; }, /must contain only action/],
    [(config) => {
      config.android.actions = [{
        action: "fillFromEnvironment",
        selector: { by: "text", value: "Token" },
        environment: "ACP_BEARER_TOKEN",
      }];
    }, /allowed only during pre-recording/],
    [(config) => { config.android.setupActions[0].environment = "DEMO_CLUSTER_TOKEN"; }, /approved ACP environment key/],
    [(config) => {
      config.android.actions = [{
        action: "fill",
        selector: { by: "text", value: "Token" },
        value: "Authorization: Bearer abcdefghijklmnopqrstuvwxyz",
      }];
    }, /credential-like material/],
    [(config) => { config.android.actions = [{ action: "tap", selector: { by: "xpath", value: "//*" } }]; }, /selector\.by/],
    [(config) => { config.android.actionSettlingMilliseconds = 899; }, /actionSettlingMilliseconds must be 900/],
    [(config) => { config.android.token = "must-not-be-accepted"; }, /android\.token is not supported/],
  ];

  for (const [mutate, expectedError] of cases) {
    const harness = createHarness();
    const config = structuredClone(validConfig);
    const mutated = mutate(config);
    const candidate = mutated === undefined ? config : mutated;
    await assert.rejects(doctorAndroid(candidate, harness.deps), expectedError);
    assert.equal(harness.resolverCalls.length, 0, JSON.stringify(candidate));
  }
});

test("refuses empty or ambiguous tool identities", async () => {
  const { doctorAndroid } = await loadDoctor();
  for (const name of Object.keys(TOOL_PATHS)) {
    const harness = createHarness({ identities: { [name]: { stdout: "", stderr: "" } } });
    await assert.rejects(
      doctorAndroid(structuredClone(validConfig), harness.deps),
      new RegExp(["avdmanager", "apkanalyzer"].includes(name)
        ? `${name} runnable proof output is empty`
        : `${name} identity output is empty`),
    );
  }

  // kubectl writes warnings to stderr even on success; the identity must come
  // from stdout and tolerate a non-empty stderr.
  const kubectlWithStderrWarning = createHarness({
    identities: {
      kubectl: {
        stdout: '{"clientVersion":{"gitVersion":"v1.33.3"}}\n',
        stderr: "W0101 kubectl version warning\n",
      },
    },
  });
  const warned = await doctorAndroid(structuredClone(validConfig), kubectlWithStderrWarning.deps);
  assert.equal(warned.tools.kubectl.identity, "kubectl v1.33.3");

  const ambiguousKubectl = createHarness({
    identities: {
      kubectl: {
        stdout: "not json output\n",
        stderr: "",
      },
    },
  });
  await assert.rejects(
    doctorAndroid(structuredClone(validConfig), ambiguousKubectl.deps),
    /kubectl identity output is ambiguous/,
  );
});

test("binds every command-line SDK tool to the sdkmanager package root", async () => {
  const { doctorAndroid } = await loadDoctor();
  const otherAvdmanager = `${SDK_ROOT}/cmdline-tools/18.0/bin/avdmanager`;
  const harness = createHarness({
    toolPaths: { avdmanager: otherAvdmanager },
    realpaths: { [otherAvdmanager]: otherAvdmanager },
    statKinds: { [otherAvdmanager]: "file" },
  });

  await assert.rejects(
    doctorAndroid(structuredClone(validConfig), harness.deps),
    /avdmanager must share the sdkmanager cmdline-tools package root/,
  );
});

test("default SDK discovery prefers latest, then the newest installed cmdline-tools version", async () => {
  const { doctorAndroid } = await loadDoctor();
  const cmdlineNames = ["sdkmanager", "avdmanager", "apkanalyzer"];
  const version18 = Object.fromEntries(cmdlineNames.map((name) => [
    `${SDK_ROOT}/cmdline-tools/18.0/bin/${name}`,
    `${SDK_ROOT}/cmdline-tools/18.0/bin/${name}`,
  ]));
  const version19 = Object.fromEntries(cmdlineNames.map((name) => [
    `${SDK_ROOT}/cmdline-tools/19.0/bin/${name}`,
    `${SDK_ROOT}/cmdline-tools/19.0/bin/${name}`,
  ]));
  const versionStats = Object.fromEntries([...Object.keys(version18), ...Object.keys(version19)]
    .map((toolPath) => [toolPath, "file"]));
  const harness = createHarness({
    env: { ANDROID_SDK_ROOT: SDK_ROOT, PATH: "/usr/local/bin:/usr/bin" },
    cmdlineToolVersions: ["18.0", "19.0"],
    realpaths: { ...version18, ...version19 },
    statKinds: versionStats,
  });
  delete harness.deps.resolveExecutable;

  const newest = await doctorAndroid(structuredClone(validConfig), harness.deps);

  for (const name of cmdlineNames) {
    assert.equal(newest.tools[name].path, `${SDK_ROOT}/cmdline-tools/19.0/bin/${name}`);
  }

  const latest = Object.fromEntries(cmdlineNames.map((name) => [
    `${SDK_ROOT}/cmdline-tools/latest/bin/${name}`,
    `${SDK_ROOT}/cmdline-tools/latest/bin/${name}`,
  ]));
  const latestHarness = createHarness({
    env: { ANDROID_SDK_ROOT: SDK_ROOT, PATH: "/usr/local/bin:/usr/bin" },
    cmdlineToolVersions: ["18.0", "19.0"],
    realpaths: { ...version18, ...version19, ...latest },
    statKinds: {
      ...versionStats,
      ...Object.fromEntries(Object.keys(latest).map((toolPath) => [toolPath, "file"])),
    },
  });
  delete latestHarness.deps.resolveExecutable;

  const exactLatest = await doctorAndroid(structuredClone(validConfig), latestHarness.deps);

  for (const name of cmdlineNames) {
    assert.equal(exactLatest.tools[name].path, `${SDK_ROOT}/cmdline-tools/latest/bin/${name}`);
  }
});

test("requires the exact requested Android system image to be installed", async () => {
  const { doctorAndroid } = await loadDoctor();
  const harness = createHarness({
    systemImageResult: {
      stdout: [
        "Installed packages:",
        "Path | Version | Description | Location",
        "system-images;android-35;google_apis;x86_64 | 14 | wrong ABI | somewhere",
        "system-images;android-350;google_apis;arm64-v8a | 1 | wrong API | somewhere",
        "",
      ].join("\n"),
      stderr: "",
    },
  });

  await assert.rejects(
    doctorAndroid(structuredClone(validConfig), harness.deps),
    new RegExp(`required Android system image is not installed: ${SYSTEM_IMAGE}`),
  );
});

test("refuses untrusted SDK roots and tool paths", async () => {
  const { doctorAndroid } = await loadDoctor();
  const cases = [
    [{ env: {} }, /ANDROID_SDK_ROOT or ANDROID_HOME is required/],
    [{ env: { ANDROID_SDK_ROOT: "/missing/android-sdk" } }, /Android SDK root does not exist/],
    [{
      env: { ANDROID_SDK_ROOT: SDK_ROOT, ANDROID_HOME: "/opt/other-sdk" },
      realpaths: { "/opt/other-sdk": "/opt/other-sdk" },
    }, /ANDROID_SDK_ROOT and ANDROID_HOME conflict/],
    [{ toolPaths: { adb: undefined } }, /required tool adb was not resolved/],
    [{
      toolPaths: { adb: `${SDK_ROOT}/platform-tools/missing-adb` },
    }, /required tool adb does not exist/],
    [{
      nonExecutable: [SDK_TOOLS.adb],
    }, /required tool adb is not executable/],
    [{
      statKinds: { [SDK_TOOLS.adb]: "directory" },
    }, /required tool adb is not a file/],
    [{
      toolPaths: { adb: "/usr/local/bin/adb" },
      realpaths: { "/usr/local/bin/adb": "/usr/local/bin/adb" },
      statKinds: { "/usr/local/bin/adb": "file" },
    }, /Android SDK tool adb resolves outside/],
    [{
      toolPaths: { adb: `${SDK_ROOT}/platform-tools/adb-symlink` },
      realpaths: { [`${SDK_ROOT}/platform-tools/adb-symlink`]: SDK_TOOLS.adb },
    }, /Android SDK tool adb path is not canonical/],
  ];

  for (const [overrides, expectedError] of cases) {
    const harness = createHarness(overrides);
    await assert.rejects(doctorAndroid(structuredClone(validConfig), harness.deps), expectedError);
  }
});
