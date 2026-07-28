export const RESOLUTIONS = Object.freeze({
  "1080p": Object.freeze({ width: 1920, height: 1080, contentHeight: 936, captionHeight: 144, gap: 24, extensionWidth: 630 }),
  "720p": Object.freeze({ width: 1280, height: 720, contentHeight: 624, captionHeight: 96, gap: 16, extensionWidth: 420 }),
});

export const LAYOUT_PRESETS = Object.freeze([
  "browser-full",
  "slides-extension",
  "terminal-extension",
  "split",
  "mobile-full",
]);

function even(value) {
  const rounded = Math.round(value);
  return rounded % 2 === 0 ? rounded : rounded - 1;
}

export function calculateLayout(preset, resolution = "1080p", leftPercent = 50) {
  const frame = RESOLUTIONS[resolution];
  if (!frame) throw new Error(`Unsupported resolution: ${resolution}`);
  if (!LAYOUT_PRESETS.includes(preset)) throw new Error(`Unsupported layout preset: ${preset}`);

  const caption = { x: 0, y: frame.contentHeight, width: frame.width, height: frame.captionHeight };
  const content = { x: 0, y: 0, width: frame.width, height: frame.contentHeight };
  if (preset === "browser-full") {
    return { resolution, frame: { width: frame.width, height: frame.height }, content, caption, browser: content };
  }
  if (preset === "mobile-full") {
    return { resolution, frame: { width: frame.width, height: frame.height }, content, caption, mobile: content };
  }

  let leftWidth;
  let rightWidth;
  if (preset === "split") {
    if (!Number.isInteger(leftPercent) || leftPercent < 30 || leftPercent > 70) {
      throw new Error("split layout leftPercent must be an integer from 30 through 70");
    }
    leftWidth = even((frame.width - frame.gap) * leftPercent / 100);
    rightWidth = frame.width - frame.gap - leftWidth;
  } else {
    rightWidth = frame.extensionWidth;
    leftWidth = frame.width - frame.gap - rightWidth;
  }

  const left = { x: 0, y: 0, width: leftWidth, height: frame.contentHeight };
  const right = { x: leftWidth + frame.gap, y: 0, width: rightWidth, height: frame.contentHeight };
  const result = {
    resolution,
    frame: { width: frame.width, height: frame.height },
    content,
    caption,
    gap: frame.gap,
    left,
    right,
  };
  if (preset === "slides-extension") return { ...result, slides: left, extension: right };
  if (preset === "terminal-extension") return { ...result, terminal: left, extension: right };
  return result;
}

export function layoutsForScenario(scenario) {
  return Object.fromEntries(["1080p", "720p"].map((resolution) => [
    resolution,
    calculateLayout(scenario.layout.preset, resolution, scenario.layout.leftPercent ?? 50),
  ]));
}
