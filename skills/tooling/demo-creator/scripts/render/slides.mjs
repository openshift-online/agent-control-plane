import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureParent, formatCommand, pathExists, resolveExecutable, runCommand } from "./common.mjs";
import { withHeadlessPage } from "./chrome-cdp.mjs";

export function exportDimensions(width, height) {
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
    throw new Error("slide width and height must be positive integers");
  }
  return {
    columns: Math.max(20, Math.round((width / height) * 48)),
    rows: 24,
  };
}

export function presentermConfig(width, height) {
  const dimensions = exportDimensions(width, height);
  return `export:\n  dimensions:\n    columns: ${dimensions.columns}\n    rows: ${dimensions.rows}\n  pauses: ignore\n  snippets: sequential\n`;
}

export function normalizeExportedHtml(html) {
  if (!/<html(?:\s|>)/i.test(html)) throw new Error("Presenterm did not produce an HTML document");
  const externalAsset = /(?:src|srcset)\s*=\s*["'](?:https?:)?\/\//i.test(html)
    || /<link\b[^>]*\bhref\s*=\s*["'](?:https?:)?\/\//i.test(html)
    || /url\(\s*["']?(?:https?:)?\/\//i.test(html);
  if (externalAsset) {
    throw new Error("Presenterm export contains an external asset reference");
  }
  const branded = html
    .replaceAll(/#040312/gi, "#292929")
    .replaceAll(/#3085c3/gi, "#F56E6E")
    .replaceAll(/#b4ccff/gi, "#FFFFFF")
    .replaceAll(/#e6e6e6/gi, "#F7F7F3");
  const style = "<style id=\"demo-creator-viewport\">html{width:100%;height:100%;overflow:hidden;background:#292929}body{position:absolute;left:0;top:0}</style>";
  const script = `<script id="demo-creator-center">document.addEventListener('DOMContentLoaded',function(){function centerDemoSlide(){const w=document.documentElement.clientWidth;const h=document.documentElement.clientHeight;const scale=Math.min(w/originalWidth,h/originalHeight);const x=(w-originalWidth*scale)/2;const y=(h-originalHeight*scale)/2;document.body.style.transform='translate('+x+'px,'+y+'px) scale('+scale+')'}centerDemoSlide();window.addEventListener('resize',centerDemoSlide)},{once:true});</script>`;
  const withStyle = branded.replace(/<\/head>/i, `${style}</head>`);
  return withStyle.replace(/<\/body>/i, `${script}</body>`);
}

export async function embedSlideFonts(html, fontsDir) {
  const regular = (await readFile(join(fontsDir, "RedHatMono-Regular.ttf"))).toString("base64");
  const bold = (await readFile(join(fontsDir, "RedHatMono-Bold.ttf"))).toString("base64");
  const style = `<style id="demo-creator-fonts">@font-face{font-family:"Red Hat Mono";src:url(data:font/ttf;base64,${regular}) format("truetype");font-weight:400}@font-face{font-family:"Red Hat Mono";src:url(data:font/ttf;base64,${bold}) format("truetype");font-weight:700}body,pre,span{font-family:"Red Hat Mono",monospace}</style>`;
  return html.replace(/<\/head>/i, `${style}</head>`);
}

export async function removeOwnedSlideFrames(outputDir) {
  let entries;
  try {
    entries = await readdir(outputDir, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  await Promise.all(entries
    .filter((entry) => (entry.isFile() || entry.isSymbolicLink()) && /^frame-\d{4,}\.png$/.test(entry.name))
    .map((entry) => rm(join(outputDir, entry.name))));
}

export async function renderSlides(options) {
  const {
    input,
    outputDir,
    width = 1266,
    height = 936,
    dryRun = false,
    presentermPath,
    browserPath,
    theme = "dark",
  } = options;
  if (!input || !outputDir) throw new Error("slide input and outputDir are required");
  const absoluteInput = resolve(input);
  const absoluteOutput = resolve(outputDir);
  const htmlOutput = join(absoluteOutput, "slides.html");
  const configOutput = join(absoluteOutput, "presenterm-export.yaml");
  const skillRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
  const fontsDir = resolve(options.fontsDir ?? join(skillRoot, "assets/fonts"));
  const presenterm = await resolveExecutable("presenterm", presentermPath);
  const args = ["--config-file", configOutput, "--theme", theme, "--export-html", "--output", htmlOutput, absoluteInput];
  const plan = {
    renderer: "presenterm",
    width,
    height,
    input: absoluteInput,
    html: htmlOutput,
    frames: join(absoluteOutput, "frame-%04d.png"),
    config: configOutput,
    fontsDir,
    command: formatCommand(presenterm ?? "presenterm", args),
  };
  if (dryRun) return plan;
  if (!(await pathExists(absoluteInput))) throw new Error(`slide source not found: ${absoluteInput}`);
  if (!presenterm) throw new Error("presenterm is required to render slide Markdown");
  for (const filename of ["RedHatMono-Regular.ttf", "RedHatMono-Bold.ttf"]) {
    const path = join(fontsDir, filename);
    if (!(await pathExists(path))) throw new Error(`slide font not found: ${path}`);
  }
  await mkdir(absoluteOutput, { recursive: true });
  await writeFile(configOutput, presentermConfig(width, height), "utf8");
  await runCommand(presenterm, args, { cwd: dirname(absoluteInput) });
  const exportedHtml = await embedSlideFonts(normalizeExportedHtml(await readFile(htmlOutput, "utf8")), fontsDir);
  await writeFile(htmlOutput, exportedHtml, "utf8");

  const framePaths = [];
  await removeOwnedSlideFrames(absoluteOutput);
  await withHeadlessPage({ width, height, browserPath, allowedFilePaths: [htmlOutput] }, async (page) => {
    await page.navigate(htmlOutput);
    await page.evaluate("document.fonts.ready");
    const slideCount = await page.evaluate("document.querySelectorAll('.container').length");
    if (!Number.isInteger(slideCount) || slideCount < 1) {
      throw new Error("exported presentation contains no slides");
    }
    for (let index = 0; index < slideCount; index += 1) {
      if (index > 0) {
        await page.evaluate("document.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight'}));new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
      }
      const framePath = join(absoluteOutput, `frame-${String(index + 1).padStart(4, "0")}.png`);
      await ensureParent(framePath);
      await writeFile(framePath, await page.screenshot());
      framePaths.push(framePath);
    }
  });
  await writeFile(join(absoluteOutput, "slides-render.json"), `${JSON.stringify({ ...plan, framePaths }, null, 2)}\n`, "utf8");
  return { ...plan, framePaths };
}
