import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { embedSlideFonts, exportDimensions, normalizeExportedHtml, presentermConfig, removeOwnedSlideFrames, renderSlides } from "../../scripts/render/slides.mjs";

test("exportDimensions maps target pixels to stable terminal cells", () => {
  assert.deepEqual(exportDimensions(1266, 936), { columns: 65, rows: 24 });
  assert.deepEqual(exportDimensions(630, 936), { columns: 32, rows: 24 });
});

test("Presenterm export config fixes dimensions and ignores pauses", () => {
  const config = presentermConfig(1266, 936);
  assert.match(config, /columns: 65/);
  assert.match(config, /rows: 24/);
  assert.match(config, /pauses: ignore/);
  assert.match(config, /snippets: sequential/);
});

test("export normalization centers fixed-size slides and rejects remote assets", () => {
  const normalized = normalizeExportedHtml("<html><head></head><body><div class=\"container\"></div></body></html>");
  assert.match(normalized, /demo-creator-viewport/);
  assert.match(normalized, /demo-creator-center/);
  assert.match(normalized, /translate/);
  assert.match(normalized, /#292929/);
  assert.throws(
    () => normalizeExportedHtml('<html><head></head><body><img src="https://example.test/a.png"></body></html>'),
    /external asset/,
  );
  assert.doesNotThrow(
    () => normalizeExportedHtml('<html><head></head><body><a href="https://example.test/">source</a></body></html>'),
  );
});

test("slide font embedding keeps exported HTML self-contained", async (context) => {
  const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = await mkdtemp(join(tmpdir(), "demo-slide-fonts-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "RedHatMono-Regular.ttf"), "regular");
  await writeFile(join(root, "RedHatMono-Bold.ttf"), "bold");
  const html = await embedSlideFonts("<html><head></head><body></body></html>", root);
  assert.match(html, /Red Hat Mono/);
  assert.match(html, /data:font\/ttf;base64,/);
});

test("slide dry-run returns a reproducible export plan without requiring tools", async () => {
  const plan = await renderSlides({
    input: "fixtures/demo.md",
    outputDir: "build/slides",
    width: 1280,
    height: 624,
    dryRun: true,
  });
  assert.equal(plan.renderer, "presenterm");
  assert.equal(plan.width, 1280);
  assert.equal(plan.height, 624);
  assert.match(plan.command, /--export-html/);
  assert.match(plan.frames, /frame-%04d\.png$/);
});

test("slide rerender removes stale owned frames after the slide count shrinks", async (context) => {
  const outputDir = await mkdtemp(join(tmpdir(), "demo-slide-rerender-"));
  context.after(() => rm(outputDir, { recursive: true, force: true }));
  await Promise.all([
    writeFile(join(outputDir, "frame-0001.png"), "old-1"),
    writeFile(join(outputDir, "frame-0002.png"), "old-2"),
    writeFile(join(outputDir, "frame-0003.png"), "old-3"),
    writeFile(join(outputDir, "frame-10000.png"), "old-10000"),
    writeFile(join(outputDir, "frame-preview.png"), "not-owned"),
    writeFile(join(outputDir, "notes.png"), "not-owned"),
    symlink(join(outputDir, "notes.png"), join(outputDir, "frame-0004.png")),
  ]);
  await removeOwnedSlideFrames(outputDir);
  await writeFile(join(outputDir, "frame-0001.png"), "new-1");
  assert.deepEqual((await readdir(outputDir)).sort(), ["frame-0001.png", "frame-preview.png", "notes.png"]);
});
