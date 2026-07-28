import { constants as fsConstants } from "node:fs";
import { execFile } from "node:child_process";
import { access, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { isAndroidLaunchActivity } from "../../core/android-contract.mjs";
import {
  ANDROID_ACTION_SETTLING_MILLISECONDS,
  validateAndroidActions,
} from "./actions.mjs";

const execFileAsync = promisify(execFile);
const SDK_TOOL_NAMES = Object.freeze([
  "adb",
  "emulator",
  "sdkmanager",
  "avdmanager",
  "apkanalyzer",
]);
const EXTERNAL_TOOL_NAMES = Object.freeze(["kind", "kubectl", "docker", "git", "make", "ffmpeg", "ffprobe"]);
const TOOL_ENVIRONMENT_KEYS = Object.freeze([
  "ANDROID_HOME",
  "ANDROID_SDK_ROOT",
  "HOME",
  "JAVA_HOME",
  "LANG",
  "LC_ALL",
  "PATH",
  "TEMP",
  "TMP",
  "TMPDIR",
]);
const VERSION_ARGUMENTS = Object.freeze({
  adb: ["version"],
  emulator: ["-version"],
  sdkmanager: ["--version"],
  avdmanager: ["--help"],
  apkanalyzer: ["--help"],
  kind: ["version"],
  kubectl: ["version", "--client=true", "--output=json"],
  docker: ["--version"],
  git: ["--version"],
  make: ["--version"],
  ffmpeg: ["-version"],
  ffprobe: ["-version"],
});

const defaultFilesystem = Object.freeze({ access, readdir, realpath, stat });
const ANDROID_APPLICATION_ID = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/u;
const ANDROID_SYSTEM_IMAGE = /^system-images;android-(?:[2-9][0-9]|[1-9][0-9]{2})(?:\.[0-9]+)?;(?:default|google_apis|google_apis_playstore|google_apis_ps16k);(?:arm64-v8a|x86_64)$/u;
const ANDROID_SDK_REVISION = /^[0-9]{1,6}(?:\.[0-9]{1,6}){0,3}$/u;

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function refuseUnknownKeys(value, allowed, location) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${location}.${key} is not supported`);
  }
}

function isCanonicalRepositoryReference(value) {
  if (typeof value !== "string" || value.length <= "repo:".length || value.length > 505) return false;
  if (!value.startsWith("repo:") || value.includes("\\") || value.includes("\0")) return false;
  const repositoryPath = value.slice("repo:".length);
  if (path.posix.isAbsolute(repositoryPath) || path.posix.normalize(repositoryPath) !== repositoryPath) return false;
  const segments = repositoryPath.split("/");
  return segments.every((segment) => /^[A-Za-z0-9._-]+$/u.test(segment) && segment !== "." && segment !== "..");
}

function validateAndroidConfig(config) {
  if (!isObject(config)) throw new Error("Android doctor config must be an object");
  refuseUnknownKeys(config, new Set(["kind", "cluster", "android"]), "config");
  if (config.kind !== "android-emulator") throw new Error("Android doctor config kind must be android-emulator");
  if (!isObject(config.cluster)) throw new Error("Android doctor cluster must be an object");
  refuseUnknownKeys(config.cluster, new Set(["kind"]), "config.cluster");
  if (config.cluster.kind !== "disposable-kind") {
    throw new Error("Android doctor cluster kind must be disposable-kind");
  }
  if (!isObject(config.android)) throw new Error("Android doctor android config must be an object");
  refuseUnknownKeys(config.android, new Set([
    "expectedApplicationId",
    "apk",
    "apkLock",
    "launchActivity",
    "systemImage",
    "actionSettlingMilliseconds",
    "setupActions",
    "actions",
  ]), "config.android");

  const android = config.android;
  if (typeof android.expectedApplicationId !== "string"
    || android.expectedApplicationId.length < 3
    || android.expectedApplicationId.length > 200
    || !ANDROID_APPLICATION_ID.test(android.expectedApplicationId)) {
    throw new Error("Android doctor expectedApplicationId is invalid");
  }
  if (!isCanonicalRepositoryReference(android.apk)) {
    throw new Error("Android doctor apk must be a canonical repo: reference");
  }
  if (!android.apk.endsWith(".apk")) {
    throw new Error("Android doctor apk must reference an .apk file");
  }
  if (!isCanonicalRepositoryReference(android.apkLock)) {
    throw new Error("Android doctor apkLock must be a canonical repo: reference");
  }
  if (!isAndroidLaunchActivity(android.launchActivity)) {
    throw new Error("Android doctor launchActivity is invalid");
  }
  const componentParts = android.launchActivity.split("/");
  if (componentParts.length !== 2
    || !ANDROID_APPLICATION_ID.test(componentParts[0])) {
    throw new Error("Android doctor launchActivity must be a bounded Android component");
  }
  if (componentParts[0] !== android.expectedApplicationId) {
    throw new Error("Android doctor launchActivity package must match expectedApplicationId");
  }
  if (typeof android.systemImage !== "string" || !ANDROID_SYSTEM_IMAGE.test(android.systemImage)) {
    throw new Error("Android doctor systemImage is invalid");
  }
  if (android.actionSettlingMilliseconds !== undefined
    && android.actionSettlingMilliseconds !== ANDROID_ACTION_SETTLING_MILLISECONDS) {
    throw new Error(`Android doctor actionSettlingMilliseconds must be ${ANDROID_ACTION_SETTLING_MILLISECONDS}`);
  }
  if (!Array.isArray(android.actions)) throw new Error("Android doctor actions must be an array");
  validateAndroidActions({
    setupActions: android.setupActions ?? [],
    actions: android.actions,
  });
}

function sdkCandidates(name, sdkRoot) {
  if (name === "adb") return [path.join(sdkRoot, "platform-tools", "adb")];
  if (name === "emulator") return [path.join(sdkRoot, "emulator", "emulator")];
  return [
    path.join(sdkRoot, "cmdline-tools", "latest", "bin", name),
    path.join(sdkRoot, "cmdline-tools", "bin", name),
    path.join(sdkRoot, "tools", "bin", name),
  ];
}

async function defaultResolveExecutable(name, options = {}) {
  const filesystem = options.filesystem ?? defaultFilesystem;
  const candidates = options.sdkRoot
    ? sdkCandidates(name, options.sdkRoot)
    : (options.env?.PATH ?? process.env.PATH ?? "")
      .split(path.delimiter)
      .filter(Boolean)
      .map((entry) => path.join(entry, name));

  if (options.sdkRoot && !["adb", "emulator"].includes(name)) {
    try {
      const entries = await filesystem.readdir(path.join(options.sdkRoot, "cmdline-tools"), {
        withFileTypes: true,
      });
      const versionedCandidates = entries
        .filter((candidate) => candidate.name !== "latest" && (candidate.isDirectory() || candidate.isSymbolicLink()))
        .sort((left, right) => right.name.localeCompare(left.name, undefined, { numeric: true }))
        .map((entry) => path.join(options.sdkRoot, "cmdline-tools", entry.name, "bin", name));
      candidates.splice(1, 0, ...versionedCandidates);
    } catch {
      // Fixed SDK layout candidates are still checked below.
    }
  }

  for (const candidate of candidates) {
    try {
      const canonical = await filesystem.realpath(candidate);
      await filesystem.access(canonical, fsConstants.X_OK);
      return canonical;
    } catch {
      // Try the next bounded candidate.
    }
  }
  return undefined;
}

async function defaultRunCommand(executable, args, options = {}) {
  return execFileAsync(executable, args, options);
}

function outputText(result) {
  return `${String(result?.stdout ?? "")}\n${String(result?.stderr ?? "")}`.trim();
}

function uniqueMatchingLine(name, result, pattern) {
  const output = outputText(result);
  if (!output) throw new Error(`${name} identity output is empty`);
  const matches = [...new Set(output.split(/\r?\n/u).map((line) => line.trim()).filter((line) => pattern.test(line)))];
  if (matches.length !== 1) throw new Error(`${name} identity output is ambiguous`);
  return matches[0];
}

function cmdlineToolsVersion(result) {
  return uniqueMatchingLine(
    "sdkmanager",
    result,
    /^\d+(?:\.\d+)+(?:[-+._a-z0-9]*)?$/iu,
  );
}

function proveRunnable(name, result) {
  const output = outputText(result);
  if (!output) throw new Error(`${name} runnable proof output is empty`);
  const lines = output.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  const sameLine = new RegExp(`^Usage:\\s+${name}\\b`, "u");
  const commandLine = new RegExp(`^${name}\\b`, "u");
  const matches = lines.filter((line, index) => (
    sameLine.test(line)
    || (line === "Usage:" && commandLine.test(lines[index + 1] ?? ""))
  ));
  if (matches.length !== 1) throw new Error(`${name} runnable proof output is ambiguous`);
}

async function runRunnableProbe(name, executable, args, options, runCommand) {
  try {
    return await runCommand(executable, args, options);
  } catch (error) {
    const acceptedAvdmanagerHelp = name === "avdmanager"
      && error?.code === 1
      && error?.signal == null
      && String(error?.stderr ?? "").trim() === "";
    if (!acceptedAvdmanagerHelp) throw error;
    const result = { stdout: error.stdout, stderr: error.stderr };
    proveRunnable(name, result);
    return result;
  }
}

function commandIdentity(name, result) {
  if (name === "adb") {
    return uniqueMatchingLine(name, result, /^Android Debug Bridge version\s+\S.+$/u);
  }
  if (name === "emulator") {
    return uniqueMatchingLine(name, result, /^Android emulator version\s+\S.+$/u);
  }
  if (name === "kind") {
    return uniqueMatchingLine(name, result, /^kind\s+(?:version\s+)?v?\d+(?:\.\d+)+\S*(?:\s+.*)?$/iu);
  }
  if (name === "kubectl") {
    // kubectl emits warnings on stderr even on success, so rely on the exit
    // code (runCommand rejects on failure) and parse stdout for the identity.
    const stdout = String(result?.stdout ?? "").trim();
    if (!stdout) throw new Error("kubectl identity output is empty");
    try {
      const parsed = JSON.parse(stdout);
      const version = parsed?.clientVersion?.gitVersion;
      if (typeof version !== "string" || !/^v\d+(?:\.\d+)+\S*$/u.test(version)) throw new Error("invalid");
      return `kubectl ${version}`;
    } catch {
      throw new Error("kubectl identity output is ambiguous");
    }
  }
  if (name === "docker") {
    return uniqueMatchingLine(name, result, /^Docker version\s+\d+(?:\.\d+)+\S*(?:,\s+build\s+\S+)?$/u);
  }
  if (name === "git") {
    return uniqueMatchingLine(
      name,
      result,
      /^git version\s+\d+(?:\.\d+)+\S*(?: \([A-Za-z0-9](?:[A-Za-z0-9 ._-]{0,62}[A-Za-z0-9])?\))?$/u,
    );
  }
  if (name === "make") {
    return uniqueMatchingLine(name, result, /^GNU Make\s+\d+(?:\.\d+)+\S*$/u);
  }
  if (name === "ffmpeg") {
    return uniqueMatchingLine(name, result, /^ffmpeg version\s+\S.+$/u);
  }
  if (name === "ffprobe") {
    return uniqueMatchingLine(name, result, /^ffprobe version\s+\S.+$/u);
  }
  throw new Error(`unsupported Android doctor tool: ${name}`);
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function cmdlineToolsPackageRoot(sdkRoot, toolPath, name) {
  const binDirectory = path.dirname(toolPath);
  const packageRoot = path.dirname(binDirectory);
  const cmdlineToolsRoot = path.dirname(packageRoot);
  if (path.basename(toolPath) !== name
    || path.basename(binDirectory) !== "bin"
    || path.basename(cmdlineToolsRoot) !== "cmdline-tools"
    || path.dirname(cmdlineToolsRoot) !== sdkRoot) {
    throw new Error(`${name} must resolve inside one canonical cmdline-tools package root`);
  }
  return packageRoot;
}

async function canonicalSdkRoot(env, filesystem) {
  const requested = [env.ANDROID_SDK_ROOT, env.ANDROID_HOME]
    .filter((value) => typeof value === "string" && value.trim().length > 0);
  if (requested.length === 0) throw new Error("ANDROID_SDK_ROOT or ANDROID_HOME is required");
  let roots;
  try {
    roots = await Promise.all(requested.map((value) => filesystem.realpath(value)));
  } catch {
    throw new Error("Android SDK root does not exist");
  }
  if (new Set(roots).size !== 1) throw new Error("ANDROID_SDK_ROOT and ANDROID_HOME conflict");
  const root = roots[0];
  let info;
  try {
    info = await filesystem.stat(root);
  } catch {
    throw new Error("Android SDK root does not exist");
  }
  if (!info.isDirectory()) throw new Error("Android SDK root must be a directory");
  return root;
}

async function resolvedTool(name, { sdkRoot, env, filesystem, resolveExecutable }) {
  const requestedPath = await resolveExecutable(name, {
    ...(sdkRoot ? { sdkRoot } : {}),
    env,
    filesystem,
  });
  if (typeof requestedPath !== "string" || !path.isAbsolute(requestedPath)) {
    throw new Error(`required tool ${name} was not resolved to an absolute path`);
  }
  let canonicalPath;
  try {
    canonicalPath = await filesystem.realpath(requestedPath);
  } catch {
    throw new Error(`required tool ${name} does not exist`);
  }
  if (sdkRoot && path.normalize(requestedPath) !== canonicalPath) {
    throw new Error(`Android SDK tool ${name} path is not canonical`);
  }
  if (sdkRoot && !isInside(sdkRoot, canonicalPath)) {
    throw new Error(`Android SDK tool ${name} resolves outside the Android SDK root`);
  }
  let info;
  try {
    info = await filesystem.stat(canonicalPath);
  } catch {
    throw new Error(`required tool ${name} does not exist`);
  }
  if (!info.isFile()) throw new Error(`required tool ${name} is not a file`);
  try {
    await filesystem.access(canonicalPath, fsConstants.X_OK);
  } catch {
    throw new Error(`required tool ${name} is not executable`);
  }
  return canonicalPath;
}

function toolEnvironment(env, sdkRoot) {
  return Object.freeze(Object.fromEntries(
    TOOL_ENVIRONMENT_KEYS
      .filter((name) => typeof env[name] === "string")
      .map((name) => [
        name,
        name === "ANDROID_HOME" || name === "ANDROID_SDK_ROOT" ? sdkRoot : env[name],
      ]),
  ));
}

function installedSystemImageRevision(result, packageName) {
  const matches = String(result?.stdout ?? "")
    .split(/\r?\n/u)
    .map((line) => line.split("|").map((field) => field.trim()))
    .filter(([candidate]) => candidate === packageName);
  if (matches.length === 0) return undefined;
  const revisions = [...new Set(matches.map((fields) => fields[1]))];
  if (revisions.length !== 1) throw new Error("installed Android system image revision is ambiguous");
  const [revision] = revisions;
  if (typeof revision !== "string" || !ANDROID_SDK_REVISION.test(revision)) {
    throw new Error("installed Android system image revision is invalid");
  }
  return revision;
}

export async function doctorAndroid(config, deps = {}) {
  validateAndroidConfig(config);
  const env = deps.env ?? process.env;
  const filesystem = deps.filesystem ?? defaultFilesystem;
  const resolveExecutable = deps.resolveExecutable ?? defaultResolveExecutable;
  const runCommand = deps.runCommand ?? defaultRunCommand;
  const sdkRoot = await canonicalSdkRoot(env, filesystem);
  const commandEnvironment = toolEnvironment(env, sdkRoot);
  const tools = {};
  const sdkToolPaths = {};

  for (const name of SDK_TOOL_NAMES) {
    sdkToolPaths[name] = await resolvedTool(name, { sdkRoot, env, filesystem, resolveExecutable });
  }
  const cmdlinePackageRoot = cmdlineToolsPackageRoot(
    sdkRoot,
    sdkToolPaths.sdkmanager,
    "sdkmanager",
  );
  for (const name of ["avdmanager", "apkanalyzer"]) {
    if (cmdlineToolsPackageRoot(sdkRoot, sdkToolPaths[name], name) !== cmdlinePackageRoot) {
      throw new Error(`${name} must share the sdkmanager cmdline-tools package root`);
    }
  }

  for (const name of ["adb", "emulator"]) {
    const toolPath = sdkToolPaths[name];
    const identityResult = await runCommand(toolPath, VERSION_ARGUMENTS[name], {
      env: commandEnvironment,
      shell: false,
      timeout: 5000,
      maxBuffer: 4 * 1024 * 1024,
    });
    tools[name] = { path: toolPath, identity: commandIdentity(name, identityResult) };
  }
  const sdkmanagerResult = await runCommand(sdkToolPaths.sdkmanager, VERSION_ARGUMENTS.sdkmanager, {
    env: commandEnvironment,
    shell: false,
    timeout: 5000,
    maxBuffer: 4 * 1024 * 1024,
  });
  const cmdlineVersion = `cmdline-tools ${cmdlineToolsVersion(sdkmanagerResult)}`;
  tools.sdkmanager = {
    path: sdkToolPaths.sdkmanager,
    identity: "sdkmanager",
    version: cmdlineVersion,
  };
  for (const name of ["avdmanager", "apkanalyzer"]) {
    const runnableResult = await runRunnableProbe(name, sdkToolPaths[name], VERSION_ARGUMENTS[name], {
      env: commandEnvironment,
      shell: false,
      timeout: 5000,
      maxBuffer: 4 * 1024 * 1024,
    }, runCommand);
    proveRunnable(name, runnableResult);
    tools[name] = {
      path: sdkToolPaths[name],
      identity: name,
      version: cmdlineVersion,
    };
  }
  for (const name of EXTERNAL_TOOL_NAMES) {
    const toolPath = await resolvedTool(name, { env, filesystem, resolveExecutable });
    const identityResult = await runCommand(toolPath, VERSION_ARGUMENTS[name], {
      env: commandEnvironment,
      shell: false,
      timeout: 5000,
      maxBuffer: 4 * 1024 * 1024,
    });
    tools[name] = { path: toolPath, identity: commandIdentity(name, identityResult) };
  }

  const imageResult = await runCommand(tools.sdkmanager.path, ["--list_installed"], {
    env: commandEnvironment,
    shell: false,
    timeout: 15000,
    maxBuffer: 8 * 1024 * 1024,
  });
  const systemImageRevision = installedSystemImageRevision(imageResult, config.android.systemImage);
  if (systemImageRevision === undefined) {
    throw new Error(`required Android system image is not installed: ${config.android.systemImage}`);
  }

  return deepFreeze({
    ok: true,
    capture: {
      kind: config.kind,
      cluster: { kind: config.cluster.kind },
      android: {
        expectedApplicationId: config.android.expectedApplicationId,
        apk: config.android.apk,
        apkLock: config.android.apkLock,
        launchActivity: config.android.launchActivity,
        systemImage: config.android.systemImage,
        actionSettlingMilliseconds: config.android.actionSettlingMilliseconds ?? ANDROID_ACTION_SETTLING_MILLISECONDS,
        setupActionCount: config.android.setupActions?.length ?? 0,
        actionCount: config.android.actions.length,
      },
    },
    sdk: {
      root: sdkRoot,
      systemImage: {
        package: config.android.systemImage,
        revision: systemImageRevision,
        installed: true,
      },
    },
    tools,
  });
}
