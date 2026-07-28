import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import * as androidActions from "../../../scripts/capture/android/actions.mjs";
import {
  ANDROID_ACTION_SETTLING_MILLISECONDS,
  ANDROID_DEFAULT_SELECTOR_TIMEOUT_MILLISECONDS,
  ANDROID_MAX_SELECTOR_TIMEOUT_MILLISECONDS,
  ANDROID_MIN_SELECTOR_TIMEOUT_MILLISECONDS,
  androidMutationQuiescenceUnproved,
  auditAndroidSetupUiForSecrets,
  executeAndroidActions,
  findAndroidSelectorInUiDump,
  validateAndroidActions,
} from "../../../scripts/capture/android/actions.mjs";

const SELECTORS = Object.freeze({
  resourceId: { by: "resourceId", value: "dev.ambientcode.mobile:id/onboard" },
  text: { by: "text", value: "Onboard & continue" },
  contentDescription: { by: "contentDescription", value: "Cluster name" },
});

const UI_DUMP = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<hierarchy rotation="0">
  <node index="0" text="Onboard &amp; continue" resource-id="dev.ambientcode.mobile:id/onboard" content-desc="" password="false" bounds="[10,20][110,220]" />
  <node index="1" text="" resource-id="dev.ambientcode.mobile:id/cluster" content-desc="Cluster name" password="true" bounds="[120,40][320,140]" />
</hierarchy>`;

const TASK3_UI_DUMP = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<hierarchy rotation="0">
  <node index="0" text="" resource-id="connection-origin" content-desc="ACP origin" password="false" bounds="[10,20][310,120]" />
  <node index="1" text="" resource-id="auth-mode-bearer" content-desc="Advanced bearer" password="false" bounds="[10,140][310,240]" />
  <node index="2" text="" resource-id="artoo-composer" content-desc="Message Artoo" password="false" bounds="[10,260][310,460]" />
</hierarchy>`;

function fakeClock(start = 0) {
  let current = start;
  const sleeps = [];
  return {
    now: () => current,
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
      current += milliseconds;
    },
    sleeps,
    current: () => current,
  };
}

function fakeDriver(overrides = {}) {
  const calls = [];
  return {
    calls,
    async dumpUiHierarchy() {
      calls.push({ operation: "dumpUiHierarchy" });
      return UI_DUMP;
    },
    async tap(position) {
      calls.push({ operation: "tap", ...position });
    },
    async fill(request) {
      calls.push({ operation: "fill", ...request });
    },
    async back() {
      calls.push({ operation: "back" });
    },
    ...overrides,
  };
}

test("the secret stdin seam is private to the phase-enforcing executor", () => {
  assert.equal(Object.hasOwn(androidActions, "fillFromEnvironmentViaStdin"), false);
});

test("Android action validation accepts the closed recorded and pre-recording vocabulary", () => {
  const input = {
    setupActions: [
      { action: "wait", ms: 0 },
      { action: "expect", selector: SELECTORS.text },
      { action: "tap", selector: SELECTORS.resourceId },
      { action: "fill", selector: SELECTORS.contentDescription, value: "demo-cluster" },
      { action: "fillFromEnvironment", selector: SELECTORS.contentDescription, environment: "ACP_BEARER_TOKEN" },
      { action: "back" },
    ],
    actions: [
      { action: "wait", ms: 10_000 },
      { action: "expect", selector: SELECTORS.text },
      { action: "tap", selector: SELECTORS.resourceId },
      { action: "fill", selector: SELECTORS.contentDescription, value: "" },
      { action: "back" },
    ],
  };

  const validated = validateAndroidActions(input);

  assert.deepEqual(validated, input);
  assert.notEqual(validated, input);
  assert.notEqual(validated.actions, input.actions);
});

test("Android action validation uses action as the discriminator and rejects open-ended commands", () => {
  const invalidRecordedActions = [
    { type: "tap", selector: SELECTORS.resourceId },
    { action: "tap", selector: { ...SELECTORS.resourceId, query: "//*" } },
    { action: "tap", selector: { by: "xpath", value: "//*" } },
    { action: "tap", selector: { by: "query", value: "#onboard" } },
    { action: "tap", selector: SELECTORS.resourceId, shell: "input tap 1 1" },
    { action: "shell", command: "id" },
    { action: "back", selector: SELECTORS.text },
    { action: "wait", ms: 10_001 },
    { action: "fillFromEnvironment", selector: SELECTORS.contentDescription, environment: "ACP_BEARER_TOKEN" },
  ];

  for (const action of invalidRecordedActions) {
    assert.throws(
      () => validateAndroidActions({ setupActions: [], actions: [action] }),
      /capture\.android\.actions\[0\]/,
      JSON.stringify(action),
    );
  }
});

test("Android action validation enforces selector, action-count, fill, and environment bounds", () => {
  const invalidSetupActions = [
    { action: "tap", selector: "resourceId=onboard" },
    { action: "tap", selector: { by: "text", value: "x".repeat(201) } },
    { action: "tap", selector: { by: "resourceId", value: "bad id" } },
    { action: "fill", selector: SELECTORS.text, value: "x".repeat(501) },
    { action: "fill", selector: SELECTORS.text, value: "Authorization: Bearer abcdefghijklmnopqrstuvwxyz" },
    { action: "fillFromEnvironment", selector: SELECTORS.text, environment: "DEMO_CLUSTER_TOKEN" },
    { action: "fillFromEnvironment", selector: SELECTORS.text, environment: "ACP_OIDC_USERNAME" },
    { action: "fillFromEnvironment", selector: SELECTORS.text, environment: "ACP_OIDC_PASSWORD" },
  ];
  for (const action of invalidSetupActions) {
    assert.throws(
      () => validateAndroidActions({ setupActions: [action], actions: [] }),
      /capture\.android\.setupActions\[0\]/,
      JSON.stringify(action),
    );
  }
  for (const environment of ["ACP_URL", "ACP_PROJECT", "ACP_BEARER_TOKEN"]) {
    assert.doesNotThrow(() => validateAndroidActions({
      setupActions: [{ action: "fillFromEnvironment", selector: SELECTORS.text, environment }],
      actions: [],
    }));
  }
  assert.throws(
    () => validateAndroidActions({
      setupActions: [],
      actions: Array.from({ length: 101 }, () => ({ action: "back" })),
    }),
    /no more than 100/,
  );
});

test("UIAutomator selector parsing exposes only bounded coordinates", () => {
  assert.deepEqual(findAndroidSelectorInUiDump(UI_DUMP, SELECTORS.resourceId), {
    bounds: { left: 10, top: 20, right: 110, bottom: 220 },
    x: 60,
    y: 120,
  });
  assert.deepEqual(findAndroidSelectorInUiDump(UI_DUMP, SELECTORS.text), {
    bounds: { left: 10, top: 20, right: 110, bottom: 220 },
    x: 60,
    y: 120,
  });
  assert.deepEqual(findAndroidSelectorInUiDump(UI_DUMP, SELECTORS.contentDescription), {
    bounds: { left: 120, top: 40, right: 320, bottom: 140 },
    x: 220,
    y: 90,
  });
  assert.equal(findAndroidSelectorInUiDump(UI_DUMP, { by: "text", value: "Missing" }), undefined);
  assert.equal(JSON.stringify(findAndroidSelectorInUiDump(UI_DUMP, SELECTORS.contentDescription)).includes("password"), false);
});

test("UIAutomator selector parsing refuses ambiguous exact matches", () => {
  const duplicateDump = `<hierarchy>
    <node resource-id="dev.ambientcode.mobile:id/onboard" text="Onboard" bounds="[10,20][110,220]" />
    <node resource-id="dev.ambientcode.mobile:id/onboard" text="Onboard" bounds="[120,20][220,220]" />
  </hierarchy>`;

  assert.throws(
    () => findAndroidSelectorInUiDump(duplicateDump, SELECTORS.resourceId),
    /matched more than one bounded node/,
  );
  assert.throws(
    () => findAndroidSelectorInUiDump(duplicateDump, { by: "text", value: "Onboard" }),
    /matched more than one bounded node/,
  );
});

test("UIAutomator resolves accepted bare hyphenated React Native testIDs exactly", () => {
  for (const [testID, expected] of [
    ["connection-origin", { x: 160, y: 70 }],
    ["auth-mode-bearer", { x: 160, y: 190 }],
    ["artoo-composer", { x: 160, y: 360 }],
  ]) {
    const match = findAndroidSelectorInUiDump(TASK3_UI_DUMP, {
      by: "resourceId",
      value: testID,
    });
    assert.deepEqual({ x: match.x, y: match.y }, expected);
  }
});

test("Android resourceId grammar accepts bare React Native testIDs but rejects malformed IDs", () => {
  for (const value of ["connection origin", "connection/origin", "-connection-origin", "dev.ambientcode.mobile:id/with-hyphen"]) {
    assert.throws(
      () => validateAndroidActions({
        setupActions: [],
        actions: [{ action: "tap", selector: { by: "resourceId", value } }],
      }),
      /bounded Android resource ID/,
      value,
    );
  }
});

test("UIAutomator selector parsing rejects malformed, unbounded, or oversized input", () => {
  for (const dump of [
    "<hierarchy><node text=\"Onboard\" bounds=\"[10,20][10,220]\" /></hierarchy>",
    "<hierarchy><node text=\"Onboard\" bounds=\"[-1,20][10,220]\" /></hierarchy>",
    "<hierarchy><node text=\"Onboard\" bounds=\"[10,20][100001,220]\" /></hierarchy>",
  ]) {
    assert.equal(findAndroidSelectorInUiDump(dump, { by: "text", value: "Onboard" }), undefined);
  }
  assert.throws(
    () => findAndroidSelectorInUiDump("x".repeat(2 * 1024 * 1024 + 1), SELECTORS.text),
    /UIAutomator dump exceeds/,
  );
});

test("recorded Android execution uses bounded selectors, fixed settling, and value-free pointers", async () => {
  const clock = fakeClock(1_000);
  const driver = fakeDriver();
  const pointers = [];
  const logs = [];
  const actions = [
    { action: "expect", selector: SELECTORS.text },
    { action: "tap", selector: SELECTORS.resourceId },
    { action: "fill", selector: SELECTORS.contentDescription, value: "demo-cluster" },
    { action: "wait", ms: 200 },
    { action: "back" },
  ];

  const result = await executeAndroidActions(actions, {
    driver,
    phase: "recording",
    nowMilliseconds: clock.now,
    sleep: clock.sleep,
    settleMilliseconds: 1,
    deadlineMilliseconds: 10_000,
    recordPointer: async (event) => pointers.push(event),
    logger: (entry) => logs.push(entry),
  });

  assert.equal(ANDROID_ACTION_SETTLING_MILLISECONDS, 900);
  assert.deepEqual(clock.sleeps, [900, 900, 900, 200, 900]);
  assert.deepEqual(driver.calls, [
    { operation: "dumpUiHierarchy" },
    { operation: "dumpUiHierarchy" },
    { operation: "tap", x: 60, y: 120 },
    { operation: "dumpUiHierarchy" },
    { operation: "fill", x: 220, y: 90, value: "demo-cluster" },
    { operation: "back" },
  ]);
  assert.deepEqual(pointers, [
    { type: "tap", monotonicSeconds: 1.9, x: 60, y: 120 },
    { type: "fill", monotonicSeconds: 2.8, x: 220, y: 90 },
  ]);
  assert.deepEqual(result, {
    phase: "recording",
    completedActions: ["expect", "tap", "fill", "wait", "back"],
    count: 5,
  });
  assert.ok(logs.every((entry) => Object.keys(entry).sort().join(",") === "action,event,index,phase"));
  assert.equal(JSON.stringify({ pointers, result, logs }).includes("demo-cluster"), false);
});

test("selector polling has explicit timeout bounds and no unbounded loop", async () => {
  assert.equal(ANDROID_MIN_SELECTOR_TIMEOUT_MILLISECONDS, 100);
  assert.equal(ANDROID_DEFAULT_SELECTOR_TIMEOUT_MILLISECONDS, 5_000);
  assert.equal(ANDROID_MAX_SELECTOR_TIMEOUT_MILLISECONDS, 30_000);
  for (const selectorTimeoutMilliseconds of [99, 30_001, 100.5, Number.POSITIVE_INFINITY]) {
    await assert.rejects(
      executeAndroidActions([{ action: "expect", selector: SELECTORS.text }], {
        driver: fakeDriver(),
        phase: "pre-recording",
        selectorTimeoutMilliseconds,
      }),
      /selectorTimeoutMilliseconds must be an integer from 100 through 30000/,
    );
  }

  const clock = fakeClock();
  let dumps = 0;
  await assert.rejects(
    executeAndroidActions([{ action: "expect", selector: SELECTORS.text }], {
      driver: fakeDriver({
        async dumpUiHierarchy() {
          dumps += 1;
          return "<hierarchy />";
        },
      }),
      phase: "pre-recording",
      nowMilliseconds: clock.now,
      sleep: clock.sleep,
      selectorTimeoutMilliseconds: 300,
      pollIntervalMilliseconds: 100,
    }),
    /selector was not found within 300ms/,
  );
  assert.equal(dumps, 3);
  assert.deepEqual(clock.sleeps, [100, 100, 100]);
});

test("an abort-ignoring UI dump reports indeterminate mutation quiescence within a bounded grace", async () => {
  const execution = executeAndroidActions([{
    action: "expect",
    selector: SELECTORS.text,
  }], {
    driver: fakeDriver({
      async dumpUiHierarchy() {
        return new Promise(() => {});
      },
    }),
    phase: "pre-recording",
    nowMilliseconds: () => 0,
    selectorTimeoutMilliseconds: 100,
  });

  const outcome = await Promise.race([
    execution.then(
      () => ({ state: "resolved" }),
      (error) => ({ state: "rejected", error }),
    ),
    delay(750).then(() => ({ state: "hung" })),
  ]);

  assert.equal(outcome.state, "rejected");
  assert.match(outcome.error.message, /UI hierarchy dump timed out.*quiescence could not be proven/);
  assert.deepEqual(Object.getOwnPropertyDescriptor(
    outcome.error,
    "androidMutationQuiescenceUnproved",
  ), {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false,
  });
});

test("an aborted UI callback that settles reports an ordinary static timeout", async () => {
  const execution = executeAndroidActions([{
    action: "expect",
    selector: SELECTORS.text,
  }], {
    driver: fakeDriver({
      async dumpUiHierarchy({ signal }) {
        return new Promise((resolve) => {
          signal.addEventListener("abort", () => resolve("<hierarchy />"), { once: true });
        });
      },
    }),
    phase: "pre-recording",
    nowMilliseconds: () => 0,
    selectorTimeoutMilliseconds: 100,
  });

  await assert.rejects(execution, (error) => {
    assert.match(error.message, /UI hierarchy dump timed out after 100ms/);
    assert.equal(Object.hasOwn(error, "androidMutationQuiescenceUnproved"), false);
    return true;
  });
});

test("an aborted UI callback preserves a nested mutation-quiescence blocker", async () => {
  const indeterminate = new Error("nested Android mutation quiescence is unknown");
  Object.defineProperty(indeterminate, "androidMutationQuiescenceUnproved", {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  const execution = executeAndroidActions([{
    action: "expect",
    selector: SELECTORS.text,
  }], {
    driver: fakeDriver({
      async dumpUiHierarchy({ signal }) {
        return new Promise((resolve, reject) => {
          signal.addEventListener("abort", () => reject(indeterminate), { once: true });
        });
      },
    }),
    phase: "pre-recording",
    nowMilliseconds: () => 0,
    selectorTimeoutMilliseconds: 100,
  });

  await assert.rejects(
    execution,
    (error) => error === indeterminate && androidMutationQuiescenceUnproved(error),
  );
});

test("later UI dumps receive only the remaining selector timeout", async () => {
  const clock = fakeClock();
  let dumps = 0;
  await assert.rejects(
    executeAndroidActions([{ action: "expect", selector: SELECTORS.text }], {
      driver: fakeDriver({
        async dumpUiHierarchy() {
          dumps += 1;
          if (dumps === 1) return "<hierarchy />";
          return new Promise(() => {});
        },
      }),
      phase: "pre-recording",
      nowMilliseconds: clock.now,
      sleep: clock.sleep,
      selectorTimeoutMilliseconds: 100,
      pollIntervalMilliseconds: 75,
    }),
    /UI hierarchy dump timed out after 25ms/,
  );
  assert.equal(dumps, 2);
});

test("an abort-ignoring pointer recorder reports indeterminate mutation quiescence", async () => {
  const execution = executeAndroidActions([{
    action: "tap",
    selector: SELECTORS.resourceId,
  }], {
    driver: fakeDriver(),
    phase: "recording",
    deadlineMilliseconds: 10_000,
    nowMilliseconds: () => 0,
    sleep: async () => {},
    selectorTimeoutMilliseconds: 100,
    recordPointer: async () => new Promise(() => {}),
  });

  const outcome = await Promise.race([
    execution.then(
      () => ({ state: "resolved" }),
      (error) => ({ state: "rejected", error }),
    ),
    delay(750).then(() => ({ state: "hung" })),
  ]);

  assert.equal(outcome.state, "rejected");
  assert.match(outcome.error.message, /pointer recording timed out.*quiescence could not be proven/);
  assert.equal(outcome.error.androidMutationQuiescenceUnproved, true);
});

test("recorded execution refuses waits or settling that reach the recorder deadline", async () => {
  const waitClock = fakeClock(1_000);
  await assert.rejects(
    executeAndroidActions([{ action: "wait", ms: 1_000 }], {
      driver: fakeDriver(),
      phase: "recording",
      nowMilliseconds: waitClock.now,
      sleep: waitClock.sleep,
      deadlineMilliseconds: 2_000,
    }),
    /recording budget.*wait/,
  );
  assert.deepEqual(waitClock.sleeps, []);

  const settleClock = fakeClock(1_000);
  const driver = fakeDriver();
  await assert.rejects(
    executeAndroidActions([{ action: "back" }], {
      driver,
      phase: "recording",
      nowMilliseconds: settleClock.now,
      sleep: settleClock.sleep,
      deadlineMilliseconds: 1_900,
    }),
    /recording budget.*settle/,
  );
  assert.deepEqual(driver.calls, [{ operation: "back" }]);
  assert.deepEqual(settleClock.sleeps, []);
});

test("pre-recording environment fill crosses only an injected stdin channel", async () => {
  const secret = "sentinel-secret-value-never-serialize";
  const clock = fakeClock(1_000);
  const openCalls = [];
  const sinkBytes = [];
  const pointers = [];
  const logs = [];
  const stdin = {
    write(value) {
      sinkBytes.push(value);
      return true;
    },
    end() {
      sinkBytes.push("<END>");
    },
  };
  const driver = fakeDriver({
    async openSecretInput(request) {
      openCalls.push({
        executable: "adb",
        args: ["-s", "emulator-5554", "shell", "static-secret-input-helper"],
        request,
      });
      return {
        stdin,
        completed: Promise.resolve(),
      };
    },
  });

  const result = await executeAndroidActions([{
    action: "fillFromEnvironment",
    selector: SELECTORS.contentDescription,
    environment: "ACP_BEARER_TOKEN",
  }], {
    driver,
    phase: "pre-recording",
    environment: { ACP_BEARER_TOKEN: secret },
    nowMilliseconds: clock.now,
    sleep: clock.sleep,
    recordPointer: async (event) => pointers.push(event),
    logger: (entry) => logs.push(entry),
  });

  assert.deepEqual(openCalls, [{
    executable: "adb",
    args: ["-s", "emulator-5554", "shell", "static-secret-input-helper"],
    request: { x: 220, y: 90, environmentName: "ACP_BEARER_TOKEN" },
  }]);
  assert.deepEqual(sinkBytes, [secret, "<END>"]);
  assert.deepEqual(pointers, []);
  assert.deepEqual(clock.sleeps, [900]);
  assert.deepEqual(result, {
    phase: "pre-recording",
    completedActions: ["fillFromEnvironment"],
    count: 1,
  });
  assert.equal(JSON.stringify({ openCalls, pointers, logs, result }).includes(secret), false);
});

test("post-setup UI audit rejects raw and commonly encoded non-project values with a static error", async () => {
  const url = "https://127.0.0.1:8443/path?q=one two";
  const token = "header.payload.signature";
  const variants = (value) => {
    const encoded = encodeURIComponent(value);
    const form = new URLSearchParams({ value }).toString().slice("value=".length);
    const json = JSON.stringify(value);
    const base64 = Buffer.from(value, "utf8").toString("base64");
    return [
      value,
      json,
      json.slice(1, -1),
      encoded,
      encoded.replace(/%[0-9A-F]{2}/gu, (escape) => escape.toLowerCase()),
      encoded.replaceAll("%20", "+"),
      form,
      form.replace(/%[0-9A-F]{2}/gu, (escape) => escape.toLowerCase()),
      base64,
      base64.replace(/=+$/u, ""),
      base64.replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, ""),
    ];
  };
  const escapeXml = (value) => value
    .replaceAll("&", "&amp;")
    .replaceAll("\"", "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

  for (const exposed of [
    ...variants(url),
    ...variants(token),
  ]) {
    let dumpCount = 0;
    await assert.rejects(
      auditAndroidSetupUiForSecrets({
        driver: fakeDriver({
          async dumpUiHierarchy() {
            dumpCount += 1;
            return `<hierarchy><node text="${escapeXml(exposed)}" resource-id="id/value" content-desc="" bounds="[0,0][10,10]" /></hierarchy>`;
          },
        }),
        environment: {
          ACP_PROJECT: "demo-project",
          ACP_URL: url,
          ACP_BEARER_TOKEN: token,
        },
      }),
      (error) => {
        assert.equal(error.message, "Android setup UI audit detected exposed configured input");
        assert.equal(error.message.includes(exposed), false);
        assert.equal(error.cause, undefined);
        return true;
      },
    );
    assert.equal(dumpCount, 1);
  }
});

test("post-setup UI audit ignores project identity, returns no dump, and is bounded", async () => {
  const token = "escaped-\\\"token";
  const dump = `<hierarchy><node text="demo-project" resource-id="id/project" content-desc="masked" bounds="[0,0][10,10]" /></hierarchy>`;
  const calls = [];
  const result = await auditAndroidSetupUiForSecrets({
    driver: fakeDriver({
      async dumpUiHierarchy(options) {
        calls.push(options);
        return dump;
      },
    }),
    environment: {
      ACP_PROJECT: "demo-project",
      ACP_BEARER_TOKEN: token,
    },
  });

  assert.equal(result, undefined);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].signal instanceof AbortSignal, true);
  assert.equal(calls[0].signal.aborted, false);
  assert.equal(JSON.stringify({ result, calls }).includes(token), false);

  for (const invalidDump of [
    "x".repeat(2 * 1024 * 1024 + 1),
    `<hierarchy><node text="${"x".repeat(4_097)}" /></hierarchy>`,
    `<hierarchy>${"<node text=\"x\" />".repeat(10_001)}</hierarchy>`,
    `<hierarchy><node text='${token}' /></hierarchy>`,
  ]) {
    await assert.rejects(
      auditAndroidSetupUiForSecrets({
        driver: fakeDriver({ async dumpUiHierarchy() { return invalidDump; } }),
        environment: { ACP_BEARER_TOKEN: token },
      }),
      (error) => {
        assert.match(error.message, /^Android setup UI audit (?:could not prove configured inputs are hidden|failed)$/u);
        assert.equal(error.message.includes(token), false);
        assert.equal(error.cause, undefined);
        return true;
      },
    );
  }
});

test("setup UI audit preserves an exact mutation-quiescence cleanup blocker", async () => {
  const indeterminate = new Error("static driver failure");
  Object.defineProperty(indeterminate, "androidMutationQuiescenceUnproved", {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  await assert.rejects(
    auditAndroidSetupUiForSecrets({
      driver: fakeDriver({ async dumpUiHierarchy() { throw indeterminate; } }),
      environment: { ACP_BEARER_TOKEN: "private-bearer-value" },
    }),
    (error) => error === indeterminate && androidMutationQuiescenceUnproved(error),
  );
  assert.throws(() => {
    const invalid = new Error("invalid marker");
    invalid.androidMutationQuiescenceUnproved = true;
    androidMutationQuiescenceUnproved(invalid);
  }, /not an exact static proof/);
});

test("secret input rejects channel diagnostics and command-plan fields before writing", async () => {
  const secret = "sentinel-secret-value-never-serialize";
  for (const extra of ["diagnostics", "commandPlan", "result"]) {
    let writes = 0;
    const driver = fakeDriver({
      async openSecretInput() {
        return {
          stdin: { write() { writes += 1; }, end() {} },
          completed: Promise.resolve(),
          [extra]: secret,
        };
      },
    });

    await assert.rejects(
      executeAndroidActions([{
        action: "fillFromEnvironment",
        selector: SELECTORS.contentDescription,
        environment: "ACP_BEARER_TOKEN",
      }], {
        driver,
        phase: "pre-recording",
        environment: { ACP_BEARER_TOKEN: secret },
      }),
      (error) => {
        assert.match(error.message, /invalid private stdin channel/);
        assert.equal(error.message.includes(secret), false);
        return true;
      },
    );
    assert.equal(writes, 0);
  }
});

test("secret input rejects non-enumerable and symbol channel fields", async () => {
  const secret = "sentinel-secret-value-never-serialize";
  for (const makeChannel of [
    (stdin) => {
      const channel = { stdin, completed: Promise.resolve() };
      Object.defineProperty(channel, "diagnostics", { value: secret });
      return channel;
    },
    (stdin) => ({
      stdin,
      completed: Promise.resolve(),
      [Symbol("result")]: secret,
    }),
  ]) {
    let writes = 0;
    await assert.rejects(
      executeAndroidActions([{
        action: "fillFromEnvironment",
        selector: SELECTORS.contentDescription,
        environment: "ACP_BEARER_TOKEN",
      }], {
        driver: fakeDriver({
          async openSecretInput() {
            return makeChannel({ write() { writes += 1; }, end() {} });
          },
        }),
        phase: "pre-recording",
        environment: { ACP_BEARER_TOKEN: secret },
      }),
      (error) => {
        assert.match(error.message, /invalid private stdin channel/);
        assert.equal(error.message.includes(secret), false);
        return true;
      },
    );
    assert.equal(writes, 0);
  }
});

test("secret input rejects nonempty completion results without exposing them", async () => {
  const secret = "sentinel-secret-value-never-serialize";
  for (const completion of [secret, { stdout: secret }, { commandPlan: secret }]) {
    await assert.rejects(
      executeAndroidActions([{
        action: "fillFromEnvironment",
        selector: SELECTORS.contentDescription,
        environment: "ACP_BEARER_TOKEN",
      }], {
        driver: fakeDriver({
          async openSecretInput() {
            return {
              stdin: { write() {}, end() {} },
              completed: Promise.resolve(completion),
            };
          },
        }),
        phase: "pre-recording",
        environment: { ACP_BEARER_TOKEN: secret },
      }),
      (error) => {
        assert.match(error.message, /completion must not return data/);
        assert.equal(error.message.includes(secret), false);
        return true;
      },
    );
  }
});

test("pre-recording actions emit no public pointer events", async () => {
  const clock = fakeClock();
  const pointers = [];
  const driver = fakeDriver({
    async openSecretInput() {
      return {
        stdin: { write() {}, end() {} },
        completed: Promise.resolve(),
      };
    },
  });

  const result = await executeAndroidActions([
    { action: "tap", selector: SELECTORS.resourceId },
    { action: "fill", selector: SELECTORS.contentDescription, value: "demo-cluster" },
    {
      action: "fillFromEnvironment",
      selector: SELECTORS.contentDescription,
      environment: "ACP_BEARER_TOKEN",
    },
  ], {
    driver,
    phase: "pre-recording",
    environment: { ACP_BEARER_TOKEN: "sentinel-secret-value-never-serialize" },
    nowMilliseconds: clock.now,
    sleep: clock.sleep,
    recordPointer: async (event) => pointers.push(event),
  });

  assert.deepEqual(pointers, []);
  assert.deepEqual(result.completedActions, ["tap", "fill", "fillFromEnvironment"]);
});

test("a hung private stdin completion cannot outlive the action timeout", async () => {
  const secret = "sentinel-secret-value-never-serialize";
  let destroyed = 0;
  const action = {
    action: "fillFromEnvironment",
    selector: SELECTORS.contentDescription,
    environment: "ACP_BEARER_TOKEN",
  };
  const execution = executeAndroidActions([action], {
    driver: fakeDriver({
      async openSecretInput() {
        return {
          stdin: {
            write() {},
            end() {},
            destroy() { destroyed += 1; },
          },
          completed: new Promise(() => {}),
        };
      },
    }),
    phase: "pre-recording",
    environment: { ACP_BEARER_TOKEN: secret },
    selectorTimeoutMilliseconds: 100,
  });

  const outcome = await Promise.race([
    execution.then(
      () => ({ state: "resolved" }),
      (error) => ({ state: "rejected", error }),
    ),
    delay(250).then(() => ({ state: "hung" })),
  ]);

  assert.equal(outcome.state, "rejected");
  assert.match(outcome.error.message, /secret input timed out after 100ms/);
  assert.equal(outcome.error.message.includes(secret), false);
  assert.equal(destroyed, 1);
});

test("a secret channel resolving after cancellation never receives the secret", async () => {
  const secret = "sentinel-secret-value-never-serialize";
  let resolveOpen;
  let writes = 0;
  let destroyed = 0;
  const execution = executeAndroidActions([{
    action: "fillFromEnvironment",
    selector: SELECTORS.contentDescription,
    environment: "ACP_BEARER_TOKEN",
  }], {
    driver: fakeDriver({
      async openSecretInput() {
        return new Promise((resolve) => { resolveOpen = resolve; });
      },
    }),
    phase: "pre-recording",
    environment: { ACP_BEARER_TOKEN: secret },
    selectorTimeoutMilliseconds: 100,
  });

  await assert.rejects(execution, /secret input timed out after 100ms/);
  resolveOpen({
    stdin: {
      write() { writes += 1; },
      end() {},
      destroy() { destroyed += 1; },
    },
    completed: Promise.resolve(),
  });
  await delay(0);

  assert.equal(writes, 0);
  assert.equal(destroyed, 1);
});

test("environment fill redacts driver failures and remains setup-only", async () => {
  const secret = "sentinel-secret-value-never-serialize";
  const action = {
    action: "fillFromEnvironment",
    selector: SELECTORS.contentDescription,
    environment: "ACP_BEARER_TOKEN",
  };
  const logs = [];
  const driver = fakeDriver({
    async openSecretInput() {
      return {
        stdin: { write() {}, end() {} },
        completed: Promise.reject(new Error(`driver leaked ${secret}`)),
      };
    },
  });

  await assert.rejects(
    executeAndroidActions([action], {
      driver,
      phase: "pre-recording",
      environment: { ACP_BEARER_TOKEN: secret },
      logger: (entry) => logs.push(entry),
    }),
    (error) => {
      assert.equal(error.message.includes(secret), false);
      assert.equal("cause" in error, false);
      assert.match(error.message, /secret input failed/);
      return true;
    },
  );
  assert.equal(JSON.stringify(logs).includes(secret), false);

  const throwingEnvironment = {};
  Object.defineProperty(throwingEnvironment, "ACP_BEARER_TOKEN", {
    get() {
      throw new Error(`environment getter leaked ${secret}`);
    },
  });
  await assert.rejects(
    executeAndroidActions([action], {
      driver,
      phase: "pre-recording",
      environment: throwingEnvironment,
    }),
    (error) => {
      assert.equal(error.message.includes(secret), false);
      assert.match(error.message, /could not read configured environment/);
      return true;
    },
  );

  await assert.rejects(
    executeAndroidActions([action], {
      driver,
      phase: "recording",
      deadlineMilliseconds: 10_000,
    }),
    /fillFromEnvironment is allowed only during pre-recording/,
  );
});
