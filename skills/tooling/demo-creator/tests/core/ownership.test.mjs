import test from "node:test";
import assert from "node:assert/strict";
import {
  OWNERSHIP_LABEL,
  OWNERSHIP_VALUE,
  SCENARIO_LABEL,
  assertProjectName,
  assertProjectOwned,
  expectedProjectName,
  ownershipMarker,
} from "../../scripts/core/ownership.mjs";

test("project name is deterministic for the scenario", () => {
  assert.equal(expectedProjectName("extension-flow"), "demo-extension-flow");
});

test("scenario project must match its stable derived name", () => {
  assert.throws(() => assertProjectName("something-else", { id: "extension-flow", acp: { project: "something-else" } }), /Scenario ACP project/);
  assert.equal(assertProjectName("demo-extension-flow", { id: "extension-flow", acp: { project: "demo-extension-flow" } }), true);
});

test("ownership guard refuses an unmarked or differently marked project", () => {
  assert.throws(() => assertProjectOwned({ name: "demo-extension-flow", labels: {} }, "extension-flow"), /Refusing/);
  assert.throws(() => assertProjectOwned({
    name: "demo-extension-flow",
    labels: { [OWNERSHIP_LABEL]: OWNERSHIP_VALUE, [SCENARIO_LABEL]: "other" },
  }, "extension-flow"), /Refusing/);
});

test("ownership guard accepts only the exact skill and scenario markers", () => {
  assert.equal(assertProjectOwned({ name: "demo-extension-flow", labels: ownershipMarker("extension-flow") }, "extension-flow"), true);
});
