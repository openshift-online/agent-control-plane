import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

let lifecycle = {};
try {
  lifecycle = await import("../../../scripts/capture/android/avd-lifecycle.mjs");
} catch (error) {
  if (error?.code !== "ERR_MODULE_NOT_FOUND") throw error;
}

test("exports the owned AVD reservation boundary", () => {
  assert.equal(typeof lifecycle.reserveAvdOwnership, "function");
});

const reservationInput = Object.freeze({
  scenarioId: "android-install-flow",
  runId: "run-2026-07-17T120000Z",
  nonce: "n-8fC_42",
  avdRoot: "/virtual/android/avd",
  markerRoot: "/virtual/demo-creator/avd-owners",
  systemImage: "system-images;android-35;google_apis;x86_64",
});

const processBinding = Object.freeze({
  serial: "emulator-5554",
  consolePort: 5554,
  pid: 4242,
  processStartIdentity: "pid-4242-start-987654321",
});
const markerUpdateOwner = Object.freeze({
  pid: 8181,
  processStartIdentity: "pid-8181-start-123456789",
});

function markerUpdateLock(ownership, owner = markerUpdateOwner) {
  return {
    version: 1,
    toolNamespace: "acp.demo-creator.android-avd.marker-update",
    avdName: ownership.avdName,
    markerPath: ownership.markerPath,
    ownerPid: owner.pid,
    ownerProcessStartIdentity: owner.processStartIdentity,
  };
}

function missing(pathname) {
  const error = new Error(`ENOENT: ${pathname}`);
  error.code = "ENOENT";
  return error;
}

function memoryFs({
  raceExclusiveCreate = false,
  exclusiveCreateMode,
  openedCreateMode,
  interruptedTempWrite = false,
  lockCleanupError = false,
} = {}) {
  const entries = new Map();
  const realpaths = new Map();
  const calls = {
    chmod: [],
    close: [],
    handleChmod: [],
    handleWriteFile: [],
    link: [],
    open: [],
    realpath: [],
    rename: [],
    rm: [],
    sync: [],
    writeFile: [],
  };
  return {
    entries,
    calls,
    alias(pathname, canonicalPath) {
      realpaths.set(pathname, canonicalPath);
    },
    seed(pathname, { contents = "", mode = 0o600, type = "file" } = {}) {
      entries.set(pathname, { contents, mode, type });
    },
    async access(pathname) {
      const entry = entries.get(pathname);
      if (!entry || entry.type === "symlink") throw missing(pathname);
    },
    async lstat(pathname) {
      const entry = entries.get(pathname);
      if (!entry) throw missing(pathname);
      return {
        mode: entry.mode,
        isFile: () => entry.type === "file",
        isDirectory: () => entry.type === "directory",
        isSymbolicLink: () => entry.type === "symlink",
      };
    },
    async realpath(pathname) {
      calls.realpath.push(pathname);
      if (realpaths.has(pathname)) return realpaths.get(pathname);
      if (!entries.has(pathname)) throw missing(pathname);
      return pathname;
    },
    async readFile(pathname) {
      const entry = entries.get(pathname);
      if (!entry) throw missing(pathname);
      return entry.contents;
    },
    async writeFile(pathname, contents, options = {}) {
      calls.writeFile.push({ pathname, contents: String(contents), options: { ...options } });
      if (options.flag === "wx" && (entries.has(pathname) || raceExclusiveCreate)) {
        const error = new Error(`EEXIST: ${pathname}`);
        error.code = "EEXIST";
        throw error;
      }
      if (options.flag === "r+" && !entries.has(pathname)) throw missing(pathname);
      entries.set(pathname, {
        contents: String(contents),
        mode: options.flag === "wx" && exclusiveCreateMode !== undefined
          ? exclusiveCreateMode
          : options.mode ?? entries.get(pathname)?.mode ?? 0o666,
        type: "file",
      });
    },
    async open(pathname, flags, mode) {
      calls.open.push({ pathname, flags, mode });
      if (flags === "wx") {
        if (entries.has(pathname)) {
          const error = new Error(`EEXIST: ${pathname}`);
          error.code = "EEXIST";
          throw error;
        }
        entries.set(pathname, {
          contents: "",
          mode: openedCreateMode ?? mode ?? 0o666,
          type: "file",
        });
      } else if (!entries.has(pathname)) {
        throw missing(pathname);
      }
      return {
        async chmod(handleMode) {
          calls.handleChmod.push({ pathname, mode: handleMode });
          entries.get(pathname).mode = handleMode;
        },
        async writeFile(contents, options = {}) {
          calls.handleWriteFile.push({ pathname, contents: String(contents), options: { ...options } });
          if (interruptedTempWrite && pathname.includes(".update-") && pathname.endsWith(".tmp")) {
            entries.get(pathname).contents = "partial";
            throw new Error("temp write interrupted");
          }
          entries.get(pathname).contents = String(contents);
        },
        async sync() {
          calls.sync.push(pathname);
        },
        async close() {
          calls.close.push(pathname);
        },
      };
    },
    async chmod(pathname, mode) {
      calls.chmod.push({ pathname, mode });
      const entry = entries.get(pathname);
      if (!entry) throw missing(pathname);
      entry.mode = mode;
    },
    async rename(sourcePath, destinationPath) {
      calls.rename.push({ sourcePath, destinationPath });
      const entry = entries.get(sourcePath);
      if (!entry) throw missing(sourcePath);
      entries.set(destinationPath, entry);
      entries.delete(sourcePath);
    },
    async link(sourcePath, destinationPath) {
      calls.link.push({ sourcePath, destinationPath });
      const entry = entries.get(sourcePath);
      if (!entry) throw missing(sourcePath);
      if (entries.has(destinationPath)) {
        const error = new Error(`EEXIST: ${destinationPath}`);
        error.code = "EEXIST";
        throw error;
      }
      entries.set(destinationPath, entry);
    },
    async rm(pathname, options = {}) {
      calls.rm.push(pathname);
      if (lockCleanupError && pathname.endsWith(".update.lock")) {
        throw new Error("synthetic AVD lock cleanup failure");
      }
      if (!entries.delete(pathname) && options.force !== true) throw missing(pathname);
    },
  };
}

function runtimeState() {
  const state = {
    avds: [],
    emulators: [],
    killed: [],
    deleted: [],
    events: [],
    killError: null,
    deleteError: null,
    markerUpdateOwner: structuredClone(markerUpdateOwner),
    markerUpdateOwnerInspection: structuredClone(markerUpdateOwner),
  };
  return {
    state,
    async inspectAvds() {
      return structuredClone(state.avds);
    },
    async inspectEmulators() {
      return structuredClone(state.emulators);
    },
    async assertEmulatorAbsent(identity) {
      const candidates = state.emulators.filter((emulator) => (
        emulator.avdName === identity.avdName
        || emulator.serial === identity.serial
        || emulator.consolePort === identity.consolePort
        || emulator.pid === identity.pid
      ));
      if (candidates.length !== 0) {
        throw new Error(`Emulator identity is not absent: ${identity.serial}`);
      }
    },
    async getMarkerUpdateOwner() {
      return structuredClone(state.markerUpdateOwner);
    },
    async inspectMarkerUpdateOwner() {
      return state.markerUpdateOwnerInspection === null
        ? null
        : { ...structuredClone(state.markerUpdateOwnerInspection), alive: true };
    },
    async killEmulator(identity) {
      state.events.push("kill");
      if (state.killError) throw state.killError;
      state.killed.push(structuredClone(identity));
      state.emulators = state.emulators.filter((emulator) => !(
        emulator.avdName === identity.avdName
        && emulator.serial === identity.serial
        && emulator.consolePort === identity.consolePort
        && emulator.pid === identity.pid
        && emulator.processStartIdentity === identity.processStartIdentity
      ));
    },
    async deleteAvd(identity) {
      state.events.push("delete");
      if (state.deleteError) throw state.deleteError;
      state.deleted.push(structuredClone(identity));
      state.avds = state.avds.filter((avd) => !(
        avd.avdName === identity.avdName && avd.avdPath === identity.avdPath
      ));
    },
  };
}

function harness(options) {
  const fs = memoryFs(options);
  fs.seed(reservationInput.avdRoot, { mode: 0o700, type: "directory" });
  fs.seed(reservationInput.markerRoot, { mode: 0o700, type: "directory" });
  return { fs, runtime: runtimeState() };
}

function exactAvd(ownership) {
  return {
    avdName: ownership.avdName,
    avdPath: ownership.avdPath,
    systemImage: ownership.systemImage,
    config: {
      avdName: ownership.avdName,
      avdPath: ownership.avdPath,
      systemImage: ownership.systemImage,
    },
  };
}

function exactEmulator(ownership, overrides = {}) {
  return {
    ...processBinding,
    avdName: ownership.avdName,
    ready: true,
    ...overrides,
  };
}

async function boundHarness() {
  const dependencies = harness();
  const ownership = await lifecycle.reserveAvdOwnership(reservationInput, dependencies);
  dependencies.runtime.state.avds.push(exactAvd(ownership));
  dependencies.runtime.state.emulators.push(exactEmulator(ownership));
  const bound = await lifecycle.bindAvdProcess(ownership, processBinding, dependencies);
  dependencies.fs.calls.rm.length = 0;
  return { dependencies, ownership, bound };
}

test("reserves a unique generated AVD with an external exact private marker", async () => {
  const dependencies = harness();

  const ownership = await lifecycle.reserveAvdOwnership(reservationInput, dependencies);

  assert.match(ownership.avdName, /^acp-demo-[a-z0-9-]+$/);
  assert.notEqual(ownership.avdName, reservationInput.scenarioId);
  assert.equal(ownership.avdPath, path.resolve(reservationInput.avdRoot, `${ownership.avdName}.avd`));
  assert.equal(ownership.markerPath, path.resolve(reservationInput.markerRoot, `${ownership.avdName}.owner.json`));
  assert.equal(path.dirname(ownership.avdPath), reservationInput.avdRoot);
  assert.equal(path.dirname(ownership.markerPath), reservationInput.markerRoot);
  assert.equal(ownership.markerPath.startsWith(`${ownership.avdPath}${path.sep}`), false);

  const markerEntry = dependencies.fs.entries.get(ownership.markerPath);
  assert.deepEqual(JSON.parse(markerEntry.contents), {
    version: 1,
    toolNamespace: "acp.demo-creator.android-avd",
    scenarioId: reservationInput.scenarioId,
    runId: reservationInput.runId,
    nonce: reservationInput.nonce,
    avdName: ownership.avdName,
    avdPath: ownership.avdPath,
    systemImage: reservationInput.systemImage,
  });
  assert.equal(markerEntry.mode & 0o777, 0o600);
  assert.deepEqual(dependencies.fs.calls.writeFile[0].options, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  assert.deepEqual(dependencies.fs.calls.realpath, [reservationInput.avdRoot, reservationInput.markerRoot]);
  assert.deepEqual(dependencies.fs.calls.chmod, [{ pathname: ownership.markerPath, mode: 0o600 }]);
});

test("reservation generates and persists a nonce when capture omits one", async () => {
  const nonceLessInput = { ...reservationInput };
  delete nonceLessInput.nonce;
  const generatedNonce = "generated-run-nonce-7a913";
  const dependencies = harness();
  let generated = 0;
  dependencies.randomUUID = () => {
    generated += 1;
    return generatedNonce;
  };

  const ownership = await lifecycle.reserveAvdOwnership(nonceLessInput, dependencies);
  const explicit = await lifecycle.reserveAvdOwnership(
    { ...nonceLessInput, nonce: generatedNonce },
    harness(),
  );
  const defaultGenerated = await lifecycle.reserveAvdOwnership(nonceLessInput, harness());

  assert.equal(generated, 1);
  assert.equal(ownership.nonce, generatedNonce);
  assert.equal(ownership.avdName, explicit.avdName);
  assert.equal(JSON.parse(dependencies.fs.entries.get(ownership.markerPath).contents).nonce, generatedNonce);
  assert.match(defaultGenerated.nonce, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(defaultGenerated.avdName, ownership.avdName);
});

test("reservation requires existing canonical directory roots and rejects symlink aliases", async (t) => {
  await t.test("missing root", async () => {
    const dependencies = harness();
    dependencies.fs.entries.delete(reservationInput.avdRoot);
    await assert.rejects(
      lifecycle.reserveAvdOwnership(reservationInput, dependencies),
      /avdRoot must already exist/,
    );
  });

  await t.test("non-directory root", async () => {
    const dependencies = harness();
    dependencies.fs.seed(reservationInput.markerRoot, { type: "file" });
    await assert.rejects(
      lifecycle.reserveAvdOwnership(reservationInput, dependencies),
      /markerRoot must be a directory/,
    );
  });

  await t.test("AVD root symlink alias", async () => {
    const dependencies = harness();
    const alias = "/virtual/android/avd-alias";
    dependencies.fs.alias(alias, reservationInput.avdRoot);
    await assert.rejects(
      lifecycle.reserveAvdOwnership({ ...reservationInput, avdRoot: alias }, dependencies),
      /avdRoot must be canonical/,
    );
  });

  await t.test("marker root symlink alias", async () => {
    const dependencies = harness();
    const alias = "/virtual/demo-creator/owner-alias";
    dependencies.fs.alias(alias, reservationInput.markerRoot);
    await assert.rejects(
      lifecycle.reserveAvdOwnership({ ...reservationInput, markerRoot: alias }, dependencies),
      /markerRoot must be canonical/,
    );
  });
});

test("reservation rejects a canonical marker root that escapes inside the generated AVD", async () => {
  const derived = await lifecycle.reserveAvdOwnership(reservationInput, harness());
  const dependencies = harness();
  dependencies.fs.seed(derived.avdPath, { mode: 0o700, type: "directory" });

  await assert.rejects(
    lifecycle.reserveAvdOwnership({ ...reservationInput, markerRoot: derived.avdPath }, dependencies),
    /marker must be external/,
  );
});

test("reservation chmods an exclusively created marker to exact mode 0600", async () => {
  const dependencies = harness({ exclusiveCreateMode: 0o400 });

  const ownership = await lifecycle.reserveAvdOwnership(reservationInput, dependencies);

  assert.equal(dependencies.fs.entries.get(ownership.markerPath).mode & 0o777, 0o600);
  assert.deepEqual(dependencies.fs.calls.chmod, [{ pathname: ownership.markerPath, mode: 0o600 }]);
});

test("generated names depend on scenario, run, and nonce and reject authored identities", async () => {
  const first = await lifecycle.reserveAvdOwnership(reservationInput, harness());
  const second = await lifecycle.reserveAvdOwnership({ ...reservationInput, nonce: "different-nonce" }, harness());
  const third = await lifecycle.reserveAvdOwnership({ ...reservationInput, runId: "different-run" }, harness());
  const fourth = await lifecycle.reserveAvdOwnership({ ...reservationInput, scenarioId: "different-scenario" }, harness());

  assert.equal(new Set([first.avdName, second.avdName, third.avdName, fourth.avdName]).size, 4);
  await assert.rejects(
    lifecycle.reserveAvdOwnership({ ...reservationInput, avdName: "shared-device" }, harness()),
    /caller-authored AVD identity/,
  );
  await assert.rejects(
    lifecycle.reserveAvdOwnership({ ...reservationInput, avdPath: "/shared/device.avd" }, harness()),
    /caller-authored AVD identity/,
  );
  await assert.rejects(
    lifecycle.reserveAvdOwnership({ ...reservationInput, markerPath: "/shared/owner.json" }, harness()),
    /caller-authored AVD identity/,
  );
});

test("reservation refuses a pre-existing generated name, AVD path, or marker", async () => {
  const derived = await lifecycle.reserveAvdOwnership(reservationInput, harness());

  const nameCollision = harness();
  nameCollision.runtime.state.avds.push({ avdName: derived.avdName });
  await assert.rejects(
    lifecycle.reserveAvdOwnership(reservationInput, nameCollision),
    /generated AVD name already exists/,
  );

  const pathCollision = harness();
  pathCollision.fs.seed(derived.avdPath, { type: "directory", mode: 0o700 });
  await assert.rejects(
    lifecycle.reserveAvdOwnership(reservationInput, pathCollision),
    /generated AVD path already exists/,
  );

  const markerCollision = harness();
  markerCollision.fs.seed(derived.markerPath, { contents: "do not overwrite" });
  await assert.rejects(
    lifecycle.reserveAvdOwnership(reservationInput, markerCollision),
    /ownership marker already exists/,
  );
  assert.equal(markerCollision.fs.entries.get(derived.markerPath).contents, "do not overwrite");
});

test("reservation uses exclusive marker creation and refuses a creation race", async () => {
  const dependencies = harness({ raceExclusiveCreate: true });

  await assert.rejects(
    lifecycle.reserveAvdOwnership(reservationInput, dependencies),
    /ownership marker was claimed concurrently/,
  );
  assert.deepEqual(dependencies.fs.calls.writeFile[0].options, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
});

test("creates a safe launch plan for only the generated AVD at vsync rate 30", async () => {
  assert.equal(typeof lifecycle.createOwnedEmulatorLaunchPlan, "function");
  const ownership = await lifecycle.reserveAvdOwnership(reservationInput, harness());

  const plan = lifecycle.createOwnedEmulatorLaunchPlan(ownership);

  assert.deepEqual(plan, {
    executable: "emulator",
    args: [
      "-avd",
      ownership.avdName,
      "-no-snapshot-save",
      "-no-audio",
      "-no-boot-anim",
      "-vsync-rate",
      "30",
    ],
    avdName: ownership.avdName,
  });
  assert.equal(plan.args.filter((argument) => argument === "-vsync-rate").length, 1);
});

test("launch planning rejects caller-authored or forged AVD names", async () => {
  const ownership = await lifecycle.reserveAvdOwnership(reservationInput, harness());

  assert.throws(
    () => lifecycle.createOwnedEmulatorLaunchPlan(ownership, { avdName: "shared-device" }),
    /caller-authored AVD name/,
  );
  assert.throws(
    () => lifecycle.createOwnedEmulatorLaunchPlan({ ...ownership, avdName: "shared-device" }),
    /generated AVD identity/,
  );
});

test("binds and verifies the exact created AVD and live emulator identity", async () => {
  assert.equal(typeof lifecycle.bindAvdProcess, "function");
  assert.equal(typeof lifecycle.verifyOwnedAvd, "function");
  const dependencies = harness();
  const ownership = await lifecycle.reserveAvdOwnership(reservationInput, dependencies);
  dependencies.runtime.state.avds.push(exactAvd(ownership));

  const unboundVerification = await lifecycle.verifyOwnedAvd(ownership, dependencies);
  assert.deepEqual(unboundVerification, {
    marker: Object.fromEntries(Object.entries(ownership).filter(([key]) => key !== "markerPath")),
    avd: exactAvd(ownership),
    emulator: null,
  });

  dependencies.runtime.state.emulators.push(exactEmulator(ownership));
  const bound = await lifecycle.bindAvdProcess(ownership, processBinding, dependencies);
  assert.deepEqual(bound, { ...ownership, ...processBinding });
  assert.deepEqual(JSON.parse(dependencies.fs.entries.get(ownership.markerPath).contents), {
    version: 1,
    toolNamespace: "acp.demo-creator.android-avd",
    scenarioId: reservationInput.scenarioId,
    runId: reservationInput.runId,
    nonce: reservationInput.nonce,
    avdName: ownership.avdName,
    avdPath: ownership.avdPath,
    systemImage: reservationInput.systemImage,
    ...processBinding,
  });

  const boundVerification = await lifecycle.verifyOwnedAvd(bound, dependencies);
  assert.deepEqual(boundVerification, {
    marker: { ...unboundVerification.marker, ...processBinding },
    avd: exactAvd(ownership),
    emulator: exactEmulator(ownership),
  });

  const lockPath = `${ownership.markerPath}.update.lock`;
  const lockCandidateOpen = dependencies.fs.calls.open.find(({ pathname, flags }) => (
    flags === "wx" && pathname.includes(".update.lock.candidate-") && pathname.endsWith(".tmp")
  ));
  const markerTempOpen = dependencies.fs.calls.open.find(({ pathname, flags }) => (
    flags === "wx"
    && pathname.startsWith(`${ownership.markerPath}.update-`)
    && !pathname.includes(".update.lock.")
    && pathname.endsWith(".tmp")
  ));
  assert.ok(lockCandidateOpen, "expected one complete lock candidate before atomic publication");
  assert.ok(markerTempOpen, "expected one exclusive generated marker temp file");
  assert.equal(lockCandidateOpen.mode, 0o600);
  assert.equal(markerTempOpen.mode, 0o600);
  assert.deepEqual(dependencies.fs.calls.link, [{
    sourcePath: lockCandidateOpen.pathname,
    destinationPath: lockPath,
  }]);
  assert.deepEqual(JSON.parse(
    dependencies.fs.calls.handleWriteFile.find(({ pathname }) => pathname === lockCandidateOpen.pathname).contents,
  ), markerUpdateLock(ownership));
  assert.ok(dependencies.fs.calls.sync.includes(lockCandidateOpen.pathname));
  assert.ok(dependencies.fs.calls.sync.includes(markerTempOpen.pathname));
  assert.deepEqual(dependencies.fs.calls.rename, [{
    sourcePath: markerTempOpen.pathname,
    destinationPath: ownership.markerPath,
  }]);
  assert.equal(dependencies.fs.calls.writeFile.some(({ options }) => options.flag === "r+"), false);
  assert.equal(dependencies.fs.entries.has(lockPath), false);
  assert.equal([...dependencies.fs.entries.keys()].some((pathname) => pathname.endsWith(".tmp")), false);
});

test("binding refuses an ambiguous adjacent update lock without changing the base marker", async () => {
  const dependencies = harness();
  const ownership = await lifecycle.reserveAvdOwnership(reservationInput, dependencies);
  dependencies.runtime.state.avds.push(exactAvd(ownership));
  dependencies.runtime.state.emulators.push(exactEmulator(ownership));
  const markerBefore = dependencies.fs.entries.get(ownership.markerPath).contents;
  const lockPath = `${ownership.markerPath}.update.lock`;
  dependencies.fs.seed(lockPath, { contents: "held by another binder", mode: 0o600 });

  await assert.rejects(
    lifecycle.bindAvdProcess(ownership, processBinding, dependencies),
    /marker update lock is unreadable|marker update lock.*ambiguous/,
  );

  assert.equal(dependencies.fs.entries.get(ownership.markerPath).contents, markerBefore);
  assert.equal(dependencies.fs.entries.get(lockPath).contents, "held by another binder");
  assert.deepEqual(dependencies.fs.calls.rename, []);
  assert.equal([...dependencies.fs.entries.keys()].some((pathname) => pathname.endsWith(".tmp")), false);
});

test("an interrupted temp write preserves the base marker and cleans owned update artifacts", async () => {
  const dependencies = harness({ interruptedTempWrite: true });
  const ownership = await lifecycle.reserveAvdOwnership(reservationInput, dependencies);
  dependencies.runtime.state.avds.push(exactAvd(ownership));
  dependencies.runtime.state.emulators.push(exactEmulator(ownership));
  const markerBefore = dependencies.fs.entries.get(ownership.markerPath).contents;
  const lockPath = `${ownership.markerPath}.update.lock`;

  await assert.rejects(
    lifecycle.bindAvdProcess(ownership, processBinding, dependencies),
    /temp write interrupted/,
  );

  assert.equal(dependencies.fs.entries.get(ownership.markerPath).contents, markerBefore);
  assert.equal(dependencies.fs.entries.has(lockPath), false);
  assert.equal([...dependencies.fs.entries.keys()].some((pathname) => pathname.endsWith(".tmp")), false);
  assert.deepEqual(dependencies.fs.calls.rename, []);
});

test("bind errors after a persisted bound marker expose non-enumerable recovered ownership", async () => {
  const dependencies = harness({ lockCleanupError: true });
  const ownership = await lifecycle.reserveAvdOwnership(reservationInput, dependencies);
  dependencies.runtime.state.avds.push(exactAvd(ownership));
  dependencies.runtime.state.emulators.push(exactEmulator(ownership));

  let thrown;
  try {
    await lifecycle.bindAvdProcess(ownership, processBinding, dependencies);
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown instanceof Error);
  assert.match(thrown.message, /synthetic AVD lock cleanup failure/);
  const descriptor = Object.getOwnPropertyDescriptor(thrown, "recoveredBoundOwnership");
  assert.equal(descriptor?.enumerable, false);
  assert.equal(descriptor?.writable, false);
  assert.deepEqual(descriptor?.value, { ...ownership, ...processBinding });
  assert.equal(Object.keys(thrown).includes("recoveredBoundOwnership"), false);
  assert.equal(Object.hasOwn(thrown, "bindOwnershipIndeterminate"), false);
});

test("bind recovery marks ownership indeterminate when exact post-persist proof fails", async () => {
  const dependencies = harness({ lockCleanupError: true });
  const ownership = await lifecycle.reserveAvdOwnership(reservationInput, dependencies);
  dependencies.runtime.state.avds.push(exactAvd(ownership));
  dependencies.runtime.state.emulators.push(exactEmulator(ownership));
  const originalInspectEmulators = dependencies.runtime.inspectEmulators.bind(dependencies.runtime);
  let inspections = 0;
  dependencies.runtime.inspectEmulators = async () => {
    inspections += 1;
    const emulators = await originalInspectEmulators();
    if (inspections >= 5) emulators[0].processStartIdentity = "indeterminate-after-persist";
    return emulators;
  };

  let thrown;
  try {
    await lifecycle.bindAvdProcess(ownership, processBinding, dependencies);
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown instanceof Error);
  assert.equal(Object.hasOwn(thrown, "recoveredBoundOwnership"), false);
  const descriptor = Object.getOwnPropertyDescriptor(thrown, "bindOwnershipIndeterminate");
  assert.equal(descriptor?.value, true);
  assert.equal(descriptor?.enumerable, false);
  assert.equal(descriptor?.writable, false);
});

test("verification rejects marker permissions, marker fields, and AVD config mismatches", async (t) => {
  await t.test("private marker permissions", async () => {
    const { dependencies, ownership, bound } = await boundHarness();
    dependencies.fs.entries.get(ownership.markerPath).mode = 0o644;
    await assert.rejects(lifecycle.verifyOwnedAvd(bound, dependencies), /permissions must be 0600/);
  });

  await t.test("exact marker fields", async () => {
    const { dependencies, ownership, bound } = await boundHarness();
    const entry = dependencies.fs.entries.get(ownership.markerPath);
    entry.contents = JSON.stringify({ ...JSON.parse(entry.contents), diagnosticOverride: true });
    await assert.rejects(lifecycle.verifyOwnedAvd(bound, dependencies), /marker fields do not exactly match/);
  });

  await t.test("exact AVD path, image, and config", async () => {
    for (const mutate of [
      (avd) => { avd.avdPath = "/shared/external.avd"; },
      (avd) => { avd.systemImage = "system-images;android-34;default;x86_64"; },
      (avd) => { avd.config.systemImage = "system-images;android-34;default;x86_64"; },
      (avd) => { avd.config.externalField = "not-owned"; },
    ]) {
      const { dependencies, bound } = await boundHarness();
      mutate(dependencies.runtime.state.avds[0]);
      await assert.rejects(lifecycle.verifyOwnedAvd(bound, dependencies), /path, system image, or config mismatch/);
    }
  });
});

test("binding performs no marker mutation when the live process identity is not exact", async () => {
  const dependencies = harness();
  const ownership = await lifecycle.reserveAvdOwnership(reservationInput, dependencies);
  dependencies.runtime.state.avds.push(exactAvd(ownership));
  dependencies.runtime.state.emulators.push(exactEmulator(ownership, {
    processStartIdentity: "reused-pid-different-start",
  }));

  await assert.rejects(
    lifecycle.bindAvdProcess(ownership, processBinding, dependencies),
    /process start identity mismatch/,
  );
  assert.equal(dependencies.fs.calls.writeFile.length, 1);
  assert.deepEqual(JSON.parse(dependencies.fs.entries.get(ownership.markerPath).contents),
    Object.fromEntries(Object.entries(ownership).filter(([key]) => key !== "markerPath")));
});

test("verification detects PID reuse and ambiguous live emulator identities", async () => {
  for (const [field, changedValue] of [
    ["serial", "emulator-5556"],
    ["consolePort", 5556],
    ["pid", 9001],
    ["processStartIdentity", "same-pid-new-process"],
  ]) {
    const current = await boundHarness();
    current.dependencies.runtime.state.emulators[0][field] = changedValue;
    await assert.rejects(
      lifecycle.verifyOwnedAvd(current.bound, current.dependencies),
      /serial, console port, PID, or process start identity mismatch/,
    );
  }

  const second = await boundHarness();
  second.dependencies.runtime.state.emulators.push(exactEmulator(second.ownership));
  await assert.rejects(
    lifecycle.verifyOwnedAvd(second.bound, second.dependencies),
    /process identity is ambiguous/,
  );
});

test("ready assertion and teardown re-verify then remove only the exact owned process and AVD", async () => {
  assert.equal(typeof lifecycle.assertOwnedAvdReady, "function");
  assert.equal(typeof lifecycle.teardownOwnedAvd, "function");
  const { dependencies, ownership, bound } = await boundHarness();

  const ready = await lifecycle.assertOwnedAvdReady(bound, dependencies);
  assert.equal(ready.emulator.ready, true);

  const result = await lifecycle.teardownOwnedAvd(bound, dependencies);

  assert.deepEqual(result, {
    action: "deleted",
    avdName: ownership.avdName,
    serial: processBinding.serial,
  });
  assert.deepEqual(dependencies.runtime.state.events, ["kill", "delete"]);
  assert.deepEqual(dependencies.runtime.state.killed, [{
    avdName: ownership.avdName,
    ...processBinding,
  }]);
  assert.deepEqual(dependencies.runtime.state.deleted, [{
    avdName: ownership.avdName,
    avdPath: ownership.avdPath,
    systemImage: ownership.systemImage,
  }]);
  assert.equal(dependencies.fs.entries.has(ownership.markerPath), false);
  assert.deepEqual(
    dependencies.fs.calls.rm.filter((pathname) => (
      pathname === `${ownership.markerPath}.update.lock` || pathname === ownership.markerPath
    )),
    [`${ownership.markerPath}.update.lock`, ownership.markerPath],
  );
});

test("readiness requires a bound exact emulator that reports ready", async () => {
  const { dependencies, bound } = await boundHarness();
  dependencies.runtime.state.emulators[0].ready = false;
  await assert.rejects(lifecycle.assertOwnedAvdReady(bound, dependencies), /not ready/);
});

test("teardown fails closed on re-verification ambiguity and preserves marker diagnostics", async () => {
  const { dependencies, ownership, bound } = await boundHarness();
  dependencies.runtime.state.emulators[0].processStartIdentity = "pid-reused-after-ready-check";
  const markerBefore = dependencies.fs.entries.get(ownership.markerPath).contents;

  await assert.rejects(
    lifecycle.teardownOwnedAvd(bound, dependencies),
    /process start identity mismatch/,
  );

  assert.deepEqual(dependencies.runtime.state.events, []);
  assert.deepEqual(dependencies.runtime.state.killed, []);
  assert.deepEqual(dependencies.runtime.state.deleted, []);
  assert.deepEqual(dependencies.fs.calls.rm, []);
  assert.equal(dependencies.fs.entries.get(ownership.markerPath).contents, markerBefore);
});

test("teardown performs no mutation when the AVD identity is ambiguous", async () => {
  const { dependencies, ownership, bound } = await boundHarness();
  dependencies.runtime.state.avds.push(exactAvd(ownership));
  const markerBefore = dependencies.fs.entries.get(ownership.markerPath).contents;

  await assert.rejects(lifecycle.teardownOwnedAvd(bound, dependencies), /AVD identity is ambiguous/);

  assert.deepEqual(dependencies.runtime.state.events, []);
  assert.deepEqual(dependencies.fs.calls.rm, []);
  assert.equal(dependencies.fs.entries.get(ownership.markerPath).contents, markerBefore);
});

test("teardown preserves the marker when a destructive runtime operation fails", async (t) => {
  await t.test("kill failure", async () => {
    const { dependencies, ownership, bound } = await boundHarness();
    dependencies.runtime.state.killError = new Error("kill failed");
    await assert.rejects(lifecycle.teardownOwnedAvd(bound, dependencies), /kill failed/);
    assert.deepEqual(dependencies.runtime.state.deleted, []);
    assert.equal(dependencies.fs.entries.has(ownership.markerPath), true);
  });

  await t.test("AVD deletion failure", async () => {
    const { dependencies, ownership, bound } = await boundHarness();
    dependencies.runtime.state.deleteError = new Error("delete failed");
    await assert.rejects(lifecycle.teardownOwnedAvd(bound, dependencies), /delete failed/);
    assert.equal(dependencies.runtime.state.killed.length, 1);
    assert.equal(dependencies.fs.entries.has(ownership.markerPath), true);
  });
});

test("teardown persists a deletion-pending phase and recovers after kill succeeds but deletion fails", async () => {
  const { dependencies, ownership, bound } = await boundHarness();
  dependencies.runtime.state.deleteError = new Error("delete failed after exact emulator stop");

  await assert.rejects(
    lifecycle.teardownOwnedAvd(bound, dependencies),
    /delete failed after exact emulator stop/,
  );

  assert.equal(dependencies.runtime.state.emulators.length, 0);
  assert.equal(dependencies.runtime.state.killed.length, 1);
  assert.equal(Object.hasOwn(bound, "teardownPhase"), false, "phase remains marker-private");
  assert.deepEqual(JSON.parse(dependencies.fs.entries.get(ownership.markerPath).contents), {
    version: 1,
    toolNamespace: "acp.demo-creator.android-avd",
    scenarioId: reservationInput.scenarioId,
    runId: reservationInput.runId,
    nonce: reservationInput.nonce,
    avdName: ownership.avdName,
    avdPath: ownership.avdPath,
    systemImage: reservationInput.systemImage,
    ...processBinding,
    teardownPhase: "avd-delete-pending",
  });

  dependencies.runtime.state.deleteError = null;
  const result = await lifecycle.teardownOwnedAvd(bound, dependencies);

  assert.deepEqual(result, {
    action: "deleted",
    avdName: ownership.avdName,
    serial: processBinding.serial,
  });
  assert.deepEqual(dependencies.runtime.state.events, ["kill", "delete", "delete"]);
  assert.equal(dependencies.runtime.state.killed.length, 1, "retry must not signal any process");
  assert.equal(dependencies.runtime.state.avds.length, 0);
  assert.equal(dependencies.fs.entries.has(ownership.markerPath), false);
});

test("deletion-pending retry refuses reused or foreign emulator identities without signaling them", async () => {
  const { dependencies, ownership, bound } = await boundHarness();
  dependencies.runtime.state.deleteError = new Error("delete failed");
  await assert.rejects(lifecycle.teardownOwnedAvd(bound, dependencies), /delete failed/);
  dependencies.runtime.state.deleteError = null;
  dependencies.runtime.state.emulators.push(exactEmulator(ownership, {
    avdName: "foreign-avd",
    processStartIdentity: "reused-or-foreign-process",
  }));
  const markerBefore = dependencies.fs.entries.get(ownership.markerPath).contents;

  await assert.rejects(
    lifecycle.teardownOwnedAvd(bound, dependencies),
    /absent|changed|mismatch|foreign|reused|ambiguous/i,
  );

  assert.equal(dependencies.runtime.state.killed.length, 1, "retry must not signal a foreign process");
  assert.equal(dependencies.runtime.state.deleted.length, 0);
  assert.equal(dependencies.fs.entries.get(ownership.markerPath).contents, markerBefore);
});

test("deletion-pending retry removes its marker when deletion already completed but reported failure", async () => {
  const { dependencies, ownership, bound } = await boundHarness();
  dependencies.runtime.state.deleteError = new Error("delete outcome indeterminate");
  await assert.rejects(lifecycle.teardownOwnedAvd(bound, dependencies), /delete outcome indeterminate/);
  dependencies.runtime.state.deleteError = null;
  dependencies.runtime.state.avds = [];
  const deleteAttempts = dependencies.runtime.state.events.filter((event) => event === "delete").length;

  const result = await lifecycle.teardownOwnedAvd(bound, dependencies);

  assert.equal(result.action, "deleted");
  assert.equal(
    dependencies.runtime.state.events.filter((event) => event === "delete").length,
    deleteAttempts,
    "an already-absent AVD must not be deleted again",
  );
  assert.equal(dependencies.fs.entries.has(ownership.markerPath), false);
});

test("teardown retains the pending marker unless exact AVD and path absence is proven", async () => {
  const { dependencies, ownership, bound } = await boundHarness();
  dependencies.runtime.deleteAvd = async () => {
    dependencies.runtime.state.events.push("delete-without-removal");
  };

  await assert.rejects(
    lifecycle.teardownOwnedAvd(bound, dependencies),
    /did not prove absence|still exists|still present/i,
  );

  assert.equal(dependencies.runtime.state.avds.length, 1);
  assert.equal(dependencies.fs.entries.has(ownership.markerPath), true);
});

test("deletion-pending retry treats dangling symlinks and leftover exact paths as present", async (t) => {
  for (const fixture of [
    { label: "dangling AVD symlink", target: "avd", type: "symlink" },
    { label: "leftover AVD directory", target: "avd", type: "directory" },
    { label: "leftover definition file", target: "definition", type: "file" },
  ]) {
    await t.test(fixture.label, async () => {
      const { dependencies, ownership, bound } = await boundHarness();
      dependencies.runtime.state.deleteError = new Error("delete outcome indeterminate");
      await assert.rejects(lifecycle.teardownOwnedAvd(bound, dependencies), /delete outcome indeterminate/);
      dependencies.runtime.state.deleteError = null;
      dependencies.runtime.state.avds = [];
      const definitionPath = path.join(path.dirname(ownership.avdPath), `${ownership.avdName}.ini`);
      dependencies.fs.seed(
        fixture.target === "avd" ? ownership.avdPath : definitionPath,
        { type: fixture.type, mode: fixture.type === "directory" ? 0o700 : 0o600 },
      );

      await assert.rejects(
        lifecycle.teardownOwnedAvd(bound, dependencies),
        /path still exists|did not prove absence/i,
      );

      assert.equal(dependencies.fs.entries.has(ownership.markerPath), true);
    });
  }
});

test("teardown recovers a crash-stale process-bound marker lock before and after phase persistence", async (t) => {
  await t.test("bound marker after exact stop, before pending temp write", async () => {
    const { dependencies, ownership, bound } = await boundHarness();
    dependencies.runtime.state.emulators = [];
    dependencies.runtime.state.markerUpdateOwnerInspection = null;
    const lockPath = `${ownership.markerPath}.update.lock`;
    dependencies.fs.seed(lockPath, {
      contents: `${JSON.stringify(markerUpdateLock(ownership))}\n`,
      mode: 0o600,
    });

    const result = await lifecycle.teardownOwnedAvd(bound, dependencies);

    assert.equal(result.action, "deleted");
    assert.equal(dependencies.runtime.state.killed.length, 0);
    assert.equal(dependencies.fs.entries.has(lockPath), false);
    assert.equal(dependencies.fs.entries.has(ownership.markerPath), false);
  });

  await t.test("bound marker with a completed pending temp, before rename", async () => {
    const { dependencies, ownership, bound } = await boundHarness();
    dependencies.runtime.state.emulators = [];
    dependencies.runtime.state.markerUpdateOwnerInspection = null;
    const lockPath = `${ownership.markerPath}.update.lock`;
    const crashedTempPath = `${ownership.markerPath}.update-crashed-before-rename.tmp`;
    dependencies.fs.seed(lockPath, {
      contents: `${JSON.stringify(markerUpdateLock(ownership))}\n`,
      mode: 0o600,
    });
    dependencies.fs.seed(crashedTempPath, {
      contents: `${JSON.stringify({
        ...JSON.parse(dependencies.fs.entries.get(ownership.markerPath).contents),
        teardownPhase: "avd-delete-pending",
      })}\n`,
      mode: 0o600,
    });

    const result = await lifecycle.teardownOwnedAvd(bound, dependencies);

    assert.equal(result.action, "deleted");
    assert.equal(dependencies.runtime.state.killed.length, 0);
    assert.equal(dependencies.fs.entries.has(lockPath), false);
    assert.equal(dependencies.fs.entries.has(ownership.markerPath), false);
  });

  await t.test("pending marker after rename", async () => {
    const { dependencies, ownership, bound } = await boundHarness();
    dependencies.runtime.state.emulators = [];
    dependencies.runtime.state.markerUpdateOwnerInspection = null;
    const lockPath = `${ownership.markerPath}.update.lock`;
    const marker = JSON.parse(dependencies.fs.entries.get(ownership.markerPath).contents);
    dependencies.fs.entries.get(ownership.markerPath).contents = `${JSON.stringify({
      ...marker,
      teardownPhase: "avd-delete-pending",
    })}\n`;
    dependencies.fs.seed(lockPath, {
      contents: `${JSON.stringify(markerUpdateLock(ownership))}\n`,
      mode: 0o600,
    });

    const result = await lifecycle.teardownOwnedAvd(bound, dependencies);

    assert.equal(result.action, "deleted");
    assert.equal(dependencies.runtime.state.killed.length, 0);
    assert.equal(dependencies.fs.entries.has(lockPath), false);
    assert.equal(dependencies.fs.entries.has(ownership.markerPath), false);
  });
});

test("teardown refuses active, PID-reused, or ambiguous marker-lock owners", async (t) => {
  for (const fixture of [
    {
      label: "active owner",
      inspection: markerUpdateOwner,
      error: /marker update owner is still active/i,
    },
    {
      label: "reused PID",
      inspection: { ...markerUpdateOwner, processStartIdentity: "pid-8181-reused" },
      error: /marker update owner PID was reused/i,
    },
    {
      label: "ambiguous inspection",
      inspection: { pid: 9191, processStartIdentity: "different-process" },
      error: /marker update owner inspection is ambiguous/i,
    },
  ]) {
    await t.test(fixture.label, async () => {
      const { dependencies, ownership, bound } = await boundHarness();
      dependencies.runtime.state.emulators = [];
      dependencies.runtime.state.markerUpdateOwnerInspection = fixture.inspection;
      const lockPath = `${ownership.markerPath}.update.lock`;
      dependencies.fs.seed(lockPath, {
        contents: `${JSON.stringify(markerUpdateLock(ownership))}\n`,
        mode: 0o600,
      });
      const markerBefore = dependencies.fs.entries.get(ownership.markerPath).contents;

      await assert.rejects(lifecycle.teardownOwnedAvd(bound, dependencies), fixture.error);

      assert.equal(dependencies.runtime.state.deleted.length, 0);
      assert.equal(dependencies.runtime.state.killed.length, 0);
      assert.equal(dependencies.fs.entries.get(ownership.markerPath).contents, markerBefore);
      assert.equal(dependencies.fs.entries.has(lockPath), true);
    });
  }
});
