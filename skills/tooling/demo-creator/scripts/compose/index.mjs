import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  createHostProcessInspector,
  HOST_PROCESS_OUTPUT_BYTES,
} from "../capture/android/host-process-identity.mjs";
import { generateCaptionArtifacts, timelineFromScenes } from "./captions.mjs";
import {
  commandAvailable,
  create720pDerivative,
  createContactSheet,
  createSlideTrack,
  ffmpegEncoderAvailable,
  ffmpegFilterAvailable,
  joinSegments,
  overlayAss,
  renderSceneSegment,
} from "./ffmpeg.mjs";
import { layoutFor, outputGeometry } from "./layout.mjs";
import { scanTextForSecrets } from "./secrets.mjs";
import { androidSetupSensitiveValues, sanitizedSubprocessEnvironment } from "./security-values.mjs";
import {
  parsePointerEvents,
  openDigestBoundArtifact,
  validatePointerEventsAgainstDuration,
  validateAndroidPointerEvents,
  verifyOpenArtifactUnchanged,
  verifyManifestArtifact,
} from "./artifact-integrity.mjs";
import { probeMedia, validateMedia } from "./validation.mjs";

const composeDir = path.dirname(fileURLToPath(import.meta.url));
const skillDir = path.resolve(composeDir, "../..");
const PUBLIC_OUTPUTS = Object.freeze([
  "captions.vtt",
  "captions.srt",
  "transcript.txt",
  "overlays.ass",
  "demo-1080p.mp4",
  "demo-720p.mp4",
  "contact-sheet.png",
  "validation-report.json",
]);
const MOBILE_CAPTURE_DURATION_TOLERANCE_SECONDS = 1 / 30 + 0.02;
const MAX_POINTER_EVENTS_BYTES = 1024 * 1024;
const PUBLICATION_LOCK_NAME = ".compose-publish.lock";
const PUBLICATION_RECOVERY_PREFIX = ".compose-publish.recovery-";
const PUBLICATION_TRANSACTION_PREFIX = ".compose-publish.transaction-";
const publicationRecoveryStages = new WeakMap();
const execFileAsync = promisify(execFile);
const defaultInspectPublicationProcess = createHostProcessInspector({
  runCommand: execFileAsync,
  commandOptions: {
    encoding: "utf8",
    maxBuffer: HOST_PROCESS_OUTPUT_BYTES,
    timeout: 5_000,
    windowsHide: true,
    env: sanitizedSubprocessEnvironment(),
  },
});

async function defaultRenderCard(options) {
  const { renderCard } = await import("../render/card.mjs");
  return renderCard(options);
}

async function defaultRenderSlides(options) {
  const { renderSlides } = await import("../render/slides.mjs");
  return renderSlides(options);
}

async function defaultRenderTerminal(options) {
  const { renderTerminal } = await import("../render/terminal.mjs");
  return renderTerminal(options);
}

function resolveRendererAdapters(context = {}) {
  return {
    card: context.renderers?.card ?? defaultRenderCard,
    slides: context.renderers?.slides ?? defaultRenderSlides,
    terminal: context.renderers?.terminal ?? defaultRenderTerminal,
  };
}

function slug(value) {
  return String(value ?? "demo")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "demo";
}

function resolveManifestArtifact(value, context) {
  if (!value) return undefined;
  if (!context.outputDir) throw new Error("Manifest artifact resolution requires context.outputDir");
  const root = path.resolve(context.outputDir);
  const resolved = path.isAbsolute(value) ? path.resolve(value) : path.resolve(root, value);
  const relative = path.relative(root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Manifest artifacts must remain inside the scenario output directory");
  }
  return resolved;
}

function resolveCompositionContext(context, scenarioDir, scenario) {
  const outputDir = path.resolve(
    context.outputDir ?? path.join(scenarioDir, ".demo-output", slug(scenario.id)),
  );
  return { ...context, scenarioDir, outputDir };
}

function exactLiveProcessInspection(value, pid) {
  return value?.alive === true
    && value.pid === pid
    && typeof value.processStartIdentity === "string"
    && value.processStartIdentity.length > 0
    && value.processStartIdentity.length <= 256
    && value.processStartIdentity.trim() === value.processStartIdentity;
}

async function publicationOwnerIsActive(owner, inspectProcess) {
  try {
    const live = await inspectProcess(owner.pid);
    if (live === null) return false;
    if (!exactLiveProcessInspection(live, owner.pid)) return true;
    return live.processStartIdentity === owner.processStartIdentity;
  } catch {
    return true;
  }
}

function transactionJournalName(token) {
  return `${PUBLICATION_TRANSACTION_PREFIX}${token}.json`;
}

function validateTransactionRelative(value, label) {
  if (typeof value !== "string" || value.length === 0 || path.isAbsolute(value)) {
    throw new Error(`Invalid ${label} in composition publication transaction`);
  }
  const normalized = path.normalize(value);
  if (normalized === "." || normalized === ".." || normalized.startsWith(`..${path.sep}`)) {
    throw new Error(`Invalid ${label} in composition publication transaction`);
  }
  return normalized;
}

function transactionStageRelative(stageDir, outputDir) {
  const relative = path.relative(path.resolve(outputDir), path.resolve(stageDir));
  if (!relative || path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) {
    throw new Error("Composition publication stage must remain inside the output directory");
  }
  return relative;
}

function metadataStagePath(filePath) {
  return `${filePath}.stage-${randomUUID()}`;
}

async function syncMetadataDirectory(directory, operations) {
  const handle = await operations.open(directory, "r");
  try {
    if (typeof handle.sync === "function") await handle.sync();
  } finally {
    await handle.close();
  }
}

async function stageDurableJson(filePath, value, operations) {
  const stagePath = metadataStagePath(filePath);
  let handle;
  try {
    handle = await operations.open(stagePath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    if (typeof handle.sync === "function") await handle.sync();
    return { handle, stagePath };
  } catch (error) {
    if (handle) {
      await handle.close().catch(() => {});
    }
    await operations.rm(stagePath, { force: true }).catch(() => {});
    throw error;
  }
}

async function publishExclusiveMetadata(stagePath, filePath, operations) {
  let linked = false;
  try {
    await operations.link(stagePath, filePath);
    linked = true;
    await syncMetadataDirectory(path.dirname(filePath), operations);
    await operations.rm(stagePath, { force: true });
    await syncMetadataDirectory(path.dirname(filePath), operations);
  } catch (error) {
    if (linked) await operations.rm(filePath, { force: true }).catch(() => {});
    await operations.rm(stagePath, { force: true }).catch(() => {});
    await syncMetadataDirectory(path.dirname(filePath), operations).catch(() => {});
    throw error;
  }
}

async function writeDurableJson(filePath, value, operations) {
  const staged = await stageDurableJson(filePath, value, operations);
  try {
    await staged.handle.close();
    await publishExclusiveMetadata(staged.stagePath, filePath, operations);
  } catch (error) {
    await staged.handle.close().catch(() => {});
    await operations.rm(staged.stagePath, { force: true }).catch(() => {});
    throw error;
  }
}

async function createPublicationLock(outputDir, operations, inspectProcess) {
  const lockPath = path.join(outputDir, PUBLICATION_LOCK_NAME);
  const token = randomUUID();
  const journalName = transactionJournalName(token);
  const currentProcess = await inspectProcess(process.pid);
  if (!exactLiveProcessInspection(currentProcess, process.pid)) {
    throw new Error("Current composition publisher process identity is unavailable or ambiguous");
  }
  const staged = await stageDurableJson(
    lockPath,
    {
      schemaVersion: 1,
      pid: process.pid,
      processStartIdentity: currentProcess.processStartIdentity,
      token,
      journal: journalName,
    },
    operations,
  );
  try {
    await publishExclusiveMetadata(staged.stagePath, lockPath, operations);
    return {
      handle: staged.handle,
      journalPath: path.join(outputDir, journalName),
      lockPath,
      token,
    };
  } catch (error) {
    await staged.handle.close().catch(() => {});
    await operations.rm(staged.stagePath, { force: true }).catch(() => {});
    throw error;
  }
}

function isPublicationMetadataStage(entry) {
  return entry.startsWith(".compose-publish.") && entry.includes(".stage-");
}

async function cleanupPublicationMetadataStages(outputDir, operations) {
  const stages = (await operations.readdir(outputDir)).filter(isPublicationMetadataStage);
  for (const entry of stages) {
    await operations.rm(path.join(outputDir, entry), { force: true });
  }
  if (stages.length > 0) await syncMetadataDirectory(outputDir, operations);
}

async function readRecoverablePublicationOwner(lockPath, operations) {
  let metadata;
  try {
    metadata = JSON.parse(await operations.readFile(lockPath, "utf8"));
  } catch {
    return undefined;
  }
  if (metadata?.schemaVersion !== 1
    || typeof metadata.token !== "string"
    || metadata.token.length === 0
    || typeof metadata.processStartIdentity !== "string"
    || metadata.processStartIdentity.length === 0
    || metadata.processStartIdentity.length > 256
    || metadata.processStartIdentity.trim() !== metadata.processStartIdentity
    || metadata.journal !== transactionJournalName(metadata.token)) {
    return undefined;
  }
  return metadata;
}

async function acquirePublicationLock(
  outputDir,
  operations = fs,
  inspectProcess = defaultInspectPublicationProcess,
) {
  const lockPath = path.join(outputDir, PUBLICATION_LOCK_NAME);
  for (let attempt = 0; attempt < 16; attempt += 1) {
    try {
      const lock = await createPublicationLock(outputDir, operations, inspectProcess);
      try {
        await cleanupPublicationMetadataStages(outputDir, operations);
        return lock;
      } catch (error) {
        await lock.handle.close().catch(() => {});
        await operations.rm(lock.lockPath, { force: true }).catch(() => {});
        throw error;
      }
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }

    const owner = await readRecoverablePublicationOwner(lockPath, operations);
    if (!owner || await publicationOwnerIsActive(owner, inspectProcess)) {
      throw new Error("another composition publication is active");
    }
    const recoveryPath = path.join(outputDir, `${PUBLICATION_RECOVERY_PREFIX}${randomUUID()}.json`);
    try {
      await operations.rename(lockPath, recoveryPath);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
  }
  throw new Error("could not acquire composition publication ownership");
}

async function pathExists(filePath, operations) {
  try {
    await operations.access(filePath);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function readTransactionJournal(outputDir, owner, operations) {
  const journalPath = path.join(outputDir, owner.journal);
  let journal;
  try {
    journal = JSON.parse(await operations.readFile(journalPath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw new Error("Cannot safely recover composition publication transaction", { cause: error });
  }
  if (journal?.schemaVersion !== 1
    || journal.token !== owner.token
    || !Array.isArray(journal.files)
    || journal.files.length === 0) {
    throw new Error("Cannot safely recover composition publication transaction");
  }
  const stageRelative = validateTransactionRelative(journal.stageDir, "stage directory");
  const files = journal.files.map((entry) => {
    if (typeof entry !== "object" || typeof entry.hadExisting !== "boolean") {
      throw new Error("Cannot safely recover composition publication transaction");
    }
    return {
      hadExisting: entry.hadExisting,
      relative: validateTransactionRelative(entry.relative, "artifact path"),
    };
  });
  return {
    committedPath: `${journalPath}.committed`,
    files,
    journalPath,
    stageDir: path.join(outputDir, stageRelative),
  };
}

async function recoverPublicationTransaction(outputDir, recoveryPath, operations) {
  const owner = await readRecoverablePublicationOwner(recoveryPath, operations);
  if (!owner) throw new Error("Cannot safely recover composition publication owner");
  const transaction = await readTransactionJournal(outputDir, owner, operations);
  if (!transaction) {
    await operations.rm(recoveryPath, { force: true });
    return;
  }
  const committed = await pathExists(transaction.committedPath, operations);
  if (!committed) {
    const backupDir = path.join(transaction.stageDir, ".publish-backup");
    for (const entry of [...transaction.files].reverse()) {
      const destination = path.join(outputDir, entry.relative);
      const backup = path.join(backupDir, entry.relative);
      if (!entry.hadExisting) {
        await operations.rm(destination, { force: true });
        continue;
      }
      if (await pathExists(backup, operations)) {
        await operations.rm(destination, { force: true });
        await operations.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
        await operations.rename(backup, destination);
      } else if (!(await pathExists(destination, operations))) {
        throw new Error("Cannot safely restore a pre-existing composition artifact");
      }
    }
  }
  await operations.rm(transaction.stageDir, { recursive: true, force: true });
  await operations.rm(transaction.journalPath, { force: true });
  await operations.rm(transaction.committedPath, { force: true });
  await operations.rm(recoveryPath, { force: true });
}

async function recoverAbandonedPublications(outputDir, operations) {
  const entries = await operations.readdir(outputDir);
  for (const entry of entries.filter((name) => name.startsWith(PUBLICATION_RECOVERY_PREFIX)).sort()) {
    await recoverPublicationTransaction(outputDir, path.join(outputDir, entry), operations);
  }
}

function markPublicationRecoveryRequired(error, stageDir) {
  const failure = error instanceof Error
    ? error
    : new Error("Composition publication requires recovery", { cause: error });
  publicationRecoveryStages.set(failure, path.resolve(stageDir));
  return failure;
}

async function queuePublicationRecovery(lock, outputDir, operations) {
  try {
    const metadata = JSON.parse(await operations.readFile(lock.lockPath, "utf8"));
    if (metadata.token !== lock.token) return;
    await operations.rename(
      lock.lockPath,
      path.join(outputDir, `${PUBLICATION_RECOVERY_PREFIX}${randomUUID()}.json`),
    );
  } catch {
    // The owned lock remains recoverable after this publisher exits.
  }
}

async function publishStagedOutputs({
  stageDir,
  outputDir,
  files = PUBLIC_OUTPUTS,
  operations = fs,
  inspectProcess = defaultInspectPublicationProcess,
}) {
  const backupDir = path.join(stageDir, ".publish-backup");
  const movedExisting = [];
  const published = [];
  for (const relative of files) {
    await operations.access(path.join(stageDir, relative));
  }
  const lock = await acquirePublicationLock(outputDir, operations, inspectProcess);
  let transaction;
  let transactionNeedsRecovery = false;
  let publicationFailure;
  try {
    await recoverAbandonedPublications(outputDir, operations);
    const plannedFiles = [];
    for (const relative of files) {
      const normalized = validateTransactionRelative(relative, "artifact path");
      plannedFiles.push({
        relative: normalized,
        hadExisting: await pathExists(path.join(outputDir, normalized), operations),
      });
    }
    transaction = {
      committedPath: `${lock.journalPath}.committed`,
      journalPath: lock.journalPath,
      value: {
        schemaVersion: 1,
        token: lock.token,
        stageDir: transactionStageRelative(stageDir, outputDir),
        files: plannedFiles,
      },
    };
    await writeDurableJson(transaction.journalPath, transaction.value, operations);
    transactionNeedsRecovery = true;
    try {
      for (const relative of files) {
        const destination = path.join(outputDir, relative);
        try {
          await operations.access(destination);
        } catch (error) {
          if (error.code === "ENOENT") continue;
          throw error;
        }
        const backup = path.join(backupDir, relative);
        await operations.mkdir(path.dirname(backup), { recursive: true, mode: 0o700 });
        await operations.rename(destination, backup);
        movedExisting.push({ destination, backup });
      }
      for (const relative of files) {
        const source = path.join(stageDir, relative);
        const destination = path.join(outputDir, relative);
        await operations.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
        await operations.rename(source, destination);
        published.push(destination);
      }
      await writeDurableJson(
        transaction.committedPath,
        { schemaVersion: 1, token: lock.token },
        operations,
      );
    } catch (publicationError) {
      try {
        for (const destination of published.reverse()) {
          await operations.rm(destination, { force: true });
        }
        for (const { destination, backup } of movedExisting.reverse()) {
          await operations.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
          await operations.rename(backup, destination);
        }
        await operations.rm(backupDir, { recursive: true, force: true });
        await operations.rm(transaction.journalPath, { force: true });
        await operations.rm(transaction.committedPath, { force: true });
      } catch (rollbackError) {
        throw new AggregateError(
          [publicationError, rollbackError],
          "Composition publication failed and rollback requires recovery",
        );
      }
      transactionNeedsRecovery = false;
      throw publicationError;
    }
    await operations.rm(backupDir, { recursive: true, force: true });
    await operations.rm(transaction.journalPath, { force: true });
    await operations.rm(transaction.committedPath, { force: true });
    transactionNeedsRecovery = false;
  } catch (error) {
    publicationFailure = transactionNeedsRecovery
      ? markPublicationRecoveryRequired(error, stageDir)
      : error;
    throw publicationFailure;
  } finally {
    let closeFailure;
    try {
      await lock.handle.close();
    } catch (error) {
      closeFailure = error;
    }
    if (transactionNeedsRecovery) {
      await queuePublicationRecovery(lock, outputDir, operations);
    } else {
      try {
        const metadata = JSON.parse(await operations.readFile(lock.lockPath, "utf8"));
        if (metadata.token === lock.token) await operations.rm(lock.lockPath, { force: true });
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    if (closeFailure) {
      const failure = publicationFailure
        ? new AggregateError(
          [publicationFailure, closeFailure],
          "Composition publication failed and ownership cleanup also failed",
        )
        : closeFailure;
      throw transactionNeedsRecovery
        ? markPublicationRecoveryRequired(failure, stageDir)
        : failure;
    }
  }
}

function transitionSeconds(scenario) {
  if (Number.isFinite(scenario.production?.transitionSeconds)) {
    return Number(scenario.production.transitionSeconds);
  }
  if (Number.isFinite(scenario.production?.transitionMilliseconds)) {
    return Number(scenario.production.transitionMilliseconds) / 1000;
  }
  return 0.3;
}

function normalizeScenes(scenario) {
  const authoringScenes = scenario.scenes ?? scenario.story;
  if (!Array.isArray(authoringScenes) || authoringScenes.length === 0) {
    throw new Error("A scenario must define at least one story segment");
  }
  return authoringScenes.map((scene, index) => {
    const kind = scene.kind ?? scene.type;
    const defaultDuration = kind === "title" || kind === "end" ? 3 : undefined;
    return {
      ...scene,
      kind,
      id: scene.id ?? `scene-${index + 1}`,
      durationSeconds:
        scene.durationSeconds ??
        (Number.isFinite(scene.durationFrames) ? Number(scene.durationFrames) / 30 : undefined) ??
        scene.duration ??
        defaultDuration,
    };
  });
}

async function loadPointerEvents(context) {
  if (Array.isArray(context.pointerEvents)) return context.pointerEvents;
  if (Array.isArray(context.scenario.pointerEvents)) return context.scenario.pointerEvents;
  const configured =
    context.pointerEventsPath ??
    resolveManifestArtifact(context.manifest?.artifacts?.pointerEvents, context) ??
    context.manifest?.pointerEvents ??
    context.scenario.pointerEventsPath ??
    context.scenario.capture?.pointerEvents;
  if (!configured) return [];
  const resolved = path.isAbsolute(configured) ? configured : path.resolve(context.scenarioDir, configured);
  const source = await fs.readFile(resolved, "utf8");
  return parsePointerEvents(source);
}

function authoredMobileDuration(scenes) {
  const mobile = scenes.filter((scene) => scene.kind === "mobile");
  const duration = mobile.reduce((sum, scene) => sum + Number(scene.durationSeconds), 0);
  if (mobile.length === 0 || !Number.isFinite(duration) || duration <= 0) {
    throw new Error("Mobile composition requires a positive authored mobile budget");
  }
  return duration;
}

function mediaFrameRate(value) {
  const [numerator, denominator = "1"] = String(value).split("/").map(Number);
  return numerator / denominator;
}

function hasExactMobileFrameRates(stream) {
  return [stream?.avg_frame_rate, stream?.r_frame_rate].every((value) => {
    const rate = mediaFrameRate(value);
    return Number.isFinite(rate) && Math.abs(rate - 30) < 0.001;
  });
}

async function prepareMobileInputs({ context, scenes, workDir }) {
  for (const key of ["pointerEvents", "pointerEventsPath"]) {
    if (context[key] !== undefined || context.scenario[key] !== undefined) {
      throw new Error("Mobile composition accepts pointer events only from the digest-bound capture manifest");
    }
  }
  if (context.scenario.capture?.pointerEvents !== undefined) {
    throw new Error("Mobile composition accepts pointer events only from the digest-bound capture manifest");
  }
  const source = context.manifest?.capture?.source;
  const digests = source?.validationEvidence?.artifactSha256;
  const mobileReference = context.manifest?.artifacts?.mobileCapture;
  const pointerReference = context.manifest?.artifacts?.pointerEvents;
  if (typeof mobileReference !== "string" || typeof pointerReference !== "string") {
    throw new Error("Mobile composition requires mobileCapture and pointerEvents manifest artifacts");
  }
  const mobileSnapshot = path.join(workDir, "verified-mobile-capture.mp4");
  const pointerSnapshot = path.join(workDir, "verified-pointer-events.jsonl");
  const mobile = await verifyManifestArtifact({
    root: context.outputDir,
    reference: mobileReference,
    expectedSha256: digests?.mobileCapture,
    label: "mobileCapture",
    snapshotPath: mobileSnapshot,
  });
  const pointer = await verifyManifestArtifact({
    root: context.outputDir,
    reference: pointerReference,
    expectedSha256: digests?.pointerEvents,
    label: "pointerEvents",
    snapshotPath: pointerSnapshot,
    collectBytes: true,
    maximumBytes: MAX_POINTER_EVENTS_BYTES,
  });
  const openedMobile = await openDigestBoundArtifact(
    mobile.snapshotPath,
    digests.mobileCapture,
    "mobileCapture snapshot",
  );
  try {
    const probe = await probeMedia(mobile.snapshotPath, {
      ffprobe: context.ffprobe ?? "ffprobe",
      fileDescriptor: openedMobile.handle.fd,
    });
    await verifyOpenArtifactUnchanged(openedMobile, "mobileCapture snapshot");
    const video = probe.streams?.filter((stream) => stream.codec_type === "video") ?? [];
    const audio = probe.streams?.filter((stream) => stream.codec_type === "audio") ?? [];
    const capturedDuration = Number(probe.format?.duration);
    if (video.length !== 1
      || audio.length !== 0
      || video[0].width !== source?.width
      || video[0].height !== source?.height
      || !hasExactMobileFrameRates(video[0])
      || !Number.isFinite(capturedDuration)
      || capturedDuration <= 0) {
      throw new Error("Verified mobile capture media does not match its manifest source metadata");
    }
    const evidenceDuration = Number(source.validationEvidence?.durationSeconds);
    const authoredDuration = authoredMobileDuration(scenes);
    if (!Number.isFinite(evidenceDuration)
      || Math.abs(evidenceDuration - capturedDuration) > MOBILE_CAPTURE_DURATION_TOLERANCE_SECONDS) {
      throw new Error("Verified mobile capture duration does not match capture validation evidence");
    }
    if (Math.abs(capturedDuration - authoredDuration) > MOBILE_CAPTURE_DURATION_TOLERANCE_SECONDS) {
      throw new Error(
        `Verified mobile capture duration does not match the authored mobile budget within ${MOBILE_CAPTURE_DURATION_TOLERANCE_SECONDS} seconds`,
      );
    }
    const pointerEvents = parsePointerEvents(pointer.bytes.toString("utf8"));
    if (!Array.isArray(pointerEvents)) throw new Error("pointerEvents artifact must contain an event array");
    if (context.manifest?.capture?.kind === "android-emulator") {
      validateAndroidPointerEvents(pointerEvents);
    }
    validatePointerEventsAgainstDuration(pointerEvents, capturedDuration);
    await openedMobile.handle.close();
    return {
      pointerEvents,
      capturedDuration,
      mobileDigest: digests.mobileCapture,
      manifest: {
        ...context.manifest,
        artifacts: {
          ...context.manifest.artifacts,
          mobileCapture: mobile.snapshotPath,
          pointerEvents: pointer.snapshotPath,
        },
      },
    };
  } catch (error) {
    await openedMobile.handle.close();
    throw error;
  }
}

async function renderProductionCard({ scene, scenario, outputDir, context, renderers }) {
  const output = path.join(outputDir, `${slug(scene.id)}.png`);
  const production = scenario.production ?? {};
  const kind = scene.kind === "end" ? "end" : "title";
  const title = scene.title ?? (kind === "end" ? production.endTitle ?? "Demo complete" : production.title ?? scenario.title);
  if (!title) throw new Error(`Scene ${scene.id} needs a title`);
  await renderers.card({
    kind,
    title,
    subtitle: scene.subtitle ?? (kind === "end" ? production.endText : production.subtitle ?? scenario.description),
    label: scene.label,
    output,
    htmlOutput: path.join(outputDir, `${slug(scene.id)}.html`),
    width: 1920,
    height: outputGeometry("1080p").contentHeight,
    fontsDir: path.join(skillDir, "assets/fonts"),
    logoPath: path.join(skillDir, "assets/branding/acp-logo.svg"),
    browserPath: context.browserPath,
  });
  return output;
}

function resolveStorySource(source, scenarioDir) {
  if (!source) return undefined;
  const root = path.resolve(scenarioDir);
  const resolved = path.isAbsolute(source) ? path.resolve(source) : path.resolve(root, source);
  const relative = path.relative(root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Story sources must remain inside the scenario directory");
  }
  return resolved;
}

async function renderStorySource({ scene, scenarioDir, outputDir, context, layout, renderers }) {
  const source = resolveStorySource(scene.source, scenarioDir);
  if (scene.kind === "slides") {
    const cell = layout.cells.slides ?? layout.cells.left;
    const slidesDir = path.join(outputDir, `${slug(scene.id)}-slides`);
    const rendered = await renderers.slides({
      input: source,
      outputDir: slidesDir,
      width: cell.width,
      height: cell.height,
      browserPath: context.browserPath,
      presentermPath: context.presentermPath,
    });
    const track = path.join(outputDir, `${slug(scene.id)}-slides.mp4`);
    await createSlideTrack({
      frames: rendered.framePaths,
      duration: scene.durationSeconds,
      outputPath: track,
      listPath: path.join(slidesDir, "frames.txt"),
      ffmpeg: context.ffmpeg ?? "ffmpeg",
    });
    return track;
  }
  if (scene.kind === "terminal") {
    const cell = layout.cells.terminal ?? layout.cells.left;
    const track = path.join(outputDir, `${slug(scene.id)}-terminal.mp4`);
    await renderers.terminal({
      input: source,
      output: track,
      width: cell.width,
      height: cell.height,
      fps: 30,
      vhsPath: context.vhsPath,
      ffmpegPath: context.ffmpeg,
    });
    return track;
  }
  return source;
}

function mobileCaptureSource(context) {
  const metadata = context.manifest?.capture?.source;
  const width = metadata?.width;
  const height = metadata?.height;
  if (
    metadata?.type !== "mobile" ||
    !Number.isInteger(width) ||
    width <= 0 ||
    !Number.isInteger(height) ||
    height <= 0
  ) {
    throw new Error("Mobile composition requires positive integer source dimensions in manifest.capture.source");
  }
  const capture = resolveManifestArtifact(context.manifest?.artifacts?.mobileCapture, context);
  if (!capture) {
    throw new Error("Mobile composition requires manifest.artifacts.mobileCapture");
  }
  return { path: capture, width, height };
}

async function materializeScenes({ scenes, scenario, scenarioDir, outputDir, context, renderers }) {
  const result = [];
  const preset = scenario.layout?.preset ?? "browser-full";
  const layout = layoutFor(preset, "1080p", {
    leftRatio: Number(scenario.layout?.leftPercent ?? 50) / 100,
  });
  const rawBrowser =
    resolveManifestArtifact(context.manifest?.artifacts?.browserCapture, context) ??
    context.manifest?.rawVideo ??
    context.rawVideo;
  const rawMobile = scenes.some((scene) => scene.kind === "mobile")
    ? mobileCaptureSource(context)
    : undefined;
  let sideSource;
  let captureOffset = 0;
  for (const scene of scenes) {
    if ((scene.kind === "title" || scene.kind === "end") && !scene.renderedCard && !scene.cardPath && !scene.source) {
      result.push({ ...scene, renderedCard: await renderProductionCard({ scene, scenario, outputDir, context, renderers }) });
      continue;
    }
    if (scene.kind === "title" || scene.kind === "end") {
      result.push(scene);
      continue;
    }

    if (scene.kind === "mobile" && Object.hasOwn(scene, "source")) {
      throw new Error("Mobile story segments must not define story.source; use the manifest-bound mobile capture");
    }
    const renderedSource = await renderStorySource({ scene, scenarioDir, outputDir, context, layout, renderers });
    if (scene.kind === "slides" || scene.kind === "terminal") sideSource = renderedSource;
    if (scene.kind === "mobile") {
      if (preset !== "mobile-full") {
        throw new Error("Mobile story segments require the mobile-full layout preset");
      }
      result.push({
        ...scene,
        captureStart: captureOffset,
        layout: { preset },
        sources: {
          mobile: {
            ...rawMobile,
            startSeconds: captureOffset,
          },
        },
      });
      captureOffset += scene.durationSeconds;
      continue;
    }
    const browserSource = scene.kind === "browser" && renderedSource ? renderedSource : rawBrowser;
    if (!browserSource) {
      throw new Error(`Scene ${scene.id} requires a captured browser video; run demo capture first or set story.source`);
    }
    if (preset === "browser-full") {
      result.push({
        ...scene,
        captureStart: captureOffset,
        layout: { preset },
        sources: { browser: { path: browserSource, startSeconds: captureOffset } },
      });
    } else if (preset === "slides-extension" || preset === "terminal-extension") {
      const leftName = preset === "slides-extension" ? "slides" : "terminal";
      if (!sideSource) {
        throw new Error(`Scene ${scene.id} requires a ${leftName} story source before browser-only segments`);
      }
      result.push({
        ...scene,
        captureStart: captureOffset,
        layout: { preset },
        sources: {
          [leftName]: sideSource,
          extension: { path: browserSource, startSeconds: captureOffset, crop: "right-extension" },
        },
      });
    } else {
      if (!sideSource) throw new Error(`Scene ${scene.id} requires a left-side source for split layout`);
      const leftPercent = scenario.layout?.leftPercent ?? 50;
      result.push({
        ...scene,
        captureStart: captureOffset,
        layout: { preset: "generic-split", leftRatio: leftPercent / 100 },
        sources: {
          left: sideSource,
          right: { path: browserSource, startSeconds: captureOffset, crop: "right-extension" },
        },
      });
    }
    captureOffset += scene.durationSeconds;
  }
  return result;
}

function authoredCaptionEntries(scenario) {
  return (scenario.captions ?? []).map((caption, index) => ({
    index: index + 1,
    start: Number(caption.startSeconds),
    end: Number(caption.endSeconds),
    text: caption.text,
    sceneId: `caption-${index + 1}`,
  }));
}

function capturedEventSeconds(event, origin) {
  if (Number.isFinite(event.time)) return Number(event.time);
  if (Number.isFinite(event.monotonicSeconds)) return Number(event.monotonicSeconds) - origin;
  if (Number.isFinite(event.monotonicMs)) return (Number(event.monotonicMs) - origin) / 1000;
  return Number(event.seconds ?? event.timestampSeconds);
}

function aspectFitPoint({ cell, sourceWidth, sourceHeight, x, y, geometry }) {
  const scale = Math.min(cell.width / sourceWidth, cell.height / sourceHeight);
  const fittedWidth = Math.max(2, Math.round((sourceWidth * scale) / 2) * 2);
  const fittedHeight = Math.max(2, Math.round((sourceHeight * scale) / 2) * 2);
  const padX = (cell.width - fittedWidth) / 2;
  const padY = (cell.height - fittedHeight) / 2;
  return {
    x: (cell.x + padX + x * fittedWidth) / geometry.width,
    y: (cell.y + padY + y * fittedHeight) / geometry.contentHeight,
  };
}

function projectPoint(event, scene) {
  const x = Number(event.x ?? event.normalizedX);
  const y = Number(event.y ?? event.normalizedY);
  const preset = scene.layout?.preset ?? scene.layout;
  const layout = layoutFor(preset, "1080p", scene.layout ?? {});
  let cell;
  if (preset === "mobile-full") {
    cell = layout.cells.mobile;
    const source = scene.sources?.mobile;
    const sourceWidth = source?.width;
    const sourceHeight = source?.height;
    if (
      !Number.isInteger(sourceWidth) ||
      sourceWidth <= 0 ||
      !Number.isInteger(sourceHeight) ||
      sourceHeight <= 0
    ) {
      throw new Error("Mobile pointer projection requires positive integer source dimensions");
    }
    return aspectFitPoint({
      cell,
      sourceWidth,
      sourceHeight,
      x,
      y,
      geometry: layout.geometry,
    });
  }
  if (preset === "browser-full") {
    cell = layout.cells.browser;
    return aspectFitPoint({
      cell,
      sourceWidth: 1920,
      sourceHeight: 1080,
      x,
      y,
      geometry: layout.geometry,
    });
  }
  cell = layout.cells.extension ?? layout.cells.right;
  const cropStart = 1 - 0.328125;
  const localX = Math.min(1, Math.max(0, (x - cropStart) / 0.328125));
  return aspectFitPoint({
    cell,
    sourceWidth: 1920 * 0.328125,
    sourceHeight: 1080,
    x: localX,
    y,
    geometry: layout.geometry,
  });
}

function projectPointerEvents(events, timeline) {
  const content = timeline.filter((scene) => !["title", "end"].includes(scene.kind));
  for (let index = 1; index < content.length; index += 1) {
    const previous = content[index - 1];
    const current = content[index];
    const captureBoundary = previous.captureStart + previous.duration;
    const captureIsContiguous = Math.abs(current.captureStart - captureBoundary) < 1e-9;
    const compositionOverlaps = current.start < previous.start + previous.duration - 1e-9;
    if (previous.kind === "mobile"
      && current.kind === "mobile"
      && captureIsContiguous
      && compositionOverlaps) {
      throw new Error(
        "Consecutive mobile story segments require a transition of zero to preserve pointer timing",
      );
    }
  }
  if (events.length === 0) return [];
  const monotonicValues = events
    .map((event) => event.monotonicSeconds ?? event.monotonicMs)
    .filter(Number.isFinite)
    .map(Number);
  const origin = monotonicValues[0] ?? 0;
  let previousRelative = -Infinity;
  return events.map((event, index) => {
    const relative = capturedEventSeconds(event, origin);
    if (!Number.isFinite(relative)) {
      throw new Error(`Pointer event ${index + 1} timestamp is not finite`);
    }
    if (relative < 0) {
      throw new Error(`Pointer event ${index + 1} timestamp is negative`);
    }
    if (relative < previousRelative) {
      throw new Error(`Pointer event ${index + 1} timestamp regresses`);
    }
    previousRelative = relative;
    const scene = content.find(
      (candidate) => relative >= candidate.captureStart && relative < candidate.captureStart + candidate.duration,
    );
    if (!scene) throw new Error("Pointer event timestamp falls outside the captured content timeline");
    const point = projectPoint(event, scene);
    return {
      ...event,
      ...point,
      time: scene.start + relative - scene.captureStart,
      endTime: undefined,
    };
  });
}

/**
 * Compose the source tracks described by context.scenario into deterministic
 * 1080p and 720p deliverables. The returned object is safe to merge into the
 * CLI's locked manifest.
 */
export async function composeScenario(context) {
  const scenario = context.scenario;
  if (!scenario || typeof scenario !== "object") throw new Error("composeScenario requires context.scenario");
  if (!(await commandAvailable(context.ffmpeg ?? "ffmpeg"))) throw new Error("ffmpeg is required for composition");
  if (!(await commandAvailable(context.ffprobe ?? "ffprobe"))) throw new Error("ffprobe is required for validation");
  if (!(await ffmpegEncoderAvailable("libx264", context.ffmpeg ?? "ffmpeg"))) {
    throw new Error("ffmpeg must include the free libx264 encoder used for H.264 deliverables");
  }
  if (!(await ffmpegFilterAvailable("ass", context.ffmpeg ?? "ffmpeg"))) {
    throw new Error("ffmpeg must include the free libass filter used for captions and pointer overlays");
  }

  const scenarioDir = path.resolve(context.scenarioDir ?? path.dirname(context.scenarioPath));
  const effectiveContext = resolveCompositionContext(context, scenarioDir, scenario);
  const { outputDir } = effectiveContext;
  await fs.mkdir(outputDir, { recursive: true, mode: 0o700 });
  const stageDir = await fs.mkdtemp(path.join(outputDir, ".compose-stage-"));
  await fs.chmod(stageDir, 0o700);
  const workDir = path.join(stageDir, ".compose-work");
  const cardsDir = path.join(workDir, "cards");
  const captionsDir = stageDir;
  const masterPath = path.join(stageDir, "demo-1080p.mp4");
  const derivativePath = path.join(stageDir, "demo-720p.mp4");
  const contactSheetPath = path.join(stageDir, "contact-sheet.png");
  await fs.mkdir(workDir, { recursive: true, mode: 0o700 });
  let mobileInputs;
  let preserveStageForRecovery = false;
  try {
    await fs.chmod(workDir, 0o700);
    await fs.mkdir(cardsDir, { recursive: true, mode: 0o700 });

    const transition = transitionSeconds(scenario);
    if (transition < 0 || transition > 1) throw new Error("Transition duration must be between 0 and 1 second");
    let scenes = normalizeScenes(scenario);
    if (transition > 0 && scenes.length > 1 && scenes.some((scene) => scene.durationSeconds <= transition)) {
      throw new Error("Every scene must be longer than the configured crossfade transition");
    }
    mobileInputs = scenes.some((scene) => scene.kind === "mobile")
      ? await prepareMobileInputs({ context: effectiveContext, scenes, workDir })
      : undefined;
    const compositionContext = mobileInputs
      ? { ...effectiveContext, manifest: mobileInputs.manifest }
      : effectiveContext;
    const renderers = resolveRendererAdapters(compositionContext);
    scenes = await materializeScenes({
      scenes,
      scenario,
      scenarioDir,
      outputDir: cardsDir,
      context: compositionContext,
      renderers,
    });
    const timeline = timelineFromScenes(scenes, transition);
    const pointerEvents = projectPointerEvents(
      mobileInputs?.pointerEvents ?? await loadPointerEvents({ ...effectiveContext, scenario }),
      timeline,
    );
    const captions = await generateCaptionArtifacts({
      timeline,
      entries: scenario.captions ? authoredCaptionEntries(scenario) : undefined,
      pointerEvents,
      geometry: outputGeometry("1080p"),
      outputDir: captionsDir,
    });

    const ffmpeg = effectiveContext.ffmpeg ?? "ffmpeg";
    const segments = [];
    for (const scene of timeline) {
      const outputPath = path.join(workDir, `${String(segments.length + 1).padStart(3, "0")}-${slug(scene.id)}.mp4`);
      let openedSceneSource;
      try {
        const renderScene = scene.kind === "mobile"
          ? (() => {
            const source = scene.sources.mobile;
            return { ...scene, sources: { ...scene.sources, mobile: { ...source } } };
          })()
          : scene;
        if (scene.kind === "mobile") {
          openedSceneSource = await openDigestBoundArtifact(
            renderScene.sources.mobile.path,
            mobileInputs.mobileDigest,
            "mobileCapture render snapshot",
          );
          renderScene.sources.mobile.fileDescriptor = openedSceneSource.handle.fd;
        }
        await renderSceneSegment({
          scene: renderScene,
          scenarioDir,
          outputPath,
          duration: scene.duration,
          ffmpeg,
        });
        if (openedSceneSource) {
          await verifyOpenArtifactUnchanged(openedSceneSource, "mobileCapture render snapshot");
        }
      } finally {
        if (openedSceneSource) await openedSceneSource.handle.close();
      }
      segments.push(outputPath);
    }

    const joinedPath = path.join(workDir, "joined.mp4");
    const joined = await joinSegments({
      segments,
      durations: timeline.map((scene) => scene.duration),
      outputPath: joinedPath,
      transitionSeconds: transition,
      ffmpeg,
    });
    await overlayAss({
      inputPath: joinedPath,
      assPath: captions.files.ass,
      fontsDir: path.join(skillDir, "assets/fonts"),
      outputPath: masterPath,
      ffmpeg,
    });
    await create720pDerivative({ inputPath: masterPath, outputPath: derivativePath, ffmpeg });
    await createContactSheet({
      inputPath: masterPath,
      outputPath: contactSheetPath,
      duration: joined.duration,
      ffmpeg,
    });

    await fs.rm(workDir, { recursive: true, force: true });
    const sensitiveValues = androidSetupSensitiveValues(
      scenario,
      effectiveContext.environment ?? process.env,
    );
    const validation = await validateMedia({
      outputDir: stageDir,
      masterPath,
      derivativePath,
      expectedDuration: joined.duration,
      ffprobe: effectiveContext.ffprobe ?? "ffprobe",
      manifest: effectiveContext.manifest,
      scenario,
      captureRoot: effectiveContext.outputDir,
      sensitiveValues,
      secretScanRoot: effectiveContext.outputDir,
    });
    const reportFindings = scanTextForSecrets(
      await fs.readFile(validation.reportPath, "utf8"),
      "validation-report.json",
      { sensitiveValues },
    );
    if (reportFindings.length > 0) {
      throw new Error("Secret-like data found in the staged validation report");
    }

    const portable = {
      master: "demo-1080p.mp4",
      derivative: "demo-720p.mp4",
      contactSheet: "contact-sheet.png",
      captions: Object.fromEntries(
        Object.entries(captions.files).map(([name, file]) => [name, path.basename(file)]),
      ),
      validationReport: path.basename(validation.reportPath),
    };

    const result = {
      artifacts: {
        masterVideo: portable.master,
        derivativeVideo: portable.derivative,
        contactSheet: portable.contactSheet,
        captionsVtt: portable.captions.vtt,
        captionsSrt: portable.captions.srt,
        transcript: portable.captions.transcript,
        validationReport: portable.validationReport,
      },
      composition: {
        schemaVersion: 1,
        ...portable,
        width: 1920,
        height: 1080,
        fps: 30,
        durationSeconds: joined.duration,
        silent: true,
        scenes: timeline.map(({ id, start, end, duration, kind, layout }) => ({ id, start, end, duration, kind, layout })),
      },
    };
    await publishStagedOutputs({
      stageDir,
      outputDir,
      operations: effectiveContext.publicationOperations ?? fs,
      inspectProcess: effectiveContext.publicationInspectProcess ?? defaultInspectPublicationProcess,
    });
    return result;
  } catch (error) {
    preserveStageForRecovery = publicationRecoveryStages.get(error) === path.resolve(stageDir);
    throw error;
  } finally {
    if (!preserveStageForRecovery) {
      await fs.rm(stageDir, { recursive: true, force: true });
    }
  }
}

export { generateCaptionArtifacts, layoutFor, outputGeometry, scanOutputSecrets, validateMedia } from "./public.mjs";
export {
  androidSetupSensitiveValues,
  authoredCaptionEntries,
  aspectFitPoint,
  materializeScenes,
  MOBILE_CAPTURE_DURATION_TOLERANCE_SECONDS,
  mobileCaptureSource,
  normalizeScenes,
  projectPointerEvents,
  prepareMobileInputs,
  validatePointerEventsAgainstDuration,
  publishStagedOutputs,
  acquirePublicationLock,
  resolveCompositionContext,
  resolveManifestArtifact,
  resolveRendererAdapters,
  resolveStorySource,
};
