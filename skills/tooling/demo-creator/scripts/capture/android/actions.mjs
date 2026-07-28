import { setTimeout as delay } from "node:timers/promises";
import { findSecrets } from "../../core/security.mjs";
import {
  ANDROID_RESOURCE_ID_MAX_CHARACTERS,
  isAndroidResourceId,
} from "../../core/android-contract.mjs";

export const ANDROID_ACTION_SETTLING_MILLISECONDS = 900;
export const ANDROID_MIN_SELECTOR_TIMEOUT_MILLISECONDS = 100;
export const ANDROID_DEFAULT_SELECTOR_TIMEOUT_MILLISECONDS = 5_000;
export const ANDROID_MAX_SELECTOR_TIMEOUT_MILLISECONDS = 30_000;

const ANDROID_DEFAULT_POLL_INTERVAL_MILLISECONDS = 100;
const ANDROID_MIN_POLL_INTERVAL_MILLISECONDS = 10;
const ANDROID_MAX_POLL_INTERVAL_MILLISECONDS = 1_000;
const ANDROID_MAX_ACTIONS = 100;
const ANDROID_MAX_WAIT_MILLISECONDS = 10_000;
const ANDROID_MAX_SELECTOR_CHARACTERS = ANDROID_RESOURCE_ID_MAX_CHARACTERS;
const ANDROID_MAX_FILL_CHARACTERS = 500;
const ANDROID_MAX_UI_DUMP_BYTES = 2 * 1024 * 1024;
const ANDROID_MAX_UI_NODES = 10_000;
const ANDROID_MAX_ATTRIBUTE_CHARACTERS = 4_096;
const ANDROID_MAX_ATTRIBUTES_PER_NODE = 100;
const ANDROID_MAX_COORDINATE = 100_000;
const ANDROID_MUTATION_QUIESCENCE_GRACE_MILLISECONDS = 250;
const ANDROID_ENVIRONMENT_KEYS = new Set([
  "ACP_URL",
  "ACP_PROJECT",
  "ACP_BEARER_TOKEN",
]);
const ANDROID_RECORDED_ACTIONS = new Set(["wait", "expect", "tap", "fill", "back"]);
const ANDROID_SETUP_ACTIONS = new Set([...ANDROID_RECORDED_ACTIONS, "fillFromEnvironment"]);
const SELECTOR_ATTRIBUTE = Object.freeze({
  resourceId: "resource-id",
  text: "text",
  contentDescription: "content-desc",
});

class AndroidSecretInputError extends Error {}
class AndroidSetupUiExposureError extends Error {}

export function androidMutationQuiescenceUnproved(error) {
  if ((typeof error !== "object" || error === null) && typeof error !== "function") return false;
  const descriptor = Object.getOwnPropertyDescriptor(error, "androidMutationQuiescenceUnproved");
  if (descriptor === undefined) return false;
  if (
    descriptor.enumerable
    || descriptor.configurable
    || descriptor.writable
    || descriptor.value !== true
  ) throw new Error("Android mutation quiescence marker is not an exact static proof");
  return true;
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertExactKeys(value, expected, location) {
  const ownKeys = Reflect.ownKeys(value);
  const actual = ownKeys.filter((key) => typeof key === "string").sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== ownKeys.length
    || actual.length !== wanted.length
    || actual.some((key, index) => key !== wanted[index])
  ) {
    throw new Error(`${location} must contain only ${wanted.join(", ")}`);
  }
}

function validateSelector(selector, location) {
  if (!isObject(selector)) {
    throw new Error(`${location} must be an object`);
  }
  assertExactKeys(selector, ["by", "value"], location);
  if (!Object.hasOwn(SELECTOR_ATTRIBUTE, selector.by)) {
    throw new Error(`${location}.by must be resourceId, text, or contentDescription`);
  }
  if (
    typeof selector.value !== "string"
    || selector.value.length < 1
    || selector.value.length > ANDROID_MAX_SELECTOR_CHARACTERS
  ) {
    throw new Error(`${location}.value must contain 1-200 characters`);
  }
  if (selector.by === "resourceId" && !isAndroidResourceId(selector.value)) {
    throw new Error(`${location}.value must be a bounded Android resource ID`);
  }
}

function cloneSelector(selector) {
  return { by: selector.by, value: selector.value };
}

function validateAction(action, location, allowEnvironment) {
  if (!isObject(action)) {
    throw new Error(`${location} must be an object`);
  }
  const allowed = allowEnvironment ? ANDROID_SETUP_ACTIONS : ANDROID_RECORDED_ACTIONS;
  if (typeof action.action !== "string" || !allowed.has(action.action)) {
    if (!allowEnvironment && action.action === "fillFromEnvironment") {
      throw new Error(`${location}.fillFromEnvironment is allowed only during pre-recording`);
    }
    throw new Error(`${location}.action is invalid`);
  }

  if (action.action === "wait") {
    assertExactKeys(action, ["action", "ms"], location);
    if (
      !Number.isInteger(action.ms)
      || action.ms < 0
      || action.ms > ANDROID_MAX_WAIT_MILLISECONDS
    ) {
      throw new Error(`${location}.ms must be an integer from 0 through 10000`);
    }
    return { action: action.action, ms: action.ms };
  }

  if (action.action === "back") {
    assertExactKeys(action, ["action"], location);
    return { action: action.action };
  }

  if (action.action === "expect" || action.action === "tap") {
    assertExactKeys(action, ["action", "selector"], location);
    validateSelector(action.selector, `${location}.selector`);
    return { action: action.action, selector: cloneSelector(action.selector) };
  }

  if (action.action === "fill") {
    assertExactKeys(action, ["action", "selector", "value"], location);
    validateSelector(action.selector, `${location}.selector`);
    if (typeof action.value !== "string" || action.value.length > ANDROID_MAX_FILL_CHARACTERS) {
      throw new Error(`${location}.value must contain no more than 500 characters`);
    }
    if (findSecrets(action.value).length > 0) {
      throw new Error(`${location}.value contains credential-like material; use fillFromEnvironment during setup`);
    }
    return {
      action: action.action,
      selector: cloneSelector(action.selector),
      value: action.value,
    };
  }

  assertExactKeys(action, ["action", "environment", "selector"], location);
  validateSelector(action.selector, `${location}.selector`);
  if (typeof action.environment !== "string" || !ANDROID_ENVIRONMENT_KEYS.has(action.environment)) {
    throw new Error(`${location}.environment must be an approved ACP environment key`);
  }
  return {
    action: action.action,
    selector: cloneSelector(action.selector),
    environment: action.environment,
  };
}

function validateActionList(actions, location, allowEnvironment) {
  if (!Array.isArray(actions)) {
    throw new Error(`${location} must be an array`);
  }
  if (actions.length > ANDROID_MAX_ACTIONS) {
    throw new Error(`${location} must contain no more than 100 actions`);
  }
  return actions.map((action, index) => validateAction(
    action,
    `${location}[${index}]`,
    allowEnvironment,
  ));
}

export function validateAndroidActions(input = {}) {
  if (!isObject(input)) {
    throw new Error("Android actions input must be an object");
  }
  const extraKeys = Object.keys(input).filter((key) => !["setupActions", "actions"].includes(key));
  if (extraKeys.length > 0) {
    throw new Error(`Android actions input contains unsupported field ${extraKeys[0]}`);
  }
  return {
    setupActions: validateActionList(
      input.setupActions ?? [],
      "capture.android.setupActions",
      true,
    ),
    actions: validateActionList(
      input.actions ?? [],
      "capture.android.actions",
      false,
    ),
  };
}

function decodeXmlAttribute(value) {
  return value.replace(
    /&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);/giu,
    (entity) => {
      if (entity === "&amp;") return "&";
      if (entity === "&lt;") return "<";
      if (entity === "&gt;") return ">";
      if (entity === "&quot;") return "\"";
      if (entity === "&apos;") return "'";
      const hexadecimal = /^&#x([0-9a-f]+);$/iu.exec(entity);
      const decimal = /^&#(\d+);$/u.exec(entity);
      const codePoint = Number.parseInt(hexadecimal?.[1] ?? decimal?.[1] ?? "", hexadecimal ? 16 : 10);
      if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return entity;
      try {
        return String.fromCodePoint(codePoint);
      } catch {
        return entity;
      }
    },
  );
}

function parseBoundedAttributes(nodeSource) {
  const attributes = Object.create(null);
  const attributePattern = /(?:^|\s)(resource-id|text|content-desc|bounds)="([^"]*)"/gu;
  for (const match of nodeSource.matchAll(attributePattern)) {
    if (match[2].length > ANDROID_MAX_ATTRIBUTE_CHARACTERS) return undefined;
    attributes[match[1]] = decodeXmlAttribute(match[2]);
  }
  return attributes;
}

function parseBounds(value) {
  const match = /^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/u.exec(value ?? "");
  if (!match) return undefined;
  const [left, top, right, bottom] = match.slice(1).map(Number);
  if (
    [left, top, right, bottom].some((coordinate) => (
      !Number.isSafeInteger(coordinate) || coordinate > ANDROID_MAX_COORDINATE
    ))
    || left >= right
    || top >= bottom
  ) {
    return undefined;
  }
  return { left, top, right, bottom };
}

function setupValueRepresentations(value) {
  const json = JSON.stringify(value);
  const url = encodeURIComponent(value);
  const form = new URLSearchParams({ value }).toString().slice("value=".length);
  const base64 = Buffer.from(value, "utf8").toString("base64");
  const base64url = base64.replaceAll("+", "-").replaceAll("/", "_");
  return new Set([
    value,
    json,
    json.slice(1, -1),
    encodeURI(value),
    url,
    url.replace(/%[0-9A-F]{2}/gu, (escape) => escape.toLowerCase()),
    form,
    form.replace(/%[0-9A-F]{2}/gu, (escape) => escape.toLowerCase()),
    base64,
    base64.replace(/=+$/u, ""),
    base64url,
    base64url.replace(/=+$/u, ""),
  ]);
}

function boundedUiAttributeValues(uiDump) {
  if (
    typeof uiDump !== "string"
    || Buffer.byteLength(uiDump, "utf8") > ANDROID_MAX_UI_DUMP_BYTES
  ) throw new Error("invalid UI dump");

  const nodeStarts = uiDump.match(/<node\b/gu)?.length ?? 0;
  const nodePattern = /<node\b([^>]*)\/?\s*>/gu;
  const attributePattern = /\s+([A-Za-z_:][A-Za-z0-9_.:-]{0,127})="([^"]*)"/gu;
  const values = [];
  let nodes = 0;
  for (const node of uiDump.matchAll(nodePattern)) {
    nodes += 1;
    if (nodes > ANDROID_MAX_UI_NODES) throw new Error("too many UI nodes");
    let attributes = 0;
    for (const attribute of node[1].matchAll(attributePattern)) {
      attributes += 1;
      if (
        attributes > ANDROID_MAX_ATTRIBUTES_PER_NODE
        || attribute[2].length > ANDROID_MAX_ATTRIBUTE_CHARACTERS
      ) throw new Error("invalid UI attribute");
      values.push(decodeXmlAttribute(attribute[2]));
    }
    const remainder = node[1].replace(attributePattern, "").replace(/\/\s*$/u, "").trim();
    if (remainder !== "" || attributes === 0) throw new Error("invalid UI node");
  }
  if (
    nodes !== nodeStarts
    || !/<hierarchy\b[^>]*>/u.test(uiDump)
    || !/<\/hierarchy>/u.test(uiDump)
  ) throw new Error("invalid UI hierarchy");
  return values;
}

export async function auditAndroidSetupUiForSecrets(input) {
  try {
    if (!isObject(input)) throw new Error("invalid audit input");
    assertExactKeys(input, ["driver", "environment"], "Android setup UI audit input");
    if (!isObject(input.driver) || typeof input.driver.dumpUiHierarchy !== "function") {
      throw new Error("invalid audit driver");
    }
    if (!isObject(input.environment)) throw new Error("invalid audit environment");
    const environmentKeys = Reflect.ownKeys(input.environment);
    if (
      environmentKeys.some((key) => (
        typeof key !== "string" || !ANDROID_ENVIRONMENT_KEYS.has(key)
      ))
    ) throw new Error("invalid audit environment");

    const selectedValues = [];
    for (const key of environmentKeys) {
      if (key === "ACP_PROJECT") continue;
      const value = input.environment[key];
      if (
        typeof value !== "string"
        || value.length < 1
        || value.length > ANDROID_MAX_ATTRIBUTE_CHARACTERS
      ) throw new Error("invalid audit environment");
      selectedValues.push(value);
    }
    if (selectedValues.length === 0) return undefined;

    const options = validateExecutionOptions({
      driver: input.driver,
      phase: "pre-recording",
    });
    const uiDump = await callDriver(
      "setup UI audit",
      (signal) => input.driver.dumpUiHierarchy({ signal }),
      options,
    );
    const attributes = boundedUiAttributeValues(uiDump);
    for (const value of selectedValues) {
      for (const representation of setupValueRepresentations(value)) {
        if (uiDump.includes(representation) || attributes.some((attribute) => (
          attribute.includes(representation)
        ))) throw new AndroidSetupUiExposureError();
      }
    }
    return undefined;
  } catch (error) {
    if (androidMutationQuiescenceUnproved(error)) throw error;
    if (error instanceof AndroidSetupUiExposureError) {
      throw new Error("Android setup UI audit detected exposed configured input");
    }
    throw new Error("Android setup UI audit could not prove configured inputs are hidden");
  }
}

export function findAndroidSelectorInUiDump(uiDump, selector) {
  validateSelector(selector, "Android selector");
  if (typeof uiDump !== "string") {
    throw new Error("UIAutomator dump must be a string");
  }
  if (Buffer.byteLength(uiDump, "utf8") > ANDROID_MAX_UI_DUMP_BYTES) {
    throw new Error(`UIAutomator dump exceeds ${ANDROID_MAX_UI_DUMP_BYTES} bytes`);
  }

  const attributeName = SELECTOR_ATTRIBUTE[selector.by];
  const nodePattern = /<node\b([^>]*)\/?\s*>/gu;
  let examined = 0;
  let selected;
  for (const match of uiDump.matchAll(nodePattern)) {
    examined += 1;
    if (examined > ANDROID_MAX_UI_NODES) {
      throw new Error(`UIAutomator dump exceeds ${ANDROID_MAX_UI_NODES} nodes`);
    }
    const attributes = parseBoundedAttributes(match[1]);
    if (!attributes || attributes[attributeName] !== selector.value) continue;
    const bounds = parseBounds(attributes.bounds);
    if (!bounds) continue;
    if (selected) {
      throw new Error("Android selector matched more than one bounded node");
    }
    selected = {
      bounds,
      x: Math.floor((bounds.left + bounds.right) / 2),
      y: Math.floor((bounds.top + bounds.bottom) / 2),
    };
  }
  return selected;
}

function validateExecutionOptions(options) {
  if (!isObject(options)) throw new Error("Android action execution options must be an object");
  if (options.phase !== "pre-recording" && options.phase !== "recording") {
    throw new Error("Android action phase must be pre-recording or recording");
  }
  if (!isObject(options.driver)) throw new Error("Android action execution requires a driver");

  const selectorTimeoutMilliseconds = options.selectorTimeoutMilliseconds
    ?? ANDROID_DEFAULT_SELECTOR_TIMEOUT_MILLISECONDS;
  if (
    !Number.isInteger(selectorTimeoutMilliseconds)
    || selectorTimeoutMilliseconds < ANDROID_MIN_SELECTOR_TIMEOUT_MILLISECONDS
    || selectorTimeoutMilliseconds > ANDROID_MAX_SELECTOR_TIMEOUT_MILLISECONDS
  ) {
    throw new Error("selectorTimeoutMilliseconds must be an integer from 100 through 30000");
  }
  const pollIntervalMilliseconds = options.pollIntervalMilliseconds
    ?? ANDROID_DEFAULT_POLL_INTERVAL_MILLISECONDS;
  if (
    !Number.isInteger(pollIntervalMilliseconds)
    || pollIntervalMilliseconds < ANDROID_MIN_POLL_INTERVAL_MILLISECONDS
    || pollIntervalMilliseconds > ANDROID_MAX_POLL_INTERVAL_MILLISECONDS
    || pollIntervalMilliseconds > selectorTimeoutMilliseconds
  ) {
    throw new Error("pollIntervalMilliseconds must be an integer from 10 through 1000 and no greater than the selector timeout");
  }
  const nowMilliseconds = options.nowMilliseconds ?? (() => performance.now());
  const sleep = options.sleep ?? delay;
  if (typeof nowMilliseconds !== "function" || typeof sleep !== "function") {
    throw new Error("Android action execution requires callable clock and sleep functions");
  }
  const now = nowMilliseconds();
  if (!Number.isFinite(now) || now < 0) {
    throw new Error("Android action clock must return a finite nonnegative millisecond value");
  }
  if (options.phase === "recording") {
    if (
      !Number.isFinite(options.deadlineMilliseconds)
      || options.deadlineMilliseconds <= now
    ) {
      throw new Error("recorded Android actions require a future absolute deadlineMilliseconds");
    }
  }
  if (options.recordPointer !== undefined && typeof options.recordPointer !== "function") {
    throw new Error("recordPointer must be callable");
  }
  if (options.logger !== undefined && typeof options.logger !== "function") {
    throw new Error("logger must be callable");
  }
  return {
    ...options,
    selectorTimeoutMilliseconds,
    pollIntervalMilliseconds,
    nowMilliseconds,
    sleep,
  };
}

function readNow(options) {
  const value = options.nowMilliseconds();
  if (!Number.isFinite(value) || value < 0) {
    throw new Error("Android action clock must return a finite nonnegative millisecond value");
  }
  return value;
}

function assertRecordingBudget(options, activity) {
  if (
    options.phase === "recording"
    && readNow(options) >= options.deadlineMilliseconds
  ) {
    throw new Error(`Android recording budget was exhausted during ${activity}`);
  }
}

async function sleepWithinBudget(milliseconds, options, activity) {
  const now = readNow(options);
  if (
    options.phase === "recording"
    && now + milliseconds >= options.deadlineMilliseconds
  ) {
    throw new Error(`Android recording budget cannot fit ${activity}`);
  }
  await options.sleep(milliseconds);
  assertRecordingBudget(options, activity);
}

function driverTimeoutMilliseconds(options, maximumMilliseconds) {
  let timeoutMilliseconds = Math.max(
    1,
    Math.min(options.selectorTimeoutMilliseconds, Math.floor(maximumMilliseconds)),
  );
  if (options.phase !== "recording") return timeoutMilliseconds;
  const remaining = options.deadlineMilliseconds - readNow(options);
  if (remaining <= 0) {
    throw new Error(`Android recording budget was exhausted during driver operation`);
  }
  timeoutMilliseconds = Math.min(timeoutMilliseconds, Math.max(1, Math.floor(remaining)));
  return timeoutMilliseconds;
}

async function callDriver(
  operation,
  callback,
  options,
  maximumMilliseconds = options.selectorTimeoutMilliseconds,
) {
  const timeoutMilliseconds = driverTimeoutMilliseconds(options, maximumMilliseconds);
  const controller = new AbortController();
  let timeoutTimer;
  let quiescenceTimer;
  const timeout = new Promise((resolve) => {
    timeoutTimer = setTimeout(() => resolve({ state: "timed-out" }), timeoutMilliseconds);
  });
  const invocation = Promise.resolve()
    .then(() => callback(controller.signal))
    .catch((error) => {
      if (androidMutationQuiescenceUnproved(error)) throw error;
      if (error instanceof AndroidSecretInputError) throw error;
      throw new Error(`Android ${operation} failed`);
    });
  const settledInvocation = invocation.then(
    (value) => ({ state: "fulfilled", value }),
    (error) => ({ state: "rejected", error }),
  );
  try {
    const first = await Promise.race([settledInvocation, timeout]);
    if (first.state === "fulfilled") return first.value;
    if (first.state === "rejected") throw first.error;

    controller.abort();
    const quiescence = await Promise.race([
      settledInvocation,
      new Promise((resolve) => {
        quiescenceTimer = setTimeout(
          () => resolve({ state: "quiescence-unproved" }),
          ANDROID_MUTATION_QUIESCENCE_GRACE_MILLISECONDS,
        );
      }),
    ]);
    if (quiescence.state === "quiescence-unproved") {
      const error = new Error(
        `Android ${operation} timed out after ${timeoutMilliseconds}ms; mutation quiescence could not be proven`,
      );
      Object.defineProperty(error, "androidMutationQuiescenceUnproved", {
        value: true,
        enumerable: false,
        configurable: false,
        writable: false,
      });
      throw error;
    }
    if (
      quiescence.state === "rejected"
      && androidMutationQuiescenceUnproved(quiescence.error)
    ) {
      throw quiescence.error;
    }
    throw new Error(`Android ${operation} timed out after ${timeoutMilliseconds}ms`);
  } finally {
    clearTimeout(timeoutTimer);
    clearTimeout(quiescenceTimer);
  }
}

async function waitForSelector(selector, options) {
  if (typeof options.driver.dumpUiHierarchy !== "function") {
    throw new Error("Android selector actions require driver.dumpUiHierarchy");
  }
  const startedAt = readNow(options);
  const timeoutAt = startedAt + options.selectorTimeoutMilliseconds;
  const maximumAttempts = Math.ceil(
    options.selectorTimeoutMilliseconds / options.pollIntervalMilliseconds,
  );

  for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
    assertRecordingBudget(options, "selector lookup");
    if (readNow(options) >= timeoutAt) break;
    const uiDump = await callDriver(
      "UI hierarchy dump",
      (signal) => options.driver.dumpUiHierarchy({ signal }),
      options,
      timeoutAt - readNow(options),
    );
    assertRecordingBudget(options, "selector lookup");
    const match = findAndroidSelectorInUiDump(uiDump, selector);
    if (match) return match;

    const remaining = timeoutAt - readNow(options);
    if (remaining <= 0) break;
    await sleepWithinBudget(
      Math.min(options.pollIntervalMilliseconds, remaining),
      options,
      "selector polling",
    );
  }
  throw new Error(`Android selector was not found within ${options.selectorTimeoutMilliseconds}ms`);
}

function requireDriverMethod(driver, method, action) {
  if (typeof driver[method] !== "function") {
    throw new Error(`Android ${action} action requires driver.${method}`);
  }
}

async function fillFromEnvironmentViaStdin({
  driver,
  position,
  environmentName,
  environment = process.env,
  signal,
} = {}) {
  if (!isObject(driver) || typeof driver.openSecretInput !== "function") {
    throw new AndroidSecretInputError("Android secret input requires driver.openSecretInput");
  }
  if (!isObject(position) || !Number.isInteger(position.x) || !Number.isInteger(position.y)) {
    throw new AndroidSecretInputError("Android secret input requires integer coordinates");
  }
  if (!ANDROID_ENVIRONMENT_KEYS.has(environmentName)) {
    throw new AndroidSecretInputError("Android secret input requires an approved ACP environment key");
  }
  let secret;
  try {
    secret = environment?.[environmentName];
  } catch {
    throw new AndroidSecretInputError("Android secret input could not read configured environment");
  }
  if (typeof secret !== "string" || secret.length === 0) {
    throw new AndroidSecretInputError(`Android secret input requires configured environment ${environmentName}`);
  }

  let channel;
  try {
    channel = await driver.openSecretInput({
      x: position.x,
      y: position.y,
      environmentName,
    }, { signal });
  } catch {
    throw new AndroidSecretInputError("Android secret input failed to open its private stdin channel");
  }
  let stdin;
  let completed;
  try {
    assertExactKeys(channel, ["stdin", "completed"], "Android secret input channel");
    stdin = channel?.stdin;
    completed = channel?.completed;
    if (
      !isObject(channel)
      || !isObject(stdin)
      || typeof stdin.write !== "function"
      || typeof stdin.end !== "function"
      || !completed
      || typeof completed.then !== "function"
    ) throw new Error("invalid channel");
  } catch {
    throw new AndroidSecretInputError("Android secret input driver returned an invalid private stdin channel");
  }

  let destroyed = false;
  const destroy = () => {
    if (destroyed) return;
    destroyed = true;
    try {
      stdin.destroy?.();
    } catch {
      // Preserve the static, secret-free failure at the call site.
    }
  };
  if (signal?.aborted) {
    destroy();
    throw new AndroidSecretInputError("Android secret input was cancelled");
  }
  let abort;
  const aborted = signal && new Promise((_, reject) => {
    abort = () => {
      destroy();
      reject(new AndroidSecretInputError("Android secret input was cancelled"));
    };
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    stdin.write(secret);
    stdin.end();
    const completionResult = await (aborted ? Promise.race([completed, aborted]) : completed);
    if (completionResult !== undefined) {
      throw new AndroidSecretInputError("Android secret input completion must not return data");
    }
  } catch (error) {
    destroy();
    if (error instanceof AndroidSecretInputError) throw error;
    throw new AndroidSecretInputError("Android secret input failed");
  } finally {
    if (abort) signal.removeEventListener("abort", abort);
  }
}

async function executeAction(action, options) {
  if (action.action === "wait") {
    await sleepWithinBudget(action.ms, options, "authored wait");
    return;
  }
  if (action.action === "back") {
    requireDriverMethod(options.driver, "back", action.action);
    await callDriver("back", (signal) => options.driver.back({ signal }), options);
    assertRecordingBudget(options, "back action");
    return;
  }

  const position = await waitForSelector(action.selector, options);
  if (action.action === "expect") return;

  if (action.action === "tap") {
    requireDriverMethod(options.driver, "tap", action.action);
    if (options.phase === "recording" && options.recordPointer) {
      const event = {
        type: "tap",
        monotonicSeconds: readNow(options) / 1_000,
        x: position.x,
        y: position.y,
      };
      await callDriver(
        "pointer recording",
        (signal) => options.recordPointer(event, { signal }),
        options,
      );
    }
    await callDriver(
      "tap",
      (signal) => options.driver.tap({ x: position.x, y: position.y }, { signal }),
      options,
    );
    assertRecordingBudget(options, "tap action");
    return;
  }

  if (action.action === "fill") {
    requireDriverMethod(options.driver, "fill", action.action);
    if (options.phase === "recording" && options.recordPointer) {
      const event = {
        type: "fill",
        monotonicSeconds: readNow(options) / 1_000,
        x: position.x,
        y: position.y,
      };
      await callDriver(
        "pointer recording",
        (signal) => options.recordPointer(event, { signal }),
        options,
      );
    }
    await callDriver(
      "fill",
      (signal) => options.driver.fill({
        x: position.x,
        y: position.y,
        value: action.value,
      }, { signal }),
      options,
    );
    assertRecordingBudget(options, "fill action");
    return;
  }

  await callDriver("secret input", (signal) => fillFromEnvironmentViaStdin({
    driver: options.driver,
    position,
    environmentName: action.environment,
    environment: options.environment,
    signal,
  }), options);
  assertRecordingBudget(options, "secret input action");
}

export async function executeAndroidActions(actionList, rawOptions = {}) {
  const options = validateExecutionOptions(rawOptions);
  if (
    options.phase === "recording"
    && Array.isArray(actionList)
    && actionList.some((action) => action?.action === "fillFromEnvironment")
  ) {
    throw new Error("Android fillFromEnvironment is allowed only during pre-recording");
  }
  const validated = options.phase === "pre-recording"
    ? validateAndroidActions({ setupActions: actionList, actions: [] }).setupActions
    : validateAndroidActions({ setupActions: [], actions: actionList }).actions;
  const completedActions = [];

  for (const [index, action] of validated.entries()) {
    assertRecordingBudget(options, `${action.action} action`);
    await executeAction(action, options);
    if (action.action !== "wait") {
      await sleepWithinBudget(
        ANDROID_ACTION_SETTLING_MILLISECONDS,
        options,
        "fixed post-action settle",
      );
    }
    completedActions.push(action.action);
    options.logger?.({
      event: "android-action-complete",
      phase: options.phase,
      index,
      action: action.action,
    });
  }

  return {
    phase: options.phase,
    completedActions,
    count: completedActions.length,
  };
}
