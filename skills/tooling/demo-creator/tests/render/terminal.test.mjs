import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { runCommand } from "../../scripts/render/common.mjs";
import { createPrivateVhsEnvironment, normalizedTape, renderTerminal } from "../../scripts/render/terminal.mjs";

test("normalizedTape owns output and visual dimensions", () => {
  const source = `Output stray.gif\nSet Width 99\nSet Framerate 60\nSet Theme \"Catppuccin\"\nType \"hello\"\nEnter\n`;
  const tape = normalizedTape(source, {
    output: "/private/output.mp4",
    width: 1266,
    height: 936,
    fps: 30,
    fontSize: 30,
  });
  assert.match(tape, /^Output "\/private\/output\.mp4"/);
  assert.match(tape, /Set Width 1266/);
  assert.match(tape, /Set Height 936/);
  assert.match(tape, /Set Framerate 30/);
  assert.match(tape, /Set FontSize 30/);
  assert.match(tape, /Set Shell bash/);
  assert.match(tape, /Hide\nType .*HISTFILE.*\nEnter\nShow/);
  assert.match(tape, /Type "hello"/);
  assert.doesNotMatch(tape, /stray\.gif|Width 99|Framerate 60|Catppuccin/);
});

test("terminal dry-run exposes VHS and FFmpeg commands", async () => {
  const plan = await renderTerminal({
    input: "fixtures/demo.tape",
    output: "build/terminal.mp4",
    width: 630,
    height: 936,
    dryRun: true,
  });
  assert.equal(plan.renderer, "vhs");
  assert.equal(plan.commands.length, 2);
  assert.match(plan.commands[0], /vhs/);
  assert.match(plan.commands[1], /ffmpeg/);
  assert.match(plan.commands[1], /scale=630:936/);
});

test("VHS receives only allowlisted variables backed by private run directories", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "demo-vhs-environment-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const sentinelName = "ACP_BEARER_TOKEN";
  const sentinelValue = "sentinel-secret-must-not-reach-vhs";
  const previous = process.env[sentinelName];
  process.env[sentinelName] = sentinelValue;
  try {
    const environment = await createPrivateVhsEnvironment(root, { path: "/usr/bin:/bin" });
    assert.deepEqual(Object.keys(environment).sort(), [
      "BASH_ENV",
      "ENV",
      "HISTFILE",
      "HOME",
      "LANG",
      "LC_ALL",
      "NO_COLOR",
      "PATH",
      "PROMPT_COMMAND",
      "PS1",
      "SHELL",
      "TMPDIR",
      "XDG_CACHE_HOME",
      "XDG_CONFIG_HOME",
      "XDG_DATA_HOME",
      "XDG_RUNTIME_DIR",
      "__CF_USER_TEXT_ENCODING",
    ]);
    assert.equal(sentinelName in environment, false);
    for (const name of ["HOME", "TMPDIR", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_RUNTIME_DIR"]) {
      assert.equal(relative(root, environment[name]).startsWith(".."), false, `${name} must stay inside the private run directory`);
      assert.equal((await stat(environment[name])).mode & 0o777, 0o700);
    }

    const child = await runCommand(process.execPath, ["-e", "process.stdout.write(JSON.stringify(process.env))"], {
      env: environment,
      inheritEnv: false,
    });
    const childEnvironment = JSON.parse(child.stdout);
    assert.equal(sentinelName in childEnvironment, false);
    assert.doesNotMatch(child.stdout, new RegExp(sentinelValue));
    assert.deepEqual(Object.keys(childEnvironment).sort(), Object.keys(environment).sort());
  } finally {
    if (previous === undefined) delete process.env[sentinelName];
    else process.env[sentinelName] = previous;
  }
});
