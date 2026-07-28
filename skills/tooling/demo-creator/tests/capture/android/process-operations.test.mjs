import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";

let processOperations = {};
try {
  processOperations = await import("../../../scripts/capture/android/process-operations.mjs");
} catch (error) {
  if (error?.code !== "ERR_MODULE_NOT_FOUND") throw error;
}

const PROCESS_OPERATION_NAMES = Object.freeze([
  "launchOwnedEmulator",
  "probeAndroidRecording",
  "remuxAndroidScreenrecord",
  "rollbackOwnedEmulator",
  "runKindMakePlan",
  "startAndroidScreenrecord",
  "stopAndroidScreenrecord",
  "waitForOwnedAvdBoot",
]);

function stat({ type, mode, size = 0 }) {
  return {
    mode,
    size,
    isDirectory: () => type === "directory",
    isFile: () => type === "file",
    isSymbolicLink: () => type === "symlink",
  };
}

function fakeFileSystem() {
  const entries = new Map([
    ["/usr/bin/make", stat({ type: "file", mode: 0o755 })],
    ["/sdk/emulator", stat({ type: "file", mode: 0o755 })],
    ["/sdk/adb", stat({ type: "file", mode: 0o755 })],
    ["/usr/bin/ffprobe", stat({ type: "file", mode: 0o755 })],
    ["/repo", stat({ type: "directory", mode: 0o755 })],
    ["/private/run", stat({ type: "directory", mode: 0o700 })],
    ["/private/run/kind-workspace", stat({ type: "directory", mode: 0o700 })],
    ["/private/run/home", stat({ type: "directory", mode: 0o700 })],
    ["/private/run/tmp", stat({ type: "directory", mode: 0o700 })],
    ["/private/run/xdg-config", stat({ type: "directory", mode: 0o700 })],
    ["/private/run/xdg-runtime", stat({ type: "directory", mode: 0o700 })],
    ["/private/run/kind-state", stat({ type: "directory", mode: 0o700 })],
    ["/private/run/kind-state/legacy", stat({ type: "directory", mode: 0o700 })],
    ["/private/run/kubeconfig", stat({ type: "file", mode: 0o600 })],
    ["/private/avds", stat({ type: "directory", mode: 0o700 })],
    ["/public/run", stat({ type: "directory", mode: 0o755 })],
    ["/public/run/kubeconfig", stat({ type: "file", mode: 0o644 })],
    ["/private/output", stat({ type: "directory", mode: 0o700 })],
    ["/private/output/stage", stat({ type: "directory", mode: 0o700 })],
    ["/private/output/.adb-screenrecord-test", stat({ type: "directory", mode: 0o700 })],
    ["/private/output/stage/screenrecord.mp4", stat({ type: "file", mode: 0o644 })],
  ]);
  const aliases = new Map();
  return {
    aliases,
    entries,
    async lstat(pathname) {
      const entry = entries.get(pathname);
      if (entry) return entry;
      const error = new Error(`missing ${pathname}`);
      error.code = "ENOENT";
      throw error;
    },
    async realpath(pathname) {
      if (aliases.has(pathname)) return aliases.get(pathname);
      if (entries.has(pathname)) return pathname;
      const error = new Error(`missing ${pathname}`);
      error.code = "ENOENT";
      throw error;
    },
    async open(pathname, _flags, mode) {
      if (pathname !== "/private/output/.adb-screenrecord-test/screenrecord.h264") {
        throw Object.assign(new Error(`refusing open ${pathname}`), { code: "ENOENT" });
      }
      if (entries.has(pathname)) {
        throw Object.assign(new Error(`existing ${pathname}`), { code: "EEXIST" });
      }
      let size = 0;
      const update = () => entries.set(pathname, stat({ type: "file", mode, size }));
      update();
      return {
        async write(_bytes, _offset, length) {
          size += length;
          update();
          return { bytesWritten: length };
        },
        async sync() {},
        async close() {},
      };
    },
  };
}

function emulatorPlan(overrides = {}) {
  const base = {
    executable: "/sdk/emulator",
    args: [
      "-avd",
      "acp-demo-onboarding-run-7-c0ffee123456",
      "-no-snapshot-save",
      "-no-audio",
      "-no-boot-anim",
      "-vsync-rate",
      "30",
    ],
    avdName: "acp-demo-onboarding-run-7-c0ffee123456",
  };
  return { ...base, ...overrides };
}

function fakeChild(pid, onKill = () => {}) {
  const child = new EventEmitter();
  Object.assign(child, {
    pid,
    exitCode: null,
    signalCode: null,
    kills: [],
    kill(signal) {
      this.kills.push(signal);
      onKill(this, signal);
      if (this.exitCode !== null || this.signalCode !== null) {
        this.stdout.end();
        this.stderr.end();
        this.emit("exit", this.exitCode, this.signalCode);
        this.emit("close", this.exitCode, this.signalCode);
      }
      return true;
    },
  });
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdout.write(Buffer.from([
    0, 0, 0, 1, 0x67, 0x42, 0, 0x1f,
    0, 0, 0, 1, 0x68, 0xce, 6, 0xe2,
    0, 0, 0, 1, 0x65, 0x88, 0x84, 0x21,
    0, 0, 0, 1, 0x41, 0x9a, 0x10, 0x22,
  ]));
  return child;
}

function fakeClock() {
  let now = 0;
  return {
    nowMilliseconds: () => now,
    sleep: async (milliseconds) => { now += milliseconds; },
  };
}

function processRegistry() {
  return { emulators: new Map(), recorders: new Map() };
}

function trackedRecorderFileSystem() {
  const fs = fakeFileSystem();
  const open = fs.open.bind(fs);
  let closeCalls = 0;
  fs.open = async (...args) => {
    const handle = await open(...args);
    const close = handle.close.bind(handle);
    handle.close = async () => {
      closeCalls += 1;
      return close();
    };
    return handle;
  };
  return { fs, closeCalls: () => closeCalls };
}

function ownedAvd(overrides = {}) {
  return {
    avdName: emulatorPlan().avdName,
    serial: "emulator-5554",
    consolePort: 5554,
    pid: 4321,
    processStartIdentity: "owned-start",
    ...overrides,
  };
}

function screenrecordStep(overrides = {}) {
  const base = {
    executable: "/sdk/adb",
    args: [
      "-s",
      "emulator-5554",
      "exec-out",
      "screenrecord",
      "--output-format=h264",
      "--size",
      "1080x1920",
      "--bit-rate",
      "12000000",
      "--time-limit",
      "42",
      "-",
    ],
    rawOutputPath: "/private/output/.adb-screenrecord-test/screenrecord.h264",
  };
  return { ...base, ...overrides };
}

function registerEmulator(registry, ownership, child = fakeChild(ownership.pid)) {
  registry.emulators.set(ownership.avdName, Object.freeze({
    ...ownership,
    child,
    launchArgs: Object.freeze([...emulatorPlan().args, "-port", String(ownership.consolePort)]),
  }));
  return child;
}

function kindPlan(overrides = {}) {
  const base = {
    executable: "/usr/bin/make",
    args: ["kind-up"],
    cwd: "/private/run/kind-workspace",
    environment: {
      ACP_KIND_CONNECTIONS_FILE: "/private/run/kind-state/connections.json",
      ACP_KIND_LEGACY_STATE_ROOT: "/private/run/kind-state/legacy",
      KIND_CLUSTER_NAME: "acp-demo-onboarding-run-7-nonce",
      CONTAINER_ENGINE: "docker",
      DOCKER_ONLY_KIND_CLUSTER: "true",
      EXPECTED_KIND_CONTAINER_IDS: "",
      HOME: "/private/run/home",
      KIND_FWD_AMBIENT_UI_PORT: "42103",
      KIND_FWD_API_SERVER_PORT: "42102",
      KIND_FWD_BACKEND_PORT: "42101",
      KIND_FWD_FRONTEND_PORT: "42100",
      KIND_FWD_KEYCLOAK_PORT: "42104",
      KIND_CREATION_PROOF_FILE: "/private/run/kind-state/creation-container-ids",
      KIND_HTTP_PORT: "42105",
      KIND_HTTPS_PORT: "42106",
      KIND_PF_ROOT: "/private/run/kind-state",
      KUBECONFIG: "/private/run/kubeconfig",
      REQUIRE_NEW_KIND_CLUSTER: "true",
      TMPDIR: "/private/run/tmp",
      XDG_CONFIG_HOME: "/private/run/xdg-config",
      XDG_RUNTIME_DIR: "/private/run/xdg-runtime",
    },
  };
  return {
    ...base,
    ...overrides,
    environment: { ...base.environment, ...overrides.environment },
  };
}

test("creates the complete frozen Android process-operation boundary", () => {
  assert.equal(typeof processOperations.createAndroidProcessOperations, "function");
  const operations = processOperations.createAndroidProcessOperations();
  assert.deepEqual(Object.keys(operations).sort(), PROCESS_OPERATION_NAMES);
  assert.equal(Object.isFrozen(operations), true);
  for (const name of PROCESS_OPERATION_NAMES) {
    assert.equal(typeof operations[name], "function", name);
  }
});

test("runs only an exact bounded Kind Make plan with a private kubeconfig", async () => {
  const fs = fakeFileSystem();
  const secret = "do-not-print-this";
  const baseEnvironment = { PATH: "/unsafe/bin", ACP_BEARER_TOKEN: secret };
  const toolEnvironment = { PATH: "/usr/bin", ACP_OTHER_SECRET: secret };
  const calls = [];
  const operations = processOperations.createAndroidProcessOperations({
    fs,
    baseEnvironment,
    toolEnvironment,
    readKindCreationProof: async () => ["a".repeat(64)],
    runCommand: async (...args) => {
      calls.push(args);
      return { stdout: "created\n", stderr: "", exitCode: 0 };
    },
  });

  const creationWitness = Object.freeze({ opaque: true });
  const result = await operations.runKindMakePlan(kindPlan(), {
    completeKindCreation: async (evidence) => {
      assert.deepEqual(evidence.containerIdentities, ["a".repeat(64)]);
      return creationWitness;
    },
  });

  assert.equal(result.stdout, "created\n");
  assert.equal(result.creationWitness, creationWitness);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], [
    "/usr/bin/make",
    ["kind-up"],
    {
      cwd: "/private/run/kind-workspace",
      env: {
        PATH: "/usr/bin",
        ACP_KIND_CONNECTIONS_FILE: "/private/run/kind-state/connections.json",
        ACP_KIND_LEGACY_STATE_ROOT: "/private/run/kind-state/legacy",
        KIND_CLUSTER_NAME: "acp-demo-onboarding-run-7-nonce",
        CONTAINER_ENGINE: "docker",
        DOCKER_ONLY_KIND_CLUSTER: "true",
        EXPECTED_KIND_CONTAINER_IDS: "",
        HOME: "/private/run/home",
        KIND_FWD_AMBIENT_UI_PORT: "42103",
        KIND_FWD_API_SERVER_PORT: "42102",
        KIND_FWD_BACKEND_PORT: "42101",
        KIND_FWD_FRONTEND_PORT: "42100",
        KIND_FWD_KEYCLOAK_PORT: "42104",
        KIND_CREATION_PROOF_FILE: "/private/run/kind-state/creation-container-ids",
        KIND_HTTP_PORT: "42105",
        KIND_HTTPS_PORT: "42106",
        KIND_PF_ROOT: "/private/run/kind-state",
        KUBECONFIG: "/private/run/kubeconfig",
        REQUIRE_NEW_KIND_CLUSTER: "true",
        TMPDIR: "/private/run/tmp",
        XDG_CONFIG_HOME: "/private/run/xdg-config",
        XDG_RUNTIME_DIR: "/private/run/xdg-runtime",
      },
      maxOutputBytes: 4 * 1024 * 1024,
      shell: false,
      timeoutMilliseconds: 15 * 60 * 1000,
    },
  ]);
  assert.deepEqual(baseEnvironment, { PATH: "/unsafe/bin", ACP_BEARER_TOKEN: secret });
  assert.deepEqual(toolEnvironment, { PATH: "/usr/bin", ACP_OTHER_SECRET: secret });
});

test("refuses non-exact Make plans before invoking the runner", async (context) => {
  const fs = fakeFileSystem();
  const calls = [];
  const operations = processOperations.createAndroidProcessOperations({
    fs,
    runCommand: async (...args) => {
      calls.push(args);
      return { stdout: "", stderr: "", exitCode: 0 };
    },
  });
  const cases = [
    ["non-Make executable", kindPlan({ executable: "/bin/sh" }), /make executable/i],
    ["extra executable text", kindPlan({ executable: "/usr/bin/make --silent" }), /make executable/i],
    ["unsupported target", kindPlan({ args: ["kind-rebuild"] }), /kind-up or kind-down/i],
    ["extra target", kindPlan({ args: ["kind-up", "kind-down"] }), /single target/i],
    ["relative cwd", kindPlan({ cwd: "../repo" }), /cwd.*absolute/i],
    ["source checkout cwd", kindPlan({ cwd: "/repo" }), /cwd.*private runtime|kind-workspace/i],
    ["non-generated cluster", kindPlan({ environment: { KIND_CLUSTER_NAME: "shared" } }), /generated cluster/i],
    ["wrong engine", kindPlan({ environment: { CONTAINER_ENGINE: "podman" } }), /docker/i],
    ["relative kubeconfig", kindPlan({ environment: { KUBECONFIG: "run/kubeconfig" } }), /kubeconfig.*absolute/i],
    ["public kubeconfig", kindPlan({ environment: { KUBECONFIG: "/public/run/kubeconfig" } }), /private/i],
    ["kind-down without exact IDs", kindPlan({ args: ["kind-down"] }), /container identit/i],
    ["kind-up with deletion IDs", kindPlan({ environment: { EXPECTED_KIND_CONTAINER_IDS: "a".repeat(64) } }), /kind-up.*container identit/i],
    ["kind-down duplicate IDs", kindPlan({
      args: ["kind-down"],
      environment: { EXPECTED_KIND_CONTAINER_IDS: `${"a".repeat(64)},${"a".repeat(64)}` },
    }), /duplicate|canonical/i],
  ];
  for (const [name, plan, pattern] of cases) {
    await context.test(name, async () => {
      await assert.rejects(operations.runKindMakePlan(plan), pattern);
    });
  }
  await context.test("extra environment key", async () => {
    const plan = kindPlan();
    plan.environment.EXTRA = "not-allowed";
    await assert.rejects(operations.runKindMakePlan(plan), /environment must contain exactly/i);
  });
  await context.test("symlink cwd", async () => {
    fs.entries.set("/private/run/kind-workspace", stat({ type: "symlink", mode: 0o700 }));
    fs.aliases.set("/private/run/kind-workspace", "/repo");
    await assert.rejects(operations.runKindMakePlan(kindPlan()), /cwd.*canonical/i);
  });
  assert.deepEqual(calls, []);
});

test("redacts inherited environment values when Kind Make fails", async () => {
  const secret = "runner-error-secret";
  const operations = processOperations.createAndroidProcessOperations({
    fs: fakeFileSystem(),
    baseEnvironment: { ACP_BEARER_TOKEN: secret },
    runCommand: async () => {
      throw new Error(`failed with ${secret}`);
    },
  });

  await assert.rejects(
    operations.runKindMakePlan(kindPlan(), { completeKindCreation: async () => ({}) }),
    (error) => error.message === "Kind Make target kind-up failed"
      && !String(error).includes(secret)
      && Object.getOwnPropertyDescriptor(error, "kindCreationEvidence") === undefined,
  );
});

test("failed Kind-up attaches only a validated completed creation proof to its static error", async () => {
  const containerIdentities = ["a".repeat(64)];
  let completionCallbacks = 0;
  const operations = processOperations.createAndroidProcessOperations({
    fs: fakeFileSystem(),
    readKindCreationProof: async () => containerIdentities,
    runCommand: async () => ({
      exitCode: 17,
      stderr: "private deployment failure detail",
      stdout: "",
    }),
  });

  await assert.rejects(
    operations.runKindMakePlan(kindPlan(), {
      completeKindCreation: async () => {
        completionCallbacks += 1;
        return {};
      },
    }),
    (error) => {
      assert.equal(error.message, "Kind Make target kind-up failed");
      assert.equal(String(error).includes("private deployment failure detail"), false);
      const descriptor = Object.getOwnPropertyDescriptor(error, "kindCreationEvidence");
      assert.deepEqual(descriptor?.value, { containerIdentities });
      assert.equal(descriptor?.enumerable, false);
      assert.equal(descriptor?.configurable, false);
      assert.equal(descriptor?.writable, false);
      assert.equal(Object.isFrozen(descriptor?.value), true);
      assert.equal(Object.isFrozen(descriptor?.value.containerIdentities), true);
      assert.deepEqual(Object.keys(error), []);
      return true;
    },
  );
  assert.equal(completionCallbacks, 0);
});

test("failed Kind-up does not attach ambiguous creation proof content", async () => {
  const operations = processOperations.createAndroidProcessOperations({
    fs: fakeFileSystem(),
    readKindCreationProof: async () => ["a".repeat(64), "b".repeat(64)],
    runCommand: async () => { throw new Error("deployment failed"); },
  });

  await assert.rejects(
    operations.runKindMakePlan(kindPlan(), { completeKindCreation: async () => ({}) }),
    (error) => Object.getOwnPropertyDescriptor(error, "kindCreationEvidence") === undefined,
  );
});

test("successful Kind-up attaches validated evidence when creation completion fails", async () => {
  const containerIdentities = ["a".repeat(64)];
  const operations = processOperations.createAndroidProcessOperations({
    fs: fakeFileSystem(),
    readKindCreationProof: async () => containerIdentities,
    runCommand: async () => ({ exitCode: 0, stderr: "", stdout: "created\n" }),
  });

  await assert.rejects(
    operations.runKindMakePlan(kindPlan(), {
      completeKindCreation: async () => {
        throw new Error("private callback failure detail");
      },
    }),
    (error) => {
      assert.equal(error.message, "Kind-up creation witness completion failed");
      assert.equal(String(error).includes("private callback failure detail"), false);
      const descriptor = Object.getOwnPropertyDescriptor(error, "kindCreationEvidence");
      assert.deepEqual(descriptor?.value, { containerIdentities });
      assert.equal(descriptor?.enumerable, false);
      assert.equal(descriptor?.configurable, false);
      assert.equal(descriptor?.writable, false);
      assert.equal(Object.isFrozen(descriptor?.value), true);
      assert.equal(Object.isFrozen(descriptor?.value.containerIdentities), true);
      return true;
    },
  );
});

test("launches one owned emulator outside the parent SIGINT group and binds exact identities", async () => {
  const fs = fakeFileSystem();
  const registry = processRegistry();
  const clock = fakeClock();
  const child = fakeChild(4321);
  const spawnCalls = [];
  const commandCalls = [];
  let devicePolls = 0;
  const inspectCalls = [];
  const operations = processOperations.createAndroidProcessOperations({
    fs,
    processRegistry: registry,
    adbPath: "/sdk/adb",
    avdRoot: "/private/avds",
    ...clock,
    emulatorDiscoveryTimeoutMilliseconds: 100,
    emulatorPollIntervalMilliseconds: 10,
    baseEnvironment: { PATH: "/usr/bin", ACP_BEARER_TOKEN: "must-not-reach-emulator" },
    isPortAvailable: async (port) => port === 5554 || port === 5555,
    spawnProcess: (...args) => {
      spawnCalls.push(args);
      return child;
    },
    inspectProcess: async (pid) => {
      inspectCalls.push(pid);
      return { pid, processStartIdentity: "2026-07-17T20:41:00.000Z", alive: true };
    },
    runCommand: async (executable, args, options) => {
      commandCalls.push([executable, args, options]);
      if (args[0] === "devices") {
        devicePolls += 1;
        return {
          stdout: devicePolls < 3
            ? "List of devices attached\n"
            : "List of devices attached\nemulator-5554\tdevice\nphysical-device\tdevice\n",
          stderr: "",
        };
      }
      if (args.join(" ") === "-s emulator-5554 emu avd name") {
        return { stdout: `${emulatorPlan().avdName}\nOK\n`, stderr: "" };
      }
      throw new Error(`unexpected command: ${executable} ${args.join(" ")}`);
    },
  });

  const binding = await operations.launchOwnedEmulator(emulatorPlan());

  assert.deepEqual(binding, {
    serial: "emulator-5554",
    consolePort: 5554,
    pid: 4321,
    processStartIdentity: "2026-07-17T20:41:00.000Z",
  });
  assert.deepEqual(spawnCalls, [[
    "/sdk/emulator",
    [...emulatorPlan().args, "-port", "5554"],
    {
      detached: true,
      env: { PATH: "/usr/bin", ANDROID_AVD_HOME: "/private/avds" },
      shell: false,
      stdio: "ignore",
    },
  ]]);
  assert.deepEqual(inspectCalls, [4321, 4321, 4321, 4321, 4321, 4321]);
  assert.deepEqual(registry.emulators.get(emulatorPlan().avdName), {
    avdName: emulatorPlan().avdName,
    serial: "emulator-5554",
    consolePort: 5554,
    pid: 4321,
    processStartIdentity: "2026-07-17T20:41:00.000Z",
    child,
    launchArgs: [...emulatorPlan().args, "-port", "5554"],
    processCommand: "/sdk/emulator -avd acp-demo-onboarding-run-7-c0ffee123456 -no-snapshot-save -no-audio -no-boot-anim -vsync-rate 30 -port 5554",
  });
  assert.equal(commandCalls.some(([, args]) => args.includes("kill-server")), false);
  assert.equal(commandCalls.some(([, args]) => args.includes("pkill")), false);
  assert.equal(JSON.stringify(commandCalls).includes("must-not-reach-emulator"), false);
  assert.equal(commandCalls.every(([, , options]) => options.env.PATH === "/usr/bin"), true);
  assert.equal(commandCalls.filter(([, args]) => args[0] === "devices").length, 3);
  assert.deepEqual(
    commandCalls.filter(([, args]) => args[0] === "-s").map(([, args]) => args),
    [["-s", "emulator-5554", "emu", "avd", "name"]],
  );
});

test("bounds emulator discovery and cleans only the exact spawned child", async () => {
  const registry = processRegistry();
  const clock = fakeClock();
  const child = fakeChild(4322, (ownedChild, signal) => {
    if (signal === "SIGTERM") ownedChild.exitCode = 0;
  });
  const inspectCalls = [];
  const operations = processOperations.createAndroidProcessOperations({
    fs: fakeFileSystem(),
    processRegistry: registry,
    baseEnvironment: { PATH: "/usr/bin", ACP_SECRET: "must-not-reach-adb" },
    adbPath: "/sdk/adb",
    avdRoot: "/private/avds",
    ...clock,
    emulatorDiscoveryTimeoutMilliseconds: 25,
    emulatorPollIntervalMilliseconds: 10,
    stopGraceMilliseconds: 10,
    isPortAvailable: async (port) => port === 5554 || port === 5555,
    spawnProcess: () => child,
    inspectProcess: async (pid) => {
      inspectCalls.push(pid);
      return { pid, processStartIdentity: "stable-start", alive: true };
    },
    runCommand: async (_executable, args) => {
      assert.deepEqual(args, ["devices"]);
      return { stdout: "List of devices attached\n", stderr: "" };
    },
  });

  await assert.rejects(operations.launchOwnedEmulator(emulatorPlan()), /timed out.*exact emulator/i);
  assert.deepEqual(child.kills, ["SIGTERM"]);
  assert.equal(inspectCalls.length >= 5, true);
  assert.equal(inspectCalls.every((pid) => pid === 4322), true);
  assert.equal(registry.emulators.size, 0);
});

test("launch retains provisional ownership and reports cleanup failure when the child will not exit", async () => {
  const registry = processRegistry();
  const child = fakeChild(4324);
  const operations = processOperations.createAndroidProcessOperations({
    fs: fakeFileSystem(),
    processRegistry: registry,
    adbPath: "/sdk/adb",
    avdRoot: "/private/avds",
    ...fakeClock(),
    emulatorDiscoveryTimeoutMilliseconds: 10,
    emulatorPollIntervalMilliseconds: 10,
    stopGraceMilliseconds: 10,
    isPortAvailable: async (port) => port === 5554 || port === 5555,
    spawnProcess: () => child,
    inspectProcess: async (pid) => ({ pid, processStartIdentity: "stable-start", alive: true }),
    runCommand: async () => ({ stdout: "List of devices attached\n", stderr: "" }),
  });

  await assert.rejects(
    operations.launchOwnedEmulator(emulatorPlan()),
    (error) => error instanceof AggregateError
      && /cleanup.*could not prove.*exit/i.test(error.message)
      && error.errors.some((cause) => /timed out.*exact emulator/i.test(cause.message)),
  );
  assert.deepEqual(child.kills, ["SIGTERM", "SIGKILL"]);
  assert.equal(registry.emulators.size, 1);
  assert.equal(registry.emulators.get(emulatorPlan().avdName).child, child);
});

test("launch cleans its exact direct child when initial process identity cannot be proved", async () => {
  const registry = processRegistry();
  const child = fakeChild(4326, (ownedChild, signal) => {
    if (signal === "SIGTERM") ownedChild.exitCode = 0;
  });
  const operations = processOperations.createAndroidProcessOperations({
    fs: fakeFileSystem(),
    processRegistry: registry,
    adbPath: "/sdk/adb",
    avdRoot: "/private/avds",
    isPortAvailable: async (port) => port === 5554 || port === 5555,
    spawnProcess: () => child,
    inspectProcess: async () => null,
    runCommand: async () => ({ stdout: "List of devices attached\n", stderr: "" }),
  });

  await assert.rejects(
    operations.launchOwnedEmulator(emulatorPlan()),
    /not live/i,
  );
  assert.deepEqual(child.kills, ["SIGTERM"]);
  assert.equal(registry.emulators.size, 0);
});

test("launch preserves the primary failure when cleanup inspection itself fails", async () => {
  const registry = processRegistry();
  const child = fakeChild(4327);
  let inspections = 0;
  let commands = 0;
  const operations = processOperations.createAndroidProcessOperations({
    fs: fakeFileSystem(),
    processRegistry: registry,
    adbPath: "/sdk/adb",
    avdRoot: "/private/avds",
    isPortAvailable: async (port) => port === 5554 || port === 5555,
    spawnProcess: () => child,
    inspectProcess: async (pid) => {
      inspections += 1;
      if (inspections >= 3) throw new Error("private inspector detail");
      return { pid, processStartIdentity: "stable-start", alive: true };
    },
    runCommand: async () => {
      commands += 1;
      if (commands === 1) return { stdout: "List of devices attached\n", stderr: "" };
      throw new Error("primary adb discovery failure");
    },
  });

  await assert.rejects(
    operations.launchOwnedEmulator(emulatorPlan()),
    (error) => error instanceof AggregateError
      && error.errors.some((cause) => cause.message === "primary adb discovery failure")
      && error.errors.some((cause) => /cleanup.*could not prove/i.test(cause.message))
      && !String(error).includes("private inspector detail"),
  );
  assert.deepEqual(child.kills, []);
  assert.equal(registry.emulators.size, 1);
});

test("launch refuses an ADB serial when the exact spawned direct child changed", async () => {
  const registry = processRegistry();
  const child = fakeChild(4325);
  let deviceCalls = 0;
  let avdNameCalls = 0;
  const operations = processOperations.createAndroidProcessOperations({
    fs: fakeFileSystem(),
    processRegistry: registry,
    adbPath: "/sdk/adb",
    avdRoot: "/private/avds",
    ...fakeClock(),
    emulatorDiscoveryTimeoutMilliseconds: 20,
    emulatorPollIntervalMilliseconds: 10,
    isPortAvailable: async (port) => port === 5554 || port === 5555,
    spawnProcess: () => child,
    inspectProcess: async (pid) => ({ pid, processStartIdentity: "stable-start", alive: true }),
    runCommand: async (_executable, args) => {
      if (args[0] === "devices") {
        deviceCalls += 1;
        if (deviceCalls === 2) {
          child.pid = 9999;
          return { stdout: "List of devices attached\nemulator-5554\tdevice\n", stderr: "" };
        }
        return { stdout: "List of devices attached\n", stderr: "" };
      }
      avdNameCalls += 1;
      return { stdout: `${emulatorPlan().avdName}\nOK\n`, stderr: "" };
    },
  });

  await assert.rejects(
    operations.launchOwnedEmulator(emulatorPlan()),
    (error) => error instanceof AggregateError && /direct child/i.test(String(error.errors[0])),
  );
  assert.equal(avdNameCalls, 0);
  assert.deepEqual(child.kills, []);
  assert.equal(registry.emulators.size, 1);
});

test("launch attaches a bounded child error listener before process inspection", async () => {
  const registry = processRegistry();
  const child = Object.assign(new EventEmitter(), fakeChild(4328));
  let listenerAttached = false;
  const operations = processOperations.createAndroidProcessOperations({
    fs: fakeFileSystem(),
    processRegistry: registry,
    adbPath: "/sdk/adb",
    avdRoot: "/private/avds",
    isPortAvailable: async (port) => port === 5554 || port === 5555,
    spawnProcess: () => child,
    inspectProcess: async () => {
      listenerAttached = child.listenerCount("error") === 1;
      if (listenerAttached) child.emit("error", new Error("private asynchronous spawn detail"));
      return null;
    },
    runCommand: async () => ({ stdout: "List of devices attached\n", stderr: "" }),
  });

  await assert.rejects(
    operations.launchOwnedEmulator(emulatorPlan()),
    (error) => error instanceof AggregateError
      && /cleanup.*could not prove/i.test(error.message)
      && !String(error).includes("private asynchronous spawn detail"),
  );
  assert.equal(listenerAttached, true);
  assert.equal(registry.emulators.size, 1);
});

test("default inspection binds emulator identity to the exact executable and argv", async () => {
  const registry = processRegistry();
  const child = fakeChild(4329);
  let adbCalls = 0;
  const operations = processOperations.createAndroidProcessOperations({
    fs: fakeFileSystem(),
    processRegistry: registry,
    adbPath: "/sdk/adb",
    avdRoot: "/private/avds",
    ...fakeClock(),
    emulatorDiscoveryTimeoutMilliseconds: 10,
    emulatorPollIntervalMilliseconds: 10,
    isPortAvailable: async (port) => port === 5554 || port === 5555,
    spawnProcess: () => child,
    runCommand: async (executable, args) => {
      if (executable === "/bin/ps") {
        return {
          stdout: "Fri Jul 18 12:00:00 2026 /tmp/replacement --same-port\n",
          stderr: "",
        };
      }
      adbCalls += 1;
      if (adbCalls === 1) return { stdout: "List of devices attached\n", stderr: "" };
      if (args[0] === "devices") {
        return { stdout: "List of devices attached\nemulator-5554\tdevice\n", stderr: "" };
      }
      return { stdout: `${emulatorPlan().avdName}\nOK\n`, stderr: "" };
    },
  });

  await assert.rejects(
    operations.launchOwnedEmulator(emulatorPlan()),
    (error) => error instanceof AggregateError
      && error.errors.some((cause) => /exact executable and arguments/i.test(cause.message)),
  );
  assert.equal(adbCalls, 1);
  assert.equal(registry.emulators.size, 1);
});

test("launch retains both records when an AVD registry collision races with spawn", async () => {
  const registry = processRegistry();
  const child = fakeChild(4334);
  const replacement = Object.freeze({ existing: true, consolePort: 5556 });
  let inspections = 0;
  const operations = processOperations.createAndroidProcessOperations({
    fs: fakeFileSystem(),
    processRegistry: registry,
    adbPath: "/sdk/adb",
    avdRoot: "/private/avds",
    ...fakeClock(),
    stopGraceMilliseconds: 10,
    isPortAvailable: async (port) => port === 5554 || port === 5555,
    spawnProcess: () => child,
    inspectProcess: async (pid) => {
      inspections += 1;
      if (inspections === 1) registry.emulators.set(emulatorPlan().avdName, replacement);
      return { pid, processStartIdentity: "stable-start", alive: true };
    },
    runCommand: async () => ({ stdout: "List of devices attached\n", stderr: "" }),
  });

  await assert.rejects(operations.launchOwnedEmulator(emulatorPlan()), AggregateError);
  assert.equal(registry.emulators.get(emulatorPlan().avdName), replacement);
  assert.equal([...registry.emulators.values()].some((record) => record?.child === child), true);
  assert.equal(registry.emulators.size, 2);
});

test("launch cannot succeed when the direct child exits during final AVD inspection", async () => {
  const registry = processRegistry();
  const child = fakeChild(4335);
  let inspections = 0;
  let adbCalls = 0;
  const operations = processOperations.createAndroidProcessOperations({
    fs: fakeFileSystem(),
    processRegistry: registry,
    adbPath: "/sdk/adb",
    avdRoot: "/private/avds",
    ...fakeClock(),
    isPortAvailable: async (port) => port === 5554 || port === 5555,
    spawnProcess: () => child,
    inspectProcess: async (pid) => {
      inspections += 1;
      if (inspections === 4) child.exitCode = 0;
      return { pid, processStartIdentity: "stable-start", alive: true };
    },
    runCommand: async (_executable, args) => {
      adbCalls += 1;
      if (adbCalls === 1) return { stdout: "List of devices attached\n", stderr: "" };
      if (args[0] === "devices") {
        return { stdout: "List of devices attached\nemulator-5554\tdevice\n", stderr: "" };
      }
      return { stdout: `${emulatorPlan().avdName}\nOK\n`, stderr: "" };
    },
  });

  await assert.rejects(operations.launchOwnedEmulator(emulatorPlan()), /direct child exited/i);
  assert.equal(registry.emulators.size, 0);
});

test("refuses emulator PID reuse without signaling or registering the replacement", async () => {
  const registry = processRegistry();
  const child = fakeChild(4323);
  let inspections = 0;
  let devicePolls = 0;
  const operations = processOperations.createAndroidProcessOperations({
    fs: fakeFileSystem(),
    processRegistry: registry,
    adbPath: "/sdk/adb",
    avdRoot: "/private/avds",
    ...fakeClock(),
    emulatorDiscoveryTimeoutMilliseconds: 25,
    emulatorPollIntervalMilliseconds: 10,
    isPortAvailable: async (port) => port === 5554 || port === 5555,
    spawnProcess: () => child,
    inspectProcess: async (pid) => {
      inspections += 1;
      return {
        pid,
        processStartIdentity: inspections === 1 ? "owned-start" : "replacement-start",
        alive: true,
      };
    },
    runCommand: async (_executable, args) => {
      if (args[0] === "devices") {
        devicePolls += 1;
        return {
          stdout: devicePolls === 1
            ? "List of devices attached\n"
            : "List of devices attached\nemulator-5554\tdevice\n",
          stderr: "",
        };
      }
      return { stdout: `${emulatorPlan().avdName}\nOK\n`, stderr: "" };
    },
  });

  await assert.rejects(
    operations.launchOwnedEmulator(emulatorPlan()),
    (error) => error instanceof AggregateError
      && error.errors.some((cause) => /process identity changed/i.test(cause.message)),
  );
  assert.deepEqual(child.kills, []);
  assert.equal(registry.emulators.size, 1);
});

test("refuses non-exact emulator launch plans before spawning", async () => {
  let spawned = false;
  const operations = processOperations.createAndroidProcessOperations({
    fs: fakeFileSystem(),
    spawnProcess: () => {
      spawned = true;
      return fakeChild(9999);
    },
  });
  const plan = emulatorPlan({ args: [...emulatorPlan().args, "-shell"] });

  await assert.rejects(operations.launchOwnedEmulator(plan), /exact owned emulator arguments/i);
  assert.equal(spawned, false);
});

test("rolls back only the exact launched emulator child and removes its registry record", async () => {
  const registry = processRegistry();
  const child = fakeChild(4330, (ownedChild, signal) => {
    if (signal === "SIGTERM") ownedChild.exitCode = 0;
  });
  const binding = Object.freeze({
    avdName: "acp-demo-onboarding-run-7-c0ffee123456",
    serial: "emulator-5554",
    consolePort: 5554,
    pid: 4330,
    processStartIdentity: "owned-start",
  });
  registry.emulators.set(binding.avdName, Object.freeze({
    ...binding,
    child,
  }));
  registry.emulators.set("acp-demo-other-run-c0ffee654321", Object.freeze({
    avdName: "acp-demo-other-run-c0ffee654321",
    serial: "emulator-5556",
    consolePort: 5556,
    pid: 4339,
    processStartIdentity: binding.processStartIdentity,
    child: fakeChild(4339),
  }));
  const operations = processOperations.createAndroidProcessOperations({
    fs: fakeFileSystem(),
    processRegistry: registry,
    ...fakeClock(),
    stopGraceMilliseconds: 10,
    inspectProcess: async (pid) => ({
      pid,
      processStartIdentity: "owned-start",
      alive: true,
    }),
  });

  const result = await operations.rollbackOwnedEmulator(binding);

  assert.deepEqual(result, { rolledBack: true, pid: 4330, serial: "emulator-5554" });
  assert.deepEqual(child.kills, ["SIGTERM"]);
  assert.equal(registry.emulators.has(binding.avdName), false);
  assert.equal(registry.emulators.has("acp-demo-other-run-c0ffee654321"), true);
});

test("rollback refuses PID reuse without signaling or deleting ownership evidence", async () => {
  const registry = processRegistry();
  const child = fakeChild(4331);
  const binding = Object.freeze({
    avdName: "acp-demo-onboarding-run-7-c0ffee123456",
    serial: "emulator-5554",
    consolePort: 5554,
    pid: 4331,
    processStartIdentity: "owned-start",
  });
  const avdName = binding.avdName;
  registry.emulators.set(avdName, Object.freeze({ avdName, ...binding, child }));
  const operations = processOperations.createAndroidProcessOperations({
    fs: fakeFileSystem(),
    processRegistry: registry,
    inspectProcess: async (pid) => ({
      pid,
      processStartIdentity: "replacement-start",
      alive: true,
    }),
  });

  await assert.rejects(operations.rollbackOwnedEmulator(binding), /process identity changed/i);
  assert.deepEqual(child.kills, []);
  assert.equal(registry.emulators.has(avdName), true);
});

test("rollback refuses a caller-supplied child that is not the registered direct child", async () => {
  const registry = processRegistry();
  const child = fakeChild(4332);
  const impostor = fakeChild(4332);
  const binding = Object.freeze({
    avdName: "acp-demo-onboarding-run-7-c0ffee123456",
    serial: "emulator-5554",
    consolePort: 5554,
    pid: 4332,
    processStartIdentity: "owned-start",
  });
  registry.emulators.set(binding.avdName, Object.freeze({ ...binding, child }));
  const operations = processOperations.createAndroidProcessOperations({
    fs: fakeFileSystem(),
    processRegistry: registry,
    inspectProcess: async (pid) => ({ pid, processStartIdentity: "owned-start", alive: true }),
  });

  await assert.rejects(
    operations.rollbackOwnedEmulator({ ...binding, child: impostor }),
    /direct child.*changed/i,
  );
  assert.deepEqual(child.kills, []);
  assert.deepEqual(impostor.kills, []);
  assert.equal(registry.emulators.has(binding.avdName), true);
});

test("rollback removes an exact unchanged registry record for an already-exited direct child", async () => {
  const registry = processRegistry();
  const child = fakeChild(4333);
  child.exitCode = 0;
  const binding = Object.freeze({
    avdName: "acp-demo-onboarding-run-7-c0ffee123456",
    serial: "emulator-5554",
    consolePort: 5554,
    pid: 4333,
    processStartIdentity: "owned-start",
  });
  registry.emulators.set(binding.avdName, Object.freeze({ ...binding, child }));
  const operations = processOperations.createAndroidProcessOperations({
    fs: fakeFileSystem(),
    processRegistry: registry,
    inspectProcess: async () => {
      throw new Error("an exited direct child must not be adopted through PID lookup");
    },
  });

  const result = await operations.rollbackOwnedEmulator(binding);

  assert.deepEqual(result, { rolledBack: true, pid: 4333, serial: "emulator-5554" });
  assert.deepEqual(child.kills, []);
  assert.equal(registry.emulators.has(binding.avdName), false);
});

test("waits for boot readiness only through the exact owned emulator serial", async () => {
  const registry = processRegistry();
  const ownership = ownedAvd();
  registerEmulator(registry, ownership);
  const clock = fakeClock();
  const calls = [];
  let polls = 0;
  const operations = processOperations.createAndroidProcessOperations({
    fs: fakeFileSystem(),
    baseEnvironment: { PATH: "/usr/bin", ACP_SECRET: "must-not-reach-adb" },
    processRegistry: registry,
    ...clock,
    avdBootTimeoutMilliseconds: 100,
    avdBootPollIntervalMilliseconds: 10,
    inspectProcess: async (pid) => ({ pid, processStartIdentity: "owned-start", alive: true }),
    runCommand: async (...args) => {
      calls.push(args);
      polls += 1;
      return { stdout: polls === 1 ? "\n" : "1\n", stderr: "" };
    },
  });

  const result = await operations.waitForOwnedAvdBoot(ownership, { adbPath: "/sdk/adb" });

  assert.deepEqual(result, { ready: true, serial: "emulator-5554" });
  assert.deepEqual(calls, [
    [
      "/sdk/adb",
      ["-s", "emulator-5554", "shell", "getprop", "sys.boot_completed"],
      {
        env: { PATH: "/usr/bin" },
        maxOutputBytes: 16 * 1024,
        shell: false,
        timeoutMilliseconds: 5_000,
      },
    ],
    [
      "/sdk/adb",
      ["-s", "emulator-5554", "shell", "getprop", "sys.boot_completed"],
      {
        env: { PATH: "/usr/bin" },
        maxOutputBytes: 16 * 1024,
        shell: false,
        timeoutMilliseconds: 5_000,
      },
    ],
  ]);
  assert.equal(calls.every(([, args]) => args[0] === "-s"), true);
});

test("bounds exact AVD boot polling", async () => {
  const registry = processRegistry();
  const ownership = ownedAvd();
  registerEmulator(registry, ownership);
  const clock = fakeClock();
  let calls = 0;
  const operations = processOperations.createAndroidProcessOperations({
    fs: fakeFileSystem(),
    baseEnvironment: { PATH: "/usr/bin", ACP_SECRET: "must-not-reach-adb" },
    processRegistry: registry,
    ...clock,
    avdBootTimeoutMilliseconds: 25,
    avdBootPollIntervalMilliseconds: 10,
    inspectProcess: async (pid) => ({ pid, processStartIdentity: "owned-start", alive: true }),
    runCommand: async () => {
      calls += 1;
      return { stdout: "0\n", stderr: "" };
    },
  });

  await assert.rejects(
    operations.waitForOwnedAvdBoot(ownership, { adbPath: "/sdk/adb" }),
    /timed out.*boot/i,
  );
  assert.equal(calls, 3);
});

test("refuses AVD boot polling when the tracked PID start identity changed", async () => {
  const registry = processRegistry();
  const ownership = ownedAvd();
  registerEmulator(registry, ownership);
  let commands = 0;
  const operations = processOperations.createAndroidProcessOperations({
    fs: fakeFileSystem(),
    processRegistry: registry,
    inspectProcess: async (pid) => ({ pid, processStartIdentity: "replacement-start", alive: true }),
    runCommand: async () => {
      commands += 1;
      return { stdout: "1\n", stderr: "" };
    },
  });

  await assert.rejects(
    operations.waitForOwnedAvdBoot(ownership, { adbPath: "/sdk/adb" }),
    /process identity changed/i,
  );
  assert.equal(commands, 0);
});

test("boot readiness cannot succeed when the direct child exits during final inspection", async () => {
  const registry = processRegistry();
  const ownership = ownedAvd();
  const child = registerEmulator(registry, ownership);
  let inspections = 0;
  const operations = processOperations.createAndroidProcessOperations({
    fs: fakeFileSystem(),
    processRegistry: registry,
    ...fakeClock(),
    inspectProcess: async (pid) => {
      inspections += 1;
      if (inspections === 2) {
        child.exitCode = 0;
        child.stdout.end();
        child.emit("close", 0, null);
      }
      return { pid, processStartIdentity: "owned-start", alive: true };
    },
    runCommand: async () => ({ stdout: "1\n", stderr: "" }),
  });

  await assert.rejects(
    operations.waitForOwnedAvdBoot(ownership, { adbPath: "/sdk/adb" }),
    /direct child exited/i,
  );
});

test("starts and registers the exact adb screenrecord child without secret environment", async () => {
  const registry = processRegistry();
  const child = fakeChild(5200);
  const spawnCalls = [];
  const clock = fakeClock();
  let inspections = 0;
  const operations = processOperations.createAndroidProcessOperations({
    fs: fakeFileSystem(),
    processRegistry: registry,
    baseEnvironment: { PATH: "/usr/bin", UNRELATED_SECRET: "must-not-reach-adb" },
    ...clock,
    recorderReadinessMilliseconds: 20,
    spawnProcess: (...args) => {
      spawnCalls.push(args);
      return child;
    },
    inspectProcess: async (pid) => {
      inspections += 1;
      return { pid, processStartIdentity: "recorder-start", alive: true };
    },
  });

  const handle = await operations.startAndroidScreenrecord(screenrecordStep());

  assert.deepEqual(handle, {
    pid: 5200,
    processStartIdentity: "recorder-start",
    mediaStartMonotonicMilliseconds: 0,
  });
  assert.deepEqual(spawnCalls, [[
    "/sdk/adb",
    screenrecordStep().args,
    { detached: false, env: { PATH: "/usr/bin" }, shell: false, stdio: ["ignore", "pipe", "pipe"] },
  ]]);
  assert.equal(registry.recorders.get(5200).child, child);
  assert.equal(registry.recorders.get(5200).handle, handle);
  assert.equal(registry.recorders.get(5200).serial, "emulator-5554");
  assert.equal(clock.nowMilliseconds(), 20);
  assert.equal(inspections >= 2, true);
});

test("screenrecord readiness failure retains evidence when exact cleanup cannot prove exit", async () => {
  const registry = processRegistry();
  const child = fakeChild(5205);
  let inspections = 0;
  const operations = processOperations.createAndroidProcessOperations({
    fs: fakeFileSystem(),
    processRegistry: registry,
    ...fakeClock(),
    recorderReadinessMilliseconds: 10,
    stopGraceMilliseconds: 10,
    spawnProcess: () => child,
    inspectProcess: async (pid) => {
      inspections += 1;
      return {
        pid,
        processStartIdentity: inspections === 1 ? "recorder-start" : "replacement-start",
        alive: true,
      };
    },
  });

  await assert.rejects(
    operations.startAndroidScreenrecord(screenrecordStep()),
    (error) => {
      const descriptor = Object.getOwnPropertyDescriptor(error, "recorderExitUnproved");
      return error instanceof AggregateError
        && /cleanup.*could not prove.*exit/i.test(error.message)
        && error.errors.some((cause) => /process identity changed/i.test(cause.message))
        && descriptor?.value === true
        && descriptor.enumerable === false
        && descriptor.configurable === false
        && descriptor.writable === false;
    },
  );
  assert.deepEqual(child.kills, []);
  assert.equal(registry.recorders.size, 1);
  assert.equal(registry.recorders.get(5205).child, child);
});

test("screenrecord cleans its exact direct child when initial process identity is unavailable", async () => {
  const registry = processRegistry();
  const child = fakeChild(5207, (ownedChild, signal) => {
    if (signal === "SIGTERM") ownedChild.exitCode = 0;
  });
  const operations = processOperations.createAndroidProcessOperations({
    fs: fakeFileSystem(),
    processRegistry: registry,
    spawnProcess: () => child,
    inspectProcess: async () => null,
  });

  await assert.rejects(
    operations.startAndroidScreenrecord(screenrecordStep()),
    /not live/i,
  );
  assert.deepEqual(child.kills, ["SIGTERM"]);
  assert.equal(registry.recorders.size, 0);
});

test("screenrecord closes its exclusive raw output when spawn throws before registration", async () => {
  const trackedFs = trackedRecorderFileSystem();
  const operations = processOperations.createAndroidProcessOperations({
    fs: trackedFs.fs,
    spawnProcess: () => {
      throw new Error("synthetic spawn failure");
    },
  });

  await assert.rejects(
    operations.startAndroidScreenrecord(screenrecordStep()),
    /synthetic spawn failure/,
  );
  assert.equal(trackedFs.closeCalls(), 1);
});

test("screenrecord closes raw output and preserves an unprovable invalid-PID child", async () => {
  const trackedFs = trackedRecorderFileSystem();
  const child = fakeChild(5207);
  child.pid = 0;
  const operations = processOperations.createAndroidProcessOperations({
    fs: trackedFs.fs,
    spawnProcess: () => child,
  });

  await assert.rejects(
    operations.startAndroidScreenrecord(screenrecordStep()),
    (error) => error instanceof AggregateError
      && error.recorderExitUnproved === true
      && error.errors.some((cause) => /positive integer/i.test(cause.message)),
  );
  assert.equal(trackedFs.closeCalls(), 1);
  assert.deepEqual(child.kills, []);
});

test("screenrecord closes raw output after stopping a proven child with unusable streams", async () => {
  const trackedFs = trackedRecorderFileSystem();
  const child = fakeChild(5208);
  child.stderr = undefined;
  child.kill = function kill(signal) {
    this.kills.push(signal);
    this.exitCode = 0;
    this.emit("exit", 0, null);
    this.emit("close", 0, null);
    return true;
  };
  const operations = processOperations.createAndroidProcessOperations({
    fs: trackedFs.fs,
    spawnProcess: () => child,
  });

  await assert.rejects(
    operations.startAndroidScreenrecord(screenrecordStep()),
    /separate piped stdout and stderr streams/i,
  );
  assert.equal(trackedFs.closeCalls(), 1);
  assert.deepEqual(child.kills, ["SIGTERM"]);
});

test("screenrecord retains both records when its spawned PID collides", async () => {
  const registry = processRegistry();
  const child = fakeChild(5208);
  const existing = Object.freeze({ existing: true, pid: 5208 });
  registry.recorders.set(5208, existing);
  const operations = processOperations.createAndroidProcessOperations({
    fs: fakeFileSystem(),
    processRegistry: registry,
    ...fakeClock(),
    stopGraceMilliseconds: 10,
    spawnProcess: () => child,
    inspectProcess: async (pid) => ({ pid, processStartIdentity: "recorder-start", alive: true }),
  });

  await assert.rejects(operations.startAndroidScreenrecord(screenrecordStep()), AggregateError);
  assert.equal(registry.recorders.get(5208), existing);
  assert.equal([...registry.recorders.values()].some((record) => record?.child === child), true);
  assert.equal(registry.recorders.size, 2);
});

test("screenrecord readiness cannot succeed when the direct child exits during final inspection", async () => {
  const registry = processRegistry();
  const child = fakeChild(5209);
  let inspections = 0;
  const operations = processOperations.createAndroidProcessOperations({
    fs: fakeFileSystem(),
    processRegistry: registry,
    ...fakeClock(),
    recorderReadinessMilliseconds: 10,
    spawnProcess: () => child,
    inspectProcess: async (pid) => {
      inspections += 1;
      if (inspections === 2) child.exitCode = 0;
      return { pid, processStartIdentity: "recorder-start", alive: true };
    },
  });

  await assert.rejects(
    operations.startAndroidScreenrecord(screenrecordStep()),
    /direct child exited|cleanup could not prove exact child exit/i,
  );
  assert.equal(registry.recorders.size <= 1, true);
});

test("stops only the exact tracked recorder with bounded signal escalation", async () => {
  const registry = processRegistry();
  const child = fakeChild(5201, (ownedChild, signal) => {
    if (signal === "SIGINT") ownedChild.exitCode = 0;
  });
  const clock = fakeClock();
  const operations = processOperations.createAndroidProcessOperations({
    fs: fakeFileSystem(),
    processRegistry: registry,
    ...clock,
    recorderSignalGraceMilliseconds: 10,
    spawnProcess: () => child,
    inspectProcess: async (pid) => ({ pid, processStartIdentity: "recorder-start", alive: true }),
  });
  const handle = await operations.startAndroidScreenrecord(screenrecordStep());

  const result = await operations.stopAndroidScreenrecord(handle);

  assert.deepEqual(result, { stopped: true, pid: 5201 });
  assert.deepEqual(child.kills, ["SIGINT"]);
  assert.equal(registry.recorders.size, 0);
});

test("refuses an untracked copy of a recorder handle", async () => {
  const registry = processRegistry();
  const child = fakeChild(5202, (ownedChild) => { ownedChild.exitCode = 0; });
  const operations = processOperations.createAndroidProcessOperations({
    fs: fakeFileSystem(),
    processRegistry: registry,
    ...fakeClock(),
    recorderReadinessMilliseconds: 10,
    spawnProcess: () => child,
    inspectProcess: async (pid) => ({ pid, processStartIdentity: "recorder-start", alive: true }),
  });
  const handle = await operations.startAndroidScreenrecord(screenrecordStep());

  await assert.rejects(
    operations.stopAndroidScreenrecord({ ...handle }),
    /exact tracked recorder handle/i,
  );
  assert.deepEqual(child.kills, []);
  assert.equal(registry.recorders.size, 1);
});

test("recorder stop refuses PID reuse without signaling or deleting ownership evidence", async () => {
  const registry = processRegistry();
  const child = fakeChild(5203);
  let inspections = 0;
  const operations = processOperations.createAndroidProcessOperations({
    fs: fakeFileSystem(),
    processRegistry: registry,
    ...fakeClock(),
    recorderReadinessMilliseconds: 10,
    spawnProcess: () => child,
    inspectProcess: async (pid) => {
      inspections += 1;
      return {
        pid,
        processStartIdentity: inspections <= 2 ? "recorder-start" : "replacement-start",
        alive: true,
      };
    },
  });
  const handle = await operations.startAndroidScreenrecord(screenrecordStep());

  await assert.rejects(operations.stopAndroidScreenrecord(handle), /process identity changed/i);
  assert.deepEqual(child.kills, []);
  assert.equal(registry.recorders.size, 1);
});

test("recorder stop is bounded even when the exact child ignores every signal", async () => {
  const registry = processRegistry();
  const child = fakeChild(5204);
  const operations = processOperations.createAndroidProcessOperations({
    fs: fakeFileSystem(),
    processRegistry: registry,
    ...fakeClock(),
    recorderSignalGraceMilliseconds: 10,
    spawnProcess: () => child,
    inspectProcess: async (pid) => ({ pid, processStartIdentity: "recorder-start", alive: true }),
  });
  const handle = await operations.startAndroidScreenrecord(screenrecordStep());

  await assert.rejects(operations.stopAndroidScreenrecord(handle), /did not exit/i);
  assert.deepEqual(child.kills, ["SIGINT", "SIGTERM", "SIGKILL"]);
  assert.equal(registry.recorders.size, 1);
});

test("recorder stop refuses a signal that ChildProcess.kill reports as undelivered", async () => {
  const registry = processRegistry();
  const child = fakeChild(5210);
  child.kill = function kill(signal) {
    this.kills.push(signal);
    return false;
  };
  const operations = processOperations.createAndroidProcessOperations({
    fs: fakeFileSystem(),
    processRegistry: registry,
    ...fakeClock(),
    recorderSignalGraceMilliseconds: 10,
    spawnProcess: () => child,
    inspectProcess: async (pid) => ({ pid, processStartIdentity: "recorder-start", alive: true }),
  });
  const handle = await operations.startAndroidScreenrecord(screenrecordStep());

  await assert.rejects(operations.stopAndroidScreenrecord(handle), /could not signal/i);
  assert.deepEqual(child.kills, ["SIGINT"]);
  assert.equal(registry.recorders.size, 1);
});

test("recorder stop rejects an unsolicited SIGINT when its own signal was undelivered", async () => {
  const registry = processRegistry();
  const child = fakeChild(5211);
  child.kill = function kill(signal) {
    this.kills.push(signal);
    if (signal === "SIGINT") {
      this.signalCode = "SIGINT";
      this.stdout.end();
      this.stderr.end();
      this.emit("exit", null, "SIGINT");
      this.emit("close", null, "SIGINT");
    }
    return false;
  };
  const operations = processOperations.createAndroidProcessOperations({
    fs: fakeFileSystem(),
    processRegistry: registry,
    ...fakeClock(),
    recorderSignalGraceMilliseconds: 10,
    spawnProcess: () => child,
    inspectProcess: async (pid) => ({ pid, processStartIdentity: "recorder-start", alive: true }),
  });
  const handle = await operations.startAndroidScreenrecord(screenrecordStep());

  await assert.rejects(
    operations.stopAndroidScreenrecord(handle),
    /forced termination|unsolicited|unpublishable/i,
  );
  assert.deepEqual(child.kills, ["SIGINT"]);
  assert.equal(registry.recorders.size, 0);
});

test("recorder stop retains a replacement registry entry after exact child exit", async () => {
  const registry = processRegistry();
  const replacement = Object.freeze({ replacement: true });
  const child = fakeChild(5206, (ownedChild) => {
    ownedChild.exitCode = 0;
    registry.recorders.set(5206, replacement);
  });
  const operations = processOperations.createAndroidProcessOperations({
    fs: fakeFileSystem(),
    processRegistry: registry,
    ...fakeClock(),
    recorderReadinessMilliseconds: 10,
    recorderSignalGraceMilliseconds: 10,
    spawnProcess: () => child,
    inspectProcess: async (pid) => ({ pid, processStartIdentity: "recorder-start", alive: true }),
  });
  const handle = await operations.startAndroidScreenrecord(screenrecordStep());

  await assert.rejects(operations.stopAndroidScreenrecord(handle), /registry changed/i);
  assert.equal(registry.recorders.get(5206), replacement);
});

test("probes one canonical Android recording with bounded ffprobe JSON", async () => {
  const calls = [];
  const probe = {
    streams: [{ codec_type: "video", width: 1080, height: 1920 }],
    format: { duration: "41.9" },
    packets: [],
  };
  const operations = processOperations.createAndroidProcessOperations({
    fs: fakeFileSystem(),
    baseEnvironment: { PATH: "/usr/bin", ACP_SECRET: "must-not-reach-ffprobe" },
    runCommand: async (...args) => {
      calls.push(args);
      return { stdout: JSON.stringify(probe), stderr: "", exitCode: 0 };
    },
  });

  const result = await operations.probeAndroidRecording({
    path: "/private/output/stage/screenrecord.mp4",
    ffprobePath: "/usr/bin/ffprobe",
  });

  assert.deepEqual(result, probe);
  assert.deepEqual(calls, [[
    "/usr/bin/ffprobe",
    [
      "-v",
      "error",
      "-print_format",
      "json",
      "-show_format",
      "-show_streams",
      "-show_packets",
      "-count_frames",
      "-count_packets",
      "--",
      "/private/output/stage/screenrecord.mp4",
    ],
    {
      env: { PATH: "/usr/bin" },
      maxOutputBytes: 4 * 1024 * 1024,
      shell: false,
      timeoutMilliseconds: 15_000,
    },
  ]]);
});

test("rejects invalid or oversized ffprobe output", async (context) => {
  for (const [name, stdout, pattern] of [
    ["invalid JSON", "not-json", /valid JSON/i],
    ["wrong shape", "[]", /object with streams, packets, and format/i],
    ["oversized", "x".repeat((4 * 1024 * 1024) + 1), /output exceeds/i],
  ]) {
    await context.test(name, async () => {
      const operations = processOperations.createAndroidProcessOperations({
        fs: fakeFileSystem(),
        runCommand: async () => ({ stdout, stderr: "" }),
      });
      await assert.rejects(operations.probeAndroidRecording({
        path: "/private/output/stage/screenrecord.mp4",
        ffprobePath: "/usr/bin/ffprobe",
      }), pattern);
    });
  }
});
