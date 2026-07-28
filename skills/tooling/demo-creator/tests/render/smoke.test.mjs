import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { renderCard } from "../../scripts/render/card.mjs";
import { renderSlides } from "../../scripts/render/slides.mjs";
import { renderTerminal } from "../../scripts/render/terminal.mjs";

const smoke = process.env.DEMO_RENDER_SMOKE === "1";
const here = dirname(fileURLToPath(import.meta.url));
const skillRoot = resolve(here, "../..");

test("installed browser renders an exact-size branded card", { skip: !smoke }, async (context) => {
  const outputDir = await mkdtemp(join(tmpdir(), "demo-card-smoke-"));
  context.after(() => rm(outputDir, { recursive: true, force: true }));
  const output = join(outputDir, "title.png");
  await renderCard({
    kind: "title",
    title: "ACP Sessions",
    subtitle: "Repeatable browser-extension demos",
    output,
    width: 1280,
    height: 720,
    fontsDir: join(skillRoot, "assets/fonts"),
    logoPath: join(skillRoot, "assets/branding/acp-logo.svg"),
  });
  const png = await readFile(output);
  assert.equal(png.readUInt32BE(16), 1280);
  assert.equal(png.readUInt32BE(20), 720);
});

test("installed VHS and FFmpeg render an exact-size terminal clip", { skip: !smoke }, async (context) => {
  const outputDir = await mkdtemp(join(tmpdir(), "demo-terminal-smoke-"));
  context.after(() => rm(outputDir, { recursive: true, force: true }));
  const output = join(outputDir, "terminal.mp4");
  await renderTerminal({
    input: join(here, "fixtures/basic.tape"),
    output,
    width: 640,
    height: 360,
    fps: 30,
  });
  const bytes = await readFile(output);
  assert.ok(bytes.length > 1_000);
});

test("installed Presenterm exports self-contained HTML and exact-size slide frames", { skip: !smoke || !process.env.DEMO_PRESENTERM_BIN }, async (context) => {
  const outputDir = await mkdtemp(join(tmpdir(), "demo-slides-smoke-"));
  context.after(() => rm(outputDir, { recursive: true, force: true }));
  const result = await renderSlides({
    input: join(here, "fixtures/basic-slides.md"),
    outputDir,
    width: 640,
    height: 360,
    presentermPath: process.env.DEMO_PRESENTERM_BIN,
  });
  assert.equal(result.framePaths.length, 2);
  for (const framePath of result.framePaths) {
    const png = await readFile(framePath);
    assert.equal(png.readUInt32BE(16), 640);
    assert.equal(png.readUInt32BE(20), 360);
  }
  const html = await readFile(join(outputDir, "slides.html"), "utf8");
  assert.match(html, /<html(?:\s|>)/i);
  assert.doesNotMatch(html, /(?:src|href)=["']https?:/i);
});
