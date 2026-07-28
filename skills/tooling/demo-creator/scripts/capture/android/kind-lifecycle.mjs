import { createHash, randomUUID as defaultRandomUUID } from "node:crypto";
import * as defaultFileSystem from "node:fs/promises";
import path from "node:path";

const MARKER_VERSION = 1;
const TOOL_NAMESPACE = "acp.demo-creator.android.kind";
const MARKER_UPDATE_LOCK_NAMESPACE = `${TOOL_NAMESPACE}.marker-update`;
const RESERVED_MARKER_KEYS = Object.freeze([
  "clusterName",
  "nonce",
  "runId",
  "scenarioId",
  "toolNamespace",
  "version",
]);
const BOUND_MARKER_KEYS = Object.freeze([
  ...RESERVED_MARKER_KEYS,
  "containerIdentities",
  "kubeContext",
  "kubeServer",
].sort());
const KIND_DELETE_PENDING_PHASE = "kind-delete-pending";
const DELETION_PENDING_MARKER_KEYS = Object.freeze([
  ...BOUND_MARKER_KEYS,
  "teardownPhase",
].sort());
const CREATION_TRANSACTIONS = new WeakMap();
const BOUND_MARKER_FILE_IDENTITY = Symbol("bound Kind marker file identity");

function own(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function requireRecord(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value;
}

function requireNonEmptyString(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}

function slug(value, name) {
  const normalized = requireNonEmptyString(value, name)
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!normalized) throw new Error(`${name} must contain an ASCII letter or digit`);
  return normalized;
}

function generatedClusterName(scenarioId, runId, nonce) {
  const parts = [
    slug(scenarioId, "scenarioId"),
    slug(runId, "runId"),
    slug(nonce, "nonce"),
  ];
  const fullName = `acp-demo-${parts.join("-")}`;
  if (fullName.length <= 63) return fullName;

  const digest = createHash("sha256")
    .update(parts.join("\0"))
    .digest("hex")
    .slice(0, 10);
  return `acp-demo-${parts[0].slice(0, 12)}-${parts[1].slice(0, 10)}-${parts[2].slice(0, 16)}-${digest}`;
}

function expectedKubeContext(clusterName) {
  return `kind-${clusterName}`;
}

function isWithin(parentPath, candidatePath) {
  const relative = path.relative(parentPath, candidatePath);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

async function canonicalDirectoryRoot(fs, value) {
  const authoredRoot = requireNonEmptyString(value, "markerRoot");
  const resolvedRoot = path.resolve(authoredRoot);
  if (authoredRoot !== resolvedRoot) {
    throw new Error(`markerRoot must be canonical and absolute: ${authoredRoot}`);
  }
  let canonicalRoot;
  try {
    canonicalRoot = await fs.realpath(resolvedRoot);
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error(`markerRoot must already exist: ${resolvedRoot}`);
    throw error;
  }
  if (canonicalRoot !== resolvedRoot || path.resolve(canonicalRoot) !== canonicalRoot) {
    throw new Error(`markerRoot must be canonical; symlink aliases are not accepted: ${resolvedRoot}`);
  }
  const rootStat = await fs.lstat(canonicalRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`markerRoot must be a directory: ${canonicalRoot}`);
  }
  return canonicalRoot;
}

function derivedMarkerPath(markerRoot, clusterName) {
  const candidate = path.join(markerRoot, `${clusterName}.owner.json`);
  if (path.dirname(candidate) !== markerRoot || !isWithin(markerRoot, candidate)) {
    throw new Error("Generated Kind ownership marker escaped its canonical root");
  }
  return candidate;
}

function fileSystem(options) {
  return options.fs ?? defaultFileSystem;
}

function inspectFunction(options) {
  if (typeof options.inspectKindCluster !== "function") {
    throw new Error("inspectKindCluster dependency is required");
  }
  return options.inspectKindCluster;
}

function markerJson(marker) {
  return `${JSON.stringify(marker, null, 2)}\n`;
}

function markerResult(markerRoot, markerPath, marker, extra = {}, markerFileIdentity = undefined) {
  const result = { markerRoot, markerPath, ...marker, ...extra };
  if (markerFileIdentity !== undefined) {
    Object.defineProperty(result, BOUND_MARKER_FILE_IDENTITY, {
      value: markerFileIdentity,
      enumerable: false,
      writable: false,
      configurable: false,
    });
  }
  return Object.freeze(result);
}

function boundMarkerFileIdentity(ownership) {
  const identity = ownership?.[BOUND_MARKER_FILE_IDENTITY];
  if (typeof identity !== "string" || identity === "") {
    throw new Error("Bound Kind ownership proof omitted its private marker file identity");
  }
  return identity;
}

function canonicalContainerIdentities(value, name) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${name} must be a non-empty array`);
  }
  const identities = value.map((identity, index) => requireNonEmptyString(identity, `${name}[${index}]`));
  if (new Set(identities).size !== identities.length) {
    throw new Error(`${name} is ambiguous because it contains duplicates`);
  }
  return identities.toSorted();
}

function uniqueStringList(value, name) {
  if (!Array.isArray(value)) {
    throw new Error(`${name} must be an array`);
  }
  const items = value.map((item, index) => requireNonEmptyString(item, `${name}[${index}]`));
  if (new Set(items).size !== items.length) {
    throw new Error(`${name} is ambiguous because it contains duplicates`);
  }
  return items;
}

function kindClusterNames(inspection) {
  return uniqueStringList(inspection.kindClusterNames, "Kind inspection kindClusterNames");
}

function kubeContexts(inspection) {
  return uniqueStringList(inspection.kubeContexts, "Kind inspection kubeContexts");
}

function assertMarkerKeys(marker, expectedKeys) {
  const keys = Object.keys(marker).sort();
  if (JSON.stringify(keys) !== JSON.stringify(expectedKeys)) {
    throw new Error(`Kind ownership marker fields are invalid: ${keys.join(", ")}`);
  }
}

function assertReservation(reservation) {
  requireRecord(reservation, "Kind ownership reservation");
  const scenarioId = requireNonEmptyString(reservation.scenarioId, "Kind ownership reservation scenarioId");
  const runId = requireNonEmptyString(reservation.runId, "Kind ownership reservation runId");
  const nonce = requireNonEmptyString(reservation.nonce, "Kind ownership reservation nonce");
  const clusterName = generatedClusterName(scenarioId, runId, nonce);
  const markerRoot = requireNonEmptyString(
    reservation.markerRoot,
    "Kind ownership reservation markerRoot",
  );
  if (markerRoot !== path.resolve(markerRoot)) {
    throw new Error("Kind ownership reservation markerRoot must be canonical and absolute");
  }
  const markerPath = derivedMarkerPath(markerRoot, clusterName);
  if (reservation.markerPath !== markerPath) {
    throw new Error("Kind ownership reservation markerPath mismatch");
  }
  if (reservation.version !== MARKER_VERSION) {
    throw new Error("Kind ownership reservation version mismatch");
  }
  if (reservation.toolNamespace !== TOOL_NAMESPACE) {
    throw new Error("Kind ownership reservation toolNamespace mismatch");
  }
  if (reservation.clusterName !== clusterName) {
    throw new Error("Kind ownership reservation clusterName mismatch");
  }
  if (reservation.kubeContext !== undefined && reservation.kubeContext !== expectedKubeContext(clusterName)) {
    throw new Error("Kind ownership reservation kubeContext mismatch");
  }
  return { markerRoot, markerPath, scenarioId, runId, nonce, clusterName };
}

function assertMarkerIdentity(marker, reservation, { bound, deletionPending = false }) {
  if (deletionPending && !bound) {
    throw new Error("A Kind deletion-pending marker must be bound");
  }
  assertMarkerKeys(
    marker,
    deletionPending
      ? DELETION_PENDING_MARKER_KEYS
      : (bound ? BOUND_MARKER_KEYS : RESERVED_MARKER_KEYS),
  );
  if (marker.version !== MARKER_VERSION) throw new Error("Kind ownership marker version mismatch");
  if (marker.toolNamespace !== TOOL_NAMESPACE) throw new Error("Kind ownership marker toolNamespace mismatch");

  for (const field of ["scenarioId", "runId", "nonce", "clusterName"]) {
    if (marker[field] !== reservation[field]) {
      throw new Error(`Kind ownership marker ${field} mismatch`);
    }
  }
  if (marker.clusterName !== generatedClusterName(marker.scenarioId, marker.runId, marker.nonce)) {
    throw new Error("Kind ownership marker clusterName is not generated from its identity fields");
  }

  if (bound) {
    if (marker.kubeContext !== expectedKubeContext(marker.clusterName)) {
      throw new Error("Kind ownership marker kubeContext mismatch");
    }
    requireNonEmptyString(marker.kubeServer, "Kind ownership marker kubeServer");
    const canonical = canonicalContainerIdentities(
      marker.containerIdentities,
      "Kind ownership marker containerIdentities",
    );
    if (JSON.stringify(marker.containerIdentities) !== JSON.stringify(canonical)) {
      throw new Error("Kind ownership marker containerIdentities are not canonical");
    }
  }
  if (deletionPending && marker.teardownPhase !== KIND_DELETE_PENDING_PHASE) {
    throw new Error("Kind ownership marker deletion-pending phase mismatch");
  }
  return marker;
}

async function readMarker(markerPath, fs) {
  let source;
  let markerStat;
  try {
    [source, markerStat] = await Promise.all([
      fs.readFile(markerPath, "utf8"),
      fs.lstat(markerPath),
    ]);
  } catch (error) {
    throw new Error(`Unable to read Kind ownership marker ${markerPath}: ${error.message}`, { cause: error });
  }
  if (typeof markerStat.isFile === "function" && !markerStat.isFile()) {
    throw new Error(`Kind ownership marker ${markerPath} is not a regular file`);
  }
  if ((markerStat.mode & 0o777) !== 0o600) {
    throw new Error(`Kind ownership marker ${markerPath} must have mode 0600`);
  }
  try {
    return requireRecord(JSON.parse(source), "Kind ownership marker");
  } catch (error) {
    throw new Error(`Kind ownership marker ${markerPath} is invalid: ${error.message}`, { cause: error });
  }
}

function markerFileIdentity(details) {
  if (
    !Number.isSafeInteger(details?.dev)
    || details.dev < 0
    || !Number.isSafeInteger(details?.ino)
    || details.ino < 1
    || !Number.isFinite(details?.ctimeMs)
  ) {
    throw new Error("Kind ownership marker file identity is unavailable");
  }
  return `${details.dev}:${details.ino}:${details.ctimeMs}`;
}

function markerFileNodeIdentity(details) {
  if (
    !Number.isSafeInteger(details?.dev)
    || details.dev < 0
    || !Number.isSafeInteger(details?.ino)
    || details.ino < 1
  ) {
    throw new Error("Kind marker file node identity is unavailable");
  }
  return `${details.dev}:${details.ino}`;
}

async function readMarkerSnapshot(markerPath, fs) {
  const before = markerFileIdentity(await fs.lstat(markerPath));
  const marker = await readMarker(markerPath, fs);
  const after = markerFileIdentity(await fs.lstat(markerPath));
  if (before !== after) {
    throw new Error("Kind ownership marker was replaced during inspection");
  }
  return Object.freeze({ marker, fileIdentity: before });
}

async function createMarkerExclusively(markerPath, marker, fs, nonceGenerator) {
  if (typeof fs.link !== "function") {
    throw new Error("Atomic Kind ownership reservation requires filesystem hard-link publication");
  }
  const reservationNonce = requireNonEmptyString(
    nonceGenerator(),
    "generated reservation publication nonce",
  );
  const reservationId = createHash("sha256").update(reservationNonce).digest("hex").slice(0, 16);
  const candidatePath = `${markerPath}.reserve.${reservationId}.tmp`;
  let handle;
  let candidatePresent = false;
  let published = false;
  let candidateFileIdentity;
  let primaryError;
  try {
    handle = await fs.open(candidatePath, "wx", 0o600);
    candidatePresent = true;
    await handle.chmod(0o600);
    await handle.writeFile(markerJson(marker), "utf8");
    if (typeof handle.sync === "function") await handle.sync();
    candidateFileIdentity = markerFileIdentity(await handle.stat());
    await handle.close();
    handle = undefined;
    try {
      await fs.link(candidatePath, markerPath);
      published = true;
    } catch (error) {
      if (error?.code === "EEXIST") {
        throw new Error(`Kind ownership marker already exists at ${markerPath}`, { cause: error });
      }
      throw error;
    }
    // Creating the hard link can update inode ctime. Refresh the candidate's
    // identity after publication, then require the destination to be that same
    // inode rather than comparing against the pre-link ctime snapshot.
    candidateFileIdentity = markerFileIdentity(await fs.lstat(candidatePath));
    if (markerFileIdentity(await fs.lstat(markerPath)) !== candidateFileIdentity) {
      throw new Error("Kind ownership reservation publication changed file identity");
    }
    await fs.unlink(candidatePath);
    candidatePresent = false;
    candidateFileIdentity = markerFileIdentity(await fs.lstat(markerPath));
    await syncDirectoryIfSupported(fs, path.dirname(markerPath));
  } catch (error) {
    primaryError = error;
  }

  const cleanupErrors = [];
  if (handle) {
    try {
      await handle.close();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (candidatePresent) {
    try {
      await removeIfPresent(fs, candidatePath);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (primaryError && published) {
    try {
      const publishedIdentity = markerFileIdentity(await fs.lstat(markerPath));
      if (publishedIdentity !== candidateFileIdentity) {
        throw new Error("Refusing to remove a replaced Kind ownership reservation marker");
      }
      await fs.unlink(markerPath);
      await syncDirectoryIfSupported(fs, path.dirname(markerPath));
    } catch (error) {
      if (error?.code !== "ENOENT") cleanupErrors.push(error);
    }
  }
  if (primaryError) {
    if (cleanupErrors.length > 0) {
      throw new AggregateError([primaryError, ...cleanupErrors], primaryError.message);
    }
    throw primaryError;
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, `Unable to clean Kind reservation candidate ${candidatePath}`);
  }
}

async function removeIfPresent(fs, pathname) {
  try {
    await fs.unlink(pathname);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function syncDirectoryIfSupported(fs, directory) {
  let handle;
  try {
    handle = await fs.open(directory, "r");
    if (typeof handle.sync === "function") await handle.sync();
  } catch (error) {
    if (!["EBADF", "EINVAL", "EISDIR", "ENOTSUP", "EPERM"].includes(error?.code)) throw error;
  } finally {
    if (handle) await handle.close();
  }
}

function normalizedMarkerUpdateOwner(value, name = "Kind marker update owner") {
  requireRecord(value, name);
  if (!Number.isSafeInteger(value.pid) || value.pid < 1) {
    throw new Error(`${name} pid must be a positive integer`);
  }
  return Object.freeze({
    pid: value.pid,
    processStartIdentity: requireNonEmptyString(
      value.processStartIdentity,
      `${name} processStartIdentity`,
    ),
  });
}

function markerUpdateLockRecord(ownership, owner) {
  return Object.freeze({
    version: MARKER_VERSION,
    toolNamespace: MARKER_UPDATE_LOCK_NAMESPACE,
    clusterName: ownership.clusterName,
    markerPath: ownership.markerPath,
    ownerPid: owner.pid,
    ownerProcessStartIdentity: owner.processStartIdentity,
  });
}

function sameFlatRecord(actual, expected) {
  if (!actual || typeof actual !== "object" || Array.isArray(actual)) return false;
  const keys = Object.keys(actual).sort();
  const expectedKeys = Object.keys(expected).sort();
  return JSON.stringify(keys) === JSON.stringify(expectedKeys)
    && expectedKeys.every((key) => actual[key] === expected[key]);
}

async function readMarkerUpdateLockAt(ownership, fs, lockPath) {
  let beforeDetails;
  try {
    beforeDetails = await fs.lstat(lockPath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  if (
    (typeof beforeDetails.isFile === "function" && !beforeDetails.isFile())
    || (typeof beforeDetails.isSymbolicLink === "function" && beforeDetails.isSymbolicLink())
    || (beforeDetails.mode & 0o777) !== 0o600
  ) {
    throw new Error(`Kind marker update lock is not one mode-0600 regular file: ${lockPath}`);
  }
  const beforeIdentity = markerFileIdentity(beforeDetails);
  const nodeIdentity = markerFileNodeIdentity(beforeDetails);
  let record;
  try {
    record = requireRecord(JSON.parse(await fs.readFile(lockPath, "utf8")), "Kind marker update lock");
  } catch (error) {
    throw new Error(`Kind marker update lock is unreadable: ${lockPath}`, { cause: error });
  }
  const expectedBase = {
    version: MARKER_VERSION,
    toolNamespace: MARKER_UPDATE_LOCK_NAMESPACE,
    clusterName: ownership.clusterName,
    markerPath: ownership.markerPath,
  };
  const expectedKeys = [...Object.keys(expectedBase), "ownerPid", "ownerProcessStartIdentity"].sort();
  if (
    JSON.stringify(Object.keys(record).sort()) !== JSON.stringify(expectedKeys)
    || Object.entries(expectedBase).some(([key, value]) => record[key] !== value)
  ) {
    throw new Error(`Kind marker update lock fields are ambiguous: ${lockPath}`);
  }
  const owner = normalizedMarkerUpdateOwner({
    pid: record.ownerPid,
    processStartIdentity: record.ownerProcessStartIdentity,
  });
  const afterIdentity = markerFileIdentity(await fs.lstat(lockPath));
  if (afterIdentity !== beforeIdentity) {
    throw new Error(`Kind marker update lock changed during inspection: ${lockPath}`);
  }
  return Object.freeze({ record, owner, fileIdentity: beforeIdentity, nodeIdentity });
}

async function markerUpdateOwnerState(owner, options) {
  if (typeof options.inspectMarkerUpdateOwner !== "function") {
    throw new Error("inspectMarkerUpdateOwner dependency is required for Kind lock recovery");
  }
  const observed = await options.inspectMarkerUpdateOwner(owner);
  if (observed === null || observed === undefined) return "stale";
  requireRecord(observed, "Observed Kind marker update owner");
  if (observed.alive !== true) {
    throw new Error("Observed Kind marker update owner state is ambiguous");
  }
  const live = normalizedMarkerUpdateOwner(observed, "Observed Kind marker update owner");
  if (live.pid !== owner.pid) {
    throw new Error("Observed Kind marker update owner pid is ambiguous");
  }
  return live.processStartIdentity === owner.processStartIdentity ? "active" : "stale";
}

async function recoverStaleMarkerUpdateLock(ownership, fs, options, nonceGenerator) {
  const lockPath = `${ownership.markerPath}.update.lock`;
  const initial = await readMarkerUpdateLockAt(ownership, fs, lockPath);
  if (!initial) return false;
  if (await markerUpdateOwnerState(initial.owner, options) === "active") {
    throw new Error(
      `Kind ownership marker update already in progress; owner is still active: ${ownership.markerPath}`,
    );
  }
  const recoveryNonce = requireNonEmptyString(
    nonceGenerator(),
    "generated marker lock recovery nonce",
  );
  const recoveryId = createHash("sha256").update(recoveryNonce).digest("hex").slice(0, 16);
  const quarantinePath = `${lockPath}.stale.${recoveryId}.tmp`;
  await fs.rename(lockPath, quarantinePath);
  const quarantined = await readMarkerUpdateLockAt(ownership, fs, quarantinePath);
  if (
    !quarantined
    || quarantined.nodeIdentity !== initial.nodeIdentity
    || !sameFlatRecord(quarantined.record, initial.record)
  ) {
    throw new Error(`Kind marker update lock changed during stale recovery: ${lockPath}`);
  }
  if (await markerUpdateOwnerState(quarantined.owner, options) === "active") {
    throw new Error(`Kind marker update lock owner became active during stale recovery: ${lockPath}`);
  }
  await fs.unlink(quarantinePath);
  await syncDirectoryIfSupported(fs, path.dirname(lockPath));
  return true;
}

async function publishMarkerUpdateLock(ownership, fs, options, nonceGenerator) {
  if (typeof options.getMarkerUpdateOwner !== "function") {
    throw new Error("getMarkerUpdateOwner dependency is required for Kind marker updates");
  }
  if (typeof fs.link !== "function" || typeof fs.rename !== "function") {
    throw new Error("Kind marker update locks require filesystem link and rename operations");
  }
  const owner = normalizedMarkerUpdateOwner(await options.getMarkerUpdateOwner());
  const record = markerUpdateLockRecord(ownership, owner);
  const lockPath = `${ownership.markerPath}.update.lock`;
  const candidateNonce = requireNonEmptyString(
    nonceGenerator(),
    "generated marker lock publication nonce",
  );
  const candidateId = createHash("sha256").update(candidateNonce).digest("hex").slice(0, 16);
  const candidatePath = `${lockPath}.candidate.${candidateId}.tmp`;
  let handle;
  let candidatePresent = false;
  let candidateFileIdentity;
  try {
    handle = await fs.open(candidatePath, "wx", 0o600);
    candidatePresent = true;
    await handle.chmod(0o600);
    await handle.writeFile(markerJson(record), "utf8");
    if (typeof handle.sync === "function") await handle.sync();
    candidateFileIdentity = markerFileIdentity(await handle.stat());
    await handle.close();
    handle = undefined;
    try {
      await fs.link(candidatePath, lockPath);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      await recoverStaleMarkerUpdateLock(ownership, fs, options, nonceGenerator);
      try {
        await fs.link(candidatePath, lockPath);
      } catch (retryError) {
        if (retryError?.code === "EEXIST") {
          throw new Error(`Kind ownership marker update already in progress: ${ownership.markerPath}`);
        }
        throw retryError;
      }
    }
    candidateFileIdentity = markerFileIdentity(await fs.lstat(candidatePath));
    await fs.unlink(candidatePath);
    candidatePresent = false;
    candidateFileIdentity = markerFileIdentity(await fs.lstat(lockPath));
    await syncDirectoryIfSupported(fs, path.dirname(lockPath));
    const published = await readMarkerUpdateLockAt(ownership, fs, lockPath);
    if (
      !published
      || published.fileIdentity !== candidateFileIdentity
      || !sameFlatRecord(published.record, record)
    ) {
      throw new Error(`Kind marker update lock changed during publication: ${lockPath}`);
    }
    return published;
  } finally {
    if (handle) await handle.close();
    if (candidatePresent) await removeIfPresent(fs, candidatePath);
  }
}

async function withMarkerUpdateLock(ownership, fs, options, operation) {
  const nonceGenerator = options.randomUUID ?? defaultRandomUUID;
  if (typeof nonceGenerator !== "function") throw new Error("randomUUID dependency must be a function");
  const published = await publishMarkerUpdateLock(ownership, fs, options, nonceGenerator);
  const lockPath = `${ownership.markerPath}.update.lock`;
  let result;
  let primaryError;
  try {
    result = await operation();
  } catch (error) {
    primaryError = error;
  }

  const cleanupErrors = [];
  try {
    const current = await readMarkerUpdateLockAt(ownership, fs, lockPath);
    if (
      !current
      || current.fileIdentity !== published.fileIdentity
      || !sameFlatRecord(current.record, published.record)
    ) {
      throw new Error(`Kind ownership marker update lock changed before release: ${lockPath}`);
    }
    await fs.unlink(lockPath);
  } catch (error) {
    cleanupErrors.push(error);
  }

  if (primaryError) {
    if (cleanupErrors.length > 0) {
      throw new AggregateError([primaryError, ...cleanupErrors], primaryError.message);
    }
    throw primaryError;
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, `Unable to remove Kind ownership update lock ${lockPath}`);
  }
  return result;
}

async function atomicallyReplaceMarker(markerPath, marker, fs, nonceGenerator) {
  const updateNonce = requireNonEmptyString(nonceGenerator(), "generated marker update nonce");
  const updateId = createHash("sha256").update(updateNonce).digest("hex").slice(0, 16);
  const tempPath = `${markerPath}.update.${updateId}.tmp`;
  let tempHandle;
  let tempOwned = false;
  let renamed = false;
  let primaryError;
  let createdFileIdentity;

  try {
    tempHandle = await fs.open(tempPath, "wx", 0o600);
    tempOwned = true;
    await tempHandle.chmod(0o600);
    await tempHandle.writeFile(markerJson(marker), "utf8");
    if (typeof tempHandle.sync === "function") await tempHandle.sync();
    await fs.rename(tempPath, markerPath);
    renamed = true;
    createdFileIdentity = markerFileIdentity(await tempHandle.stat());
    const destinationFileIdentity = markerFileIdentity(await fs.lstat(markerPath));
    if (destinationFileIdentity !== createdFileIdentity) {
      throw new Error("Kind ownership marker atomic replacement file identity changed");
    }
    await syncDirectoryIfSupported(fs, path.dirname(markerPath));
    await tempHandle.close();
    tempHandle = undefined;
  } catch (error) {
    primaryError = error;
  }

  const cleanupErrors = [];
  if (tempHandle) {
    try {
      await tempHandle.close();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (tempOwned && !renamed) {
    try {
      await removeIfPresent(fs, tempPath);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (primaryError) {
    if (cleanupErrors.length > 0) {
      throw new AggregateError([primaryError, ...cleanupErrors], primaryError.message);
    }
    throw primaryError;
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, `Unable to clean Kind ownership marker update ${tempPath}`);
  }
  return createdFileIdentity;
}

async function inspect(options, phase, clusterName) {
  const inspection = requireRecord(await inspectFunction(options)({
    phase,
    clusterName,
    kubeContext: expectedKubeContext(clusterName),
  }), "Kind inspection");
  kindClusterNames(inspection);
  kubeContexts(inspection);
  return inspection;
}

function assertExactLiveCluster(marker, inspection) {
  const matches = kindClusterNames(inspection).filter((name) => name === marker.clusterName);
  if (matches.length !== 1) {
    throw new Error(`The owned Kind cluster name ${marker.clusterName} is not present exactly once`);
  }
  if (inspection.inspectedKubeContext !== marker.kubeContext) {
    throw new Error(`The inspected Kind kube context does not match ${marker.kubeContext}`);
  }
  if (inspection.kubeServer !== marker.kubeServer) {
    throw new Error(`The owned Kind kube server changed from ${marker.kubeServer}`);
  }
  const identities = canonicalContainerIdentities(
    inspection.containerIdentities,
    "Kind inspection containerIdentities",
  );
  if (JSON.stringify(identities) !== JSON.stringify(marker.containerIdentities)) {
    throw new Error("The owned Kind container identities changed");
  }
  return inspection;
}

function exactBoundIdentity(marker, inspection) {
  const matches = kindClusterNames(inspection).filter((name) => name === marker.clusterName);
  if (matches.length !== 1) {
    throw new Error(`The created Kind cluster name ${marker.clusterName} is not present exactly once`);
  }
  const kubeContext = expectedKubeContext(marker.clusterName);
  if (inspection.inspectedKubeContext !== kubeContext) {
    throw new Error(`The inspected Kind kube context does not match ${kubeContext}`);
  }
  return Object.freeze({
    clusterName: marker.clusterName,
    kubeContext,
    kubeServer: requireNonEmptyString(inspection.kubeServer, "Kind inspection kubeServer"),
    containerIdentities: canonicalContainerIdentities(
      inspection.containerIdentities,
      "Kind inspection containerIdentities",
    ),
  });
}

function markerIdentityFromResult(result) {
  return Object.freeze({
    version: result.version,
    toolNamespace: result.toolNamespace,
    scenarioId: result.scenarioId,
    runId: result.runId,
    nonce: result.nonce,
    clusterName: result.clusterName,
    kubeContext: result.kubeContext,
    kubeServer: result.kubeServer,
    containerIdentities: [...result.containerIdentities],
  });
}

function deletionPendingMarker(marker) {
  return Object.freeze({
    ...marker,
    teardownPhase: KIND_DELETE_PENDING_PHASE,
  });
}

function boundIdentityFromDeletionPending(marker) {
  const { teardownPhase: _teardownPhase, ...boundMarker } = marker;
  return Object.freeze(boundMarker);
}

function assertSameMarker(actual, expected, message) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(message);
}

function assertExactClusterAbsent(marker, inspection) {
  if (kindClusterNames(inspection).includes(marker.clusterName)) {
    throw new Error(`Kind teardown did not prove cluster absence: ${marker.clusterName}`);
  }
  if (kubeContexts(inspection).includes(marker.kubeContext)) {
    throw new Error(`Kind teardown did not prove kube context absence: ${marker.kubeContext}`);
  }
  if (inspection.inspectedKubeContext === marker.kubeContext) {
    throw new Error(`Kind teardown absence proof still inspected ${marker.kubeContext}`);
  }
  if (!Array.isArray(inspection.kubeServers) || !Array.isArray(inspection.containerIdentities)) {
    throw new Error("Kind teardown absence proof omitted kube server or container identities");
  }
  if (inspection.kubeServer === marker.kubeServer || inspection.kubeServers.includes(marker.kubeServer)) {
    throw new Error(`Kind teardown did not prove kube server absence: ${marker.kubeServer}`);
  }
  const remaining = new Set(inspection.containerIdentities);
  if (marker.containerIdentities.some((identity) => remaining.has(identity))) {
    throw new Error("Kind teardown did not prove container identity absence");
  }
}

function residualOwnedKindIdentity(marker, inspection) {
  if (!Array.isArray(inspection.kubeServers) || !Array.isArray(inspection.containerIdentities)) {
    throw new Error("Kind teardown residual proof omitted kube server or container identities");
  }
  if (inspection.containerIdentities.length !== 0) {
    throw new Error("Kind teardown could not prove the exact owned container identities absent");
  }
  return kubeContexts(inspection).includes(marker.kubeContext)
    || inspection.inspectedKubeContext === marker.kubeContext
    || inspection.kubeServer === marker.kubeServer
    || inspection.kubeServers.includes(marker.kubeServer);
}

async function verifyForPhase(reservation, options, phase) {
  const expected = assertReservation(reservation);
  const fs = fileSystem(options);
  const expectedMarkerFileIdentity = boundMarkerFileIdentity(reservation);
  const snapshot = await readMarkerSnapshot(expected.markerPath, fs);
  if (snapshot.fileIdentity !== expectedMarkerFileIdentity) {
    throw new Error("Bound Kind ownership marker file identity changed");
  }
  const marker = assertMarkerIdentity(
    snapshot.marker,
    expected,
    { bound: true },
  );
  const inspection = await inspect(options, phase, marker.clusterName);
  assertExactLiveCluster(marker, inspection);
  return markerResult(expected.markerRoot, expected.markerPath, marker, {
    ready: inspection.ready === true,
  }, expectedMarkerFileIdentity);
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

async function annotatePersistedBindError(
  error,
  reservation,
  options,
  expectedMarkerFileIdentity,
) {
  const expected = assertReservation(reservation);
  const fs = fileSystem(options);
  let snapshot;
  let marker;
  try {
    snapshot = await readMarkerSnapshot(expected.markerPath, fs);
    marker = assertMarkerIdentity(
      snapshot.marker,
      expected,
      { bound: true },
    );
  } catch {
    return;
  }
  if (
    typeof expectedMarkerFileIdentity !== "string"
    || snapshot.fileIdentity !== expectedMarkerFileIdentity
  ) {
    defineHiddenRecovery(error, "bindOwnershipIndeterminate", true);
    return;
  }
  try {
    const inspection = await inspect(options, "bind-recovery", marker.clusterName);
    assertExactLiveCluster(marker, inspection);
    const recovered = markerResult(
      expected.markerRoot,
      expected.markerPath,
      marker,
      { ready: inspection.ready === true },
      snapshot.fileIdentity,
    );
    defineHiddenRecovery(error, "recoveredBoundOwnership", recovered);
  } catch {
    defineHiddenRecovery(error, "bindOwnershipIndeterminate", true);
  }
}

export async function reserveKindClusterOwnership(input, options = {}) {
  requireRecord(input, "Kind ownership input");
  if (own(input, "clusterName") || own(input, "kindClusterName")) {
    throw new Error("caller-supplied Kind cluster names are forbidden");
  }
  if (own(input, "markerPath")) {
    throw new Error("caller-supplied Kind marker paths are forbidden");
  }
  const scenarioId = requireNonEmptyString(input.scenarioId, "scenarioId");
  const runId = requireNonEmptyString(input.runId, "runId");
  const nonceGenerator = options.randomUUID ?? defaultRandomUUID;
  if (typeof nonceGenerator !== "function") throw new Error("randomUUID dependency must be a function");
  const nonce = input.nonce === undefined
    ? requireNonEmptyString(nonceGenerator(), "generated nonce")
    : requireNonEmptyString(input.nonce, "nonce");
  const clusterName = generatedClusterName(scenarioId, runId, nonce);
  const kubeContext = expectedKubeContext(clusterName);
  const fs = fileSystem(options);
  const markerRoot = await canonicalDirectoryRoot(fs, input.markerRoot);
  const markerPath = derivedMarkerPath(markerRoot, clusterName);
  const inspection = await inspect(options, "reserve", clusterName);

  if (kindClusterNames(inspection).includes(clusterName)) {
    throw new Error(`The generated Kind cluster name ${clusterName} already exists`);
  }
  if (kubeContexts(inspection).includes(kubeContext)) {
    throw new Error(`The generated kube context ${kubeContext} already exists`);
  }

  const marker = Object.freeze({
    version: MARKER_VERSION,
    toolNamespace: TOOL_NAMESPACE,
    scenarioId,
    runId,
    nonce,
    clusterName,
  });
  await createMarkerExclusively(markerPath, marker, fs, nonceGenerator);
  return markerResult(markerRoot, markerPath, marker, { kubeContext });
}

export async function beginKindClusterCreation(reservation, options = {}) {
  const expected = assertReservation(reservation);
  const fs = fileSystem(options);
  const snapshot = await readMarkerSnapshot(expected.markerPath, fs);
  const marker = assertMarkerIdentity(
    snapshot.marker,
    expected,
    { bound: false },
  );
  const inspection = await inspect(options, "create-preflight", marker.clusterName);
  if (kindClusterNames(inspection).includes(marker.clusterName)) {
    throw new Error(`Kind creation preflight found an existing cluster: ${marker.clusterName}`);
  }
  const kubeContext = expectedKubeContext(marker.clusterName);
  if (kubeContexts(inspection).includes(kubeContext)) {
    throw new Error(`Kind creation preflight found an existing kube context: ${kubeContext}`);
  }
  const transaction = Object.freeze(Object.create(null));
  CREATION_TRANSACTIONS.set(transaction, Object.freeze({
    phase: "pending",
    markerPath: expected.markerPath,
    marker: markerJson(marker),
    markerFileIdentity: snapshot.fileIdentity,
  }));
  return transaction;
}

export async function completeKindClusterCreation(reservation, options = {}) {
  const expected = assertReservation(reservation);
  const transaction = options.creationTransaction;
  const transactionState = transaction && typeof transaction === "object"
    ? CREATION_TRANSACTIONS.get(transaction)
    : undefined;
  if (
    !transactionState
    || transactionState.markerPath !== expected.markerPath
    || transactionState.phase !== "pending"
  ) {
    throw new Error("Kind creation completion requires the exact unused creation transaction");
  }
  const fs = fileSystem(options);
  const before = await readMarkerSnapshot(expected.markerPath, fs);
  const marker = assertMarkerIdentity(before.marker, expected, { bound: false });
  if (
    markerJson(marker) !== transactionState.marker
    || before.fileIdentity !== transactionState.markerFileIdentity
  ) {
    throw new Error("Kind creation transaction marker identity changed before completion");
  }
  const createdIdentity = exactBoundIdentity(
    marker,
    await inspect(options, "create-witness", marker.clusterName),
  );
  const witnessedContainerIdentities = canonicalContainerIdentities(
    options.createdContainerIdentities,
    "Kind creation operation containerIdentities",
  );
  if (
    JSON.stringify(createdIdentity.containerIdentities)
    !== JSON.stringify(witnessedContainerIdentities)
  ) {
    throw new Error("Kind creation operation witness does not match live container identities");
  }
  const after = await readMarkerSnapshot(expected.markerPath, fs);
  const markerAfterInspection = assertMarkerIdentity(after.marker, expected, { bound: false });
  if (
    markerJson(markerAfterInspection) !== transactionState.marker
    || after.fileIdentity !== transactionState.markerFileIdentity
  ) {
    throw new Error("Kind creation transaction marker identity changed during completion");
  }
  CREATION_TRANSACTIONS.set(transaction, Object.freeze({
    ...transactionState,
    phase: "completed",
    createdIdentity,
  }));
  return transaction;
}

export async function bindKindCluster(reservation, options = {}) {
  const expected = assertReservation(reservation);
  const fs = fileSystem(options);
  const nonceGenerator = options.randomUUID ?? defaultRandomUUID;
  if (typeof nonceGenerator !== "function") throw new Error("randomUUID dependency must be a function");
  const transaction = options.creationTransaction;
  const transactionState = transaction && typeof transaction === "object"
    ? CREATION_TRANSACTIONS.get(transaction)
    : undefined;
  if (
    !transactionState
    || transactionState.markerPath !== expected.markerPath
    || transactionState.phase !== "completed"
    || transactionState.createdIdentity === undefined
  ) {
    throw new Error("Kind bind requires the exact completed one-use creation transaction");
  }
  const bindingTransactionState = Object.freeze({
    ...transactionState,
    phase: "binding",
  });
  CREATION_TRANSACTIONS.set(transaction, bindingTransactionState);
  let createdBoundMarkerFileIdentity;
  let boundMarkerVerified = false;

  try {
    return await withMarkerUpdateLock(expected, fs, options, async () => {
      const markerSnapshot = await readMarkerSnapshot(expected.markerPath, fs);
      const marker = assertMarkerIdentity(
        markerSnapshot.marker,
        expected,
        { bound: false },
      );
      if (
        markerJson(marker) !== transactionState.marker
        || markerSnapshot.fileIdentity !== transactionState.markerFileIdentity
      ) {
        throw new Error("Kind creation transaction marker identity changed before bind");
      }
      const created = transactionState.createdIdentity;
      assertExactLiveCluster(
        created,
        await inspect(options, "create-complete", marker.clusterName),
      );
      const markerBeforeBindSnapshot = await readMarkerSnapshot(expected.markerPath, fs);
      const markerBeforeBind = assertMarkerIdentity(
        markerBeforeBindSnapshot.marker,
        expected,
        { bound: false },
      );
      if (
        markerJson(markerBeforeBind) !== transactionState.marker
        || markerBeforeBindSnapshot.fileIdentity !== transactionState.markerFileIdentity
      ) {
        throw new Error("Kind creation transaction marker identity changed during bind");
      }
      const inspection = await inspect(options, "bind", marker.clusterName);
      assertExactLiveCluster(created, inspection);
      const finalUnboundSnapshot = await readMarkerSnapshot(expected.markerPath, fs);
      const finalUnboundMarker = assertMarkerIdentity(
        finalUnboundSnapshot.marker,
        expected,
        { bound: false },
      );
      if (
        markerJson(finalUnboundMarker) !== transactionState.marker
        || finalUnboundSnapshot.fileIdentity !== transactionState.markerFileIdentity
      ) {
        throw new Error("Kind creation transaction marker identity changed after final inspection");
      }
      const boundMarker = Object.freeze({
        ...marker,
        kubeContext: created.kubeContext,
        kubeServer: created.kubeServer,
        containerIdentities: created.containerIdentities,
      });
      createdBoundMarkerFileIdentity = await atomicallyReplaceMarker(
        expected.markerPath,
        boundMarker,
        fs,
        nonceGenerator,
      );
      const persistedSnapshot = await readMarkerSnapshot(expected.markerPath, fs);
      if (persistedSnapshot.fileIdentity !== createdBoundMarkerFileIdentity) {
        throw new Error("Kind ownership marker inode changed after atomic replacement");
      }
      const persistedMarker = assertMarkerIdentity(
        persistedSnapshot.marker,
        expected,
        { bound: true },
      );
      if (JSON.stringify(persistedMarker) !== JSON.stringify(boundMarker)) {
        throw new Error("Kind ownership marker changed during its atomic update");
      }
      boundMarkerVerified = true;
      CREATION_TRANSACTIONS.delete(transaction);
      return markerResult(expected.markerRoot, expected.markerPath, persistedMarker, {
        ready: inspection.ready === true,
      }, createdBoundMarkerFileIdentity);
    });
  } catch (error) {
    if (
      !boundMarkerVerified
      && CREATION_TRANSACTIONS.get(transaction) === bindingTransactionState
    ) {
      CREATION_TRANSACTIONS.set(transaction, transactionState);
    }
    await annotatePersistedBindError(
      error,
      reservation,
      options,
      createdBoundMarkerFileIdentity,
    );
    throw error;
  }
}

export async function verifyOwnedKindCluster(reservation, options = {}) {
  return verifyForPhase(reservation, options, "verify");
}

export async function assertOwnedKindClusterReady(reservation, options = {}) {
  const verified = await verifyForPhase(reservation, options, "mutation");
  if (!verified.ready) {
    throw new Error(`The owned Kind cluster ${verified.clusterName} is not ready`);
  }
  return verified;
}

export async function verifyOwnedKindAcpEndpoint(reservation, options = {}) {
  if (typeof options.readKindAcpEndpointEvidence !== "function") {
    throw new Error("readKindAcpEndpointEvidence dependency is required");
  }
  const verified = await verifyForPhase(reservation, options, "endpoint");
  const proof = requireRecord(
    await options.readKindAcpEndpointEvidence({
      clusterName: verified.clusterName,
      kubeContext: verified.kubeContext,
      kubeServer: verified.kubeServer,
      containerIdentities: [...verified.containerIdentities],
    }),
    "Kind ACP endpoint proof",
  );
  const identities = canonicalContainerIdentities(
    proof.containerIdentities,
    "Kind ACP endpoint proof containerIdentities",
  );
  if (
    proof.clusterName !== verified.clusterName
    || proof.kubeContext !== verified.kubeContext
    || proof.kubeServer !== verified.kubeServer
    || JSON.stringify(identities) !== JSON.stringify(verified.containerIdentities)
    || proof.descriptorVerified !== true
    || proof.processIdentityVerified !== true
    || proof.reachable !== true
    || !Number.isInteger(proof.hostPort)
    || proof.hostPort < 1024
    || proof.hostPort > 65535
  ) {
    throw new Error("Owned Kind ACP endpoint proof does not match the exact disposable cluster");
  }
  return Object.freeze({ hostPort: proof.hostPort });
}

export async function teardownOwnedKindCluster(reservation, options = {}) {
  if (typeof options.deleteKindCluster !== "function") {
    throw new Error("deleteKindCluster dependency is required");
  }
  const fs = fileSystem(options);
  const expected = assertReservation(reservation);
  const expectedMarkerFileIdentity = boundMarkerFileIdentity(reservation);
  const teardownNonceGenerator = options.randomUUID ?? defaultRandomUUID;
  if (typeof teardownNonceGenerator !== "function") {
    throw new Error("randomUUID dependency must be a function");
  }
  const initialMarkerSnapshot = await readMarkerSnapshot(expected.markerPath, fs);
  const markerIsDeletionPending = own(initialMarkerSnapshot.marker, "teardownPhase");
  let deletionPending;
  let deletionPendingFileIdentity;

  if (markerIsDeletionPending) {
    deletionPending = assertMarkerIdentity(
      initialMarkerSnapshot.marker,
      expected,
      { bound: true, deletionPending: true },
    );
    assertSameMarker(
      boundIdentityFromDeletionPending(deletionPending),
      markerIdentityFromResult(reservation),
      "Kind deletion-pending marker does not match the exact bound ownership",
    );
    deletionPendingFileIdentity = initialMarkerSnapshot.fileIdentity;
    await recoverStaleMarkerUpdateLock(
      expected,
      fs,
      options,
      teardownNonceGenerator,
    );
  } else {
    if (initialMarkerSnapshot.fileIdentity !== expectedMarkerFileIdentity) {
      throw new Error("Bound Kind ownership marker file identity changed before teardown");
    }
    assertMarkerIdentity(initialMarkerSnapshot.marker, expected, { bound: true });
    const verified = await verifyForPhase(reservation, options, "teardown");
    const verifiedMarker = markerIdentityFromResult(verified);
    await withMarkerUpdateLock(expected, fs, options, async () => {
      const markerBeforeTransitionSnapshot = await readMarkerSnapshot(expected.markerPath, fs);
      const markerBeforeTransition = assertMarkerIdentity(
        markerBeforeTransitionSnapshot.marker,
        expected,
        { bound: true },
      );
      assertSameMarker(
        markerBeforeTransition,
        verifiedMarker,
        "Kind ownership marker changed before deletion-pending transition",
      );
      if (markerBeforeTransitionSnapshot.fileIdentity !== expectedMarkerFileIdentity) {
        throw new Error("Kind ownership marker file identity changed before deletion-pending transition");
      }
      deletionPending = deletionPendingMarker(markerBeforeTransition);
      deletionPendingFileIdentity = await atomicallyReplaceMarker(
        expected.markerPath,
        deletionPending,
        fs,
        teardownNonceGenerator,
      );
      const persistedPendingSnapshot = await readMarkerSnapshot(expected.markerPath, fs);
      if (persistedPendingSnapshot.fileIdentity !== deletionPendingFileIdentity) {
        throw new Error("Kind deletion-pending marker file identity changed after persistence");
      }
      const persistedPending = assertMarkerIdentity(
        persistedPendingSnapshot.marker,
        expected,
        { bound: true, deletionPending: true },
      );
      assertSameMarker(
        persistedPending,
        deletionPending,
        "Kind deletion-pending marker changed during persistence",
      );
    });
  }

  const deletionInspection = await inspect(
    options,
    "teardown-delete",
    deletionPending.clusterName,
  );
  const clusterStillPresent = kindClusterNames(deletionInspection).includes(
    deletionPending.clusterName,
  );

  if (clusterStillPresent) {
    assertExactLiveCluster(deletionPending, deletionInspection);
    const markerBeforeDeleteSnapshot = await readMarkerSnapshot(expected.markerPath, fs);
    if (markerBeforeDeleteSnapshot.fileIdentity !== deletionPendingFileIdentity) {
      throw new Error("Kind deletion-pending marker file identity changed before deletion");
    }
    const markerBeforeDelete = assertMarkerIdentity(
      markerBeforeDeleteSnapshot.marker,
      expected,
      { bound: true, deletionPending: true },
    );
    assertSameMarker(
      markerBeforeDelete,
      deletionPending,
      "Kind deletion-pending marker changed immediately before deletion",
    );

    // The marker covers the whole disposable cluster, so deleting the cluster
    // is also the cleanup boundary for every child resource created inside it.
    await options.deleteKindCluster(Object.freeze({
      clusterName: deletionPending.clusterName,
      kubeContext: deletionPending.kubeContext,
      kubeServer: deletionPending.kubeServer,
      containerIdentities: [...deletionPending.containerIdentities],
    }));
  } else {
    const cleanupRequired = residualOwnedKindIdentity(deletionPending, deletionInspection);
    if (cleanupRequired) {
      const markerBeforeResidualCleanup = await readMarkerSnapshot(expected.markerPath, fs);
      if (markerBeforeResidualCleanup.fileIdentity !== deletionPendingFileIdentity) {
        throw new Error("Kind deletion-pending marker file identity changed before residual cleanup");
      }
      const pendingBeforeResidualCleanup = assertMarkerIdentity(
        markerBeforeResidualCleanup.marker,
        expected,
        { bound: true, deletionPending: true },
      );
      assertSameMarker(
        pendingBeforeResidualCleanup,
        deletionPending,
        "Kind deletion-pending marker changed before residual cleanup",
      );
      await options.deleteKindCluster(Object.freeze({
        clusterName: deletionPending.clusterName,
        kubeContext: deletionPending.kubeContext,
        kubeServer: deletionPending.kubeServer,
        containerIdentities: [...deletionPending.containerIdentities],
      }));
    } else {
      assertExactClusterAbsent(deletionPending, deletionInspection);
    }
  }

  const proof = await inspect(options, "teardown-proof", deletionPending.clusterName);
  assertExactClusterAbsent(deletionPending, proof);

  const markerAfterDeleteSnapshot = await readMarkerSnapshot(expected.markerPath, fs);
  if (markerAfterDeleteSnapshot.fileIdentity !== deletionPendingFileIdentity) {
    throw new Error("Kind deletion-pending marker file identity changed during teardown");
  }
  const markerAfterDelete = assertMarkerIdentity(
    markerAfterDeleteSnapshot.marker,
    expected,
    { bound: true, deletionPending: true },
  );
  assertSameMarker(
    markerAfterDelete,
    deletionPending,
    "Kind ownership marker changed during teardown; preserving it for diagnostics",
  );
  // A crash or unlink failure after the durable phase rename can leave the
  // adjacent transition lock behind. Recover it only when its exact process
  // start identity proves the publishing owner is no longer active.
  await recoverStaleMarkerUpdateLock(
    expected,
    fs,
    options,
    teardownNonceGenerator,
  );
  await fs.unlink(expected.markerPath);
  await syncDirectoryIfSupported(fs, expected.markerRoot);
  return Object.freeze({
    action: "deleted",
    clusterName: deletionPending.clusterName,
    markerPath: expected.markerPath,
  });
}
