import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  parsePointerEvents,
  openDigestBoundArtifact,
  validateAndroidPointerEvents,
  verifyOpenArtifactUnchanged,
  verifyManifestArtifact,
} from "../../scripts/compose/artifact-integrity.mjs";

test("manifest artifact verification rejects a path inode swap after opening", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "demo-artifact-identity-"));
  const original = path.join(root, "mobile.mp4");
  const moved = path.join(root, "mobile-original.mp4");
  const snapshot = path.join(root, "snapshot.mp4");
  const bytes = Buffer.from("captured bytes");
  try {
    await fs.writeFile(original, bytes);
    await assert.rejects(
      verifyManifestArtifact({
        root,
        reference: "mobile.mp4",
        expectedSha256: createHash("sha256").update(bytes).digest("hex"),
        label: "mobileCapture",
        snapshotPath: snapshot,
        dependencies: {
          afterOpen: async () => {
            await fs.rename(original, moved);
            await fs.writeFile(original, "replacement bytes");
          },
        },
      }),
      /mobileCapture changed identity while it was verified/,
    );
    await assert.rejects(fs.access(snapshot), { code: "ENOENT" });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("digest-bound open descriptor rejects pathname substitution and restored-mtime mutation", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "demo-open-artifact-"));
  const file = path.join(root, "mobile.mp4");
  const moved = path.join(root, "mobile-original.mp4");
  const bytes = Buffer.from("verified descriptor bytes");
  let opened;
  let mutationOpened;
  try {
    await fs.writeFile(file, bytes, { mode: 0o600 });
    opened = await openDigestBoundArtifact(
      file,
      createHash("sha256").update(bytes).digest("hex"),
      "mobileCapture snapshot",
    );
    await fs.rename(file, moved);
    await fs.writeFile(file, "substituted pathname bytes");
    const fromDescriptor = await opened.handle.readFile();
    assert.deepEqual(fromDescriptor, bytes);
    await assert.rejects(
      verifyOpenArtifactUnchanged(opened, "mobileCapture snapshot"),
      /changed while it was consumed/,
    );
    await opened.handle.close();
    opened = undefined;

    const mutationFile = path.join(root, "mutation.mp4");
    await fs.writeFile(mutationFile, bytes);
    mutationOpened = await openDigestBoundArtifact(
      mutationFile,
      createHash("sha256").update(bytes).digest("hex"),
      "mutation snapshot",
    );
    const originalStat = await fs.stat(mutationFile);
    const writer = await fs.open(mutationFile, "r+");
    await writer.write(Buffer.from("X"), 0, 1, 0);
    await writer.close();
    await fs.utimes(mutationFile, originalStat.atime, originalStat.mtime);
    await assert.rejects(
      verifyOpenArtifactUnchanged(mutationOpened, "mutation snapshot"),
      /changed while it was consumed/,
    );
  } finally {
    if (opened) await opened.handle.close();
    if (mutationOpened) await mutationOpened.handle.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Android pointer artifacts require exact normalized click events", () => {
  assert.deepEqual(
    validateAndroidPointerEvents([{ type: "click", time: 0, x: 0.5, y: 1 }]),
    [{ type: "click", time: 0, x: 0.5, y: 1 }],
  );
  for (const event of [
    { type: "move", time: 0, x: 0.5, y: 0.5 },
    { type: "click", time: 0, x: 1.1, y: 0.5 },
    { type: "click", time: 0, x: 0.5, y: 0.5, private: true },
  ]) {
    assert.throws(() => validateAndroidPointerEvents([event]), /canonical normalized click/);
  }
});

test("pointer artifact parser rejects a JSON object without an events array", () => {
  assert.throws(
    () => parsePointerEvents('{"unexpected":true}'),
    /pointerEvents artifact must contain an event array/,
  );
});
