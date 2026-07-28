import { access } from "node:fs/promises";
import path from "node:path";
import { readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// The bearer token lives in this process only so captured artifacts can be
// scanned for accidental leaks — never so a version-probe subprocess (ffmpeg,
// ffprobe, tesseract, vhs, presenterm, node, Xvfb, xdotool) can read it. Strip
// caller credentials from any inherited environment before it reaches a child,
// enforcing the "pass credentials only to the process that needs them" boundary.
// Mirrors capture/common's sanitizedInheritedEnv, compose's
// sanitizedSubprocessEnvironment, and render's sanitizedInheritedEnv so the
// credential boundary is uniform across the skill. Explicit overrides win so a
// value can still be delivered deliberately, and process.env is never mutated.
const CALLER_SENSITIVE_ENVIRONMENT = Object.freeze(["ACP_BEARER_TOKEN"]);

function sanitizedInheritedEnv(overrides = {}) {
  const environment = { ...process.env };
  for (const name of CALLER_SENSITIVE_ENVIRONMENT) delete environment[name];
  return { ...environment, ...overrides };
}

async function commandCheck(name, args = ["--version"], required = true) {
  try {
    const { stdout, stderr } = await execFileAsync(name, args, { timeout: 5000, env: sanitizedInheritedEnv() });
    return { name, required, ok: true, detail: String(stdout || stderr).trim().split("\n")[0] };
  } catch {
    return { name, required, ok: false, detail: "not found or not runnable" };
  }
}

async function pathCheck(name, target, required = true) {
  try {
    await access(target);
    return { name, required, ok: true, detail: target };
  } catch {
    return { name, required, ok: false, detail: `${target} not found` };
  }
}

async function moduleCheck(name, specifier, required = true) {
  try {
    await import(specifier);
    return { name, required, ok: true, detail: `${specifier} is installed` };
  } catch {
    return { name, required, ok: false, detail: `${specifier} is not installed` };
  }
}

async function supportsAss(executable) {
  try {
    const { stdout, stderr } = await execFileAsync(executable, ["-hide_banner", "-filters"], { timeout: 5000, maxBuffer: 4 * 1024 * 1024, env: sanitizedInheritedEnv() });
    const filters = `${stdout}\n${stderr}`;
    return /^\s*[TSC.]+\s+ass\s+/m.test(filters);
  } catch {
    return false;
  }
}

export async function findMediaTools(env = process.env) {
  const candidates = [
    env.DEMO_FFMPEG,
    "ffmpeg",
    "/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg",
    "/usr/local/opt/ffmpeg-full/bin/ffmpeg",
  ].filter(Boolean);
  for (const ffmpeg of [...new Set(candidates)]) {
    if (!(await supportsAss(ffmpeg))) continue;
    const ffprobe = env.DEMO_FFPROBE ?? (path.isAbsolute(ffmpeg) ? path.join(path.dirname(ffmpeg), "ffprobe") : "ffprobe");
    try {
      await execFileAsync(ffprobe, ["-version"], { timeout: 5000, env: sanitizedInheritedEnv() });
      return { ffmpeg, ffprobe };
    } catch {
      // Keep looking for a matched FFmpeg/FFprobe pair.
    }
  }
  return { ffmpeg: env.DEMO_FFMPEG ?? "ffmpeg", ffprobe: env.DEMO_FFPROBE ?? "ffprobe" };
}

async function versionOf(executable, args, pattern) {
  try {
    const { stdout, stderr } = await execFileAsync(executable, args, { timeout: 5000, env: sanitizedInheritedEnv() });
    const line = String(stdout || stderr).trim().split("\n")[0];
    return line.match(pattern)?.[1] ?? line;
  } catch {
    return "unavailable";
  }
}

export async function toolchainSnapshot(mediaTools) {
  const resolvedMediaTools = mediaTools ?? await findMediaTools();
  const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const [ffmpeg, ffprobe, tesseract, vhs, presenterm] = await Promise.all([
    versionOf(resolvedMediaTools.ffmpeg, ["-version"], /^ffmpeg version\s+(\S+)/),
    versionOf(resolvedMediaTools.ffprobe, ["-version"], /^ffprobe version\s+(\S+)/),
    versionOf("tesseract", ["--version"], /^tesseract\s+(\S+)/),
    versionOf("vhs", ["--version"], /(?:vhs version\s+)?(\S+)$/),
    versionOf("presenterm", ["--version"], /(?:presenterm\s+)?(\S+)$/),
  ]);
  return Object.freeze({
    node: process.version,
    ffmpeg,
    ffprobe,
    tesseract,
    vhs,
    presenterm,
    playwright: packageJson.dependencies.playwright,
  });
}

async function ffmpegAssCheck(executable, required = true) {
  const ok = await supportsAss(executable);
  return { name: "ffmpeg-libass", required, ok, detail: ok ? `ASS subtitle filter is available in ${executable}` : `${executable} lacks the ASS subtitle filter` };
}

export async function runDoctor(platform = process.platform, options = {}) {
  const operations = {
    commandCheck,
    ffmpegAssCheck,
    findMediaTools,
    moduleCheck,
    pathCheck,
    ...options.dependencies,
  };
  const mediaTools = await operations.findMediaTools();
  const commonChecks = [
    operations.commandCheck("node"),
    operations.commandCheck(mediaTools.ffmpeg, ["-version"]),
    operations.ffmpegAssCheck(mediaTools.ffmpeg),
    operations.commandCheck(mediaTools.ffprobe, ["-version"]),
    operations.commandCheck("tesseract", ["--version"]),
  ];
  const browserChecks = options.captureKind === "android-emulator" ? [] : [
    operations.commandCheck("vhs"),
    operations.commandCheck("presenterm"),
    operations.moduleCheck("playwright", "playwright"),
    ...(platform === "darwin" ? [
      operations.pathCheck("Hammerspoon", "/Applications/Hammerspoon.app"),
      operations.pathCheck("Chrome for Testing", "/Applications/Google Chrome for Testing.app"),
      operations.pathCheck("OBS", "/Applications/OBS.app"),
    ] : [
      operations.commandCheck("Xvfb", ["-version"]),
      operations.commandCheck("xdotool"),
    ]),
  ];
  const checks = await Promise.all([...commonChecks, ...browserChecks]);
  return { ok: checks.every((check) => check.ok || !check.required), platform, mediaTools, checks };
}
