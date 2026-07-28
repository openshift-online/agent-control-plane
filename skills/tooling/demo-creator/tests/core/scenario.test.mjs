import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadScenario,
  validateScenario,
  validateStoryAssets,
  validateUploadActions,
} from "../../scripts/core/scenario.mjs";
import * as scenarioCore from "../../scripts/core/scenario.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

test("the full-browser example passes semantic validation", async () => {
  const scenarioPath = path.resolve(here, "../../examples/browser-full/scenario.yaml");
  const result = await loadScenario(scenarioPath);
  assert.equal(result.scenario.fps, 30);
  assert.equal(result.durationSeconds, 18.4);
  assert.equal(result.layouts["1080p"].caption.height, 144);
  assert.deepEqual(result.scenario.extension.actions.map((action) => action.action), [
    "wait",
    "uploadConnection",
    "wait",
    "expect",
    "configureBearer",
    "expect",
  ]);
});

test("the Android onboarding example passes the complete mobile contract", async () => {
  const scenarioPath = path.resolve(here, "../../examples/android-onboarding/scenario.yaml");
  const result = await loadScenario(scenarioPath);
  assert.equal(result.durationSeconds, 20.4);
  assert.equal(result.scenario.layout.preset, "mobile-full");
  assert.equal(result.scenario.capture.kind, "android-emulator");
  assert.equal(result.scenario.capture.cluster.kind, "disposable-kind");
  assert.equal(result.scenario.acp, undefined);
  assert.deepEqual(result.scenario.capture.android.setupActions
    .filter((action) => action.action === "fillFromEnvironment")
    .map((action) => action.environment), ["ACP_URL", "ACP_BEARER_TOKEN"]);
  assert.deepEqual(result.layouts["1080p"].mobile, { x: 0, y: 0, width: 1920, height: 936 });
});

test("the Android onboarding example is locked to the accepted Task 3 automation contract", async () => {
  const exampleDirectory = path.resolve(here, "../../examples/android-onboarding");
  const contract = JSON.parse(await readFile(
    path.join(exampleDirectory, "android-artoo-task3-contract.json"),
    "utf8",
  ));
  const { scenario } = await loadScenario(path.join(exampleDirectory, "scenario.yaml"));
  const expectedStaticTestIds = [
    "connection-origin",
    "auth-mode-oidc",
    "auth-mode-bearer",
    "bearer-token",
    "sign-in",
    "sign-out",
    "default-project-picker",
    "artoo-heading",
    "artoo-setup",
    "artoo-composer",
    "artoo-send",
    "artoo-restart",
    "other-sessions-list",
    "new-session",
    "new-session-submit",
    "alerts",
    "alerts-mark-all-read",
    "settings",
    "reset-local-data",
    "secret-redact-send",
    "secret-send-anyway",
    "secret-cancel",
  ];
  assert.deepEqual(contract.staticTestIds, expectedStaticTestIds);
  assert.equal(contract.acceptedSpec, "specs/ui/android-artoo-client.spec.md");
  assert.equal(contract.resourceIdRepresentation, "bare-react-native-test-id");
  assert.equal(scenario.capture.android.expectedApplicationId, contract.applicationId);
  assert.equal(scenario.capture.android.launchActivity, contract.launchActivity);
  assert.equal(scenario.acp, undefined);

  const expectedActions = (actions) => actions.map(({ testID, ...action }) => ({
    ...action,
    selector: { by: "resourceId", value: testID },
  }));
  assert.deepEqual(
    scenario.capture.android.setupActions,
    expectedActions(contract.onboardingFlow.setup),
  );
  assert.deepEqual(
    scenario.capture.android.actions,
    expectedActions(contract.onboardingFlow.recorded),
  );
  const usedTestIds = [
    ...scenario.capture.android.setupActions,
    ...scenario.capture.android.actions,
  ].map((action) => action.selector?.value).filter(Boolean);
  assert.ok(usedTestIds.every((testID) => contract.staticTestIds.includes(testID)));
  assert.ok([
    ...scenario.capture.android.setupActions,
    ...scenario.capture.android.actions,
  ].every((action) => action.selector?.by === "resourceId"));
});

test("caption timestamps use the final crossfade-overlapped timeline", () => {
  const base = {
    ...actionScenario([]),
    story: [
      { type: "title", durationSeconds: 3 },
      { type: "browser", durationSeconds: 4 },
      { type: "end", durationSeconds: 3 },
    ],
    production: { transitionMilliseconds: 300, silent: true },
  };
  const valid = validateScenario({
    ...base,
    captions: [{ startSeconds: 8, endSeconds: 9.4, text: "Final timeline caption." }],
  });
  assert.equal(valid.durationSeconds, 9.4);
  assert.equal(valid.valid, true);

  const late = validateScenario({
    ...base,
    captions: [{ startSeconds: 9.2, endSeconds: 9.5, text: "Too late." }],
  });
  assert.equal(late.valid, false);
  assert.ok(late.errors.some((error) => error.includes("after the story")));
});

test("split-layout examples configure the isolated extension and reach Sessions", async () => {
  for (const example of ["slides-extension", "terminal-extension"]) {
    const scenarioPath = path.resolve(here, `../../examples/${example}/scenario.yaml`);
    const result = await loadScenario(scenarioPath);
    assert.deepEqual(result.scenario.extension.actions.map((action) => action.action), [
      "wait",
      "uploadConnection",
      "configureBearer",
      "expect",
    ]);
    assert.equal(result.scenario.extension.actions.at(-1).text, "Sessions");
  }
});

test("scenario validation keeps connection data in environment variables", () => {
  const result = validateScenario({
    version: 1,
    id: "secret-example",
    title: "Secret example",
    layout: { preset: "browser-full" },
    story: [{ type: "browser", durationSeconds: 10 }],
    captions: [],
    acp: { project: "demo-secret-example" },
    connection: { token: "example-value-that-must-not-live-here" },
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.includes("unsupported field")));

  const untrustedKey = "Authorization: Bearer private-unknown-field";
  const redacted = validateScenario({ ...actionScenario([]), [untrustedKey]: true });
  assert.equal(redacted.valid, false);
  assert.equal(redacted.errors.some((error) => error.includes(untrustedKey)), false);
});

test("scenario production authors card copy but cannot retain ACP projects", () => {
  const authored = validateScenario({
    ...actionScenario([]),
    production: {
      title: "Open ACP",
      subtitle: "A repeatable native extension demo.",
      endTitle: "Demo complete",
      endText: "Run it again from the same scenario.",
      transitionMilliseconds: 300,
      silent: true,
    },
  });
  assert.equal(authored.valid, true);
  assert.equal(authored.scenario.production.endTitle, "Demo complete");
  assert.equal(Object.hasOwn(authored.scenario.acp, "keepProject"), false);

  const retained = validateScenario({
    ...actionScenario([]),
    acp: { project: "demo-action-example", keepProject: true },
  });
  assert.equal(retained.valid, false);
  assert.ok(retained.errors.some((error) => error.includes("unsupported field")));

  for (const obsolete of ["titleSeconds", "endSeconds"]) {
    const result = validateScenario({
      ...actionScenario([]),
      production: { [obsolete]: 3, transitionMilliseconds: 300, silent: true },
    });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((error) => error.includes("unsupported field")), obsolete);
  }
});

test("scenario validation rejects credential-shaped caption content", () => {
  const result = validateScenario({
    version: 1,
    id: "caption-secret",
    title: "Caption secret",
    layout: { preset: "browser-full" },
    story: [{ type: "browser", durationSeconds: 10 }],
    captions: [{ startSeconds: 0, endSeconds: 2, text: "Authorization: Bearer abcdefghijklmnopqrstuvwxyz" }],
    acp: { project: "demo-caption-secret" },
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.includes("credential-like")));
});

function actionScenario(actions) {
  return {
    version: 1,
    id: "action-example",
    title: "Action example",
    layout: { preset: "browser-full" },
    story: [{ type: "browser", durationSeconds: 10 }],
    captions: [],
    acp: { project: "demo-action-example" },
    extension: { actions },
  };
}

function mobileScenario(overrides = {}) {
  return {
    version: 1,
    id: "mobile-example",
    title: "Mobile example",
    layout: { preset: "mobile-full" },
    story: [{ type: "mobile", durationSeconds: 10 }],
    captions: [],
    acp: { project: "demo-mobile-example" },
    capture: {
      kind: "android-emulator",
      cluster: { kind: "disposable-kind" },
      android: {
        expectedApplicationId: "dev.ambientcode.mobile",
        launchActivity: "dev.ambientcode.mobile/.MainActivity",
        apk: "repo:components/mobile/dist/ambient-mobile.apk",
        apkLock: "repo:components/mobile/dist/ambient-mobile.apk.lock.json",
        systemImage: "system-images;android-35;google_apis;arm64-v8a",
        actions: [
          { action: "expect", selector: { by: "resourceId", value: "artoo-heading" } },
          { action: "tap", selector: { by: "resourceId", value: "artoo-setup" } },
          { action: "fill", selector: { by: "resourceId", value: "artoo-composer" }, value: "Summarize this ACP environment." },
          { action: "wait", ms: 500 },
          { action: "back" },
        ],
        setupActions: [
          {
            action: "fillFromEnvironment",
            selector: { by: "resourceId", value: "connection-origin" },
            environment: "ACP_URL",
          },
          {
            action: "fillFromEnvironment",
            selector: { by: "resourceId", value: "bearer-token" },
            environment: "ACP_BEARER_TOKEN",
          },
        ],
      },
    },
    ...overrides,
  };
}

test("mobile scenarios accept bounded Android emulator actions with a fixed settle", () => {
  const scenario = mobileScenario();
  const result = validateScenario(scenario);
  assert.equal(result.valid, true, result.errors.join("\n"));
  assert.equal(scenarioCore.ANDROID_ACTION_SETTLING_MILLISECONDS, 900);
  assert.equal(result.scenario.capture.android.actionSettlingMilliseconds, 900);
});

test("Android mobile stories contain only title, mobile, and end scenes", () => {
  for (const type of ["browser", "slides", "terminal"]) {
    const unsupported = { type, durationSeconds: 3 };
    if (["slides", "terminal"].includes(type)) unsupported.source = `story.${type}`;
    const result = validateScenario(mobileScenario({
      story: [
        { type: "title", durationSeconds: 3 },
        { type: "mobile", durationSeconds: 10 },
        unsupported,
        { type: "end", durationSeconds: 3 },
      ],
    }));
    assert.equal(result.valid, false, type);
    assert.ok(result.errors.some((error) => (
      error.includes("Android mobile stories")
      && error.includes("title, mobile, and end")
    )), `${type}: ${result.errors.join("\n")}`);
  }

  const missingMobile = validateScenario(mobileScenario({
    story: [
      { type: "title", durationSeconds: 3 },
      { type: "end", durationSeconds: 3 },
    ],
  }));
  assert.equal(missingMobile.valid, false);
  assert.ok(missingMobile.errors.some((error) => error.includes("at least one mobile scene")));
});

test("mobile scenarios author exactly one owned ACP_URL setup input and a recorded landmark action", () => {
  const missingUrlScenario = mobileScenario();
  missingUrlScenario.capture.android.setupActions = missingUrlScenario.capture.android.setupActions
    .filter((action) => action.environment !== "ACP_URL");
  const missingUrl = validateScenario(missingUrlScenario);
  assert.equal(missingUrl.valid, false);
  assert.ok(missingUrl.errors.some((error) => error.includes("ACP_URL exactly once")));

  const duplicateUrl = mobileScenario();
  duplicateUrl.capture.android.setupActions.unshift({
    action: "fillFromEnvironment",
    selector: { by: "contentDescription", value: "Secondary server URL" },
    environment: "ACP_URL",
  });
  const duplicated = validateScenario(duplicateUrl);
  assert.equal(duplicated.valid, false);
  assert.ok(duplicated.errors.some((error) => error.includes("ACP_URL exactly once")));

  const emptyActions = mobileScenario();
  emptyActions.capture.android.actions = [];
  const empty = validateScenario(emptyActions);
  assert.equal(empty.valid, false);
  assert.ok(empty.errors.some((error) => error.includes("at least one recorded action")));

  const maximum = mobileScenario({ story: [{ type: "mobile", durationSeconds: 179 }] });
  assert.equal(validateScenario(maximum).valid, true);

  const overlong = mobileScenario({ story: [{ type: "mobile", durationSeconds: 179.0004 }] });
  const overlongResult = validateScenario(overlong);
  assert.equal(overlongResult.valid, false);
  assert.ok(overlongResult.errors.some((error) => error.includes("no more than 179 seconds")));

  const overlongTotal = mobileScenario({
    story: [
      { type: "mobile", durationSeconds: 100 },
      { type: "mobile", durationSeconds: 80 },
    ],
  });
  assert.equal(validateScenario(overlongTotal).valid, false);
});

test("mobile scenarios omit the browser Project envelope unless a real ACP_PROJECT control is authored", () => {
  const projectless = mobileScenario();
  delete projectless.acp;
  assert.equal(validateScenario(projectless).valid, true);

  projectless.capture.android.setupActions.push({
    action: "fillFromEnvironment",
    selector: { by: "resourceId", value: "default-project-picker" },
    environment: "ACP_PROJECT",
  });
  const missingProject = validateScenario(projectless);
  assert.equal(missingProject.valid, false);
  assert.ok(missingProject.errors.some((error) => error.includes("acp")));

  const browser = actionScenario([]);
  delete browser.acp;
  assert.equal(validateScenario(browser).valid, false);
});

test("consecutive mobile scenes require a zero transition at scenario validation", () => {
  const scenario = mobileScenario({
    story: [
      { type: "mobile", durationSeconds: 8 },
      { type: "mobile", durationSeconds: 8 },
    ],
    production: { transitionMilliseconds: 300, silent: true },
  });
  const invalid = validateScenario(scenario);
  assert.equal(invalid.valid, false);
  assert.ok(invalid.errors.some((error) => (
    error.includes("consecutive mobile") && error.includes("zero transition")
  )));

  scenario.production.transitionMilliseconds = 0;
  assert.equal(validateScenario(scenario).valid, true);
});

test("mobile scenarios require Android capture and a disposable whole-cluster boundary", () => {
  const cases = [
    { capture: undefined },
    { capture: { kind: "android-emulator" } },
    { capture: { ...mobileScenario().capture, cluster: undefined } },
    { capture: { ...mobileScenario().capture, cluster: { kind: "existing", name: "shared" } } },
    { capture: { ...mobileScenario().capture, context: "kind-shared" } },
    { extension: { actions: [] } },
  ];
  for (const override of cases) {
    const result = validateScenario(mobileScenario(override));
    assert.equal(result.valid, false, JSON.stringify(override));
  }
});

test("mobile-full is reserved for mobile stories", () => {
  const result = validateScenario({
    ...actionScenario([]),
    layout: { preset: "mobile-full" },
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.includes("mobile-full") && error.includes("mobile story")));
});

test("Android capture accepts only contained APKs, strict system images, and application IDs", () => {
  const android = mobileScenario().capture.android;
  const invalid = [
    { ...android, expectedApplicationId: "Not An Application" },
    { ...android, launchActivity: ".MainActivity" },
    { ...android, launchActivity: "dev.ambientcode.mobile/MainActivity;rm" },
    { ...android, launchActivity: "dev.example.mobile/.MainActivity" },
    { ...android, apk: "repo:components/mobile/../ambient-mobile.apk" },
    { ...android, apk: "repo:/components/mobile/dist/ambient-mobile.apk" },
    { ...android, apk: "repo:components\\mobile\\dist\\ambient-mobile.apk" },
    { ...android, apk: "repo:components/mobile/dist/ambient-mobile.zip" },
    { ...android, apkLock: "repo:components/mobile/./ambient-mobile.apk.lock.json" },
    { ...android, apkLock: "repo:components//mobile/ambient-mobile.apk.lock.json" },
    { ...android, apkLock: "repo:components/mobile/dist/other.apk.lock.json" },
    { ...android, systemImage: "android latest from the network" },
  ];
  for (const captureAndroid of invalid) {
    const result = validateScenario(mobileScenario({
      capture: { ...mobileScenario().capture, android: captureAndroid },
    }));
    assert.equal(result.valid, false, JSON.stringify(captureAndroid));
  }
});

test("Android launch activity and React Native testID bounds match the runtime contract", () => {
  assert.equal(scenarioCore.ANDROID_LAUNCH_ACTIVITY_MAX_CHARACTERS, 300);
  const applicationId = "dev.ambientcode.mobile";
  const exactMaximum = `${applicationId}/.${"A".repeat(
    scenarioCore.ANDROID_LAUNCH_ACTIVITY_MAX_CHARACTERS - applicationId.length - 2,
  )}`;
  const maximumScenario = mobileScenario();
  maximumScenario.capture.android.launchActivity = exactMaximum;
  assert.equal(exactMaximum.length, 300);
  assert.equal(validateScenario(maximumScenario).valid, true);

  const overlongScenario = mobileScenario();
  overlongScenario.capture.android.launchActivity = `${exactMaximum}A`;
  assert.equal(validateScenario(overlongScenario).valid, false);

  for (const testID of [
    "connection-origin",
    "auth-mode-bearer",
    "bearer-token",
    "artoo-heading",
    "artoo-setup",
    "artoo-composer",
    "artoo-send",
  ]) {
    const scenario = mobileScenario();
    scenario.capture.android.actions = [{
      action: "tap",
      selector: { by: "resourceId", value: testID },
    }];
    assert.equal(validateScenario(scenario).valid, true, testID);
  }
});

test("mobile story media comes only from the lock-bound capture manifest", () => {
  for (const source of ["fixtures/mobile.mp4", "../mobile.mp4", "repo:components/mobile/demo/mobile.mp4"]) {
    const result = validateScenario(mobileScenario({
      story: [{ type: "mobile", source, durationSeconds: 10 }],
    }));
    assert.equal(result.valid, false, source);
    assert.ok(result.errors.some((error) => error.includes("mobile") && error.includes("source")));
  }
});

test("Android system images accept current integer and dotted SDK identifiers", () => {
  for (const systemImage of [
    "system-images;android-36;google_apis;arm64-v8a",
    "system-images;android-36.1;google_apis_playstore;x86_64",
    "system-images;android-37.0;google_apis_ps16k;arm64-v8a",
  ]) {
    const scenario = mobileScenario();
    scenario.capture.android.systemImage = systemImage;
    const result = validateScenario(scenario);
    assert.equal(result.valid, true, `${systemImage}: ${result.errors.join("\n")}`);
  }
});

test("fillFromEnvironment is setup-only and uses a bounded non-secret key name", () => {
  const selector = { by: "resourceId", value: "dev.ambientcode.mobile:id/token" };
  const urlAction = { action: "fillFromEnvironment", selector, environment: "ACP_URL" };
  for (const environment of ["DEMO_CLUSTER_TOKEN", "HOME", "PATH", "demo_token", "ACP_TOKEN", "ACP_BEARER_TOKEN_EXTRA"]) {
    const scenario = mobileScenario();
    scenario.capture.android.setupActions = [{ action: "fillFromEnvironment", selector, environment }];
    assert.equal(validateScenario(scenario).valid, false, environment);
  }

  for (const environment of ["ACP_URL", "ACP_PROJECT", "ACP_BEARER_TOKEN"]) {
    const scenario = mobileScenario();
    scenario.capture.android.setupActions = environment === "ACP_URL"
      ? [urlAction]
      : [urlAction, { action: "fillFromEnvironment", selector, environment }];
    assert.equal(validateScenario(scenario).valid, true, environment);
  }

  for (const environment of ["ACP_OIDC_USERNAME", "ACP_OIDC_PASSWORD"]) {
    const scenario = mobileScenario();
    scenario.capture.android.setupActions = [urlAction, {
      action: "fillFromEnvironment",
      selector,
      environment,
    }];
    assert.equal(validateScenario(scenario).valid, false, environment);
  }

  const oidc = mobileScenario();
  oidc.capture.android.setupActions = [
    urlAction,
    { action: "fillFromEnvironment", selector, environment: "ACP_OIDC_USERNAME" },
    { action: "fillFromEnvironment", selector, environment: "ACP_OIDC_PASSWORD" },
  ];
  assert.equal(validateScenario(oidc).valid, false);

  const mixedAuthentication = mobileScenario();
  mixedAuthentication.capture.android.setupActions = [
    urlAction,
    { action: "fillFromEnvironment", selector, environment: "ACP_BEARER_TOKEN" },
    { action: "fillFromEnvironment", selector, environment: "ACP_OIDC_USERNAME" },
    { action: "fillFromEnvironment", selector, environment: "ACP_OIDC_PASSWORD" },
  ];
  assert.equal(validateScenario(mixedAuthentication).valid, false);

  const recorded = mobileScenario();
  recorded.capture.android.actions = [{ action: "fillFromEnvironment", selector, environment: "ACP_BEARER_TOKEN" }];
  assert.equal(validateScenario(recorded).valid, false);
});

test("Android selectors and settle configuration are closed and bounded", () => {
  const invalidActions = [
    [{ action: "tap", selector: "resourceId=onboard" }],
    [{ action: "tap", selector: { by: "xpath", value: "//*" } }],
    [{ action: "tap", selector: { by: "text", value: "Onboard", arbitrary: true } }],
    [{ action: "back", selector: { by: "text", value: "ignored" } }],
  ];
  for (const actions of invalidActions) {
    const scenario = mobileScenario();
    scenario.capture.android.actions = actions;
    assert.equal(validateScenario(scenario).valid, false, JSON.stringify(actions));
  }
  for (const actionSettlingMilliseconds of [0, 899, 901, "900"]) {
    const scenario = mobileScenario();
    scenario.capture.android.actionSettlingMilliseconds = actionSettlingMilliseconds;
    assert.equal(validateScenario(scenario).valid, false, String(actionSettlingMilliseconds));
  }
});

test("Android literal fills reject credential-like values", () => {
  for (const field of ["actions", "setupActions"]) {
    const scenario = mobileScenario();
    scenario.capture.android[field] = [{
      action: "fill",
      selector: { by: "contentDescription", value: "Token" },
      value: "Authorization: Bearer abcdefghijklmnopqrstuvwxyz",
    }];
    const result = validateScenario(scenario);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((error) => error.includes("credential-like")));
  }
});

test("malformed Android capture values report errors without throwing", () => {
  for (const capture of [null, "android", {}, { kind: "android-emulator", android: null }, {
    kind: "android-emulator",
    cluster: null,
    android: { actions: [null], setupActions: {} },
  }]) {
    assert.doesNotThrow(() => {
      assert.equal(validateScenario(mobileScenario({ capture })).valid, false);
    });
  }

  const bigint = mobileScenario();
  bigint.capture.android.actions = [{ action: "wait", ms: 1n }];
  assert.doesNotThrow(() => {
    assert.equal(validateScenario(bigint).valid, false);
  });
});

test("extension actions reject unknown fields, oversized waits, and long selectors", () => {
  const cases = [
    [{ action: "click", selector: "#button", surprise: true }],
    [{ action: "wait", ms: 10001 }],
    [{ action: "click", selector: "x".repeat(513) }],
  ];
  for (const actions of cases) assert.equal(validateScenario(actionScenario(actions)).valid, false);
});

test("fill actions reject credential-like literal values", () => {
  const result = validateScenario(actionScenario([{
    action: "fill",
    selector: "#field",
    value: "Authorization: Bearer abcdefghijklmnopqrstuvwxyz",
  }]));
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.includes("credential-like")));
});

test("upload actions stay inside the scenario directory and scan file content", async () => {
  assert.equal(validateScenario(actionScenario([{ action: "upload", selector: "#file", path: "../outside.json" }])).valid, false);
  const directory = await mkdtemp(path.join(os.tmpdir(), "demo-upload-"));
  try {
    await writeFile(path.join(directory, "safe.json"), '{"version":1,"connections":[]}\n');
    await writeFile(path.join(directory, "unsafe.json"), '{"token":"short-secret"}\n');
    assert.deepEqual(await validateUploadActions(actionScenario([]), directory), []);
    assert.deepEqual(await validateUploadActions({ extension: { actions: [{ action: "upload", path: "safe.json" }] } }, directory), []);
    const errors = await validateUploadActions({ extension: { actions: [{ action: "upload", path: "unsafe.json" }] } }, directory);
    assert.ok(errors.some((error) => error.includes("credential-like")));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("story assets stay inside the scenario and reject credentials in slides or tapes", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "demo-story-"));
  try {
    await writeFile(path.join(directory, "safe.md"), "# Safe synthetic slide\n");
    await writeFile(path.join(directory, "unsafe.tape"), "Type 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz'\n");
    assert.deepEqual(await validateStoryAssets({ story: [{ source: "safe.md" }] }, directory), []);
    const errors = await validateStoryAssets({ story: [{ source: "unsafe.tape" }] }, directory);
    assert.ok(errors.some((error) => error.includes("credential-like")));
    assert.equal(validateScenario(actionScenario([])).valid, true);
    const traversal = { ...actionScenario([]), story: [{ type: "slides", source: "../outside.md", durationSeconds: 10 }] };
    assert.equal(validateScenario(traversal).valid, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("malformed nested values report validation errors without throwing", () => {
  const symbolDurationScenario = mobileScenario();
  symbolDurationScenario.story = [{ type: "mobile", durationSeconds: Symbol("private-duration") }];
  const malformed = [
    { canvas: "1080p" },
    { production: null },
    { story: [null] },
    { captions: [null] },
    { extension: { actions: {} } },
    symbolDurationScenario,
  ];
  for (const override of malformed) {
    assert.doesNotThrow(() => {
      assert.equal(validateScenario({ ...actionScenario([]), ...override }).valid, false);
    });
  }
});

test("schema and semantic validation reject absolute and parent-relative asset paths", () => {
  const paths = ["/tmp/demo.md", "../demo.md", "assets/../demo.md", "C:\\temp\\demo.md", "\\\\server\\demo.md"];
  for (const source of paths) {
    const result = validateScenario({
      ...actionScenario([]),
      story: [{ type: "slides", source, durationSeconds: 10 }],
    });
    assert.equal(result.valid, false, source);
  }
});
