import { execFile } from "node:child_process";
import * as defaultFs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_OUTPUT_BYTES = 1024 * 1024;
const TIMEOUT_MILLISECONDS = 60_000;

function exactAbsolute(value, label) {
  if (typeof value !== "string" || !path.isAbsolute(value) || path.resolve(value) !== value || value.includes("\0")) {
    throw new Error(`${label} must be one normalized absolute path`);
  }
  return value;
}

async function exactDirectory(fs, pathname, label, { privateMode = false } = {}) {
  const [canonical, details] = await Promise.all([fs.realpath(pathname), fs.lstat(pathname)]);
  if (canonical !== pathname || details.isSymbolicLink() || !details.isDirectory()) {
    throw new Error(`${label} must be one canonical directory`);
  }
  if (privateMode && (details.mode & 0o077) !== 0) {
    throw new Error(`${label} must be private`);
  }
}

async function exactExecutable(fs, pathname) {
  const executable = exactAbsolute(pathname, "gitPath");
  const [canonical, details] = await Promise.all([fs.realpath(executable), fs.lstat(executable)]);
  if (canonical !== executable || details.isSymbolicLink() || !details.isFile() || (details.mode & 0o111) === 0) {
    throw new Error("gitPath must be one canonical executable");
  }
  return executable;
}

function commandText(result, label) {
  const output = result?.stdout ?? result;
  if (typeof output !== "string" && !Buffer.isBuffer(output)) {
    throw new Error(`${label} did not return bounded stdout`);
  }
  const text = String(output);
  if (Buffer.byteLength(text, "utf8") > MAX_OUTPUT_BYTES) {
    throw new Error(`${label} output is too large`);
  }
  return text;
}

async function defaultRunCommand(executable, args, options) {
  return execFileAsync(executable, args, {
    encoding: "utf8",
    env: options.env,
    maxBuffer: options.maxOutputBytes,
    shell: false,
    timeout: options.timeoutMilliseconds,
  });
}

function gitOptions(environment) {
  return {
    env: environment,
    maxOutputBytes: MAX_OUTPUT_BYTES,
    shell: false,
    timeoutMilliseconds: TIMEOUT_MILLISECONDS,
  };
}

export async function prepareIsolatedKindWorkspace(input = {}, dependencies = {}) {
  const fs = dependencies.fs ?? defaultFs;
  const runCommand = dependencies.runCommand ?? defaultRunCommand;
  const repoRoot = exactAbsolute(input.repoRoot, "repoRoot");
  const runtimeRoot = exactAbsolute(input.runtimeRoot, "runtimeRoot");
  const expectedCommit = input.expectedCommit;
  if (typeof expectedCommit !== "string" || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(expectedCommit)) {
    throw new Error("expectedCommit must be one lowercase 40- or 64-character Git commit");
  }
  if (typeof runCommand !== "function") throw new Error("runCommand must be a function");
  await exactDirectory(fs, repoRoot, "repoRoot");
  await exactDirectory(fs, runtimeRoot, "runtimeRoot", { privateMode: true });
  const gitPath = await exactExecutable(fs, input.gitPath);
  const workspaceRoot = path.join(runtimeRoot, "kind-workspace");
  const environment = Object.freeze({
    ...(typeof dependencies.toolEnvironment?.PATH === "string"
      ? { PATH: dependencies.toolEnvironment.PATH }
      : {}),
  });
  const runGit = async (args, label) => commandText(
    await runCommand(gitPath, ["-C", repoRoot, ...args], gitOptions(environment)),
    label,
  );
  const assertCleanStableHead = async (phase) => {
    const head = (await runGit(["rev-parse", "HEAD"], `git HEAD ${phase}`)).trim();
    if (head !== expectedCommit) throw new Error(`Repository HEAD changed ${phase}`);
    const status = await runGit(
      ["status", "--porcelain=v1", "--untracked-files=all"],
      `git status ${phase}`,
    );
    if (status !== "") throw new Error(`Repository must be clean ${phase}`);
  };

  await assertCleanStableHead("before Kind workspace materialization");
  try {
    await fs.mkdir(workspaceRoot, { mode: 0o700 });
    await fs.chmod(workspaceRoot, 0o700);
    await runGit(
      ["checkout-index", "--all", "--force", `--prefix=${workspaceRoot}${path.sep}`],
      "git checkout-index",
    );
    await assertCleanStableHead("after Kind workspace materialization");
    await exactDirectory(fs, workspaceRoot, "Kind workspace", { privateMode: true });
    for (const relative of ["Makefile", "tests/infra/setup-kind.sh", "tests/infra/cleanup.sh"]) {
      const pathname = path.join(workspaceRoot, ...relative.split("/"));
      const details = await fs.lstat(pathname);
      if (details.isSymbolicLink() || !details.isFile()) {
        throw new Error(`Kind workspace is missing exact committed ${relative}`);
      }
    }
    return Object.freeze({ workspaceRoot, sourceCommit: expectedCommit });
  } catch (error) {
    await fs.rm(workspaceRoot, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}
