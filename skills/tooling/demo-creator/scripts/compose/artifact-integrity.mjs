import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, realpath, rm, stat } from "node:fs/promises";
import path from "node:path";

const SHA256 = /^[0-9a-f]{64}$/u;
const COPY_BUFFER_BYTES = 64 * 1024;

export function parsePointerEvents(bytes) {
  const source = Buffer.isBuffer(bytes) ? bytes.toString("utf8") : String(bytes);
  let value;
  try {
    value = JSON.parse(source);
  } catch (jsonError) {
    if (source.trim() === "") return [];
    try {
      return source.split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
    } catch {
      throw new Error("pointerEvents artifact is not valid JSON or JSON Lines", { cause: jsonError });
    }
  }
  const looksLikeEvent = value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && typeof value.type === "string"
    && ["time", "monotonicSeconds", "monotonicMs", "seconds", "timestampSeconds"]
      .some((key) => Object.hasOwn(value, key));
  const events = Array.isArray(value) ? value : value?.events ?? (looksLikeEvent ? [value] : undefined);
  if (!Array.isArray(events)) throw new Error("pointerEvents artifact must contain an event array");
  return events;
}

function relativeEventSeconds(event, origin) {
  if (Number.isFinite(event?.time)) return Number(event.time);
  if (Number.isFinite(event?.monotonicSeconds)) return Number(event.monotonicSeconds) - origin;
  if (Number.isFinite(event?.monotonicMs)) return (Number(event.monotonicMs) - origin) / 1000;
  return Number(event?.seconds ?? event?.timestampSeconds);
}

export function validatePointerEventsAgainstDuration(events, durationSeconds) {
  if (!Array.isArray(events)) throw new Error("pointerEvents artifact must contain an event array");
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new Error("Verified mobile capture duration must be finite and positive");
  }
  const monotonic = events
    .map((event) => event?.monotonicSeconds ?? event?.monotonicMs)
    .filter(Number.isFinite)
    .map(Number);
  const origin = monotonic[0] ?? 0;
  let previous = -Infinity;
  for (const [index, event] of events.entries()) {
    const seconds = relativeEventSeconds(event, origin);
    if (!Number.isFinite(seconds) || seconds < 0 || seconds < previous) {
      throw new Error(`Pointer event ${index + 1} has invalid capture timing`);
    }
    if (seconds >= durationSeconds) {
      throw new Error(`Pointer event ${index + 1} falls beyond the verified mobile capture duration`);
    }
    previous = seconds;
  }
  return events;
}

function contained(root, target) {
  const relative = path.relative(root, target);
  return relative !== ""
    && relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

function sameIdentity(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

async function digestOpenHandle(handle, size, label) {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
  let position = 0;
  while (position < size) {
    const length = Math.min(buffer.length, size - position);
    const { bytesRead } = await handle.read(buffer, 0, length, position);
    if (bytesRead === 0) throw new Error(`${label} ended while its verified bytes were read`);
    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  return hash.digest("hex");
}

export async function openDigestBoundArtifact(file, expectedSha256, label) {
  if (!SHA256.test(expectedSha256 ?? "")) throw new Error(`${label} digest must be a SHA-256 digest`);
  const handle = await open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error(`${label} must be a regular file`);
    const digest = await digestOpenHandle(handle, before.size, label);
    const after = await handle.stat();
    if (!sameIdentity(before, after) || digest !== expectedSha256) {
      throw new Error(`${label} changed before it could be consumed`);
    }
    return { handle, identity: before, digest };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

export async function verifyOpenArtifactUnchanged(opened, label) {
  const after = await opened.handle.stat();
  const digest = await digestOpenHandle(opened.handle, after.size, label);
  const finalIdentity = await opened.handle.stat();
  if (!sameIdentity(opened.identity, after)
    || !sameIdentity(after, finalIdentity)
    || digest !== opened.digest) {
    throw new Error(`${label} changed while it was consumed`);
  }
}

export function validateAndroidPointerEvents(events) {
  if (!Array.isArray(events)) throw new Error("Android pointerEvents must contain canonical normalized clicks");
  for (const event of events) {
    if (event === null
      || typeof event !== "object"
      || Array.isArray(event)
      || JSON.stringify(Object.keys(event).sort()) !== JSON.stringify(["time", "type", "x", "y"])
      || event.type !== "click"
      || !Number.isFinite(event.time)
      || event.time < 0
      || !Number.isFinite(event.x)
      || event.x < 0
      || event.x > 1
      || !Number.isFinite(event.y)
      || event.y < 0
      || event.y > 1) {
      throw new Error("Android pointerEvents must contain canonical normalized clicks");
    }
  }
  return events;
}

async function rejectSymlinkComponents(root, requested, label) {
  const relative = path.relative(root, requested);
  let current = root;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    if ((await lstat(current)).isSymbolicLink()) {
      throw new Error(`${label} must not resolve through a symbolic link`);
    }
  }
}

/**
 * Open a manifest artifact without following its final symlink, bind it to its
 * canonical path and inode, and hash/copy only bytes read from that open file.
 */
export async function verifyManifestArtifact({
  root,
  reference,
  expectedSha256,
  label,
  snapshotPath,
  collectBytes = false,
  maximumBytes = Number.POSITIVE_INFINITY,
  dependencies = {},
}) {
  if (typeof reference !== "string" || reference.length === 0 || reference.includes("\0")) {
    throw new Error(`${label} must be a non-empty manifest artifact path`);
  }
  if (!SHA256.test(expectedSha256 ?? "")) {
    throw new Error(`${label} manifest digest must be a SHA-256 digest`);
  }
  const lexicalRoot = path.resolve(root);
  const requested = path.isAbsolute(reference)
    ? path.resolve(reference)
    : path.resolve(lexicalRoot, reference);
  if (!contained(lexicalRoot, requested)) {
    throw new Error(`${label} must remain inside the capture output directory`);
  }
  const canonicalRoot = await realpath(lexicalRoot);
  await rejectSymlinkComponents(lexicalRoot, requested, label);
  const canonical = await realpath(requested);
  if (!contained(canonicalRoot, canonical)) {
    throw new Error(`${label} canonical path escapes the capture output directory`);
  }

  const source = await open(requested, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  let destination;
  try {
    const before = await source.stat();
    if (!before.isFile()) throw new Error(`${label} must be a regular file`);
    if (before.size > maximumBytes) throw new Error(`${label} exceeds its maximum byte bound`);
    destination = snapshotPath === undefined
      ? undefined
      : await open(snapshotPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o400);
    await dependencies.afterOpen?.({ requested, canonical, source, before });

    const hash = createHash("sha256");
    const chunks = collectBytes ? [] : undefined;
    const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
    let position = 0;
    while (position < before.size) {
      const length = Math.min(buffer.length, before.size - position);
      const { bytesRead } = await source.read(buffer, 0, length, position);
      if (bytesRead === 0) throw new Error(`${label} ended while its verified bytes were read`);
      const chunk = buffer.subarray(0, bytesRead);
      hash.update(chunk);
      if (destination) {
        let written = 0;
        while (written < bytesRead) {
          const result = await destination.write(
            chunk,
            written,
            bytesRead - written,
            position + written,
          );
          if (result.bytesWritten === 0) {
            throw new Error(`${label} verified snapshot stopped accepting bytes`);
          }
          written += result.bytesWritten;
        }
      }
      if (chunks) chunks.push(Buffer.from(chunk));
      position += bytesRead;
    }
    const digest = hash.digest("hex");
    const [after, currentCanonical, currentIdentity] = await Promise.all([
      source.stat(),
      realpath(requested),
      stat(canonical),
    ]);
    if (currentCanonical !== canonical
      || !sameIdentity(before, after)
      || !sameIdentity(before, currentIdentity)) {
      throw new Error(`${label} changed identity while it was verified`);
    }
    if (digest !== expectedSha256) throw new Error(`${label} digest does not match the manifest`);
    if (destination) {
      const copied = await destination.stat();
      if (!copied.isFile() || copied.size !== before.size) {
        throw new Error(`${label} verified snapshot is incomplete`);
      }
    }
    return {
      canonical,
      digest,
      size: before.size,
      ...(snapshotPath === undefined ? {} : { snapshotPath }),
      ...(chunks === undefined ? {} : { bytes: Buffer.concat(chunks) }),
    };
  } catch (error) {
    if (destination) await destination.close().catch(() => {});
    destination = undefined;
    if (snapshotPath !== undefined) await rm(snapshotPath, { force: true });
    throw error;
  } finally {
    if (destination) await destination.close();
    await source.close();
  }
}

export { sameIdentity };
