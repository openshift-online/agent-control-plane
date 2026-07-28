import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

import { prepareIsolatedKindWorkspace } from "../../../scripts/capture/android/kind-workspace.mjs";

const COMMIT = "c".repeat(40);
const execFileAsync = promisify(execFile);

test("repository Kind setup fails instead of adopting a reserved same-name cluster", async () => {
  const script = await readFile(new URL(
    "../../../../../../tests/infra/setup-kind.sh",
    import.meta.url,
  ), "utf8");
  const guard = script.indexOf("REQUIRE_NEW_KIND_CLUSTER");
  const adoption = script.indexOf("already exists — skipping creation");
  assert.ok(guard >= 0 && adoption > guard);
  assert.match(script.slice(guard, adoption), /Refusing to reuse pre-existing Kind cluster/);
});

test("repository Kind setup binds its proof to exact create events and one control-plane node", async () => {
  const script = await readFile(new URL(
    "../../../../../../tests/infra/setup-kind.sh",
    import.meta.url,
  ), "utf8");
  assert.match(script, /docker events[\s\S]+?event=create/);
  assert.match(script, /creation event[\s\S]+?final Docker container identit/i);
  assert.match(script, /proof_count[^\n]+-ne 1/);
  assert.match(script, /io\.x-k8s\.kind\.role[\s\S]+?control-plane/);
});

test("strict Kind setup rejects same-label creation races and publishes only the exact invocation", async (context) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "kind-create-exact-")));
  context.after(() => rm(root, { recursive: true, force: true }));
  const bin = path.join(root, "bin");
  await mkdir(bin, { recursive: true, mode: 0o700 });
  const setupPath = path.join(root, "setup-kind.sh");
  await writeFile(setupPath, await readFile(new URL(
    "../../../../../../tests/infra/setup-kind.sh",
    import.meta.url,
  ), "utf8"), { mode: 0o700 });
  await writeFile(path.join(bin, "kind"), `#!/bin/bash
set -eu
if [ "$1" = get ]; then exit 0; fi
if [ "$1" = create ]; then
  cat >/dev/null
  : > "$KIND_CREATE_MARKER"
  if [ "\${KIND_CREATE_BLOCK:-false}" = true ]; then
    trap 'exit 143' TERM INT
    while :; do sleep 1; done
  fi
  exit "\${KIND_CREATE_EXIT_CODE:-0}"
fi
exit 91
`, { mode: 0o700 });
  await writeFile(path.join(bin, "docker"), `#!/bin/bash
set -eu
case "$1" in
  events) printf '%s\\n' "$DOCKER_EVENTS" ;;
  ps)
    if [ -e "$KIND_CREATE_MARKER" ]; then
      container_ids="$FINAL_KIND_CONTAINER_IDS"
    else
      container_ids="\${PRE_KIND_CONTAINER_IDS:-}"
    fi
    [ -z "$container_ids" ] || printf '%s\\n' "$container_ids"
    ;;
  inspect)
    if [ "\${KIND_INSPECT_FAIL:-false}" = true ]; then exit 94; fi
    case "$3" in
      *.Name*) printf '/%s-control-plane\\n' "$KIND_CLUSTER_NAME" ;;
      *io.x-k8s.kind.cluster*) printf '%s\\n' "$KIND_CLUSTER_NAME" ;;
      *io.x-k8s.kind.role*) printf '%s\\n' "$KIND_NODE_ROLE" ;;
      *) exit 92 ;;
    esac
    ;;
  rm) printf 'docker %s\\n' "$*" >> "$DOCKER_COMMAND_LOG" ;;
  *) exit 93 ;;
esac
`, { mode: 0o700 });
  await writeFile(path.join(bin, "kubectl"), `#!/bin/bash
set -eu
printf 'kubectl %s\\n' "$*" >> "$DOCKER_COMMAND_LOG"
`, { mode: 0o700 });
  await writeFile(path.join(bin, "chmod"), `#!/bin/bash
set -eu
case "\${PROOF_CHMOD_BEHAVIOR:-pass}" in
  fail) exit 97 ;;
  interrupt)
    kill -TERM "$PPID"
    exit 98
    ;;
  race)
    printf 'competing-publisher\\n' > "$KIND_CREATION_PROOF_FILE"
    /bin/chmod 0600 "$KIND_CREATION_PROOF_FILE"
    ;;
esac
/bin/chmod "$@"
`, { mode: 0o700 });
  const createdId = "a".repeat(64);
  const injectedId = "b".repeat(64);
  const baseEnvironment = {
    ...process.env,
    PATH: `${bin}:/usr/bin:/bin`,
    CONTAINER_ENGINE: "docker",
    REQUIRE_NEW_KIND_CLUSTER: "true",
    KIND_CLUSTER_NAME: "acp-demo-create-proof",
    KIND_NODE_ROLE: "control-plane",
  };
  const invocationEnvironment = (name, values) => ({
    ...baseEnvironment,
    DOCKER_COMMAND_LOG: path.join(root, `${name}.docker.log`),
    KIND_CREATE_MARKER: path.join(root, `${name}.kind-created`),
    ...values,
  });

  for (const [name, dockerEvents, finalIds] of [
    ["replacement", `create ${createdId}\ndestroy ${createdId}\ncreate ${injectedId}`, injectedId],
    ["extra injection", `create ${createdId}\ncreate ${injectedId}`, `${createdId}\n${injectedId}`],
  ]) {
    const proofPath = path.join(root, `${name.replace(" ", "-")}.proof`);
    await assert.rejects(execFileAsync("/bin/bash", [setupPath], {
      env: {
        ...invocationEnvironment(name.replace(" ", "-"), {}),
        DOCKER_EVENTS: dockerEvents,
        FINAL_KIND_CONTAINER_IDS: finalIds,
        KIND_CREATION_PROOF_FILE: proofPath,
      },
    }), undefined, name);
    await assert.rejects(readFile(proofPath, "utf8"), { code: "ENOENT" });
  }

  const proofPath = path.join(root, "exact.proof");
  await execFileAsync("/bin/bash", [setupPath], {
    env: {
      ...invocationEnvironment("exact", {}),
      DOCKER_EVENTS: `create ${createdId}`,
      FINAL_KIND_CONTAINER_IDS: createdId,
      KIND_CREATION_PROOF_FILE: proofPath,
    },
  });
  assert.equal(await readFile(proofPath, "utf8"), `${createdId}\n`);
  assert.equal((await stat(proofPath)).mode & 0o777, 0o600);

  for (const behavior of ["fail", "interrupt"]) {
    const failedProofPath = path.join(root, `${behavior}.proof`);
    await assert.rejects(execFileAsync("/bin/bash", [setupPath], {
      env: {
        ...invocationEnvironment(behavior, {}),
        DOCKER_EVENTS: `create ${createdId}`,
        FINAL_KIND_CONTAINER_IDS: createdId,
        KIND_CREATION_PROOF_FILE: failedProofPath,
        PROOF_CHMOD_BEHAVIOR: behavior,
      },
    }));
    await assert.rejects(readFile(failedProofPath, "utf8"), { code: "ENOENT" });
    assert.deepEqual(
      (await readdir(root)).filter((name) => name.startsWith(`${behavior}.proof.`)),
      [],
    );
    assert.equal(
      await readFile(path.join(root, `${behavior}.docker.log`), "utf8"),
      `docker rm --force --volumes -- ${createdId}\n`,
    );
  }

  const racedProofPath = path.join(root, "race.proof");
  await assert.rejects(execFileAsync("/bin/bash", [setupPath], {
    env: {
      ...invocationEnvironment("race", {}),
      DOCKER_EVENTS: `create ${createdId}`,
      FINAL_KIND_CONTAINER_IDS: createdId,
      KIND_CREATION_PROOF_FILE: racedProofPath,
      PROOF_CHMOD_BEHAVIOR: "race",
    },
  }));
  assert.equal(await readFile(racedProofPath, "utf8"), "competing-publisher\n");
  assert.equal((await stat(racedProofPath)).mode & 0o777, 0o600);
  assert.deepEqual(
    (await readdir(root)).filter((name) => name.startsWith("race.proof.")),
    [],
  );
  assert.equal(
    await readFile(path.join(root, "race.docker.log"), "utf8"),
    `docker rm --force --volumes -- ${createdId}\n`,
  );

  for (const [name, extraEnvironment] of [
    ["inspect-failure", { KIND_INSPECT_FAIL: "true" }],
    ["partial-create", { KIND_CREATE_EXIT_CODE: "42" }],
  ]) {
    const failedProofPath = path.join(root, `${name}.proof`);
    await assert.rejects(execFileAsync("/bin/bash", [setupPath], {
      env: invocationEnvironment(name, {
        DOCKER_EVENTS: `create ${createdId}`,
        FINAL_KIND_CONTAINER_IDS: createdId,
        KIND_CREATION_PROOF_FILE: failedProofPath,
        ...extraEnvironment,
      }),
    }));
    await assert.rejects(readFile(failedProofPath, "utf8"), { code: "ENOENT" });
    assert.equal(
      await readFile(path.join(root, `${name}.docker.log`), "utf8"),
      `docker rm --force --volumes -- ${createdId}\n`,
    );
  }

  const ambiguousProofPath = path.join(root, "ambiguous-partial.proof");
  await assert.rejects(execFileAsync("/bin/bash", [setupPath], {
    env: invocationEnvironment("ambiguous-partial", {
      DOCKER_EVENTS: `create ${createdId}\ncreate ${injectedId}`,
      FINAL_KIND_CONTAINER_IDS: `${createdId}\n${injectedId}`,
      KIND_CREATE_EXIT_CODE: "42",
      KIND_CREATION_PROOF_FILE: ambiguousProofPath,
    }),
  }), (error) => {
    assert.match(error.stderr, /ambiguous.*automatic cleanup was not attempted/iu);
    return true;
  });
  await assert.rejects(readFile(ambiguousProofPath, "utf8"), { code: "ENOENT" });
  await assert.rejects(
    readFile(path.join(root, "ambiguous-partial.docker.log"), "utf8"),
    { code: "ENOENT" },
  );

  const runInterruptedCreate = async (name, finalIds) => {
    const proof = path.join(root, `${name}.proof`);
    const environment = invocationEnvironment(name, {
      DOCKER_EVENTS: "",
      FINAL_KIND_CONTAINER_IDS: finalIds,
      KIND_CREATE_BLOCK: "true",
      KIND_CREATION_PROOF_FILE: proof,
      KUBECONFIG: path.join(root, `${name}.kubeconfig`),
    });
    const child = spawn("/bin/bash", [setupPath], {
      detached: true,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        await access(environment.KIND_CREATE_MARKER);
        break;
      } catch {
        if (attempt === 99) throw new Error("fake Kind create did not enter its foreground wait");
        await delay(10);
      }
    }
    process.kill(-child.pid, "SIGTERM");
    let timeout;
    const timeoutPromise = new Promise((_, reject) => {
      timeout = setTimeout(() => {
        process.kill(-child.pid, "SIGKILL");
        reject(new Error("interrupted Kind setup did not exit"));
      }, 5_000);
    });
    let result;
    try {
      result = await Promise.race([
        new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal }))),
        timeoutPromise,
      ]);
    } finally {
      clearTimeout(timeout);
    }
    return { environment, proof, result, stderr, stdout };
  };

  const interrupted = await runInterruptedCreate("foreground-interrupt", createdId);
  assert.notEqual(interrupted.result.code, 0);
  await assert.rejects(readFile(interrupted.proof, "utf8"), { code: "ENOENT" });
  const interruptedLog = await readFile(interrupted.environment.DOCKER_COMMAND_LOG, "utf8");
  assert.match(interruptedLog, new RegExp(`^docker rm --force --volumes -- ${createdId}$`, "mu"));
  assert.match(interruptedLog, /config delete-context kind-acp-demo-create-proof/mu);
  assert.match(interruptedLog, /config delete-cluster kind-acp-demo-create-proof/mu);
  assert.match(interruptedLog, /config delete-user kind-acp-demo-create-proof/mu);

  const ambiguousInterrupt = await runInterruptedCreate(
    "ambiguous-foreground-interrupt",
    `${createdId}\n${injectedId}`,
  );
  assert.notEqual(ambiguousInterrupt.result.code, 0);
  assert.match(ambiguousInterrupt.stderr, /ambiguous.*automatic cleanup was not attempted/iu);
  await assert.rejects(
    readFile(ambiguousInterrupt.environment.DOCKER_COMMAND_LOG, "utf8"),
    { code: "ENOENT" },
  );
});

test("repository Kind cleanup disables Podman fallback for the Docker-owned demo path", async () => {
  const script = await readFile(new URL(
    "../../../../../../tests/infra/cleanup.sh",
    import.meta.url,
  ), "utf8");
  assert.match(script, /DOCKER_ONLY_KIND_CLUSTER/);
  assert.match(script, /EXPECTED_KIND_CONTAINER_IDS/);
  assert.match(script, /docker ps[\s\S]+?io\.x-k8s\.kind\.cluster/);
  assert.match(script, /docker rm --force --volumes --[^\n]*"\$\{current_ids\[@\]\}"/);
  assert.match(script, /for expected_id in "\$\{expected_ids\[@\]\}"/);
  assert.match(script, /Refusing.*container identit/i);
  assert.match(script, /Refusing cross-provider cleanup/);
  assert.match(script, /DOCKER_ONLY_KIND_CLUSTER[^\n]+!= "true"[^\n]+podman container exists/);
});

test("strict Kind cleanup refuses a replacement and deletes only witnessed Docker IDs", async (context) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "kind-cleanup-exact-")));
  context.after(() => rm(root, { recursive: true, force: true }));
  const bin = path.join(root, "bin");
  const infra = path.join(root, "tests", "infra");
  await mkdir(bin, { recursive: true, mode: 0o700 });
  await mkdir(infra, { recursive: true, mode: 0o700 });
  await mkdir(path.join(root, "tests", "cypress"), { recursive: true, mode: 0o700 });
  const cleanupPath = path.join(infra, "cleanup.sh");
  await writeFile(cleanupPath, await readFile(new URL(
    "../../../../../../tests/infra/cleanup.sh",
    import.meta.url,
  ), "utf8"), { mode: 0o700 });
  const logPath = path.join(root, "commands.log");
  await writeFile(path.join(bin, "docker"), `#!/bin/bash
set -eu
if [ "$1" = ps ]; then printf '%s\\n' "$CURRENT_KIND_CONTAINER_IDS"; exit 0; fi
printf 'docker %s\\n' "$*" >> "$COMMAND_LOG"
`, { mode: 0o700 });
  await writeFile(path.join(bin, "kubectl"), `#!/bin/bash
printf 'kubectl %s\\n' "$*" >> "$COMMAND_LOG"
`, { mode: 0o700 });
  await writeFile(path.join(bin, "kind"), `#!/bin/bash
printf 'kind %s\\n' "$*" >> "$COMMAND_LOG"
exit 99
`, { mode: 0o700 });
  const ownedId = "a".repeat(64);
  const baseEnvironment = {
    ...process.env,
    PATH: `${bin}:/usr/bin:/bin`,
    COMMAND_LOG: logPath,
    CONTAINER_ENGINE: "docker",
    DOCKER_ONLY_KIND_CLUSTER: "true",
    EXPECTED_KIND_CONTAINER_IDS: ownedId,
    KIND_CLUSTER_NAME: "acp-demo-exact-cleanup",
    KUBECONFIG: path.join(root, "kubeconfig"),
  };

  await assert.rejects(execFileAsync("/bin/bash", [cleanupPath], {
    env: { ...baseEnvironment, CURRENT_KIND_CONTAINER_IDS: "b".repeat(64) },
  }));
  await assert.rejects(readFile(logPath, "utf8"), { code: "ENOENT" });

  await execFileAsync("/bin/bash", [cleanupPath], {
    env: { ...baseEnvironment, CURRENT_KIND_CONTAINER_IDS: ownedId },
  });
  const log = await readFile(logPath, "utf8");
  assert.match(log, new RegExp(`docker rm --force --volumes -- ${ownedId}`, "u"));
  assert.equal(log.includes("kind delete"), false);
  assert.equal(log.match(/^kubectl /gmu)?.length, 3);
});

async function fixture(context) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "kind-workspace-")));
  const repoRoot = path.join(root, "source");
  const runtimeRoot = path.join(root, "runtime");
  const gitPath = path.join(root, "git");
  await mkdir(repoRoot, { mode: 0o700 });
  await mkdir(runtimeRoot, { mode: 0o700 });
  await writeFile(gitPath, "#!/bin/sh\nexit 99\n", { mode: 0o700 });
  await chmod(gitPath, 0o700);
  context.after(() => rm(root, { recursive: true, force: true }));
  return { root, repoRoot, runtimeRoot, gitPath };
}

test("materializes a clean stable committed tree into the private runtime boundary", async (context) => {
  const input = await fixture(context);
  const calls = [];
  const runCommand = async (executable, args, options) => {
    calls.push({ executable, args, options });
    if (args.includes("rev-parse")) return { stdout: `${COMMIT}\n` };
    if (args.includes("status")) return { stdout: "" };
    const prefix = args.find((argument) => argument.startsWith("--prefix=")).slice("--prefix=".length);
    await mkdir(path.join(prefix, "tests/infra"), { recursive: true, mode: 0o700 });
    await writeFile(path.join(prefix, "Makefile"), "kind-up:\n", { mode: 0o600 });
    await writeFile(path.join(prefix, "tests/infra/setup-kind.sh"), "#!/bin/sh\n", { mode: 0o700 });
    await writeFile(path.join(prefix, "tests/infra/cleanup.sh"), "#!/bin/sh\n", { mode: 0o700 });
    return { stdout: "" };
  };

  const result = await prepareIsolatedKindWorkspace({
    ...input,
    expectedCommit: COMMIT,
  }, { runCommand, toolEnvironment: { PATH: "/usr/bin" } });

  assert.deepEqual(result, {
    workspaceRoot: path.join(input.runtimeRoot, "kind-workspace"),
    sourceCommit: COMMIT,
  });
  assert.deepEqual(calls.map(({ args }) => args.slice(2, 4)), [
    ["rev-parse", "HEAD"],
    ["status", "--porcelain=v1"],
    ["checkout-index", "--all"],
    ["rev-parse", "HEAD"],
    ["status", "--porcelain=v1"],
  ]);
  assert.ok(calls.every(({ args }) => args[0] === "-C" && args[1] === input.repoRoot));
  assert.ok(calls.every(({ options }) => options.shell === false));
});

test("accepts a lowercase SHA-256 Git commit for workspace provenance", async (context) => {
  const input = await fixture(context);
  const sha256Commit = "d".repeat(64);
  const runCommand = async (_executable, args) => {
    if (args.includes("rev-parse")) return { stdout: `${sha256Commit}\n` };
    if (args.includes("status")) return { stdout: "" };
    const prefix = args.find((argument) => argument.startsWith("--prefix=")).slice("--prefix=".length);
    await mkdir(path.join(prefix, "tests/infra"), { recursive: true, mode: 0o700 });
    await writeFile(path.join(prefix, "Makefile"), "kind-up:\n", { mode: 0o600 });
    await writeFile(path.join(prefix, "tests/infra/setup-kind.sh"), "#!/bin/sh\n", { mode: 0o700 });
    await writeFile(path.join(prefix, "tests/infra/cleanup.sh"), "#!/bin/sh\n", { mode: 0o700 });
    return { stdout: "" };
  };

  const result = await prepareIsolatedKindWorkspace({
    ...input,
    expectedCommit: sha256Commit,
  }, { runCommand, toolEnvironment: { PATH: "/usr/bin" } });

  assert.equal(result.sourceCommit, sha256Commit);
});

test("refuses dirty or changing source state and removes a partial workspace", async (context) => {
  for (const mode of ["dirty", "changed-after"]) {
    const input = await fixture(context);
    let headReads = 0;
    const runCommand = async (_executable, args) => {
      if (args.includes("rev-parse")) {
        headReads += 1;
        return { stdout: `${mode === "changed-after" && headReads === 2 ? "d".repeat(40) : COMMIT}\n` };
      }
      if (args.includes("status")) {
        return { stdout: mode === "dirty" ? " M Makefile\n" : "" };
      }
      const prefix = args.find((argument) => argument.startsWith("--prefix=")).slice("--prefix=".length);
      await writeFile(path.join(prefix, "partial"), "partial", { mode: 0o600 });
      return { stdout: "" };
    };
    await assert.rejects(
      prepareIsolatedKindWorkspace({ ...input, expectedCommit: COMMIT }, { runCommand }),
      /clean|HEAD changed/,
      mode,
    );
    await assert.rejects(realpath(path.join(input.runtimeRoot, "kind-workspace")), { code: "ENOENT" });
  }
});
