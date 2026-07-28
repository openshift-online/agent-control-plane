import { createHash, randomUUID } from "node:crypto";
import * as defaultFs from "node:fs/promises";
import path from "node:path";

export const AVD_OWNERSHIP_VERSION = 1;
export const AVD_TOOL_NAMESPACE = "acp.demo-creator.android-avd";

const BASE_MARKER_FIELDS = Object.freeze([
  "version",
  "toolNamespace",
  "scenarioId",
  "runId",
  "nonce",
  "avdName",
  "avdPath",
  "systemImage",
]);
const PROCESS_MARKER_FIELDS = Object.freeze([
  "serial",
  "consolePort",
  "pid",
  "processStartIdentity",
]);
const AVD_DELETE_PENDING_PHASE = "avd-delete-pending";
const MARKER_UPDATE_LOCK_NAMESPACE = `${AVD_TOOL_NAMESPACE}.marker-update`;

function requiredString(value, fieldName) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${fieldName} must be a non-empty string`);
  }
  return value;
}

function slug(value, maximumLength) {
  const normalized = value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maximumLength)
    .replace(/-+$/g, "");
  return normalized || "id";
}

function generatedAvdName({ scenarioId, runId, nonce }) {
  const digest = createHash("sha256")
    .update(JSON.stringify([scenarioId, runId, nonce]))
    .digest("hex")
    .slice(0, 12);
  return [
    "acp-demo",
    slug(scenarioId, 12),
    slug(runId, 12),
    slug(nonce, 8),
    digest,
  ].join("-");
}

function baseMarker(ownership) {
  return Object.fromEntries(BASE_MARKER_FIELDS.map((field) => [field, ownership[field]]));
}

function hasProcessBinding(value) {
  return PROCESS_MARKER_FIELDS.some((field) => Object.hasOwn(value, field));
}

function normalizedProcessBinding(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Emulator process binding is required");
  }
  for (const field of PROCESS_MARKER_FIELDS) {
    if (!Object.hasOwn(value, field)) throw new Error(`Emulator process binding is missing ${field}`);
  }
  const serial = requiredString(value.serial, "binding.serial");
  const processStartIdentity = requiredString(value.processStartIdentity, "binding.processStartIdentity");
  if (!Number.isInteger(value.consolePort) || value.consolePort < 1 || value.consolePort > 65535) {
    throw new Error("binding.consolePort must be an integer TCP port");
  }
  if (!Number.isInteger(value.pid) || value.pid < 1) {
    throw new Error("binding.pid must be a positive integer");
  }
  return Object.freeze({
    serial,
    consolePort: value.consolePort,
    pid: value.pid,
    processStartIdentity,
  });
}

function normalizedMarkerUpdateOwner(value, fieldName = "marker update owner") {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${fieldName} must be an object`);
  }
  if (!Number.isInteger(value.pid) || value.pid < 1) {
    throw new Error(`${fieldName}.pid must be a positive integer`);
  }
  return Object.freeze({
    pid: value.pid,
    processStartIdentity: requiredString(
      value.processStartIdentity,
      `${fieldName}.processStartIdentity`,
    ),
  });
}

function markerUpdateLockRecord(ownership, owner) {
  return {
    version: AVD_OWNERSHIP_VERSION,
    toolNamespace: MARKER_UPDATE_LOCK_NAMESPACE,
    avdName: ownership.avdName,
    markerPath: ownership.markerPath,
    ownerPid: owner.pid,
    ownerProcessStartIdentity: owner.processStartIdentity,
  };
}

function markerForOwnership(ownership) {
  const marker = baseMarker(ownership);
  if (!hasProcessBinding(ownership)) return marker;
  return { ...marker, ...normalizedProcessBinding(ownership) };
}

function deletionPendingMarker(ownership) {
  return {
    ...markerForOwnership(ownership),
    teardownPhase: AVD_DELETE_PENDING_PHASE,
  };
}

function sameFlatObject(actual, expected) {
  if (!actual || typeof actual !== "object" || Array.isArray(actual)) return false;
  const actualKeys = Object.keys(actual).sort();
  const expectedKeys = Object.keys(expected).sort();
  if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) return false;
  return expectedKeys.every((key) => actual[key] === expected[key]);
}

function assertGeneratedOwnershipIdentity(ownership) {
  if (!ownership || typeof ownership !== "object" || Array.isArray(ownership)) {
    throw new Error("Generated AVD ownership is required");
  }
  if (ownership.version !== AVD_OWNERSHIP_VERSION || ownership.toolNamespace !== AVD_TOOL_NAMESPACE) {
    throw new Error("Refusing an ownership envelope from a different tool or version");
  }
  const scenarioId = requiredString(ownership.scenarioId, "ownership.scenarioId");
  const runId = requiredString(ownership.runId, "ownership.runId");
  const nonce = requiredString(ownership.nonce, "ownership.nonce");
  const expectedName = generatedAvdName({ scenarioId, runId, nonce });
  if (ownership.avdName !== expectedName) {
    throw new Error(`Refusing non-generated AVD identity ${ownership.avdName ?? "<missing>"}`);
  }
  const avdPath = path.resolve(requiredString(ownership.avdPath, "ownership.avdPath"));
  const markerPath = path.resolve(requiredString(ownership.markerPath, "ownership.markerPath"));
  if (ownership.avdPath !== avdPath || path.basename(avdPath) !== `${expectedName}.avd`) {
    throw new Error("Refusing non-generated AVD identity path");
  }
  if (ownership.markerPath !== markerPath || path.basename(markerPath) !== `${expectedName}.owner.json`) {
    throw new Error("Refusing non-generated AVD ownership marker path");
  }
  if (isWithin(avdPath, markerPath)) {
    throw new Error("AVD ownership marker must be external to the generated AVD path");
  }
  requiredString(ownership.systemImage, "ownership.systemImage");
  return ownership;
}

function isWithin(parentPath, candidatePath) {
  const relative = path.relative(parentPath, candidatePath);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

async function pathExists(fs, pathname) {
  try {
    // lstat observes the directory entry itself. access() follows symlinks and
    // would incorrectly classify a dangling symlink at an owned path as absent.
    await fs.lstat(pathname);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function canonicalDirectoryRoot(fs, value, fieldName) {
  const authoredRoot = requiredString(value, fieldName);
  const resolvedRoot = path.resolve(authoredRoot);
  if (authoredRoot !== resolvedRoot) {
    throw new Error(`${fieldName} must be canonical and absolute: ${authoredRoot}`);
  }
  let canonicalRoot;
  try {
    canonicalRoot = await fs.realpath(resolvedRoot);
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error(`${fieldName} must already exist: ${resolvedRoot}`);
    throw error;
  }
  const normalizedCanonicalRoot = path.resolve(canonicalRoot);
  if (canonicalRoot !== normalizedCanonicalRoot || canonicalRoot !== resolvedRoot) {
    throw new Error(`${fieldName} must be canonical; symlink aliases are not accepted: ${resolvedRoot}`);
  }
  let stat;
  try {
    stat = await fs.lstat(canonicalRoot);
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error(`${fieldName} must already exist: ${canonicalRoot}`);
    throw error;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${fieldName} must be a directory: ${canonicalRoot}`);
  }
  return canonicalRoot;
}

function exactChildPath(root, basename, fieldName) {
  const candidate = path.join(root, basename);
  if (path.dirname(candidate) !== root || !isWithin(root, candidate)) {
    throw new Error(`${fieldName} escaped its canonical root`);
  }
  return candidate;
}

async function reservationContext(input, dependencies) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("AVD reservation input is required");
  }
  for (const field of ["avdName", "avdPath", "markerPath"]) {
    if (Object.hasOwn(input, field)) {
      throw new Error(`Refusing caller-authored AVD identity field ${field}`);
    }
  }
  const scenarioId = requiredString(input.scenarioId, "scenarioId");
  const runId = requiredString(input.runId, "runId");
  const nonceGenerator = dependencies?.randomUUID ?? randomUUID;
  if (input.nonce === undefined && typeof nonceGenerator !== "function") {
    throw new Error("A random UUID generator is required when nonce is omitted");
  }
  const nonce = input.nonce === undefined
    ? requiredString(nonceGenerator(), "generated nonce")
    : requiredString(input.nonce, "nonce");
  const systemImage = requiredString(input.systemImage, "systemImage");
  const fs = dependencies?.fs ?? defaultFs;
  const avdRoot = await canonicalDirectoryRoot(fs, input.avdRoot, "avdRoot");
  const markerRoot = await canonicalDirectoryRoot(fs, input.markerRoot, "markerRoot");
  const avdName = generatedAvdName({ scenarioId, runId, nonce });
  const avdPath = exactChildPath(avdRoot, `${avdName}.avd`, "Generated AVD path");
  const avdDefinitionPath = exactChildPath(avdRoot, `${avdName}.ini`, "Generated AVD definition path");
  const markerPath = exactChildPath(markerRoot, `${avdName}.owner.json`, "Generated ownership marker path");
  if (isWithin(avdPath, markerPath)) {
    throw new Error("AVD ownership marker must be external to the generated AVD path");
  }
  const ownership = Object.freeze({
    version: AVD_OWNERSHIP_VERSION,
    toolNamespace: AVD_TOOL_NAMESPACE,
    scenarioId,
    runId,
    nonce,
    avdName,
    avdPath,
    systemImage,
    markerPath,
  });
  const runtime = dependencies?.runtime;
  if (!runtime || typeof runtime.inspectAvds !== "function") {
    throw new Error("An AVD runtime inspector is required");
  }
  return { ownership, avdDefinitionPath, fs, runtime };
}

function lifecycleDependencies(dependencies) {
  const fs = dependencies?.fs ?? defaultFs;
  const runtime = dependencies?.runtime;
  if (
    !runtime
    || typeof runtime.inspectAvds !== "function"
    || typeof runtime.inspectEmulators !== "function"
  ) {
    throw new Error("AVD and emulator runtime inspectors are required");
  }
  return { fs, runtime };
}

async function readMarker(ownership, fs) {
  let stat;
  try {
    stat = await fs.lstat(ownership.markerPath);
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error(`Owned AVD marker is missing: ${ownership.markerPath}`);
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Owned AVD marker is not a regular file: ${ownership.markerPath}`);
  }
  if ((stat.mode & 0o777) !== 0o600) {
    throw new Error(`Owned AVD marker permissions must be 0600: ${ownership.markerPath}`);
  }
  let marker;
  try {
    marker = JSON.parse(await fs.readFile(ownership.markerPath, "utf8"));
  } catch (error) {
    throw new Error(`Owned AVD marker is unreadable: ${ownership.markerPath}`, { cause: error });
  }
  return marker;
}

async function readExactMarker(ownership, fs) {
  const marker = await readMarker(ownership, fs);
  const expected = markerForOwnership(ownership);
  if (!sameFlatObject(marker, expected)) {
    throw new Error(`Owned AVD marker fields do not exactly match ${ownership.markerPath}`);
  }
  return marker;
}

async function readTeardownMarker(ownership, fs) {
  const marker = await readMarker(ownership, fs);
  if (sameFlatObject(marker, markerForOwnership(ownership))) {
    return Object.freeze({ marker, phase: "bound" });
  }
  if (sameFlatObject(marker, deletionPendingMarker(ownership))) {
    return Object.freeze({ marker, phase: AVD_DELETE_PENDING_PHASE });
  }
  throw new Error(`Owned AVD teardown marker fields do not exactly match ${ownership.markerPath}`);
}

function exactAvdConfig(ownership) {
  return {
    avdName: ownership.avdName,
    avdPath: ownership.avdPath,
    systemImage: ownership.systemImage,
  };
}

async function inspectExactAvd(ownership, runtime) {
  const avds = await runtime.inspectAvds();
  if (!Array.isArray(avds)) throw new Error("AVD runtime inspection must return an array");
  const candidates = avds.filter((avd) => (
    avd?.avdName === ownership.avdName || avd?.avdPath === ownership.avdPath
  ));
  if (candidates.length !== 1) {
    throw new Error(
      candidates.length === 0
        ? `Owned AVD is missing: ${ownership.avdName}`
        : `Owned AVD identity is ambiguous: ${ownership.avdName}`,
    );
  }
  const avd = candidates[0];
  const expectedConfig = exactAvdConfig(ownership);
  if (
    avd.avdName !== ownership.avdName
    || avd.avdPath !== ownership.avdPath
    || avd.systemImage !== ownership.systemImage
    || !sameFlatObject(avd.config, expectedConfig)
  ) {
    throw new Error(`Owned AVD path, system image, or config mismatch: ${ownership.avdName}`);
  }
  return avd;
}

async function exactAvdPresence(ownership, runtime) {
  const avds = await runtime.inspectAvds();
  if (!Array.isArray(avds)) throw new Error("AVD runtime inspection must return an array");
  const candidates = avds.filter((avd) => (
    avd?.avdName === ownership.avdName || avd?.avdPath === ownership.avdPath
  ));
  if (candidates.length > 1) {
    throw new Error(`Owned AVD identity is ambiguous: ${ownership.avdName}`);
  }
  if (candidates.length === 0) return null;
  const avd = candidates[0];
  const expectedConfig = exactAvdConfig(ownership);
  if (
    avd.avdName !== ownership.avdName
    || avd.avdPath !== ownership.avdPath
    || avd.systemImage !== ownership.systemImage
    || !sameFlatObject(avd.config, expectedConfig)
  ) {
    throw new Error(`Owned AVD path, system image, or config mismatch: ${ownership.avdName}`);
  }
  return avd;
}

function emulatorCandidates(ownership, binding, emulators) {
  if (!Array.isArray(emulators)) throw new Error("Emulator runtime inspection must return an array");
  return emulators.filter((emulator) => (
    emulator?.avdName === ownership.avdName
    || emulator?.serial === binding.serial
    || emulator?.consolePort === binding.consolePort
    || emulator?.pid === binding.pid
  ));
}

async function inspectExactEmulatorIfPresent(ownership, binding, runtime) {
  const candidates = emulatorCandidates(ownership, binding, await runtime.inspectEmulators());
  if (candidates.length > 1) {
    throw new Error(`Owned emulator process identity is ambiguous: ${binding.serial}`);
  }
  if (candidates.length === 0) return null;
  const emulator = candidates[0];
  if (
    emulator.avdName !== ownership.avdName
    || emulator.serial !== binding.serial
    || emulator.consolePort !== binding.consolePort
    || emulator.pid !== binding.pid
    || emulator.processStartIdentity !== binding.processStartIdentity
  ) {
    throw new Error(`Owned emulator serial, console port, PID, or process start identity mismatch: ${binding.serial}`);
  }
  return emulator;
}

async function inspectExactEmulator(ownership, binding, runtime) {
  const emulator = await inspectExactEmulatorIfPresent(ownership, binding, runtime);
  if (!emulator) throw new Error(`Owned emulator process is missing: ${binding.serial}`);
  return emulator;
}

async function verifySnapshot(ownership, dependencies, processBinding = undefined) {
  assertGeneratedOwnershipIdentity(ownership);
  const { fs, runtime } = lifecycleDependencies(dependencies);
  const marker = await readExactMarker(ownership, fs);
  const avd = await inspectExactAvd(ownership, runtime);
  const binding = processBinding ?? (hasProcessBinding(ownership) ? normalizedProcessBinding(ownership) : null);
  const emulator = binding ? await inspectExactEmulator(ownership, binding, runtime) : null;
  return Object.freeze({ marker, avd, emulator });
}

function defineHiddenRecovery(error, property, value) {
  if (!(error instanceof Error)) return;
  Object.defineProperty(error, property, {
    value,
    enumerable: false,
    writable: false,
    configurable: false,
  });
}

async function annotatePersistedBindError(error, bound, dependencies) {
  const { fs } = lifecycleDependencies(dependencies);
  try {
    await readExactMarker(bound, fs);
  } catch {
    return;
  }
  try {
    await verifySnapshot(bound, dependencies);
    defineHiddenRecovery(error, "recoveredBoundOwnership", bound);
  } catch {
    defineHiddenRecovery(error, "bindOwnershipIndeterminate", true);
  }
}

const UNSUPPORTED_DIRECTORY_SYNC_CODES = new Set([
  "EACCES",
  "EBADF",
  "EISDIR",
  "EINVAL",
  "ENOTSUP",
  "EPERM",
]);

async function syncDirectoryIfAvailable(fs, directoryPath) {
  let directoryHandle;
  try {
    directoryHandle = await fs.open(directoryPath, "r");
    await directoryHandle.sync();
  } catch (error) {
    if (!UNSUPPORTED_DIRECTORY_SYNC_CODES.has(error?.code)) throw error;
  } finally {
    await directoryHandle?.close();
  }
}

async function removeOwnedUpdateArtifact(fs, pathname) {
  try {
    await fs.rm(pathname, { force: true });
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function readMarkerUpdateLockAt(ownership, fs, pathname) {
  let details;
  try {
    details = await fs.lstat(pathname);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  if (!details.isFile() || details.isSymbolicLink() || (details.mode & 0o777) !== 0o600) {
    throw new Error(`Owned AVD marker update lock is ambiguous: ${pathname}`);
  }
  let record;
  try {
    record = JSON.parse(await fs.readFile(pathname, "utf8"));
  } catch (error) {
    throw new Error(`Owned AVD marker update lock is unreadable: ${pathname}`, { cause: error });
  }
  const expectedBase = {
    version: AVD_OWNERSHIP_VERSION,
    toolNamespace: MARKER_UPDATE_LOCK_NAMESPACE,
    avdName: ownership.avdName,
    markerPath: ownership.markerPath,
  };
  const keys = Object.keys(record ?? {}).sort();
  const expectedKeys = [...Object.keys(expectedBase), "ownerPid", "ownerProcessStartIdentity"].sort();
  if (
    JSON.stringify(keys) !== JSON.stringify(expectedKeys)
    || Object.entries(expectedBase).some(([key, value]) => record[key] !== value)
  ) {
    throw new Error(`Owned AVD marker update lock fields are ambiguous: ${pathname}`);
  }
  const owner = normalizedMarkerUpdateOwner({
    pid: record.ownerPid,
    processStartIdentity: record.ownerProcessStartIdentity,
  });
  return Object.freeze({ record, owner });
}

async function inspectMarkerUpdateOwner(owner, runtime) {
  if (typeof runtime.inspectMarkerUpdateOwner !== "function") {
    throw new Error("Marker update owner inspection is required");
  }
  const observed = await runtime.inspectMarkerUpdateOwner(owner);
  if (observed === null || observed === undefined) return "absent";
  if (!observed || typeof observed !== "object" || observed.alive !== true) {
    throw new Error("Marker update owner inspection is ambiguous");
  }
  const live = normalizedMarkerUpdateOwner(observed, "observed marker update owner");
  if (live.pid !== owner.pid) {
    throw new Error("Marker update owner inspection is ambiguous");
  }
  if (live.processStartIdentity !== owner.processStartIdentity) {
    throw new Error("Marker update owner PID was reused");
  }
  return "active";
}

async function recoverStaleMarkerUpdateLock(ownership, dependencies) {
  const { fs, runtime } = lifecycleDependencies(dependencies);
  if (typeof fs.rename !== "function" || typeof fs.rm !== "function") {
    throw new Error("Marker update lock recovery requires filesystem rename and removal operations");
  }
  const lockPath = `${ownership.markerPath}.update.lock`;
  const initial = await readMarkerUpdateLockAt(ownership, fs, lockPath);
  if (!initial) return false;
  const state = await inspectMarkerUpdateOwner(initial.owner, runtime);
  if (state === "active") {
    throw new Error(`Owned AVD marker update owner is still active: ${lockPath}`);
  }

  const quarantinePath = `${lockPath}.stale-${randomUUID()}.tmp`;
  await fs.rename(lockPath, quarantinePath);
  try {
    const quarantined = await readMarkerUpdateLockAt(ownership, fs, quarantinePath);
    if (!quarantined || !sameFlatObject(quarantined.record, initial.record)) {
      throw new Error(`Owned AVD marker update lock changed during recovery: ${lockPath}`);
    }
    const rechecked = await inspectMarkerUpdateOwner(quarantined.owner, runtime);
    if (rechecked === "active") {
      throw new Error(`Owned AVD marker update owner became active during recovery: ${lockPath}`);
    }
    await fs.rm(quarantinePath);
    await syncDirectoryIfAvailable(fs, path.dirname(lockPath));
    return true;
  } catch (error) {
    // Preserve the exact quarantined evidence on any ambiguous re-check.
    throw error;
  }
}

async function publishMarkerUpdateLock(ownership, dependencies) {
  const { fs, runtime } = lifecycleDependencies(dependencies);
  if (
    typeof fs.open !== "function"
    || typeof fs.link !== "function"
    || typeof fs.rm !== "function"
  ) {
    throw new Error("Atomic marker update lock publication requires filesystem open, link, and removal operations");
  }
  if (typeof runtime.getMarkerUpdateOwner !== "function") {
    throw new Error("Current marker update owner identity is required");
  }
  const owner = normalizedMarkerUpdateOwner(await runtime.getMarkerUpdateOwner());
  const lockPath = `${ownership.markerPath}.update.lock`;
  const candidatePath = `${lockPath}.candidate-${randomUUID()}.tmp`;
  const record = markerUpdateLockRecord(ownership, owner);
  let candidateHandle;
  let candidatePresent = false;
  let ownsLock = false;
  let publishSucceeded = false;
  try {
    candidateHandle = await fs.open(candidatePath, "wx", 0o600);
    candidatePresent = true;
    await candidateHandle.chmod(0o600);
    await candidateHandle.writeFile(`${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8" });
    await candidateHandle.sync();
    await candidateHandle.close();
    candidateHandle = undefined;

    try {
      await fs.link(candidatePath, lockPath);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      await recoverStaleMarkerUpdateLock(ownership, dependencies);
      try {
        await fs.link(candidatePath, lockPath);
      } catch (retryError) {
        if (retryError?.code === "EEXIST") {
          throw new Error(`Owned AVD marker update is already in progress: ${ownership.markerPath}`);
        }
        throw retryError;
      }
    }
    ownsLock = true;
    await fs.rm(candidatePath);
    candidatePresent = false;
    await syncDirectoryIfAvailable(fs, path.dirname(lockPath));
    const published = await readMarkerUpdateLockAt(ownership, fs, lockPath);
    if (!published || !sameFlatObject(published.record, record)) {
      throw new Error(`Owned AVD marker update lock changed during publication: ${lockPath}`);
    }
    publishSucceeded = true;
    return lockPath;
  } finally {
    await candidateHandle?.close();
    if (candidatePresent) await removeOwnedUpdateArtifact(fs, candidatePath);
    if (ownsLock && !publishSucceeded) {
      // A later step failed after we acquired the lock. Release the lock we
      // own, but never remove a lock a different owner now holds.
      const current = await readMarkerUpdateLockAt(ownership, fs, lockPath).catch(() => null);
      if (current && sameFlatObject(current.record, record)) {
        await removeOwnedUpdateArtifact(fs, lockPath);
      }
    }
  }
}

async function writeMarkerAtomically({ ownership, marker, dependencies, verifyBefore, verifyAfter }) {
  const { fs } = lifecycleDependencies(dependencies);
  if (
    typeof fs.open !== "function"
    || typeof fs.link !== "function"
    || typeof fs.rename !== "function"
    || typeof fs.rm !== "function"
  ) {
    throw new Error("Atomic marker update requires filesystem open, rename, and removal operations");
  }
  const lockPath = `${ownership.markerPath}.update.lock`;
  const tempPath = `${ownership.markerPath}.update-${randomUUID()}.tmp`;
  const contents = `${JSON.stringify(marker, null, 2)}\n`;
  let tempHandle;
  let ownsLock = false;
  let ownsTemp = false;

  try {
    await publishMarkerUpdateLock(ownership, dependencies);
    ownsLock = true;

    // Serialize writers, then re-check the exact old marker and the resource
    // state before constructing the replacement.
    await verifyBefore();

    tempHandle = await fs.open(tempPath, "wx", 0o600);
    ownsTemp = true;
    await tempHandle.chmod(0o600);
    await tempHandle.writeFile(contents, { encoding: "utf8" });
    await tempHandle.sync();
    await tempHandle.close();
    tempHandle = undefined;

    // The rename is the first mutation of the ownership marker. Revalidate
    // immediately before it even though cooperating writers hold the lock.
    await verifyBefore();
    await fs.rename(tempPath, ownership.markerPath);
    ownsTemp = false;
    await syncDirectoryIfAvailable(fs, path.dirname(ownership.markerPath));
    await verifyAfter();
  } finally {
    await tempHandle?.close();
    if (ownsTemp) await removeOwnedUpdateArtifact(fs, tempPath);
    if (ownsLock) await removeOwnedUpdateArtifact(fs, lockPath);
  }
}

async function replaceMarkerAtomically(ownership, bound, binding, dependencies) {
  return writeMarkerAtomically({
    ownership,
    marker: markerForOwnership(bound),
    dependencies,
    verifyBefore: () => verifySnapshot(ownership, dependencies, binding),
    verifyAfter: () => verifySnapshot(bound, dependencies),
  });
}

async function persistDeletionPending(ownership, processIdentity, dependencies) {
  const { fs, runtime } = lifecycleDependencies(dependencies);
  const verifyStoppedBoundState = async () => {
    await readExactMarker(ownership, fs);
    await inspectExactAvd(ownership, runtime);
    await runtime.assertEmulatorAbsent(processIdentity);
  };
  return writeMarkerAtomically({
    ownership,
    marker: deletionPendingMarker(ownership),
    dependencies,
    verifyBefore: verifyStoppedBoundState,
    verifyAfter: async () => {
      const state = await readTeardownMarker(ownership, fs);
      if (state.phase !== AVD_DELETE_PENDING_PHASE) {
        throw new Error(`Owned AVD marker did not enter deletion-pending phase: ${ownership.markerPath}`);
      }
      await inspectExactAvd(ownership, runtime);
      await runtime.assertEmulatorAbsent(processIdentity);
    },
  });
}

async function assertExactAvdAbsent(ownership, fs, runtime) {
  const candidate = await exactAvdPresence(ownership, runtime);
  if (candidate) {
    throw new Error(`Owned AVD still exists; teardown did not prove absence: ${ownership.avdName}`);
  }
  const definitionPath = path.join(path.dirname(ownership.avdPath), `${ownership.avdName}.ini`);
  for (const pathname of [ownership.avdPath, definitionPath]) {
    if (await pathExists(fs, pathname)) {
      throw new Error(`Owned AVD path still exists; teardown did not prove absence: ${pathname}`);
    }
  }
}

export async function reserveAvdOwnership(input, dependencies = {}) {
  const { ownership, avdDefinitionPath, fs, runtime } = await reservationContext(input, dependencies);
  const avds = await runtime.inspectAvds();
  if (!Array.isArray(avds)) throw new Error("AVD runtime inspection must return an array");
  if (avds.some((avd) => avd?.avdName === ownership.avdName || avd?.name === ownership.avdName)) {
    throw new Error(`Refusing reservation because generated AVD name already exists: ${ownership.avdName}`);
  }
  if (await pathExists(fs, ownership.avdPath)) {
    throw new Error(`Refusing reservation because generated AVD path already exists: ${ownership.avdPath}`);
  }
  if (await pathExists(fs, avdDefinitionPath)) {
    throw new Error(`Refusing reservation because generated AVD name already exists: ${avdDefinitionPath}`);
  }
  if (await pathExists(fs, ownership.markerPath)) {
    throw new Error(`Refusing reservation because ownership marker already exists: ${ownership.markerPath}`);
  }
  try {
    await fs.writeFile(
      ownership.markerPath,
      `${JSON.stringify(baseMarker(ownership), null, 2)}\n`,
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    );
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw new Error(`Refusing reservation because ownership marker was claimed concurrently: ${ownership.markerPath}`);
    }
    throw error;
  }
  await fs.chmod(ownership.markerPath, 0o600);
  await readExactMarker(ownership, fs);
  return ownership;
}

export function createOwnedEmulatorLaunchPlan(ownership, options = {}) {
  if (Object.hasOwn(options, "avdName")) {
    throw new Error("Refusing caller-authored AVD name in emulator launch options");
  }
  assertGeneratedOwnershipIdentity(ownership);
  const executable = options.emulatorBinary === undefined
    ? "emulator"
    : requiredString(options.emulatorBinary, "emulatorBinary");
  return Object.freeze({
    executable,
    args: Object.freeze([
      "-avd",
      ownership.avdName,
      "-no-snapshot-save",
      "-no-audio",
      "-no-boot-anim",
      "-vsync-rate",
      "30",
    ]),
    avdName: ownership.avdName,
  });
}

export async function verifyOwnedAvd(ownership, dependencies = {}) {
  return verifySnapshot(ownership, dependencies);
}

export async function bindAvdProcess(ownership, processBinding, dependencies = {}) {
  assertGeneratedOwnershipIdentity(ownership);
  if (hasProcessBinding(ownership)) {
    throw new Error(`Owned AVD is already bound to an emulator process: ${ownership.avdName}`);
  }
  const binding = normalizedProcessBinding(processBinding);
  lifecycleDependencies(dependencies);
  await verifySnapshot(ownership, dependencies, binding);
  const bound = Object.freeze({ ...ownership, ...binding });
  try {
    await replaceMarkerAtomically(ownership, bound, binding, dependencies);
    return bound;
  } catch (error) {
    await annotatePersistedBindError(error, bound, dependencies);
    throw error;
  }
}

export async function assertOwnedAvdReady(ownership, dependencies = {}) {
  assertGeneratedOwnershipIdentity(ownership);
  if (!hasProcessBinding(ownership)) {
    throw new Error(`Owned AVD has not been bound to an emulator process: ${ownership.avdName}`);
  }
  const verification = await verifySnapshot(ownership, dependencies);
  if (verification.emulator?.ready !== true) {
    throw new Error(`Owned emulator is not ready: ${ownership.serial}`);
  }
  return verification;
}

export async function teardownOwnedAvd(ownership, dependencies = {}) {
  assertGeneratedOwnershipIdentity(ownership);
  if (!hasProcessBinding(ownership)) {
    throw new Error(`Refusing to tear down unbound AVD ownership: ${ownership.avdName}`);
  }
  const binding = normalizedProcessBinding(ownership);
  const { fs, runtime } = lifecycleDependencies(dependencies);
  if (
    typeof runtime.killEmulator !== "function"
    || typeof runtime.deleteAvd !== "function"
    || typeof runtime.assertEmulatorAbsent !== "function"
  ) {
    throw new Error("Exact emulator kill, absence proof, and AVD deletion operations are required");
  }
  const processIdentity = Object.freeze({
    avdName: ownership.avdName,
    ...binding,
  });
  const avdIdentity = Object.freeze({
    avdName: ownership.avdName,
    avdPath: ownership.avdPath,
    systemImage: ownership.systemImage,
  });

  const teardownMarker = await readTeardownMarker(ownership, fs);
  if (teardownMarker.phase === "bound") {
    // A retry can arrive after the exact child was stopped but before the
    // durable phase transition. A present candidate must still match every
    // bound field before it can be signaled; an absent candidate is never
    // replaced by a PID-only lookup.
    await inspectExactAvd(ownership, runtime);
    const emulator = await inspectExactEmulatorIfPresent(ownership, binding, runtime);
    if (emulator) await runtime.killEmulator(processIdentity);
    await runtime.assertEmulatorAbsent(processIdentity);
    await persistDeletionPending(ownership, processIdentity, dependencies);
  } else {
    await recoverStaleMarkerUpdateLock(ownership, dependencies);
    const recoveredMarker = await readTeardownMarker(ownership, fs);
    if (recoveredMarker.phase !== AVD_DELETE_PENDING_PHASE) {
      throw new Error(`Owned AVD marker changed during deletion-pending recovery: ${ownership.markerPath}`);
    }
    await runtime.assertEmulatorAbsent(processIdentity);
  }

  const avd = await exactAvdPresence(ownership, runtime);
  if (avd) {
    // The runtime repeats the emulator-absence proof immediately before its
    // avdmanager mutation. The phase marker remains if that mutation fails.
    await runtime.deleteAvd(avdIdentity, processIdentity);
  }
  await recoverStaleMarkerUpdateLock(ownership, dependencies);
  const finalMarker = await readTeardownMarker(ownership, fs);
  if (finalMarker.phase !== AVD_DELETE_PENDING_PHASE) {
    throw new Error(`Owned AVD marker changed before final removal: ${ownership.markerPath}`);
  }
  // Keep exact AVD/path absence as the final asynchronous proof immediately
  // before ownership evidence is removed.
  await assertExactAvdAbsent(ownership, fs, runtime);
  await fs.rm(ownership.markerPath);

  return Object.freeze({
    action: "deleted",
    avdName: ownership.avdName,
    serial: binding.serial,
  });
}
