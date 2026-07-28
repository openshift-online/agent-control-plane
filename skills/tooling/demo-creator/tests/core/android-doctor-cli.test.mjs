import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import test from "node:test";
import { promisify } from "node:util";

import { runDoctor } from "../../scripts/core/doctor.mjs";

const execFileAsync = promisify(execFile);
const cliUrl = new URL("../../scripts/demo.mjs", import.meta.url).href;

function passingCheck(name, required = true) {
  return { name, required, ok: true, detail: "fixture" };
}

function doctorDependencies(calls) {
  return {
    findMediaTools: async () => ({ ffmpeg: "ffmpeg-full", ffprobe: "ffprobe-full" }),
    commandCheck: async (name, _args, required) => {
      calls.push(["command", name]);
      return passingCheck(name, required);
    },
    ffmpegAssCheck: async (name, required) => {
      calls.push(["ass", name]);
      return passingCheck("ffmpeg-libass", required);
    },
    moduleCheck: async (name, _specifier, required) => {
      calls.push(["module", name]);
      return passingCheck(name, required);
    },
    pathCheck: async (name, target, required) => {
      calls.push(["path", name, target]);
      return passingCheck(name, required);
    },
  };
}

test("Android core doctor gates common media and security tools without browser-only prerequisites", async () => {
  const calls = [];
  const result = await runDoctor("darwin", {
    captureKind: "android-emulator",
    dependencies: doctorDependencies(calls),
  });

  assert.equal(result.ok, true);
  assert.deepEqual(calls, [
    ["command", "node"],
    ["command", "ffmpeg-full"],
    ["ass", "ffmpeg-full"],
    ["command", "ffprobe-full"],
    ["command", "tesseract"],
  ]);
  for (const forbidden of ["vhs", "presenterm", "playwright", "Hammerspoon", "Chrome for Testing", "OBS", "Xvfb", "xdotool"]) {
    assert.equal(JSON.stringify(calls).includes(forbidden), false, `${forbidden} must not be required`);
  }
});

test("browser core doctor preserves the existing macOS prerequisite set", async () => {
  const calls = [];
  const result = await runDoctor("darwin", { dependencies: doctorDependencies(calls) });

  assert.equal(result.ok, true);
  assert.deepEqual(calls, [
    ["command", "node"],
    ["command", "ffmpeg-full"],
    ["ass", "ffmpeg-full"],
    ["command", "ffprobe-full"],
    ["command", "tesseract"],
    ["command", "vhs"],
    ["command", "presenterm"],
    ["module", "playwright"],
    ["path", "Hammerspoon", "/Applications/Hammerspoon.app"],
    ["path", "Chrome for Testing", "/Applications/Google Chrome for Testing.app"],
    ["path", "OBS", "/Applications/OBS.app"],
  ]);
});

test("browser core doctor preserves the existing Linux prerequisite set", async () => {
  const calls = [];
  const result = await runDoctor("linux", { dependencies: doctorDependencies(calls) });

  assert.equal(result.ok, true);
  assert.deepEqual(calls.slice(-2), [
    ["command", "Xvfb"],
    ["command", "xdotool"],
  ]);
  assert.equal(calls.some(([kind]) => kind === "path"), false);
});

test("scenario-aware doctor validates Android and gates cards without live capture mutation", async () => {
  const cli = await import("../../scripts/demo.mjs");
  assert.equal(typeof cli.doctor, "function", "demo.mjs must export doctor for dependency-injected checks");
  const calls = [];
  const capture = {
    kind: "android-emulator",
    cluster: { kind: "disposable-kind" },
    android: { systemImage: "system-images;android-35;google_apis;arm64-v8a" },
  };
  const scenario = { id: "android-onboarding", capture, story: [{ type: "mobile", durationSeconds: 12 }] };

  const result = await cli.doctor("/scenario/scenario.yaml", {}, {
    platform: "darwin",
    resolveScenarioPath: async (argument) => {
      calls.push(["resolveScenarioPath", argument]);
      return argument;
    },
    loadScenario: async (scenarioPath) => {
      calls.push(["loadScenario", scenarioPath]);
      return { scenario };
    },
    runDoctor: async (platform, options) => {
      calls.push(["runDoctor", platform, options.captureKind]);
      return { ok: true, platform, mediaTools: {}, checks: [] };
    },
    renderDoctor: async (options) => {
      calls.push(["renderDoctor", options.required]);
      return { ok: true, required: options.required, checks: [] };
    },
    doctorCapture: async (context) => {
      calls.push(["doctorCapture", context.scenario.capture.kind]);
      return { ok: true, capture: { kind: "android-emulator" }, tools: {} };
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(calls, [
    ["resolveScenarioPath", "/scenario/scenario.yaml"],
    ["loadScenario", "/scenario/scenario.yaml"],
    ["runDoctor", "darwin", "android-emulator"],
    ["renderDoctor", ["cards"]],
    ["doctorCapture", "android-emulator"],
  ]);
  assert.equal(result.render.required[0], "cards");
  assert.equal(result.nativeCapture.capture.kind, "android-emulator");
});

test("doctor without a scenario preserves the browser prerequisite path", async () => {
  const cli = await import("../../scripts/demo.mjs");
  const calls = [];
  const result = await cli.doctor(undefined, {}, {
    platform: "linux",
    runDoctor: async (platform, options) => {
      calls.push(["runDoctor", platform, options.captureKind]);
      return { ok: true, platform, mediaTools: {}, checks: [] };
    },
    renderDoctor: async () => { throw new Error("browser compatibility path must not add a renderer report"); },
    doctorCapture: async (context) => {
      calls.push(["doctorCapture", context.scenario]);
      return { ok: true, platform: "linux", checks: [] };
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(calls, [
    ["runDoctor", "linux", "browser-extension"],
    ["doctorCapture", undefined],
  ]);
  assert.equal(Object.hasOwn(result, "render"), false);
});

test("process-level doctor dispatch supports scenario and no-scenario forms without import side effects", async () => {
  for (const scenarioArgument of [undefined, "/scenario/scenario.yaml"]) {
    const script = `
      import { main } from ${JSON.stringify(cliUrl)};
      const scenario = {
        id: "android-onboarding",
        capture: { kind: "android-emulator", cluster: { kind: "disposable-kind" }, android: {} },
        story: [{ type: "mobile", durationSeconds: 12 }],
      };
      await main(${JSON.stringify(scenarioArgument ? ["doctor", scenarioArgument, "--json"] : ["doctor", "--json"])}, {
        platform: "linux",
        resolveScenarioPath: async (value) => value,
        loadScenario: async () => ({ scenario }),
        runDoctor: async (platform) => ({ ok: true, platform, mediaTools: {}, checks: [] }),
        renderDoctor: async (options) => ({ ok: true, required: options.required, checks: [] }),
        doctorCapture: async (context) => ({
          ok: true,
          capture: { kind: context.scenario?.capture?.kind ?? "browser-extension" },
          checks: [],
        }),
      });
    `;
    const { stdout, stderr } = await execFileAsync(process.execPath, ["--input-type=module", "--eval", script]);
    assert.equal(stderr, "");
    const result = JSON.parse(stdout);
    assert.equal(result.ok, true);
    assert.equal(
      result.nativeCapture.capture.kind,
      scenarioArgument ? "android-emulator" : "browser-extension",
    );
    assert.equal(Object.hasOwn(result, "render"), Boolean(scenarioArgument));
  }
});
