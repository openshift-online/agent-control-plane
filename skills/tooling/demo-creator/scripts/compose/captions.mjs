import fs from "node:fs/promises";
import path from "node:path";
import { captionWidthErrors } from "../core/captions.mjs";

const FRAME_RATE = 30;
const MIN_CLICK_FRAMES = 18;
const POINTER_VECTOR = "m 0 0 l 0 72 18 55 32 88 46 81 31 50 55 50 0 0";
const POINTER_VECTOR_UP = "m 0 88 l 0 16 18 33 32 0 46 7 31 38 55 38 0 88";
const POINTER_VECTOR_LEFT = "m 55 0 l 55 72 37 55 23 88 9 81 24 50 0 50 55 0";
const POINTER_VECTOR_UP_LEFT = "m 55 88 l 55 16 37 33 23 0 9 7 24 38 0 38 55 88";
const POINTER_WIDTH = 55;
const POINTER_HEIGHT = 88;
const CLICK_SCALE = 1.2;

function secondsFromScene(scene) {
  if (Number.isFinite(scene.durationSeconds)) return Number(scene.durationSeconds);
  if (Number.isFinite(scene.durationFrames)) return Number(scene.durationFrames) / FRAME_RATE;
  if (Number.isFinite(scene.duration)) return Number(scene.duration);
  throw new Error(`Scene ${scene.id ?? "<unknown>"} has no finite duration`);
}

export function timelineFromScenes(scenes, transitionSeconds = 0) {
  let cursor = 0;
  return scenes.map((scene, index) => {
    const duration = secondsFromScene(scene);
    if (duration <= 0) throw new Error(`Scene ${scene.id ?? index} duration must be positive`);
    const start = cursor;
    const end = start + duration;
    cursor = end - (index < scenes.length - 1 ? transitionSeconds : 0);
    return { ...scene, start, end, duration };
  });
}

function pad(value, length = 2) {
  return String(value).padStart(length, "0");
}

function timestamp(seconds, decimalSeparator = ".", centiseconds = false) {
  const safe = Math.max(0, seconds);
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const wholeSeconds = Math.floor(safe % 60);
  const scale = centiseconds ? 100 : 1000;
  const fraction = Math.min(scale - 1, Math.round((safe - Math.floor(safe)) * scale));
  return `${pad(hours)}:${pad(minutes)}:${pad(wholeSeconds)}${decimalSeparator}${pad(
    fraction,
    centiseconds ? 2 : 3,
  )}`;
}

function captionText(scene) {
  const text = scene.caption?.text ?? scene.caption ?? "";
  if (typeof text !== "string") return "";
  return text.trim();
}

export function captionEntries(timeline) {
  const entries = timeline
    .map((scene, index) => ({
      index: index + 1,
      start: scene.start,
      end: scene.end,
      text: captionText(scene),
      sceneId: scene.id ?? `scene-${index + 1}`,
    }))
    .filter((entry) => entry.text.length > 0);
  // Adjacent scenes overlap during crossfade transitions; clamp each caption's
  // start so it never precedes the previous caption's end.
  let previousEnd = 0;
  for (const entry of entries) {
    if (entry.start < previousEnd) entry.start = Math.min(previousEnd, entry.end);
    previousEnd = entry.end;
  }
  return entries;
}

export function validateCaptionText(text) {
  const lines = String(text).split(/\r?\n/);
  if (lines.length > 2) throw new Error("Captions may contain at most two lines");
  const widthErrors = captionWidthErrors(text);
  if (widthErrors.length > 0) throw new Error(`Caption does not fit: ${widthErrors.join("; ")}`);
  return true;
}

export function validateCaptionTimeline(entries, duration) {
  let previousEnd = 0;
  for (const [index, entry] of entries.entries()) {
    if (!Number.isFinite(entry.start) || entry.start < 0) {
      throw new Error(`Caption ${index + 1} start must be a non-negative final-timeline timestamp`);
    }
    if (!Number.isFinite(entry.end) || entry.end <= entry.start) {
      throw new Error(`Caption ${index + 1} end must follow its start`);
    }
    if (entry.start < previousEnd) throw new Error(`Caption ${index + 1} overlaps the preceding caption`);
    if (Number.isFinite(duration) && entry.end > duration) {
      throw new Error(`Caption ${index + 1} ends after the composed video timeline`);
    }
    previousEnd = entry.end;
  }
  return true;
}

export function renderVtt(entries) {
  const blocks = entries.map((entry) => {
    validateCaptionText(entry.text);
    return `${entry.index}\n${timestamp(entry.start)} --> ${timestamp(entry.end)}\n${entry.text}`;
  });
  return `WEBVTT\n\n${blocks.join("\n\n")}\n`;
}

export function renderSrt(entries) {
  const blocks = entries.map((entry) => {
    validateCaptionText(entry.text);
    return `${entry.index}\n${timestamp(entry.start, ",")} --> ${timestamp(entry.end, ",")}\n${entry.text}`;
  });
  return `${blocks.join("\n\n")}\n`;
}

export function renderTranscript(entries) {
  return `${entries.map((entry) => `[${timestamp(entry.start)}] ${entry.text.replace(/\n/g, " ")}`).join("\n")}\n`;
}

function assEscape(text) {
  return String(text)
    .replace(/\\/g, "\\\\")
    .replace(/{/g, "\\{")
    .replace(/}/g, "\\}")
    .replace(/\r?\n/g, "\\N");
}

function assTimestamp(seconds) {
  const value = timestamp(seconds, ".", true);
  return value.replace(/^0/, "");
}

function assColor(hex, alpha = "00") {
  const value = hex.replace(/^#/, "");
  const [r, g, b] = [value.slice(0, 2), value.slice(2, 4), value.slice(4, 6)];
  return `&H${alpha}${b}${g}${r}`;
}

function assHeader({ width, height, captionHeight, fontSize }) {
  const marginV = Math.max(10, Math.floor((captionHeight - fontSize * 2) / 2));
  const marginH = width === 1920 ? 48 : 32;
  return `[Script Info]
ScriptType: v4.00+
PlayResX: ${width}
PlayResY: ${height}
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Caption,Red Hat Text,${fontSize},${assColor("#FFFFFF")},${assColor("#FFFFFF")},${assColor("#000000")},${assColor("#000000")},0,0,0,0,100,100,0,0,1,0,0,2,${marginH},${marginH},${marginV},1
Style: Pointer,Red Hat Text,1,${assColor("#FFFFFF")},${assColor("#FFFFFF")},${assColor("#000000")},${assColor("#000000", "FF")},-1,0,0,0,100,100,0,0,1,6,0,7,0,0,0,1
Style: ClickPointer,Red Hat Text,1,${assColor("#FFFFFF")},${assColor("#FFFFFF")},${assColor("#000000")},${assColor("#000000", "FF")},-1,0,0,0,100,100,0,0,1,6,0,7,0,0,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text`;
}

function pointerPresentation(x, y, geometry, scale = 1) {
  const left = x + POINTER_WIDTH * scale > geometry.width;
  const up = y + POINTER_HEIGHT * scale > geometry.contentHeight;
  if (left && up) return { alignment: "\\an3", vector: POINTER_VECTOR_UP_LEFT };
  if (left) return { alignment: "\\an9", vector: POINTER_VECTOR_LEFT };
  if (up) return { alignment: "\\an1", vector: POINTER_VECTOR_UP };
  return { alignment: "\\an7", vector: POINTER_VECTOR };
}

function visiblePointerIntervals(start, end, pulses) {
  const intervals = [];
  let cursor = start;
  for (const pulse of pulses) {
    if (pulse.end <= cursor) continue;
    if (pulse.start >= end) break;
    if (pulse.start > cursor) intervals.push([cursor, Math.min(pulse.start, end)]);
    cursor = Math.max(cursor, pulse.end);
    if (cursor >= end) break;
  }
  if (cursor < end) intervals.push([cursor, end]);
  return intervals;
}

function interpolatePointer(start, end, time, next, at) {
  if (!next || end <= time) return { x: start.x, y: start.y };
  const ratio = Math.max(0, Math.min(1, (at - time) / (end - time)));
  return {
    x: Math.round(start.x + (next.x - start.x) * ratio),
    y: Math.round(start.y + (next.y - start.y) * ratio),
  };
}

function pointerDialogs(pointerEvents, geometry, videoDuration) {
  const dialogs = [];
  let previous = -1;
  const normalized = pointerEvents.map((event) => {
    const milliseconds = event.monotonicMs ?? event.timestampMs ?? event.timeMs;
    const time = Number(
      event.time ?? event.seconds ?? event.timestampSeconds ??
        (Number.isFinite(milliseconds) ? Number(milliseconds) / 1000 : undefined),
    );
    if (!Number.isFinite(time) || time < previous) {
      throw new Error("Pointer event timestamps must be finite and monotonic");
    }
    previous = time;
    const normalizedX = Number(event.x ?? event.normalizedX);
    const normalizedY = Number(event.y ?? event.normalizedY);
    const x = Math.round(normalizedX * geometry.width);
    const y = Math.round(normalizedY * geometry.contentHeight);
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > geometry.width || y < 0 || y > geometry.contentHeight) {
      throw new Error("Pointer coordinates must be normalized inside the content region");
    }
    return { event, time, x, y };
  });
  const pulses = normalized.flatMap(({ event, time, x, y }) => {
    if (event.type !== "click" && event.click !== true) return [];
    const minDuration = MIN_CLICK_FRAMES / FRAME_RATE;
    const end = Math.min(time + minDuration, videoDuration ?? time + minDuration);
    return end > time ? [{ start: time, end, x, y }] : [];
  });
  for (let index = 0; index < normalized.length; index += 1) {
    const current = normalized[index];
    const { event, time, x, y } = current;
    const next = normalized[index + 1];
    const end = Number(event.endTime ?? event.endSeconds ?? (next?.time > time ? next.time : time + 0.7));
    for (const [visibleStart, visibleEnd] of visiblePointerIntervals(time, end, pulses)) {
      const from = interpolatePointer(current, end, time, next, visibleStart);
      const to = interpolatePointer(current, end, time, next, visibleEnd);
      const position = next
        ? `\\move(${from.x},${from.y},${to.x},${to.y})`
        : `\\pos(${from.x},${from.y})`;
      const presentation = pointerPresentation(
        Math.max(from.x, to.x),
        Math.max(from.y, to.y),
        geometry,
      );
      dialogs.push(
        `Dialogue: 2,${assTimestamp(visibleStart)},${assTimestamp(visibleEnd)},Pointer,,0,0,0,,{${presentation.alignment}${position}\\p1}${presentation.vector}`,
      );
    }
  }
  for (const pulse of pulses) {
    const presentation = pointerPresentation(pulse.x, pulse.y, geometry, CLICK_SCALE);
    dialogs.push(
      `Dialogue: 3,${assTimestamp(pulse.start)},${assTimestamp(pulse.end)},ClickPointer,,0,0,0,,{${presentation.alignment}\\pos(${pulse.x},${pulse.y})\\fscx120\\fscy120\\t(0,150,\\fscx88\\fscy88)\\t(150,360,\\fscx100\\fscy100)\\fad(0,120)\\p1}${presentation.vector}`,
    );
  }
  return dialogs;
}

export function renderAss({ entries, pointerEvents = [], geometry, duration }) {
  const fontSize = geometry.width === 1920 ? 44 : 30;
  const captionTop = geometry.contentHeight;
  const dialogs = entries.map((entry) => {
    validateCaptionText(entry.text);
    return `Dialogue: 0,${assTimestamp(entry.start)},${assTimestamp(entry.end)},Caption,,0,0,0,,{\\an2\\pos(${Math.round(
      geometry.width / 2,
    )},${captionTop + Math.round(geometry.captionHeight / 2 + fontSize / 2)})}${assEscape(entry.text)}`;
  });
  return `${assHeader({ ...geometry, fontSize })}\n${[...dialogs, ...pointerDialogs(pointerEvents, geometry, duration)].join("\n")}\n`;
}

export async function generateCaptionArtifacts({ timeline, entries: suppliedEntries, pointerEvents = [], geometry, outputDir }) {
  const entries = suppliedEntries ?? captionEntries(timeline);
  const duration = timeline?.at(-1)?.end;
  validateCaptionTimeline(entries, duration);
  await fs.mkdir(outputDir, { recursive: true });
  const files = {
    vtt: path.join(outputDir, "captions.vtt"),
    srt: path.join(outputDir, "captions.srt"),
    transcript: path.join(outputDir, "transcript.txt"),
    ass: path.join(outputDir, "overlays.ass"),
  };
  await Promise.all([
    fs.writeFile(files.vtt, renderVtt(entries), { mode: 0o600 }),
    fs.writeFile(files.srt, renderSrt(entries), { mode: 0o600 }),
    fs.writeFile(files.transcript, renderTranscript(entries), { mode: 0o600 }),
    fs.writeFile(files.ass, renderAss({
      entries,
      pointerEvents,
      geometry,
      duration,
    }), { mode: 0o600 }),
  ]);
  return { entries, files };
}

export { FRAME_RATE, MIN_CLICK_FRAMES, assEscape, timestamp };
