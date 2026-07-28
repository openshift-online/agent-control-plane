export const CALLER_SENSITIVE_ENVIRONMENT = new Set([
  "ACP_BEARER_TOKEN",
]);

/**
 * Build a subprocess environment that never carries caller credentials.
 *
 * Compose only spawns tools that transform media (ffmpeg/ffprobe/tesseract) or
 * inspect the host process table (ps); none of them need the caller's bearer
 * token, which is present in this process only so artifacts can be scanned for
 * it. This enforces the "pass credentials only to the process that needs them"
 * boundary. Scrubbing runs on the final merged environment, so a generic
 * override (e.g. {env: process.env}) can never reintroduce a sensitive value.
 */
export function sanitizedSubprocessEnvironment(base = process.env, overrides = {}) {
  const environment = { ...base, ...overrides };
  for (const name of CALLER_SENSITIVE_ENVIRONMENT) {
    delete environment[name];
  }
  return environment;
}

export function androidSetupSensitiveValues(scenario, environment = process.env) {
  if (scenario?.capture?.kind !== "android-emulator") return [];
  const names = [...new Set((scenario.capture.android?.setupActions ?? [])
    .filter((action) => action?.action === "fillFromEnvironment")
    .map((action) => action.environment)
    .filter((name) => CALLER_SENSITIVE_ENVIRONMENT.has(name)))];
  return names.map((name) => {
    const value = environment?.[name];
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`${name} is required for exact output secret scanning`);
    }
    return value;
  });
}
