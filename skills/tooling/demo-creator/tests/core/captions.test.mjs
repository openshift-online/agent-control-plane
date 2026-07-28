import test from "node:test";
import assert from "node:assert/strict";
import {
  captionStyle,
  captionWidthErrors,
  estimateCaptionLineWidth,
  validateCaptions,
} from "../../scripts/core/captions.mjs";

test("caption style uses exact master text and a conservative nominal derivative profile", () => {
  assert.deepEqual(captionStyle("1080p"), {
    fontFamily: "Red Hat Text",
    fontSize: 44,
    foreground: "#FFFFFF",
    background: "#000000",
    maxLines: 2,
  });
  assert.equal(captionStyle("720p").fontSize, 29);
});

test("caption width uses conservative glyph advances at both resolutions", () => {
  assert.equal(captionWidthErrors("i".repeat(100)).length, 0);
  assert.deepEqual(captionWidthErrors("W".repeat(40)), []);
  assert.deepEqual(captionWidthErrors("W".repeat(41)), [
    "line 1 exceeds the 720p caption width (1230px > 1216px)",
  ]);
  const wideErrors = captionWidthErrors("W".repeat(60));
  assert.ok(wideErrors.some((error) => error.includes("1080p")));
  assert.ok(wideErrors.some((error) => error.includes("720p")));
  assert.ok(estimateCaptionLineWidth("WW", 44) > estimateCaptionLineWidth("ii", 44));
});

test("mobile captions require readable holds and no more than three words per second", () => {
  assert.deepEqual(validateCaptions([
    { startSeconds: 0, endSeconds: 2.5, text: "One two three four five six seven" },
  ], 10, { profile: "mobile" }), []);

  const tooShort = validateCaptions([
    { startSeconds: 0, endSeconds: 2.49, text: "Brief caption" },
  ], 10, { profile: "mobile" });
  assert.ok(tooShort.some((error) => error.includes("at least 2.5 seconds")));

  const tooFast = validateCaptions([
    { startSeconds: 0, endSeconds: 2.5, text: "One two three four five six seven eight" },
  ], 10, { profile: "mobile" });
  assert.ok(tooFast.some((error) => error.includes("3 words per second")));
});

test("browser captions retain the existing timing behavior", () => {
  assert.deepEqual(validateCaptions([
    { startSeconds: 0, endSeconds: 1, text: "One two three four five six" },
  ], 10), []);
});

test("mobile caption validation does not subtract malformed mixed numeric types", () => {
  assert.doesNotThrow(() => {
    const errors = validateCaptions([
      { startSeconds: 0n, endSeconds: 3, text: "Malformed timing" },
    ], 10, { profile: "mobile" });
    assert.ok(errors.some((error) => error.includes("startSeconds")));
  });
});

test("caption validation rejects overlap, overflow, and a third line", () => {
  const errors = validateCaptions([
    { startSeconds: 0, endSeconds: 4, text: "One" },
    { startSeconds: 3, endSeconds: 11, text: "Two\nlines\nonly" },
  ], 10);
  assert.ok(errors.some((error) => error.includes("overlaps")));
  assert.ok(errors.some((error) => error.includes("after the story")));
  assert.ok(errors.some((error) => error.includes("at most two lines")));
});
