import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureParent, formatCommand, pathExists, resolveChrome } from "./common.mjs";
import { withHeadlessPage } from "./chrome-cdp.mjs";

const COLORS = Object.freeze({
  background: "#292929",
  coral: "#F56E6E",
  red: "#EE0000",
  white: "#FFFFFF",
  paper: "#F7F7F3",
  muted: "#D2D2D2",
});

const FONT_FILES = Object.freeze({
  display: "RedHatDisplay-Bold.ttf",
  text: "RedHatText-Regular.ttf",
  textBold: "RedHatText-Bold.ttf",
  mono: "RedHatMono-Regular.ttf",
});

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function fontData(fontsDir, filename) {
  const path = resolve(fontsDir, filename);
  return (await readFile(path)).toString("base64");
}

export function defaultCardHtmlOutput(output) {
  return /\.png$/i.test(output) ? output.replace(/\.png$/i, ".html") : `${output}.html`;
}

export async function buildCardHtml(options) {
  const {
    kind = "title",
    title,
    subtitle = "",
    label = kind === "title" ? "ACP DEMO" : "LEARN MORE",
    width = 1920,
    height = 1080,
    fontsDir,
    logoPath,
  } = options;
  if (!title) throw new Error("card title is required");
  if (!["title", "end"].includes(kind)) throw new Error("card kind must be title or end");
  if (!fontsDir || !logoPath) throw new Error("fontsDir and logoPath are required");
  const [display, text, textBold, mono, logo] = await Promise.all([
    fontData(fontsDir, FONT_FILES.display),
    fontData(fontsDir, FONT_FILES.text),
    fontData(fontsDir, FONT_FILES.textBold),
    fontData(fontsDir, FONT_FILES.mono),
    readFile(logoPath),
  ]);
  const logoData = logo.toString("base64");
  const scale = width / 1920;
  const titleSize = Math.round((kind === "title" ? 92 : 76) * scale);
  const subtitleSize = Math.round(36 * scale);
  const eyebrowSize = Math.round(22 * scale);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=${width},initial-scale=1">
<style>
@font-face{font-family:"Red Hat Display";src:url(data:font/ttf;base64,${display}) format("truetype");font-weight:700}
@font-face{font-family:"Red Hat Text";src:url(data:font/ttf;base64,${text}) format("truetype");font-weight:400}
@font-face{font-family:"Red Hat Text";src:url(data:font/ttf;base64,${textBold}) format("truetype");font-weight:700}
@font-face{font-family:"Red Hat Mono";src:url(data:font/ttf;base64,${mono}) format("truetype");font-weight:400}
*{box-sizing:border-box}html,body{margin:0;width:${width}px;height:${height}px;overflow:hidden;background:${COLORS.background}}
body{color:${COLORS.white};font-family:"Red Hat Text",sans-serif;background-image:radial-gradient(circle,rgba(255,255,255,.12) 1.25px,transparent 1.25px);background-size:${Math.round(32 * scale)}px ${Math.round(32 * scale)}px}
.wash{position:absolute;inset:0;background:linear-gradient(110deg,rgba(41,41,41,.98) 0%,rgba(41,41,41,.92) 58%,rgba(245,110,110,.11) 100%)}
.red-rule{position:absolute;left:${Math.round(104 * scale)}px;top:${Math.round(92 * scale)}px;width:${Math.round(108 * scale)}px;height:${Math.max(6, Math.round(8 * scale))}px;background:${COLORS.red}}
.content{position:absolute;left:${Math.round(104 * scale)}px;right:${Math.round(620 * scale)}px;top:50%;transform:translateY(-48%)}
.eyebrow{font-family:"Red Hat Mono",monospace;font-size:${eyebrowSize}px;letter-spacing:.13em;color:${COLORS.coral};text-transform:uppercase;margin-bottom:${Math.round(32 * scale)}px}
h1{font-family:"Red Hat Display",sans-serif;font-size:${titleSize}px;line-height:1.04;letter-spacing:-.025em;margin:0 0 ${Math.round(30 * scale)}px;max-width:${Math.round(1180 * scale)}px;text-wrap:balance}
p{font-size:${subtitleSize}px;line-height:1.35;color:${COLORS.paper};margin:0;max-width:${Math.round(980 * scale)}px;text-wrap:balance}
.robot{position:absolute;right:${Math.round(100 * scale)}px;bottom:${Math.round(88 * scale)}px;width:${Math.round(430 * scale)}px;height:${Math.round(430 * scale)}px;object-fit:contain;filter:drop-shadow(0 ${Math.round(18 * scale)}px ${Math.round(28 * scale)}px rgba(0,0,0,.38))}
.footer{position:absolute;left:${Math.round(104 * scale)}px;bottom:${Math.round(74 * scale)}px;font-family:"Red Hat Mono",monospace;font-size:${Math.round(18 * scale)}px;color:${COLORS.muted};letter-spacing:.06em}
</style></head><body><div class="wash"></div><div class="red-rule"></div><main class="content"><div class="eyebrow">${escapeHtml(label)}</div><h1>${escapeHtml(title)}</h1>${subtitle ? `<p>${escapeHtml(subtitle)}</p>` : ""}</main><img class="robot" alt="" src="data:image/svg+xml;base64,${logoData}"><div class="footer">OPENSHIFT AI · AGENT CONTROL PLANE</div></body></html>`;
}

export async function renderCard(options) {
  const {
    output,
    htmlOutput,
    dryRun = false,
    browserPath,
  } = options;
  if (!output) throw new Error("card output path is required");
  if (!options.title) throw new Error("card title is required");
  if (!["title", "end"].includes(options.kind ?? "title")) throw new Error("card kind must be title or end");
  const htmlPlanPath = htmlOutput ?? defaultCardHtmlOutput(output);
  const executable = await resolveChrome(browserPath);
  const plan = {
    renderer: "html-card",
    kind: options.kind ?? "title",
    width: options.width ?? 1920,
    height: options.height ?? 1080,
    html: htmlPlanPath,
    output,
    command: formatCommand(process.execPath, [
      fileURLToPath(new URL("index.mjs", import.meta.url)),
      "card",
      "--kind", options.kind ?? "title",
      "--title", options.title,
      "--output", output,
      "--width", String(options.width ?? 1920),
      "--height", String(options.height ?? 1080),
    ]),
  };
  if (dryRun) return plan;
  if (!executable) throw new Error("a Chromium-compatible browser is required to render cards");
  for (const required of [
    options.logoPath,
    ...Object.values(FONT_FILES).map((filename) => resolve(options.fontsDir, filename)),
  ]) {
    if (!(await pathExists(required))) throw new Error(`card asset not found: ${required}`);
  }
  const html = await buildCardHtml(options);
  await ensureParent(htmlPlanPath);
  await ensureParent(output);
  await writeFile(htmlPlanPath, html, "utf8");
  await withHeadlessPage({
    width: plan.width,
    height: plan.height,
    browserPath: executable,
    allowedFilePaths: [htmlPlanPath],
  }, async (page) => {
    await page.navigate(htmlPlanPath);
    await page.evaluate("document.fonts.ready");
    await writeFile(output, await page.screenshot());
  });
  return plan;
}
