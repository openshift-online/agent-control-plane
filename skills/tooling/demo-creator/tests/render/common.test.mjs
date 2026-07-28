import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  chromeForTestingCandidates,
  explicitChromiumPathAllowed,
  formatCommand,
  parseArguments,
  positiveInteger,
  resolveChrome,
  runCommand,
  sanitizedInheritedEnv,
} from "../../scripts/render/common.mjs";

test("parseArguments supports flags, values, and positional arguments", () => {
  assert.deepEqual(parseArguments(["slides", "--dry-run", "--output-dir", "a b", "--width=1280"]), {
    _: ["slides"],
    dry_run: true,
    output_dir: "a b",
    width: "1280",
  });
});

test("positiveInteger rejects partial and non-positive values", () => {
  assert.equal(positiveInteger("1080", "height"), 1080);
  assert.throws(() => positiveInteger("1080px", "height"), /positive integer/);
  assert.throws(() => positiveInteger(0, "height"), /positive integer/);
});

test("formatCommand shell-quotes paths without executing them", () => {
  assert.equal(formatCommand("tool", ["plain", "two words", "it's"]), "tool plain 'two words' 'it'\"'\"'s'");
});

test("runCommand escalates TERM to KILL and rejects only after child exit", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "demo-command-timeout-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const pidPath = join(root, "pid");
  // The child must enter its signal handler before the timeout; media tests can
  // otherwise starve a 500 ms startup window on a loaded host.
  await assert.rejects(
    runCommand(process.execPath, [
      "-e",
      `require('fs').writeFileSync(${JSON.stringify(pidPath)},String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},1000)`,
    ], { timeoutMs: 2_000, killGraceMs: 50 }),
    /timed out after 2000ms/,
  );
  const pid = Number(await readFile(pidPath, "utf8"));
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});

test("runCommand timeout terminates a grandchild in the managed process group", { skip: process.platform === "win32" }, async (context) => {
  const root = await mkdtemp(join(tmpdir(), "demo-command-tree-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const pidPath = join(root, "grandchild-pid");
  const grandchildScript = "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)";
  const parentScript = [
    "const {spawn}=require('child_process')",
    `const child=spawn(process.execPath,['-e',${JSON.stringify(grandchildScript)}],{stdio:'ignore'})`,
    `require('fs').writeFileSync(${JSON.stringify(pidPath)},String(child.pid))`,
    "process.on('SIGTERM',()=>{})",
    "setInterval(()=>{},1000)",
  ].join(";");
  // Leave enough startup headroom for the parent to spawn the grandchild and
  // persist its PID even when media integration tests are loading the host.
  await assert.rejects(
    runCommand(process.execPath, ["-e", parentScript], { timeoutMs: 2_000, killGraceMs: 50 }),
    /timed out after 2000ms/,
  );
  const grandchildPid = Number(await readFile(pidPath, "utf8"));
  assert.throws(() => process.kill(grandchildPid, 0), { code: "ESRCH" });
});

test("runCommand keeps only a bounded tail of stdout and stderr", async () => {
  const result = await runCommand(process.execPath, [
    "-e",
    "process.stdout.write('a'.repeat(4096)+'stdout-tail');process.stderr.write('b'.repeat(4096)+'stderr-tail')",
  ], { outputLimitBytes: 64 });
  assert.equal(Buffer.byteLength(result.stdout), 64);
  assert.equal(Buffer.byteLength(result.stderr), 64);
  assert.equal(result.stdout.endsWith("stdout-tail"), true);
  assert.equal(result.stderr.endsWith("stderr-tail"), true);
  assert.equal(result.stdoutTruncated, true);
  assert.equal(result.stderrTruncated, true);
  assert.ok(result.stdoutBytes > 4_096);
  assert.ok(result.stderrBytes > 4_096);
});

test("runCommand can replace rather than inherit the host environment", async () => {
  const sentinelName = "ACP_RENDER_SENTINEL_SECRET";
  const previous = process.env[sentinelName];
  process.env[sentinelName] = "must-not-cross-process-boundary";
  try {
    const result = await runCommand(process.execPath, [
      "-e",
      `process.stdout.write(JSON.stringify({sentinel:process.env.${sentinelName},safe:process.env.SAFE_VALUE}))`,
    ], {
      env: { SAFE_VALUE: "allowed" },
      inheritEnv: false,
    });
    assert.deepEqual(JSON.parse(result.stdout), { safe: "allowed" });
    assert.doesNotMatch(result.stdout, /must-not-cross-process-boundary/);
  } finally {
    if (previous === undefined) delete process.env[sentinelName];
    else process.env[sentinelName] = previous;
  }
});

test("runCommand scrubs ACP_BEARER_TOKEN from the inherited environment but keeps other variables", async () => {
  const priorToken = Object.prototype.hasOwnProperty.call(process.env, "ACP_BEARER_TOKEN")
    ? process.env.ACP_BEARER_TOKEN
    : undefined;
  process.env.ACP_BEARER_TOKEN = "render-inheritance-sentinel";
  process.env.DEMO_RENDER_ENV_PROBE = "kept-value";
  try {
    const { stdout } = await runCommand(process.execPath, [
      "-e",
      "process.stdout.write(JSON.stringify({ token: process.env.ACP_BEARER_TOKEN ?? null, probe: process.env.DEMO_RENDER_ENV_PROBE ?? null }))",
    ]);
    const child = JSON.parse(stdout);
    assert.equal(child.token, null, "ACP_BEARER_TOKEN must not reach presenterm/ffmpeg/chrome subprocesses");
    assert.equal(child.probe, "kept-value", "non-sensitive environment must still be inherited");
  } finally {
    if (priorToken === undefined) delete process.env.ACP_BEARER_TOKEN;
    else process.env.ACP_BEARER_TOKEN = priorToken;
    delete process.env.DEMO_RENDER_ENV_PROBE;
  }
});

test("runCommand scrubs ACP_BEARER_TOKEN even when replacing the environment", async () => {
  // inheritEnv:false is a deliberate full replacement, but it must still never
  // deliver the caller credential to the child.
  const { stdout } = await runCommand(
    process.execPath,
    ["-e", "process.stdout.write(process.env.ACP_BEARER_TOKEN ?? '<absent>')"],
    { env: { ACP_BEARER_TOKEN: "replace-attempt", SAFE_VALUE: "allowed" }, inheritEnv: false },
  );
  assert.equal(stdout, "<absent>", "ACP_BEARER_TOKEN must not reach the subprocess in replace mode");
});

test("runCommand refuses to let a generic env override reintroduce ACP_BEARER_TOKEN", async () => {
  // Passing {env: process.env} (or any override still carrying the token) must
  // not deliver it to the child; scrubbing applies to the final merged env.
  const { stdout } = await runCommand(
    process.execPath,
    ["-e", "process.stdout.write(process.env.ACP_BEARER_TOKEN ?? '<absent>')"],
    { env: { ACP_BEARER_TOKEN: "override-attempt", SAFE_VALUE: "allowed" } },
  );
  assert.equal(stdout, "<absent>", "ACP_BEARER_TOKEN must not reach the subprocess via an override");
});

test("sanitizedInheritedEnv drops sensitive names, keeps the rest, and never mutates process.env", () => {
  const priorToken = Object.prototype.hasOwnProperty.call(process.env, "ACP_BEARER_TOKEN")
    ? process.env.ACP_BEARER_TOKEN
    : undefined;
  process.env.ACP_BEARER_TOKEN = "helper-sentinel";
  process.env.DEMO_RENDER_HELPER_PROBE = "kept";
  try {
    const scrubbed = sanitizedInheritedEnv();
    assert.equal("ACP_BEARER_TOKEN" in scrubbed, false, "sensitive names must be removed");
    assert.equal(scrubbed.DEMO_RENDER_HELPER_PROBE, "kept", "non-sensitive names must survive");
    assert.equal(
      "ACP_BEARER_TOKEN" in sanitizedInheritedEnv({ ACP_BEARER_TOKEN: "override" }),
      false,
      "a generic override must not reintroduce a sensitive name",
    );
    assert.equal("ACP_BEARER_TOKEN" in process.env, true, "process.env must not be mutated");
  } finally {
    if (priorToken === undefined) delete process.env.ACP_BEARER_TOKEN;
    else process.env.ACP_BEARER_TOKEN = priorToken;
    delete process.env.DEMO_RENDER_HELPER_PROBE;
  }
});

test("automatic browser discovery is limited to Chrome for Testing", () => {
  assert.deepEqual(chromeForTestingCandidates("darwin"), [
    "/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
  ]);
  assert.deepEqual(chromeForTestingCandidates("linux"), ["/usr/bin/google-chrome-for-testing"]);
  for (const candidate of [...chromeForTestingCandidates("darwin"), ...chromeForTestingCandidates("linux")]) {
    assert.doesNotMatch(candidate, /Google Chrome\.app|\/google-chrome$/);
  }
});

test("explicit browser selection accepts Chromium variants but rejects regular Chrome", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "demo-browser-policy-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const chromium = join(root, "chromium");
  const regularChrome = join(root, "Google Chrome");
  const { writeFile } = await import("node:fs/promises");
  await writeFile(chromium, "fixture");
  await writeFile(regularChrome, "fixture");

  assert.equal(explicitChromiumPathAllowed(chromium), true);
  assert.equal(await resolveChrome(chromium), chromium);
  assert.equal(explicitChromiumPathAllowed("/opt/chrome-for-testing/chrome-linux64/chrome"), true);
  assert.equal(explicitChromiumPathAllowed(regularChrome), false);
  await assert.rejects(resolveChrome(regularChrome), /Chrome for Testing.*Chromium/);
  assert.equal(explicitChromiumPathAllowed("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"), false);
});
