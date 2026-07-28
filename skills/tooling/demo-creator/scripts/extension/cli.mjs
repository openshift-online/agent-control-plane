#!/usr/bin/env node

import path from "node:path";

import {
  assertCaptureExtensionMatches,
  buildExtensionGate,
  verifyExtensionGate,
} from "./gate.mjs";

function usage() {
  return [
    "Usage:",
    "  node cli.mjs build --repo-root PATH --output PATH [--lock PATH]",
    "  node cli.mjs verify --repo-root PATH --lock PATH [--artifact PATH] [--extension-dir PATH]",
    "  node cli.mjs capture-check --repo-root PATH --lock PATH --extension-dir PATH",
  ].join("\n");
}

function parseArguments(argv) {
  const [command, ...tokens] = argv;
  if (!["build", "verify", "capture-check"].includes(command)) {
    throw new Error(usage());
  }
  const options = {};
  for (let index = 0; index < tokens.length; index += 2) {
    const flag = tokens[index];
    const value = tokens[index + 1];
    if (!flag?.startsWith("--") || value === undefined || value.startsWith("--")) {
      throw new Error(`invalid argument near ${flag ?? "end of command"}\n${usage()}`);
    }
    const name = flag.slice(2);
    if (!["repo-root", "output", "lock", "artifact", "extension-dir"].includes(name)) {
      throw new Error(`unknown option: ${flag}\n${usage()}`);
    }
    options[name] = path.resolve(value);
  }
  if (options["repo-root"] === undefined) {
    throw new Error(`--repo-root is required\n${usage()}`);
  }
  return { command, options };
}

async function main() {
  const { command, options } = parseArguments(process.argv.slice(2));
  if (command === "build") {
    if (options.output === undefined) {
      throw new Error(`--output is required\n${usage()}`);
    }
    const result = await buildExtensionGate({
      repoRoot: options["repo-root"],
      outputRoot: options.output,
      lockPath: options.lock,
    });
    process.stdout.write(
      `${JSON.stringify({
        extensionId: result.lock.extension.id,
        commit: result.lock.source.commit,
        sha256: result.lock.artifact.sha256,
        lockPath: result.lockPath,
        zipPath: result.zipPath,
        unpackedPath: result.unpackedPath,
      })}\n`,
    );
    return;
  }
  if (options.lock === undefined) {
    throw new Error(`--lock is required\n${usage()}`);
  }
  if (command === "verify") {
    const result = await verifyExtensionGate({
      repoRoot: options["repo-root"],
      lockPath: options.lock,
      artifactPath: options.artifact,
      unpackedPath: options["extension-dir"],
    });
    process.stdout.write(
      `${JSON.stringify({
        extensionId: result.lock.extension.id,
        commit: result.lock.source.commit,
        sha256: result.lock.artifact.sha256,
      })}\n`,
    );
    return;
  }
  if (options["extension-dir"] === undefined) {
    throw new Error(`--extension-dir is required\n${usage()}`);
  }
  const result = await assertCaptureExtensionMatches({
    repoRoot: options["repo-root"],
    lockPath: options.lock,
    extensionDir: options["extension-dir"],
  });
  process.stdout.write(
    `${JSON.stringify({
      extensionId: result.lock.extension.id,
      commit: result.lock.source.commit,
      sha256: result.lock.artifact.sha256,
      captureReady: true,
    })}\n`,
  );
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Extension package gate failed: ${message}\n`);
  process.exitCode = 1;
}
