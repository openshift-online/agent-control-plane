#!/usr/bin/env node
import { access, mkdir, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { findMediaTools, runDoctor, toolchainSnapshot } from "./core/doctor.mjs";
import { loadScenario } from "./core/scenario.mjs";
import { createOrVerifyManifest, mergeManifest, readManifest } from "./core/manifest.mjs";
import { expectedProjectName } from "./core/ownership.mjs";
import { scanFiles } from "./core/security.mjs";
import { readAcpEnvironment } from "./acp/client.mjs";
import { renderDoctor } from "./render/doctor.mjs";

function usage() {
  return `Usage: demo <command> [scenario] [options]

Commands:
  doctor [scenario]      Check local production prerequisites
  init <scenario>        Create a scenario directory
  capture <scenario>     Capture deterministic source media
  compose <scenario>     Compose 1080p and 720p deliverables
  validate <scenario>    Validate scenario, artifacts, and secret hygiene
  run <scenario>         Capture, compose, and validate

Options:
  --output <directory>   Override the scenario build directory
  --force                Replace a stale locked manifest
  --keep-project         Record explicit retention after project safety checks
  --json                  Emit machine-readable output
`;
}

function parseArguments(argv) {
  const [command, ...rest] = argv;
  const options = { force: false, keepProject: false, json: false };
  const positional = [];
  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index];
    if (value === "--force") options.force = true;
    else if (value === "--keep-project") options.keepProject = true;
    else if (value === "--json") options.json = true;
    else if (value === "--output") {
      if (!rest[index + 1]) throw new Error("--output requires a directory");
      options.output = rest[++index];
    } else if (value.startsWith("--")) throw new Error(`Unknown option: ${value}`);
    else positional.push(value);
  }
  return { command, scenarioArgument: positional[0], options };
}

async function exists(target) {
  try { await access(target); return true; } catch { return false; }
}

async function resolveScenarioPath(argument) {
  if (!argument) throw new Error("A scenario path is required");
  const resolved = path.resolve(argument);
  if ((await stat(resolved)).isDirectory()) {
    for (const name of ["scenario.yaml", "scenario.yml", "scenario.json"]) {
      const candidate = path.join(resolved, name);
      if (await exists(candidate)) return candidate;
    }
    throw new Error(`No scenario.yaml, scenario.yml, or scenario.json found in ${resolved}`);
  }
  return resolved;
}

function template(id) {
  const title = id.split("-").map((word) => word[0].toUpperCase() + word.slice(1)).join(" ");
  return {
    version: 1,
    id,
    title,
    fps: 30,
    canvas: { master: "1080p", derivative: "720p" },
    layout: { preset: "browser-full" },
    story: [
      { type: "title", durationSeconds: 3 },
      { type: "browser", durationSeconds: 8 },
      { type: "end", durationSeconds: 3 },
    ],
    captions: [{ startSeconds: 3, endSeconds: 7, text: "Open the pinned extension from the browser toolbar." }],
    acp: { project: expectedProjectName(id) },
    production: {
      title,
      subtitle: "A repeatable native browser-extension demo.",
      endTitle: "Demo complete",
      endText: "The workflow is ready to repeat.",
      transitionMilliseconds: 300,
      silent: true,
    },
  };
}

async function initScenario(argument) {
  if (!argument) throw new Error("init requires a scenario name or path");
  const isFile = [".yaml", ".yml", ".json"].includes(path.extname(argument));
  const destination = path.resolve(isFile ? argument : path.join(argument, "scenario.yaml"));
  if (await exists(destination)) throw new Error(`Refusing to overwrite ${destination}`);
  const id = path.basename(isFile ? destination : argument).replace(/\.(?:ya?ml|json)$/i, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  if (!/^[a-z][a-z0-9-]{2,57}$/.test(id)) throw new Error("Scenario name must resolve to a lowercase DNS-style id with 3-58 characters");
  await mkdir(path.dirname(destination), { recursive: true });
  const value = template(id);
  await writeFile(destination, path.extname(destination) === ".json" ? `${JSON.stringify(value, null, 2)}\n` : YAML.stringify(value), { flag: "wx" });
  return { scenarioPath: destination };
}

function requireCaptureEnvironment(scenario) {
  const config = readAcpEnvironment(process.env);
  if (config.project !== scenario.acp.project) throw new Error(`ACP_PROJECT must be ${scenario.acp.project} for this scenario`);
  return config;
}

async function scenarioContext(argument, options, { capture = false } = {}) {
  const scenarioPath = await resolveScenarioPath(argument);
  const loaded = await loadScenario(scenarioPath);
  const liveCapture = capture && process.env.DEMO_CAPTURE_DRY_RUN !== "1";
  const androidCapture = loaded.scenario.capture?.kind === "android-emulator";
  const acpConfig = liveCapture && !androidCapture ? requireCaptureEnvironment(loaded.scenario) : undefined;
  const scenarioDir = path.dirname(scenarioPath);
  const outputDir = path.resolve(options.output ?? path.join(scenarioDir, "build", loaded.scenario.id));
  const manifestPath = path.join(outputDir, "manifest.lock.json");
  let manifest = await createOrVerifyManifest(manifestPath, {
    scenario: loaded.scenario,
    source: loaded.source,
    scenarioPath,
    layouts: loaded.layouts,
    durationSeconds: loaded.durationSeconds,
  }, options);
  const mediaTools = await findMediaTools();
  manifest = await mergeManifest(manifestPath, { toolchain: await toolchainSnapshot(mediaTools) });
  return {
    scenario: loaded.scenario,
    scenarioPath,
    scenarioDir,
    outputDir,
    manifestPath,
    manifest,
    ...mediaTools,
    keepProject: options.keepProject,
    acp: acpConfig ? { url: acpConfig.baseUrl, project: acpConfig.project } : undefined,
    captureOptions: androidCapture ? { dryRun: !liveCapture } : undefined,
  };
}

async function callModule(relativePath, exportName, context) {
  const module = await import(new URL(relativePath, import.meta.url));
  if (typeof module[exportName] !== "function") throw new Error(`${relativePath} must export ${exportName}(context)`);
  const result = await module[exportName](context);
  if (result && typeof result === "object" && result.dryRun !== true) {
    context.manifest = await mergeManifest(context.manifestPath, result);
  }
  return result ?? {};
}

export async function doctor(argument, _options = {}, dependencies = {}) {
  const operations = {
    doctorCapture: dependencies.doctorCapture ?? (async (context) => {
      const captureModule = await import(new URL("./capture/index.mjs", import.meta.url));
      if (typeof captureModule.doctorCapture !== "function") return undefined;
      return captureModule.doctorCapture(context, dependencies.captureDoctorDependencies);
    }),
    loadScenario: dependencies.loadScenario ?? loadScenario,
    renderDoctor: dependencies.renderDoctor ?? renderDoctor,
    resolveScenarioPath: dependencies.resolveScenarioPath ?? resolveScenarioPath,
    runDoctor: dependencies.runDoctor ?? runDoctor,
  };
  let scenario;
  let scenarioPath;
  let scenarioDir;
  if (argument) {
    scenarioPath = await operations.resolveScenarioPath(argument);
    scenario = (await operations.loadScenario(scenarioPath)).scenario;
    scenarioDir = path.dirname(scenarioPath);
  }
  const captureKind = scenario?.capture?.kind ?? "browser-extension";
  const platform = dependencies.platform ?? process.platform;
  const result = await operations.runDoctor(platform, {
    captureKind,
    dependencies: dependencies.coreDoctorDependencies,
  });
  result.entryPoint = fileURLToPath(import.meta.url);
  if (captureKind === "android-emulator") {
    result.render = await operations.renderDoctor({ required: ["cards"] });
    result.ok = result.ok && result.render.ok;
  }
  const nativeCapture = await operations.doctorCapture({
    scenario,
    scenarioPath,
    scenarioDir,
    captureOptions: { dryRun: true },
  });
  if (nativeCapture) {
    result.nativeCapture = nativeCapture;
    result.ok = result.ok && result.nativeCapture.ok;
  }
  return result;
}

async function capture(argument, options) {
  const context = await scenarioContext(argument, options, { capture: true });
  const result = await callModule("./capture/index.mjs", "captureScenario", context);
  return { scenarioId: context.scenario.id, manifestPath: context.manifestPath, ...result };
}

async function compose(argument, options) {
  const context = await scenarioContext(argument, options);
  const result = await callModule("./compose/index.mjs", "composeScenario", context);
  return { scenarioId: context.scenario.id, manifestPath: context.manifestPath, ...result };
}

async function validate(argument, options) {
  const context = await scenarioContext(argument, options);
  const findings = await scanFiles(context.outputDir);
  if (findings.length) throw new Error(`Output security scan failed in ${findings.length} location(s)`);
  const composeModule = await import(new URL("./compose/index.mjs", import.meta.url));
  const manifest = await readManifest(context.manifestPath);
  const masterPath = manifest.composition?.master ?? manifest.artifacts?.masterVideo;
  const derivativePath = manifest.composition?.derivative ?? manifest.artifacts?.derivativeVideo;
  if (!masterPath || !derivativePath) {
    throw new Error("Validation requires composed 1080p and 720p media; run demo compose first");
  }
  if (typeof composeModule.validateMedia !== "function") throw new Error("The compose module does not provide media validation");
  const media = await composeModule.validateMedia({
    manifest,
    scenario: context.scenario,
    environment: process.env,
    masterPath,
    derivativePath,
    expectedDuration: manifest.composition?.durationSeconds ?? manifest.durationSeconds,
    ffprobe: context.ffprobe,
    scenarioDir: context.scenarioDir,
    outputDir: context.outputDir,
  });
  return { valid: true, scenarioId: context.scenario.id, manifestPath: context.manifestPath, secretFindings: 0, media };
}

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  const { command, scenarioArgument, options } = parseArguments(argv);
  if (!command || command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(usage());
    return;
  }
  let result;
  if (command === "doctor") result = await doctor(scenarioArgument, options, dependencies);
  else if (command === "init") result = await initScenario(scenarioArgument);
  else if (command === "capture") result = await capture(scenarioArgument, options);
  else if (command === "compose") result = await compose(scenarioArgument, options);
  else if (command === "validate") result = await validate(scenarioArgument, options);
  else if (command === "run") {
    const captured = await capture(scenarioArgument, options);
    const composed = await compose(scenarioArgument, options);
    const validated = await validate(scenarioArgument, options);
    result = { captured, composed, validated };
  } else throw new Error(`Unknown command: ${command}\n\n${usage()}`);
  process.stdout.write(`${JSON.stringify(result, null, options.json ? 0 : 2)}\n`);
  if (command === "doctor" && !result.ok) process.exitCode = 1;
}

async function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return await realpath(process.argv[1]) === await realpath(fileURLToPath(import.meta.url));
  } catch {
    return path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  }
}

if (await isMainModule()) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
