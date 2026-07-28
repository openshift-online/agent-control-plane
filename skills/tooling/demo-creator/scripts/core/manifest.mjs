import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { ownershipMarker } from "./ownership.mjs";
import { findSecrets, findSensitiveFields } from "./security.mjs";

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  return value;
}

export function stableJson(value) {
  return `${JSON.stringify(stable(value), null, 2)}\n`;
}

export function buildManifest({ scenario, source, scenarioPath, layouts, durationSeconds }) {
  return {
    manifestVersion: 1,
    scenarioId: scenario.id,
    scenarioPath: path.basename(scenarioPath),
    scenarioSha256: sha256(source),
    fps: scenario.fps,
    durationSeconds,
    canvas: scenario.canvas,
    layouts,
    ownership: ownershipMarker(scenario.id),
    artifacts: {},
  };
}

const LOCK_TIMEOUT_MS = 10_000;
const STALE_LOCK_MS = 5_000;

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}

async function removeStaleLock(lockPath) {
  try {
    const metadata = JSON.parse(await readFile(lockPath, "utf8"));
    let age = Date.now() - Date.parse(metadata.createdAt);
    if (!Number.isFinite(age)) age = Date.now() - (await stat(lockPath)).mtimeMs;
    if (Number.isFinite(age) && age >= STALE_LOCK_MS && !processIsAlive(metadata.pid)) {
      await unlink(lockPath);
      return true;
    }
  } catch (error) {
    if (error.code === "ENOENT") return true;
  }
  return false;
}

async function acquireManifestLock(manifestPath) {
  const lockPath = `${manifestPath}.write.lock`;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  const token = randomUUID();
  while (Date.now() < deadline) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      try {
        await handle.writeFile(stableJson({ pid: process.pid, token, createdAt: new Date().toISOString() }), "utf8");
        return { handle, lockPath, token };
      } catch (error) {
        await handle.close();
        await rm(lockPath, { force: true });
        throw error;
      }
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (!(await removeStaleLock(lockPath))) await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error(`Timed out waiting for manifest writer lock: ${lockPath}`);
}

async function releaseManifestLock(lock) {
  await lock.handle.close();
  try {
    const metadata = JSON.parse(await readFile(lock.lockPath, "utf8"));
    if (metadata.token === lock.token) await unlink(lock.lockPath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

async function withManifestLock(manifestPath, operation) {
  await mkdir(path.dirname(manifestPath), { recursive: true, mode: 0o700 });
  const lock = await acquireManifestLock(manifestPath);
  try {
    return await operation();
  } finally {
    await releaseManifestLock(lock);
  }
}

async function writeManifestUnlocked(manifestPath, manifest) {
  const temporaryPath = `${manifestPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, stableJson(manifest), { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporaryPath, manifestPath);
    return manifest;
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

export async function writeManifest(manifestPath, manifest) {
  return withManifestLock(manifestPath, () => writeManifestUnlocked(manifestPath, manifest));
}

export async function readManifest(manifestPath) {
  return JSON.parse(await readFile(manifestPath, "utf8"));
}

export async function createOrVerifyManifest(manifestPath, input, { force = false } = {}) {
  const proposed = buildManifest(input);
  return withManifestLock(manifestPath, async () => {
    try {
      const existing = await readManifest(manifestPath);
      if (!force) {
        const immutableFields = ["manifestVersion", "scenarioId", "scenarioPath", "scenarioSha256", "fps", "durationSeconds", "canvas", "layouts", "ownership"];
        const mismatches = immutableFields.filter((key) => stableJson(existing[key]) !== stableJson(proposed[key]));
        if (mismatches.length) {
          throw new Error(`Scenario changed after the manifest was locked (${mismatches.join(", ")}); choose a new output directory or pass --force`);
        }
      }
      return force ? writeManifestUnlocked(manifestPath, proposed) : existing;
    } catch (error) {
      if (error.code === "ENOENT") return writeManifestUnlocked(manifestPath, proposed);
      throw error;
    }
  });
}

export async function mergeManifest(manifestPath, patch) {
  const unsafeFields = findSensitiveFields(patch);
  if (unsafeFields.length || findSecrets(JSON.stringify(patch)).length) {
    throw new Error("Refusing to write credential-like material to the locked manifest");
  }
  return withManifestLock(manifestPath, async () => {
    const current = await readManifest(manifestPath);
    for (const key of ["manifestVersion", "scenarioId", "scenarioPath", "scenarioSha256", "fps", "durationSeconds", "canvas", "layouts", "ownership", "toolchain"]) {
      if (Object.hasOwn(patch, key) && current[key] !== undefined && stableJson(patch[key]) !== stableJson(current[key])) {
        throw new Error(`Refusing to change locked manifest field: ${key}`);
      }
    }
    const next = {
      ...current,
      ...patch,
      artifacts: { ...(current.artifacts ?? {}), ...(patch?.artifacts ?? {}) },
    };
    return writeManifestUnlocked(manifestPath, next);
  });
}
