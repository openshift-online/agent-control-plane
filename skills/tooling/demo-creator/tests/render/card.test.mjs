import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildCardHtml, defaultCardHtmlOutput, renderCard } from "../../scripts/render/card.mjs";

async function fixtureAssets(root) {
  const fontsDir = join(root, "fonts");
  await mkdir(fontsDir, { recursive: true });
  for (const filename of [
    "RedHatDisplay-Bold.ttf",
    "RedHatText-Regular.ttf",
    "RedHatText-Bold.ttf",
    "RedHatMono-Regular.ttf",
  ]) {
    await writeFile(join(fontsDir, filename), `fixture:${filename}`);
  }
  const logoPath = join(root, "logo.svg");
  await writeFile(logoPath, '<svg xmlns="http://www.w3.org/2000/svg"><rect fill="#F56E6E" width="10" height="10"/></svg>');
  return { fontsDir, logoPath };
}

test("card HTML is self-contained, branded, and escapes user text", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "demo-card-test-"));
  const assets = await fixtureAssets(root);
  context.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(root, { recursive: true, force: true });
  });
  const html = await buildCardHtml({
    kind: "title",
    title: "ACP <Sessions>",
    subtitle: "A & B",
    width: 1920,
    height: 1080,
    ...assets,
  });
  assert.match(html, /#292929/);
  assert.match(html, /#F56E6E/);
  assert.match(html, /#EE0000/);
  assert.match(html, /data:font\/ttf;base64,/);
  assert.match(html, /data:image\/svg\+xml;base64,/);
  assert.match(html, /ACP &lt;Sessions&gt;/);
  assert.match(html, /A &amp; B/);
  assert.doesNotMatch(html, /ACP <Sessions>/);
});

test("card dry-run returns exact output dimensions", async () => {
  const plan = await renderCard({
    kind: "end",
    title: "Learn more",
    output: "/tmp/end.png",
    fontsDir: "/tmp/fonts",
    logoPath: "/tmp/logo.svg",
    width: 1280,
    height: 720,
    dryRun: true,
  });
  assert.equal(plan.width, 1280);
  assert.equal(plan.height, 720);
  assert.equal(plan.output, "/tmp/end.png");
  assert.equal(plan.html, "/tmp/end.html");
});

test("default card HTML paths never collide with non-PNG or extensionless outputs", () => {
  assert.equal(defaultCardHtmlOutput("/tmp/title.png"), "/tmp/title.html");
  assert.equal(defaultCardHtmlOutput("/tmp/title.PNG"), "/tmp/title.html");
  assert.equal(defaultCardHtmlOutput("/tmp/title.webp"), "/tmp/title.webp.html");
  assert.equal(defaultCardHtmlOutput("/tmp/title"), "/tmp/title.html");
});

test("card dry-run preserves an explicit HTML output path", async () => {
  const plan = await renderCard({
    kind: "title",
    title: "ACP Sessions",
    output: "/tmp/title.webp",
    htmlOutput: "/tmp/render-source/card.html",
    fontsDir: "/tmp/fonts",
    logoPath: "/tmp/logo.svg",
    dryRun: true,
  });
  assert.equal(plan.html, "/tmp/render-source/card.html");
  assert.equal(plan.output, "/tmp/title.webp");
});
