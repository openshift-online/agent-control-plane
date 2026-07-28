import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  bindAvdProcess,
  createOwnedEmulatorLaunchPlan,
  reserveAvdOwnership,
} from "../../../scripts/capture/android/avd-lifecycle.mjs";
import { createAvdLifecycleDeps } from "../../../scripts/capture/android/lifecycle-operations.mjs";
import { createAndroidProcessOperations } from "../../../scripts/capture/android/process-operations.mjs";

const SYSTEM_IMAGE = "system-images;android-35;google_apis;x86_64";

function result(stdout = "") {
  return { stdout, stderr: "", exitCode: 0 };
}

function fakeChild(pid) {
  return Object.assign(new EventEmitter(), {
    pid,
    exitCode: null,
    signalCode: null,
    kill: () => false,
  });
}

async function createDefaultInspectorHarness(t) {
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), "demo-creator-process-identity-")),
  );
  t.after(async () => rm(root, { force: true, recursive: true }));
  const avdRoot = path.join(root, "avds");
  const markerRoot = path.join(root, "markers");
  const toolsRoot = path.join(root, "tools");
  await Promise.all([
    mkdir(avdRoot, { mode: 0o700 }),
    mkdir(markerRoot, { mode: 0o700 }),
    mkdir(toolsRoot, { mode: 0o700 }),
  ]);
  const toolPaths = Object.fromEntries(
    ["adb", "avdmanager", "emulator"].map((name) => [name, path.join(toolsRoot, name)]),
  );
  await Promise.all(Object.values(toolPaths).map(async (pathname) => {
    await writeFile(pathname, "", { mode: 0o700 });
    await chmod(pathname, 0o700);
  }));

  const processRegistry = { emulators: new Map(), recorders: new Map() };
  const emulatorPid = 4321;
  const markerOwnerPid = 7373;
  let emulatorStartIdentity = "Sat Jul 18 12:00:00 2026";
  let emulatorCommandOverride;
  const markerOwnerStartIdentity = "Sat Jul 18 11:00:00 2026";
  let adbDeviceCalls = 0;
  let avdCreated = false;
  let ownership;

  const runCommand = async (executable, args) => {
    if (executable === "/bin/ps") {
      const pid = Number(args[args.indexOf("-p") + 1]);
      const processStartIdentity = pid === emulatorPid
        ? emulatorStartIdentity
        : markerOwnerStartIdentity;
      const command = pid === emulatorPid
        ? emulatorCommandOverride ?? [
          toolPaths.emulator,
          ...createOwnedEmulatorLaunchPlan(ownership, {
            emulatorBinary: toolPaths.emulator,
          }).args,
          "-port",
          "5554",
        ].join(" ")
        : "/usr/bin/node --test";
      const includesCommand = args.includes("command=");
      return result(`${processStartIdentity}${includesCommand ? ` ${command}` : ""}\n`);
    }
    if (executable === toolPaths.avdmanager) {
      assert.deepEqual(args, ["list", "avd"]);
      if (!avdCreated) return result("Available Android Virtual Devices:\n");
      return result([
        "Available Android Virtual Devices:",
        `    Name: ${ownership.avdName}`,
        `    Path: ${ownership.avdPath}`,
        "---------",
        "",
      ].join("\n"));
    }
    if (executable === toolPaths.adb && args[0] === "devices") {
      adbDeviceCalls += 1;
      return result(adbDeviceCalls === 1
        ? "List of devices attached\n"
        : "List of devices attached\nemulator-5554\tdevice\n");
    }
    if (executable === toolPaths.adb && args.join(" ") === "-s emulator-5554 emu avd name") {
      return result(`${ownership.avdName}\nOK\n`);
    }
    if (
      executable === toolPaths.adb
      && args.join(" ") === "-s emulator-5554 shell getprop sys.boot_completed"
    ) {
      return result("1\n");
    }
    throw new Error(`Unexpected command: ${executable} ${args.join(" ")}`);
  };

  const processOperations = createAndroidProcessOperations({
    adbPath: toolPaths.adb,
    avdRoot,
    emulatorDiscoveryTimeoutMilliseconds: 100,
    emulatorPollIntervalMilliseconds: 10,
    isPortAvailable: async (port) => port === 5554 || port === 5555,
    nowMilliseconds: () => 0,
    processRegistry,
    runCommand,
    sleep: async () => {},
    spawnProcess: () => fakeChild(emulatorPid),
    toolEnvironment: { PATH: "/usr/bin" },
  });
  const lifecycle = createAvdLifecycleDeps({
    avdRoot,
    adbPath: toolPaths.adb,
    emulatorPath: toolPaths.emulator,
    avdmanagerPath: toolPaths.avdmanager,
  }, {
    currentProcessPid: markerOwnerPid,
    processRegistry,
    runCommand,
    stopEmulator: processOperations.rollbackOwnedEmulator,
    toolEnvironment: { PATH: "/usr/bin" },
  });
  ownership = await reserveAvdOwnership({
    scenarioId: "onboarding",
    runId: "run-7",
    nonce: "identity-seam",
    markerRoot,
    avdRoot,
    systemImage: SYSTEM_IMAGE,
  }, lifecycle);
  await mkdir(ownership.avdPath, { mode: 0o700 });
  await writeFile(path.join(ownership.avdPath, "config.ini"), [
    `AvdId=${ownership.avdName}`,
    "image.sysdir.1=system-images/android-35/google_apis/x86_64/",
    "",
  ].join("\n"));
  await writeFile(path.join(avdRoot, `${ownership.avdName}.ini`), [
    "avd.ini.encoding=UTF-8",
    `path=${ownership.avdPath}`,
    "target=android-35",
    "",
  ].join("\n"));
  avdCreated = true;

  return {
    lifecycle,
    markerPath: ownership.markerPath,
    ownership,
    processOperations,
    setEmulatorStartIdentity(value) {
      emulatorStartIdentity = value;
    },
    setEmulatorCommand(value) {
      emulatorCommandOverride = value;
    },
    toolPaths,
  };
}

test("production default inspectors preserve launch identity through AVD bind", async (t) => {
  const harness = await createDefaultInspectorHarness(t);
  const binding = await harness.processOperations.launchOwnedEmulator(
    createOwnedEmulatorLaunchPlan(harness.ownership, {
      emulatorBinary: harness.toolPaths.emulator,
    }),
  );

  const bound = await bindAvdProcess(harness.ownership, binding, harness.lifecycle);

  assert.equal(bound.processStartIdentity, "Sat Jul 18 12:00:00 2026");
  assert.equal(
    JSON.parse(await readFile(harness.markerPath, "utf8")).processStartIdentity,
    bound.processStartIdentity,
  );
});

test("production default lifecycle inspector rejects a reused launch PID before bind", async (t) => {
  const harness = await createDefaultInspectorHarness(t);
  const binding = await harness.processOperations.launchOwnedEmulator(
    createOwnedEmulatorLaunchPlan(harness.ownership, {
      emulatorBinary: harness.toolPaths.emulator,
    }),
  );
  harness.setEmulatorStartIdentity("Sat Jul 18 12:00:01 2026");

  await assert.rejects(
    bindAvdProcess(harness.ownership, binding, harness.lifecycle),
    /PID.*reused|changed start identity/i,
  );
  assert.equal(Object.hasOwn(JSON.parse(await readFile(harness.markerPath, "utf8")), "pid"), false);
});

test("production default lifecycle inspector rejects a changed command before bind", async (t) => {
  const harness = await createDefaultInspectorHarness(t);
  const binding = await harness.processOperations.launchOwnedEmulator(
    createOwnedEmulatorLaunchPlan(harness.ownership, {
      emulatorBinary: harness.toolPaths.emulator,
    }),
  );
  harness.setEmulatorCommand("/tmp/foreign-process --same-pid");

  await assert.rejects(
    bindAvdProcess(harness.ownership, binding, harness.lifecycle),
    /command|executable.*arguments/i,
  );
  assert.equal(Object.hasOwn(JSON.parse(await readFile(harness.markerPath, "utf8")), "pid"), false);
});
