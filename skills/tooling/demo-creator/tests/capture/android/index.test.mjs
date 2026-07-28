import assert from "node:assert/strict";
import test from "node:test";

test("Android capture exposes one explicit integration entrypoint", async () => {
  let android = {};
  try {
    android = await import("../../../scripts/capture/android/index.mjs");
  } catch {
    // The first RED run intentionally reaches this path before the entrypoint exists.
  }
  const expected = [
    "assertOwnedAvdReady",
    "assertOwnedKindClusterReady",
    "bindAvdProcess",
    "bindKindCluster",
    "captureAndroid",
    "createAndroidOperations",
    "createAndroidProcessRegistry",
    "createAdbScreenrecordPlan",
    "createAndroidPointerRecorder",
    "createOwnedEmulatorLaunchPlan",
    "doctorAndroid",
    "executeAndroidActions",
    "prepareAndroidRunDirectories",
    "reserveAvdOwnership",
    "reserveKindClusterOwnership",
    "teardownOwnedAvd",
    "teardownOwnedKindCluster",
    "validateAdbScreenrecordOutput",
    "validateAndroidActions",
    "verifyAndroidApkGate",
    "verifyOwnedAvd",
    "verifyOwnedKindCluster",
  ];

  for (const name of expected) {
    assert.equal(typeof android[name], "function", `missing Android export ${name}`);
  }
});
