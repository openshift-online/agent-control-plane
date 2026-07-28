import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createOrVerifyManifest, mergeManifest, sha256, writeManifest } from "../../scripts/core/manifest.mjs";

const input = {
  scenario: { id: "manifest-example", fps: 30, canvas: { master: "1080p", derivative: "720p" } },
  source: "version: 1\n",
  scenarioPath: "/scenario/scenario.yaml",
  layouts: { "1080p": {}, "720p": {} },
  durationSeconds: 60,
};

test("manifest locks the scenario hash and merges artifact records atomically", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "demo-manifest-"));
  const manifestPath = path.join(directory, "manifest.lock.json");
  try {
    const manifest = await createOrVerifyManifest(manifestPath, input);
    assert.equal(manifest.scenarioSha256, sha256(input.source));
    await mergeManifest(manifestPath, { toolchain: { node: "v-test" } });
    await assert.rejects(() => mergeManifest(manifestPath, { toolchain: { node: "v-other" } }), /locked manifest field/);
    await mergeManifest(manifestPath, { artifacts: { master: "final-1080p.mp4" } });
    const stored = JSON.parse(await readFile(manifestPath, "utf8"));
    assert.equal(stored.artifacts.master, "final-1080p.mp4");
    await assert.rejects(() => mergeManifest(manifestPath, { token: "must-not-be-stored" }), /credential-like/);
    await assert.rejects(() => mergeManifest(manifestPath, { fps: 60 }), /locked manifest field/);
    await assert.rejects(() => createOrVerifyManifest(manifestPath, { ...input, source: "changed" }), /Scenario changed/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("concurrent manifest merges preserve every artifact", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "demo-manifest-concurrent-"));
  const manifestPath = path.join(directory, "manifest.lock.json");
  try {
    await createOrVerifyManifest(manifestPath, input);
    await Promise.all(Array.from({ length: 32 }, (_, index) => mergeManifest(manifestPath, {
      artifacts: { [`artifact${index}`]: `artifact-${index}.txt` },
    })));
    const stored = JSON.parse(await readFile(manifestPath, "utf8"));
    assert.equal(Object.keys(stored.artifacts).length, 32);
    for (let index = 0; index < 32; index += 1) {
      assert.equal(stored.artifacts[`artifact${index}`], `artifact-${index}.txt`);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("manifest verification rejects every changed immutable scenario field", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "demo-manifest-immutable-"));
  const manifestPath = path.join(directory, "manifest.lock.json");
  try {
    await createOrVerifyManifest(manifestPath, input);
    const changes = [
      { scenario: { ...input.scenario, id: "different-example" } },
      { source: "version: 2\n" },
      { scenario: { ...input.scenario, fps: 24 } },
      { durationSeconds: 61 },
      { layouts: { "1080p": { changed: true }, "720p": {} } },
    ];
    for (const change of changes) {
      await assert.rejects(() => createOrVerifyManifest(manifestPath, { ...input, ...change }), /Scenario changed/);
    }
    const tampered = JSON.parse(await readFile(manifestPath, "utf8"));
    tampered.ownership["acp.dev/demo-creator-owner"] = "someone-else";
    await writeManifest(manifestPath, tampered);
    await assert.rejects(() => createOrVerifyManifest(manifestPath, input), /ownership/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
