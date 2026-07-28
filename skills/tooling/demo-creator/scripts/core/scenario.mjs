import { readFileSync } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import YAML from "yaml";
import { LAYOUT_PRESETS, layoutsForScenario } from "./layout.mjs";
import { validateCaptions } from "./captions.mjs";
import { findSecrets, findSensitiveFields } from "./security.mjs";
import { expectedProjectName } from "./ownership.mjs";
import {
  ANDROID_AUTHORED_CAPTURE_MAX_SECONDS,
  ANDROID_LAUNCH_ACTIVITY_MAX_CHARACTERS,
  isAndroidLaunchActivity,
  isAndroidResourceId,
} from "./android-contract.mjs";

export const ANDROID_ACTION_SETTLING_MILLISECONDS = 900;
export { ANDROID_LAUNCH_ACTIVITY_MAX_CHARACTERS };

const ROOT_KEYS = new Set(["version", "id", "title", "description", "fps", "canvas", "layout", "story", "captions", "acp", "extension", "capture", "production"]);
const STORY_TYPES = new Set(["title", "browser", "slides", "terminal", "mobile", "end"]);
const ANDROID_APPLICATION_ID = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/u;
const ANDROID_SYSTEM_IMAGE = /^system-images;android-(?:[2-9][0-9]|[1-9][0-9]{2})(?:\.[0-9]+)?;(?:default|google_apis|google_apis_playstore|google_apis_ps16k);(?:arm64-v8a|x86_64)$/u;
const ANDROID_ENVIRONMENT_KEYS = new Set(["ACP_URL", "ACP_PROJECT", "ACP_BEARER_TOKEN"]);
const REPOSITORY_ARTIFACT_PATH = /^repo:(?!\/)(?!\.{1,2}(?:\/|$))(?!.*\/\/)(?!.*\/\.{1,2}(?:\/|$))(?!.*\\)[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/u;
const scenarioSchema = JSON.parse(readFileSync(new URL("../../schema/scenario.schema.json", import.meta.url), "utf8"));
const validateStructure = new Ajv2020({ allErrors: true, strict: true }).compile(scenarioSchema);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function withObjectDefaults(value, defaults) {
  if (value === undefined) return { ...defaults };
  return isObject(value) ? { ...defaults, ...value } : value;
}

function isContainedRelativePath(value) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) return false;
  if (path.isAbsolute(value) || /^[a-zA-Z]:[\\/]/u.test(value) || /^[\\/]/u.test(value)) return false;
  return !value.split(/[\\/]/u).includes("..");
}

function unknownKeys(value, allowed, location, errors) {
  if (!isObject(value)) return;
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    errors.push(`${location} contains an unsupported field`);
  }
}

export function normalizeScenario(input) {
  const capture = isObject(input.capture) && isObject(input.capture.android)
    ? {
        ...input.capture,
        android: {
          actionSettlingMilliseconds: ANDROID_ACTION_SETTLING_MILLISECONDS,
          ...input.capture.android,
        },
      }
    : input.capture;
  return {
    ...input,
    fps: input.fps ?? 30,
    canvas: withObjectDefaults(input.canvas, { master: "1080p", derivative: "720p" }),
    production: withObjectDefaults(input.production, {
      transitionMilliseconds: 300,
      silent: true,
    }),
    ...(input.acp === undefined ? {} : { acp: withObjectDefaults(input.acp, {}) }),
    ...(input.capture === undefined ? {} : { capture }),
  };
}

function validateAndroidSelector(selector, location, errors) {
  if (!isObject(selector)) {
    errors.push(`${location} must be an object`);
    return;
  }
  unknownKeys(selector, new Set(["by", "value"]), location, errors);
  if (!["resourceId", "text", "contentDescription"].includes(selector.by)) {
    errors.push(`${location}.by is invalid`);
  }
  if (typeof selector.value !== "string" || !selector.value || selector.value.length > 200) {
    errors.push(`${location}.value must contain 1-200 characters`);
  } else if (selector.by === "resourceId" && !isAndroidResourceId(selector.value)) {
    errors.push(`${location}.value must be a bounded Android resource ID`);
  }
}

function validateAndroidActions(actions, location, allowEnvironment, errors) {
  if (!Array.isArray(actions)) {
    errors.push(`${location} must be an array`);
    return;
  }
  if (actions.length > 100) errors.push(`${location} must contain no more than 100 actions`);
  actions.forEach((action, index) => {
    const at = `${location}[${index}]`;
    if (!isObject(action)) {
      errors.push(`${at} must be an object`);
      return;
    }
    const allowedActions = allowEnvironment
      ? ["wait", "expect", "tap", "fill", "fillFromEnvironment", "back"]
      : ["wait", "expect", "tap", "fill", "back"];
    if (!allowedActions.includes(action.action)) errors.push(`${at}.action is invalid`);
    if (action.action === "wait") {
      unknownKeys(action, new Set(["action", "ms"]), at, errors);
      if (!Number.isInteger(action.ms) || action.ms < 0 || action.ms > 10000) {
        errors.push(`${at}.ms must be an integer from 0 through 10000`);
      }
      return;
    }
    if (action.action === "back") {
      unknownKeys(action, new Set(["action"]), at, errors);
      return;
    }
    if (["expect", "tap"].includes(action.action)) {
      unknownKeys(action, new Set(["action", "selector"]), at, errors);
      validateAndroidSelector(action.selector, `${at}.selector`, errors);
      return;
    }
    if (action.action === "fill") {
      unknownKeys(action, new Set(["action", "selector", "value"]), at, errors);
      validateAndroidSelector(action.selector, `${at}.selector`, errors);
      if (typeof action.value !== "string" || action.value.length > 500) {
        errors.push(`${at}.value must contain no more than 500 characters`);
      } else if (findSecrets(action.value).length) {
        errors.push(`${at}.value contains credential-like material; use fillFromEnvironment during setup`);
      }
      return;
    }
    if (action.action === "fillFromEnvironment") {
      unknownKeys(action, new Set(["action", "selector", "environment"]), at, errors);
      validateAndroidSelector(action.selector, `${at}.selector`, errors);
      if (typeof action.environment !== "string" || !ANDROID_ENVIRONMENT_KEYS.has(action.environment)) {
        errors.push(`${at}.environment must be an approved ACP environment key`);
      }
    }
  });
}

function validateAndroidCapture(capture, errors) {
  if (!isObject(capture)) {
    errors.push("capture must be an object");
    return;
  }
  unknownKeys(capture, new Set(["kind", "cluster", "android"]), "capture", errors);
  if (capture.kind !== "android-emulator") errors.push("capture.kind must be android-emulator");
  if (!isObject(capture.cluster)) {
    errors.push("capture.cluster must declare the disposable Kind boundary");
  } else {
    unknownKeys(capture.cluster, new Set(["kind"]), "capture.cluster", errors);
    if (capture.cluster.kind !== "disposable-kind") errors.push("capture.cluster.kind must be disposable-kind");
  }
  if (!isObject(capture.android)) {
    errors.push("capture.android must be an object");
    return;
  }
  const android = capture.android;
  unknownKeys(android, new Set([
    "expectedApplicationId",
    "launchActivity",
    "apk",
    "apkLock",
    "systemImage",
    "actionSettlingMilliseconds",
    "setupActions",
    "actions",
  ]), "capture.android", errors);
  if (typeof android.expectedApplicationId !== "string" || !ANDROID_APPLICATION_ID.test(android.expectedApplicationId)) {
    errors.push("capture.android.expectedApplicationId must be a bounded Android application ID");
  }
  if (!isAndroidLaunchActivity(android.launchActivity)) {
    errors.push("capture.android.launchActivity must be a bounded Android component/activity");
  } else if (android.launchActivity.split("/", 1)[0] !== android.expectedApplicationId) {
    errors.push("capture.android.launchActivity must use capture.android.expectedApplicationId");
  }
  if (typeof android.apk !== "string" || !REPOSITORY_ARTIFACT_PATH.test(android.apk) || !android.apk.endsWith(".apk")) {
    errors.push("capture.android.apk must be a normalized repo: .apk artifact path");
  }
  if (typeof android.apkLock !== "string" || !REPOSITORY_ARTIFACT_PATH.test(android.apkLock) || !android.apkLock.endsWith(".apk.lock.json")) {
    errors.push("capture.android.apkLock must be a normalized repo: .apk.lock.json artifact path");
  } else if (typeof android.apk === "string" && android.apkLock !== `${android.apk}.lock.json`) {
    errors.push("capture.android.apkLock must be the lock for capture.android.apk");
  }
  if (typeof android.systemImage !== "string" || !ANDROID_SYSTEM_IMAGE.test(android.systemImage)) {
    errors.push("capture.android.systemImage must be a bounded Android SDK system-image package");
  }
  if (android.actionSettlingMilliseconds !== ANDROID_ACTION_SETTLING_MILLISECONDS) {
    errors.push(`capture.android.actionSettlingMilliseconds must be ${ANDROID_ACTION_SETTLING_MILLISECONDS}`);
  }
  validateAndroidActions(android.setupActions, "capture.android.setupActions", true, errors);
  if (Array.isArray(android.setupActions)) {
    const setupEnvironmentActions = android.setupActions
      .filter((action) => action?.action === "fillFromEnvironment");
    const setupEnvironment = new Set(setupEnvironmentActions.map((action) => action.environment));
    if (setupEnvironmentActions.filter((action) => action.environment === "ACP_URL").length !== 1) {
      errors.push("capture.android.setupActions must configure ACP_URL exactly once from the owned endpoint");
    }
  }
  validateAndroidActions(android.actions, "capture.android.actions", false, errors);
  if (Array.isArray(android.actions) && android.actions.length === 0) {
    errors.push("capture.android.actions must contain at least one recorded action for portable landmarks");
  }
}

export function composedDurationSeconds(story, transitionMilliseconds) {
  const total = story.reduce(
    (sum, segment) => sum + (Number.isFinite(segment?.durationSeconds) ? segment.durationSeconds : 0),
    0,
  );
  const transitionSeconds = Number.isFinite(transitionMilliseconds)
    ? transitionMilliseconds / 1000
    : 0;
  return Number((total - Math.max(0, story.length - 1) * transitionSeconds).toFixed(9));
}

export function validateScenario(input) {
  const errors = [];
  if (!isObject(input)) return { valid: false, errors: ["scenario must be an object"] };
  unknownKeys(input, ROOT_KEYS, "scenario", errors);
  const scenario = normalizeScenario(input);
  if (!validateStructure(scenario)) {
    for (const error of validateStructure.errors ?? []) {
      errors.push(`schema${error.instancePath || "/"}: ${error.message}`);
    }
  }
  if (scenario.version !== 1) errors.push("version must be 1");
  if (!/^[a-z][a-z0-9-]{2,57}$/.test(scenario.id ?? "")) errors.push("id must be a lowercase DNS-style name with 3-58 characters");
  if (typeof scenario.title !== "string" || !scenario.title.trim() || scenario.title.length > 100) errors.push("title must contain 1-100 characters");
  if (scenario.fps !== 30) errors.push("fps must be 30");
  if (!isObject(scenario.canvas) || scenario.canvas.master !== "1080p" || scenario.canvas.derivative !== "720p") errors.push("canvas must produce a 1080p master and 720p derivative");

  if (!isObject(scenario.layout) || !LAYOUT_PRESETS.includes(scenario.layout?.preset)) errors.push("layout.preset is invalid");
  unknownKeys(scenario.layout, new Set(["preset", "leftPercent"]), "layout", errors);
  if (scenario.layout?.preset === "split" && (!Number.isInteger(scenario.layout.leftPercent) || scenario.layout.leftPercent < 30 || scenario.layout.leftPercent > 70)) {
    errors.push("layout.leftPercent must be an integer from 30 through 70 for split layouts");
  }

  if (!Array.isArray(scenario.story) || scenario.story.length === 0) errors.push("story must contain at least one segment");
  const story = Array.isArray(scenario.story) ? scenario.story : [];
  story.forEach((segment, index) => {
    if (!isObject(segment)) return errors.push(`story[${index}] must be an object`);
    unknownKeys(segment, new Set(["type", "source", "durationSeconds", "note"]), `story[${index}]`, errors);
    if (!STORY_TYPES.has(segment.type)) errors.push(`story[${index}].type is invalid`);
    if (!Number.isFinite(segment.durationSeconds) || segment.durationSeconds <= 0) errors.push(`story[${index}].durationSeconds must be positive`);
    if (["slides", "terminal"].includes(segment.type) && !segment.source) errors.push(`story[${index}].source is required for ${segment.type}`);
    if (segment.type === "mobile" && segment.source !== undefined) {
      errors.push(`story[${index}].source is not supported for mobile capture`);
    }
    if (segment.source !== undefined && !isContainedRelativePath(segment.source)) {
      errors.push(`story[${index}].source must stay inside the scenario directory`);
    }
  });
  const includesMobile = story.some((segment) => segment?.type === "mobile");
  const usesAndroidMobileContract = includesMobile
    || scenario.capture?.kind === "android-emulator"
    || scenario.layout?.preset === "mobile-full";
  if (usesAndroidMobileContract) {
    if (!includesMobile) {
      errors.push("Android mobile stories require at least one mobile scene");
    }
    if (story.some((segment) => !["title", "mobile", "end"].includes(segment?.type))) {
      errors.push("Android mobile stories may contain only title, mobile, and end scenes");
    }
  }
  const transitionMilliseconds = Number.isInteger(scenario.production?.transitionMilliseconds)
    && scenario.production.transitionMilliseconds >= 0
    && scenario.production.transitionMilliseconds <= 1000
    ? scenario.production.transitionMilliseconds
    : 0;
  const transitionSeconds = transitionMilliseconds / 1000;
  if (transitionSeconds > 0 && story.length > 1) {
    story.forEach((segment, index) => {
      if (Number.isFinite(segment?.durationSeconds) && segment.durationSeconds <= transitionSeconds) {
        errors.push(`story[${index}].durationSeconds must exceed the crossfade transition`);
      }
    });
    for (let index = 1; index < story.length; index += 1) {
      if (story[index - 1]?.type === "mobile" && story[index]?.type === "mobile") {
        errors.push("consecutive mobile story scenes require a zero transition");
        break;
      }
    }
  }
  const durationSeconds = composedDurationSeconds(story, transitionMilliseconds);

  if (!Array.isArray(scenario.captions)) errors.push("captions must be an array");
  else {
    const malformedCaption = scenario.captions.findIndex((caption) => !isObject(caption));
    if (malformedCaption >= 0) errors.push(`captions[${malformedCaption}] must be an object`);
    else errors.push(...validateCaptions(scenario.captions, durationSeconds, {
      profile: story.some((segment) => segment?.type === "mobile") ? "mobile" : "browser",
    }));
  }
  const authorsAndroidProject = Array.isArray(scenario.capture?.android?.setupActions)
    && scenario.capture.android.setupActions.some((action) => (
      action?.action === "fillFromEnvironment" && action.environment === "ACP_PROJECT"
    ));
  const requiresAcpProject = !includesMobile || authorsAndroidProject;
  if (!isObject(scenario.acp)) {
    if (requiresAcpProject) errors.push("acp must be an object with the authored project");
  } else if (/^[a-z][a-z0-9-]{2,57}$/.test(scenario.id ?? "")) {
    const expectedProject = expectedProjectName(scenario.id);
    if (scenario.acp.project !== expectedProject) errors.push(`acp.project must be ${expectedProject}`);
  }
  unknownKeys(scenario.acp, new Set(["project"]), "acp", errors);
  unknownKeys(scenario.canvas, new Set(["master", "derivative"]), "canvas", errors);
  unknownKeys(scenario.production, new Set(["title", "subtitle", "endTitle", "endText", "transitionMilliseconds", "silent"]), "production", errors);
  unknownKeys(scenario.extension, new Set(["expectedId", "actions"]), "extension", errors);
  const actions = Array.isArray(scenario.extension?.actions) ? scenario.extension.actions : [];
  for (const [index, action] of actions.entries()) {
    if (action?.action === "upload") {
      if (!isContainedRelativePath(action.path)) {
        errors.push(`extension.actions[${index}].path must stay inside the scenario directory`);
      }
    }
  }
  if (includesMobile) {
    if (scenario.layout?.preset !== "mobile-full") errors.push("mobile stories require layout.preset mobile-full");
    if (scenario.extension !== undefined) errors.push("mobile stories do not support extension configuration");
    const mobileSegments = story.filter((segment) => segment?.type === "mobile");
    const mobileDurationSeconds = mobileSegments.every((segment) => (
      typeof segment.durationSeconds === "number"
      && Number.isFinite(segment.durationSeconds)
      && segment.durationSeconds > 0
    ))
      ? mobileSegments.reduce((sum, segment) => sum + segment.durationSeconds, 0)
      : Number.NaN;
    if (Number.isFinite(mobileDurationSeconds) && mobileDurationSeconds > ANDROID_AUTHORED_CAPTURE_MAX_SECONDS) {
      errors.push(`mobile story duration must be no more than ${ANDROID_AUTHORED_CAPTURE_MAX_SECONDS} seconds`);
    }
    validateAndroidCapture(scenario.capture, errors);
  } else if (scenario.capture !== undefined) {
    errors.push("Android capture requires a mobile story segment");
    validateAndroidCapture(scenario.capture, errors);
  }
  if (!includesMobile && scenario.layout?.preset === "mobile-full") {
    errors.push("layout.preset mobile-full requires a mobile story segment");
  }
  if (!isObject(scenario.production) || scenario.production.silent !== true) errors.push("production.silent must be true");
  if (!isObject(scenario.production) || !Number.isInteger(scenario.production.transitionMilliseconds) || scenario.production.transitionMilliseconds < 0 || scenario.production.transitionMilliseconds > 1000) errors.push("production.transitionMilliseconds must be an integer from 0 through 1000");

  let serializedInput = "";
  try {
    serializedInput = JSON.stringify(input);
  } catch {
    errors.push("scenario must contain only JSON-compatible values");
  }
  const secretFindings = findSecrets(serializedInput);
  if (secretFindings.length) errors.push("scenario contains credential-like material; use environment variables instead");
  const canCalculateLayouts = isObject(scenario.layout)
    && LAYOUT_PRESETS.includes(scenario.layout.preset)
    && (scenario.layout.preset !== "split" || (Number.isInteger(scenario.layout.leftPercent) && scenario.layout.leftPercent >= 30 && scenario.layout.leftPercent <= 70));
  return { valid: errors.length === 0, errors, scenario, durationSeconds, layouts: canCalculateLayouts ? layoutsForScenario(scenario) : undefined };
}

export async function loadScenario(scenarioPath) {
  const absolutePath = path.resolve(scenarioPath);
  const source = await readFile(absolutePath, "utf8");
  let parsed;
  try {
    parsed = path.extname(absolutePath).toLowerCase() === ".json" ? JSON.parse(source) : YAML.parse(source, { strict: true, uniqueKeys: true });
  } catch (error) {
    throw new Error(`Cannot parse ${absolutePath}: ${error.message}`);
  }
  const result = validateScenario(parsed);
  if (!result.valid) throw new Error(`Invalid scenario ${absolutePath}:\n- ${result.errors.join("\n- ")}`);
  const uploadErrors = await validateUploadActions(result.scenario, path.dirname(absolutePath));
  const assetErrors = await validateStoryAssets(result.scenario, path.dirname(absolutePath));
  const fileErrors = [...uploadErrors, ...assetErrors];
  if (fileErrors.length) throw new Error(`Invalid scenario ${absolutePath}:\n- ${fileErrors.join("\n- ")}`);
  return { ...result, path: absolutePath, source };
}

export async function validateStoryAssets(scenario, scenarioDirectory) {
  const errors = [];
  const scenarioRoot = await realpath(scenarioDirectory);
  const textExtensions = new Set([".json", ".yaml", ".yml", ".md", ".txt", ".tape", ".cast", ".html"]);
  const story = Array.isArray(scenario?.story) ? scenario.story : [];
  for (const [index, segment] of story.entries()) {
    if (!isObject(segment) || typeof segment.source !== "string" || segment.source.length === 0) continue;
    const label = `story[${index}].source`;
    try {
      const candidate = path.resolve(scenarioRoot, segment.source);
      if (candidate === scenarioRoot || !candidate.startsWith(`${scenarioRoot}${path.sep}`)) {
        errors.push(`${label} must stay inside the scenario directory`);
        continue;
      }
      const resolved = await realpath(candidate);
      if (!resolved.startsWith(`${scenarioRoot}${path.sep}`)) {
        errors.push(`${label} resolves outside the scenario directory`);
        continue;
      }
      const details = await stat(resolved);
      if (!details.isFile()) {
        errors.push(`${label} must reference a file`);
        continue;
      }
      if (textExtensions.has(path.extname(resolved).toLowerCase())) {
        if (details.size > 2 * 1024 * 1024) {
          errors.push(`${label} text input exceeds 2 MiB`);
          continue;
        }
        const contents = await readFile(resolved, "utf8");
        if (findSecrets(contents).length) errors.push(`${label} contains credential-like material`);
      }
    } catch (error) {
      errors.push(`${label} cannot be read: ${error.code === "ENOENT" ? "file not found" : error.message}`);
    }
  }
  return errors;
}

export async function validateUploadActions(scenario, scenarioDirectory) {
  const errors = [];
  const scenarioRoot = await realpath(scenarioDirectory);
  const actions = Array.isArray(scenario?.extension?.actions) ? scenario.extension.actions : [];
  for (const [index, action] of actions.entries()) {
    if (!isObject(action) || action.action !== "upload" || typeof action.path !== "string") continue;
    const label = `extension.actions[${index}].path`;
    try {
      const candidate = path.resolve(scenarioRoot, action.path);
      if (candidate === scenarioRoot || !candidate.startsWith(`${scenarioRoot}${path.sep}`)) {
        errors.push(`${label} must stay inside the scenario directory`);
        continue;
      }
      const resolved = await realpath(candidate);
      if (!resolved.startsWith(`${scenarioRoot}${path.sep}`)) {
        errors.push(`${label} resolves outside the scenario directory`);
        continue;
      }
      const details = await stat(resolved);
      if (!details.isFile() || details.size > 64 * 1024) {
        errors.push(`${label} must reference a file no larger than 64 KiB`);
        continue;
      }
      const contents = await readFile(resolved, "utf8");
      let sensitiveFields = [];
      if (path.extname(resolved).toLowerCase() === ".json") {
        try { sensitiveFields = findSensitiveFields(JSON.parse(contents)); } catch { /* The consumer reports format errors. */ }
      }
      if (findSecrets(contents).length || sensitiveFields.length) errors.push(`${label} contains credential-like material`);
    } catch (error) {
      errors.push(`${label} cannot be read: ${error.code === "ENOENT" ? "file not found" : error.message}`);
    }
  }
  return errors;
}
