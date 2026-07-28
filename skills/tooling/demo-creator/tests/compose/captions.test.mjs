import assert from "node:assert/strict";
import test from "node:test";
import {
  captionEntries,
  renderAss,
  renderSrt,
  renderTranscript,
  renderVtt,
  timelineFromScenes,
  validateCaptionTimeline,
  validateCaptionText,
} from "../../scripts/compose/captions.mjs";
import { outputGeometry } from "../../scripts/compose/layout.mjs";

test("timeline accounts for crossfade overlap", () => {
  const timeline = timelineFromScenes(
    [
      { id: "title", durationSeconds: 3 },
      { id: "content", durationFrames: 90, caption: "A visible caption." },
      { id: "end", duration: 3 },
    ],
    0.3,
  );
  assert.deepEqual(timeline.map(({ start, end }) => [start, end]), [
    [0, 3],
    [2.7, 5.7],
    [5.4, 8.4],
  ]);
  assert.equal(captionEntries(timeline).length, 1);
});

test("caption timestamps are bounded by the final overlapped timeline", () => {
  const timeline = timelineFromScenes([
    { durationSeconds: 3 },
    { durationSeconds: 4 },
    { durationSeconds: 3 },
  ], 0.3);
  assert.equal(timeline.at(-1).end, 9.4);
  assert.doesNotThrow(() => validateCaptionTimeline([{ start: 8, end: 9.4 }], 9.4));
  assert.throws(
    () => validateCaptionTimeline([{ start: 9.2, end: 9.5 }], 9.4),
    /after the composed video timeline/,
  );
});

test("caption sidecars are deterministic and independent of audio", () => {
  const entries = [{ index: 1, start: 1.2, end: 2.4, text: "First line\nSecond line" }];
  assert.match(renderVtt(entries), /WEBVTT/);
  assert.match(renderSrt(entries), /00:00:01,200 --> 00:00:02,400/);
  assert.match(renderTranscript(entries), /First line Second line/);
  assert.throws(() => validateCaptionText("one\ntwo\nthree"), /at most two lines/);
  assert.doesNotThrow(() => validateCaptionText("i".repeat(100)));
  assert.throws(() => validateCaptionText("W".repeat(60)), /does not fit/);
});

test("ASS overlay reserves the caption band and renders an accessible vector pointer", () => {
  const ass = renderAss({
    entries: [{ index: 1, start: 0, end: 2, text: "Click the extension icon." }],
    pointerEvents: [{ type: "click", time: 0.5, endTime: 0.6, x: 0.9, y: 0.1 }],
    geometry: outputGeometry("1080p"),
  });
  assert.match(ass, /Style: Caption,Red Hat Text,44/);
  assert.match(ass, /Style: Pointer,Red Hat Text,1,.*1,6,0,7/);
  assert.match(ass, /Dialogue: 3,0:00:00\.50,0:00:01\.10,ClickPointer/);
  assert.match(ass, /\\an7\\pos\(1728,94\)\\fscx120\\fscy120\\t\(0,150,\\fscx88\\fscy88\)\\t\(150,360,\\fscx100\\fscy100\).*\\p1}m 0 0 l 0 72 18 55 32 88 46 81 31 50 55 50 0 0/);
  assert.doesNotMatch(ass, /[◆○]/);
  assert.doesNotMatch(ass, /ClickOuter|&H000000EE/);
  assert.match(ass, /Click the extension icon\./);
});

test("click pointer pulses last exactly 18 frames and clamp at the video boundary", () => {
  const geometry = outputGeometry("1080p");
  const exact = renderAss({
    entries: [],
    pointerEvents: [
      { type: "click", time: 0.5, x: 0.5, y: 0.5 },
      { type: "move", time: 2, x: 0.6, y: 0.5 },
    ],
    geometry,
    duration: 3,
  });
  assert.match(exact, /Dialogue: 3,0:00:00\.50,0:00:01\.10,ClickPointer/);
  assert.doesNotMatch(exact, /Dialogue: 3,0:00:00\.50,0:00:02\.00,ClickPointer/);
  assert.doesNotMatch(exact, /Dialogue: 2,0:00:00\.50,[^\n]*,Pointer/);
  assert.match(exact, /Dialogue: 2,0:00:01\.10,0:00:02\.00,Pointer[^\n]*\\move\(1037,468,1152,468\)/);

  const clamped = renderAss({
    entries: [],
    pointerEvents: [{ type: "click", time: 0.5, x: 0.5, y: 0.5 }],
    geometry,
    duration: 0.8,
  });
  assert.match(clamped, /Dialogue: 3,0:00:00\.50,0:00:00\.80,ClickPointer/);
});

test("pointer timestamps and coordinates are guarded", () => {
  const geometry = outputGeometry("1080p");
  assert.throws(
    () => renderAss({ entries: [], pointerEvents: [{ time: 1, x: 0.2, y: 0.2 }, { time: 0.5, x: 0.2, y: 0.2 }], geometry }),
    /monotonic/,
  );
  assert.throws(() => renderAss({ entries: [], pointerEvents: [{ time: 1, x: 2, y: 0 }], geometry }), /normalized/);
});

test("vector pointer interpolates movement instead of leaving a cursor trail", () => {
  const ass = renderAss({
    entries: [],
    pointerEvents: [
      { type: "move", time: 0, x: 0.1, y: 0.1 },
      { type: "move", time: 0.5, x: 0.2, y: 0.2 },
    ],
    geometry: outputGeometry("1080p"),
  });
  assert.match(ass, /\\an7\\move\(192,94,384,187\)\\p1}m 0 0 l 0 72 18 55 32 88 46 81 31 50 55 50 0 0/);
  assert.doesNotMatch(ass, /[◆○]/);
});

test("pointer reflects above a bottom-edge click while preserving its hotspot", () => {
  const ass = renderAss({
    entries: [],
    pointerEvents: [{ type: "click", time: 0.5, endTime: 0.6, x: 0.5, y: 1 }],
    geometry: outputGeometry("1080p"),
    duration: 2,
  });
  assert.match(ass, /\\an1\\pos\(960,936\)[^}]*\\p1}m 0 88 l 0 16 18 33 32 0 46 7 31 38 55 38 0 88/);
  assert.doesNotMatch(ass, /\\an7\\pos\(960,936\)/);
});

test("pointer reflects left of a right-edge click while preserving its hotspot", () => {
  const ass = renderAss({
    entries: [],
    pointerEvents: [{ type: "click", time: 0.5, endTime: 0.6, x: 1, y: 0.5 }],
    geometry: outputGeometry("1080p"),
    duration: 2,
  });
  assert.match(ass, /\\an9\\pos\(1920,468\)[^}]*\\p1}m 55 0 l 55 72 37 55 23 88 9 81 24 50 0 50 55 0/);
  assert.doesNotMatch(ass, /\\an7\\pos\(1920,468\)/);
});
