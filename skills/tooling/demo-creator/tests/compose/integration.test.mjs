import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { composeScenario } from "../../scripts/compose/index.mjs";
import {
  commandAvailable,
  ffmpegEncoderAvailable,
  ffmpegFilterAvailable,
  runCommand,
} from "../../scripts/compose/ffmpeg.mjs";

const mediaToolsAvailable =
  (await commandAvailable("ffmpeg")) &&
  (await commandAvailable("ffprobe")) &&
  (await ffmpegEncoderAvailable("libx264")) &&
  (await ffmpegFilterAvailable("ass"));

async function createCapturedVideo(outputDir, duration = 0.25) {
  const rawDir = path.join(outputDir, "raw");
  const capturedSource = path.join(rawDir, "browser.mp4");
  await fs.mkdir(rawDir, { recursive: true });
  await runCommand("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    `testsrc2=size=640x480:rate=30:duration=${duration}`,
    "-an",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    capturedSource,
  ]);
  return capturedSource;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function mobileManifest(outputDir, { durationSeconds, pointerEvents = [] } = {}) {
  const capture = await fs.readFile(path.join(outputDir, "raw", "mobile.mp4"));
  const pointerBytes = Buffer.from(`${pointerEvents.map((event) => JSON.stringify(event)).join("\n")}${pointerEvents.length ? "\n" : ""}`);
  await fs.writeFile(path.join(outputDir, "pointer-events.jsonl"), pointerBytes);
  return {
    artifacts: {
      mobileCapture: "raw/mobile.mp4",
      pointerEvents: "pointer-events.jsonl",
    },
    capture: {
      source: {
        type: "mobile",
        width: 360,
        height: 800,
        landmarks: [{ id: "home-visible", frame: 1 }],
        validationEvidence: {
          orientation: "portrait",
          durationSeconds,
          artifactSha256: {
            mobileCapture: sha256(capture),
            pointerEvents: sha256(pointerBytes),
          },
        },
      },
    },
  };
}

function browserScenario(overrides = {}) {
  return {
    version: 1,
    id: "synthetic-failure",
    title: "Synthetic browser demo",
    fps: 30,
    canvas: { master: "1080p", derivative: "720p" },
    layout: { preset: "browser-full" },
    production: { transitionMilliseconds: 0, silent: true },
    story: [{ type: "browser", durationSeconds: 0.25 }],
    acp: { project: "demo-synthetic-failure" },
    ...overrides,
  };
}

test(
  "synthetic scenario composes and validates exact 1080p and 720p deliverables",
  { skip: mediaToolsAvailable ? false : "ffmpeg with the free libass filter and libx264 encoder is not installed" },
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "demo-creator-compose-"));
    try {
      const source = path.join(root, "browser.mp4");
      await runCommand("ffmpeg", [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=640x480:rate=30:duration=1",
        "-an",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        source,
      ]);
      const outputDir = path.join(root, "out");
      await fs.mkdir(path.join(outputDir, "raw"), { recursive: true });
      const capturedSource = path.join(outputDir, "raw", "browser.mp4");
      await fs.rename(source, capturedSource);
      await fs.writeFile(
        path.join(outputDir, "pointer-events.jsonl"),
        `${JSON.stringify({ type: "click", monotonicSeconds: 100, x: 0.9, y: 0.1 })}\n`,
      );
      const result = await composeScenario({
        scenario: {
          version: 1,
          id: "synthetic",
          title: "Synthetic browser demo",
          fps: 30,
          canvas: { master: "1080p", derivative: "720p" },
          layout: { preset: "browser-full" },
          production: { transitionMilliseconds: 0, silent: true },
          story: [
            {
              type: "browser",
              durationSeconds: 1,
            },
          ],
          captions: [{ startSeconds: 0, endSeconds: 0.9, text: "A silent, self-explanatory browser demo." }],
          acp: { project: "demo-synthetic" },
        },
        scenarioPath: path.join(root, "scenario.yaml"),
        scenarioDir: root,
        outputDir,
        manifest: {
          artifacts: {
            browserCapture: "raw/browser.mp4",
            pointerEvents: "pointer-events.jsonl",
          },
        },
      });
      assert.equal(result.composition.width, 1920);
      assert.equal(result.composition.height, 1080);
      assert.equal(result.composition.fps, 30);
      assert.equal(result.composition.silent, true);
      assert.equal(result.composition.master, "demo-1080p.mp4");
      assert.equal(result.composition.derivative, "demo-720p.mp4");
      assert.equal(result.composition.contactSheet, "contact-sheet.png");
      assert.equal(result.composition.captions.vtt, "captions.vtt");
      await Promise.all([
        fs.access(path.join(outputDir, result.composition.master)),
        fs.access(path.join(outputDir, result.composition.derivative)),
        fs.access(path.join(outputDir, result.composition.contactSheet)),
        fs.access(path.join(outputDir, result.composition.validationReport)),
      ]);
      const report = JSON.parse(await fs.readFile(path.join(outputDir, result.composition.validationReport), "utf8"));
      assert.equal(report.ok, true);
      assert.equal(report.master.file, "demo-1080p.mp4");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "mobile composition publishes portrait media with capture evidence in its validation report",
  { skip: mediaToolsAvailable ? false : "ffmpeg with the free libass filter and libx264 encoder is not installed" },
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "demo-creator-mobile-compose-"));
    const outputDir = path.join(root, "out");
    const rawDir = path.join(outputDir, "raw");
    const capturedSource = path.join(rawDir, "mobile.mp4");
    try {
      await fs.mkdir(rawDir, { recursive: true });
      await runCommand("ffmpeg", [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=360x800:rate=30:duration=0.25",
        "-an",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        capturedSource,
      ]);
      const manifest = await mobileManifest(outputDir, { durationSeconds: 0.25 });
      const result = await composeScenario({
        scenario: {
          version: 1,
          id: "synthetic-mobile",
          title: "Synthetic mobile demo",
          fps: 30,
          canvas: { master: "1080p", derivative: "720p" },
          layout: { preset: "mobile-full" },
          production: { transitionMilliseconds: 0, silent: true },
          story: [{ type: "mobile", durationSeconds: 0.25 }],
          acp: { project: "demo-synthetic-mobile" },
        },
        scenarioPath: path.join(root, "scenario.yaml"),
        scenarioDir: root,
        outputDir,
        manifest,
      });
      const report = JSON.parse(
        await fs.readFile(path.join(outputDir, result.composition.validationReport), "utf8"),
      );
      assert.deepEqual(report.capture, { source: manifest.capture.source });
      assert.equal(report.master.checks.dimensions, true);
      assert.equal(report.derivative.checks.dimensions, true);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "mobile composition rejects a capture that ends before the authored budget instead of looping it",
  { skip: mediaToolsAvailable ? false : "ffmpeg with the free libass filter and libx264 encoder is not installed" },
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "demo-creator-mobile-truncated-"));
    const outputDir = path.join(root, "out");
    try {
      await fs.mkdir(path.join(outputDir, "raw"), { recursive: true });
      await runCommand("ffmpeg", [
        "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", "testsrc2=size=360x800:rate=30:duration=0.25",
        "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p",
        path.join(outputDir, "raw", "mobile.mp4"),
      ]);
      const manifest = await mobileManifest(outputDir, { durationSeconds: 0.25 });
      await assert.rejects(
        composeScenario({
          scenario: {
            version: 1,
            id: "truncated-mobile",
            title: "Truncated mobile demo",
            layout: { preset: "mobile-full" },
            production: { transitionMilliseconds: 0, silent: true },
            story: [{ type: "mobile", durationSeconds: 1 }],
            acp: { project: "demo-truncated-mobile" },
          },
          scenarioPath: path.join(root, "scenario.yaml"),
          scenarioDir: root,
          outputDir,
          manifest,
        }),
        /duration.*authored mobile budget/i,
      );
      await assert.rejects(fs.access(path.join(outputDir, "demo-1080p.mp4")), { code: "ENOENT" });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "mobile composition rejects manifest digest mismatches and symlinked capture artifacts",
  { skip: mediaToolsAvailable ? false : "ffmpeg with the free libass filter and libx264 encoder is not installed" },
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "demo-creator-mobile-integrity-"));
    const outputDir = path.join(root, "out");
    try {
      await fs.mkdir(path.join(outputDir, "raw"), { recursive: true });
      await runCommand("ffmpeg", [
        "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", "testsrc2=size=360x800:rate=30:duration=0.5",
        "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p",
        path.join(outputDir, "raw", "mobile.mp4"),
      ]);
      const scenario = {
        version: 1,
        id: "integrity-mobile",
        title: "Integrity mobile demo",
        layout: { preset: "mobile-full" },
        production: { transitionMilliseconds: 0, silent: true },
        story: [{ type: "mobile", durationSeconds: 0.5 }],
        acp: { project: "demo-integrity-mobile" },
      };
      const invoke = (manifest) => composeScenario({
        scenario,
        scenarioPath: path.join(root, "scenario.yaml"),
        scenarioDir: root,
        outputDir,
        manifest,
      });

      const mismatched = await mobileManifest(outputDir, { durationSeconds: 0.5 });
      mismatched.capture.source.validationEvidence.artifactSha256.mobileCapture = "0".repeat(64);
      await assert.rejects(invoke(mismatched), /mobileCapture digest does not match/i);

      const manifest = await mobileManifest(outputDir, { durationSeconds: 0.5 });
      await fs.rename(path.join(outputDir, "raw", "mobile.mp4"), path.join(outputDir, "raw", "mobile-real.mp4"));
      await fs.symlink("mobile-real.mp4", path.join(outputDir, "raw", "mobile.mp4"));
      await assert.rejects(invoke(manifest), /mobileCapture.*symbolic link/i);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "mobile composition rejects pointer events beyond the verified capture duration",
  { skip: mediaToolsAvailable ? false : "ffmpeg with the free libass filter and libx264 encoder is not installed" },
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "demo-creator-mobile-pointer-duration-"));
    const outputDir = path.join(root, "out");
    try {
      await fs.mkdir(path.join(outputDir, "raw"), { recursive: true });
      await runCommand("ffmpeg", [
        "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", "testsrc2=size=360x800:rate=30:duration=0.95",
        "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p",
        path.join(outputDir, "raw", "mobile.mp4"),
      ]);
      const manifest = await mobileManifest(outputDir, {
        durationSeconds: 0.95,
        pointerEvents: [{ type: "click", time: 0.97, x: 0.5, y: 0.5 }],
      });
      await assert.rejects(
        composeScenario({
          scenario: {
            version: 1,
            id: "pointer-duration-mobile",
            title: "Pointer duration mobile demo",
            layout: { preset: "mobile-full" },
            production: { transitionMilliseconds: 0, silent: true },
            story: [{ type: "mobile", durationSeconds: 1 }],
            acp: { project: "demo-pointer-duration-mobile" },
          },
          scenarioPath: path.join(root, "scenario.yaml"),
          scenarioDir: root,
          outputDir,
          manifest,
        }),
        /pointer event.*verified mobile capture duration/i,
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "retained raw-artifact secret-scan failure preserves every pre-existing public artifact",
  { skip: mediaToolsAvailable ? false : "ffmpeg with the free libass filter and libx264 encoder is not installed" },
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "demo-creator-secret-failure-"));
    const outputDir = path.join(root, "out");
    const sentinel = path.join(outputDir, "demo-1080p.mp4");
    const sentinelBytes = Buffer.from([0, 1, 2, 3, 254, 255]);
    try {
      await createCapturedVideo(outputDir);
      await fs.writeFile(
        path.join(outputDir, "raw", "android-apk-lock.json"),
        `${JSON.stringify({ note: "access_token=abcdefghijklmnop" })}\n`,
      );
      await fs.writeFile(sentinel, sentinelBytes);
      await assert.rejects(
        composeScenario({
          scenario: browserScenario(),
          scenarioPath: path.join(root, "scenario.yaml"),
          scenarioDir: root,
          outputDir,
          manifest: { artifacts: { browserCapture: "raw/browser.mp4" } },
        }),
        /Secret-like data found/,
      );
      assert.deepEqual(await fs.readFile(sentinel), sentinelBytes);
      await fs.access(path.join(outputDir, "raw", "browser.mp4"));
      for (const generated of [
        "captions.vtt",
        "captions.srt",
        "transcript.txt",
        "overlays.ass",
        "demo-720p.mp4",
        "contact-sheet.png",
      ]) {
        await assert.rejects(fs.access(path.join(outputDir, generated)), { code: "ENOENT" });
      }
      assert.equal((await fs.readdir(outputDir)).some((entry) => entry.startsWith(".compose-stage-")), false);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "validation failure still removes the private compose workspace",
  { skip: mediaToolsAvailable ? false : "ffmpeg with the free libass filter and libx264 encoder is not installed" },
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "demo-creator-validation-failure-"));
    const outputDir = path.join(root, "out");
    const ffprobe = path.join(root, "failing-ffprobe.mjs");
    try {
      await createCapturedVideo(outputDir);
      await fs.writeFile(
        ffprobe,
        "#!/usr/bin/env node\nif (process.argv.includes('-version')) process.exit(0); console.error('intentional ffprobe failure'); process.exit(8);\n",
      );
      await fs.chmod(ffprobe, 0o700);
      await assert.rejects(
        composeScenario({
          scenario: browserScenario({ id: "validation-failure" }),
          scenarioPath: path.join(root, "scenario.yaml"),
          scenarioDir: root,
          outputDir,
          manifest: { artifacts: { browserCapture: "raw/browser.mp4" } },
          ffprobe,
        }),
        /intentional ffprobe failure/,
      );
      assert.equal((await fs.readdir(outputDir)).some((entry) => entry.startsWith(".compose-stage-")), false);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);
