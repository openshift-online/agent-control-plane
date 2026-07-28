import test from "node:test";
import assert from "node:assert/strict";
import { calculateLayout } from "../../scripts/core/layout.mjs";

test("1080p extension layout preserves the caption band and fixed side panel", () => {
  const layout = calculateLayout("slides-extension", "1080p");
  assert.deepEqual(layout.frame, { width: 1920, height: 1080 });
  assert.deepEqual(layout.caption, { x: 0, y: 936, width: 1920, height: 144 });
  assert.deepEqual(layout.slides, { x: 0, y: 0, width: 1266, height: 936 });
  assert.deepEqual(layout.extension, { x: 1290, y: 0, width: 630, height: 936 });
});

test("720p extension layout is the exact derivative geometry", () => {
  const layout = calculateLayout("terminal-extension", "720p");
  assert.deepEqual(layout.frame, { width: 1280, height: 720 });
  assert.deepEqual(layout.caption, { x: 0, y: 624, width: 1280, height: 96 });
  assert.deepEqual(layout.terminal, { x: 0, y: 0, width: 844, height: 624 });
  assert.deepEqual(layout.extension, { x: 860, y: 0, width: 420, height: 624 });
});

test("mobile-full exposes the exact even content cell for centered aspect-fit composition", () => {
  const master = calculateLayout("mobile-full", "1080p");
  assert.deepEqual(master.mobile, { x: 0, y: 0, width: 1920, height: 936 });
  assert.deepEqual(master.caption, { x: 0, y: 936, width: 1920, height: 144 });

  const derivative = calculateLayout("mobile-full", "720p");
  assert.deepEqual(derivative.mobile, { x: 0, y: 0, width: 1280, height: 624 });
  for (const bounds of [master.mobile, derivative.mobile]) {
    for (const value of Object.values(bounds)) assert.equal(value % 2, 0);
  }
});

test("generic split accepts only the accessible 30-70 range", () => {
  const layout = calculateLayout("split", "1080p", 30);
  assert.equal(layout.left.width + layout.gap + layout.right.width, 1920);
  const unevenRatio = calculateLayout("split", "1080p", 31);
  assert.equal(unevenRatio.left.width, 588);
  assert.equal(unevenRatio.left.width % 2, 0);
  assert.equal(unevenRatio.right.width % 2, 0);
  assert.throws(() => calculateLayout("split", "1080p", 29), /30 through 70/);
});
