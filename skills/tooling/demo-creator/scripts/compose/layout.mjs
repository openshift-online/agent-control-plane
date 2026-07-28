const OUTPUTS = Object.freeze({
  "1080p": Object.freeze({
    name: "1080p",
    width: 1920,
    height: 1080,
    contentHeight: 936,
    captionHeight: 144,
    gap: 24,
    extensionWidth: 630,
  }),
  "720p": Object.freeze({
    name: "720p",
    width: 1280,
    height: 720,
    contentHeight: 624,
    captionHeight: 96,
    gap: 16,
    extensionWidth: 420,
  }),
});

export function outputGeometry(name = "1080p") {
  const geometry = OUTPUTS[name];
  if (!geometry) {
    throw new Error(`Unsupported output geometry: ${name}`);
  }
  return { ...geometry };
}

function even(value) {
  const rounded = Math.round(value);
  return rounded % 2 === 0 ? rounded : rounded - 1;
}

/**
 * Return exact pixel cells for a supported layout. Cells cover the content
 * region only; the caption band is intentionally never available to sources.
 */
export function layoutFor(preset, output = "1080p", options = {}) {
  const geometry = outputGeometry(output);
  const full = {
    x: 0,
    y: 0,
    width: geometry.width,
    height: geometry.contentHeight,
  };

  if (preset === "browser-full") {
    return { preset, geometry, cells: { browser: full } };
  }

  if (preset === "mobile-full") {
    return { preset, geometry, cells: { mobile: full } };
  }

  if (preset === "slides-extension" || preset === "terminal-extension") {
    const leftName = preset === "slides-extension" ? "slides" : "terminal";
    const leftWidth = geometry.width - geometry.extensionWidth - geometry.gap;
    return {
      preset,
      geometry,
      cells: {
        [leftName]: { ...full, width: leftWidth },
        extension: {
          x: leftWidth + geometry.gap,
          y: 0,
          width: geometry.extensionWidth,
          height: geometry.contentHeight,
        },
      },
    };
  }

  if (preset === "split" || preset === "generic-split") {
    const ratio = Number(options.leftRatio ?? options.ratio ?? 0.5);
    if (!Number.isFinite(ratio) || ratio < 0.3 || ratio > 0.7) {
      throw new Error("Generic split ratio must be between 0.30 and 0.70");
    }
    const available = geometry.width - geometry.gap;
    const leftWidth = even(available * ratio);
    const rightWidth = available - leftWidth;
    return {
      preset: "generic-split",
      geometry,
      cells: {
        left: { ...full, width: leftWidth },
        right: {
          x: leftWidth + geometry.gap,
          y: 0,
          width: rightWidth,
          height: geometry.contentHeight,
        },
      },
    };
  }

  throw new Error(`Unsupported layout preset: ${preset}`);
}

export function scaleLayout(layout, targetOutput) {
  const target = outputGeometry(targetOutput);
  const sx = target.width / layout.geometry.width;
  const sy = target.contentHeight / layout.geometry.contentHeight;
  const cells = Object.fromEntries(
    Object.entries(layout.cells).map(([name, cell]) => [
      name,
      {
        x: even(cell.x * sx),
        y: even(cell.y * sy),
        width: even(cell.width * sx),
        height: even(cell.height * sy),
      },
    ]),
  );
  return { ...layout, geometry: target, cells };
}

export function assertLayoutBounds(layout) {
  const { geometry, cells } = layout;
  for (const [name, cell] of Object.entries(cells)) {
    if (
      cell.x < 0 ||
      cell.y < 0 ||
      cell.width <= 0 ||
      cell.height <= 0 ||
      cell.x + cell.width > geometry.width ||
      cell.y + cell.height > geometry.contentHeight
    ) {
      throw new Error(`Layout cell ${name} exceeds the content region`);
    }
    if ([cell.x, cell.y, cell.width, cell.height].some((value) => value % 2 !== 0)) {
      throw new Error(`Layout cell ${name} must use even pixel coordinates`);
    }
  }
  return true;
}
