import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { DEFAULT_FPS, ensureParent, formatCommand, pathExists, resolveExecutable, runCommand, withPrivateTempDir } from "./common.mjs";

const NORMALIZED_SETTINGS = new Set(["shell", "width", "height", "framerate", "fontsize", "padding", "margin", "marginfill", "borderradius", "cursorblink", "theme"]);
const VHS_PRIVATE_DIRECTORIES = Object.freeze({
  HOME: "home",
  TMPDIR: "tmp",
  XDG_CACHE_HOME: "xdg/cache",
  XDG_CONFIG_HOME: "xdg/config",
  XDG_DATA_HOME: "xdg/data",
  XDG_RUNTIME_DIR: "xdg/runtime",
});

export async function createPrivateVhsEnvironment(tempPath, options = {}) {
  const directories = Object.fromEntries(
    Object.entries(VHS_PRIVATE_DIRECTORIES).map(([name, relativePath]) => [name, join(tempPath, relativePath)]),
  );
  await Promise.all(Object.values(directories).map((path) => mkdir(path, { recursive: true, mode: 0o700 })));
  return {
    __CF_USER_TEXT_ENCODING: "0x0:0:0",
    BASH_ENV: "/dev/null",
    ENV: "/dev/null",
    HISTFILE: "/dev/null",
    HOME: directories.HOME,
    LANG: "C",
    LC_ALL: "C",
    NO_COLOR: "1",
    PATH: options.path ?? process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    PROMPT_COMMAND: "",
    PS1: "> ",
    SHELL: "/bin/bash",
    TMPDIR: directories.TMPDIR,
    XDG_CACHE_HOME: directories.XDG_CACHE_HOME,
    XDG_CONFIG_HOME: directories.XDG_CONFIG_HOME,
    XDG_DATA_HOME: directories.XDG_DATA_HOME,
    XDG_RUNTIME_DIR: directories.XDG_RUNTIME_DIR,
  };
}

export function normalizedTape(source, options) {
  const {
    output,
    width,
    height,
    fps = DEFAULT_FPS,
    fontSize = Math.max(18, Math.round(width / 42)),
  } = options;
  const kept = source.split(/\r?\n/).filter((line) => {
    if (/^\s*Output\s+/i.test(line)) return false;
    const setting = line.match(/^\s*Set\s+(\S+)/i)?.[1];
    return !setting || !NORMALIZED_SETTINGS.has(setting.toLowerCase());
  });
  return [
    `Output ${JSON.stringify(output)}`,
    `Set Width ${width}`,
    `Set Height ${height}`,
    `Set Framerate ${fps}`,
    `Set FontSize ${fontSize}`,
    "Set Shell bash",
    "Set Padding 24",
    "Set Margin 0",
    "Set CursorBlink false",
    "Set Theme {\"name\":\"ACP Dark\",\"black\":\"#292929\",\"red\":\"#F56E6E\",\"green\":\"#92D400\",\"yellow\":\"#F4C145\",\"blue\":\"#73BCF7\",\"magenta\":\"#A18FFF\",\"cyan\":\"#009596\",\"white\":\"#FFFFFF\",\"brightBlack\":\"#6A6E73\",\"brightRed\":\"#EE0000\",\"brightGreen\":\"#BDEB61\",\"brightYellow\":\"#F9E0A2\",\"brightBlue\":\"#2B9AF3\",\"brightMagenta\":\"#CBC1FF\",\"brightCyan\":\"#A2D9D9\",\"brightWhite\":\"#FFFFFF\",\"background\":\"#292929\",\"foreground\":\"#F7F7F3\",\"selection\":\"#4F5255\",\"cursor\":\"#FFFFFF\"}",
    "Hide",
    "Type \"export HISTFILE=/dev/null; clear\"",
    "Enter",
    "Show",
    ...kept,
  ].join("\n");
}

export async function renderTerminal(options) {
  const {
    input,
    output,
    width = 1266,
    height = 936,
    fps = DEFAULT_FPS,
    dryRun = false,
    vhsPath,
    ffmpegPath,
  } = options;
  if (!input || !output) throw new Error("terminal input and output are required");
  const absoluteInput = resolve(input);
  const absoluteOutput = resolve(output);
  const vhs = await resolveExecutable("vhs", vhsPath);
  const ffmpeg = await resolveExecutable("ffmpeg", ffmpegPath);
  const plan = {
    renderer: "vhs",
    width,
    height,
    fps,
    input: absoluteInput,
    output: absoluteOutput,
    commands: [
      formatCommand(vhs ?? "vhs", ["<normalized-tape>"]),
      formatCommand(ffmpeg ?? "ffmpeg", ["-i", "<vhs-output>", "-vf", `fps=${fps},scale=${width}:${height}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=#292929`, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-an", absoluteOutput]),
    ],
  };
  if (dryRun) return plan;
  if (!(await pathExists(absoluteInput))) throw new Error(`terminal tape not found: ${absoluteInput}`);
  if (!vhs) throw new Error("VHS is required to render terminal tapes");
  if (!ffmpeg) throw new Error("FFmpeg is required to normalize terminal video");
  await ensureParent(absoluteOutput);
  return await withPrivateTempDir("demo-vhs-", async (tempPath) => {
    const rawOutput = join(tempPath, "terminal-raw.mp4");
    const tapePath = join(tempPath, basename(absoluteInput));
    const source = await readFile(absoluteInput, "utf8");
    await writeFile(tapePath, normalizedTape(source, { output: rawOutput, width, height, fps, fontSize: options.fontSize }), "utf8");
    const vhsEnvironment = await createPrivateVhsEnvironment(tempPath);
    await runCommand(vhs, [tapePath], {
      cwd: dirname(absoluteInput),
      timeoutMs: options.timeoutMs ?? 300_000,
      env: vhsEnvironment,
      inheritEnv: false,
    });
    const filter = `fps=${fps},scale=${width}:${height}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=#292929`;
    await runCommand(ffmpeg, [
      "-hide_banner", "-loglevel", "error", "-y",
      "-i", rawOutput,
      "-vf", filter,
      "-c:v", "libx264",
      "-pix_fmt", "yuv420p",
      "-movflags", "+faststart",
      "-an",
      absoluteOutput,
    ], { timeoutMs: options.timeoutMs ?? 300_000 });
    return plan;
  });
}
