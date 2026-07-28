import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createAndroidArtifactOperations,
  prepareAndroidRunDirectories,
} from "../../../scripts/capture/android/artifact-operations.mjs";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function privateFixture(context, prefix = "android-artifacts-") {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), prefix)));
  const outputDir = path.join(root, "output");
  await mkdir(outputDir, { mode: 0o700 });
  context.after(() => rm(root, { recursive: true, force: true }));
  return { root, outputDir };
}

test("writes canonical normalized pointer events as a private exclusive JSONL artifact", async (context) => {
  const { outputDir } = await privateFixture(context);
  const outputPath = path.join(outputDir, "pointer-events.jsonl");
  const events = [
    { type: "click", time: 0, x: 0.25, y: 0.5 },
    { type: "click", time: 1.25, x: 1, y: 0 },
  ];

  const operations = createAndroidArtifactOperations();
  const artifact = await operations.writeAndroidPointerEvents({ events, outputPath });
  const expected = `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;

  assert.deepEqual(artifact, { path: outputPath, sha256: sha256(expected) });
  assert.equal(await readFile(outputPath, "utf8"), expected);
  assert.equal((await stat(outputPath)).mode & 0o777, 0o600);
  assert.equal(Object.isFrozen(operations), true);
});

test("accepts an empty pointer event stream", async (context) => {
  const { outputDir } = await privateFixture(context);
  const outputPath = path.join(outputDir, "pointer-events.jsonl");

  const artifact = await createAndroidArtifactOperations()
    .writeAndroidPointerEvents({ events: [], outputPath });

  assert.equal(await readFile(outputPath, "utf8"), "");
  assert.deepEqual(artifact, { path: outputPath, sha256: sha256("") });
});

test("rejects noncanonical, nonfinite, unnormalized, nonmonotonic, or unbounded pointer events", async (context) => {
  const cases = [
    ["not an array", null],
    ["wrong type", [{ type: "tap", time: 0, x: 0.5, y: 0.5 }]],
    ["extra field", [{ type: "click", time: 0, x: 0.5, y: 0.5, text: "secret" }]],
    ["missing field", [{ type: "click", time: 0, x: 0.5 }]],
    ["nonfinite time", [{ type: "click", time: Number.NaN, x: 0.5, y: 0.5 }]],
    ["negative time", [{ type: "click", time: -0.1, x: 0.5, y: 0.5 }]],
    ["overlong time", [{ type: "click", time: 180.001, x: 0.5, y: 0.5 }]],
    ["nonfinite coordinate", [{ type: "click", time: 0, x: Infinity, y: 0.5 }]],
    ["negative coordinate", [{ type: "click", time: 0, x: -0.01, y: 0.5 }]],
    ["oversized coordinate", [{ type: "click", time: 0, x: 0.5, y: 1.01 }]],
    ["decreasing time", [
      { type: "click", time: 1, x: 0.5, y: 0.5 },
      { type: "click", time: 0.5, x: 0.5, y: 0.5 },
    ]],
    ["too many events", Array.from({ length: 10_001 }, (_, index) => ({
      type: "click",
      time: index / 100,
      x: 0.5,
      y: 0.5,
    }))],
  ];
  const operations = createAndroidArtifactOperations();

  for (const [name, events] of cases) {
    const outputPath = path.join((await privateFixture(context, `android-pointer-${name.replaceAll(" ", "-")}-`)).outputDir, "pointer-events.jsonl");
    await assert.rejects(
      operations.writeAndroidPointerEvents({ events, outputPath }),
      /pointer event/i,
      name,
    );
    await assert.rejects(stat(outputPath), { code: "ENOENT" }, name);
  }
});

test("refuses pointer destination collisions and symlink aliases without changing existing data", async (context) => {
  const { root, outputDir } = await privateFixture(context);
  const outputPath = path.join(outputDir, "pointer-events.jsonl");
  const victim = path.join(root, "victim");
  await writeFile(outputPath, "existing", { mode: 0o600 });
  await writeFile(victim, "victim", { mode: 0o600 });

  const operations = createAndroidArtifactOperations();
  await assert.rejects(
    operations.writeAndroidPointerEvents({
      events: [{ type: "click", time: 0, x: 0.5, y: 0.5 }],
      outputPath,
    }),
    /exist|refus/i,
  );
  assert.equal(await readFile(outputPath, "utf8"), "existing");

  await rm(outputPath);
  await symlink(victim, outputPath);
  await assert.rejects(
    operations.writeAndroidPointerEvents({
      events: [{ type: "click", time: 0, x: 0.5, y: 0.5 }],
      outputPath,
    }),
    /exist|symlink|refus/i,
  );
  assert.equal(await readFile(victim, "utf8"), "victim");
});

test("requires the exact pointer filename beneath a canonical output parent", async (context) => {
  const { root, outputDir } = await privateFixture(context);
  const alias = path.join(root, "output-alias");
  await symlink(outputDir, alias);
  const operations = createAndroidArtifactOperations();
  const events = [{ type: "click", time: 0, x: 0.5, y: 0.5 }];

  await assert.rejects(
    operations.writeAndroidPointerEvents({ events, outputPath: path.join(outputDir, "other.jsonl") }),
    /pointer-events\.jsonl/,
  );
  await assert.rejects(
    operations.writeAndroidPointerEvents({ events, outputPath: path.join(alias, "pointer-events.jsonl") }),
    /canonical|symlink/,
  );
});

test("refuses pointer parent path swaps and removes interrupted private staging files", async (context) => {
  const { outputDir } = await privateFixture(context, "android-pointer-race-");
  const outputPath = path.join(outputDir, "pointer-events.jsonl");
  const events = [{ type: "click", time: 0, x: 0.5, y: 0.5 }];
  const nodeFilesystem = await import("node:fs/promises");
  let parentChecks = 0;
  const swappingFs = {
    ...nodeFilesystem,
    async realpath(requestedPath) {
      if (requestedPath === outputDir && ++parentChecks > 1) return `${outputDir}-swapped`;
      return nodeFilesystem.realpath(requestedPath);
    },
  };
  await assert.rejects(
    createAndroidArtifactOperations({ fs: swappingFs })
      .writeAndroidPointerEvents({ events, outputPath }),
    /canonical|symlink/,
  );
  await assert.rejects(stat(outputPath), { code: "ENOENT" });
  assert.deepEqual(await readdir(outputDir), []);

  const interruptedFs = {
    ...nodeFilesystem,
    async open(requestedPath, ...args) {
      const handle = await nodeFilesystem.open(requestedPath, ...args);
      if (!path.basename(requestedPath).includes("pointer-events.jsonl")) return handle;
      return {
        ...handle,
        chmod: handle.chmod.bind(handle),
        close: handle.close.bind(handle),
        stat: handle.stat.bind(handle),
        sync: handle.sync.bind(handle),
        async writeFile(bytes) {
          await handle.writeFile(bytes);
          throw new Error("simulated interrupted write");
        },
      };
    },
  };
  await assert.rejects(
    createAndroidArtifactOperations({ fs: interruptedFs })
      .writeAndroidPointerEvents({ events, outputPath }),
    /simulated interrupted write/,
  );
  await assert.rejects(stat(outputPath), { code: "ENOENT" });
  assert.deepEqual(await readdir(outputDir), []);
});

test("copies verified repo lock evidence to an exact private atomic artifact", async (context) => {
  const { root, outputDir } = await privateFixture(context, "android-lock-");
  const repoRoot = path.join(root, "repo");
  const sourceDir = path.join(repoRoot, "artifacts");
  const rawOutputDir = path.join(outputDir, "raw");
  const sourcePath = path.join(sourceDir, "mobile.apk.lock.json");
  const outputPath = path.join(rawOutputDir, "android-apk-lock.json");
  const bytes = Buffer.from('{"schemaVersion":1,"apk":{"sha256":"locked"}}\n');
  await mkdir(sourceDir, { recursive: true, mode: 0o700 });
  await mkdir(rawOutputDir, { mode: 0o700 });
  await writeFile(sourcePath, bytes, { mode: 0o600 });

  const artifact = await createAndroidArtifactOperations().copyAndroidApkLockEvidence({
    repoRoot,
    sourceRef: "repo:artifacts/mobile.apk.lock.json",
    expectedSha256: sha256(bytes),
    outputPath,
  });

  assert.deepEqual(artifact, { path: outputPath, sha256: sha256(bytes) });
  assert.deepEqual(await readFile(outputPath), bytes);
  assert.equal((await stat(outputPath)).mode & 0o777, 0o600);
});

test("rejects malformed repo references, digest mismatches, and source or output symlinks", async (context) => {
  const malformedRefs = [
    "/absolute/lock.json",
    "repo:/absolute/lock.json",
    "repo:../lock.json",
    "repo:artifacts/../lock.json",
    "repo:artifacts//lock.json",
    "repo:artifacts\\lock.json",
    "repo:artifacts/lock.json:alternate",
  ];
  for (const [index, sourceRef] of malformedRefs.entries()) {
    const { root, outputDir } = await privateFixture(context, `android-lock-ref-${index}-`);
    const repoRoot = path.join(root, "repo");
    const rawOutputDir = path.join(outputDir, "raw");
    await mkdir(repoRoot, { mode: 0o700 });
    await mkdir(rawOutputDir, { mode: 0o700 });
    await assert.rejects(
      createAndroidArtifactOperations().copyAndroidApkLockEvidence({
        repoRoot,
        sourceRef,
        expectedSha256: "a".repeat(64),
        outputPath: path.join(rawOutputDir, "android-apk-lock.json"),
      }),
      /repo: reference|sourceRef/i,
      sourceRef,
    );
  }

  const { root, outputDir } = await privateFixture(context, "android-lock-attacks-");
  const repoRoot = path.join(root, "repo");
  const sourceDir = path.join(repoRoot, "artifacts");
  const rawOutputDir = path.join(outputDir, "raw");
  const realSource = path.join(root, "real-lock.json");
  const sourcePath = path.join(sourceDir, "mobile.apk.lock.json");
  const outputPath = path.join(rawOutputDir, "android-apk-lock.json");
  await mkdir(sourceDir, { recursive: true, mode: 0o700 });
  await mkdir(rawOutputDir, { mode: 0o700 });
  await writeFile(realSource, "locked", { mode: 0o600 });
  await symlink(realSource, sourcePath);
  await assert.rejects(
    createAndroidArtifactOperations().copyAndroidApkLockEvidence({
      repoRoot,
      sourceRef: "repo:artifacts/mobile.apk.lock.json",
      expectedSha256: sha256("locked"),
      outputPath,
    }),
    /symlink|exact/,
  );

  await rm(sourcePath);
  await writeFile(sourcePath, "locked", { mode: 0o600 });
  await assert.rejects(
    createAndroidArtifactOperations().copyAndroidApkLockEvidence({
      repoRoot,
      sourceRef: "repo:artifacts/mobile.apk.lock.json",
      expectedSha256: "b".repeat(64),
      outputPath,
    }),
    /SHA-256.*expectedSha256/i,
  );

  const victim = path.join(root, "victim");
  await writeFile(victim, "victim", { mode: 0o600 });
  await symlink(victim, outputPath);
  await assert.rejects(
    createAndroidArtifactOperations().copyAndroidApkLockEvidence({
      repoRoot,
      sourceRef: "repo:artifacts/mobile.apk.lock.json",
      expectedSha256: sha256("locked"),
      outputPath,
    }),
    /exist|symlink|refus/i,
  );
  assert.equal(await readFile(victim, "utf8"), "victim");
});

test("does not publish when the source or canonical output parent changes during copy", async (context) => {
  const { root, outputDir } = await privateFixture(context, "android-lock-races-");
  const repoRoot = path.join(root, "repo");
  const sourceDir = path.join(repoRoot, "artifacts");
  const rawOutputDir = path.join(outputDir, "raw");
  const sourcePath = path.join(sourceDir, "mobile.apk.lock.json");
  const outputPath = path.join(rawOutputDir, "android-apk-lock.json");
  await mkdir(sourceDir, { recursive: true, mode: 0o700 });
  await mkdir(rawOutputDir, { mode: 0o700 });
  await writeFile(sourcePath, "locked", { mode: 0o600 });

  let sourceOpens = 0;
  const sourceChangingFs = {
    ...await import("node:fs/promises"),
    async open(requestedPath, ...args) {
      if (requestedPath === sourcePath && ++sourceOpens === 2) {
        await writeFile(sourcePath, "changed", { mode: 0o600 });
      }
      return (await import("node:fs/promises")).open(requestedPath, ...args);
    },
  };
  await assert.rejects(
    createAndroidArtifactOperations({ fs: sourceChangingFs }).copyAndroidApkLockEvidence({
      repoRoot,
      sourceRef: "repo:artifacts/mobile.apk.lock.json",
      expectedSha256: sha256("locked"),
      outputPath,
    }),
    /changed while copying/,
  );
  await assert.rejects(stat(outputPath), { code: "ENOENT" });
  assert.deepEqual(await readdir(rawOutputDir), []);

  await writeFile(sourcePath, "locked", { mode: 0o600 });
  let outputParentChecks = 0;
  const pathChangingFs = {
    ...await import("node:fs/promises"),
    async realpath(requestedPath) {
      if (requestedPath === rawOutputDir && ++outputParentChecks > 1) {
        return `${rawOutputDir}-swapped`;
      }
      return (await import("node:fs/promises")).realpath(requestedPath);
    },
  };
  await assert.rejects(
    createAndroidArtifactOperations({ fs: pathChangingFs }).copyAndroidApkLockEvidence({
      repoRoot,
      sourceRef: "repo:artifacts/mobile.apk.lock.json",
      expectedSha256: sha256("locked"),
      outputPath,
    }),
    /canonical|symlink/,
  );
  await assert.rejects(stat(outputPath), { code: "ENOENT" });
  assert.deepEqual(await readdir(rawOutputDir), []);
});

test("uses the injected hash function for artifact digests", async (context) => {
  const { outputDir } = await privateFixture(context, "android-hash-");
  const outputPath = path.join(outputDir, "pointer-events.jsonl");
  let hashed;
  const expected = "c".repeat(64);

  const artifact = await createAndroidArtifactOperations({
    hash(bytes) {
      hashed = bytes;
      return expected;
    },
  }).writeAndroidPointerEvents({ events: [], outputPath });

  assert.equal(hashed, "");
  assert.deepEqual(artifact, { path: outputPath, sha256: expected });
});

test("refuses an invalid injected pointer digest before publishing", async (context) => {
  const { outputDir } = await privateFixture(context, "android-invalid-hash-");
  const outputPath = path.join(outputDir, "pointer-events.jsonl");

  await assert.rejects(
    createAndroidArtifactOperations({ hash: () => "invalid" })
      .writeAndroidPointerEvents({ events: [], outputPath }),
    /SHA-256 digest/,
  );

  await assert.rejects(stat(outputPath), { code: "ENOENT" });
  assert.deepEqual(await readdir(outputDir), []);
});

test("prepares canonical private Android run directories without replacing secure roots", async (context) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "android-directories-")));
  const markerRoot = path.join(root, "run");
  const outputDir = path.join(root, "output");
  await mkdir(markerRoot, { mode: 0o700 });
  await mkdir(outputDir, { mode: 0o700 });
  context.after(() => rm(root, { recursive: true, force: true }));

  const prepared = await prepareAndroidRunDirectories({ markerRoot, outputDir });

  assert.deepEqual(prepared, {
    markerRoot,
    avdRoot: path.join(markerRoot, "avds"),
    homeRoot: path.join(markerRoot, "home"),
    tmpRoot: path.join(markerRoot, "tmp"),
    xdgConfigRoot: path.join(markerRoot, "xdg-config"),
    xdgRuntimeRoot: path.join(markerRoot, "xdg-runtime"),
    kindStateRoot: path.join(markerRoot, "kind-state"),
    kindLegacyRoot: path.join(markerRoot, "kind-state", "legacy"),
    outputDir,
    rawOutputDir: path.join(outputDir, "raw"),
    stagingParent: outputDir,
  });
  assert.equal(Object.isFrozen(prepared), true);
  for (const directory of Object.values(prepared)) {
    assert.equal(await realpath(directory), directory);
    assert.equal((await stat(directory)).isDirectory(), true);
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
  }

  assert.deepEqual(await prepareAndroidRunDirectories({ markerRoot, outputDir }), prepared);
});

test("creates absent run roots and children with private modes", async (context) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "android-directory-create-")));
  const markerRoot = path.join(root, "run");
  const outputDir = path.join(root, "output");
  context.after(() => rm(root, { recursive: true, force: true }));

  await prepareAndroidRunDirectories({ markerRoot, outputDir });

  for (const directory of [
    markerRoot,
    path.join(markerRoot, "avds"),
    path.join(markerRoot, "home"),
    path.join(markerRoot, "tmp"),
    path.join(markerRoot, "xdg-config"),
    path.join(markerRoot, "xdg-runtime"),
    path.join(markerRoot, "kind-state"),
    path.join(markerRoot, "kind-state", "legacy"),
    outputDir,
    path.join(outputDir, "raw"),
  ]) {
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    assert.equal(await realpath(directory), directory);
  }
});

test("refuses insecure, foreign-shaped, or symlinked preexisting run paths", async (context) => {
  const { root } = await privateFixture(context, "android-directory-attacks-");
  const cases = [
    async () => {
      const markerRoot = path.join(root, "public-marker");
      const outputDir = path.join(root, "public-output");
      await mkdir(markerRoot, { mode: 0o700 });
      await mkdir(outputDir, { mode: 0o700 });
      await chmod(markerRoot, 0o755);
      return { markerRoot, outputDir };
    },
    async () => {
      const target = path.join(root, "marker-target");
      const markerRoot = path.join(root, "marker-alias");
      const outputDir = path.join(root, "symlink-output");
      await mkdir(target, { mode: 0o700 });
      await symlink(target, markerRoot);
      await mkdir(outputDir, { mode: 0o700 });
      return { markerRoot, outputDir };
    },
    async () => {
      const markerRoot = path.join(root, "file-child-marker");
      const outputDir = path.join(root, "file-child-output");
      await mkdir(markerRoot, { mode: 0o700 });
      await mkdir(outputDir, { mode: 0o700 });
      await writeFile(path.join(markerRoot, "avds"), "foreign", { mode: 0o600 });
      return { markerRoot, outputDir };
    },
  ];

  for (const arrange of cases) {
    await assert.rejects(prepareAndroidRunDirectories(await arrange()), /0700|symlink|directory/i);
  }
  await assert.rejects(
    prepareAndroidRunDirectories({ markerRoot: "relative", outputDir: path.join(root, "unused") }),
    /normalized absolute path/,
  );
});

test("rolls back only newly created children when a directory path changes during preparation", async (context) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "android-directory-race-")));
  const markerRoot = path.join(root, "run");
  const outputDir = path.join(root, "output");
  await mkdir(markerRoot, { mode: 0o700 });
  await mkdir(outputDir, { mode: 0o700 });
  context.after(() => rm(root, { recursive: true, force: true }));
  let outputChecks = 0;
  const swappingFs = {
    ...await import("node:fs/promises"),
    async realpath(requestedPath) {
      if (requestedPath === outputDir && ++outputChecks > 1) return `${outputDir}-swapped`;
      return (await import("node:fs/promises")).realpath(requestedPath);
    },
  };

  await assert.rejects(
    prepareAndroidRunDirectories({ markerRoot, outputDir, fs: swappingFs }),
    /canonical|symlink/,
  );

  assert.deepEqual(await readdir(markerRoot), []);
  assert.deepEqual(await readdir(outputDir), []);
});
