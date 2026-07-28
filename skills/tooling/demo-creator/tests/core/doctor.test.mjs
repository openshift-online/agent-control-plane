import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { findMediaTools, runDoctor, toolchainSnapshot } from "../../scripts/core/doctor.mjs";

const SENTINEL = "doctor-inheritance-sentinel-never-forward";
const PROBE = "kept-doctor-probe-value";

// A stand-in for every tool doctor probes (ffmpeg/ffprobe/tesseract/vhs/...).
// It records whichever caller-sensitive and benign variables it actually
// received, then prints output that satisfies commandCheck, supportsAss, and
// versionOf so the real exec sites in doctor.mjs run to completion.
const SHIM = [
  "#!/bin/sh",
  'if [ -n "$DEMO_DOCTOR_ENV_DUMP" ]; then',
  '  printf \'%s\\t%s\\t%s\\n\' "doctor-tool" "${ACP_BEARER_TOKEN:-<absent>}" "${DEMO_DOCTOR_ENV_PROBE:-<absent>}" >> "$DEMO_DOCTOR_ENV_DUMP"',
  "fi",
  "printf ' T.. ass              Render ASS/SSA subtitles onto input video\\n'",
  "printf 'shim version 9.9.9\\n'",
  "exit 0",
  "",
].join("\n");

async function withDoctorShim(run) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "demo-doctor-env-"));
  const shim = path.join(dir, "tool-shim");
  const dump = path.join(dir, "env-dump.tsv");
  await writeFile(shim, SHIM, { mode: 0o755 });
  const prior = {
    token: Object.prototype.hasOwnProperty.call(process.env, "ACP_BEARER_TOKEN")
      ? process.env.ACP_BEARER_TOKEN
      : undefined,
    probe: Object.prototype.hasOwnProperty.call(process.env, "DEMO_DOCTOR_ENV_PROBE")
      ? process.env.DEMO_DOCTOR_ENV_PROBE
      : undefined,
    dump: Object.prototype.hasOwnProperty.call(process.env, "DEMO_DOCTOR_ENV_DUMP")
      ? process.env.DEMO_DOCTOR_ENV_DUMP
      : undefined,
  };
  process.env.ACP_BEARER_TOKEN = SENTINEL;
  process.env.DEMO_DOCTOR_ENV_PROBE = PROBE;
  process.env.DEMO_DOCTOR_ENV_DUMP = dump;
  try {
    const records = async () => {
      const raw = await readFile(dump, "utf8").catch(() => "");
      return raw.split("\n").filter(Boolean).map((line) => {
        const [tool, token, probe] = line.split("\t");
        return { tool, token, probe };
      });
    };
    await run({ shim, records });
  } finally {
    for (const [name, value] of [
      ["ACP_BEARER_TOKEN", prior.token],
      ["DEMO_DOCTOR_ENV_PROBE", prior.probe],
      ["DEMO_DOCTOR_ENV_DUMP", prior.dump],
    ]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(dir, { recursive: true, force: true });
  }
}

function assertBoundary(records, minimum) {
  assert.ok(
    records.length >= minimum,
    `expected at least ${minimum} recorded subprocess env(s), saw ${records.length}`,
  );
  for (const record of records) {
    assert.equal(
      record.token,
      "<absent>",
      "ACP_BEARER_TOKEN must not reach a doctor probe subprocess",
    );
    assert.equal(
      record.probe,
      PROBE,
      "non-sensitive environment (PATH/HOME/tool vars) must still be inherited",
    );
  }
}

test("runDoctor does not leak ACP_BEARER_TOKEN into command-probe subprocesses", async () => {
  await withDoctorShim(async ({ shim, records }) => {
    // captureKind android-emulator skips browser checks, keeping this hermetic;
    // the media tools are forced to the shim so the real commandCheck (L11) and
    // ffmpegAssCheck/supportsAss (L38) exec sites run against it.
    await runDoctor("linux", {
      captureKind: "android-emulator",
      dependencies: { findMediaTools: async () => ({ ffmpeg: shim, ffprobe: shim }) },
    });
    assertBoundary(await records(), 1);
  });
});

test("findMediaTools does not leak ACP_BEARER_TOKEN into ffmpeg/ffprobe detection", async () => {
  await withDoctorShim(async ({ shim, records }) => {
    // Exercises supportsAss (L38) and the ffprobe pairing exec (L57).
    const result = await findMediaTools({ DEMO_FFMPEG: shim, DEMO_FFPROBE: shim });
    assert.equal(result.ffmpeg, shim, "shim ffmpeg must be selected (supportsAss ran)");
    assert.equal(result.ffprobe, shim, "shim ffprobe must be selected (ffprobe exec ran)");
    assertBoundary(await records(), 2);
  });
});

test("toolchainSnapshot does not leak ACP_BEARER_TOKEN into version probes", async () => {
  await withDoctorShim(async ({ shim, records }) => {
    // Exercises versionOf (L68) for both ffmpeg and ffprobe.
    const snapshot = await toolchainSnapshot({ ffmpeg: shim, ffprobe: shim });
    assert.equal(typeof snapshot.ffmpeg, "string");
    assert.equal(typeof snapshot.ffprobe, "string");
    assertBoundary(await records(), 2);
  });
});
