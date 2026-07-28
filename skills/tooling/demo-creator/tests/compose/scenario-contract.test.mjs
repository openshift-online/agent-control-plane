import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  androidSetupSensitiveValues,
  authoredCaptionEntries,
  composeScenario,
  materializeScenes,
  normalizeScenes,
  projectPointerEvents,
  resolveManifestArtifact,
  resolveRendererAdapters,
  resolveStorySource,
} from "../../scripts/compose/index.mjs";

async function createFakeMediaTools(root) {
  const ffmpeg = path.join(root, "fake-ffmpeg.mjs");
  const ffprobe = path.join(root, "fake-ffprobe.mjs");
  await fs.writeFile(ffmpeg, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes("-version")) process.exit(0);
if (args.includes("-encoders")) { console.log(" V..... libx264 H.264 encoder"); process.exit(0); }
if (args.includes("-filters")) { console.log(" T.. ass V->V Render ASS subtitles"); process.exit(0); }
console.error("intentional ffmpeg failure");
process.exit(9);
`);
  await fs.writeFile(ffprobe, "#!/usr/bin/env node\nprocess.exit(process.argv.includes('-version') ? 0 : 9);\n");
  await Promise.all([fs.chmod(ffmpeg, 0o700), fs.chmod(ffprobe, 0o700)]);
  return { ffmpeg, ffprobe };
}

test("Android composition selects only configured setup values for transient exact-value scanning", () => {
  const scenario = {
    capture: {
      kind: "android-emulator",
      android: {
        setupActions: [
          { action: "fillFromEnvironment", environment: "ACP_URL" },
          { action: "fillFromEnvironment", environment: "ACP_PROJECT" },
          { action: "fillFromEnvironment", environment: "ACP_BEARER_TOKEN" },
          { action: "fillFromEnvironment", environment: "ACP_BEARER_TOKEN" },
        ],
      },
    },
  };
  const environment = {
    ACP_BEARER_TOKEN: "exact-bearer-token",
    ACP_URL: "http://127.0.0.1:4812",
    ACP_PROJECT: "demo-android-onboarding",
    UNRELATED_SECRET: "must-not-be-selected",
  };
  assert.deepEqual(androidSetupSensitiveValues(scenario, environment), ["exact-bearer-token"]);
  const onlyRuntimeAndProject = structuredClone(scenario);
  onlyRuntimeAndProject.capture.android.setupActions = onlyRuntimeAndProject.capture.android.setupActions.slice(0, 2);
  assert.deepEqual(androidSetupSensitiveValues(onlyRuntimeAndProject, {}), []);
  assert.throws(
    () => androidSetupSensitiveValues(scenario, {}),
    /ACP_BEARER_TOKEN is required for exact output secret scanning/,
  );
  assert.deepEqual(androidSetupSensitiveValues({ capture: { kind: "browser-extension" } }, environment), []);
});

test("core v1 story and captions normalize to compositor contracts", () => {
  const scenario = {
    story: [
      { type: "title", durationSeconds: 3 },
      { type: "browser", durationSeconds: 4 },
      { type: "end", durationSeconds: 3 },
    ],
    captions: [{ startSeconds: 3, endSeconds: 6, text: "Open the pinned extension." }],
  };
  assert.deepEqual(normalizeScenes(scenario).map(({ kind, durationSeconds }) => ({ kind, durationSeconds })), [
    { kind: "title", durationSeconds: 3 },
    { kind: "browser", durationSeconds: 4 },
    { kind: "end", durationSeconds: 3 },
  ]);
  assert.deepEqual(authoredCaptionEntries(scenario), [
    { index: 1, start: 3, end: 6, text: "Open the pinned extension.", sceneId: "caption-1" },
  ]);
});

test("renderer adapters are injectable without importing renderer implementation details", () => {
  const card = async () => "card";
  const slides = async () => "slides";
  const terminal = async () => "terminal";
  assert.deepEqual(resolveRendererAdapters({ renderers: { card, slides, terminal } }), { card, slides, terminal });
});

test("compose workspace is removed when a post-creation validation step fails", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "demo-compose-finally-"));
  const outputDir = path.join(root, "out");
  try {
    const { ffmpeg, ffprobe } = await createFakeMediaTools(root);
    await assert.rejects(
      composeScenario({
        scenario: {
          id: "invalid-transition",
          layout: { preset: "browser-full" },
          production: { transitionSeconds: 2 },
          story: [{ type: "browser", durationSeconds: 1, source: "missing.mp4" }],
        },
        scenarioPath: path.join(root, "scenario.yaml"),
        scenarioDir: root,
        outputDir,
        ffmpeg,
        ffprobe,
      }),
      /Transition duration must be between 0 and 1 second/,
    );
    assert.equal((await fs.readdir(outputDir)).some((entry) => entry.startsWith(".compose-stage-")), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("compose workspace is removed when ffmpeg fails", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "demo-compose-ffmpeg-failure-"));
  const outputDir = path.join(root, "out");
  const source = path.join(root, "browser.mp4");
  try {
    const { ffmpeg, ffprobe } = await createFakeMediaTools(root);
    await fs.writeFile(source, "fixture");
    await assert.rejects(
      composeScenario({
        scenario: {
          id: "ffmpeg-failure",
          layout: { preset: "browser-full" },
          production: { transitionSeconds: 0 },
          story: [{ type: "browser", durationSeconds: 1, source: "browser.mp4" }],
        },
        scenarioPath: path.join(root, "scenario.yaml"),
        scenarioDir: root,
        outputDir,
        ffmpeg,
        ffprobe,
      }),
      /intentional ffmpeg failure/,
    );
    assert.equal((await fs.readdir(outputDir)).some((entry) => entry.startsWith(".compose-stage-")), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("capture manifest artifacts resolve relative to the shared output directory", () => {
  const context = { outputDir: "/tmp/demo-output" };
  assert.equal(resolveManifestArtifact("raw/browser.mp4", context), "/tmp/demo-output/raw/browser.mp4");
  assert.equal(resolveManifestArtifact("pointer-events.jsonl", context), "/tmp/demo-output/pointer-events.jsonl");
  assert.throws(() => resolveManifestArtifact("../credential.json", context), /inside the scenario output/);
  assert.equal(resolveStorySource("slides.md", "/tmp/scenario"), "/tmp/scenario/slides.md");
  assert.throws(() => resolveStorySource("../../credential.json", "/tmp/scenario"), /inside the scenario directory/);
});

test("mobile stories resolve the generic raw capture and retain exact source dimensions", async () => {
  const scenes = await materializeScenes({
    scenes: [{ id: "phone", kind: "mobile", durationSeconds: 2 }],
    scenario: { layout: { preset: "mobile-full" } },
    scenarioDir: "/tmp/scenario",
    outputDir: "/tmp/cards",
    context: {
      outputDir: "/tmp/demo-output",
      manifest: {
        artifacts: { mobileCapture: "raw/android.mp4" },
        capture: {
          source: {
            type: "mobile",
            width: 1080,
            height: 2400,
            landmarks: [{ id: "app-ready", frame: 12 }],
            validationEvidence: { device: "pixel_9" },
          },
        },
      },
    },
    renderers: {},
  });
  assert.deepEqual(scenes, [{
    id: "phone",
    kind: "mobile",
    durationSeconds: 2,
    captureStart: 0,
    layout: { preset: "mobile-full" },
    sources: {
      mobile: {
        path: "/tmp/demo-output/raw/android.mp4",
        startSeconds: 0,
        width: 1080,
        height: 2400,
      },
    },
  }]);
});

test("mobile stories reject missing or non-integral capture dimensions", async () => {
  const base = {
    scenes: [{ id: "phone", kind: "mobile", durationSeconds: 2 }],
    scenario: { layout: { preset: "mobile-full" } },
    scenarioDir: "/tmp/scenario",
    outputDir: "/tmp/cards",
    renderers: {},
  };
  await assert.rejects(
    materializeScenes({
      ...base,
      context: {
        outputDir: "/tmp/demo-output",
        manifest: {
          artifacts: { mobileCapture: "raw/android.mp4" },
          capture: { source: { type: "mobile", width: 1080.5, height: 2400 } },
        },
      },
    }),
    /positive integer source dimensions/,
  );
  await assert.rejects(
    materializeScenes({
      ...base,
      context: {
        outputDir: "/tmp/demo-output",
        manifest: { artifacts: { mobileCapture: "raw/android.mp4" } },
      },
    }),
    /positive integer source dimensions/,
  );
  await assert.rejects(
    materializeScenes({
      ...base,
      context: {
        outputDir: "/tmp/demo-output",
        manifest: {
          artifacts: { mobileCapture: "raw/android.mp4" },
          capture: { source: { type: "mobile", width: "1080", height: 2400 } },
        },
      },
    }),
    /positive integer source dimensions/,
  );
});

test("mobile stories reject authored sources that bypass the manifest-bound capture", async () => {
  for (const source of ["untrusted.mp4", null]) {
    await assert.rejects(
      materializeScenes({
        scenes: [{ id: "phone", kind: "mobile", durationSeconds: 2, source }],
        scenario: { layout: { preset: "mobile-full" } },
        scenarioDir: "/tmp/scenario",
        outputDir: "/tmp/cards",
        context: {
          outputDir: "/tmp/demo-output",
          manifest: {
            artifacts: { mobileCapture: "raw/android.mp4" },
            capture: { source: { type: "mobile", width: 1080, height: 2400 } },
          },
        },
        renderers: {},
      }),
      /mobile story segments must not define story\.source/i,
    );
  }
});

test("absolute monotonic capture events project onto the browser scene timeline", () => {
  const timeline = [
    { id: "title", kind: "title", start: 0, end: 3, duration: 3 },
    {
      id: "browser",
      kind: "browser",
      start: 2.7,
      end: 6.7,
      duration: 4,
      captureStart: 0,
      layout: { preset: "browser-full" },
    },
  ];
  const projected = projectPointerEvents(
    [
      { type: "move", monotonicSeconds: 1000, x: 0, y: 0 },
      { type: "click", monotonicSeconds: 1000.6, x: 1, y: 1 },
    ],
    timeline,
  );
  assert.equal(projected[0].time, 2.7);
  assert.ok(Math.abs(projected[1].time - 3.3) < 1e-9);
  assert.equal(projected[0].x, 128 / 1920);
  assert.equal(projected[1].x, (128 + 1664) / 1920);
  assert.equal(projected[1].y, 1);
  assert.throws(
    () => projectPointerEvents([{ time: 5, x: 0.5, y: 0.5 }], timeline),
    /outside the captured content timeline/,
  );
  assert.throws(
    () => projectPointerEvents([{
      time: 4,
      monotonicSeconds: 1000,
      x: 0.5,
      y: 0.5,
    }], timeline),
    /outside the captured content timeline/,
  );
});

test("pointer projection rejects negative or regressing time and preserves equal-time order", () => {
  const timeline = [{
    id: "browser",
    kind: "browser",
    start: 2.7,
    end: 6.7,
    duration: 4,
    captureStart: 0,
    layout: { preset: "browser-full" },
  }];
  const point = { x: 0.5, y: 0.5 };
  assert.throws(
    () => projectPointerEvents([{ type: "click", time: -0.1, ...point }], timeline),
    /Pointer event 1 timestamp is negative/,
  );
  assert.throws(
    () => projectPointerEvents([
      { type: "move", time: 0, monotonicSeconds: 1000, ...point },
      { type: "click", monotonicSeconds: 999, ...point },
    ], timeline),
    /Pointer event 2 timestamp is negative/,
  );
  assert.throws(
    () => projectPointerEvents([
      { type: "move", time: 1, ...point },
      { type: "click", time: 0.5, ...point },
    ], timeline),
    /Pointer event 2 timestamp regresses/,
  );
  const equal = projectPointerEvents([
    { type: "move", time: 1, ...point },
    { type: "click", time: 1, ...point },
  ], timeline);
  assert.deepEqual(equal.map((event) => event.type), ["move", "click"]);
  assert.deepEqual(equal.map((event) => event.time), [3.7, 3.7]);
});

test("extension-right pointer endpoints include the same aspect-fit padding as FFmpeg", () => {
  const cropStart = 1 - 0.328125;
  const project = (layout) => projectPointerEvents(
    [
      { type: "move", time: 0, x: cropStart, y: 0 },
      { type: "move", time: 0.5, x: 1, y: 1 },
    ],
    [{
      id: "split",
      kind: "browser",
      start: 0,
      end: 2,
      duration: 2,
      captureStart: 0,
      layout,
    }],
  );

  const extension = project({ preset: "slides-extension" });
  assert.equal(extension[0].x, 1332 / 1920);
  assert.equal(extension[1].x, 1878 / 1920);
  assert.equal(extension[0].y, 0);
  assert.equal(extension[1].y, 1);

  const generic = project({ preset: "generic-split", leftRatio: 0.5 });
  assert.equal(generic[0].x, 1173 / 1920);
  assert.equal(generic[1].x, 1719 / 1920);
});

test("mobile pointers use source dimensions and the centered portrait aspect-fit transform", () => {
  const projected = projectPointerEvents(
    [
      { type: "move", time: 0, normalizedX: 0, normalizedY: 0 },
      { type: "click", time: 0.5, normalizedX: 1, normalizedY: 1 },
    ],
    [{
      id: "phone",
      kind: "mobile",
      start: 0,
      end: 2,
      duration: 2,
      captureStart: 0,
      layout: { preset: "mobile-full" },
      sources: { mobile: { width: 1080, height: 2400 } },
    }],
  );
  assert.equal(projected[0].x, 749 / 1920);
  assert.equal(projected[0].y, 0);
  assert.equal(projected[1].x, 1171 / 1920);
  assert.equal(projected[1].y, 1);
  assert.throws(
    () => projectPointerEvents(
      [{ type: "move", time: 0, x: 0.5, y: 0.5 }],
      [{
        id: "phone",
        kind: "mobile",
        start: 0,
        end: 2,
        duration: 2,
        captureStart: 0,
        layout: { preset: "mobile-full" },
        sources: { mobile: { width: "1080", height: 2400 } },
      }],
    ),
    /positive integer source dimensions/,
  );
});

test("consecutive mobile scenes require a zero transition to preserve pointer time order", () => {
  const scene = (id, start, captureStart) => ({
    id,
    kind: "mobile",
    start,
    end: start + 2,
    duration: 2,
    captureStart,
    layout: { preset: "mobile-full" },
    sources: { mobile: { width: 1080, height: 2400 } },
  });
  const events = [
    { type: "move", time: 1.99, x: 0.5, y: 0.5 },
    { type: "click", time: 2.01, x: 0.5, y: 0.5 },
  ];

  assert.throws(
    () => projectPointerEvents(events, [scene("first", 0, 0), scene("second", 1.7, 2)]),
    /consecutive mobile.*transition.*zero/i,
  );

  assert.deepEqual(
    projectPointerEvents(events, [scene("first", 0, 0), scene("second", 2, 2)]).map(({ time }) => time),
    [1.99, 2.01],
  );
});

test("9:16 mobile pointer endpoints use the same even-decrease rectangle as FFmpeg", () => {
  const projected = projectPointerEvents(
    [
      { type: "move", time: 0, x: 0, y: 0 },
      { type: "move", time: 0.5, x: 1, y: 1 },
    ],
    [{
      id: "phone",
      kind: "mobile",
      start: 0,
      end: 2,
      duration: 2,
      captureStart: 0,
      layout: { preset: "mobile-full" },
      sources: { mobile: { width: 1080, height: 1920 } },
    }],
  );
  assert.deepEqual(
    projected.map(({ x, y }) => ({ x, y })),
    [
      { x: 697 / 1920, y: 0 },
      { x: 1223 / 1920, y: 1 },
    ],
  );
});
