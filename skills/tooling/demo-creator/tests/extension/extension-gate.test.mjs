import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import {
  assertCaptureExtensionMatches,
  buildExtensionGate,
  verifyExtensionGate,
} from "../../scripts/extension/gate.mjs";
import {
  extensionIdFromManifest,
  STABLE_EXTENSION_ID,
} from "../../scripts/extension/extension-id.mjs";

const runFile = promisify(execFile);
const TEST_ROOT = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_ROOT, "../../../../..");
const COMPONENT_ROOT = path.join(REPO_ROOT, "components", "browser-extension");
const SKIP = existsSync(COMPONENT_ROOT)
  ? false
  : "components/browser-extension is not present in this repo; the extension gate is exercised in the consumer repo that ships the component";

function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

async function git(repoRoot, args) {
  const { stdout } = await runFile("git", ["-C", repoRoot, ...args], { encoding: "utf8" });
  return stdout.trim();
}

async function makeRepository() {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "demo-extension-gate-"));
  const target = path.join(repoRoot, "components", "browser-extension");
  await mkdir(path.dirname(target), { recursive: true });
  await cp(COMPONENT_ROOT, target, {
    recursive: true,
    filter: (source) => !["dist", "node_modules"].includes(path.basename(source)),
  });
  await git(repoRoot, ["init", "--quiet"]);
  await git(repoRoot, ["config", "user.name", "Extension Gate Test"]);
  await git(repoRoot, ["config", "user.email", "extension-gate@example.invalid"]);
  await git(repoRoot, ["add", "components/browser-extension"]);
  await git(repoRoot, ["commit", "--quiet", "-m", "test fixture"]);
  return repoRoot;
}

async function withRepository(run) {
  const repoRoot = await makeRepository();
  try {
    await run(repoRoot);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
}

test("manifest key derives the pinned browser extension identity", { skip: SKIP }, async () => {
  const manifest = JSON.parse(await readFile(path.join(COMPONENT_ROOT, "manifest.json"), "utf8"));
  assert.equal(extensionIdFromManifest(manifest), STABLE_EXTENSION_ID);
});

test("build emits a deterministic ZIP and commit-locked metadata", { skip: SKIP }, async () => {
  await withRepository(async (repoRoot) => {
    const first = await buildExtensionGate({
      repoRoot,
      outputRoot: path.join(repoRoot, "output-a"),
    });
    const second = await buildExtensionGate({
      repoRoot,
      outputRoot: path.join(repoRoot, "output-b"),
    });

    assert.deepEqual(await readFile(first.zipPath), await readFile(second.zipPath));
    assert.deepEqual(first.lock, second.lock);
    assert.equal(first.lock.source.commit, await git(repoRoot, ["rev-parse", "HEAD"]));
    assert.equal(
      first.lock.source.tree,
      await git(repoRoot, ["rev-parse", "HEAD:components/browser-extension"]),
    );
    assert.equal(first.lock.extension.id, STABLE_EXTENSION_ID);
    assert.match(first.lock.artifact.sha256, /^[0-9a-f]{64}$/);
    assert.ok(first.lock.files.some((entry) => entry.path === "manifest.json"));

    await verifyExtensionGate({ repoRoot, lockPath: first.lockPath });
    await assertCaptureExtensionMatches({
      repoRoot,
      lockPath: first.lockPath,
      extensionDir: first.unpackedPath,
    });
  });
});

test("verification compares mixed directory and file prefixes independent of traversal order", { skip: SKIP }, async () => {
  await withRepository(async (repoRoot) => {
    const extensionRoot = path.join(repoRoot, "components", "browser-extension");
    const contractPath = path.join(extensionRoot, "scripts", "package-contract.mjs");
    const contract = await readFile(contractPath, "utf8");
    const marker = '  "lib/kind-connections.js",';
    assert.ok(contract.includes(marker));
    await writeFile(contractPath, contract.replace(marker, `  "lib.js",\n${marker}`));
    await writeFile(path.join(extensionRoot, "lib.js"), "export const fixture = true;\n");
    await git(repoRoot, ["add", "components/browser-extension"]);
    await git(repoRoot, ["commit", "--quiet", "-m", "add mixed prefix fixture"]);

    const result = await buildExtensionGate({
      repoRoot,
      outputRoot: path.join(repoRoot, "output"),
    });
    const lockedPaths = result.lock.files.map((entry) => entry.path);
    assert.ok(lockedPaths.indexOf("lib.js") < lockedPaths.indexOf("lib/kind-connections.js"));
    await verifyExtensionGate({ repoRoot, lockPath: result.lockPath });
  });
});

test("capture check rejects an unpacked extension that differs from the lock", { skip: SKIP }, async () => {
  await withRepository(async (repoRoot) => {
    const result = await buildExtensionGate({ repoRoot, outputRoot: path.join(repoRoot, "output") });
    await writeFile(path.join(result.unpackedPath, "app.js"), "// changed after verification\n");

    await assert.rejects(
      assertCaptureExtensionMatches({
        repoRoot,
        lockPath: result.lockPath,
        extensionDir: result.unpackedPath,
      }),
      /unpacked extension file mismatch: app\.js/,
    );
  });
});

test("verification rejects ZIP bytes that differ from the lock", { skip: SKIP }, async () => {
  await withRepository(async (repoRoot) => {
    const result = await buildExtensionGate({ repoRoot, outputRoot: path.join(repoRoot, "output") });
    const zip = await readFile(result.zipPath);
    zip[zip.length - 1] ^= 0xff;
    await writeFile(result.zipPath, zip);

    await assert.rejects(
      verifyExtensionGate({ repoRoot, lockPath: result.lockPath }),
      /extension ZIP does not match the extension lock/,
    );
  });
});

test("verification rejects a replacement lock and artifact not rebuilt from committed source", { skip: SKIP }, async () => {
  await withRepository(async (repoRoot) => {
    const result = await buildExtensionGate({ repoRoot, outputRoot: path.join(repoRoot, "output") });
    const { createDeterministicZip, readDeterministicZip } = await import(
      path.join(repoRoot, "components", "browser-extension", "scripts", "zip-store.mjs")
    );
    const replacementData = Buffer.from("// internally consistent replacement artifact\n");
    const replacementEntries = readDeterministicZip(await readFile(result.zipPath)).map((entry) =>
      entry.name === "app.js" ? { ...entry, data: replacementData } : entry,
    );
    const replacementZip = createDeterministicZip(replacementEntries);
    await writeFile(result.zipPath, replacementZip);
    await writeFile(path.join(result.unpackedPath, "app.js"), replacementData);

    const replacementLock = structuredClone(result.lock);
    replacementLock.artifact.sha256 = sha256(replacementZip);
    replacementLock.artifact.sizeBytes = replacementZip.length;
    const replacementFile = replacementLock.files.find((entry) => entry.path === "app.js");
    replacementFile.sha256 = sha256(replacementData);
    replacementFile.sizeBytes = replacementData.length;
    await writeFile(result.lockPath, `${JSON.stringify(replacementLock, null, 2)}\n`);

    await assert.rejects(
      verifyExtensionGate({ repoRoot, lockPath: result.lockPath }),
      /not the deterministic package rebuilt from committed source/,
    );
  });
});

test("build refuses a browser extension source that is dirty", { skip: SKIP }, async () => {
  await withRepository(async (repoRoot) => {
    await writeFile(
      path.join(repoRoot, "components", "browser-extension", "app.js"),
      "// uncommitted source\n",
    );

    await assert.rejects(
      buildExtensionGate({ repoRoot, outputRoot: path.join(repoRoot, "output") }),
      /browser extension source does not match commit/,
    );
  });
});

test("build packages the committed snapshot and detects a concurrent worktree change", { skip: SKIP }, async () => {
  await withRepository(async (repoRoot) => {
    const extensionRoot = path.join(repoRoot, "components", "browser-extension");
    const appPath = path.join(extensionRoot, "app.js");
    const packageArtifactPath = path.join(extensionRoot, "scripts", "package-artifact.mjs");
    const committedApp = await readFile(appPath, "utf8");
    const racedApp = "// concurrent worktree replacement\n";
    const marker =
      "export async function buildArtifact({ sourceRoot, distRoot, requestedVersion }) {\n";
    const packageArtifact = await readFile(packageArtifactPath, "utf8");
    assert.ok(packageArtifact.includes(marker));
    await writeFile(
      packageArtifactPath,
      packageArtifact.replace(
        marker,
        `${marker}  await writeFile(${JSON.stringify(appPath)}, ${JSON.stringify(racedApp)});\n`,
      ),
    );
    await git(repoRoot, ["add", "components/browser-extension/scripts/package-artifact.mjs"]);
    await git(repoRoot, ["commit", "--quiet", "-m", "inject source race fixture"]);

    const outputRoot = path.join(repoRoot, "output");
    await assert.rejects(
      buildExtensionGate({ repoRoot, outputRoot }),
      /browser extension source does not match commit/,
    );

    assert.equal(await readFile(appPath, "utf8"), racedApp);
    assert.equal(
      await readFile(path.join(outputRoot, "artifact", "unpacked", "app.js"), "utf8"),
      committedApp,
    );
  });
});

test("build refuses a committed manifest whose key changes the stable identity", { skip: SKIP }, async () => {
  await withRepository(async (repoRoot) => {
    const manifestPath = path.join(repoRoot, "components", "browser-extension", "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const key = Buffer.from(manifest.key, "base64");
    key[key.length - 1] ^= 0x01;
    manifest.key = key.toString("base64");
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await git(repoRoot, ["add", "components/browser-extension/manifest.json"]);
    await git(repoRoot, ["commit", "--quiet", "-m", "change extension identity"]);

    await assert.rejects(
      buildExtensionGate({ repoRoot, outputRoot: path.join(repoRoot, "output") }),
      /extension identity mismatch/,
    );
  });
});

test("verification refuses reuse after the worktree advances to another commit", { skip: SKIP }, async () => {
  await withRepository(async (repoRoot) => {
    const result = await buildExtensionGate({ repoRoot, outputRoot: path.join(repoRoot, "output") });
    await writeFile(path.join(repoRoot, "README.md"), "next commit\n");
    await git(repoRoot, ["add", "README.md"]);
    await git(repoRoot, ["commit", "--quiet", "-m", "advance worktree"]);

    await assert.rejects(
      verifyExtensionGate({ repoRoot, lockPath: result.lockPath }),
      /extension lock source mismatch/,
    );
  });
});

// Self-contained (does not need the packaged browser-extension component): a
// minimal committed `components/browser-extension` tree lets buildExtensionGate
// run its git and tar exec sites before it fails on the absent manifest. PATH
// shims record whether each child actually received ACP_BEARER_TOKEN.
const GATE_SENTINEL = "gate-inheritance-sentinel-never-forward";
const GATE_PROBE = "kept-gate-probe-value";

async function realExecutable(name) {
  const { stdout } = await runFile("sh", ["-c", `command -v ${name}`], { encoding: "utf8" });
  const resolved = stdout.trim();
  if (!resolved) throw new Error(`${name} is required for the credential-boundary test`);
  return resolved;
}

function recordingShim(tag, realPath) {
  return [
    "#!/bin/sh",
    'if [ -n "$DEMO_GATE_ENV_DUMP" ]; then',
    `  printf '%s\\t%s\\t%s\\n' "${tag}" "\${ACP_BEARER_TOKEN:-<absent>}" "\${DEMO_GATE_ENV_PROBE:-<absent>}" >> "$DEMO_GATE_ENV_DUMP"`,
    "fi",
    `exec "${realPath}" "$@"`,
    "",
  ].join("\n");
}

test("build does not leak ACP_BEARER_TOKEN into git or tar subprocesses", async () => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "demo-gate-env-"));
  const shimDir = await mkdtemp(path.join(os.tmpdir(), "demo-gate-shim-"));
  const dump = path.join(shimDir, "env-dump.tsv");
  const prior = {
    path: process.env.PATH,
    token: Object.prototype.hasOwnProperty.call(process.env, "ACP_BEARER_TOKEN")
      ? process.env.ACP_BEARER_TOKEN
      : undefined,
    probe: Object.prototype.hasOwnProperty.call(process.env, "DEMO_GATE_ENV_PROBE")
      ? process.env.DEMO_GATE_ENV_PROBE
      : undefined,
    dumpVar: Object.prototype.hasOwnProperty.call(process.env, "DEMO_GATE_ENV_DUMP")
      ? process.env.DEMO_GATE_ENV_DUMP
      : undefined,
  };
  try {
    // Build the fixture repo with the real toolchain, before any PATH shimming.
    await mkdir(path.join(repoRoot, "components", "browser-extension"), { recursive: true });
    await writeFile(
      path.join(repoRoot, "components", "browser-extension", "placeholder.txt"),
      "fixture\n",
    );
    await git(repoRoot, ["init", "--quiet"]);
    await git(repoRoot, ["config", "user.name", "Gate Env Test"]);
    await git(repoRoot, ["config", "user.email", "gate-env@example.invalid"]);
    await git(repoRoot, ["add", "components/browser-extension"]);
    await git(repoRoot, ["commit", "--quiet", "-m", "gate env fixture"]);

    const [realGit, realTar] = await Promise.all([realExecutable("git"), realExecutable("tar")]);
    await writeFile(path.join(shimDir, "git"), recordingShim("git", realGit), { mode: 0o755 });
    await writeFile(path.join(shimDir, "tar"), recordingShim("tar", realTar), { mode: 0o755 });

    process.env.PATH = `${shimDir}${path.delimiter}${prior.path ?? ""}`;
    process.env.ACP_BEARER_TOKEN = GATE_SENTINEL;
    process.env.DEMO_GATE_ENV_PROBE = GATE_PROBE;
    process.env.DEMO_GATE_ENV_DUMP = dump;

    // The build shells out to git (source identity + archive) and tar (extract)
    // before it fails on the missing manifest; that failure is expected here.
    await buildExtensionGate({ repoRoot, outputRoot: path.join(repoRoot, "output") })
      .then(() => assert.fail("expected the manifest-less fixture build to reject"))
      .catch((error) => {
        if (/expected the manifest-less fixture build to reject/.test(error.message)) throw error;
      });

    const records = (await readFile(dump, "utf8").catch(() => ""))
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [tool, token, probe] = line.split("\t");
        return { tool, token, probe };
      });

    assert.ok(records.some((r) => r.tool === "git"), "git must have been spawned by the gate");
    assert.ok(records.some((r) => r.tool === "tar"), "tar must have been spawned by the gate");
    for (const record of records) {
      assert.equal(
        record.token,
        "<absent>",
        `ACP_BEARER_TOKEN must not reach the ${record.tool} subprocess`,
      );
      assert.equal(
        record.probe,
        GATE_PROBE,
        `non-sensitive environment (PATH/HOME) must still reach ${record.tool}`,
      );
    }
  } finally {
    if (prior.path === undefined) delete process.env.PATH;
    else process.env.PATH = prior.path;
    for (const [name, value] of [
      ["ACP_BEARER_TOKEN", prior.token],
      ["DEMO_GATE_ENV_PROBE", prior.probe],
      ["DEMO_GATE_ENV_DUMP", prior.dumpVar],
    ]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(repoRoot, { recursive: true, force: true });
    await rm(shimDir, { recursive: true, force: true });
  }
});
