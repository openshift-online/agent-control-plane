import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { layoutFor } from "./layout.mjs";
import { sanitizedSubprocessEnvironment } from "./security-values.mjs";

function run(command, args, options = {}) {
  const inheritedFileDescriptors = options.inheritedFileDescriptors ?? [];
  const timeoutMs = options.timeoutMs ?? 600_000;
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: sanitizedSubprocessEnvironment(process.env, options.env),
      stdio: ["ignore", "pipe", "pipe", ...inheritedFileDescriptors],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = Number.isFinite(timeoutMs) && timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, timeoutMs)
      : null;
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (error) => {
      if (timer) clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      if (timedOut) reject(new Error(`${command} timed out after ${timeoutMs}ms`));
      else if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} exited ${code}: ${stderr.slice(-4000)}`));
    });
  });
}

export async function commandAvailable(command) {
  try {
    await run(command, ["-version"]);
    return true;
  } catch {
    return false;
  }
}

export async function ffmpegFilterAvailable(filter, ffmpeg = "ffmpeg") {
  try {
    const { stdout, stderr } = await run(ffmpeg, ["-hide_banner", "-filters"]);
    return `${stdout}\n${stderr}`
      .split(/\r?\n/)
      .some((line) => line.trim().split(/\s+/).includes(filter));
  } catch {
    return false;
  }
}

export async function ffmpegEncoderAvailable(encoder, ffmpeg = "ffmpeg", execute = run) {
  try {
    const { stdout, stderr } = await execute(ffmpeg, ["-hide_banner", "-encoders"]);
    return `${stdout}\n${stderr}`
      .split(/\r?\n/)
      .some((line) => line.trim().split(/\s+/).includes(encoder));
  } catch {
    return false;
  }
}

function sourcePath(source) {
  if (typeof source === "string") return source;
  return source?.path ?? source?.file ?? source?.video ?? source?.image;
}

function sourceType(source, file) {
  if (typeof source === "object" && source?.type) return source.type;
  return /\.(?:png|jpe?g|webp)$/i.test(file) ? "image" : "video";
}

function sourceStart(source) {
  if (typeof source !== "object") return 0;
  const value = Number(source.startSeconds ?? source.offsetSeconds ?? 0);
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function sourceCrop(source) {
  if (typeof source !== "object") return "";
  if (source.crop === "right-extension") {
    return "crop=iw*0.328125:ih:iw-iw*0.328125:0,";
  }
  return "";
}

function resolveSource(file, scenarioDir) {
  return path.isAbsolute(file) ? file : path.resolve(scenarioDir, file);
}

function sourceMapForScene(scene, layout) {
  const sources = scene.sources ?? {};
  if (typeof sources === "string") {
    const onlyCell = Object.keys(layout.cells)[0];
    return { [onlyCell]: sources };
  }
  const result = {};
  for (const cell of Object.keys(layout.cells)) {
    result[cell] = sources[cell];
  }
  if (Object.keys(layout.cells).length === 1) {
    const onlyCell = Object.keys(layout.cells)[0];
    result[onlyCell] ??=
      scene.renderedCard ?? scene.cardPath ?? scene.source ?? sources.browser ?? sources.full;
  }
  return result;
}

const SAFE_NAMED_COLORS = new Set([
  "black", "white", "gray", "grey", "red", "green", "blue", "yellow", "cyan", "magenta", "orange",
]);

function filterSafeColor(color) {
  const value = String(color ?? "").trim();
  const hex = value.replace(/^#/, "");
  if (/^[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/.test(hex)) return `0x${hex}`;
  if (SAFE_NAMED_COLORS.has(value.toLowerCase())) return value.toLowerCase();
  return "0x292929";
}

/** Build a deterministic, silent, exact-size scene segment. */
export async function renderSceneSegment({
  scene,
  scenarioDir,
  outputPath,
  duration,
  ffmpeg = "ffmpeg",
  execute = run,
}) {
  const preset = scene.layout?.preset ?? scene.layout ?? "browser-full";
  const layout = layoutFor(preset, "1080p", scene.layout ?? {});
  const sources = sourceMapForScene(scene, layout);
  const args = ["-hide_banner", "-loglevel", "error", "-y"];
  const filter = [
    `color=c=${filterSafeColor(scene.background)}:s=${layout.geometry.width}x${layout.geometry.contentHeight}:r=30:d=${duration}[base]`,
  ];
  let inputIndex = 0;
  let previous = "base";
  const inheritedFileDescriptors = [];

  for (const [cellName, cell] of Object.entries(layout.cells)) {
    const source = sources[cellName];
    const file = sourcePath(source);
    if (!file) throw new Error(`Scene ${scene.id ?? "<unknown>"} is missing source for ${cellName}`);
    const absolute = resolveSource(file, scenarioDir);
    const fileDescriptor = Number.isInteger(source?.fileDescriptor) && source.fileDescriptor >= 0
      ? source.fileDescriptor
      : undefined;
    if (fileDescriptor === undefined) await fs.access(absolute);
    let input = absolute;
    if (fileDescriptor !== undefined) {
      const childFileDescriptor = 3 + inheritedFileDescriptors.length;
      inheritedFileDescriptors.push(fileDescriptor);
      input = `/dev/fd/${childFileDescriptor}`;
    }
    const start = sourceStart(source);
    if (start > 0) args.push("-ss", String(start));
    if (sourceType(source, absolute) === "image") args.push("-loop", "1", "-framerate", "30");
    else if (scene.kind !== "mobile") args.push("-stream_loop", "-1");
    args.push("-i", input);
    filter.push(
      `[${inputIndex}:v]setpts=PTS-STARTPTS,${sourceCrop(source)}scale=${cell.width}:${cell.height}:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=lanczos,pad=${cell.width}:${cell.height}:(ow-iw)/2:(oh-ih)/2:color=0x151515,setsar=1[cell${inputIndex}]`,
    );
    const next = `overlay${inputIndex}`;
    filter.push(
      `[${previous}][cell${inputIndex}]overlay=x=${cell.x}:y=${cell.y}:shortest=1[${next}]`,
    );
    previous = next;
    inputIndex += 1;
  }

  filter.push(
    `color=c=black:s=${layout.geometry.width}x${layout.geometry.captionHeight}:r=30:d=${duration}[caption]`,
    `[${previous}][caption]vstack=inputs=2,trim=duration=${duration},setpts=PTS-STARTPTS,format=yuv420p[out]`,
  );
  args.push(
    "-filter_complex",
    filter.join(";"),
    "-map",
    "[out]",
    "-an",
    "-r",
    "30",
    "-c:v",
    "libx264",
    "-preset",
    "medium",
    "-crf",
    "18",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    "-t",
    String(duration),
    outputPath,
  );
  await execute(ffmpeg, args, { inheritedFileDescriptors });
  return { outputPath, args, layout };
}

export function xfadeFilter(durations, transitionSeconds = 0.3) {
  if (durations.length === 0) throw new Error("At least one segment is required");
  if (durations.length === 1) return { filter: null, output: "0:v", duration: durations[0] };
  if (transitionSeconds === 0) {
    const inputs = durations.map((_, index) => `[${index}:v]`).join("");
    return {
      filter: `${inputs}concat=n=${durations.length}:v=1:a=0[concat]`,
      output: "concat",
      duration: durations.reduce((sum, duration) => sum + duration, 0),
    };
  }
  const filters = [];
  let previous = "0:v";
  let elapsed = durations[0];
  for (let index = 1; index < durations.length; index += 1) {
    const output = `xf${index}`;
    const offset = elapsed - transitionSeconds * index;
    filters.push(
      `[${previous}][${index}:v]xfade=transition=fade:duration=${transitionSeconds}:offset=${offset.toFixed(6)}[${output}]`,
    );
    previous = output;
    elapsed += durations[index];
  }
  return {
    filter: filters.join(";"),
    output: previous,
    duration: elapsed - transitionSeconds * (durations.length - 1),
  };
}

export async function joinSegments({
  segments,
  durations,
  outputPath,
  transitionSeconds = 0.3,
  ffmpeg = "ffmpeg",
  execute = run,
}) {
  const args = ["-hide_banner", "-loglevel", "error", "-y"];
  for (const segment of segments) args.push("-i", segment);
  const xfade = xfadeFilter(durations, transitionSeconds);
  if (xfade.filter) args.push("-filter_complex", xfade.filter, "-map", `[${xfade.output}]`);
  else args.push("-map", xfade.output);
  args.push(
    "-an",
    "-r",
    "30",
    "-c:v",
    "libx264",
    "-preset",
    "medium",
    "-crf",
    "18",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    outputPath,
  );
  await execute(ffmpeg, args);
  return { outputPath, duration: xfade.duration, args };
}

function escapeFilterPath(value) {
  return path.resolve(value).replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "'\\''");
}

export async function overlayAss({
  inputPath,
  assPath,
  fontsDir,
  outputPath,
  ffmpeg = "ffmpeg",
  execute = run,
}) {
  const filter = `ass=filename='${escapeFilterPath(assPath)}':fontsdir='${escapeFilterPath(fontsDir)}'`;
  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-i",
    inputPath,
    "-vf",
    filter,
    "-an",
    "-r",
    "30",
    "-c:v",
    "libx264",
    "-preset",
    "medium",
    "-crf",
    "18",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    outputPath,
  ];
  await execute(ffmpeg, args);
  return { outputPath, args };
}

export async function create720pDerivative({ inputPath, outputPath, ffmpeg = "ffmpeg", execute = run }) {
  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-i",
    inputPath,
    "-vf",
    "scale=1280:720:flags=lanczos,setsar=1",
    "-an",
    "-r",
    "30",
    "-c:v",
    "libx264",
    "-preset",
    "medium",
    "-crf",
    "20",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    outputPath,
  ];
  await execute(ffmpeg, args);
  return { outputPath, args };
}

export async function createContactSheet({
  inputPath,
  outputPath,
  duration,
  ffmpeg = "ffmpeg",
  execute = run,
}) {
  const interval = Math.max(0.1, duration / 12);
  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-i",
    inputPath,
    "-vf",
    `fps=1/${interval.toFixed(6)},scale=480:-2:flags=lanczos,tile=4x3:padding=4:margin=4:color=black`,
    "-frames:v",
    "1",
    outputPath,
  ];
  await execute(ffmpeg, args);
  return { outputPath, args };
}

function concatPath(file) {
  return path.resolve(file).replace(/'/g, "'\\''");
}

export async function createSlideTrack({
  frames,
  duration,
  outputPath,
  listPath,
  ffmpeg = "ffmpeg",
  execute = run,
}) {
  if (!Array.isArray(frames) || frames.length === 0) throw new Error("At least one rendered slide frame is required");
  const frameDuration = duration / frames.length;
  const lines = [];
  for (const frame of frames) {
    lines.push(`file '${concatPath(frame)}'`, `duration ${frameDuration.toFixed(9)}`);
  }
  lines.push(`file '${concatPath(frames.at(-1))}'`);
  await fs.writeFile(listPath, `${lines.join("\n")}\n`, { mode: 0o600 });
  const args = [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "concat", "-safe", "0", "-i", listPath,
    "-vf", "fps=30,format=yuv420p",
    "-an", "-r", "30", "-t", String(duration),
    "-c:v", "libx264", "-preset", "medium", "-crf", "18",
    "-pix_fmt", "yuv420p", "-movflags", "+faststart",
    outputPath,
  ];
  await execute(ffmpeg, args);
  return { outputPath, args };
}

export { run as runCommand };
