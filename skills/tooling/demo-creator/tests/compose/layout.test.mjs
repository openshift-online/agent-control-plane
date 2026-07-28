import assert from "node:assert/strict";
import test from "node:test";
import { assertLayoutBounds, layoutFor, outputGeometry, scaleLayout } from "../../scripts/compose/layout.mjs";

test("output geometries reserve exact content and caption bands", () => {
  assert.deepEqual(outputGeometry("1080p"), {
    name: "1080p",
    width: 1920,
    height: 1080,
    contentHeight: 936,
    captionHeight: 144,
    gap: 24,
    extensionWidth: 630,
  });
  const output720 = outputGeometry("720p");
  assert.equal(output720.contentHeight + output720.captionHeight, output720.height);
});

test("native extension layouts preserve the specified right rail", () => {
  const slides = layoutFor("slides-extension", "1080p");
  assert.deepEqual(slides.cells.extension, { x: 1290, y: 0, width: 630, height: 936 });
  assert.deepEqual(slides.cells.slides, { x: 0, y: 0, width: 1266, height: 936 });
  assertLayoutBounds(slides);

  const terminal720 = layoutFor("terminal-extension", "720p");
  assert.deepEqual(terminal720.cells.extension, { x: 860, y: 0, width: 420, height: 624 });
  assertLayoutBounds(terminal720);
});

test("mobile-full reserves the complete content region as the aspect-fit canvas", () => {
  const mobile1080 = layoutFor("mobile-full", "1080p");
  assert.deepEqual(mobile1080.cells.mobile, { x: 0, y: 0, width: 1920, height: 936 });
  assertLayoutBounds(mobile1080);

  const mobile720 = layoutFor("mobile-full", "720p");
  assert.deepEqual(mobile720.cells.mobile, { x: 0, y: 0, width: 1280, height: 624 });
  assertLayoutBounds(mobile720);
});

test("generic split is bounded between 30 and 70 percent", () => {
  assert.throws(() => layoutFor("generic-split", "1080p", { ratio: 0.29 }), /between/);
  const split = layoutFor("generic-split", "1080p", { ratio: 0.3 });
  assertLayoutBounds(split);
  assert.equal(split.cells.right.x - split.cells.left.width, 24);
});

test("1080p layouts scale to even 720p cells", () => {
  const scaled = scaleLayout(layoutFor("browser-full", "1080p"), "720p");
  assert.deepEqual(scaled.cells.browser, { x: 0, y: 0, width: 1280, height: 624 });
  assertLayoutBounds(scaled);
});
