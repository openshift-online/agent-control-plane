import assert from "node:assert/strict";
import test from "node:test";
import { createAndroidPointerRecorder } from "../../../scripts/capture/android/pointer-events.mjs";

function displayGeometry(width, height) {
  return Object.freeze({
    physical: Object.freeze({ width, height }),
    recording: Object.freeze({ width, height }),
    rotation: 0,
  });
}

test("Android pointer recorder normalizes tap and fill intents to canonical click events", () => {
  const recorder = createAndroidPointerRecorder({
    displayGeometry: displayGeometry(4, 2),
    startMonotonicSeconds: 100,
  });

  const tap = recorder.record({
    type: "tap",
    monotonicSeconds: 100,
    x: 0,
    y: 0,
  });
  const fill = recorder.record({
    type: "fill",
    monotonicSeconds: 100.5,
    x: 3,
    y: 1,
  });

  assert.deepEqual(tap, { type: "click", time: 0, x: 0.125, y: 0.25 });
  assert.deepEqual(fill, { type: "click", time: 0.5, x: 0.875, y: 0.75 });
  assert.deepEqual(recorder.snapshot(), [tap, fill]);
  assert.deepEqual(Object.keys(fill).sort(), ["time", "type", "x", "y"]);
  assert.equal("sourceAction" in tap, false);
  assert.equal("value" in fill, false);
});

test("Android pointer recorder permits equal monotonic timestamps and rejects regression", () => {
  const recorder = createAndroidPointerRecorder({
    displayGeometry: displayGeometry(100, 200),
    startMonotonicSeconds: 10,
  });
  recorder.record({ type: "tap", monotonicSeconds: 10.25, x: 10, y: 20 });
  assert.doesNotThrow(() => {
    recorder.record({ type: "fill", monotonicSeconds: 10.25, x: 10, y: 20 });
  });
  assert.throws(
    () => recorder.record({ type: "tap", monotonicSeconds: 10.24, x: 10, y: 20 }),
    /nondecreasing/,
  );
});

test("Android pointer recorder requires events before the authored duration boundary", () => {
  const recorder = createAndroidPointerRecorder({
    displayGeometry: displayGeometry(100, 200),
    startMonotonicSeconds: 10,
    durationSeconds: 2,
  });
  assert.doesNotThrow(() => {
    recorder.record({ type: "tap", monotonicSeconds: 11.999, x: 10, y: 20 });
  });
  assert.throws(
    () => recorder.record({ type: "tap", monotonicSeconds: 12, x: 10, y: 20 }),
    /authored duration/,
  );
});

test("Android pointer recorder rejects unsupported events and secret-bearing fields", () => {
  for (const event of [
    { type: "move", monotonicSeconds: 1, x: 0, y: 0 },
    { type: "click", monotonicSeconds: 1, x: 0, y: 0 },
    { type: "fill", monotonicSeconds: 1, x: 0, y: 0, value: "private" },
    { type: "fill", monotonicSeconds: 1, x: 0, y: 0, text: "private" },
    { type: "fill", monotonicSeconds: 1, x: 0, y: 0, password: "private" },
    { type: "tap", monotonicSeconds: 1, x: 0, y: 0, secret: "private" },
  ]) {
    const recorder = createAndroidPointerRecorder({
      displayGeometry: displayGeometry(10, 10),
      startMonotonicSeconds: 1,
    });
    assert.throws(() => recorder.record(event), /pointer event/);
    assert.deepEqual(recorder.snapshot(), []);
  }
});

test("Android pointer recorder rejects nonfinite, fractional, and out-of-range coordinates", () => {
  const invalidPoints = [
    { x: -1, y: 0 },
    { x: 10, y: 0 },
    { x: 0, y: -1 },
    { x: 0, y: 20 },
    { x: 0.5, y: 0 },
    { x: Number.NaN, y: 0 },
    { x: 0, y: Number.POSITIVE_INFINITY },
  ];
  for (const point of invalidPoints) {
    const recorder = createAndroidPointerRecorder({
      displayGeometry: displayGeometry(10, 20),
      startMonotonicSeconds: 1,
    });
    assert.throws(
      () => recorder.record({
        type: "tap",
        monotonicSeconds: 1,
        ...point,
      }),
      /coordinates/,
    );
  }
});

test("Android pointer recorder requires verified unrotated display geometry", () => {
  for (const options of [
    { displayGeometry: displayGeometry(0, 10), startMonotonicSeconds: 1 },
    { displayGeometry: displayGeometry(10.5, 10), startMonotonicSeconds: 1 },
    { displayGeometry: displayGeometry(10, Number.POSITIVE_INFINITY), startMonotonicSeconds: 1 },
    {
      displayGeometry: {
        physical: { width: 10, height: 10 },
        recording: { width: 10, height: 10 },
        rotation: 1,
      },
      startMonotonicSeconds: 1,
    },
    { width: 10, height: 10, startMonotonicSeconds: 1 },
    {
      displayGeometry: displayGeometry(10, 10),
      width: 10,
      height: 10,
      startMonotonicSeconds: 1,
    },
  ]) {
    assert.throws(() => createAndroidPointerRecorder(options));
  }
});

test("Android pointer recorder rejects invalid monotonic timestamps", () => {
  for (const options of [
    { displayGeometry: displayGeometry(10, 10), startMonotonicSeconds: Number.NaN },
    { displayGeometry: displayGeometry(10, 10), startMonotonicSeconds: 1, durationSeconds: 0 },
    { displayGeometry: displayGeometry(10, 10), startMonotonicSeconds: 1, durationSeconds: Number.POSITIVE_INFINITY },
  ]) {
    assert.throws(() => createAndroidPointerRecorder(options));
  }

  const recorder = createAndroidPointerRecorder({
    displayGeometry: displayGeometry(10, 10),
    startMonotonicSeconds: 2,
  });
  for (const monotonicSeconds of [Number.NaN, Number.POSITIVE_INFINITY, 1.999]) {
    assert.throws(
      () => recorder.record({ type: "tap", monotonicSeconds, x: 0, y: 0 }),
      /monotonic/,
    );
  }
});

test("Android pointer recorder snapshots do not expose mutable internal state", () => {
  const recorder = createAndroidPointerRecorder({
    displayGeometry: displayGeometry(10, 10),
    startMonotonicSeconds: 1,
  });
  recorder.record({ type: "tap", monotonicSeconds: 1, x: 0, y: 0 });
  const snapshot = recorder.snapshot();
  snapshot.push({ type: "tap", time: 9, x: 9, y: 9 });
  assert.equal(recorder.snapshot().length, 1);
});

test("Android pointer recorder always emits finite normalized coordinates strictly inside the unit square", () => {
  const recorder = createAndroidPointerRecorder({
    displayGeometry: displayGeometry(1080, 1920),
    startMonotonicSeconds: 0,
  });
  const events = [
    recorder.record({ type: "tap", monotonicSeconds: 0, x: 0, y: 0 }),
    recorder.record({ type: "tap", monotonicSeconds: 1, x: 1079, y: 1919 }),
  ];
  for (const event of events) {
    assert.equal(Number.isFinite(event.x), true);
    assert.equal(Number.isFinite(event.y), true);
    assert.ok(event.x > 0 && event.x < 1);
    assert.ok(event.y > 0 && event.y < 1);
  }
});
