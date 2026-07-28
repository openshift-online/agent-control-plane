import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  composeScenario,
  publishStagedOutputs,
  resolveCompositionContext,
  resolveManifestArtifact,
} from "../../scripts/compose/index.mjs";
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

const publicOutputs = [
  "captions.vtt",
  "captions.srt",
  "transcript.txt",
  "overlays.ass",
  "demo-1080p.mp4",
  "demo-720p.mp4",
  "contact-sheet.png",
  "validation-report.json",
];

test("computed default output directory is propagated before manifest artifacts resolve", () => {
  const scenarioDir = "/tmp/demo-scenario";
  const context = resolveCompositionContext({}, scenarioDir, { id: "browser-flow" });
  assert.equal(context.outputDir, "/tmp/demo-scenario/.demo-output/browser-flow");
  assert.equal(
    resolveManifestArtifact("raw/browser.mp4", context),
    "/tmp/demo-scenario/.demo-output/browser-flow/raw/browser.mp4",
  );
});

test("staged publication replaces the complete output set only after preflight", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "demo-publish-"));
  const outputDir = path.join(root, "output");
  const stageDir = path.join(outputDir, ".stage");
  try {
    await fs.mkdir(stageDir, { recursive: true });
    await fs.writeFile(path.join(outputDir, "a.txt"), "old-a");
    await fs.writeFile(path.join(stageDir, "a.txt"), "new-a");
    await fs.writeFile(path.join(stageDir, "b.txt"), "new-b");
    await publishStagedOutputs({ stageDir, outputDir, files: ["a.txt", "b.txt"] });
    assert.equal(await fs.readFile(path.join(outputDir, "a.txt"), "utf8"), "new-a");
    assert.equal(await fs.readFile(path.join(outputDir, "b.txt"), "utf8"), "new-b");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("publication preflight leaves finals untouched when a staged artifact is missing", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "demo-publish-preflight-"));
  const outputDir = path.join(root, "output");
  const stageDir = path.join(outputDir, ".stage");
  try {
    await fs.mkdir(stageDir, { recursive: true });
    await fs.writeFile(path.join(outputDir, "a.txt"), "old-a");
    await fs.writeFile(path.join(stageDir, "a.txt"), "new-a");
    await assert.rejects(
      publishStagedOutputs({ stageDir, outputDir, files: ["a.txt", "missing.txt"] }),
      { code: "ENOENT" },
    );
    assert.equal(await fs.readFile(path.join(outputDir, "a.txt"), "utf8"), "old-a");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("publication rollback preserves every pre-existing final byte on failure", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "demo-publish-rollback-"));
  const outputDir = path.join(root, "output");
  const stageDir = path.join(outputDir, ".stage");
  const oldA = Buffer.from([0, 1, 2, 3, 255]);
  const oldB = Buffer.from([255, 4, 3, 2, 1]);
  try {
    await fs.mkdir(stageDir, { recursive: true });
    await fs.writeFile(path.join(outputDir, "a.bin"), oldA);
    await fs.writeFile(path.join(outputDir, "b.bin"), oldB);
    await fs.writeFile(path.join(stageDir, "a.bin"), "new-a");
    await fs.writeFile(path.join(stageDir, "b.bin"), "new-b");
    const operations = new Proxy(fs, {
      get(target, property) {
        if (property !== "rename") return target[property];
        return async (source, destination) => {
          if (source === path.join(stageDir, "b.bin") && destination === path.join(outputDir, "b.bin")) {
            throw new Error("injected publish failure");
          }
          return fs.rename(source, destination);
        };
      },
    });
    await assert.rejects(
      publishStagedOutputs({ stageDir, outputDir, files: ["a.bin", "b.bin"], operations }),
      /injected publish failure/,
    );
    assert.deepEqual(await fs.readFile(path.join(outputDir, "a.bin")), oldA);
    assert.deepEqual(await fs.readFile(path.join(outputDir, "b.bin")), oldB);
    await assert.rejects(fs.access(path.join(outputDir, ".compose-publish.lock")), { code: "ENOENT" });
    assert.deepEqual(
      (await fs.readdir(outputDir)).filter((entry) => entry.startsWith(".compose-publish.transaction-")),
      [],
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a later publication recovers a transaction whose publisher crashed mid-rename", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "demo-publish-crash-"));
  const outputDir = path.join(root, "output");
  const crashedStageDir = path.join(outputDir, ".crashed-stage");
  const nextStageDir = path.join(outputDir, ".next-stage");
  try {
    await fs.mkdir(crashedStageDir, { recursive: true });
    await fs.writeFile(path.join(outputDir, "a.txt"), "old-a");
    await fs.writeFile(path.join(outputDir, "b.txt"), "old-b");
    await fs.writeFile(path.join(crashedStageDir, "new.txt"), "partial-new");
    await fs.writeFile(path.join(crashedStageDir, "a.txt"), "crashed-a");
    await fs.writeFile(path.join(crashedStageDir, "b.txt"), "crashed-b");

    const moduleUrl = new URL("../../scripts/compose/index.mjs", import.meta.url).href;
    const childSource = `
      import fs from "node:fs/promises";
      import path from "node:path";
      import { publishStagedOutputs } from ${JSON.stringify(moduleUrl)};
      const outputDir = ${JSON.stringify(outputDir)};
      const stageDir = ${JSON.stringify(crashedStageDir)};
      const operations = new Proxy(fs, {
        get(target, property) {
          if (property !== "rename") return target[property];
          return async (source, destination) => {
            await fs.rename(source, destination);
            if (source === path.join(stageDir, "a.txt") && destination === path.join(outputDir, "a.txt")) {
              process.exit(91);
            }
          };
        },
      });
      await publishStagedOutputs({ stageDir, outputDir, files: ["new.txt", "a.txt", "b.txt"], operations });
    `;
    const child = spawn(process.execPath, ["--input-type=module", "-e", childSource], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const [exitCode, stderr] = await Promise.all([
      new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code) => resolve(code));
      }),
      new Promise((resolve) => {
        let output = "";
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (chunk) => { output += chunk; });
        child.stderr.once("end", () => resolve(output));
      }),
    ]);
    assert.equal(exitCode, 91, stderr);
    assert.equal(await fs.readFile(path.join(outputDir, "a.txt"), "utf8"), "crashed-a");
    await assert.rejects(fs.access(path.join(outputDir, "b.txt")), { code: "ENOENT" });
    assert.equal(await fs.readFile(path.join(outputDir, "new.txt"), "utf8"), "partial-new");
    await fs.access(path.join(outputDir, ".compose-publish.lock"));

    await fs.mkdir(nextStageDir, { recursive: true });
    await fs.writeFile(path.join(nextStageDir, "next.txt"), "next");
    await publishStagedOutputs({
      stageDir: nextStageDir,
      outputDir,
      files: ["next.txt"],
    });

    assert.equal(await fs.readFile(path.join(outputDir, "a.txt"), "utf8"), "old-a");
    assert.equal(await fs.readFile(path.join(outputDir, "b.txt"), "utf8"), "old-b");
    await assert.rejects(fs.access(path.join(outputDir, "new.txt")), { code: "ENOENT" });
    assert.equal(await fs.readFile(path.join(outputDir, "next.txt"), "utf8"), "next");
    await assert.rejects(fs.access(crashedStageDir), { code: "ENOENT" });
    await assert.rejects(fs.access(path.join(outputDir, ".compose-publish.lock")), { code: "ENOENT" });
    assert.deepEqual(
      (await fs.readdir(outputDir)).filter((entry) => entry.startsWith(".compose-publish.transaction-")),
      [],
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a partial lock-metadata write cannot permanently claim publication ownership", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "demo-publish-partial-lock-"));
  const outputDir = path.join(root, "output");
  const stageDir = path.join(outputDir, ".stage");
  try {
    await fs.mkdir(stageDir, { recursive: true });
    await fs.writeFile(path.join(stageDir, "a.txt"), "new-a");
    const moduleUrl = new URL("../../scripts/compose/index.mjs", import.meta.url).href;
    const childSource = `
      import fs from "node:fs/promises";
      import path from "node:path";
      import { publishStagedOutputs } from ${JSON.stringify(moduleUrl)};
      const outputDir = ${JSON.stringify(outputDir)};
      const stageDir = ${JSON.stringify(stageDir)};
      const operations = new Proxy(fs, {
        get(target, property) {
          if (property !== "open") return target[property];
          return async (file, ...args) => {
            const handle = await fs.open(file, ...args);
            if (!path.basename(file).startsWith(".compose-publish.lock")) return handle;
            return new Proxy(handle, {
              get(handleTarget, handleProperty) {
                if (handleProperty === "writeFile") {
                  return async (value) => {
                    await handleTarget.write(String(value).slice(0, 12));
                    process.exit(92);
                  };
                }
                const member = handleTarget[handleProperty];
                return typeof member === "function" ? member.bind(handleTarget) : member;
              },
            });
          };
        },
      });
      await publishStagedOutputs({ stageDir, outputDir, files: ["a.txt"], operations });
    `;
    const child = spawn(process.execPath, ["--input-type=module", "-e", childSource]);
    const exitCode = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    });
    assert.equal(exitCode, 92);

    await publishStagedOutputs({ stageDir, outputDir, files: ["a.txt"] });
    assert.equal(await fs.readFile(path.join(outputDir, "a.txt"), "utf8"), "new-a");
    assert.deepEqual(
      (await fs.readdir(outputDir)).filter((entry) => entry.startsWith(".compose-publish.")),
      [],
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a partial journal write is ignored safely after its owner crashes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "demo-publish-partial-journal-"));
  const outputDir = path.join(root, "output");
  const crashedStageDir = path.join(outputDir, ".crashed-stage");
  const nextStageDir = path.join(outputDir, ".next-stage");
  try {
    await fs.mkdir(crashedStageDir, { recursive: true });
    await fs.writeFile(path.join(crashedStageDir, "a.txt"), "new-a");
    const moduleUrl = new URL("../../scripts/compose/index.mjs", import.meta.url).href;
    const childSource = `
      import fs from "node:fs/promises";
      import path from "node:path";
      import { publishStagedOutputs } from ${JSON.stringify(moduleUrl)};
      const outputDir = ${JSON.stringify(outputDir)};
      const stageDir = ${JSON.stringify(crashedStageDir)};
      const operations = new Proxy(fs, {
        get(target, property) {
          if (property !== "open") return target[property];
          return async (file, ...args) => {
            const handle = await fs.open(file, ...args);
            if (!path.basename(file).startsWith(".compose-publish.transaction-")) return handle;
            return new Proxy(handle, {
              get(handleTarget, handleProperty) {
                if (handleProperty === "writeFile") {
                  return async (value) => {
                    await handleTarget.write(String(value).slice(0, 12));
                    process.exit(93);
                  };
                }
                const member = handleTarget[handleProperty];
                return typeof member === "function" ? member.bind(handleTarget) : member;
              },
            });
          };
        },
      });
      await publishStagedOutputs({ stageDir, outputDir, files: ["a.txt"], operations });
    `;
    const child = spawn(process.execPath, ["--input-type=module", "-e", childSource]);
    const exitCode = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    });
    assert.equal(exitCode, 93);

    await fs.mkdir(nextStageDir);
    await fs.writeFile(path.join(nextStageDir, "next.txt"), "next");
    await publishStagedOutputs({ stageDir: nextStageDir, outputDir, files: ["next.txt"] });
    assert.equal(await fs.readFile(path.join(outputDir, "next.txt"), "utf8"), "next");
    assert.deepEqual(
      (await fs.readdir(outputDir)).filter((entry) => entry.startsWith(".compose-publish.")),
      [],
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test(
  "compose preserves an incompletely rolled-back stage until the next publication recovers it",
  { skip: mediaToolsAvailable ? false : "ffmpeg with libass and libx264 is not installed" },
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "demo-compose-recovery-"));
    const outputDir = path.join(root, "output");
    const rawDir = path.join(outputDir, "raw");
    const source = path.join(rawDir, "browser.mp4");
    const baseline = new Map(publicOutputs.map((relative) => [relative, `baseline-${relative}`]));
    try {
      await fs.mkdir(rawDir, { recursive: true });
      await runCommand("ffmpeg", [
        "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=30:duration=0.25",
        "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", source,
      ]);
      let baselineSeeded = false;
      let publishFailed = false;
      let rollbackFailed = false;
      let lockCloseFailed = false;
      const publicationOperations = new Proxy(fs, {
        get(target, property) {
          if (property === "open") {
            return async (file, ...args) => {
              const isLockStage = path.basename(file).startsWith(".compose-publish.lock.stage-");
              if (!baselineSeeded && isLockStage) {
                await Promise.all(
                  [...baseline].map(([relative, contents]) => fs.writeFile(path.join(outputDir, relative), contents)),
                );
                baselineSeeded = true;
              }
              const handle = await fs.open(file, ...args);
              if (!isLockStage) return handle;
              return new Proxy(handle, {
                get(handleTarget, handleProperty) {
                  if (handleProperty === "close") {
                    return async () => {
                      await handleTarget.close();
                      lockCloseFailed = true;
                      throw new Error("injected lock close failure");
                    };
                  }
                  const value = handleTarget[handleProperty];
                  return typeof value === "function" ? value.bind(handleTarget) : value;
                },
              });
            };
          }
          if (property !== "rename") return target[property];
          return async (from, to) => {
            if (!publishFailed
              && path.basename(from) === "captions.srt"
              && path.dirname(from).startsWith(path.join(outputDir, ".compose-stage-"))
              && to === path.join(outputDir, "captions.srt")) {
              publishFailed = true;
              throw new Error("injected compose publication failure");
            }
            if (publishFailed
              && !rollbackFailed
              && from.includes(`${path.sep}.publish-backup${path.sep}`)) {
              rollbackFailed = true;
              throw new Error("injected compose rollback failure");
            }
            return fs.rename(from, to);
          };
        },
      });

      let compositionFailure;
      await assert.rejects(
        composeScenario({
          scenario: {
            version: 1,
            id: "transaction-recovery",
            title: "Transaction recovery",
            fps: 30,
            canvas: { master: "1080p", derivative: "720p" },
            layout: { preset: "browser-full" },
            production: { transitionMilliseconds: 0, silent: true },
            story: [{ type: "browser", durationSeconds: 0.25 }],
            acp: { project: "demo-transaction-recovery" },
          },
          scenarioPath: path.join(root, "scenario.yaml"),
          scenarioDir: root,
          outputDir,
          manifest: { artifacts: { browserCapture: "raw/browser.mp4" } },
          publicationOperations,
        }),
        (error) => {
          compositionFailure = error;
          return true;
        },
      );
      const errorMessages = [];
      const collectErrorMessages = (error) => {
        errorMessages.push(error.message);
        for (const nested of error.errors ?? []) collectErrorMessages(nested);
      };
      collectErrorMessages(compositionFailure);
      assert.match(errorMessages.join("\n"), /injected compose publication failure/);
      assert.match(errorMessages.join("\n"), /injected compose rollback failure/);
      assert.match(errorMessages.join("\n"), /injected lock close failure/);
      assert.equal(baselineSeeded, true);
      assert.equal(publishFailed, true);
      assert.equal(rollbackFailed, true);
      assert.equal(lockCloseFailed, true);
      const retainedEntries = await fs.readdir(outputDir);
      assert.equal(
        retainedEntries.filter((entry) => entry.startsWith(".compose-stage-")).length,
        1,
      );
      assert.equal(
        retainedEntries.filter((entry) => entry.startsWith(".compose-publish.transaction-")).length,
        1,
      );
      assert.equal(
        retainedEntries.filter((entry) => entry.startsWith(".compose-publish.recovery-")).length,
        1,
      );
      await assert.rejects(
        fs.access(path.join(outputDir, ".compose-publish.lock")),
        { code: "ENOENT" },
      );

      const nextStage = path.join(outputDir, ".next-stage");
      await fs.mkdir(nextStage);
      await fs.writeFile(path.join(nextStage, "next.txt"), "next");
      await publishStagedOutputs({ stageDir: nextStage, outputDir, files: ["next.txt"] });

      for (const [relative, contents] of baseline) {
        assert.equal(await fs.readFile(path.join(outputDir, relative), "utf8"), contents);
      }
      assert.equal(await fs.readFile(path.join(outputDir, "next.txt"), "utf8"), "next");
      assert.equal(
        (await fs.readdir(outputDir)).some((entry) => entry.startsWith(".compose-stage-")),
        false,
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);

test("publication recovers a stale owner when its PID has been reused", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "demo-publish-reused-pid-"));
  const outputDir = path.join(root, "output");
  const stageDir = path.join(outputDir, ".stage");
  const lockPath = path.join(outputDir, ".compose-publish.lock");
  try {
    await fs.mkdir(stageDir, { recursive: true });
    await fs.writeFile(path.join(stageDir, "a.txt"), "new-a");
    await fs.writeFile(lockPath, `${JSON.stringify({
      schemaVersion: 1,
      pid: process.pid,
      processStartIdentity: "previous-process-start",
      token: "previous-publisher",
      journal: ".compose-publish.transaction-previous-publisher.json",
    })}\n`);
    await publishStagedOutputs({
      stageDir,
      outputDir,
      files: ["a.txt"],
      inspectProcess: async (pid) => ({
        pid,
        processStartIdentity: "current-process-start",
        alive: true,
      }),
    });
    assert.equal(await fs.readFile(path.join(outputDir, "a.txt"), "utf8"), "new-a");
    await assert.rejects(fs.access(lockPath), { code: "ENOENT" });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("publication refuses to overlap an owner with the exact live process identity", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "demo-publish-lock-"));
  const outputDir = path.join(root, "output");
  const stageDir = path.join(outputDir, ".stage");
  const lockPath = path.join(outputDir, ".compose-publish.lock");
  try {
    await fs.mkdir(stageDir, { recursive: true });
    await fs.writeFile(path.join(stageDir, "a.txt"), "new-a");
    await fs.writeFile(lockPath, `${JSON.stringify({
      schemaVersion: 1,
      pid: process.pid,
      processStartIdentity: "active-process-start",
      token: "other-publisher",
      journal: ".compose-publish.transaction-other-publisher.json",
    })}\n`);
    await assert.rejects(
      publishStagedOutputs({
        stageDir,
        outputDir,
        files: ["a.txt"],
        inspectProcess: async (pid) => ({
          pid,
          processStartIdentity: "active-process-start",
          alive: true,
        }),
      }),
      /another composition publication is active/,
    );
    await fs.access(path.join(stageDir, "a.txt"));
    await assert.rejects(fs.access(path.join(outputDir, "a.txt")), { code: "ENOENT" });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("publication fails closed on a stale lock instead of racing its replacement", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "demo-publish-stale-lock-"));
  const outputDir = path.join(root, "output");
  const stageDir = path.join(outputDir, ".stage");
  const lockPath = path.join(outputDir, ".compose-publish.lock");
  try {
    await fs.mkdir(stageDir, { recursive: true });
    await fs.writeFile(path.join(stageDir, "a.txt"), "new-a");
    await fs.writeFile(lockPath, `${JSON.stringify({ pid: 2_147_483_647, token: "stale-publisher" })}\n`);
    await assert.rejects(
      publishStagedOutputs({ stageDir, outputDir, files: ["a.txt"] }),
      /another composition publication is active/,
    );
    await fs.access(lockPath);
    await assert.rejects(fs.access(path.join(outputDir, "a.txt")), { code: "ENOENT" });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("publication removes its own lock if lock metadata cannot be written", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "demo-publish-lock-write-"));
  const outputDir = path.join(root, "output");
  const stageDir = path.join(outputDir, ".stage");
  const lockPath = path.join(outputDir, ".compose-publish.lock");
  try {
    await fs.mkdir(stageDir, { recursive: true });
    await fs.writeFile(path.join(stageDir, "a.txt"), "new-a");
    const operations = new Proxy(fs, {
      get(target, property) {
        if (property !== "open") return target[property];
        return async (...args) => {
          const handle = await fs.open(...args);
          return new Proxy(handle, {
            get(handleTarget, handleProperty) {
              if (handleProperty === "writeFile") return async () => { throw new Error("injected lock write failure"); };
              const value = handleTarget[handleProperty];
              return typeof value === "function" ? value.bind(handleTarget) : value;
            },
          });
        };
      },
    });
    await assert.rejects(
      publishStagedOutputs({ stageDir, outputDir, files: ["a.txt"], operations }),
      /injected lock write failure/,
    );
    await assert.rejects(fs.access(lockPath), { code: "ENOENT" });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
