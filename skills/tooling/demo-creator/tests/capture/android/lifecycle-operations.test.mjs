import assert from "node:assert/strict";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { reserveAvdOwnership } from "../../../scripts/capture/android/avd-lifecycle.mjs";
import {
  beginKindClusterCreation,
  bindKindCluster,
  completeKindClusterCreation,
  reserveKindClusterOwnership,
  teardownOwnedKindCluster,
} from "../../../scripts/capture/android/kind-lifecycle.mjs";

let lifecycleOperations = {};
try {
  lifecycleOperations = await import(
    "../../../scripts/capture/android/lifecycle-operations.mjs"
  );
} catch (error) {
  if (error?.code !== "ERR_MODULE_NOT_FOUND") throw error;
}

test("exports concrete Kind and AVD lifecycle dependency factories", () => {
  assert.equal(typeof lifecycleOperations.createKindLifecycleDeps, "function");
  assert.equal(typeof lifecycleOperations.createAvdLifecycleDeps, "function");
});

test("rejects a lexically escaping private kubeconfig path before executing a command", () => {
  assert.throws(() => lifecycleOperations.createKindLifecycleDeps({
    kubeconfigPath: "/private/acp-run/../shared-kubeconfig",
    dockerPath: "/tools/docker",
    kindPath: "/tools/kind",
    kubectlPath: "/tools/kubectl",
  }, { runCommand: async () => result() }), /normalized absolute path/);
});

test("rejects bare lifecycle tool names instead of resolving them through PATH", () => {
  assert.throws(() => lifecycleOperations.createKindLifecycleDeps({
    kubeconfigPath: "/private/acp-run/kubeconfig",
    dockerPath: "docker",
    kindPath: "/tools/kind",
    kubectlPath: "/tools/kubectl",
  }, { runCommand: async () => result() }), /dockerPath must be a normalized absolute path/);

  assert.throws(() => lifecycleOperations.createAvdLifecycleDeps({
    avdRoot: "/private/acp-run/avds",
    adbPath: "adb",
    emulatorPath: "/tools/emulator",
    avdmanagerPath: "/tools/avdmanager",
  }, {
    processRegistry: { emulators: new Map(), recorders: new Map() },
    inspectProcess: async () => null,
    stopEmulator: async () => {},
  }), /adbPath must be a normalized absolute path/);
});

test("AVD lifecycle defaults to bounded host process identity inspection", async (t) => {
  const calls = [];
  const config = {
    avdRoot: "/private/acp-run/avds",
    adbPath: "/tools/adb",
    emulatorPath: "/tools/emulator",
    avdmanagerPath: "/tools/avdmanager",
  };
  const create = (runCommand) => lifecycleOperations.createAvdLifecycleDeps(config, {
    currentProcessPid: 7373,
    processRegistry: { emulators: new Map(), recorders: new Map() },
    stopEmulator: async () => {},
    runCommand: async (executable, args, options) => {
      calls.push({ executable, args, options });
      return runCommand(executable, args, options);
    },
  });

  await t.test("returns the exact current PID and start identity", async () => {
    const dependencies = create(async (executable, args) => {
      assert.equal(executable, "/bin/ps");
      assert.deepEqual(args, [
        "-ww",
        "-p",
        "7373",
        "-o",
        "lstart=",
        "-o",
        "command=",
      ]);
      return result("Fri Jul 17 12:34:56 2026 /usr/bin/node --test\n");
    });
    assert.deepEqual(await dependencies.runtime.getMarkerUpdateOwner(), {
      pid: 7373,
      processStartIdentity: "Fri Jul 17 12:34:56 2026",
    });
    assert.equal(calls.at(-1).options.timeout, 15_000);
    assert.equal(calls.at(-1).options.maxBuffer, 16 * 1024);
  });

  await t.test("distinguishes an absent PID from an ambiguous inspection failure", async () => {
    const missingProcess = create(async () => {
      const error = new Error("no such process");
      error.code = 1;
      throw error;
    });
    assert.equal(await missingProcess.runtime.inspectMarkerUpdateOwner({
      pid: 8181,
      processStartIdentity: "old-start",
    }), null);

    const inspectionFailure = create(async () => {
      const error = new Error("ps unavailable");
      error.code = "EACCES";
      throw error;
    });
    await assert.rejects(
      inspectionFailure.runtime.inspectMarkerUpdateOwner({
        pid: 8181,
        processStartIdentity: "old-start",
      }),
      /host process inspection failed/i,
    );

    const wrappedStringExit = create(async () => {
      const error = new Error("untrusted wrapped status");
      error.code = "1";
      throw error;
    });
    await assert.rejects(
      wrappedStringExit.runtime.inspectMarkerUpdateOwner({
        pid: 8181,
        processStartIdentity: "old-start",
      }),
      /host process inspection failed/i,
    );

    const emptyInspection = create(async () => result(""));
    await assert.rejects(
      emptyInspection.runtime.inspectMarkerUpdateOwner({
        pid: 8181,
        processStartIdentity: "old-start",
      }),
      /host process inspection.*ambiguous/i,
    );
  });
});

test("Kind lifecycle exposes canonical marker-update owner process inspection", async () => {
  const calls = [];
  const dependencies = lifecycleOperations.createKindLifecycleDeps({
    kubeconfigPath: "/private/acp-run/kubeconfig",
    dockerPath: "/tools/docker",
    kindPath: "/tools/kind",
    kubectlPath: "/tools/kubectl",
  }, {
    currentProcessPid: 7373,
    runCommand: async (executable, args, options) => {
      calls.push({ executable, args, options });
      return result("Sat Jul 18 11:00:00 2026 /usr/bin/node --test\n");
    },
  });

  assert.deepEqual(await dependencies.getMarkerUpdateOwner(), {
    pid: 7373,
    processStartIdentity: "Sat Jul 18 11:00:00 2026",
  });
  assert.deepEqual(await dependencies.inspectMarkerUpdateOwner({
    pid: 7373,
    processStartIdentity: "Sat Jul 18 11:00:00 2026",
  }), {
    pid: 7373,
    processStartIdentity: "Sat Jul 18 11:00:00 2026",
    command: "/usr/bin/node --test",
    alive: true,
  });
  assert.deepEqual(calls.map(({ executable, args }) => [executable, args]), [
    ["/bin/ps", ["-ww", "-p", "7373", "-o", "lstart=", "-o", "command="]],
    ["/bin/ps", ["-ww", "-p", "7373", "-o", "lstart=", "-o", "command="]],
  ]);
  assert.equal(calls.every(({ options }) => options.maxBuffer === 16 * 1024), true);
});

function result(stdout = "") {
  return { stdout, stderr: "", exitCode: 0 };
}

test("Kind inspection binds every kubectl read to the private kubeconfig and requested context", async () => {
  const calls = [];
  const kubeconfigPath = "/private/acp-run/kubeconfig";
  const clusterName = "acp-demo-flow-run-nonce";
  const kubeContext = `kind-${clusterName}`;
  const kubeServer = "https://127.0.0.1:61443";
  const runCommand = async (executable, args, options) => {
    calls.push({ executable, args, options });
    if (executable === "/tools/kind") {
      assert.deepEqual(args, ["get", "clusters"]);
      return result(`${clusterName}\nunrelated\n`);
    }
    if (executable === "/tools/kubectl" && args.includes("get-contexts")) {
      return result(`${kubeContext}\nkind-unrelated\n`);
    }
    if (executable === "/tools/kubectl" && args.includes("view")) {
      return result(JSON.stringify({
        "current-context": kubeContext,
        contexts: [{ name: kubeContext, context: { cluster: "owned-cluster" } }],
        clusters: [{ name: "owned-cluster", cluster: { server: kubeServer } }],
      }));
    }
    if (executable === "/tools/docker" && args[0] === "ps") {
      return result("sha256:bbbb\nsha256:aaaa\n");
    }
    if (executable === "/tools/docker" && args[0] === "inspect") {
      return result(JSON.stringify([
        { Id: "sha256:bbbb", Config: { Labels: { "io.x-k8s.kind.cluster": clusterName } } },
        { Id: "sha256:aaaa", Config: { Labels: { "io.x-k8s.kind.cluster": clusterName } } },
      ]));
    }
    if (executable === "/tools/kubectl" && args.includes("nodes")) {
      return result(JSON.stringify({
        items: [{
          metadata: { name: "owned-control-plane" },
          status: { conditions: [{ type: "Ready", status: "True" }] },
        }],
      }));
    }
    throw new Error(`unexpected command: ${executable} ${args.join(" ")}`);
  };

  const dependencies = lifecycleOperations.createKindLifecycleDeps({
    kubeconfigPath,
    dockerPath: "/tools/docker",
    kindPath: "/tools/kind",
    kubectlPath: "/tools/kubectl",
  }, { runCommand });
  const inspection = await dependencies.inspectKindCluster({
    phase: "bind",
    clusterName,
    kubeContext,
  });

  assert.deepEqual(inspection, {
    kindClusterNames: [clusterName, "unrelated"],
    kubeContexts: [kubeContext, "kind-unrelated"],
    inspectedKubeContext: kubeContext,
    kubeServer,
    containerIdentities: ["sha256:aaaa", "sha256:bbbb"],
    ready: true,
  });
  const kubectlCalls = calls.filter(({ executable }) => executable === "/tools/kubectl");
  assert.ok(kubectlCalls.length >= 3);
  for (const { args, options } of kubectlCalls) {
    assert.deepEqual(args.slice(0, 2), ["--kubeconfig", kubeconfigPath]);
    assert.ok(Number.isInteger(options.timeout) && options.timeout > 0);
    assert.ok(Number.isInteger(options.maxBuffer) && options.maxBuffer > 0);
  }
  for (const { args } of kubectlCalls.filter(({ args }) => !args.includes("get-contexts"))) {
    assert.deepEqual(args.slice(2, 4), ["--context", kubeContext]);
  }
  assert.equal(Object.hasOwn(dependencies, "deleteKindCluster"), false);
});

test("Kind teardown proof freshly enumerates private kube servers and exact-label Docker remnants", async () => {
  const clusterName = "acp-demo-flow-run-nonce";
  const kubeContext = `kind-${clusterName}`;
  const calls = [];
  const dependencies = lifecycleOperations.createKindLifecycleDeps({
    kubeconfigPath: "/private/acp-run/kubeconfig",
    dockerPath: "/tools/docker",
    kindPath: "/tools/kind",
    kubectlPath: "/tools/kubectl",
  }, {
    runCommand: async (executable, args) => {
      calls.push({ executable, args });
      if (executable === "/tools/kind") return result("unrelated\n");
      if (executable === "/tools/kubectl" && args.includes("get-contexts")) {
        return result("kind-unrelated\n");
      }
      if (executable === "/tools/kubectl" && args.includes("view")) {
        return result(JSON.stringify({
          clusters: [{ name: "other", cluster: { server: "https://127.0.0.1:6443" } }],
        }));
      }
      if (executable === "/tools/docker" && args[0] === "ps") return result("");
      throw new Error(`unexpected command ${executable} ${args.join(" ")}`);
    },
  });

  assert.deepEqual(await dependencies.inspectKindCluster({
    phase: "teardown-proof",
    clusterName,
    kubeContext,
  }), {
    kindClusterNames: ["unrelated"],
    kubeContexts: ["kind-unrelated"],
    kubeServers: ["https://127.0.0.1:6443"],
    containerIdentities: [],
  });
  assert.ok(calls.some(({ executable, args }) => (
    executable === "/tools/docker" && args.includes(`label=io.x-k8s.kind.cluster=${clusterName}`)
  )));
  assert.ok(calls.filter(({ executable }) => executable === "/tools/kubectl")
    .every(({ args }) => args[0] === "--kubeconfig"));
});

test("Kind ACP endpoint evidence is bound to private descriptor and process state", async (context) => {
  const kindStateRoot = await realpath(await mkdtemp(path.join(tmpdir(), "owned-kind-endpoint-")));
  const clusterName = "acp-demo-flow-run-nonce";
  const kubeContext = `kind-${clusterName}`;
  const stateDirectory = path.join(kindStateRoot, clusterName);
  await mkdir(stateDirectory, { mode: 0o700 });
  context.after(() => rm(kindStateRoot, { recursive: true, force: true }));
  await writeFile(path.join(stateDirectory, "connection-state.json"), `${JSON.stringify({
    version: 1,
    cluster: clusterName,
    context: kubeContext,
    namespace: "ambient-code",
    api_url: "http://localhost:42101",
    ports: { backend: 42101 },
  })}\n`, { mode: 0o600 });
  await writeFile(path.join(stateDirectory, "port-forward-processes.json"), `${JSON.stringify({
    backend: {
      pid: 1234,
      uid: 501,
      started_at: "Fri Jul 17 12:00:00 2026",
      command: `/tools/kubectl --context ${kubeContext} port-forward -n ambient-code svc/ambient-api-server 42101:8000`,
    },
  })}\n`, { mode: 0o600 });
  await writeFile(path.join(stateDirectory, "kind-pf-backend.pid"), "1234\n", { mode: 0o600 });
  const dependencies = lifecycleOperations.createKindLifecycleDeps({
    kubeconfigPath: path.join(kindStateRoot, "kubeconfig"),
    dockerPath: "/tools/docker",
    kindPath: "/tools/kind",
    kubectlPath: "/tools/kubectl",
    kindStateRoot,
    backendPort: 42101,
  }, {
    probeLoopback: async (port) => port === 42101,
    inspectKindProcess: async (pid) => ({
      pid,
      uid: 501,
      started_at: "Fri Jul 17 12:00:00 2026",
      command: `/tools/kubectl --context ${kubeContext} port-forward -n ambient-code svc/ambient-api-server 42101:8000`,
    }),
  });

  assert.deepEqual(await dependencies.readKindAcpEndpointEvidence({
    clusterName,
    kubeContext,
    kubeServer: "https://127.0.0.1:61443",
    containerIdentities: ["sha256:bbbb", "sha256:aaaa"],
  }), {
    clusterName,
    kubeContext,
    kubeServer: "https://127.0.0.1:61443",
    containerIdentities: ["sha256:aaaa", "sha256:bbbb"],
    hostPort: 42101,
    descriptorVerified: true,
    processIdentityVerified: true,
    reachable: true,
  });
});

test("Kind ACP endpoint evidence rejects stale or reused port-forward process identity", async (context) => {
  const kindStateRoot = await realpath(await mkdtemp(path.join(tmpdir(), "stale-kind-endpoint-")));
  const clusterName = "acp-demo-flow-run-stale";
  const kubeContext = `kind-${clusterName}`;
  const stateDirectory = path.join(kindStateRoot, clusterName);
  await mkdir(stateDirectory, { mode: 0o700 });
  context.after(() => rm(kindStateRoot, { recursive: true, force: true }));
  await writeFile(path.join(stateDirectory, "connection-state.json"), `${JSON.stringify({
    version: 1,
    cluster: clusterName,
    context: kubeContext,
    namespace: "ambient-code",
    api_url: "http://localhost:42101",
    ports: { backend: 42101 },
  })}\n`, { mode: 0o600 });
  await writeFile(path.join(stateDirectory, "port-forward-processes.json"), `${JSON.stringify({
    backend: {
      pid: 1234,
      uid: 501,
      started_at: "owned-start",
      command: `/tools/kubectl --context ${kubeContext} port-forward -n ambient-code svc/ambient-api-server 42101:8000`,
    },
  })}\n`, { mode: 0o600 });
  await writeFile(path.join(stateDirectory, "kind-pf-backend.pid"), "1234\n", { mode: 0o600 });
  const dependencies = lifecycleOperations.createKindLifecycleDeps({
    kubeconfigPath: path.join(kindStateRoot, "kubeconfig"),
    dockerPath: "/tools/docker",
    kindPath: "/tools/kind",
    kubectlPath: "/tools/kubectl",
    kindStateRoot,
    backendPort: 42101,
  }, {
    probeLoopback: async () => true,
    inspectKindProcess: async () => ({
      pid: 1234,
      uid: 501,
      started_at: "replacement-start",
      command: "/usr/bin/python replacement-listener.py",
    }),
  });
  const evidence = await dependencies.readKindAcpEndpointEvidence({
    clusterName,
    kubeContext,
    kubeServer: "https://127.0.0.1:61443",
    containerIdentities: ["sha256:owned"],
  });
  assert.equal(evidence.processIdentityVerified, false);
  assert.equal(evidence.reachable, false);
});

test("Kind inspection fails closed on duplicate identities and a scoped context mismatch", async (t) => {
  const config = {
    kubeconfigPath: "/private/acp-run/kubeconfig",
    dockerPath: "/tools/docker",
    kindPath: "/tools/kind",
    kubectlPath: "/tools/kubectl",
  };
  const clusterName = "acp-demo-flow-run-nonce";
  const kubeContext = `kind-${clusterName}`;

  await t.test("duplicate cluster list", async () => {
    let dockerCalled = false;
    const dependencies = lifecycleOperations.createKindLifecycleDeps(config, {
      runCommand: async (executable, args) => {
        if (executable === config.kindPath) return result(`${clusterName}\n${clusterName}\n`);
        if (executable === config.kubectlPath && args.includes("get-contexts")) {
          return result(`${kubeContext}\n`);
        }
        if (executable === config.dockerPath) dockerCalled = true;
        throw new Error("scoped inspection should not run for an ambiguous list");
      },
    });
    await assert.rejects(
      dependencies.inspectKindCluster({ phase: "bind", clusterName, kubeContext }),
      /cluster list is ambiguous/,
    );
    assert.equal(dockerCalled, false);
  });

  await t.test("requested context differs from scoped config result", async () => {
    const dependencies = lifecycleOperations.createKindLifecycleDeps(config, {
      runCommand: async (executable, args) => {
        if (executable === config.kindPath) return result(`${clusterName}\n`);
        if (executable === config.kubectlPath && args.includes("get-contexts")) {
          return result(`${kubeContext}\n`);
        }
        if (executable === config.kubectlPath && args.includes("view")) {
          return result(JSON.stringify({
            "current-context": "kind-global-unrelated",
            contexts: [{ name: "kind-global-unrelated", context: { cluster: "other" } }],
            clusters: [{ name: "other", cluster: { server: "https://127.0.0.1:1" } }],
          }));
        }
        if (executable === config.dockerPath && args[0] === "ps") return result("node-a\n");
        if (executable === config.dockerPath && args[0] === "inspect") {
          return result(JSON.stringify([{
            Id: "sha256:aaaa",
            Config: { Labels: { "io.x-k8s.kind.cluster": clusterName } },
          }]));
        }
        if (executable === config.kubectlPath && args.includes("nodes")) {
          return result(JSON.stringify({ items: [] }));
        }
        throw new Error(`unexpected command: ${executable} ${args.join(" ")}`);
      },
    });
    await assert.rejects(
      dependencies.inspectKindCluster({ phase: "verify", clusterName, kubeContext }),
      /inspected context does not match requested context/,
    );
  });

  await t.test("Docker inspection cannot substitute a different same-label container", async () => {
    const dependencies = lifecycleOperations.createKindLifecycleDeps(config, {
      runCommand: async (executable, args) => {
        if (executable === config.kindPath) return result(`${clusterName}\n`);
        if (executable === config.kubectlPath && args.includes("get-contexts")) {
          return result(`${kubeContext}\n`);
        }
        if (executable === config.kubectlPath && args.includes("view")) {
          return result(JSON.stringify({
            "current-context": kubeContext,
            contexts: [{ name: kubeContext, context: { cluster: "owned" } }],
            clusters: [{ name: "owned", cluster: { server: "https://127.0.0.1:61443" } }],
          }));
        }
        if (executable === config.dockerPath && args[0] === "ps") {
          return result("sha256:aaaa\n");
        }
        if (executable === config.dockerPath && args[0] === "inspect") {
          return result(JSON.stringify([{
            Id: "sha256:bbbb",
            Config: { Labels: { "io.x-k8s.kind.cluster": clusterName } },
          }]));
        }
        if (executable === config.kubectlPath && args.includes("nodes")) {
          return result(JSON.stringify({ items: [] }));
        }
        throw new Error(`unexpected command: ${executable} ${args.join(" ")}`);
      },
    });
    await assert.rejects(
      dependencies.inspectKindCluster({ phase: "verify", clusterName, kubeContext }),
      /does not match selected Docker containers/,
    );
  });
});

test("lifecycle commands use an allowlisted tool environment with no ACP credentials", async () => {
  const authoredEnvironment = {
    PATH: "/tools",
    HOME: "/private/home",
    ANDROID_SDK_ROOT: "/private/sdk",
    DOCKER_HOST: "unix:///private/docker.sock",
    KUBECONFIG: "/Users/example/.kube/config",
    ACP_BEARER_TOKEN: "must-not-cross-process-boundary",
    ACP_URL: "https://private.example.test",
    UNRELATED_SECRET: "must-not-cross-process-boundary",
  };
  const kindEnvironments = [];
  const kind = lifecycleOperations.createKindLifecycleDeps({
    kubeconfigPath: "/private/acp-run/kubeconfig",
    dockerPath: "/tools/docker",
    kindPath: "/tools/kind",
    kubectlPath: "/tools/kubectl",
    toolEnvironment: authoredEnvironment,
  }, {
    runCommand: async (_executable, _args, options) => {
      kindEnvironments.push(options.env);
      return result();
    },
  });
  await kind.inspectKindCluster({
    phase: "reserve",
    clusterName: "acp-demo-flow-run-nonce",
    kubeContext: "kind-acp-demo-flow-run-nonce",
  });
  assert.deepEqual(kindEnvironments, [
    {
      PATH: "/tools",
      HOME: "/private/acp-run",
      ANDROID_SDK_ROOT: "/private/sdk",
      DOCKER_HOST: "unix:///private/docker.sock",
    },
    {
      PATH: "/tools",
      HOME: "/private/acp-run",
      ANDROID_SDK_ROOT: "/private/sdk",
      DOCKER_HOST: "unix:///private/docker.sock",
    },
  ]);

  const avdRoot = "/private/acp-run/avds";
  const avdName = "acp-demo-flow-run-nonce-0123456789ab";
  const fixture = avdFilesystem({
    avdRoot,
    avdName,
    systemImage: "system-images;android-35;google_apis;x86_64",
  });
  const avdEnvironments = [];
  const avd = lifecycleOperations.createAvdLifecycleDeps({
    avdRoot,
    adbPath: "/tools/adb",
    emulatorPath: "/tools/emulator",
    avdmanagerPath: "/tools/avdmanager",
    baseEnvironment: authoredEnvironment,
  }, {
    fs: fixture.fs,
    processRegistry: { emulators: new Map(), recorders: new Map() },
    inspectProcess: async () => null,
    stopEmulator: async () => {},
    runCommand: async (_executable, args, options) => {
      avdEnvironments.push(options.env);
      assert.deepEqual(args, ["list", "avd"]);
      return result("Available Android Virtual Devices:\n");
    },
  });
  await avd.runtime.inspectAvds();
  assert.deepEqual(avdEnvironments, [{
    PATH: "/tools",
    HOME: "/private/acp-run",
    ANDROID_SDK_ROOT: "/private/sdk",
    DOCKER_HOST: "unix:///private/docker.sock",
    ANDROID_USER_HOME: "/private/acp-run",
    ANDROID_AVD_HOME: avdRoot,
  }]);
});

function avdFilesystem({ avdRoot, avdName, systemImage }) {
  const avdPath = `${avdRoot}/${avdName}.avd`;
  const configPath = `${avdPath}/config.ini`;
  const definitionPath = `${avdRoot}/${avdName}.ini`;
  const directories = new Set([avdRoot, avdPath]);
  const files = new Set([configPath, definitionPath]);
  return {
    avdPath,
    configPath,
    definitionPath,
    removeAvd() {
      directories.delete(avdPath);
      files.delete(configPath);
      files.delete(definitionPath);
    },
    fs: {
      async realpath(pathname) {
        if (!directories.has(pathname) && !files.has(pathname)) {
          const error = new Error(`ENOENT: ${pathname}`);
          error.code = "ENOENT";
          throw error;
        }
        return pathname;
      },
      async lstat(pathname) {
        if (!directories.has(pathname) && !files.has(pathname)) {
          const error = new Error(`ENOENT: ${pathname}`);
          error.code = "ENOENT";
          throw error;
        }
        return {
          mode: directories.has(pathname) ? 0o700 : 0o600,
          isDirectory: () => directories.has(pathname),
          isFile: () => files.has(pathname),
          isSymbolicLink: () => false,
        };
      },
      async readFile(pathname) {
        if (pathname === definitionPath) {
          return [
            "avd.ini.encoding=UTF-8",
            `path=${avdPath}`,
            "path.rel=avd/private.avd",
            "target=android-35",
            "",
          ].join("\n");
        }
        assert.equal(pathname, configPath);
        return [
          `AvdId=${avdName}`,
          `image.sysdir.1=${systemImage.replaceAll(";", "/")}/`,
          "",
        ].join("\n");
      },
    },
  };
}

test("AVD inspection returns only canonical private AVD and exact tracked emulator identities", async () => {
  const avdRoot = "/private/acp-run/avds";
  const avdName = "acp-demo-flow-run-nonce-0123456789ab";
  const systemImage = "system-images;android-35;google_apis;x86_64";
  const fixture = avdFilesystem({ avdRoot, avdName, systemImage });
  const processRegistry = {
    emulators: new Map([[avdName, {
      avdName,
      serial: "emulator-5554",
      consolePort: 5554,
      pid: 4242,
      processStartIdentity: "4242:100000",
      child: { pid: 4242, private: true },
    }]]),
    recorders: new Map(),
  };
  const commands = [];
  const runCommand = async (executable, args, options) => {
    commands.push({ executable, args, options });
    assert.equal(options.env.ANDROID_AVD_HOME, avdRoot);
    if (executable === "/tools/avdmanager") {
      assert.deepEqual(args, ["list", "avd"]);
      return result([
        "Available Android Virtual Devices:",
        `    Name: ${avdName}`,
        `    Path: ${fixture.avdPath}`,
        "---------",
        "",
      ].join("\n"));
    }
    if (executable === "/tools/adb" && args[0] === "devices") {
      return result("List of devices attached\nemulator-5554\tdevice\n");
    }
    if (executable === "/tools/adb" && args.includes("avd") && args.includes("name")) {
      assert.deepEqual(args, ["-s", "emulator-5554", "emu", "avd", "name"]);
      return result(`${avdName}\nOK\n`);
    }
    if (executable === "/tools/adb" && args.includes("sys.boot_completed")) {
      assert.deepEqual(args.slice(0, 2), ["-s", "emulator-5554"]);
      return result("1\n");
    }
    throw new Error(`unexpected command: ${executable} ${args.join(" ")}`);
  };
  const dependencies = lifecycleOperations.createAvdLifecycleDeps({
    avdRoot,
    adbPath: "/tools/adb",
    emulatorPath: "/tools/emulator",
    avdmanagerPath: "/tools/avdmanager",
  }, {
    fs: fixture.fs,
    runCommand,
    processRegistry,
    inspectProcess: async (pid) => ({
      pid,
      processStartIdentity: "4242:100000",
      alive: true,
    }),
    stopEmulator: async () => assert.fail("inspection must not stop a child"),
  });

  assert.deepEqual(await dependencies.runtime.inspectAvds(), [{
    avdName,
    avdPath: fixture.avdPath,
    configPath: fixture.configPath,
    definitionPath: fixture.definitionPath,
    systemImage,
    config: {
      avdName,
      avdPath: fixture.avdPath,
      systemImage,
    },
  }]);
  assert.deepEqual(await dependencies.runtime.inspectEmulators(), [{
    avdName,
    serial: "emulator-5554",
    consolePort: 5554,
    pid: 4242,
    processStartIdentity: "4242:100000",
    ready: true,
  }]);
  assert.ok(commands.every(({ options }) => (
    Number.isInteger(options.timeout) && Number.isInteger(options.maxBuffer)
  )));
  assert.equal(commands.some(({ args }) => (
    JSON.stringify(args) === JSON.stringify(["-s", "emulator-5554", "emu", "avd", "name"])
  )), true);
});

test("AVD inspection rejects a group-readable canonical runtime root before commands", async () => {
  let commandCalled = false;
  const avdRoot = "/private/acp-run/avds";
  const dependencies = lifecycleOperations.createAvdLifecycleDeps({
    avdRoot,
    adbPath: "/tools/adb",
    emulatorPath: "/tools/emulator",
    avdmanagerPath: "/tools/avdmanager",
  }, {
    fs: {
      realpath: async (pathname) => pathname,
      lstat: async () => ({
        mode: 0o750,
        isDirectory: () => true,
        isSymbolicLink: () => false,
      }),
    },
    processRegistry: { emulators: new Map(), recorders: new Map() },
    inspectProcess: async () => null,
    stopEmulator: async () => {},
    runCommand: async () => {
      commandCalled = true;
      return result("Available Android Virtual Devices:\n");
    },
  });
  await assert.rejects(dependencies.runtime.inspectAvds(), /must have mode 0700/);
  assert.equal(commandCalled, false);
});

function avdRuntimeHarness({ records, liveIdentity = "4242:100000" }) {
  const processRegistry = {
    emulators: new Map(records.map((record, index) => [`record-${index}`, record])),
    recorders: new Map(),
  };
  const stopped = [];
  const inspected = [];
  let stoppedChild = false;
  const dependencies = lifecycleOperations.createAvdLifecycleDeps({
    avdRoot: "/private/acp-run/avds",
    adbPath: "/tools/adb",
    emulatorPath: "/tools/emulator",
    avdmanagerPath: "/tools/avdmanager",
  }, {
    fs: {},
    processRegistry,
    runCommand: async () => result(),
    inspectProcess: async (pid) => {
      inspected.push(pid);
      return stoppedChild
        ? null
        : { pid, processStartIdentity: liveIdentity, alive: true };
    },
    stopEmulator: async (binding) => {
      stopped.push(binding);
      stoppedChild = true;
      const entry = [...processRegistry.emulators.entries()].find(([, record]) => (
        record.avdName === binding.avdName && record.child === binding.child
      ));
      if (entry) processRegistry.emulators.delete(entry[0]);
    },
  });
  return { dependencies, processRegistry, stopped, inspected };
}

test("exact emulator kill rejects PID reuse and ambiguous registry identities before mutation", async (t) => {
  const identity = Object.freeze({
    avdName: "acp-demo-flow-run-nonce-0123456789ab",
    serial: "emulator-5554",
    consolePort: 5554,
    pid: 4242,
    processStartIdentity: "4242:100000",
  });

  await t.test("kills only the immediately reverified PID and removes its exact registry entry", async () => {
    const child = { pid: 4242, kill: () => assert.fail("lifecycle must not signal child directly") };
    const harness = avdRuntimeHarness({ records: [{ ...identity, child }] });
    await harness.dependencies.runtime.killEmulator(identity);
    assert.deepEqual(harness.stopped, [{ ...identity, child }]);
    assert.deepEqual(harness.inspected, [4242, 4242]);
    assert.equal(harness.processRegistry.emulators.size, 0);
  });

  await t.test("PID reuse", async () => {
    const harness = avdRuntimeHarness({
      records: [{ ...identity, child: { pid: 4242 } }],
      liveIdentity: "4242:later-process",
    });
    await assert.rejects(
      harness.dependencies.runtime.killEmulator(identity),
      /PID 4242 was reused or changed start identity/,
    );
    assert.deepEqual(harness.stopped, []);
    assert.equal(harness.processRegistry.emulators.size, 1);
  });

  await t.test("ambiguous tracked identities", async () => {
    const harness = avdRuntimeHarness({
      records: [
        { ...identity, child: { pid: 4242 } },
        { ...identity, child: { pid: 4242 } },
      ],
    });
    await assert.rejects(
      harness.dependencies.runtime.killEmulator(identity),
      /tracked emulator identity is ambiguous/,
    );
    assert.deepEqual(harness.stopped, []);
    assert.equal(harness.processRegistry.emulators.size, 2);
  });
});

test("emulator absence proof rejects live, reused, and foreign identities without signaling", async (t) => {
  const identity = Object.freeze({
    avdName: "acp-demo-flow-run-nonce-0123456789ab",
    serial: "emulator-5554",
    consolePort: 5554,
    pid: 4242,
    processStartIdentity: "4242:100000",
  });
  const config = {
    avdRoot: "/private/acp-run/avds",
    adbPath: "/tools/adb",
    emulatorPath: "/tools/emulator",
    avdmanagerPath: "/tools/avdmanager",
  };
  const privateRootFs = {
    async realpath(pathname) { return pathname; },
    async lstat() {
      return {
        mode: 0o700,
        isDirectory: () => true,
        isSymbolicLink: () => false,
      };
    },
  };

  const create = ({ adbRows = "", avdNames = {}, inspectProcess, records = [] }) => {
    const commands = [];
    let stopCalls = 0;
    const dependencies = lifecycleOperations.createAvdLifecycleDeps(config, {
      fs: privateRootFs,
      processRegistry: {
        emulators: new Map(records.map((record, index) => [`record-${index}`, record])),
        recorders: new Map(),
      },
      inspectProcess,
      stopEmulator: async () => { stopCalls += 1; },
      runCommand: async (executable, args) => {
        commands.push({ executable, args });
        assert.equal(executable, "/tools/adb");
        if (args[0] === "devices") {
          return result(`List of devices attached\n${adbRows}`);
        }
        const serial = args[1];
        assert.deepEqual(args, ["-s", serial, "emu", "avd", "name"]);
        return result(`${avdNames[serial]}\nOK\n`);
      },
    });
    return { dependencies, commands, stopCalls: () => stopCalls };
  };

  await t.test("proves exact absence only when PID, registry, serial, and AVD name are all absent", async () => {
    const harness = create({ inspectProcess: async () => null });
    await harness.dependencies.runtime.assertEmulatorAbsent(identity);
    assert.deepEqual(harness.commands, [{ executable: "/tools/adb", args: ["devices"] }]);
    assert.equal(harness.stopCalls(), 0);
  });

  await t.test("refuses a still-live exact process", async () => {
    const harness = create({
      inspectProcess: async () => ({
        pid: identity.pid,
        processStartIdentity: identity.processStartIdentity,
        alive: true,
      }),
    });
    await assert.rejects(
      harness.dependencies.runtime.assertEmulatorAbsent(identity),
      /exact emulator process is still live/i,
    );
    assert.equal(harness.stopCalls(), 0);
  });

  await t.test("refuses a reused PID", async () => {
    const harness = create({
      inspectProcess: async () => ({
        pid: identity.pid,
        processStartIdentity: "4242:later-process",
        alive: true,
      }),
    });
    await assert.rejects(
      harness.dependencies.runtime.assertEmulatorAbsent(identity),
      /reused or changed start identity/i,
    );
    assert.equal(harness.stopCalls(), 0);
  });

  await t.test("refuses a foreign emulator reusing the bound serial", async () => {
    const harness = create({
      adbRows: `${identity.serial}\tdevice\n`,
      avdNames: { [identity.serial]: "foreign-avd" },
      inspectProcess: async () => null,
    });
    await assert.rejects(
      harness.dependencies.runtime.assertEmulatorAbsent(identity),
      /serial.*belongs to a live emulator|foreign|collision/i,
    );
    assert.equal(harness.stopCalls(), 0);
  });

  await t.test("refuses another serial running the owned AVD", async () => {
    const harness = create({
      adbRows: "emulator-5556\tdevice\n",
      avdNames: { "emulator-5556": identity.avdName },
      inspectProcess: async () => null,
    });
    await assert.rejects(
      harness.dependencies.runtime.assertEmulatorAbsent(identity),
      /AVD name.*live emulator|foreign|collision/i,
    );
    assert.equal(harness.stopCalls(), 0);
  });
});

test("AVD deletion re-verifies the exact generated name, private path, and image around avdmanager", async () => {
  const avdRoot = "/private/acp-run/avds";
  const avdName = "acp-demo-flow-run-nonce-0123456789ab";
  const systemImage = "system-images;android-35;google_apis;x86_64";
  const fixture = avdFilesystem({ avdRoot, avdName, systemImage });
  let deleted = false;
  const calls = [];
  const processIdentity = {
    avdName,
    serial: "emulator-5554",
    consolePort: 5554,
    pid: 4242,
    processStartIdentity: "owned-start",
  };
  const dependencies = lifecycleOperations.createAvdLifecycleDeps({
    avdRoot,
    adbPath: "/tools/adb",
    emulatorPath: "/tools/emulator",
    avdmanagerPath: "/tools/avdmanager",
  }, {
    fs: fixture.fs,
    processRegistry: { emulators: new Map(), recorders: new Map() },
    inspectProcess: async () => null,
    stopEmulator: async () => assert.fail("AVD deletion must not stop a child"),
    runCommand: async (executable, args, options) => {
      calls.push({ executable, args, options });
      if (executable === "/tools/adb") {
        assert.deepEqual(args, ["devices"]);
        return result("List of devices attached\n");
      }
      assert.equal(executable, "/tools/avdmanager");
      assert.equal(options.env.ANDROID_AVD_HOME, avdRoot);
      if (args[0] === "list") {
        return result(deleted ? "Available Android Virtual Devices:\n" : [
          "Available Android Virtual Devices:",
          `    Name: ${avdName}`,
          `    Path: ${fixture.avdPath}`,
          "---------",
          "",
        ].join("\n"));
      }
      assert.deepEqual(args, ["delete", "avd", "--name", avdName]);
      deleted = true;
      fixture.removeAvd();
      return result();
    },
  });

  await assert.rejects(dependencies.runtime.deleteAvd({
    avdName,
    avdPath: fixture.avdPath,
    systemImage,
  }), /exact bound emulator absence identity/);

  await dependencies.runtime.deleteAvd({
    avdName,
    avdPath: fixture.avdPath,
    systemImage,
  }, processIdentity);
  assert.deepEqual(calls.map(({ args }) => args), [
    ["list", "avd"],
    ["devices"],
    ["delete", "avd", "--name", avdName],
    ["list", "avd"],
  ]);
});

async function temporaryDirectory(t, label) {
  const directory = await mkdtemp(path.join(tmpdir(), `${label}-`));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return realpath(directory);
}

test("production Kind adapter completes an already-deleted deletion-pending retry", async (t) => {
  const markerRoot = await temporaryDirectory(t, "kind-production-pending-retry");
  const containerIdentity = "sha256:owned-control-plane";
  let clusterPresent = false;
  let ownership;
  const runCommand = async (executable, args) => {
    if (executable === "/bin/ps") {
      return result("Sat Jul 18 11:00:00 2026 /usr/bin/node --test\n");
    }
    if (executable === "/tools/kind") {
      assert.deepEqual(args, ["get", "clusters"]);
      return result(clusterPresent ? `${ownership.clusterName}\n` : "");
    }
    if (executable === "/tools/kubectl" && args.includes("get-contexts")) {
      return result(clusterPresent ? `${ownership.kubeContext}\n` : "");
    }
    if (executable === "/tools/kubectl" && args.includes("view")) {
      if (!args.includes("--minify")) {
        return result(JSON.stringify({ clusters: [] }));
      }
      return result(JSON.stringify({
        "current-context": ownership.kubeContext,
        contexts: [{
          name: ownership.kubeContext,
          context: { cluster: "owned-cluster" },
        }],
        clusters: [{
          name: "owned-cluster",
          cluster: { server: "https://127.0.0.1:61443" },
        }],
      }));
    }
    if (executable === "/tools/kubectl" && args.includes("nodes")) {
      return result(JSON.stringify({
        items: [{ status: { conditions: [{ type: "Ready", status: "True" }] } }],
      }));
    }
    if (executable === "/tools/docker" && args[0] === "ps") {
      return result(clusterPresent ? `${containerIdentity}\n` : "");
    }
    if (executable === "/tools/docker" && args[0] === "inspect") {
      return result(JSON.stringify([{
        Id: containerIdentity,
        Config: { Labels: { "io.x-k8s.kind.cluster": ownership.clusterName } },
      }]));
    }
    throw new Error(`unexpected command: ${executable} ${args.join(" ")}`);
  };
  const lifecycle = lifecycleOperations.createKindLifecycleDeps({
    kubeconfigPath: path.join(markerRoot, "kubeconfig"),
    dockerPath: "/tools/docker",
    kindPath: "/tools/kind",
    kubectlPath: "/tools/kubectl",
  }, {
    currentProcessPid: 7373,
    runCommand,
  });
  ownership = await reserveKindClusterOwnership({
    scenarioId: "flow",
    runId: "run",
    nonce: "pending-retry",
    markerRoot,
  }, lifecycle);
  const pendingCreation = await beginKindClusterCreation(ownership, lifecycle);
  clusterPresent = true;
  const creation = await completeKindClusterCreation(ownership, {
    ...lifecycle,
    creationTransaction: pendingCreation,
    createdContainerIdentities: [containerIdentity],
  });
  const bound = await bindKindCluster(ownership, {
    ...lifecycle,
    creationTransaction: creation,
  });
  let deletionCalls = 0;
  await assert.rejects(teardownOwnedKindCluster(bound, {
    ...lifecycle,
    deleteKindCluster: async () => {
      deletionCalls += 1;
      clusterPresent = false;
      throw new Error("synthetic post-delete command failure");
    },
  }), /synthetic post-delete command failure/);
  assert.equal(
    JSON.parse(await readFile(bound.markerPath, "utf8")).teardownPhase,
    "kind-delete-pending",
  );

  const retryResult = await teardownOwnedKindCluster(bound, {
    ...lifecycle,
    deleteKindCluster: async () => { deletionCalls += 1; },
  });

  assert.equal(retryResult.action, "deleted");
  assert.equal(deletionCalls, 1);
  await assert.rejects(access(bound.markerPath), { code: "ENOENT" });
});

test("reserved Kind rollback never name-deletes an unbound cluster or context", async (t) => {
  const markerRoot = await temporaryDirectory(t, "kind-reserved-rollback");
  const reservation = await reserveKindClusterOwnership({
    scenarioId: "flow",
    runId: "run",
    nonce: "nonce",
    markerRoot,
  }, {
    inspectKindCluster: async () => ({ kindClusterNames: [], kubeContexts: [] }),
  });
  let present = true;
  const dependencies = lifecycleOperations.createKindLifecycleDeps({
    kubeconfigPath: path.join(markerRoot, "kubeconfig"),
    dockerPath: "/tools/docker",
    kindPath: "/tools/kind",
    kubectlPath: "/tools/kubectl",
  }, {
    runCommand: async (executable, args) => {
      if (executable === "/tools/kind") {
        return result(present ? `${reservation.clusterName}\n` : "");
      }
      assert.ok(args.includes("get-contexts"));
      return result(present ? `${reservation.kubeContext}\n` : "");
    },
  });

  await assert.rejects(
    dependencies.rollbackUnboundKindCluster(reservation),
    /unbound.*provenance|refusing.*delete|exact.*identit/i,
  );
  assert.match(await readFile(reservation.markerPath, "utf8"), /android\.kind/u);

  present = false;
  const rolledBack = await dependencies.rollbackUnboundKindCluster(reservation);
  assert.deepEqual(rolledBack, {
    action: "rolled-back",
    clusterName: reservation.clusterName,
    resourceDeleted: false,
  });
  await assert.rejects(access(reservation.markerPath), { code: "ENOENT" });

  const raced = await reserveKindClusterOwnership({
    scenarioId: "flow",
    runId: "marker-race",
    nonce: "nonce",
    markerRoot,
  }, {
    inspectKindCluster: async () => ({ kindClusterNames: [], kubeContexts: [] }),
  });
  const racedMarker = await readFile(raced.markerPath, "utf8");
  let kindInspections = 0;
  const racedDeps = lifecycleOperations.createKindLifecycleDeps({
    kubeconfigPath: path.join(markerRoot, "kubeconfig"),
    dockerPath: "/tools/docker",
    kindPath: "/tools/kind",
    kubectlPath: "/tools/kubectl",
  }, {
    runCommand: async (executable) => {
      if (executable === "/tools/kind") {
        kindInspections += 1;
        if (kindInspections === 2) {
          const replacementPath = `${raced.markerPath}.foreign`;
          await writeFile(replacementPath, racedMarker, { mode: 0o600 });
          await rename(replacementPath, raced.markerPath);
        }
      }
      return result("");
    },
  });
  await assert.rejects(
    racedDeps.rollbackUnboundKindCluster(raced),
    /marker.*file identity.*changed|marker.*replaced/i,
  );
  assert.equal(await readFile(raced.markerPath, "utf8"), racedMarker);

  const ambiguous = await reserveKindClusterOwnership({
    scenarioId: "flow",
    runId: "ambiguous",
    nonce: "nonce",
    markerRoot,
  }, {
    inspectKindCluster: async () => ({ kindClusterNames: [], kubeContexts: [] }),
  });
  const ambiguousDeps = lifecycleOperations.createKindLifecycleDeps({
    kubeconfigPath: path.join(markerRoot, "kubeconfig"),
    dockerPath: "/tools/docker",
    kindPath: "/tools/kind",
    kubectlPath: "/tools/kubectl",
  }, {
    runCommand: async (executable) => result(executable === "/tools/kind"
      ? `${ambiguous.clusterName}\n${ambiguous.clusterName}\n`
      : `${ambiguous.kubeContext}\n`),
  });
  await assert.rejects(
    ambiguousDeps.rollbackUnboundKindCluster(ambiguous),
    /cluster list is ambiguous/,
  );
  assert.match(await readFile(ambiguous.markerPath, "utf8"), /android\.kind/);
});

test("reserved AVD rollback deletes only unchanged proven creation after proving no live emulator", async (t) => {
  const root = await temporaryDirectory(t, "avd-reserved-rollback");
  const avdRoot = path.join(root, "avds");
  const markerRoot = path.join(root, "markers");
  await mkdir(avdRoot, { mode: 0o700 });
  await mkdir(markerRoot, { mode: 0o700 });
  const systemImage = "system-images;android-35;google_apis;x86_64";
  const ownership = await reserveAvdOwnership({
    scenarioId: "flow",
    runId: "run",
    nonce: "nonce",
    avdRoot,
    markerRoot,
    systemImage,
  }, { runtime: { inspectAvds: async () => [] } });
  const definitionPath = path.join(avdRoot, `${ownership.avdName}.ini`);
  const configPath = path.join(ownership.avdPath, "config.ini");
  await mkdir(ownership.avdPath, { mode: 0o700 });
  await writeFile(definitionPath, `path=${ownership.avdPath}\n`, { mode: 0o600 });
  await writeFile(configPath, [
    `AvdId=${ownership.avdName}`,
    `image.sysdir.1=${systemImage.replaceAll(";", "/")}/`,
    "",
  ].join("\n"), { mode: 0o600 });
  let present = true;
  let liveUntrackedEmulator = false;
  const processRegistry = { emulators: new Map(), recorders: new Map() };
  const dependencies = lifecycleOperations.createAvdLifecycleDeps({
    avdRoot,
    adbPath: "/tools/adb",
    emulatorPath: "/tools/emulator",
    avdmanagerPath: "/tools/avdmanager",
  }, {
    processRegistry,
    inspectProcess: async () => null,
    stopEmulator: async () => {},
    runCommand: async (executable, args) => {
      if (executable === "/tools/adb") {
        if (args[0] === "devices") {
          return result(liveUntrackedEmulator
            ? "List of devices attached\nemulator-5554\tdevice\n"
            : "List of devices attached\n");
        }
        assert.deepEqual(args, ["-s", "emulator-5554", "emu", "avd", "name"]);
        return result(`${ownership.avdName}\nOK\n`);
      }
      assert.equal(executable, "/tools/avdmanager");
      if (args[0] === "list") {
        return result(present ? [
          `Name: ${ownership.avdName}`,
          `Path: ${ownership.avdPath}`,
          "---------",
        ].join("\n") : "Available Android Virtual Devices:\n");
      }
      assert.deepEqual(args, ["delete", "avd", "--name", ownership.avdName]);
      present = false;
      await rm(ownership.avdPath, { recursive: true });
      await unlink(definitionPath);
      return result();
    },
  });
  await assert.rejects(
    dependencies.rollbackUnboundAvd(ownership),
    /creation proof/i,
  );
  await assert.rejects(
    dependencies.rollbackUnboundAvd(ownership, {
      creationProof: {
        version: 1,
        avdName: ownership.avdName,
        avdPath: ownership.avdPath,
        systemImage,
      },
    }),
    /creation proof/i,
  );
  assert.equal(present, true, "a same-name resource without creation provenance must be preserved");
  assert.match(await readFile(ownership.markerPath, "utf8"), /android-avd/);

  const creationProof = await dependencies.recordCreatedAvd(ownership);
  const originalConfig = [
    `AvdId=${ownership.avdName}`,
    `image.sysdir.1=${systemImage.replaceAll(";", "/")}/`,
    "",
  ].join("\n");
  await writeFile(configPath, `${originalConfig}foreign.race=true\n`, { mode: 0o600 });
  await assert.rejects(
    dependencies.rollbackUnboundAvd(ownership, { creationProof }),
    /creation identity changed|preserving resource/i,
  );
  assert.equal(present, true, "a replaced same-name AVD must be preserved");
  assert.match(await readFile(ownership.markerPath, "utf8"), /android-avd/);
  await writeFile(configPath, originalConfig, { mode: 0o600 });

  liveUntrackedEmulator = true;
  await assert.rejects(
    dependencies.rollbackUnboundAvd(ownership, { creationProof }),
    /live emulator|present process/i,
  );
  assert.equal(present, true);
  assert.match(await readFile(ownership.markerPath, "utf8"), /android-avd/);

  liveUntrackedEmulator = false;
  const rolledBack = await dependencies.rollbackUnboundAvd(ownership, { creationProof });
  assert.deepEqual(rolledBack, {
    action: "rolled-back",
    avdName: ownership.avdName,
    resourceDeleted: true,
  });
  assert.equal(present, false);
  await assert.rejects(access(ownership.avdPath), { code: "ENOENT" });
  await assert.rejects(access(definitionPath), { code: "ENOENT" });
  await assert.rejects(access(ownership.markerPath), { code: "ENOENT" });

  const ambiguous = await reserveAvdOwnership({
    scenarioId: "flow",
    runId: "ambiguous",
    nonce: "nonce",
    avdRoot,
    markerRoot,
    systemImage,
  }, { runtime: { inspectAvds: async () => [] } });
  const ambiguousDeps = lifecycleOperations.createAvdLifecycleDeps({
    avdRoot,
    adbPath: "/tools/adb",
    emulatorPath: "/tools/emulator",
    avdmanagerPath: "/tools/avdmanager",
  }, {
    processRegistry: { emulators: new Map(), recorders: new Map() },
    inspectProcess: async () => null,
    stopEmulator: async () => {},
    runCommand: async (_executable, args) => {
      assert.equal(args[0], "list");
      return result([
        `Name: ${ambiguous.avdName}`,
        `Path: ${path.join(avdRoot, "wrong.avd")}`,
        "---------",
        "Name: wrong-name",
        `Path: ${ambiguous.avdPath}`,
        "---------",
      ].join("\n"));
    },
  });
  await assert.rejects(ambiguousDeps.rollbackUnboundAvd(ambiguous), /identity is ambiguous/);
  assert.match(await readFile(ambiguous.markerPath, "utf8"), /android-avd/);
});

test("unbound AVD rollback retry removes the marker after a delete command removed the AVD then failed", async (t) => {
  const root = await temporaryDirectory(t, "avd-rollback-retry");
  const avdRoot = path.join(root, "avds");
  const markerRoot = path.join(root, "markers");
  await mkdir(avdRoot, { mode: 0o700 });
  await mkdir(markerRoot, { mode: 0o700 });
  const systemImage = "system-images;android-35;google_apis;x86_64";
  const ownership = await reserveAvdOwnership({
    scenarioId: "flow",
    runId: "retry",
    nonce: "nonce",
    avdRoot,
    markerRoot,
    systemImage,
  }, { runtime: { inspectAvds: async () => [] } });
  const definitionPath = path.join(avdRoot, `${ownership.avdName}.ini`);
  const configPath = path.join(ownership.avdPath, "config.ini");
  await mkdir(ownership.avdPath, { mode: 0o700 });
  await writeFile(definitionPath, `path=${ownership.avdPath}\n`, { mode: 0o600 });
  await writeFile(configPath, [
    `AvdId=${ownership.avdName}`,
    `image.sysdir.1=${systemImage.replaceAll(";", "/")}/`,
    "",
  ].join("\n"), { mode: 0o600 });
  let present = true;
  let deletes = 0;
  const dependencies = lifecycleOperations.createAvdLifecycleDeps({
    avdRoot,
    adbPath: "/tools/adb",
    emulatorPath: "/tools/emulator",
    avdmanagerPath: "/tools/avdmanager",
  }, {
    processRegistry: { emulators: new Map(), recorders: new Map() },
    inspectProcess: async () => null,
    stopEmulator: async () => {},
    runCommand: async (executable, args) => {
      if (executable === "/tools/adb") return result("List of devices attached\n");
      if (args[0] === "list") {
        return result(present ? [
          `Name: ${ownership.avdName}`,
          `Path: ${ownership.avdPath}`,
          "---------",
        ].join("\n") : "Available Android Virtual Devices:\n");
      }
      deletes += 1;
      present = false;
      await rm(ownership.avdPath, { recursive: true });
      await unlink(definitionPath);
      throw new Error("avdmanager transport failed after deletion");
    },
  });
  const creationProof = await dependencies.recordCreatedAvd(ownership);

  await assert.rejects(
    dependencies.rollbackUnboundAvd(ownership, { creationProof }),
    /transport failed after deletion/,
  );
  assert.equal(deletes, 1);
  assert.match(await readFile(ownership.markerPath, "utf8"), /android-avd/);

  const retried = await dependencies.rollbackUnboundAvd(ownership, { creationProof });
  assert.deepEqual(retried, {
    action: "rolled-back",
    avdName: ownership.avdName,
    resourceDeleted: false,
  });
  assert.equal(deletes, 1, "retry must not issue another name deletion after absence is proven");
  await assert.rejects(access(ownership.markerPath), { code: "ENOENT" });
});
