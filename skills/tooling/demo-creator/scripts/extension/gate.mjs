import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

import {
  assertStableExtensionId,
  ExtensionGateError,
  extensionIdFromManifest,
  manifestKeySha256,
  STABLE_EXTENSION_ID,
} from "./extension-id.mjs";

const runFile = promisify(execFile);
const COMPONENT_PATH = "components/browser-extension";
const LOCK_SCHEMA_VERSION = 1;

// The gate only shells out to git and tar to read committed extension source;
// neither needs the caller's bearer token, which lives in this process only so
// captured artifacts can be scanned for leaks. Strip caller credentials from the
// inherited environment before it reaches a child, enforcing the "pass
// credentials only to the process that needs them" boundary. Mirrors
// capture/common, compose, and render so the credential boundary is uniform
// across the skill; process.env is never mutated.
const CALLER_SENSITIVE_ENVIRONMENT = Object.freeze(["ACP_BEARER_TOKEN"]);

function sanitizedInheritedEnv(overrides = {}) {
  const environment = { ...process.env };
  for (const name of CALLER_SENSITIVE_ENVIRONMENT) delete environment[name];
  return { ...environment, ...overrides };
}

function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

async function git(repoRoot, args) {
  try {
    const { stdout } = await runFile("git", ["-C", repoRoot, ...args], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      env: sanitizedInheritedEnv(),
    });
    return stdout.trim();
  } catch (error) {
    const detail = typeof error?.stderr === "string" ? error.stderr.trim() : "";
    throw new ExtensionGateError(
      detail === "" ? `git ${args[0]} failed` : `git ${args[0]} failed: ${detail}`,
    );
  }
}

async function materializeCommittedSource({ repoRoot, commit, destinationRoot }) {
  const archivePath = path.join(destinationRoot, "browser-extension.tar");
  const sourceRoot = path.join(destinationRoot, "source");
  await mkdir(sourceRoot, { recursive: true, mode: 0o700 });

  let archive;
  try {
    ({ stdout: archive } = await runFile(
      "git",
      ["-C", repoRoot, "archive", "--format=tar", `${commit}:${COMPONENT_PATH}`],
      { encoding: null, maxBuffer: 128 * 1024 * 1024, env: sanitizedInheritedEnv() },
    ));
  } catch (error) {
    const detail = Buffer.isBuffer(error?.stderr)
      ? error.stderr.toString("utf8").trim()
      : typeof error?.stderr === "string"
        ? error.stderr.trim()
        : "";
    throw new ExtensionGateError(
      detail === ""
        ? "failed to archive committed browser extension source"
        : `failed to archive committed browser extension source: ${detail}`,
    );
  }

  await writeFile(archivePath, archive, { mode: 0o600, flag: "wx" });
  try {
    await runFile("tar", ["-xf", archivePath, "-C", sourceRoot], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      env: sanitizedInheritedEnv(),
    });
  } catch (error) {
    const detail = typeof error?.stderr === "string" ? error.stderr.trim() : "";
    throw new ExtensionGateError(
      detail === ""
        ? "failed to extract committed browser extension source"
        : `failed to extract committed browser extension source: ${detail}`,
    );
  } finally {
    await rm(archivePath, { force: true });
  }

  // Reject links and special files before importing the committed packaging tools.
  await walkFiles(sourceRoot);
  return sourceRoot;
}

async function sourceIdentity(repoRoot) {
  const requestedRoot = await realpath(repoRoot);
  const actualRoot = await realpath(await git(requestedRoot, ["rev-parse", "--show-toplevel"]));
  if (requestedRoot !== actualRoot) {
    throw new ExtensionGateError(`repo root must be the worktree root: ${actualRoot}`);
  }
  const commit = await git(actualRoot, ["rev-parse", "--verify", "HEAD"]);
  const tree = await git(actualRoot, ["rev-parse", `${commit}:${COMPONENT_PATH}`]);
  const changes = await git(actualRoot, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
    "--",
    COMPONENT_PATH,
  ]);
  if (changes !== "") {
    throw new ExtensionGateError(
      `browser extension source does not match commit ${commit}: ${changes.split("\n")[0]}`,
    );
  }
  return { repoRoot: actualRoot, commit, tree };
}

async function loadJson(filePath, label) {
  let contents;
  try {
    contents = await readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new ExtensionGateError(`missing ${label}: ${filePath}`);
    }
    throw error;
  }
  try {
    return JSON.parse(contents);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new ExtensionGateError(`${label} is not valid JSON`);
    }
    throw error;
  }
}

async function loadPackageTools(sourceRoot) {
  const artifactModule = path.join(sourceRoot, "scripts", "package-artifact.mjs");
  const zipModule = path.join(sourceRoot, "scripts", "zip-store.mjs");
  const [{ buildArtifact, verifyArtifact }, { readDeterministicZip }] = await Promise.all([
    import(pathToFileURL(artifactModule).href),
    import(pathToFileURL(zipModule).href),
  ]);
  return { buildArtifact, verifyArtifact, readDeterministicZip };
}

function validateLockShape(lock) {
  if (
    lock?.schemaVersion !== LOCK_SCHEMA_VERSION ||
    typeof lock?.source?.commit !== "string" ||
    typeof lock?.source?.tree !== "string" ||
    lock?.source?.path !== COMPONENT_PATH ||
    typeof lock?.extension?.id !== "string" ||
    typeof lock?.extension?.version !== "string" ||
    typeof lock?.artifact?.zip !== "string" ||
    typeof lock?.artifact?.unpacked !== "string" ||
    typeof lock?.artifact?.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(lock?.artifact?.sha256) ||
    !Number.isSafeInteger(lock?.artifact?.sizeBytes) ||
    !Array.isArray(lock?.files)
  ) {
    throw new ExtensionGateError("extension lock has an invalid schema");
  }
  if (lock.extension.id !== STABLE_EXTENSION_ID) {
    throw new ExtensionGateError(
      `extension lock identity mismatch: expected ${STABLE_EXTENSION_ID}, got ${lock.extension.id}`,
    );
  }
  const seen = new Set();
  for (const file of lock.files) {
    if (
      typeof file?.path !== "string" ||
      file.path.length === 0 ||
      file.path.startsWith("/") ||
      file.path.includes("\\") ||
      file.path.split("/").some((part) => part === "" || part === "." || part === "..") ||
      typeof file.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(file.sha256) ||
      !Number.isSafeInteger(file.sizeBytes) ||
      file.sizeBytes < 0 ||
      seen.has(file.path)
    ) {
      throw new ExtensionGateError("extension lock has an invalid file entry");
    }
    seen.add(file.path);
  }
  return lock;
}

function resolveLockedPath(lockPath, relativePath, label) {
  if (
    path.isAbsolute(relativePath) ||
    relativePath.includes("\\") ||
    relativePath.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new ExtensionGateError(`extension lock ${label} path is unsafe`);
  }
  const lockRoot = path.dirname(path.resolve(lockPath));
  const resolved = path.resolve(lockRoot, ...relativePath.split("/"));
  if (resolved !== lockRoot && !resolved.startsWith(`${lockRoot}${path.sep}`)) {
    throw new ExtensionGateError(`extension lock ${label} path escapes its output root`);
  }
  return resolved;
}

async function regularFileMetadata(filePath, label) {
  const details = await lstat(filePath).catch((error) => {
    if (error?.code === "ENOENT") {
      throw new ExtensionGateError(`missing ${label}: ${filePath}`);
    }
    throw error;
  });
  if (details.isSymbolicLink() || !details.isFile()) {
    throw new ExtensionGateError(`${label} is not a regular file: ${filePath}`);
  }
  const data = await readFile(filePath);
  return { data, sha256: sha256(data), sizeBytes: data.length };
}

async function walkFiles(root, relative = "") {
  const directory = relative === "" ? root : path.join(root, ...relative.split("/"));
  const entries = await readdir(directory, { withFileTypes: true }).catch((error) => {
    if (error?.code === "ENOENT") {
      throw new ExtensionGateError(`missing unpacked extension: ${root}`);
    }
    throw error;
  });
  const files = [];
  for (const entry of entries.sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  )) {
    const child = relative === "" ? entry.name : `${relative}/${entry.name}`;
    const childPath = path.join(root, ...child.split("/"));
    const details = await lstat(childPath);
    if (details.isSymbolicLink()) {
      throw new ExtensionGateError(`unpacked extension contains a symlink: ${child}`);
    }
    if (details.isDirectory()) {
      files.push(...(await walkFiles(root, child)));
    } else if (details.isFile()) {
      files.push(child);
    } else {
      throw new ExtensionGateError(`unpacked extension contains a non-file entry: ${child}`);
    }
  }
  return files;
}

function normalizedFileCollection(paths, label) {
  const seen = new Set();
  for (const filePath of paths) {
    if (seen.has(filePath)) {
      throw new ExtensionGateError(`${label} contains a duplicate file: ${filePath}`);
    }
    seen.add(filePath);
  }
  return [...seen].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
}

async function inspectUnpacked(unpackedPath, lock) {
  const actualPaths = normalizedFileCollection(
    await walkFiles(unpackedPath),
    "unpacked extension",
  );
  const expectedPaths = normalizedFileCollection(
    lock.files.map((file) => file.path),
    "extension lock",
  );
  if (
    actualPaths.length !== expectedPaths.length ||
    actualPaths.some((entry, index) => entry !== expectedPaths[index])
  ) {
    const expected = new Set(expectedPaths);
    const actual = new Set(actualPaths);
    const unexpected = actualPaths.find((entry) => !expected.has(entry));
    const missing = expectedPaths.find((entry) => !actual.has(entry));
    throw new ExtensionGateError(
      unexpected
        ? `unpacked extension has an unexpected file: ${unexpected}`
        : `unpacked extension is missing a file: ${missing ?? "unknown"}`,
    );
  }
  for (const expected of lock.files) {
    const actual = await regularFileMetadata(
      path.join(unpackedPath, ...expected.path.split("/")),
      `unpacked extension file ${expected.path}`,
    );
    if (actual.sha256 !== expected.sha256 || actual.sizeBytes !== expected.sizeBytes) {
      throw new ExtensionGateError(`unpacked extension file mismatch: ${expected.path}`);
    }
  }
  const manifest = await loadJson(path.join(unpackedPath, "manifest.json"), "unpacked manifest");
  const id = assertStableExtensionId(manifest);
  if (
    id !== lock.extension.id ||
    manifest.version !== lock.extension.version ||
    manifest.manifest_version !== lock.extension.manifestVersion ||
    manifestKeySha256(manifest) !== lock.extension.keySha256
  ) {
    throw new ExtensionGateError("unpacked extension manifest does not match the extension lock");
  }
}

async function writeLock(lockPath, lock) {
  await mkdir(path.dirname(lockPath), { recursive: true });
  const temporaryPath = `${lockPath}.tmp-${process.pid}`;
  await rm(temporaryPath, { force: true });
  await writeFile(temporaryPath, `${JSON.stringify(lock, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o644,
    flag: "wx",
  });
  await rename(temporaryPath, lockPath);
}

export async function buildExtensionGate({
  repoRoot,
  outputRoot,
  lockPath = path.join(outputRoot, "extension.lock.json"),
  expectedExtensionId = STABLE_EXTENSION_ID,
}) {
  const source = await sourceIdentity(repoRoot);
  if (expectedExtensionId !== STABLE_EXTENSION_ID) {
    throw new ExtensionGateError(
      `expected extension identity must remain ${STABLE_EXTENSION_ID}`,
    );
  }

  const resolvedOutputRoot = path.resolve(outputRoot);
  const resolvedLockPath = path.resolve(lockPath);
  if (!resolvedLockPath.startsWith(`${resolvedOutputRoot}${path.sep}`)) {
    throw new ExtensionGateError("extension lock must be written inside the output root");
  }
  await mkdir(resolvedOutputRoot, { recursive: true });
  const artifactRoot = path.join(path.dirname(resolvedLockPath), "artifact");
  const buildRoot = await mkdtemp(path.join(os.tmpdir(), "demo-extension-build-"));
  try {
    await chmod(buildRoot, 0o700);
    const sourceRoot = await materializeCommittedSource({
      repoRoot: source.repoRoot,
      commit: source.commit,
      destinationRoot: buildRoot,
    });
    const manifest = await loadJson(path.join(sourceRoot, "manifest.json"), "source manifest");
    const extensionId = assertStableExtensionId(manifest, expectedExtensionId);
    const { buildArtifact, verifyArtifact } = await loadPackageTools(sourceRoot);
    const built = await buildArtifact({ sourceRoot, distRoot: artifactRoot });
    const verified = await verifyArtifact({ sourceRoot, distRoot: artifactRoot });
    if (built.digest !== verified.digest) {
      throw new ExtensionGateError("browser extension changed between build and verification");
    }
    const verifiedSource = await sourceIdentity(source.repoRoot);
    if (verifiedSource.commit !== source.commit || verifiedSource.tree !== source.tree) {
      throw new ExtensionGateError("browser extension source changed while the package was built");
    }

    const zip = await regularFileMetadata(verified.zipPath, "extension ZIP");
    const files = [];
    for (const relativePath of [...verified.entries].sort()) {
      const metadata = await regularFileMetadata(
        path.join(verified.unpackedPath, ...relativePath.split("/")),
        `staged extension file ${relativePath}`,
      );
      files.push({ path: relativePath, sha256: metadata.sha256, sizeBytes: metadata.sizeBytes });
    }
    const lockRoot = path.dirname(resolvedLockPath);
    const lock = {
      schemaVersion: LOCK_SCHEMA_VERSION,
      source: {
        commit: source.commit,
        tree: source.tree,
        path: COMPONENT_PATH,
      },
      extension: {
        id: extensionId,
        version: manifest.version,
        manifestVersion: manifest.manifest_version,
        name: manifest.name,
        keySha256: manifestKeySha256(manifest),
      },
      artifact: {
        zip: path.relative(lockRoot, verified.zipPath).split(path.sep).join("/"),
        unpacked: path.relative(lockRoot, verified.unpackedPath).split(path.sep).join("/"),
        sha256: zip.sha256,
        sizeBytes: zip.sizeBytes,
      },
      files,
    };
    validateLockShape(lock);
    await writeLock(resolvedLockPath, lock);
    return {
      lock,
      lockPath: resolvedLockPath,
      zipPath: verified.zipPath,
      unpackedPath: verified.unpackedPath,
    };
  } finally {
    await rm(buildRoot, { recursive: true, force: true });
  }
}

export async function verifyExtensionGate({
  repoRoot,
  lockPath,
  artifactPath,
  unpackedPath,
}) {
  const resolvedLockPath = path.resolve(lockPath);
  const lock = validateLockShape(await loadJson(resolvedLockPath, "extension lock"));
  const source = await sourceIdentity(repoRoot);
  if (source.commit !== lock.source.commit || source.tree !== lock.source.tree) {
    throw new ExtensionGateError(
      `extension lock source mismatch: locked ${lock.source.commit}, current ${source.commit}`,
    );
  }

  const sourceRoot = path.join(source.repoRoot, ...COMPONENT_PATH.split("/"));
  const sourceManifest = await loadJson(path.join(sourceRoot, "manifest.json"), "source manifest");
  if (
    extensionIdFromManifest(sourceManifest) !== lock.extension.id ||
    sourceManifest.version !== lock.extension.version ||
    sourceManifest.manifest_version !== lock.extension.manifestVersion ||
    manifestKeySha256(sourceManifest) !== lock.extension.keySha256
  ) {
    throw new ExtensionGateError("current extension manifest does not match the extension lock");
  }

  const resolvedArtifactPath = path.resolve(
    artifactPath ?? resolveLockedPath(resolvedLockPath, lock.artifact.zip, "ZIP"),
  );
  const resolvedUnpackedPath = path.resolve(
    unpackedPath ?? resolveLockedPath(resolvedLockPath, lock.artifact.unpacked, "unpacked"),
  );
  const zip = await regularFileMetadata(resolvedArtifactPath, "extension ZIP");
  if (zip.sha256 !== lock.artifact.sha256 || zip.sizeBytes !== lock.artifact.sizeBytes) {
    throw new ExtensionGateError("extension ZIP does not match the extension lock");
  }

  const verificationRoot = await mkdtemp(path.join(os.tmpdir(), "demo-extension-verify-"));
  try {
    await chmod(verificationRoot, 0o700);
    const committedSourceRoot = await materializeCommittedSource({
      repoRoot: source.repoRoot,
      commit: source.commit,
      destinationRoot: verificationRoot,
    });
    const { buildArtifact, verifyArtifact, readDeterministicZip } =
      await loadPackageTools(committedSourceRoot);
    const rebuiltRoot = path.join(verificationRoot, "rebuilt");
    const built = await buildArtifact({ sourceRoot: committedSourceRoot, distRoot: rebuiltRoot });
    const rebuilt = await verifyArtifact({
      sourceRoot: committedSourceRoot,
      distRoot: rebuiltRoot,
    });
    if (built.digest !== rebuilt.digest) {
      throw new ExtensionGateError("committed extension changed during private rebuild");
    }

    const rebuiltZip = await regularFileMetadata(rebuilt.zipPath, "rebuilt extension ZIP");
    if (
      rebuiltZip.sha256 !== lock.artifact.sha256 ||
      rebuiltZip.sizeBytes !== lock.artifact.sizeBytes ||
      !rebuiltZip.data.equals(zip.data)
    ) {
      throw new ExtensionGateError(
        "extension ZIP is not the deterministic package rebuilt from committed source",
      );
    }

    await inspectUnpacked(rebuilt.unpackedPath, lock);

    let archiveEntries;
    try {
      archiveEntries = readDeterministicZip(zip.data);
    } catch (error) {
      throw new ExtensionGateError(`extension ZIP is not deterministic: ${error.message}`);
    }
    const archiveFiles = archiveEntries.map((entry) => ({
      path: entry.name,
      sha256: sha256(entry.data),
      sizeBytes: entry.data.length,
    }));
    if (JSON.stringify(archiveFiles) !== JSON.stringify(lock.files)) {
      throw new ExtensionGateError("extension ZIP contents do not match the extension lock");
    }
    const archiveManifestEntry = archiveEntries.find((entry) => entry.name === "manifest.json");
    if (archiveManifestEntry === undefined) {
      throw new ExtensionGateError("extension ZIP is missing manifest.json");
    }
    let archiveManifest;
    try {
      archiveManifest = JSON.parse(archiveManifestEntry.data.toString("utf8"));
    } catch {
      throw new ExtensionGateError("extension ZIP manifest is not valid JSON");
    }
    assertStableExtensionId(archiveManifest);
    await inspectUnpacked(resolvedUnpackedPath, lock);
  } finally {
    await rm(verificationRoot, { recursive: true, force: true });
  }

  return {
    lock,
    lockPath: resolvedLockPath,
    zipPath: resolvedArtifactPath,
    unpackedPath: resolvedUnpackedPath,
  };
}

export async function assertCaptureExtensionMatches({ repoRoot, lockPath, extensionDir }) {
  const verified = await verifyExtensionGate({
    repoRoot,
    lockPath,
    unpackedPath: extensionDir,
  });
  if ((await stat(verified.unpackedPath)).isDirectory() === false) {
    throw new ExtensionGateError("capture extension path is not a directory");
  }
  return verified;
}
