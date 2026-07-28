const ALLOWED_EVENT_TYPES = new Set(["tap", "fill"]);
const ALLOWED_EVENT_KEYS = ["monotonicSeconds", "type", "x", "y"];
const GEOMETRY_KEYS = ["physical", "recording", "rotation"];
const DIMENSION_KEYS = ["height", "width"];

function assertPositiveInteger(value, label) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
}

function assertExactEventShape(event) {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    throw new Error("pointer event must be an object");
  }
  const keys = Object.keys(event).sort();
  if (
    keys.length !== ALLOWED_EVENT_KEYS.length
    || keys.some((key, index) => key !== ALLOWED_EVENT_KEYS[index])
  ) {
    throw new Error("pointer event contains unsupported or secret-bearing fields");
  }
  if (!ALLOWED_EVENT_TYPES.has(event.type)) {
    throw new Error("pointer event type must be tap or fill");
  }
}

function assertPixelCoordinate(value, limit) {
  return Number.isInteger(value) && value >= 0 && value < limit;
}

function assertExactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} must contain only ${wanted.join(", ")}`);
  }
}

function verifiedDisplayDimensions(displayGeometry) {
  assertExactKeys(displayGeometry, GEOMETRY_KEYS, "verified display geometry");
  assertExactKeys(displayGeometry.physical, DIMENSION_KEYS, "physical display geometry");
  assertExactKeys(displayGeometry.recording, DIMENSION_KEYS, "recording display geometry");
  assertPositiveInteger(displayGeometry.physical.width, "physical display width");
  assertPositiveInteger(displayGeometry.physical.height, "physical display height");
  assertPositiveInteger(displayGeometry.recording.width, "pointer recording width");
  assertPositiveInteger(displayGeometry.recording.height, "pointer recording height");
  if (displayGeometry.rotation !== 0) {
    throw new Error("verified display geometry must be unrotated");
  }
  return displayGeometry.recording;
}

export function createAndroidPointerRecorder(options = {}) {
  const optionKeys = Object.keys(options).sort();
  const allowedKeys = ["displayGeometry", "durationSeconds", "startMonotonicSeconds"];
  if (optionKeys.some((key) => !allowedKeys.includes(key))) {
    throw new Error("pointer recorder options contain unsupported authored dimensions");
  }
  const {
    displayGeometry,
    startMonotonicSeconds = 0,
    durationSeconds,
  } = options;
  const { width, height } = verifiedDisplayDimensions(displayGeometry);
  if (!Number.isFinite(startMonotonicSeconds)) {
    throw new Error("pointer recording start monotonic time must be finite");
  }
  if (durationSeconds !== undefined && (!Number.isFinite(durationSeconds) || durationSeconds <= 0)) {
    throw new Error("pointer recording authored duration must be finite and positive");
  }

  const events = [];
  let lastMonotonicSeconds = startMonotonicSeconds;

  return Object.freeze({
    record(event) {
      assertExactEventShape(event);
      if (!assertPixelCoordinate(event.x, width) || !assertPixelCoordinate(event.y, height)) {
        throw new Error("pointer event coordinates must identify an in-range pixel");
      }
      if (
        !Number.isFinite(event.monotonicSeconds)
        || event.monotonicSeconds < lastMonotonicSeconds
      ) {
        throw new Error("pointer event monotonic times must be finite and nondecreasing");
      }
      const time = event.monotonicSeconds - startMonotonicSeconds;
      if (durationSeconds !== undefined && time >= durationSeconds) {
        throw new Error("pointer event must occur before the authored duration boundary");
      }

      const normalized = Object.freeze({
        type: "click",
        time,
        x: (event.x + 0.5) / width,
        y: (event.y + 0.5) / height,
      });
      if (
        !Number.isFinite(normalized.x)
        || !Number.isFinite(normalized.y)
        || normalized.x <= 0
        || normalized.x >= 1
        || normalized.y <= 0
        || normalized.y >= 1
      ) {
        throw new Error("pointer event normalization must remain inside the unit square");
      }
      events.push(normalized);
      lastMonotonicSeconds = event.monotonicSeconds;
      return normalized;
    },
    snapshot() {
      return [...events];
    },
  });
}
