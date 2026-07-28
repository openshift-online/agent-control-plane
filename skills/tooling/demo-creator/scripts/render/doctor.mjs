import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pathExists, resolveChrome, resolveExecutable } from "./common.mjs";

const REQUIRED_CARD_ASSETS = [
  "assets/fonts/RedHatDisplay-Bold.ttf",
  "assets/fonts/RedHatText-Regular.ttf",
  "assets/fonts/RedHatText-Bold.ttf",
  "assets/fonts/RedHatMono-Regular.ttf",
  "assets/branding/acp-logo.svg",
];

const REQUIRED_SLIDE_ASSETS = [
  "assets/fonts/RedHatMono-Regular.ttf",
  "assets/fonts/RedHatMono-Bold.ttf",
];

const RENDER_ASSETS = [...new Set([...REQUIRED_CARD_ASSETS, ...REQUIRED_SLIDE_ASSETS])];

async function binaryCheck(name, resolver) {
  const path = await resolver();
  return { name, ok: Boolean(path), path };
}

export async function renderDoctor(options = {}) {
  const skillRoot = resolve(options.skillRoot ?? fileURLToPath(new URL("../..", import.meta.url)));
  const tools = await Promise.all([
    binaryCheck("presenterm", () => resolveExecutable("presenterm", options.presentermPath)),
    binaryCheck("vhs", () => resolveExecutable("vhs", options.vhsPath)),
    binaryCheck("ffmpeg", () => resolveExecutable("ffmpeg", options.ffmpegPath)),
    binaryCheck("browser", () => resolveChrome(options.browserPath)),
  ]);
  const assets = await Promise.all(RENDER_ASSETS.map(async (relativePath) => ({
    name: relativePath,
    path: resolve(skillRoot, relativePath),
    ok: await pathExists(resolve(skillRoot, relativePath)),
  })));
  const required = new Set(options.required ?? []);
  const requirements = {
    slides: ["presenterm", "browser", ...REQUIRED_SLIDE_ASSETS],
    terminal: ["vhs", "ffmpeg"],
    cards: ["browser", ...REQUIRED_CARD_ASSETS],
  };
  const checks = [...tools, ...assets];
  const requiredNames = [...required].flatMap((name) => requirements[name] ?? [name]);
  const ok = requiredNames.every((name) => checks.find((check) => check.name === name)?.ok);
  return { ok, required: [...required], checks };
}
