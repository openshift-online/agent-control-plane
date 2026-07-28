import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import defaultFs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import {
  createHostProcessInspector,
  HOST_PROCESS_OUTPUT_BYTES,
} from "./host-process-identity.mjs";

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const PUBLICATION_LOCK_BASENAME = ".android-capture-publication";
const OWNER_FILENAME = "owner.json";
const JOURNAL_FILENAME = "journal.json";
const RECOVERY_DIRECTORY = "recovery";
const JOURNAL_TEMP_PATTERN = /^\.journal\.[0-9a-f-]{36}\.tmp$/u;
const execFileAsync = promisify(execFile);
const defaultInspectProcessIdentity = createHostProcessInspector({
  runCommand: async (executable, args) => execFileAsync(executable, args, {
    encoding: "utf8",
    env: { LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin" },
    maxBuffer: HOST_PROCESS_OUTPUT_BYTES,
    timeout: 2_000,
  }),
  commandOptions: Object.freeze({ shell: false }),
});

function isOutside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}

export function androidCapturePublicationWitnessPaths(outputDir) {
  if (typeof outputDir !== "string" || !path.isAbsolute(outputDir) || path.resolve(outputDir) !== outputDir) {
    throw new Error("capture-bundle outputDir must be one normalized absolute directory");
  }
  const witnessRoot = path.join(outputDir, PUBLICATION_LOCK_BASENAME, "witness");
  return Object.freeze({
    recording: path.join(witnessRoot, "raw", "android.mp4"),
    pointerEvents: path.join(witnessRoot, "pointer-events.jsonl"),
    apkLock: path.join(witnessRoot, "raw", "android-apk-lock.json"),
  });
}

export function sha256CanonicalAndroidPointerEvents(events) {
  if (!Array.isArray(events)) throw new Error("canonical pointer events must be an array");
  const bytes = events.length === 0
    ? ""
    : `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
  return createHash("sha256").update(bytes).digest("hex");
}

async function requireCanonicalDirectory(directory, label, fs) {
  if (typeof directory !== "string" || !path.isAbsolute(directory) || path.resolve(directory) !== directory) {
    throw new Error(`${label} must be one normalized absolute directory`);
  }
  const details = await fs.lstat(directory);
  if (details.isSymbolicLink() || !details.isDirectory() || await fs.realpath(directory) !== directory) {
    throw new Error(`${label} must be one canonical directory`);
  }
}

async function requireAbsent(filePath, label, fs) {
  try {
    const details = await fs.lstat(filePath);
    if (details.isSymbolicLink()) throw new Error(`${label} symbolic link already exists`);
    throw new Error(`${label} already exists`);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
}

function sameNodeIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

async function exactCurrentOwner(inspectProcessIdentity) {
  const identity = await inspectProcessIdentity(process.pid);
  if (
    !identity
    || identity.pid !== process.pid
    || identity.alive !== true
    || typeof identity.processStartIdentity !== "string"
    || identity.processStartIdentity.length === 0
  ) {
    throw new Error("capture-bundle cannot prove its current process identity");
  }
  return {
    pid: process.pid,
    nonce: randomUUID(),
    processStartIdentity: identity.processStartIdentity,
  };
}

async function ownerIsLive(owner, inspectProcessIdentity) {
  try {
    const identity = await inspectProcessIdentity(owner.pid);
    if (identity === null || identity === undefined) return false;
    return identity.alive !== false
      && identity.pid === owner.pid
      && identity.processStartIdentity === owner.processStartIdentity;
  } catch {
    // Inspection uncertainty is live for safety: never recover against it.
    return true;
  }
}

function exactOwner(value) {
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([
      "nonce", "pid", "processStartIdentity",
    ])
    || !Number.isInteger(value.pid)
    || value.pid < 1
    || typeof value.nonce !== "string"
    || !/^[0-9a-f-]{36}$/u.test(value.nonce)
    || typeof value.processStartIdentity !== "string"
    || value.processStartIdentity.length === 0
    || value.processStartIdentity.length > 256
  ) {
    throw new Error("capture-bundle owner record is invalid");
  }
  return value;
}

async function readExactJson(filePath, label, fs) {
  const details = await fs.lstat(filePath);
  if (
    details.isSymbolicLink()
    || !details.isFile()
    || (details.mode & 0o777) !== 0o600
    || await fs.realpath(filePath) !== filePath
  ) {
    throw new Error(`${label} must be one canonical mode-0600 file`);
  }
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function writeExclusiveJson(filePath, value, fs) {
  const handle = await fs.open(filePath, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`);
    await handle.chmod(0o600);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function requireLockIdentity(lock) {
  const details = await lock.fs.lstat(lock.lockDir);
  if (
    details.isSymbolicLink()
    || !details.isDirectory()
    || (details.mode & 0o777) !== 0o700
    || !sameNodeIdentity(details, lock.identity)
    || await lock.fs.realpath(lock.lockDir) !== lock.lockDir
  ) {
    throw new Error("capture-bundle ownership directory identity changed");
  }
}

async function requireNoRecoveryClaim(lock) {
  try {
    await lock.fs.lstat(path.join(lock.lockDir, RECOVERY_DIRECTORY));
    throw new Error("capture-bundle ownership is under recovery");
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
}

async function replaceJournal(lock, journal) {
  await requireLockIdentity(lock);
  await requireNoRecoveryClaim(lock);
  const temporaryPath = path.join(lock.lockDir, `.journal.${randomUUID()}.tmp`);
  await writeExclusiveJson(temporaryPath, journal, lock.fs);
  try {
    await requireLockIdentity(lock);
    await requireNoRecoveryClaim(lock);
    await lock.fs.rename(temporaryPath, lock.journalPath);
  } catch (error) {
    await lock.fs.unlink(temporaryPath).catch(() => {});
    throw error;
  }
}

async function removeOwnedDirectory(directory, allowedEntries, fs) {
  const details = await fs.lstat(directory);
  if (details.isSymbolicLink() || !details.isDirectory() || await fs.realpath(directory) !== directory) {
    throw new Error("capture-bundle owned directory identity changed");
  }
  const entries = await fs.readdir(directory);
  if (entries.some((entry) => !allowedEntries.has(entry))) {
    throw new Error("capture-bundle owned directory contains unexpected entries");
  }
  for (const entry of entries) await fs.unlink(path.join(directory, entry));
  await fs.rmdir(directory);
}

async function releasePublicationLock(lock, { recovery = false } = {}) {
  await requireLockIdentity(lock);
  const entries = await lock.fs.readdir(lock.lockDir);
  for (const entry of entries) {
    if (JOURNAL_TEMP_PATTERN.test(entry)) await lock.fs.unlink(path.join(lock.lockDir, entry));
  }
  if (recovery) {
    await removeOwnedDirectory(
      path.join(lock.lockDir, RECOVERY_DIRECTORY),
      new Set([OWNER_FILENAME]),
      lock.fs,
    );
  }
  for (const filePath of [lock.journalPath, lock.ownerPath]) {
    try {
      await lock.fs.unlink(filePath);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  const remaining = await lock.fs.readdir(lock.lockDir);
  if (remaining.length !== 0) throw new Error("capture-bundle lock remains nonempty");
  await lock.fs.rmdir(lock.lockDir);
}

async function prepareWitnessDirectories(lock) {
  const witnessRoot = path.join(lock.lockDir, "witness");
  const rawRoot = path.join(witnessRoot, "raw");
  for (const directory of [witnessRoot, rawRoot]) {
    await lock.fs.mkdir(directory, { mode: 0o700 });
    const identity = await inspectWitnessDirectory(lock, directory);
    lock.witnessDirectoryIdentities.set(directory, identity);
  }
}

async function inspectWitnessDirectory(lock, directory, { allowAbsent = false } = {}) {
  await requireLockIdentity(lock);
  let details;
  try {
    details = await lock.fs.lstat(directory);
  } catch (error) {
    if (allowAbsent && error?.code === "ENOENT") return undefined;
    throw error;
  }
  if (
    details.isSymbolicLink()
    || !details.isDirectory()
    || (details.mode & 0o777) !== 0o700
    || await lock.fs.realpath(directory) !== directory
  ) {
    throw new Error("capture-bundle witness directory is not exact and private");
  }
  return Object.freeze({ dev: details.dev, ino: details.ino });
}

async function captureExistingWitnessDirectoryIdentities(lock) {
  const witnessRoot = path.join(lock.lockDir, "witness");
  const rawRoot = path.join(witnessRoot, "raw");
  for (const directory of [witnessRoot, rawRoot]) {
    const identity = await inspectWitnessDirectory(lock, directory, { allowAbsent: true });
    if (identity) lock.witnessDirectoryIdentities.set(directory, identity);
  }
}

async function removeEmptyWitnessDirectories(lock) {
  const witnessRoot = path.join(lock.lockDir, "witness");
  const rawRoot = path.join(witnessRoot, "raw");
  for (const directory of [rawRoot, witnessRoot]) {
    const expectedIdentity = lock.witnessDirectoryIdentities.get(directory);
    if (!expectedIdentity) {
      const unexpectedIdentity = await inspectWitnessDirectory(lock, directory, { allowAbsent: true });
      if (!unexpectedIdentity) continue;
      throw new Error("capture-bundle witness directory identity changed");
    }
    const identity = await inspectWitnessDirectory(lock, directory);
    if (!sameNodeIdentity(identity, expectedIdentity)) {
      throw new Error("capture-bundle witness directory identity changed");
    }
    const entries = await lock.fs.readdir(directory);
    if (entries.length !== 0) throw new Error("capture-bundle witness directory remains nonempty");
    const beforeRemoval = await inspectWitnessDirectory(lock, directory);
    if (!sameNodeIdentity(beforeRemoval, expectedIdentity)) {
      throw new Error("capture-bundle witness directory identity changed");
    }
    await lock.fs.rmdir(directory);
    lock.witnessDirectoryIdentities.delete(directory);
  }
}

async function sha256File(filePath, fs) {
  const handle = await fs.open(filePath, "r");
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  try {
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    await handle.close();
  }
  return hash.digest("hex");
}

function sameIdentity(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mode === right.mode
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

async function capturePublishedIdentity({ destinationPath, fs }) {
  const before = await fs.lstat(destinationPath);
  if (
    before.isSymbolicLink()
    || !before.isFile()
    || await fs.realpath(destinationPath) !== destinationPath
  ) {
    throw new Error("capture-bundle publisher did not create one canonical regular file");
  }
  const sha256 = await sha256File(destinationPath, fs);
  const after = await fs.lstat(destinationPath);
  if (!sameIdentity(before, after)) {
    throw new Error("capture-bundle artifact identity changed during verification");
  }
  return Object.freeze({
    destinationPath,
    sha256,
    identity: Object.freeze({
      dev: after.dev,
      ino: after.ino,
      size: after.size,
      mode: after.mode,
      mtimeMs: after.mtimeMs,
      ctimeMs: after.ctimeMs,
    }),
  });
}

function verifyPublishedArtifactProof({
  artifact,
  destinationPath,
  resultPathKey,
  expectedSha256,
  publishedIdentity,
}) {
  if (
    !artifact
    || typeof artifact !== "object"
    || artifact[resultPathKey] !== destinationPath
    || !SHA256_PATTERN.test(artifact.sha256)
    || (expectedSha256 !== undefined && artifact.sha256 !== expectedSha256)
  ) {
    throw new Error("capture-bundle publisher returned an unbound artifact proof");
  }
  if (artifact.sha256 !== publishedIdentity.sha256) {
    throw new Error("capture-bundle artifact identity changed during verification");
  }
}

async function rollbackPublication(publication, fs) {
  const current = await fs.lstat(publication.destinationPath);
  if (
    current.isSymbolicLink()
    || !current.isFile()
    || !sameIdentity(current, publication.identity)
    || await fs.realpath(publication.destinationPath) !== publication.destinationPath
  ) {
    throw new Error("capture-bundle destination identity changed before exact rollback");
  }
  const sha256 = await sha256File(publication.destinationPath, fs);
  const beforeUnlink = await fs.lstat(publication.destinationPath);
  if (
    !sameIdentity(current, beforeUnlink)
    || beforeUnlink.isSymbolicLink()
    || !beforeUnlink.isFile()
    || sha256 !== publication.sha256
    || await fs.realpath(publication.destinationPath) !== publication.destinationPath
  ) {
    throw new Error("capture-bundle destination identity changed before exact rollback");
  }
  await fs.unlink(publication.destinationPath);
  try {
    await fs.lstat(publication.destinationPath);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw new Error("capture-bundle destination remains after exact rollback");
}

function journalDocument(owner, outputDir, publications, current = null, completed = []) {
  return {
    schemaVersion: 1,
    owner,
    outputDir,
    publications: publications.map(({ resultKey, destinationPath, witnessPath, expectedSha256 }) => ({
      key: resultKey,
      destinationPath,
      witnessPath,
      expectedSha256,
    })),
    current,
    completed,
    committed: false,
  };
}

function assertMatchingJournal(journal, owner, outputDir) {
  if (
    !journal
    || typeof journal !== "object"
    || Array.isArray(journal)
    || journal.schemaVersion !== 1
    || journal.outputDir !== outputDir
    || journal.owner?.pid !== owner.pid
    || journal.owner?.nonce !== owner.nonce
    || journal.owner?.processStartIdentity !== owner.processStartIdentity
    || !Array.isArray(journal.publications)
    || !Array.isArray(journal.completed)
    || typeof journal.committed !== "boolean"
    || (journal.current !== null && typeof journal.current !== "string")
  ) {
    throw new Error("capture-bundle journal is invalid");
  }
  const witnesses = androidCapturePublicationWitnessPaths(outputDir);
  const expectedPaths = [
    ["publishedRecording", path.join(outputDir, "raw", "android.mp4"), witnesses.recording],
    ["pointerArtifact", path.join(outputDir, "pointer-events.jsonl"), witnesses.pointerEvents],
    ["lockArtifact", path.join(outputDir, "raw", "android-apk-lock.json"), witnesses.apkLock],
  ];
  if (
    journal.publications.length !== expectedPaths.length
    || journal.publications.some((publication, index) => (
      publication?.key !== expectedPaths[index][0]
      || publication?.destinationPath !== expectedPaths[index][1]
      || publication?.witnessPath !== expectedPaths[index][2]
      || !SHA256_PATTERN.test(publication?.expectedSha256)
    ))
  ) {
    throw new Error("capture-bundle journal has invalid artifact boundaries");
  }
  const keys = new Set(expectedPaths.map(([key]) => key));
  if (journal.current !== null && !keys.has(journal.current)) {
    throw new Error("capture-bundle journal current publication is invalid");
  }
  for (const completed of journal.completed) {
    if (
      !completed
      || typeof completed !== "object"
      || !keys.has(completed.key)
      || typeof completed.destinationPath !== "string"
      || typeof completed.witnessPath !== "string"
      || !SHA256_PATTERN.test(completed.sha256)
      || !completed.identity
      || typeof completed.identity !== "object"
    ) {
      throw new Error("capture-bundle completed journal proof is invalid");
    }
  }
  if (journal.committed && (journal.current !== null || journal.completed.length !== expectedPaths.length)) {
    throw new Error("capture-bundle committed journal is incomplete");
  }
  return journal.publications.map((publication) => ({
    resultKey: publication.key,
    destinationPath: publication.destinationPath,
    witnessPath: publication.witnessPath,
    expectedSha256: publication.expectedSha256,
  }));
}

async function inspectOptionalPath(filePath, fs) {
  try {
    return await capturePublishedIdentity({ destinationPath: filePath, fs });
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

async function rollbackWitnessPublication(publication, fs) {
  const witness = await inspectOptionalPath(publication.witnessPath, fs);
  const destination = await inspectOptionalPath(publication.destinationPath, fs);
  if (!witness) {
    if (destination) {
      throw new Error("capture-bundle final destination has no private ownership witness");
    }
    return;
  }
  if (witness.sha256 !== publication.expectedSha256) {
    throw new Error("capture-bundle private ownership witness digest changed");
  }
  if (
    destination
    && (
      destination.identity.dev !== witness.identity.dev
      || destination.identity.ino !== witness.identity.ino
      || destination.sha256 !== witness.sha256
    )
  ) {
    throw new Error("capture-bundle final destination is not the journaled private witness inode");
  }
  if (destination) await rollbackPublication(destination, fs);
  const witnessAfterDestination = await capturePublishedIdentity({
    destinationPath: publication.witnessPath,
    fs,
  });
  if (
    witnessAfterDestination.identity.dev !== witness.identity.dev
    || witnessAfterDestination.identity.ino !== witness.identity.ino
    || witnessAfterDestination.sha256 !== publication.expectedSha256
  ) {
    throw new Error("capture-bundle private ownership witness changed during rollback");
  }
  await rollbackPublication(witnessAfterDestination, fs);
}

async function rollbackJournal(lock, journal, publications) {
  const byKey = new Map(publications.map((publication) => [publication.resultKey, publication]));
  const rollbackKeys = journal.completed.map(({ key }) => key);
  if (journal.current !== null) rollbackKeys.push(journal.current);
  const seen = new Set();
  for (const key of rollbackKeys.toReversed()) {
    if (seen.has(key)) continue;
    seen.add(key);
    await rollbackWitnessPublication(byKey.get(key), lock.fs);
  }
  for (const publication of publications) {
    if (seen.has(publication.resultKey)) continue;
    const [destination, witness] = await Promise.all([
      inspectOptionalPath(publication.destinationPath, lock.fs),
      inspectOptionalPath(publication.witnessPath, lock.fs),
    ]);
    if (destination || witness) {
      throw new Error("capture-bundle found an unowned artifact during recovery");
    }
  }
}

async function finishCommittedJournal(lock, journal, publications) {
  const completedByKey = new Map(journal.completed.map((completed) => [completed.key, completed]));
  for (const publication of publications) {
    const completed = completedByKey.get(publication.resultKey);
    const destination = await capturePublishedIdentity({
      destinationPath: publication.destinationPath,
      fs: lock.fs,
    });
    if (
      destination.sha256 !== publication.expectedSha256
      || destination.identity.dev !== completed.identity.dev
      || destination.identity.ino !== completed.identity.ino
      || destination.identity.size !== completed.identity.size
      || destination.identity.mode !== completed.identity.mode
    ) {
      throw new Error("capture-bundle committed destination identity changed");
    }
    const witness = await inspectOptionalPath(publication.witnessPath, lock.fs);
    if (witness) {
      if (
        witness.sha256 !== destination.sha256
        || witness.identity.dev !== destination.identity.dev
        || witness.identity.ino !== destination.identity.ino
      ) {
        throw new Error("capture-bundle committed witness identity changed");
      }
      await rollbackPublication(witness, lock.fs);
    }
  }
  await removeEmptyWitnessDirectories(lock);
}

async function createPublicationLock(outputDir, fs, owner) {
  const lockDir = path.join(outputDir, PUBLICATION_LOCK_BASENAME);
  await fs.mkdir(lockDir, { mode: 0o700 });
  const details = await fs.lstat(lockDir);
  const lock = {
    fs,
    lockDir,
    ownerPath: path.join(lockDir, OWNER_FILENAME),
    journalPath: path.join(lockDir, JOURNAL_FILENAME),
    identity: { dev: details.dev, ino: details.ino },
    owner,
    witnessDirectoryIdentities: new Map(),
  };
  try {
    await writeExclusiveJson(lock.ownerPath, owner, fs);
    await requireLockIdentity(lock);
    await requireNoRecoveryClaim(lock);
    return lock;
  } catch (error) {
    try {
      const entries = await fs.readdir(lockDir);
      if (entries.every((entry) => entry === OWNER_FILENAME)) {
        await fs.unlink(lock.ownerPath).catch((unlinkError) => {
          if (unlinkError?.code !== "ENOENT") throw unlinkError;
        });
        await fs.rmdir(lockDir);
      }
    } catch {
      // A recovery claimant owns ambiguous cleanup; preserve the lock fail-closed.
    }
    throw error;
  }
}

async function acquireRecoveryClaim(lock, inspectProcessIdentity) {
  const recoveryDir = path.join(lock.lockDir, RECOVERY_DIRECTORY);
  for (;;) {
    try {
      await lock.fs.mkdir(recoveryDir, { mode: 0o700 });
      const recoveryOwner = await exactCurrentOwner(inspectProcessIdentity);
      await writeExclusiveJson(path.join(recoveryDir, OWNER_FILENAME), recoveryOwner, lock.fs);
      await requireLockIdentity(lock);
      return;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      let recoveryOwner;
      try {
        recoveryOwner = exactOwner(await readExactJson(
          path.join(recoveryDir, OWNER_FILENAME),
          "capture-bundle recovery owner",
          lock.fs,
        ));
      } catch {
        recoveryOwner = undefined;
      }
      if (recoveryOwner && await ownerIsLive(recoveryOwner, inspectProcessIdentity)) {
        throw new Error("capture-bundle recovery is already owned by a live process");
      }
      await removeOwnedDirectory(recoveryDir, new Set([OWNER_FILENAME]), lock.fs);
    }
  }
}

async function recoverStalePublication(outputDir, fs, inspectProcessIdentity) {
  const lockDir = path.join(outputDir, PUBLICATION_LOCK_BASENAME);
  const details = await fs.lstat(lockDir);
  if (
    details.isSymbolicLink()
    || !details.isDirectory()
    || (details.mode & 0o777) !== 0o700
    || await fs.realpath(lockDir) !== lockDir
  ) {
    throw new Error("capture-bundle ownership directory is not exact and private");
  }
  const lock = {
    fs,
    lockDir,
    ownerPath: path.join(lockDir, OWNER_FILENAME),
    journalPath: path.join(lockDir, JOURNAL_FILENAME),
    identity: { dev: details.dev, ino: details.ino },
    witnessDirectoryIdentities: new Map(),
  };
  let owner;
  try {
    owner = exactOwner(await readExactJson(lock.ownerPath, "capture-bundle owner", fs));
  } catch {
    owner = undefined;
  }
  if (owner && await ownerIsLive(owner, inspectProcessIdentity)) {
    throw new Error("capture-bundle publication is owned by a live process");
  }
  await acquireRecoveryClaim(lock, inspectProcessIdentity);
  await captureExistingWitnessDirectoryIdentities(lock);
  try {
    try {
      owner = exactOwner(await readExactJson(lock.ownerPath, "capture-bundle owner", fs));
    } catch {
      for (const destinationPath of [
        path.join(outputDir, "raw", "android.mp4"),
        path.join(outputDir, "pointer-events.jsonl"),
        path.join(outputDir, "raw", "android-apk-lock.json"),
      ]) {
        if (await inspectOptionalPath(destinationPath, fs)) {
          throw new Error("capture-bundle incomplete owner has published artifacts");
        }
      }
      try {
        await fs.lstat(lock.journalPath);
        throw new Error("capture-bundle incomplete owner has an ambiguous journal");
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      await removeEmptyWitnessDirectories(lock);
      await releasePublicationLock(lock, { recovery: true });
      return;
    }
    if (await ownerIsLive(owner, inspectProcessIdentity)) {
      await removeOwnedDirectory(
        path.join(lock.lockDir, RECOVERY_DIRECTORY),
        new Set([OWNER_FILENAME]),
        fs,
      );
      throw new Error("capture-bundle publication became owned by a live process");
    }
    const journal = await readExactJson(lock.journalPath, "capture-bundle journal", fs);
    const stalePublications = assertMatchingJournal(journal, owner, outputDir);
    if (journal.committed) {
      await finishCommittedJournal(lock, journal, stalePublications);
    } else {
      await rollbackJournal(lock, journal, stalePublications);
      await removeEmptyWitnessDirectories(lock);
    }
    await releasePublicationLock(lock, { recovery: true });
  } catch (error) {
    throw error;
  }
}

export async function publishAndroidCaptureBundle({
  outputDir,
  recordingDestinationPath,
  pointerDestinationPath,
  lockDestinationPath,
  expectedRecordingSha256,
  expectedPointerSha256,
  expectedLockSha256,
  publishRecording,
  publishPointerEvents,
  publishApkLock,
  fs = defaultFs,
  inspectProcessIdentity = defaultInspectProcessIdentity,
} = {}) {
  await requireCanonicalDirectory(outputDir, "capture-bundle outputDir", fs);
  const witnessPaths = androidCapturePublicationWitnessPaths(outputDir);
  const publications = [
    {
      destinationPath: recordingDestinationPath,
      witnessPath: witnessPaths.recording,
      expectedBasename: "android.mp4",
      expectedSha256: expectedRecordingSha256,
      publish: publishRecording,
      resultPathKey: "outputPath",
      resultKey: "publishedRecording",
    },
    {
      destinationPath: pointerDestinationPath,
      witnessPath: witnessPaths.pointerEvents,
      expectedBasename: "pointer-events.jsonl",
      expectedSha256: expectedPointerSha256,
      publish: publishPointerEvents,
      resultPathKey: "path",
      resultKey: "pointerArtifact",
    },
    {
      destinationPath: lockDestinationPath,
      witnessPath: witnessPaths.apkLock,
      expectedBasename: "android-apk-lock.json",
      expectedSha256: expectedLockSha256,
      publish: publishApkLock,
      resultPathKey: "path",
      resultKey: "lockArtifact",
    },
  ];
  const exactDestinations = [
    path.join(outputDir, "raw", "android.mp4"),
    path.join(outputDir, "pointer-events.jsonl"),
    path.join(outputDir, "raw", "android-apk-lock.json"),
  ];
  if (publications.some(({ destinationPath }, index) => destinationPath !== exactDestinations[index])) {
    throw new Error("capture-bundle destinations must use the exact Android artifact layout");
  }
  for (const publication of publications) {
    const { destinationPath, expectedBasename, publish } = publication;
    if (
      typeof destinationPath !== "string"
      || !path.isAbsolute(destinationPath)
      || path.resolve(destinationPath) !== destinationPath
      || isOutside(outputDir, destinationPath)
      || path.basename(destinationPath) !== expectedBasename
      || typeof publish !== "function"
    ) {
      throw new Error("capture-bundle publication contract is invalid");
    }
    await requireCanonicalDirectory(
      path.dirname(destinationPath),
      "capture-bundle destination parent",
      fs,
    );
  }
  if (new Set(publications.map(({ destinationPath }) => destinationPath)).size !== publications.length) {
    throw new Error("capture-bundle destinations must be distinct");
  }
  for (const digest of [expectedRecordingSha256, expectedPointerSha256, expectedLockSha256]) {
    if (!SHA256_PATTERN.test(digest)) {
      throw new Error("capture-bundle expected digest must be one lowercase SHA-256");
    }
  }
  if (typeof inspectProcessIdentity !== "function") {
    throw new Error("capture-bundle process identity inspector must be a function");
  }

  const owner = await exactCurrentOwner(inspectProcessIdentity);
  let lock;
  for (;;) {
    try {
      lock = await createPublicationLock(outputDir, fs, owner);
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      await recoverStalePublication(outputDir, fs, inspectProcessIdentity);
    }
  }
  try {
    await prepareWitnessDirectories(lock);
    for (const publication of publications) {
      await requireAbsent(publication.destinationPath, "capture-bundle destination", fs);
      await requireAbsent(publication.witnessPath, "capture-bundle witness", fs);
    }
  } catch (error) {
    try {
      await removeEmptyWitnessDirectories(lock);
      await releasePublicationLock(lock);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "capture-bundle preparation failed and exact cleanup failed",
        { cause: error },
      );
    }
    throw error;
  }

  let journal = journalDocument(owner, outputDir, publications);
  const results = {};
  try {
    await replaceJournal(lock, journal);
    for (const publication of publications) {
      journal = { ...journal, current: publication.resultKey };
      await replaceJournal(lock, journal);
      const artifact = await publication.publish({ witnessPath: publication.witnessPath });
      const witnessIdentity = await capturePublishedIdentity({
        destinationPath: publication.witnessPath,
        fs,
      });
      if (witnessIdentity.sha256 !== publication.expectedSha256) {
        throw new Error("capture-bundle artifact identity changed during verification");
      }
      verifyPublishedArtifactProof({
        ...publication,
        destinationPath: publication.witnessPath,
        artifact,
        publishedIdentity: witnessIdentity,
      });
      try {
        await fs.link(publication.witnessPath, publication.destinationPath);
      } catch (error) {
        if (error?.code === "EEXIST") {
          throw new Error("capture-bundle final destination already exists", { cause: error });
        }
        if (error?.code === "EXDEV") {
          throw new Error("capture-bundle witness and final destination must share a filesystem", { cause: error });
        }
        throw error;
      }
      const [publishedIdentity, witnessAfterLink] = await Promise.all([
        capturePublishedIdentity({ destinationPath: publication.destinationPath, fs }),
        capturePublishedIdentity({ destinationPath: publication.witnessPath, fs }),
      ]);
      if (
        publishedIdentity.identity.dev !== witnessAfterLink.identity.dev
        || publishedIdentity.identity.ino !== witnessAfterLink.identity.ino
        || publishedIdentity.sha256 !== witnessAfterLink.sha256
      ) {
        throw new Error("capture-bundle final destination is not the private witness inode");
      }
      const completed = {
        key: publication.resultKey,
        destinationPath: publishedIdentity.destinationPath,
        witnessPath: publication.witnessPath,
        sha256: publishedIdentity.sha256,
        identity: publishedIdentity.identity,
      };
      journal = {
        ...journal,
        current: null,
        completed: [...journal.completed, completed],
      };
      await replaceJournal(lock, journal);
      results[publication.resultKey] = Object.freeze({
        ...artifact,
        [publication.resultPathKey]: publication.destinationPath,
      });
    }
    journal = { ...journal, committed: true };
    await replaceJournal(lock, journal);
    await finishCommittedJournal(lock, journal, publications);
    await releasePublicationLock(lock);
    return Object.freeze(results);
  } catch (error) {
    const rollbackErrors = [];
    try {
      await rollbackJournal(lock, journal, publications);
      await removeEmptyWitnessDirectories(lock);
      await releasePublicationLock(lock);
    } catch (rollbackError) {
      rollbackErrors.push(rollbackError);
    }
    if (rollbackErrors.length > 0) {
      throw new AggregateError(
        [error, ...rollbackErrors],
        "capture-bundle publication failed and exact rollback failed",
        { cause: error },
      );
    }
    throw error;
  }
}
