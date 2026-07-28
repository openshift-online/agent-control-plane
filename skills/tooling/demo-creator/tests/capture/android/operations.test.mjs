import assert from "node:assert/strict";
import test from "node:test";

let operations = {};
try {
  operations = await import("../../../scripts/capture/android/operations.mjs");
} catch (error) {
  if (error?.code !== "ERR_MODULE_NOT_FOUND") throw error;
}

const REQUIRED_OPERATION_NAMES = Object.freeze([
  "copyAndroidApkLockEvidence",
  "createAndroidDriver",
  "createOwnedAvd",
  "disableAndroidPointerOverlays",
  "establishOwnedAcpReverse",
  "installVerifiedAndroidApk",
  "launchAndroidApplication",
  "launchOwnedEmulator",
  "probeAndroidRecording",
  "removeOwnedAcpReverse",
  "remuxAndroidScreenrecord",
  "rollbackOwnedEmulator",
  "runKindMakePlan",
  "startAndroidScreenrecord",
  "stopAndroidScreenrecord",
  "verifyAndroidDisplayGeometry",
  "verifyInstalledAndroidApp",
  "waitForOwnedAvdBoot",
  "writeAndroidPointerEvents",
]);

test("exports the complete portable Android operation boundary", () => {
  assert.equal(typeof operations.createAndroidOperations, "function");
  assert.equal(typeof operations.createKindLifecycleDeps, "function");
  assert.equal(typeof operations.createAvdLifecycleDeps, "function");
  assert.equal(typeof operations.prepareAndroidRunDirectories, "function");
  assert.deepEqual(operations.ANDROID_DEFAULT_OPERATION_NAMES, REQUIRED_OPERATION_NAMES);
  assert.equal(Object.isFrozen(operations.ANDROID_DEFAULT_OPERATION_NAMES), true);

  const concrete = operations.createAndroidOperations();
  assert.deepEqual(Object.keys(concrete).sort(), REQUIRED_OPERATION_NAMES);
  for (const name of REQUIRED_OPERATION_NAMES) {
    assert.equal(typeof concrete[name], "function", name);
  }
  assert.equal(Object.isFrozen(concrete), true);
});

test("creates one private process registry per Android capture invocation", () => {
  assert.equal(typeof operations.createAndroidProcessRegistry, "function");

  const first = operations.createAndroidProcessRegistry();
  const second = operations.createAndroidProcessRegistry();
  assert.deepEqual(Object.keys(first).sort(), ["emulators", "recorders"]);
  assert.equal(first.emulators instanceof Map, true);
  assert.equal(first.recorders instanceof Map, true);
  assert.equal(Object.isFrozen(first), true);
  assert.notEqual(first, second);
  assert.notEqual(first.emulators, second.emulators);
  assert.notEqual(first.recorders, second.recorders);
});

test("the portable default surface contains no placeholder operations", async () => {
  const concrete = operations.createAndroidOperations({
    processRegistry: operations.createAndroidProcessRegistry(),
  });

  for (const name of REQUIRED_OPERATION_NAMES) {
    let failure;
    try {
      await concrete[name]();
    } catch (error) {
      failure = error;
    }
    assert.ok(failure instanceof Error, `${name} must reject an absent capture input`);
    assert.doesNotMatch(failure.message, /not implemented/iu, name);
  }
});

test("passes only an explicit allowlisted tool environment to concrete operations", async () => {
  const calls = [];
  const missing = () => {
    const error = new Error("missing");
    error.code = "ENOENT";
    return error;
  };
  const fs = {
    async realpath(pathname) {
      if (pathname === "/private/run/kubeconfig") throw missing();
      return pathname;
    },
    async lstat(pathname) {
      if (pathname === "/private/run/kubeconfig") throw missing();
      if (pathname === "/tools/make") {
        return {
          mode: 0o755,
          isDirectory: () => false,
          isFile: () => true,
          isSymbolicLink: () => false,
        };
      }
      return {
        mode: 0o700,
        isDirectory: () => true,
        isFile: () => false,
        isSymbolicLink: () => false,
      };
    },
  };
  const concrete = operations.createAndroidOperations({
    fs,
    processRegistry: operations.createAndroidProcessRegistry(),
    environment: { ACP_BEARER_TOKEN: "secret-must-not-reach-tools" },
    toolEnvironment: {
      HOME: "/safe/home",
      PATH: "/safe/bin",
      ACP_OTHER_SECRET: "also-private",
    },
    runCommand: async (executable, args, options) => {
      calls.push({ executable, args, options });
      return { stdout: "", stderr: "", exitCode: 0 };
    },
    readKindCreationProof: async () => ["a".repeat(64)],
  });

  await concrete.runKindMakePlan({
    executable: "/tools/make",
    args: ["kind-up"],
    cwd: "/private/run/kind-workspace",
    environment: {
      ACP_KIND_CONNECTIONS_FILE: "/private/run/kind-state/connections.json",
      ACP_KIND_LEGACY_STATE_ROOT: "/private/run/kind-state/legacy",
      KIND_CLUSTER_NAME: "acp-demo-run",
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
  }, { completeKindCreation: async () => ({ opaque: true }) });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].options.env, {
    PATH: "/safe/bin",
    ACP_KIND_CONNECTIONS_FILE: "/private/run/kind-state/connections.json",
    ACP_KIND_LEGACY_STATE_ROOT: "/private/run/kind-state/legacy",
    KIND_CLUSTER_NAME: "acp-demo-run",
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
  });
  assert.equal(JSON.stringify(calls).includes("secret-must-not-reach-tools"), false);
  assert.equal(JSON.stringify(calls).includes("also-private"), false);
});
