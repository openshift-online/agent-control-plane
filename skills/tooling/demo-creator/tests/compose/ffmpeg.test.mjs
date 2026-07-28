import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  create720pDerivative,
  ffmpegEncoderAvailable,
  renderSceneSegment,
  runCommand,
  xfadeFilter,
} from "../../scripts/compose/ffmpeg.mjs";

test("xfade offsets create a frame-stable joined duration", () => {
  const result = xfadeFilter([3, 4, 3], 0.3);
  assert.equal(result.duration, 9.4);
  assert.match(result.filter, /offset=2\.700000/);
  assert.match(result.filter, /offset=6\.400000/);
});

test("zero-duration transitions use a lossless timeline concat", () => {
  const result = xfadeFilter([1, 2], 0);
  assert.equal(result.duration, 3);
  assert.equal(result.filter, "[0:v][1:v]concat=n=2:v=1:a=0[concat]");
});

test("720p derivative uses Lanczos and production-safe encoding", async () => {
  let captured;
  await create720pDerivative({
    inputPath: "master.mp4",
    outputPath: "derivative.mp4",
    execute: async (command, args) => {
      captured = { command, args };
    },
  });
  assert.equal(captured.command, "ffmpeg");
  assert.ok(captured.args.includes("scale=1280:720:flags=lanczos,setsar=1"));
  assert.ok(captured.args.includes("yuv420p"));
  assert.ok(captured.args.includes("+faststart"));
  assert.ok(captured.args.includes("-an"));
});

test("mobile aspect-fit scaling forces even source dimensions for exact pointer projection", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "demo-mobile-filter-"));
  const source = path.join(root, "mobile.mp4");
  try {
    await fs.writeFile(source, "fixture");
    let args;
    await renderSceneSegment({
      scene: {
        id: "phone",
        kind: "mobile",
        layout: { preset: "mobile-full" },
        sources: { mobile: { path: source } },
      },
      scenarioDir: root,
      outputPath: path.join(root, "segment.mp4"),
      duration: 1,
      execute: async (_command, capturedArgs) => {
        args = capturedArgs;
      },
    });
    const filter = args[args.indexOf("-filter_complex") + 1];
    assert.equal(args.includes("-stream_loop"), false);
    assert.match(
      filter,
      /scale=1920:936:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=lanczos/,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("browser video sources retain the established looping behavior", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "demo-browser-loop-"));
  const source = path.join(root, "browser.mp4");
  try {
    await fs.writeFile(source, "fixture");
    let args;
    await renderSceneSegment({
      scene: {
        id: "browser",
        kind: "browser",
        layout: { preset: "browser-full" },
        sources: { browser: { path: source } },
      },
      scenarioDir: root,
      outputPath: path.join(root, "segment.mp4"),
      duration: 1,
      execute: async (_command, capturedArgs) => {
        args = capturedArgs;
      },
    });
    assert.deepEqual(args.slice(args.indexOf("-stream_loop"), args.indexOf("-i")), ["-stream_loop", "-1"]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("mobile rendering consumes the verified descriptor instead of a substitutable pathname", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "demo-mobile-descriptor-"));
  const source = path.join(root, "mobile.mp4");
  const original = path.join(root, "mobile-original.mp4");
  let handle;
  try {
    await fs.writeFile(source, "verified mobile bytes");
    handle = await fs.open(source, "r");
    await fs.rename(source, original);
    await fs.writeFile(source, "substituted pathname bytes");
    await renderSceneSegment({
      scene: {
        id: "phone",
        kind: "mobile",
        layout: { preset: "mobile-full" },
        sources: { mobile: { path: source, fileDescriptor: handle.fd } },
      },
      scenarioDir: root,
      outputPath: path.join(root, "segment.mp4"),
      duration: 1,
      execute: async (_command, args, options) => {
        assert.equal(args[args.indexOf("-i") + 1], "/dev/fd/3");
        assert.deepEqual(options.inheritedFileDescriptors, [handle.fd]);
        assert.equal((await handle.readFile()).toString("utf8"), "verified mobile bytes");
      },
    });
  } finally {
    if (handle) await handle.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("encoder preflight recognizes libx264 from ffmpeg's encoder table", async () => {
  const execute = async () => ({ stdout: " V..... libx264 H.264 encoder\n", stderr: "" });
  assert.equal(await ffmpegEncoderAvailable("libx264", "ffmpeg", execute), true);
  assert.equal(await ffmpegEncoderAvailable("definitely-not-an-encoder", "ffmpeg", execute), false);
});

test("runCommand scrubs caller credentials but preserves the rest of the subprocess environment", async () => {
  const priorToken = Object.prototype.hasOwnProperty.call(process.env, "ACP_BEARER_TOKEN")
    ? process.env.ACP_BEARER_TOKEN
    : undefined;
  process.env.ACP_BEARER_TOKEN = "regression-sentinel-token";
  process.env.DEMO_CREATOR_ENV_PROBE = "inherited-value";
  try {
    const { stdout } = await runCommand(process.execPath, [
      "-e",
      "process.stdout.write(JSON.stringify({ token: process.env.ACP_BEARER_TOKEN ?? null, probe: process.env.DEMO_CREATOR_ENV_PROBE ?? null }))",
    ]);
    const child = JSON.parse(stdout);
    assert.equal(child.token, null, "ACP_BEARER_TOKEN must not reach ffmpeg/ffprobe subprocesses");
    assert.equal(child.probe, "inherited-value", "non-sensitive environment must still be inherited");
  } finally {
    if (priorToken === undefined) delete process.env.ACP_BEARER_TOKEN;
    else process.env.ACP_BEARER_TOKEN = priorToken;
    delete process.env.DEMO_CREATOR_ENV_PROBE;
  }
});

test("runCommand refuses to let an explicit environment override reintroduce a sensitive name", async () => {
  const { stdout } = await runCommand(
    process.execPath,
    [
      "-e",
      "process.stdout.write(JSON.stringify({token:process.env.ACP_BEARER_TOKEN??null,safe:process.env.SAFE_VALUE??null}))",
    ],
    { env: { ACP_BEARER_TOKEN: "explicit-override", SAFE_VALUE: "allowed" } },
  );
  assert.deepEqual(JSON.parse(stdout), { token: null, safe: "allowed" });
  assert.equal(stdout.includes("explicit-override"), false);
});
