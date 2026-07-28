import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import * as fileSystem from "node:fs/promises";
import {
  access,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  assertOwnedKindClusterReady,
  beginKindClusterCreation,
  bindKindCluster as bindKindClusterImplementation,
  completeKindClusterCreation,
  reserveKindClusterOwnership,
  teardownOwnedKindCluster as teardownOwnedKindClusterImplementation,
  verifyOwnedKindAcpEndpoint,
  verifyOwnedKindCluster,
} from "../../../scripts/capture/android/kind-lifecycle.mjs";

const execFileAsync = promisify(execFile);

const SCENARIO_ID = "Android Demo / Flow";
const RUN_ID = "Run:001";
const NONCE = "Nonce_ABC";
const EXPECTED_CLUSTER_NAME = "acp-demo-android-demo-flow-run-001-nonce-abc";
const EXPECTED_KUBE_CONTEXT = `kind-${EXPECTED_CLUSTER_NAME}`;
const MARKER_UPDATE_OWNER = Object.freeze({
  pid: 8181,
  processStartIdentity: "pid-8181-start-123456789",
});

function kindLifecycleOptions(options = {}) {
  return {
    getMarkerUpdateOwner: async () => MARKER_UPDATE_OWNER,
    inspectMarkerUpdateOwner: async (owner) => ({ ...owner, alive: true }),
    ...options,
  };
}

function bindKindCluster(reservation, options = {}) {
  return bindKindClusterImplementation(reservation, kindLifecycleOptions(options));
}

function teardownOwnedKindCluster(reservation, options = {}) {
  return teardownOwnedKindClusterImplementation(reservation, kindLifecycleOptions(options));
}

function markerUpdateLock(bound, owner = MARKER_UPDATE_OWNER) {
  return {
    version: 1,
    toolNamespace: "acp.demo-creator.android.kind.marker-update",
    clusterName: bound.clusterName,
    markerPath: bound.markerPath,
    ownerPid: owner.pid,
    ownerProcessStartIdentity: owner.processStartIdentity,
  };
}

async function markerFixture(context, name) {
  const root = await mkdtemp(path.join(tmpdir(), `${name}-`));
  context.after(() => rm(root, { recursive: true, force: true }));
  return realpath(root);
}

function markerPath(markerRoot) {
  return path.join(markerRoot, `${EXPECTED_CLUSTER_NAME}.owner.json`);
}

function absentInspection(overrides = {}) {
  return {
    kindClusterNames: ["unrelated-kind-cluster"],
    kubeContexts: ["kind-unrelated-kind-cluster"],
    kubeServers: [],
    containerIdentities: [],
    currentKubeContext: "kind-unrelated-kind-cluster",
    ...overrides,
  };
}

function boundInspection(overrides = {}) {
  return {
    kindClusterNames: [EXPECTED_CLUSTER_NAME, "unrelated-kind-cluster"],
    kubeContexts: [EXPECTED_KUBE_CONTEXT, "kind-unrelated-kind-cluster"],
    currentKubeContext: "kind-unrelated-kind-cluster",
    inspectedKubeContext: EXPECTED_KUBE_CONTEXT,
    kubeServer: "https://127.0.0.1:61443",
    containerIdentities: [
      "sha256:worker-node-identity",
      "sha256:control-plane-node-identity",
    ],
    ready: true,
    ...overrides,
  };
}

async function reserve(markerRoot, inspectKindCluster = async () => absentInspection()) {
  return reserveKindClusterOwnership({
    scenarioId: SCENARIO_ID,
    runId: RUN_ID,
    nonce: NONCE,
    markerRoot,
  }, { inspectKindCluster });
}

async function beginCreation(reservation, createdInspection = boundInspection()) {
  const creationTransaction = await beginKindClusterCreation(reservation, {
    inspectKindCluster: async () => absentInspection(),
  });
  return completeKindClusterCreation(reservation, {
    creationTransaction,
    createdContainerIdentities: createdInspection.containerIdentities,
    inspectKindCluster: async () => createdInspection,
  });
}

async function reserveAndBind(markerRoot, inspectKindCluster = async () => boundInspection()) {
  const reservation = await reserve(markerRoot);
  const creationTransaction = await beginCreation(reservation);
  const bound = await bindKindCluster(reservation, { creationTransaction, inspectKindCluster });
  return { reservation, bound };
}

test("bind requires a one-use creation transaction and rejects a same-name replacement", async (context) => {
  const markerRoot = await markerFixture(context, "kind-bind-creation-provenance");
  const reservation = await reserve(markerRoot);
  let deletionCalls = 0;

  await assert.rejects(
    bindKindCluster(reservation, { inspectKindCluster: async () => boundInspection() }),
    /creation transaction/i,
  );

  const pendingCreationTransaction = await beginKindClusterCreation(reservation, {
    inspectKindCluster: async ({ phase }) => {
      assert.equal(phase, "create-preflight");
      return absentInspection();
    },
  });
  const creationTransaction = await completeKindClusterCreation(reservation, {
    creationTransaction: pendingCreationTransaction,
    createdContainerIdentities: boundInspection().containerIdentities,
    inspectKindCluster: async () => boundInspection(),
  });
  let inspections = 0;
  await assert.rejects(
    bindKindCluster(reservation, {
      creationTransaction,
      inspectKindCluster: async () => {
        inspections += 1;
        return inspections === 1
          ? boundInspection()
          : boundInspection({ containerIdentities: ["sha256:foreign-replacement"] });
      },
      deleteKindCluster: async () => { deletionCalls += 1; },
    }),
    /creation.*identity|container identities changed|replacement/i,
  );
  assert.equal(inspections, 2);
  assert.equal(deletionCalls, 0);
  assert.match(await readFile(reservation.markerPath, "utf8"), /android\.kind/u);

  const bound = await bindKindCluster(reservation, {
    creationTransaction,
    inspectKindCluster: async () => boundInspection(),
  });
  assert.equal(bound.clusterName, EXPECTED_CLUSTER_NAME);
  await assert.rejects(
    bindKindCluster(reservation, {
      creationTransaction,
      inspectKindCluster: async () => boundInspection(),
    }),
    /creation transaction.*used|one-use/i,
  );
});

test("bind retains its one-use creation authority until a bound marker is verified", async (context) => {
  const markerRoot = await markerFixture(context, "kind-bind-retry-before-persist");
  const reservation = await reserve(markerRoot);
  const creationTransaction = await beginCreation(reservation);
  const reservedMarker = await readFile(reservation.markerPath, "utf8");
  let inspections = 0;

  await assert.rejects(
    bindKindCluster(reservation, {
      creationTransaction,
      inspectKindCluster: async () => {
        inspections += 1;
        throw new Error("synthetic pre-persistence inspection failure");
      },
    }),
    /synthetic pre-persistence inspection failure/,
  );
  assert.equal(await readFile(reservation.markerPath, "utf8"), reservedMarker);

  const bound = await bindKindCluster(reservation, {
    creationTransaction,
    inspectKindCluster: async () => {
      inspections += 1;
      return boundInspection();
    },
  });

  assert.equal(bound.clusterName, EXPECTED_CLUSTER_NAME);
  assert.equal(inspections, 3);
  await assert.rejects(
    bindKindCluster(reservation, {
      creationTransaction,
      inspectKindCluster: async () => boundInspection(),
    }),
    /creation transaction.*used|one-use/i,
  );
});

test("bind rejects a stable same-name replacement that differs from the kind-up witness", async (context) => {
  const markerRoot = await markerFixture(context, "kind-bind-stable-replacement");
  const reservation = await reserve(markerRoot);
  const creationWitness = await beginCreation(reservation);
  let inspections = 0;

  await assert.rejects(
    bindKindCluster(reservation, {
      creationTransaction: creationWitness,
      inspectKindCluster: async () => {
        inspections += 1;
        return boundInspection({ containerIdentities: ["sha256:stable-foreign-replacement"] });
      },
    }),
    /container identities changed|creation.*identity|replacement/i,
  );
  assert.equal(inspections, 1);
  assert.match(await readFile(reservation.markerPath, "utf8"), /android\.kind/u);
});

test("bind rejects an exact-byte ownership marker replacement after creation preflight", async (context) => {
  const markerRoot = await markerFixture(context, "kind-bind-marker-inode-replacement");
  const reservation = await reserve(markerRoot);
  const creationTransaction = await beginCreation(reservation);
  const original = await readFile(reservation.markerPath, "utf8");
  const replacementPath = `${reservation.markerPath}.foreign`;
  await writeFile(replacementPath, original, { mode: 0o600 });
  await rename(replacementPath, reservation.markerPath);
  let inspections = 0;

  await assert.rejects(
    bindKindCluster(reservation, {
      creationTransaction,
      inspectKindCluster: async () => {
        inspections += 1;
        return boundInspection();
      },
    }),
    /marker.*(?:replaced|identity changed)|file identity.*changed/i,
  );
  assert.equal(inspections, 0);
  assert.equal(await readFile(reservation.markerPath, "utf8"), original);
});

test("bind rechecks marker file identity after its final live inspection", async (context) => {
  const markerRoot = await markerFixture(context, "kind-bind-final-marker-race");
  const reservation = await reserve(markerRoot);
  const creationTransaction = await beginCreation(reservation);
  const original = await readFile(reservation.markerPath, "utf8");
  let inspections = 0;

  await assert.rejects(
    bindKindCluster(reservation, {
      creationTransaction,
      inspectKindCluster: async () => {
        inspections += 1;
        if (inspections === 2) {
          const replacementPath = `${reservation.markerPath}.foreign`;
          await writeFile(replacementPath, original, { mode: 0o600 });
          await rename(replacementPath, reservation.markerPath);
        }
        return boundInspection();
      },
    }),
    /marker.*(?:replaced|identity changed)|file identity.*changed/i,
  );
  assert.equal(inspections, 2);
  assert.equal(await readFile(reservation.markerPath, "utf8"), original);
});

test("bind rejects an exact-byte inode swap immediately after atomic marker rename", async (context) => {
  const markerRoot = await markerFixture(context, "kind-bind-post-rename-race");
  const reservation = await reserve(markerRoot);
  const creationTransaction = await beginCreation(reservation);
  const replacingFs = new Proxy(fileSystem, {
    get(target, property) {
      if (property !== "rename") return Reflect.get(target, property);
      return async (source, destination) => {
        await fileSystem.rename(source, destination);
        if (destination === reservation.markerPath && source.includes(".owner.json.update.")) {
          const replacementPath = `${destination}.foreign`;
          await writeFile(replacementPath, await readFile(destination, "utf8"), { mode: 0o600 });
          await fileSystem.rename(replacementPath, destination);
        }
      };
    },
  });

  let thrown;
  try {
    await bindKindCluster(reservation, {
      creationTransaction,
      fs: replacingFs,
      inspectKindCluster: async () => boundInspection(),
    });
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown instanceof Error);
  assert.match(thrown.message, /marker.*identity|atomic.*replace|inode/i);
  assert.equal(Object.hasOwn(thrown, "recoveredBoundOwnership"), false);
  assert.equal(thrown.bindOwnershipIndeterminate, true);
});

test("reserve creates an exclusive private marker for a generated scenario/run/nonce cluster name", async (context) => {
  const markerRoot = await markerFixture(context, "kind-reserve");
  const expectedMarkerPath = markerPath(markerRoot);
  const inspections = [];

  const reservation = await reserve(markerRoot, async (request) => {
    inspections.push(request);
    return absentInspection();
  });

  assert.equal(reservation.markerRoot, markerRoot);
  assert.equal(reservation.markerPath, expectedMarkerPath);
  assert.equal(reservation.clusterName, EXPECTED_CLUSTER_NAME);
  assert.equal(reservation.kubeContext, EXPECTED_KUBE_CONTEXT);
  assert.deepEqual(inspections, [{
    phase: "reserve",
    clusterName: EXPECTED_CLUSTER_NAME,
    kubeContext: EXPECTED_KUBE_CONTEXT,
  }]);
  assert.deepEqual(JSON.parse(await readFile(expectedMarkerPath, "utf8")), {
    version: 1,
    toolNamespace: "acp.demo-creator.android.kind",
    scenarioId: SCENARIO_ID,
    runId: RUN_ID,
    nonce: NONCE,
    clusterName: EXPECTED_CLUSTER_NAME,
  });
  assert.equal((await stat(expectedMarkerPath)).mode & 0o777, 0o600);
});

test("accepts only a fresh exact private ACP endpoint proof for the bound cluster", async (context) => {
  const markerRoot = await markerFixture(context, "kind-owned-endpoint");
  const { reservation, bound } = await reserveAndBind(markerRoot);
  const proof = {
    clusterName: EXPECTED_CLUSTER_NAME,
    kubeContext: EXPECTED_KUBE_CONTEXT,
    kubeServer: "https://127.0.0.1:61443",
    containerIdentities: [
      "sha256:control-plane-node-identity",
      "sha256:worker-node-identity",
    ],
    hostPort: 42101,
    descriptorVerified: true,
    processIdentityVerified: true,
    reachable: true,
  };
  assert.deepEqual(await verifyOwnedKindAcpEndpoint(bound, {
    inspectKindCluster: async () => boundInspection(),
    readKindAcpEndpointEvidence: async () => proof,
  }), { hostPort: 42101 });

  for (const [label, changed] of [
    ["cluster", { clusterName: "shared-production" }],
    ["context", { kubeContext: "kind-shared-production" }],
    ["server", { kubeServer: "https://production.invalid" }],
    ["containers", { containerIdentities: ["sha256:foreign"] }],
    ["descriptor", { descriptorVerified: false }],
    ["process", { processIdentityVerified: false }],
    ["reachability", { reachable: false }],
  ]) {
    await assert.rejects(verifyOwnedKindAcpEndpoint(bound, {
      inspectKindCluster: async () => boundInspection(),
      readKindAcpEndpointEvidence: async () => ({ ...proof, ...changed }),
    }), /endpoint proof|owned Kind ACP endpoint/i, label);
  }
});

test("reserve refuses caller-authored cluster names", async (context) => {
  const markerRoot = await markerFixture(context, "kind-authored-name");
  let inspected = false;

  await assert.rejects(
    reserveKindClusterOwnership({
      scenarioId: SCENARIO_ID,
      runId: RUN_ID,
      nonce: NONCE,
      markerRoot,
      clusterName: "shared-cluster",
    }, {
      inspectKindCluster: async () => {
        inspected = true;
        return absentInspection();
      },
    }),
    /caller-supplied Kind cluster names are forbidden/,
  );
  assert.equal(inspected, false);
  await assert.rejects(access(markerPath(markerRoot)), { code: "ENOENT" });
});

test("reserve rejects a caller-authored marker path", async (context) => {
  const markerRoot = await markerFixture(context, "kind-authored-marker-path");

  await assert.rejects(
    reserveKindClusterOwnership({
      scenarioId: SCENARIO_ID,
      runId: RUN_ID,
      nonce: NONCE,
      markerRoot,
      markerPath: path.join(markerRoot, "shared-owner.json"),
    }, { inspectKindCluster: async () => absentInspection() }),
    /caller-supplied Kind marker paths are forbidden/,
  );
  await assert.rejects(access(markerPath(markerRoot)), { code: "ENOENT" });
});

test("reserve rejects a symlink marker root instead of escaping through its alias", async (context) => {
  const canonicalRoot = await markerFixture(context, "kind-canonical-marker-root");
  const aliasParent = await markerFixture(context, "kind-marker-root-alias-parent");
  const markerRootAlias = path.join(aliasParent, "owner-alias");
  await symlink(canonicalRoot, markerRootAlias);

  await assert.rejects(
    reserve(markerRootAlias),
    /markerRoot must be canonical; symlink aliases are not accepted/,
  );
  await assert.rejects(access(markerPath(canonicalRoot)), { code: "ENOENT" });
});

test("reserve refuses a pre-existing generated Kind cluster name", async (context) => {
  const markerRoot = await markerFixture(context, "kind-name-collision");

  await assert.rejects(
    reserve(markerRoot, async () => absentInspection({
      kindClusterNames: [EXPECTED_CLUSTER_NAME],
    })),
    /generated Kind cluster name .* already exists/,
  );
  await assert.rejects(access(markerPath(markerRoot)), { code: "ENOENT" });
});

test("reserve refuses a pre-existing generated kube context", async (context) => {
  const markerRoot = await markerFixture(context, "kind-context-collision");

  await assert.rejects(
    reserve(markerRoot, async () => absentInspection({
      kubeContexts: [EXPECTED_KUBE_CONTEXT],
      currentKubeContext: EXPECTED_KUBE_CONTEXT,
    })),
    /generated kube context .* already exists/,
  );
  await assert.rejects(access(markerPath(markerRoot)), { code: "ENOENT" });
});

test("reserve refuses an ambiguous kube context inspection", async (context) => {
  const markerRoot = await markerFixture(context, "kind-ambiguous-contexts");

  await assert.rejects(
    reserve(markerRoot, async () => absentInspection({
      kubeContexts: ["kind-unrelated-kind-cluster", "kind-unrelated-kind-cluster"],
    })),
    /Kind inspection kubeContexts is ambiguous because it contains duplicates/,
  );
  await assert.rejects(access(markerPath(markerRoot)), { code: "ENOENT" });
});

test("reserve refuses a pre-existing generated kube context even when it is not current", async (context) => {
  const markerRoot = await markerFixture(context, "kind-non-current-context-collision");

  await assert.rejects(
    reserve(markerRoot, async () => absentInspection({
      kubeContexts: ["kind-unrelated-kind-cluster", EXPECTED_KUBE_CONTEXT],
      currentKubeContext: "kind-unrelated-kind-cluster",
    })),
    /generated kube context .* already exists/,
  );
  await assert.rejects(access(markerPath(markerRoot)), { code: "ENOENT" });
});

test("reserve refuses an existing marker without replacing its diagnostics", async (context) => {
  const markerRoot = await markerFixture(context, "kind-marker-collision");
  const existingMarkerPath = markerPath(markerRoot);
  await writeFile(existingMarkerPath, "existing diagnostic marker\n", { mode: 0o600 });

  await assert.rejects(reserve(markerRoot), /Kind ownership marker already exists/);
  assert.equal(await readFile(existingMarkerPath, "utf8"), "existing diagnostic marker\n");
});

test("reserve never publishes a partial marker when private staging fails", async (context) => {
  for (const failedOperation of ["chmod", "writeFile", "sync", "close"]) {
    await context.test(failedOperation, async () => {
      const markerRoot = await markerFixture(context, `kind-reserve-stage-${failedOperation}`);
      let injected = false;
      const failingFs = new Proxy(fileSystem, {
        get(target, property) {
          if (property !== "open") return Reflect.get(target, property);
          return async (pathname, flags, mode) => {
            const handle = await fileSystem.open(pathname, flags, mode);
            if (!pathname.includes(".owner.json")) return handle;
            const fail = async (operation, invoke) => {
              if (operation === failedOperation && !injected) {
                injected = true;
                throw new Error(`synthetic reservation ${operation} failure`);
              }
              return invoke();
            };
            return {
              chmod: (...args) => fail("chmod", () => handle.chmod(...args)),
              close: (...args) => fail("close", () => handle.close(...args)),
              stat: handle.stat.bind(handle),
              sync: (...args) => fail("sync", () => handle.sync(...args)),
              writeFile: (...args) => fail("writeFile", () => handle.writeFile(...args)),
            };
          };
        },
      });

      await assert.rejects(
        reserveKindClusterOwnership({
          scenarioId: SCENARIO_ID,
          runId: RUN_ID,
          nonce: NONCE,
          markerRoot,
        }, kindLifecycleOptions({
          fs: failingFs,
          inspectKindCluster: async () => absentInspection(),
        })),
        new RegExp(`synthetic reservation ${failedOperation} failure`, "i"),
      );
      assert.equal(injected, true);
      await assert.rejects(access(markerPath(markerRoot)), { code: "ENOENT" });
      assert.deepEqual(await readdir(markerRoot), []);
    });
  }
});

test("bind accepts the explicitly inspected private context when the global context differs", async (context) => {
  const markerRoot = await markerFixture(context, "kind-bind");
  const reservation = await reserve(markerRoot);
  const creationTransaction = await beginCreation(reservation);

  const bound = await bindKindCluster(reservation, {
    creationTransaction,
    inspectKindCluster: async (request) => {
      assert.deepEqual(request, {
        phase: request.phase,
        clusterName: EXPECTED_CLUSTER_NAME,
        kubeContext: EXPECTED_KUBE_CONTEXT,
      });
      assert.match(request.phase, /^(?:create-complete|bind)$/u);
      return boundInspection({ currentKubeContext: "kind-some-global-context" });
    },
  });

  assert.equal(bound.markerPath, markerPath(markerRoot));
  assert.equal(bound.kubeContext, EXPECTED_KUBE_CONTEXT);
  assert.deepEqual(bound.containerIdentities, [
    "sha256:control-plane-node-identity",
    "sha256:worker-node-identity",
  ]);
  assert.deepEqual(JSON.parse(await readFile(reservation.markerPath, "utf8")), {
    version: 1,
    toolNamespace: "acp.demo-creator.android.kind",
    scenarioId: SCENARIO_ID,
    runId: RUN_ID,
    nonce: NONCE,
    clusterName: EXPECTED_CLUSTER_NAME,
    kubeContext: EXPECTED_KUBE_CONTEXT,
    kubeServer: "https://127.0.0.1:61443",
    containerIdentities: [
      "sha256:control-plane-node-identity",
      "sha256:worker-node-identity",
    ],
  });
  assert.equal((await stat(reservation.markerPath)).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(markerRoot), [`${EXPECTED_CLUSTER_NAME}.owner.json`]);
});

test("bind refuses an inspector that did not inspect the exact owned kube context", async (context) => {
  const markerRoot = await markerFixture(context, "kind-wrong-inspected-context");
  const reservation = await reserve(markerRoot);
  const creationTransaction = await beginCreation(reservation);
  const reservedMarker = await readFile(reservation.markerPath, "utf8");

  await assert.rejects(
    bindKindCluster(reservation, {
      creationTransaction,
      inspectKindCluster: async () => boundInspection({
        inspectedKubeContext: "kind-some-other-context",
      }),
    }),
    /inspected Kind kube context does not match/,
  );
  assert.equal(await readFile(reservation.markerPath, "utf8"), reservedMarker);
});

test("bind serializes marker updates with an exclusive adjacent lock", async (context) => {
  const markerRoot = await markerFixture(context, "kind-bind-race");
  const reservation = await reserve(markerRoot);
  const firstCreationTransaction = await beginCreation(reservation);
  const secondCreationTransaction = await beginCreation(reservation);
  let markFirstInspectionStarted;
  let releaseFirstInspection;
  const firstInspectionStarted = new Promise((resolve) => { markFirstInspectionStarted = resolve; });
  const firstInspectionRelease = new Promise((resolve) => { releaseFirstInspection = resolve; });

  const firstBind = bindKindCluster(reservation, {
    creationTransaction: firstCreationTransaction,
    inspectKindCluster: async () => {
      markFirstInspectionStarted();
      await firstInspectionRelease;
      return boundInspection();
    },
  });
  await firstInspectionStarted;

  let raceAssertionError;
  try {
    await assert.rejects(
      bindKindCluster(reservation, {
        creationTransaction: secondCreationTransaction,
        inspectKindCluster: async () => boundInspection(),
      }),
      /Kind ownership marker update already in progress/,
    );
  } catch (error) {
    raceAssertionError = error;
  } finally {
    releaseFirstInspection();
  }
  await firstBind;
  if (raceAssertionError) throw raceAssertionError;

  assert.deepEqual(await readdir(markerRoot), [`${EXPECTED_CLUSTER_NAME}.owner.json`]);
});

test("an interrupted bind write preserves the reserved marker and removes update artifacts", async (context) => {
  const markerRoot = await markerFixture(context, "kind-bind-interrupted-write");
  const reservation = await reserve(markerRoot);
  const creationTransaction = await beginCreation(reservation);
  const reservedMarker = await readFile(reservation.markerPath, "utf8");
  const interruptedFs = new Proxy(fileSystem, {
    get(target, property) {
      if (property !== "open") return Reflect.get(target, property);
      return async (pathname, flags, mode) => {
        const handle = await fileSystem.open(pathname, flags, mode);
        if (!pathname.includes(".owner.json.update.") || !pathname.endsWith(".tmp")) return handle;
        return {
          chmod: handle.chmod.bind(handle),
          close: handle.close.bind(handle),
          sync: handle.sync.bind(handle),
          writeFile: async () => {
            throw new Error("synthetic interrupted marker write");
          },
        };
      };
    },
  });

  await assert.rejects(
    bindKindCluster(reservation, {
      creationTransaction,
      fs: interruptedFs,
      inspectKindCluster: async () => boundInspection(),
    }),
    /synthetic interrupted marker write/,
  );
  assert.equal(await readFile(reservation.markerPath, "utf8"), reservedMarker);
  assert.deepEqual(await readdir(markerRoot), [`${EXPECTED_CLUSTER_NAME}.owner.json`]);

  const bound = await bindKindCluster(reservation, {
    creationTransaction,
    inspectKindCluster: async () => boundInspection(),
  });
  assert.equal(bound.clusterName, EXPECTED_CLUSTER_NAME);
});

test("bind errors after a persisted bound marker expose non-enumerable recovered ownership", async (context) => {
  const markerRoot = await markerFixture(context, "kind-bind-recovered");
  const reservation = await reserve(markerRoot);
  const creationTransaction = await beginCreation(reservation);
  const cleanupFailingFs = new Proxy(fileSystem, {
    get(target, property) {
      if (property !== "unlink") return Reflect.get(target, property);
      return async (pathname) => {
        if (pathname === `${reservation.markerPath}.update.lock`) {
          throw new Error("synthetic Kind lock cleanup failure");
        }
        return fileSystem.unlink(pathname);
      };
    },
  });

  let thrown;
  try {
    await bindKindCluster(reservation, {
      creationTransaction,
      fs: cleanupFailingFs,
      inspectKindCluster: async () => boundInspection(),
    });
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown instanceof Error);
  assert.match(thrown.message, /Unable to remove Kind ownership update lock/);
  const descriptor = Object.getOwnPropertyDescriptor(thrown, "recoveredBoundOwnership");
  assert.equal(descriptor?.enumerable, false);
  assert.equal(descriptor?.writable, false);
  assert.deepEqual(descriptor?.value, {
    markerRoot,
    markerPath: reservation.markerPath,
    version: 1,
    toolNamespace: "acp.demo-creator.android.kind",
    scenarioId: SCENARIO_ID,
    runId: RUN_ID,
    nonce: NONCE,
    clusterName: EXPECTED_CLUSTER_NAME,
    kubeContext: EXPECTED_KUBE_CONTEXT,
    kubeServer: "https://127.0.0.1:61443",
    containerIdentities: [
      "sha256:control-plane-node-identity",
      "sha256:worker-node-identity",
    ],
    ready: true,
  });
  assert.equal(Object.keys(thrown).includes("recoveredBoundOwnership"), false);
  assert.equal(Object.hasOwn(thrown, "bindOwnershipIndeterminate"), false);
});

test("teardown recovers the stale lock left by a verified bind cleanup failure", async (context) => {
  const markerRoot = await markerFixture(context, "kind-bind-recovered-teardown");
  const reservation = await reserve(markerRoot);
  const creationTransaction = await beginCreation(reservation);
  const lockPath = `${reservation.markerPath}.update.lock`;
  let failLockCleanup = true;
  const cleanupFailingFs = new Proxy(fileSystem, {
    get(target, property) {
      if (property !== "unlink") return Reflect.get(target, property);
      return async (pathname) => {
        if (pathname === lockPath && failLockCleanup) {
          failLockCleanup = false;
          throw new Error("synthetic bind lock cleanup failure");
        }
        return fileSystem.unlink(pathname);
      };
    },
  });

  let bindError;
  try {
    await bindKindCluster(reservation, {
      creationTransaction,
      fs: cleanupFailingFs,
      inspectKindCluster: async () => boundInspection(),
    });
  } catch (error) {
    bindError = error;
  }
  assert.ok(bindError instanceof Error);
  const recovered = bindError.recoveredBoundOwnership;
  assert.equal(recovered?.clusterName, EXPECTED_CLUSTER_NAME);
  await access(lockPath);

  const result = await teardownOwnedKindCluster(recovered, {
    inspectMarkerUpdateOwner: async () => null,
    inspectKindCluster: async ({ phase }) => (
      phase === "teardown-proof" ? absentInspection() : boundInspection()
    ),
    deleteKindCluster: async () => {},
  });

  assert.equal(result.action, "deleted");
  assert.deepEqual(await readdir(markerRoot), []);
});

test("bind recovery marks ownership indeterminate when exact live bound proof fails", async (context) => {
  const markerRoot = await markerFixture(context, "kind-bind-recovery-fails");
  const reservation = await reserve(markerRoot);
  const creationTransaction = await beginCreation(reservation);
  const cleanupFailingFs = new Proxy(fileSystem, {
    get(target, property) {
      if (property !== "unlink") return Reflect.get(target, property);
      return async (pathname) => {
        if (pathname === `${reservation.markerPath}.update.lock`) throw new Error("cleanup failed");
        return fileSystem.unlink(pathname);
      };
    },
  });
  let inspections = 0;
  let thrown;
  try {
    await bindKindCluster(reservation, {
      creationTransaction,
      fs: cleanupFailingFs,
      inspectKindCluster: async () => {
        inspections += 1;
        return inspections <= 2
          ? boundInspection()
          : boundInspection({ kubeServer: "https://127.0.0.1:62443" });
      },
    });
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

test("verification rereads the marker and accepts only the exact live owned cluster", async (context) => {
  const markerRoot = await markerFixture(context, "kind-verify");
  const { reservation, bound } = await reserveAndBind(markerRoot);
  const phases = [];

  const verified = await verifyOwnedKindCluster(bound, {
    inspectKindCluster: async (request) => {
      phases.push(request.phase);
      return boundInspection({
        containerIdentities: [
          "sha256:control-plane-node-identity",
          "sha256:worker-node-identity",
        ],
      });
    },
  });
  assert.equal(verified.clusterName, EXPECTED_CLUSTER_NAME);
  assert.equal(verified.ready, true);
  assert.deepEqual(phases, ["verify"]);

  const marker = JSON.parse(await readFile(reservation.markerPath, "utf8"));
  marker.runId = "a-different-run";
  await writeFile(reservation.markerPath, `${JSON.stringify(marker)}\n`, { mode: 0o600 });
  let inspected = false;
  await assert.rejects(
    verifyOwnedKindCluster(bound, {
      inspectKindCluster: async () => {
        inspected = true;
        return boundInspection();
      },
    }),
    /ownership marker runId mismatch|ownership marker file identity changed/,
  );
  assert.equal(inspected, false);
});

test("ready guard performs a fresh mutation-phase ownership check", async (context) => {
  const markerRoot = await markerFixture(context, "kind-ready");
  const { bound } = await reserveAndBind(markerRoot);
  const phases = [];

  await assert.rejects(
    assertOwnedKindClusterReady(bound, {
      inspectKindCluster: async (request) => {
        phases.push(request.phase);
        return boundInspection({ ready: false });
      },
    }),
    /owned Kind cluster .* is not ready/,
  );
  assert.deepEqual(phases, ["mutation"]);

  const ready = await assertOwnedKindClusterReady(bound, {
    inspectKindCluster: async (request) => {
      phases.push(request.phase);
      return boundInspection({ ready: true });
    },
  });
  assert.equal(ready.ready, true);
  assert.deepEqual(phases, ["mutation", "mutation"]);
});

test("verification refuses changed Kind name, kube context, server, or container set", async (context) => {
  const markerRoot = await markerFixture(context, "kind-changed-live-state");
  const { bound } = await reserveAndBind(markerRoot);
  const cases = [
    {
      name: "Kind name",
      inspection: boundInspection({ kindClusterNames: ["different-cluster"] }),
      expected: /owned Kind cluster name .* is not present exactly once/,
    },
    {
      name: "kube context",
      inspection: boundInspection({ inspectedKubeContext: "kind-different-cluster" }),
      expected: /inspected Kind kube context does not match/,
    },
    {
      name: "kube server",
      inspection: boundInspection({ kubeServer: "https://127.0.0.1:62443" }),
      expected: /owned Kind kube server changed/,
    },
    {
      name: "container set",
      inspection: boundInspection({
        containerIdentities: [
          "sha256:control-plane-node-identity",
          "sha256:worker-node-identity",
          "sha256:unexpected-node-identity",
        ],
      }),
      expected: /owned Kind container identities changed/,
    },
  ];

  for (const fixture of cases) {
    await assert.rejects(
      verifyOwnedKindCluster(bound, {
        inspectKindCluster: async () => fixture.inspection,
      }),
      fixture.expected,
      fixture.name,
    );
  }
});

test("teardown re-verifies immediately, deletes the whole owned cluster, then removes the marker", async (context) => {
  const markerRoot = await markerFixture(context, "kind-teardown");
  const { bound } = await reserveAndBind(markerRoot);
  const events = [];

  const result = await teardownOwnedKindCluster(bound, {
    inspectKindCluster: async (request) => {
      events.push(`inspect:${request.phase}`);
      return request.phase === "teardown-proof" ? absentInspection() : boundInspection();
    },
    deleteKindCluster: async (identity) => {
      assert.deepEqual(identity, {
        clusterName: EXPECTED_CLUSTER_NAME,
        kubeContext: EXPECTED_KUBE_CONTEXT,
        kubeServer: "https://127.0.0.1:61443",
        containerIdentities: [
          "sha256:control-plane-node-identity",
          "sha256:worker-node-identity",
        ],
      });
      events.push(`delete:${identity.clusterName}`);
    },
  });

  assert.deepEqual(result, {
    action: "deleted",
    clusterName: EXPECTED_CLUSTER_NAME,
    markerPath: bound.markerPath,
  });
  assert.deepEqual(events, [
    "inspect:teardown",
    "inspect:teardown-delete",
    `delete:${EXPECTED_CLUSTER_NAME}`,
    "inspect:teardown-proof",
  ]);
  await assert.rejects(access(bound.markerPath), { code: "ENOENT" });
});

test("teardown persists deletion-pending state and retries absence proof after deletion", async (context) => {
  const markerRoot = await markerFixture(context, "kind-teardown-pending-after-delete");
  const { bound } = await reserveAndBind(markerRoot);
  let clusterPresent = true;
  let deleteCalls = 0;
  let proofAttempts = 0;

  await assert.rejects(
    teardownOwnedKindCluster(bound, {
      inspectKindCluster: async ({ phase }) => {
        if (phase === "teardown-proof") {
          proofAttempts += 1;
          throw new Error("synthetic post-delete proof failure");
        }
        return clusterPresent ? boundInspection() : absentInspection();
      },
      deleteKindCluster: async (identity) => {
        deleteCalls += 1;
        assert.deepEqual(identity.containerIdentities, [
          "sha256:control-plane-node-identity",
          "sha256:worker-node-identity",
        ]);
        clusterPresent = false;
      },
    }),
    /synthetic post-delete proof failure/,
  );

  assert.equal(deleteCalls, 1);
  assert.equal(proofAttempts, 1);
  assert.deepEqual(JSON.parse(await readFile(bound.markerPath, "utf8")), {
    version: 1,
    toolNamespace: "acp.demo-creator.android.kind",
    scenarioId: SCENARIO_ID,
    runId: RUN_ID,
    nonce: NONCE,
    clusterName: EXPECTED_CLUSTER_NAME,
    kubeContext: EXPECTED_KUBE_CONTEXT,
    kubeServer: "https://127.0.0.1:61443",
    containerIdentities: [
      "sha256:control-plane-node-identity",
      "sha256:worker-node-identity",
    ],
    teardownPhase: "kind-delete-pending",
  });
  assert.equal(Object.hasOwn(bound, "teardownPhase"), false);

  const result = await teardownOwnedKindCluster(bound, {
    inspectKindCluster: async () => absentInspection(),
    deleteKindCluster: async () => { deleteCalls += 1; },
  });

  assert.equal(result.action, "deleted");
  assert.equal(deleteCalls, 1, "an already-absent cluster must not be deleted again");
  await assert.rejects(access(bound.markerPath), { code: "ENOENT" });
});

test("deletion-pending retry re-deletes only the same exact live container identities", async (context) => {
  const markerRoot = await markerFixture(context, "kind-teardown-pending-exact-retry");
  const { bound } = await reserveAndBind(markerRoot);
  let deleteCalls = 0;

  await assert.rejects(
    teardownOwnedKindCluster(bound, {
      inspectKindCluster: async () => boundInspection(),
      deleteKindCluster: async () => {
        deleteCalls += 1;
        throw new Error("synthetic exact deletion failure");
      },
    }),
    /synthetic exact deletion failure/,
  );

  let retryInspections = 0;
  const result = await teardownOwnedKindCluster(bound, {
    inspectKindCluster: async () => {
      retryInspections += 1;
      return retryInspections === 1 ? boundInspection() : absentInspection();
    },
    deleteKindCluster: async (identity) => {
      deleteCalls += 1;
      assert.deepEqual(identity.containerIdentities, [
        "sha256:control-plane-node-identity",
        "sha256:worker-node-identity",
      ]);
    },
  });

  assert.equal(result.action, "deleted");
  assert.equal(deleteCalls, 2);
  assert.equal(retryInspections, 2);
});

test("deletion-pending retry removes a stale transition lock after proving absence", async (context) => {
  const markerRoot = await markerFixture(context, "kind-teardown-pending-stale-lock");
  const { bound } = await reserveAndBind(markerRoot);
  const lockPath = `${bound.markerPath}.update.lock`;
  const transitionCleanupFailingFs = new Proxy(fileSystem, {
    get(target, property) {
      if (property !== "unlink") return Reflect.get(target, property);
      return async (pathname) => {
        if (pathname === lockPath) throw new Error("synthetic transition lock cleanup failure");
        return fileSystem.unlink(pathname);
      };
    },
  });

  await assert.rejects(
    teardownOwnedKindCluster(bound, {
      fs: transitionCleanupFailingFs,
      inspectKindCluster: async () => boundInspection(),
      deleteKindCluster: async () => assert.fail("delete must wait for a durable transition"),
    }),
    /transition lock cleanup failure|Unable to remove Kind ownership update lock/,
  );
  assert.equal(JSON.parse(await readFile(bound.markerPath, "utf8")).teardownPhase, "kind-delete-pending");
  await access(lockPath);

  await teardownOwnedKindCluster(bound, {
    inspectMarkerUpdateOwner: async () => null,
    inspectKindCluster: async () => absentInspection(),
    deleteKindCluster: async () => assert.fail("already-absent cluster must not be deleted"),
  });

  assert.deepEqual(await readdir(markerRoot), []);
});

test("teardown recovers a crash-stale owned update lock but blocks an active owner", async (context) => {
  for (const ownerState of ["stale", "active"]) {
    await context.test(ownerState, async () => {
      const markerRoot = await markerFixture(context, `kind-teardown-lock-${ownerState}`);
      const { bound } = await reserveAndBind(markerRoot);
      const lockPath = `${bound.markerPath}.update.lock`;
      await writeFile(lockPath, `${JSON.stringify(markerUpdateLock(bound), null, 2)}\n`, {
        mode: 0o600,
      });
      let deleteCalls = 0;

      if (ownerState === "active") {
        await assert.rejects(
          teardownOwnedKindCluster(bound, {
            inspectKindCluster: async () => boundInspection(),
            deleteKindCluster: async () => { deleteCalls += 1; },
          }),
          /marker update.*(?:active|progress)/i,
        );
        assert.equal(deleteCalls, 0);
        assert.equal(Object.hasOwn(JSON.parse(await readFile(bound.markerPath, "utf8")), "teardownPhase"), false);
        await access(lockPath);
        return;
      }

      const result = await teardownOwnedKindCluster(bound, {
        inspectMarkerUpdateOwner: async () => null,
        inspectKindCluster: async ({ phase }) => (
          phase === "teardown-proof" ? absentInspection() : boundInspection()
        ),
        deleteKindCluster: async () => { deleteCalls += 1; },
      });
      assert.equal(result.action, "deleted");
      assert.equal(deleteCalls, 1);
      assert.deepEqual(await readdir(markerRoot), []);
    });
  }
});

test("deletion-pending retry invokes exact cleanup for residual owned kubeconfig identity", async (context) => {
  const markerRoot = await markerFixture(context, "kind-teardown-residual-kubeconfig");
  const { bound } = await reserveAndBind(markerRoot);
  await assert.rejects(
    teardownOwnedKindCluster(bound, {
      inspectKindCluster: async () => boundInspection(),
      deleteKindCluster: async () => { throw new Error("synthetic cleanup interruption"); },
    }),
    /synthetic cleanup interruption/,
  );

  const residualKubeconfig = absentInspection({
    kubeContexts: [EXPECTED_KUBE_CONTEXT, "kind-unrelated-kind-cluster"],
    inspectedKubeContext: EXPECTED_KUBE_CONTEXT,
    kubeServer: "https://127.0.0.1:61443",
    kubeServers: ["https://127.0.0.1:61443"],
    containerIdentities: [],
  });
  let cleanupCalls = 0;
  const result = await teardownOwnedKindCluster(bound, {
    inspectKindCluster: async ({ phase }) => (
      phase === "teardown-delete" ? residualKubeconfig : absentInspection()
    ),
    deleteKindCluster: async (identity) => {
      cleanupCalls += 1;
      assert.deepEqual(identity.containerIdentities, [
        "sha256:control-plane-node-identity",
        "sha256:worker-node-identity",
      ]);
    },
  });

  assert.equal(result.action, "deleted");
  assert.equal(cleanupCalls, 1);
});

test("strict cleanup shell resumes after a subset of exact containers was already deleted", async (context) => {
  const root = await markerFixture(context, "kind-cleanup-shell-resume");
  const bin = path.join(root, "bin");
  const state = path.join(root, "state");
  await fileSystem.mkdir(bin);
  await fileSystem.mkdir(state);
  const firstId = "a".repeat(64);
  const secondId = "b".repeat(64);
  await writeFile(path.join(state, "containers"), `${secondId}\n`);
  for (const name of ["context", "cluster", "user"]) {
    await writeFile(path.join(state, name), `${EXPECTED_KUBE_CONTEXT}\n`);
  }
  const dockerPath = path.join(bin, "docker");
  await writeFile(dockerPath, `#!/bin/bash
set -euo pipefail
if [ "\${1:-}" = "ps" ] && [[ " $* " != *" --format "* ]]; then exit 0; fi
if [ "\${1:-}" = "ps" ]; then [ ! -f "${state}/containers" ] || cat "${state}/containers"; exit 0; fi
if [ "\${1:-}" = "rm" ]; then printf '%s\\n' "$*" >> "${state}/docker.log"; rm -f "${state}/containers"; exit 0; fi
exit 1
`, { mode: 0o700 });
  const kubectlPath = path.join(bin, "kubectl");
  await writeFile(kubectlPath, `#!/bin/bash
set -euo pipefail
args=" $* "
if [[ "$args" == *" config get-contexts -o name "* ]]; then [ ! -f "${state}/context" ] || cat "${state}/context"; exit 0; fi
if [[ "$args" == *" config get-clusters "* ]]; then [ ! -f "${state}/cluster" ] || cat "${state}/cluster"; exit 0; fi
if [[ "$args" == *" config get-users "* ]]; then [ ! -f "${state}/user" ] || cat "${state}/user"; exit 0; fi
for kind in context cluster user; do
  if [[ "$args" == *" config delete-$kind "* ]]; then printf '%s\\n' "$*" >> "${state}/kubectl.log"; rm -f "${state}/$kind"; exit 0; fi
done
exit 1
`, { mode: 0o700 });
  const cleanupPath = fileURLToPath(new URL("../../../../../../tests/infra/cleanup.sh", import.meta.url));
  const environment = {
    ...process.env,
    PATH: `${bin}:/usr/bin:/bin`,
    CONTAINER_ENGINE: "docker",
    DOCKER_ONLY_KIND_CLUSTER: "true",
    EXPECTED_KIND_CONTAINER_IDS: `${firstId},${secondId}`,
    KIND_CLUSTER_NAME: EXPECTED_CLUSTER_NAME,
    KUBECONFIG: path.join(root, "kubeconfig"),
  };

  await execFileAsync("/bin/bash", [cleanupPath], { env: environment });
  await execFileAsync("/bin/bash", [cleanupPath], { env: environment });

  const dockerLog = await readFile(path.join(state, "docker.log"), "utf8");
  assert.match(dockerLog, new RegExp(secondId));
  assert.doesNotMatch(dockerLog, new RegExp(firstId));
  const kubectlLog = await readFile(path.join(state, "kubectl.log"), "utf8");
  for (const kind of ["context", "cluster", "user"]) {
    assert.match(kubectlLog, new RegExp(`delete-${kind} ${EXPECTED_KUBE_CONTEXT}`));
  }
});

test("teardown refuses marker or live-identity replacement before destructive cleanup", async (context) => {
  for (const replacement of ["marker", "marker-exact-bytes", "runtime"]) {
    await context.test(replacement, async () => {
      const markerRoot = await markerFixture(context, `kind-teardown-${replacement}-replacement`);
      const { bound } = await reserveAndBind(markerRoot);
      const originalMarker = await readFile(bound.markerPath, "utf8");
      let inspections = 0;
      let deleteCalls = 0;

      await assert.rejects(
        teardownOwnedKindCluster(bound, {
          inspectKindCluster: async ({ phase }) => {
            inspections += 1;
            if (phase === "teardown-delete" && replacement === "marker") {
              await writeFile(bound.markerPath, `${JSON.stringify({ foreign: true })}\n`, {
                mode: 0o600,
              });
            }
            if (phase === "teardown-delete" && replacement === "marker-exact-bytes") {
              const replacementPath = `${bound.markerPath}.foreign`;
              await writeFile(replacementPath, originalMarker, { mode: 0o600 });
              await rename(replacementPath, bound.markerPath);
            }
            if (phase === "teardown-delete" && replacement === "runtime") {
              return boundInspection({ containerIdentities: ["sha256:foreign-replacement"] });
            }
            return boundInspection();
          },
          deleteKindCluster: async () => { deleteCalls += 1; },
        }),
        /marker fields are invalid|marker file identity changed|container identities changed|replacement/i,
      );

      assert.ok(inspections >= 2, "teardown must freshly inspect immediately before deletion");
      assert.equal(deleteCalls, 0);
      if (replacement === "marker-exact-bytes") {
        assert.equal(await readFile(bound.markerPath, "utf8"), originalMarker);
      }
      if (replacement === "runtime") {
        assert.equal(
          JSON.parse(await readFile(bound.markerPath, "utf8")).teardownPhase,
          "kind-delete-pending",
        );
      }
    });
  }
});

test("bound ownership rejects exact-byte marker replacement between bind and teardown", async (context) => {
  const markerRoot = await markerFixture(context, "kind-bound-marker-replacement");
  const { bound } = await reserveAndBind(markerRoot);
  const originalMarker = await readFile(bound.markerPath, "utf8");
  const replacementPath = `${bound.markerPath}.foreign`;
  await writeFile(replacementPath, originalMarker, { mode: 0o600 });
  await rename(replacementPath, bound.markerPath);
  let deleteCalls = 0;

  await assert.rejects(
    teardownOwnedKindCluster(bound, {
      inspectKindCluster: async ({ phase }) => (
        phase === "teardown-proof" ? absentInspection() : boundInspection()
      ),
      deleteKindCluster: async () => { deleteCalls += 1; },
    }),
    /bound marker.*identity|marker file identity changed|ownership.*proof/i,
  );
  assert.equal(deleteCalls, 0);
  assert.equal(await readFile(bound.markerPath, "utf8"), originalMarker);
});

test("teardown preserves its marker unless a fresh inspection proves every bound identity absent", async (context) => {
  const markerRoot = await markerFixture(context, "kind-teardown-proof");
  const { bound } = await reserveAndBind(markerRoot);
  let pendingMarker;

  for (const [label, proof] of [
    ["cluster", absentInspection({ kindClusterNames: [EXPECTED_CLUSTER_NAME] })],
    ["context", absentInspection({ kubeContexts: [EXPECTED_KUBE_CONTEXT] })],
    ["server", absentInspection({ kubeServer: "https://127.0.0.1:61443" })],
    ["container", absentInspection({ containerIdentities: ["sha256:control-plane-node-identity"] })],
  ]) {
    await assert.rejects(
      teardownOwnedKindCluster(bound, {
        inspectKindCluster: async ({ phase }) => (
          phase === "teardown-proof" ? proof : boundInspection()
        ),
        deleteKindCluster: async () => {},
      }),
      /did not prove.*absen|absence proof/i,
      label,
    );
    const currentMarker = await readFile(bound.markerPath, "utf8");
    if (pendingMarker === undefined) {
      pendingMarker = currentMarker;
      assert.equal(JSON.parse(currentMarker).teardownPhase, "kind-delete-pending", label);
    } else {
      assert.equal(currentMarker, pendingMarker, label);
    }
  }
});

test("teardown fails closed and preserves the marker on identity ambiguity or delete failure", async (context) => {
  const markerRoot = await markerFixture(context, "kind-teardown-fail-closed");
  const { bound } = await reserveAndBind(markerRoot);
  const originalMarker = await readFile(bound.markerPath, "utf8");
  let deleteCalls = 0;

  await assert.rejects(
    teardownOwnedKindCluster(bound, {
      inspectKindCluster: async () => boundInspection({
        containerIdentities: ["sha256:control-plane-node-identity"],
      }),
      deleteKindCluster: async () => { deleteCalls += 1; },
    }),
    /owned Kind container identities changed/,
  );
  assert.equal(deleteCalls, 0);
  assert.equal(await readFile(bound.markerPath, "utf8"), originalMarker);

  await assert.rejects(
    teardownOwnedKindCluster(bound, {
      inspectKindCluster: async () => boundInspection(),
      deleteKindCluster: async () => {
        deleteCalls += 1;
        throw new Error("synthetic Kind deletion failure");
      },
    }),
    /synthetic Kind deletion failure/,
  );
  assert.equal(deleteCalls, 1);
  const pendingMarker = JSON.parse(await readFile(bound.markerPath, "utf8"));
  assert.equal(pendingMarker.teardownPhase, "kind-delete-pending");
  assert.deepEqual(pendingMarker.containerIdentities, [
    "sha256:control-plane-node-identity",
    "sha256:worker-node-identity",
  ]);
});
