import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";

export const DEFAULT_WIDTH = 1920;
export const DEFAULT_HEIGHT = 936;
export const DEFAULT_FPS = 30;
const DEFAULT_OUTPUT_LIMIT_BYTES = 1024 * 1024;
const MANAGED_PROCESS_GROUP = Symbol("managedProcessGroup");

// Credentials that live in this process only so rendered artifacts can be
// scanned for accidental leaks — never so a rendering subprocess (presenterm,
// ffmpeg, Chrome, `which`) can read them. Scrub them from any inherited
// environment. Mirrors compose's sanitizedSubprocessEnvironment so the
// credential boundary is uniform across the skill.
const CALLER_SENSITIVE_ENV = Object.freeze(["ACP_BEARER_TOKEN"]);

/**
 * Merge the inherited environment with explicit overrides, then remove caller
 * credentials from the result. Scrubbing runs last, so a generic override
 * (e.g. {env: process.env}) can never reintroduce a sensitive value. Never
 * mutates process.env.
 */
export function sanitizedInheritedEnv(overrides = {}) {
  const environment = { ...process.env, ...overrides };
  for (const name of CALLER_SENSITIVE_ENV) delete environment[name];
  return environment;
}

class BoundedTail {
  constructor(limitBytes) {
    this.limitBytes = limitBytes;
    this.buffers = [];
    this.length = 0;
    this.totalBytes = 0;
  }

  append(chunk) {
    const buffer = Buffer.from(chunk);
    this.totalBytes += buffer.length;
    if (buffer.length >= this.limitBytes) {
      this.buffers = [Buffer.from(buffer.subarray(buffer.length - this.limitBytes))];
      this.length = this.limitBytes;
      return;
    }
    this.buffers.push(buffer);
    this.length += buffer.length;
    while (this.length > this.limitBytes) {
      const overflow = this.length - this.limitBytes;
      const first = this.buffers[0];
      if (first.length <= overflow) {
        this.buffers.shift();
        this.length -= first.length;
      } else {
        this.buffers[0] = first.subarray(overflow);
        this.length -= overflow;
      }
    }
  }

  value() {
    return Buffer.concat(this.buffers, this.length).toString("utf8");
  }

  get truncated() {
    return this.totalBytes > this.limitBytes;
  }
}

export function spawnManaged(command, args, options = {}) {
  // A detached POSIX child leads an isolated process group on Linux and macOS,
  // so one negative-PID signal reaches its descendants as well as the leader.
  const detached = options.detached ?? process.platform !== "win32";
  const child = spawn(command, args, { ...options, detached });
  child[MANAGED_PROCESS_GROUP] = detached && process.platform !== "win32";
  return child;
}

function signalManagedTree(child, signal) {
  if (!child.pid) return false;
  if (child[MANAGED_PROCESS_GROUP]) {
    try {
      process.kill(-child.pid, signal);
      return true;
    } catch (error) {
      if (error.code !== "ESRCH" && error.code !== "EPERM") throw error;
    }
  }
  try {
    return child.kill(signal);
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}

function managedTreeAlive(child) {
  if (!child.pid) return false;
  const pid = child[MANAGED_PROCESS_GROUP] ? -child.pid : child.pid;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    if (error.code === "EPERM") return true;
    throw error;
  }
}

async function waitForManagedTree(child, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (managedTreeAlive(child) && Date.now() < deadline) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  return !managedTreeAlive(child);
}

export async function terminateProcessTree(child, options = {}) {
  const { graceMs = 2_000, killWaitMs = 1_000 } = options;
  if (!child.pid || !managedTreeAlive(child)) return;
  signalManagedTree(child, "SIGTERM");
  if (await waitForManagedTree(child, graceMs)) return;
  signalManagedTree(child, "SIGKILL");
  if (!(await waitForManagedTree(child, killWaitMs))) {
    throw new Error(`failed to terminate subprocess tree ${child.pid}`);
  }
}

export async function pathExists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function ensureParent(path) {
  await mkdir(dirname(path), { recursive: true });
}

export async function makePrivateTempDir(prefix = "demo-render-") {
  const path = await mkdtemp(join(tmpdir(), prefix));
  return path;
}

export async function withPrivateTempDir(prefix, operation) {
  const path = await makePrivateTempDir(prefix);
  try {
    return await operation(path);
  } finally {
    await rm(path, { recursive: true, force: true });
  }
}

export function positiveInteger(value, name) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || String(parsed) !== String(value)) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

export function parseArguments(argv) {
  const options = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      options._.push(token);
      continue;
    }
    const [rawKey, inlineValue] = token.slice(2).split("=", 2);
    const key = rawKey.replaceAll("-", "_");
    if (inlineValue !== undefined) {
      options[key] = inlineValue;
      continue;
    }
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      options[key] = next;
      index += 1;
    } else {
      options[key] = true;
    }
  }
  return options;
}

export function requiredOption(options, name) {
  const value = options[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`--${name.replaceAll("_", "-")} is required`);
  }
  return value;
}

export function formatCommand(command, args) {
  return [command, ...args].map(shellQuote).join(" ");
}

function shellQuote(value) {
  const string = String(value);
  if (/^[A-Za-z0-9_./:=+,-]+$/.test(string)) return string;
  return `'${string.replaceAll("'", `'"'"'`)}'`;
}

export async function runCommand(command, args, options = {}) {
  const {
    cwd,
    env,
    inheritEnv = true,
    stdin,
    timeoutMs = 120_000,
    killGraceMs = 2_000,
    outputLimitBytes = DEFAULT_OUTPUT_LIMIT_BYTES,
  } = options;
  if (!Number.isSafeInteger(outputLimitBytes) || outputLimitBytes <= 0) {
    throw new Error("outputLimitBytes must be a positive integer");
  }
  return await new Promise((resolve, reject) => {
    const childEnv = { ...(inheritEnv ? sanitizedInheritedEnv(env) : env) };
    for (const name of CALLER_SENSITIVE_ENV) delete childEnv[name];
    const child = spawnManaged(command, args, {
      cwd,
      env: childEnv,
      stdio: [stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    const stdout = new BoundedTail(outputLimitBytes);
    const stderr = new BoundedTail(outputLimitBytes);
    let spawnError;
    let timedOut = false;
    let terminationError;
    let terminationPromise = Promise.resolve();
    const timer = setTimeout(() => {
      timedOut = true;
      terminationPromise = terminateProcessTree(child, { graceMs: killGraceMs }).catch((error) => {
        terminationError = error;
      });
    }, timeoutMs);
    child.stdout.on("data", (chunk) => stdout.append(chunk));
    child.stderr.on("data", (chunk) => stderr.append(chunk));
    child.on("error", (error) => {
      spawnError = error;
    });
    child.on("close", async (code, signal) => {
      clearTimeout(timer);
      await terminationPromise;
      if (spawnError) {
        reject(spawnError);
        return;
      }
      const result = {
        code,
        signal,
        stdout: stdout.value(),
        stderr: stderr.value(),
        stdoutBytes: stdout.totalBytes,
        stderrBytes: stderr.totalBytes,
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
      };
      if (timedOut) {
        const cleanup = terminationError ? `; ${terminationError.message}` : "";
        reject(new Error(`${command} timed out after ${timeoutMs}ms${cleanup}`));
      } else if (code === 0) {
        resolve(result);
      } else {
        const detail = result.stderr.trim() || result.stdout.trim() || `signal ${signal ?? "unknown"}`;
        reject(new Error(`${command} exited with code ${code}: ${detail}`));
      }
    });
    if (stdin !== undefined) {
      child.stdin.on("error", (error) => {
        if (error.code !== "EPIPE") spawnError = spawnError ?? error;
      });
      child.stdin.end(stdin);
    }
  });
}

export async function resolveExecutable(name, explicitPath, candidates = []) {
  if (explicitPath) {
    if (!(await pathExists(explicitPath))) throw new Error(`${name} not found at ${explicitPath}`);
    return explicitPath;
  }
  for (const candidate of candidates) {
    if (candidate.includes("/") && (await pathExists(candidate))) return candidate;
  }
  try {
    const result = await runCommand("which", [name], { timeoutMs: 5_000 });
    const path = result.stdout.trim();
    if (path) return path;
  } catch {
    // The caller decides whether a missing optional tool is fatal.
  }
  return null;
}

export function chromeForTestingCandidates(platform = process.platform) {
  if (platform === "darwin") {
    return ["/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"];
  }
  if (platform === "linux") return ["/usr/bin/google-chrome-for-testing"];
  return [];
}

export function explicitChromiumPathAllowed(path) {
  const normalized = String(path).replaceAll("\\", "/").toLowerCase();
  const executable = normalized.split("/").at(-1);
  return normalized.includes("google chrome for testing.app/")
    || (executable === "chrome" && (
      normalized.includes("/chrome-for-testing/")
      || /\/chrome-linux(?:64)?\/chrome$/.test(normalized)
    ))
    || [
      "google chrome for testing",
      "google-chrome-for-testing",
      "chromium",
      "chromium-browser",
      "chrome-headless-shell",
      "chromium-headless-shell",
    ].includes(executable);
}

export async function resolveChrome(explicitPath = process.env.DEMO_CHROME_BIN) {
  const candidates = chromeForTestingCandidates();
  if (explicitPath) {
    if (!explicitChromiumPathAllowed(explicitPath)) {
      throw new Error("browser must be Chrome for Testing or an explicitly selected Chromium executable");
    }
    return await resolveExecutable("browser", explicitPath, candidates);
  }
  for (const candidate of candidates) {
    if (await pathExists(candidate)) return candidate;
  }
  const resolved = await resolveExecutable("google-chrome-for-testing");
  if (resolved) return resolved;
  return null;
}
