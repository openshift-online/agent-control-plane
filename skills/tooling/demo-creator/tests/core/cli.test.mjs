import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.resolve(here, "../../scripts/demo.mjs");

test("the package test command recursively includes nested adapter suites", async () => {
  const packageJson = JSON.parse(await readFile(path.resolve(here, "../../scripts/package.json"), "utf8"));
  assert.equal(packageJson.scripts.test, "node --test '../tests/**/*.test.mjs'");
});

test("demo init creates a valid scenario without overwriting it", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "demo-cli-"));
  const destination = path.join(directory, "my-demo");
  try {
    const { stdout } = await execFileAsync(process.execPath, [cli, "init", destination, "--json"]);
    const result = JSON.parse(stdout);
    const source = await readFile(result.scenarioPath, "utf8");
    assert.match(source, /id: my-demo/);
    assert.match(source, /title: My Demo/);
    assert.match(source, /subtitle: A repeatable native browser-extension demo\./);
    assert.match(source, /endTitle: Demo complete/);
    assert.match(source, /endText: The workflow is ready to repeat\./);
    assert.match(source, /type: browser\n    durationSeconds: 8/);
    assert.doesNotMatch(source, /keepProject|titleSeconds|\n  endSeconds:/);
    await assert.rejects(() => execFileAsync(process.execPath, [cli, "init", destination]), /Refusing to overwrite/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("demo help exposes the six stable commands", async () => {
  const { stdout } = await execFileAsync(process.execPath, [cli, "--help"]);
  for (const command of ["doctor", "init", "capture", "compose", "validate", "run"]) assert.match(stdout, new RegExp(command));
  assert.match(stdout, /doctor \[scenario\]\s+Check local production prerequisites/);
  assert.match(stdout, /--keep-project\s+Record explicit retention after project safety checks/);
});

test("demo validate fails when composed media is absent", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "demo-validate-"));
  const scenario = path.resolve(here, "../../examples/browser-full/scenario.yaml");
  try {
    await assert.rejects(
      () => execFileAsync(process.execPath, [cli, "validate", scenario, "--output", directory, "--json"]),
      /Validation requires composed 1080p and 720p media/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
