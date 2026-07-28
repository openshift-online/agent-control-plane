import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { sanitizedSubprocessEnvironment } from "./security-values.mjs";

const execFileAsync = promisify(execFile);

const TEXT_EXTENSIONS = new Set([
  ".ass",
  ".json",
  ".jsonl",
  ".log",
  ".md",
  ".srt",
  ".txt",
  ".vtt",
  ".yaml",
  ".yml",
]);

const IMAGE_EXTENSIONS = new Set([".bmp", ".jpeg", ".jpg", ".png", ".tif", ".tiff", ".webp"]);
const VIDEO_EXTENSIONS = new Set([".m4v", ".mkv", ".mov", ".mp4", ".webm"]);
const DEFAULT_MAX_VIDEO_FRAMES = 24;
const VISUAL_CACHE_LIMIT = 16;
const visualScanCache = new Map();

const SECRET_PATTERNS = Object.freeze([
  { id: "authorization-header", regex: /authorization\s*[:=]\s*["']?bearer\s+[A-Za-z0-9._~+\/-]{12,}/gi },
  { id: "bearer-token", regex: /\bbearer\s+[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]{8,})?/gi },
  { id: "jwt", regex: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  { id: "private-key", regex: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g },
  { id: "generic-secret", regex: /\b(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)\s*[:=]\s*["']?[A-Za-z0-9._~+\/-]{12,}/gi },
  { id: "aws-access-key", regex: /\b(?:AKIA|ASIA)(?:[A-Z0-9]\s*){16}\b/g },
]);

function redactMatch() {
  return "[redacted]";
}

function configuredRepresentations(sensitiveValues = []) {
  const representations = new Map();
  for (const candidate of sensitiveValues) {
    if (typeof candidate !== "string" || candidate.length === 0) continue;
    for (const [encoding, value] of [
      ["raw", candidate],
      ["json", JSON.stringify(candidate).slice(1, -1)],
      ["uri", encodeURIComponent(candidate)],
      ["base64", Buffer.from(candidate, "utf8").toString("base64")],
      ["base64url", Buffer.from(candidate, "utf8").toString("base64url")],
    ]) {
      if (value.length > 0 && !representations.has(value)) representations.set(value, encoding);
    }
  }
  return representations;
}

function redactConfiguredRepresentations(value, sensitiveValues) {
  let redacted = String(value);
  const representations = [...configuredRepresentations(sensitiveValues).keys()]
    .sort((left, right) => right.length - left.length);
  for (const representation of representations) {
    redacted = redacted.replaceAll(representation, "[redacted]");
  }
  return redacted;
}

function sanitizeFinding(finding, sensitiveValues, { staticEvidence = false } = {}) {
  return {
    ...finding,
    source: redactConfiguredRepresentations(finding.source, sensitiveValues),
    ...(staticEvidence ? { evidence: "[configured value redacted]" } : {}),
  };
}

function scanConfiguredValues(text, source, sensitiveValues) {
  const findings = [];
  for (const [value, encoding] of configuredRepresentations(sensitiveValues)) {
    let offset = String(text).indexOf(value);
    while (offset >= 0) {
      findings.push({
        source,
        pattern: "configured-value",
        encoding,
        offset,
        evidence: "[configured value redacted]",
      });
      offset = String(text).indexOf(value, offset + value.length);
    }
  }
  return findings;
}

export function scanTextForSecrets(text, source = "<memory>", { sensitiveValues = [] } = {}) {
  const findings = [];
  for (const pattern of SECRET_PATTERNS) {
    pattern.regex.lastIndex = 0;
    for (const match of text.matchAll(pattern.regex)) {
      findings.push({
        source,
        pattern: pattern.id,
        offset: match.index,
        evidence: redactMatch(match[0]),
      });
    }
  }
  const configuredFindings = scanConfiguredValues(text, source, sensitiveValues);
  findings.push(...configuredFindings);
  return findings.map((finding) => sanitizeFinding(finding, sensitiveValues, {
    staticEvidence: configuredFindings.length > 0,
  }));
}

async function walk(root) {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const resolved = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(resolved)));
    else if (entry.isFile()) files.push(resolved);
  }
  return files;
}

async function executeFile(command, args, { timeoutMs = 60_000 } = {}) {
  return execFileAsync(command, args, {
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
    env: sanitizedSubprocessEnvironment(),
  });
}

function visualFiles(files) {
  return files.filter((file) => {
    const extension = path.extname(file).toLowerCase();
    return IMAGE_EXTENSIONS.has(extension) || VIDEO_EXTENSIONS.has(extension);
  });
}

function visualScanError(source) {
  return {
    source,
    pattern: "visual-scan-error",
    evidence: "visual inspection failed closed",
  };
}

async function visualCacheKey(files, options) {
  if (options.sensitiveValues.length > 0) return undefined;
  if (options.execute !== executeFile) return undefined;
  const fingerprints = await Promise.all(visualFiles(files).map(async (file) => {
    const stat = await fs.stat(file, { bigint: true });
    return `${path.resolve(file)}:${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}`;
  }));
  return `${options.ffmpeg}\0${options.ffprobe}\0${options.tesseract}\0${options.maxVideoFrames}\0${fingerprints.join("\0")}`;
}

function cacheVisualScan(key, value) {
  if (!key) return;
  if (visualScanCache.size >= VISUAL_CACHE_LIMIT) {
    visualScanCache.delete(visualScanCache.keys().next().value);
  }
  visualScanCache.set(key, value);
}

async function ocrImage(file, source, { execute, tesseract, sensitiveValues }) {
  const { stdout } = await execute(tesseract, [file, "stdout", "--psm", "11", "--dpi", "300"], { timeoutMs: 60_000 });
  return scanTextForSecrets(String(stdout), source, { sensitiveValues });
}

async function videoDuration(file, { execute, ffprobe }) {
  const { stdout } = await execute(ffprobe, [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    file,
  ], { timeoutMs: 30_000 });
  const duration = Number(String(stdout).trim());
  if (!Number.isFinite(duration) || duration <= 0) throw new Error("video duration is unavailable");
  return duration;
}

async function sampleVideo(file, destination, options) {
  const duration = await videoDuration(file, options);
  const interval = Math.min(duration, Math.max(0.5, duration / options.maxVideoFrames));
  const framePattern = path.join(destination, "frame-%04d.png");
  await fs.mkdir(destination, { recursive: true, mode: 0o700 });
  await options.execute(options.ffmpeg, [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-i",
    file,
    "-vf",
    `fps=1/${interval.toFixed(6)},scale=1920:-2:force_original_aspect_ratio=decrease:flags=lanczos`,
    "-fps_mode",
    "vfr",
    "-frames:v",
    String(options.maxVideoFrames),
    framePattern,
  ], { timeoutMs: 120_000 });
  const frames = (await fs.readdir(destination))
    .filter((entry) => /^frame-\d{4}\.png$/.test(entry))
    .sort()
    .map((entry) => path.join(destination, entry));
  if (frames.length === 0) throw new Error("video sampling produced no frames");
  return frames;
}

async function scanVisualSecrets(outputDir, files, options) {
  const candidates = visualFiles(files);
  const result = {
    required: candidates.length > 0,
    ok: true,
    files: candidates.length,
    images: 0,
    videos: 0,
    sampledFrames: 0,
    maxVideoFrames: options.maxVideoFrames,
  };
  if (candidates.length === 0) return { findings: [], result };

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "demo-visual-secret-scan-"));
  const findings = [];
  try {
    await fs.chmod(tempDir, 0o700);
    for (const [index, file] of candidates.entries()) {
      const relative = path.relative(outputDir, file);
      const extension = path.extname(file).toLowerCase();
      try {
        if (IMAGE_EXTENSIONS.has(extension)) {
          result.images += 1;
          findings.push(...(await ocrImage(file, `${relative}#ocr`, options)));
          continue;
        }
        result.videos += 1;
        const frames = await sampleVideo(file, path.join(tempDir, `video-${index + 1}`), options);
        result.sampledFrames += frames.length;
        for (const [frameIndex, frame] of frames.entries()) {
          findings.push(...(await ocrImage(frame, `${relative}#frame-${frameIndex + 1}`, options)));
        }
      } catch {
        findings.push(visualScanError(relative));
      }
    }
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
  result.ok = findings.length === 0;
  return { findings, result };
}

export async function scanOutputSecrets(outputDir, {
  metadata = [],
  sensitiveValues = [],
  execute = executeFile,
  ffmpeg = "ffmpeg",
  ffprobe = "ffprobe",
  tesseract = "tesseract",
  maxVideoFrames = DEFAULT_MAX_VIDEO_FRAMES,
} = {}) {
  if (!Number.isInteger(maxVideoFrames) || maxVideoFrames < 1 || maxVideoFrames > 120) {
    throw new Error("maxVideoFrames must be an integer between 1 and 120");
  }
  const files = await walk(outputDir).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const findings = [];
  for (const file of files) {
    if (!TEXT_EXTENSIONS.has(path.extname(file).toLowerCase())) continue;
    const text = await fs.readFile(file, "utf8");
    findings.push(...scanTextForSecrets(text, path.relative(outputDir, file), { sensitiveValues }));
  }
  for (const item of metadata) {
    findings.push(...scanTextForSecrets(JSON.stringify(item.value), item.source, { sensitiveValues }));
  }
  const candidates = visualFiles(files);
  if (findings.length > 0) {
    return {
      ok: false,
      findings: findings.map((finding) => sanitizeFinding(finding, sensitiveValues)),
      scannedFiles: files.length,
      visualScan: {
        required: candidates.length > 0,
        ok: false,
        skipped: "blocked-by-text-findings",
        files: candidates.length,
        images: 0,
        videos: 0,
        sampledFrames: 0,
        maxVideoFrames,
      },
    };
  }
  const visualOptions = {
    execute,
    ffmpeg,
    ffprobe,
    tesseract,
    maxVideoFrames,
    sensitiveValues,
  };
  const cacheKey = await visualCacheKey(files, visualOptions);
  let visual = cacheKey ? visualScanCache.get(cacheKey) : undefined;
  if (!visual) {
    visual = await scanVisualSecrets(outputDir, files, visualOptions);
    cacheVisualScan(cacheKey, visual);
  }
  findings.push(...visual.findings);
  return {
    ok: findings.length === 0 && visual.result.ok,
    findings: findings.map((finding) => sanitizeFinding(finding, sensitiveValues)),
    scannedFiles: files.length,
    visualScan: visual.result,
  };
}

export { DEFAULT_MAX_VIDEO_FRAMES, IMAGE_EXTENSIONS, SECRET_PATTERNS, VIDEO_EXTENSIONS, scanVisualSecrets };
