const FONT_SIZES = Object.freeze({ "1080p": 44, "720p": 29 });
const WIDTH_PROFILES = Object.freeze([
  Object.freeze({ resolution: "1080p", width: 1920, fontSize: 44, margin: 48 }),
  // The 720p derivative scales the 44px master style to about 29.33px. Round
  // upward here so width validation never understates the rendered footprint.
  Object.freeze({ resolution: "720p", width: 1280, fontSize: 30, margin: 32 }),
]);
const MOBILE_MINIMUM_DURATION_SECONDS = 2.5;
const MOBILE_MAXIMUM_WORDS_PER_SECOND = 3;

// Conservative Red Hat Text advance-width estimates in em units. Wide glyphs
// intentionally overestimate the vendored font so a passing line fits at both
// output sizes without depending on a host text renderer.
function glyphWidthEm(character) {
  if (/\s/u.test(character)) return 0.34;
  if (/[ilI1.,'`:;|!]/u.test(character)) return 0.32;
  if (/[MW@#%&]/u.test(character)) return 1;
  if (/[A-Z]/u.test(character)) return 0.7;
  if (/[a-z]/u.test(character)) return 0.57;
  if (/[0-9]/u.test(character)) return 0.6;
  if (/[-_+/?()[\]{}]/u.test(character)) return 0.5;
  return 1;
}

export function estimateCaptionLineWidth(line, fontSize) {
  return Array.from(String(line)).reduce((width, character) => width + glyphWidthEm(character) * fontSize, 0);
}

export function captionWidthErrors(text) {
  const errors = [];
  for (const [lineIndex, line] of String(text).split(/\r?\n/).entries()) {
    for (const profile of WIDTH_PROFILES) {
      const available = profile.width - profile.margin * 2;
      const measured = estimateCaptionLineWidth(line, profile.fontSize);
      if (measured > available) {
        errors.push(
          `line ${lineIndex + 1} exceeds the ${profile.resolution} caption width (${Math.ceil(measured)}px > ${available}px)`,
        );
      }
    }
  }
  return errors;
}

export function captionLineCount(text) {
  return String(text).split(/\r?\n/).length;
}

export function captionWordCount(text) {
  return String(text).trim().split(/\s+/u).filter(Boolean).length;
}

export function validateCaptions(captions, totalDurationSeconds, options = {}) {
  const errors = [];
  let previousEnd = 0;
  const mobileProfile = options?.profile === "mobile";
  captions.forEach((caption, index) => {
    const at = `captions[${index}]`;
    const validStart = typeof caption.startSeconds === "number"
      && Number.isFinite(caption.startSeconds)
      && caption.startSeconds >= 0;
    const validEnd = typeof caption.endSeconds === "number"
      && Number.isFinite(caption.endSeconds)
      && caption.endSeconds > 0;
    if (!validStart) errors.push(`${at}.startSeconds must be non-negative`);
    if (!validEnd || (validStart && caption.endSeconds <= caption.startSeconds)) errors.push(`${at}.endSeconds must be after startSeconds`);
    if (validStart && caption.startSeconds < previousEnd) errors.push(`${at} overlaps the preceding caption`);
    if (validEnd && typeof totalDurationSeconds === "number" && Number.isFinite(totalDurationSeconds) && caption.endSeconds > totalDurationSeconds) errors.push(`${at} ends after the story`);
    if (captionLineCount(caption.text) > 2) errors.push(`${at}.text must use at most two lines`);
    errors.push(...captionWidthErrors(caption.text).map((error) => `${at}.text ${error}`));
    const durationSeconds = validStart && validEnd
      ? caption.endSeconds - caption.startSeconds
      : Number.NaN;
    if (mobileProfile && Number.isFinite(durationSeconds) && durationSeconds > 0) {
      if (durationSeconds < MOBILE_MINIMUM_DURATION_SECONDS) {
        errors.push(`${at} must remain visible for at least 2.5 seconds`);
      }
      if (captionWordCount(caption.text) > durationSeconds * MOBILE_MAXIMUM_WORDS_PER_SECOND) {
        errors.push(`${at}.text must not exceed 3 words per second`);
      }
    }
    if (validEnd) previousEnd = Math.max(previousEnd, caption.endSeconds);
  });
  return errors;
}

export function captionStyle(resolution) {
  const fontSize = FONT_SIZES[resolution];
  if (!fontSize) throw new Error(`Unsupported caption resolution: ${resolution}`);
  return {
    fontFamily: "Red Hat Text",
    fontSize,
    foreground: "#FFFFFF",
    background: "#000000",
    maxLines: 2,
  };
}
