import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import * as defaultFs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { promisify } from "node:util";

import {
  createHostProcessInspector,
  HOST_PROCESS_OUTPUT_BYTES,
} from "./host-process-identity.mjs";

const execFileAsync = promisify(execFile);
const COMMAND_TIMEOUT_MILLISECONDS = 15_000;
const COMMAND_MAX_BUFFER_BYTES = 1024 * 1024;
const MAX_KIND_LIST_ITEMS = 1_000;
const MAX_KIND_STATE_BYTES = 1024 * 1024;
const KIND_CLUSTER_LABEL = "io.x-k8s.kind.cluster";
const TOOL_ENVIRONMENT_KEYS = Object.freeze([
  "PATH",
  "HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "JAVA_HOME",
  "ANDROID_HOME",
  "ANDROID_SDK_ROOT",
  "DOCKER_HOST",
  "DOCKER_CONTEXT",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
]);

function requiredString(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}

function requiredAbsolutePath(value, name) {
  const pathname = requiredString(value, name);
  if (!path.isAbsolute(pathname) || path.resolve(pathname) !== pathname || pathname.includes("\0")) {
    throw new Error(`${name} must be a normalized absolute path`);
  }
  return pathname;
}

function slugKindIdentity(value, name) {
  const normalized = requiredString(value, name)
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  if (!normalized) throw new Error(`${name} must contain an ASCII letter or digit`);
  return normalized;
}

function generatedKindName(scenarioId, runId, nonce) {
  const parts = [
    slugKindIdentity(scenarioId, "scenarioId"),
    slugKindIdentity(runId, "runId"),
    slugKindIdentity(nonce, "nonce"),
  ];
  const fullName = `acp-demo-${parts.join("-")}`;
  if (fullName.length <= 63) return fullName;
  const digest = createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 10);
  return `acp-demo-${parts[0].slice(0, 12)}-${parts[1].slice(0, 10)}-${parts[2].slice(0, 16)}-${digest}`;
}

function generatedAvdName({ scenarioId, runId, nonce }) {
  const slug = (value, length) => value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, length)
    .replace(/-+$/gu, "") || "id";
  const digest = createHash("sha256")
    .update(JSON.stringify([scenarioId, runId, nonce]))
    .digest("hex")
    .slice(0, 12);
  return ["acp-demo", slug(scenarioId, 12), slug(runId, 12), slug(nonce, 8), digest].join("-");
}

function sameFlatObject(actual, expected) {
  if (!actual || typeof actual !== "object" || Array.isArray(actual)) return false;
  const actualKeys = Object.keys(actual).sort();
  const expectedKeys = Object.keys(expected).sort();
  return JSON.stringify(actualKeys) === JSON.stringify(expectedKeys)
    && expectedKeys.every((key) => actual[key] === expected[key]);
}

async function readExactUnboundMarker(fs, markerPath, expected, label) {
  const details = await fs.lstat(markerPath);
  if (!details.isFile() || details.isSymbolicLink() || (details.mode & 0o777) !== 0o600) {
    throw new Error(`${label} marker must be one mode-0600 regular file`);
  }
  let marker;
  try {
    marker = JSON.parse(await fs.readFile(markerPath, "utf8"));
  } catch (error) {
    throw new Error(`${label} marker is invalid: ${markerPath}`, { cause: error });
  }
  if (!sameFlatObject(marker, expected)) {
    throw new Error(`${label} unbound marker fields changed: ${markerPath}`);
  }
  return marker;
}

function exactFileIdentity(details, label) {
  if (
    !Number.isSafeInteger(details?.dev)
    || details.dev < 0
    || !Number.isSafeInteger(details?.ino)
    || details.ino < 1
    || !Number.isFinite(details?.ctimeMs)
  ) {
    throw new Error(`${label} file identity is unavailable`);
  }
  return `${details.dev}:${details.ino}:${details.ctimeMs}`;
}

async function readExactUnboundMarkerSnapshot(fs, markerPath, expected, label) {
  const before = exactFileIdentity(await fs.lstat(markerPath), `${label} marker`);
  const marker = await readExactUnboundMarker(fs, markerPath, expected, label);
  const after = exactFileIdentity(await fs.lstat(markerPath), `${label} marker`);
  if (before !== after) throw new Error(`${label} marker was replaced during inspection`);
  return Object.freeze({ marker, fileIdentity: before });
}

async function defaultRunCommand(executable, args, options) {
  return execFileAsync(executable, args, options);
}

function commandOutput(commandResult, commandName) {
  const output = commandResult?.stdout ?? commandResult;
  if (typeof output !== "string" && !Buffer.isBuffer(output)) {
    throw new Error(`${commandName} did not return bounded stdout`);
  }
  const text = String(output);
  if (Buffer.byteLength(text, "utf8") > COMMAND_MAX_BUFFER_BYTES) {
    throw new Error(`${commandName} output exceeds ${COMMAND_MAX_BUFFER_BYTES} bytes`);
  }
  return text;
}

function outputLines(commandResult, commandName) {
  const lines = commandOutput(commandResult, commandName)
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length > MAX_KIND_LIST_ITEMS) {
    throw new Error(`${commandName} returned more than ${MAX_KIND_LIST_ITEMS} entries`);
  }
  return lines;
}

function outputJson(commandResult, commandName) {
  const source = commandOutput(commandResult, commandName);
  try {
    return JSON.parse(source);
  } catch (error) {
    throw new Error(`${commandName} did not return valid JSON`, { cause: error });
  }
}

function sanitizedToolEnvironment(config, deps) {
  const authored = deps.toolEnvironment
    ?? config.toolEnvironment
    ?? deps.baseEnvironment
    ?? config.baseEnvironment
    ?? {};
  if (!authored || typeof authored !== "object" || Array.isArray(authored)) {
    throw new Error("toolEnvironment must be an object");
  }
  return Object.freeze(Object.fromEntries(
    TOOL_ENVIRONMENT_KEYS
      .filter((key) => typeof authored[key] === "string")
      .map((key) => [key, authored[key]]),
  ));
}

function commandOptions(environment) {
  return {
    encoding: "utf8",
    timeout: COMMAND_TIMEOUT_MILLISECONDS,
    maxBuffer: COMMAND_MAX_BUFFER_BYTES,
    env: environment,
  };
}

async function readPrivateJson(fs, pathname, label) {
  const [canonical, details] = await Promise.all([fs.realpath(pathname), fs.lstat(pathname)]);
  if (
    canonical !== pathname
    || details.isSymbolicLink()
    || !details.isFile()
    || (details.mode & 0o777) !== 0o600
    || details.size > MAX_KIND_STATE_BYTES
  ) throw new Error(`${label} must be one bounded mode-0600 regular file`);
  let value;
  try {
    value = JSON.parse(await fs.readFile(pathname, "utf8"));
  } catch (error) {
    throw new Error(`${label} must contain valid JSON`, { cause: error });
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must contain a JSON object`);
  }
  return value;
}

async function readPrivateText(fs, pathname, label) {
  const [canonical, details] = await Promise.all([fs.realpath(pathname), fs.lstat(pathname)]);
  if (
    canonical !== pathname
    || details.isSymbolicLink()
    || !details.isFile()
    || (details.mode & 0o777) !== 0o600
    || details.size > MAX_KIND_STATE_BYTES
  ) throw new Error(`${label} must be one bounded mode-0600 regular file`);
  const value = await fs.readFile(pathname, "utf8");
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > MAX_KIND_STATE_BYTES) {
    throw new Error(`${label} must contain bounded text`);
  }
  return value;
}

function escapePattern(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

async function defaultProbeLoopback(port) {
  return new Promise((resolve) => {
    const request = http.get({
      agent: false,
      family: 4,
      host: "127.0.0.1",
      path: "/",
      port,
      timeout: 3_000,
    }, (response) => {
      response.resume();
      response.once("end", () => resolve(true));
    });
    request.once("timeout", () => {
      request.destroy();
      resolve(false);
    });
    request.once("error", () => resolve(false));
  });
}

function exactKindRequest(request) {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw new Error("Kind inspection request is required");
  }
  const clusterName = requiredString(request.clusterName, "clusterName");
  const kubeContext = requiredString(request.kubeContext, "kubeContext");
  requiredString(request.phase, "phase");
  if (!/^acp-demo-[a-z0-9-]+$/u.test(clusterName)) {
    throw new Error(`Refusing non-generated Kind cluster name ${clusterName}`);
  }
  if (kubeContext !== `kind-${clusterName}`) {
    throw new Error(`Requested kube context does not match generated cluster ${clusterName}`);
  }
  return { clusterName, kubeContext };
}

function exactKubeServer(kubeConfig, kubeContext) {
  if (!kubeConfig || typeof kubeConfig !== "object" || Array.isArray(kubeConfig)) {
    throw new Error("kubectl config view returned an invalid object");
  }
  if (kubeConfig["current-context"] !== kubeContext) {
    throw new Error(`kubectl inspected context does not match requested context ${kubeContext}`);
  }
  const contexts = Array.isArray(kubeConfig.contexts)
    ? kubeConfig.contexts.filter((entry) => entry?.name === kubeContext)
    : [];
  if (contexts.length !== 1) {
    throw new Error(`kubectl config view did not resolve exactly one context ${kubeContext}`);
  }
  const clusterReference = requiredString(
    contexts[0]?.context?.cluster,
    `cluster reference for ${kubeContext}`,
  );
  const clusters = Array.isArray(kubeConfig.clusters)
    ? kubeConfig.clusters.filter((entry) => entry?.name === clusterReference)
    : [];
  if (clusters.length !== 1) {
    throw new Error(`kubectl config view did not resolve exactly one cluster for ${kubeContext}`);
  }
  return requiredString(clusters[0]?.cluster?.server, `server for ${kubeContext}`);
}

function allKubeServers(kubeConfig) {
  if (!kubeConfig || typeof kubeConfig !== "object" || !Array.isArray(kubeConfig.clusters)) {
    throw new Error("kubectl config view returned an invalid cluster list");
  }
  const servers = kubeConfig.clusters.map((entry, index) => requiredString(
    entry?.cluster?.server,
    `kube server ${index}`,
  ));
  if (new Set(servers).size !== servers.length) {
    throw new Error("kubectl config view returned ambiguous duplicate kube servers");
  }
  return servers;
}

function exactContainerIdentities(dockerInspection, clusterName, selectedContainerIds) {
  if (!Array.isArray(dockerInspection) || dockerInspection.length === 0) {
    throw new Error(`Kind cluster ${clusterName} has no Docker container identities`);
  }
  if (dockerInspection.length > MAX_KIND_LIST_ITEMS) {
    throw new Error(`Kind cluster ${clusterName} has too many Docker containers`);
  }
  const identities = dockerInspection.map((container, index) => {
    if (container?.Config?.Labels?.[KIND_CLUSTER_LABEL] !== clusterName) {
      throw new Error(`Docker container ${index} does not belong to exact Kind cluster ${clusterName}`);
    }
    return requiredString(container.Id, `Docker container identity ${index}`);
  });
  if (new Set(identities).size !== identities.length) {
    throw new Error(`Kind cluster ${clusterName} has duplicate Docker container identities`);
  }
  const canonical = identities.toSorted();
  if (JSON.stringify(canonical) !== JSON.stringify([...selectedContainerIds].toSorted())) {
    throw new Error(`Docker inspection does not match selected Docker containers for ${clusterName}`);
  }
  return canonical;
}

function nodesReady(nodeList) {
  if (!nodeList || typeof nodeList !== "object" || !Array.isArray(nodeList.items)) {
    throw new Error("kubectl node readiness response must contain an items array");
  }
  if (nodeList.items.length === 0 || nodeList.items.length > MAX_KIND_LIST_ITEMS) return false;
  return nodeList.items.every((node) => (
    Array.isArray(node?.status?.conditions)
    && node.status.conditions.some((condition) => (
      condition?.type === "Ready" && condition?.status === "True"
    ))
  ));
}

export function createKindLifecycleDeps(config = {}, deps = {}) {
  const kubeconfigPath = requiredAbsolutePath(config.kubeconfigPath, "kubeconfigPath");
  const dockerPath = requiredAbsolutePath(config.dockerPath, "dockerPath");
  const kindPath = requiredAbsolutePath(config.kindPath, "kindPath");
  const kubectlPath = requiredAbsolutePath(config.kubectlPath, "kubectlPath");
  const runCommand = deps.runCommand ?? config.runCommand ?? defaultRunCommand;
  const fs = deps.fs ?? config.fs ?? defaultFs;
  const probeLoopback = deps.probeLoopback ?? config.probeLoopback ?? defaultProbeLoopback;
  const authoredInspectProcess = deps.inspectProcess ?? config.inspectProcess;
  const currentProcessPid = deps.currentProcessPid ?? config.currentProcessPid ?? process.pid;
  const inspectKindProcess = deps.inspectKindProcess ?? config.inspectKindProcess ?? (async (pid) => {
    const read = async (field) => commandOutput(
      await runCommand(
        "/bin/ps",
        ["-o", `${field}=`, "-p", String(pid)],
        commandOptions(environment),
      ),
      `ps ${field} for Kind endpoint PID ${pid}`,
    ).trim();
    const [uidSource, startedAt, command] = await Promise.all([
      read("uid"),
      read("lstart"),
      read("command"),
    ]);
    const uid = Number(uidSource);
    if (!Number.isSafeInteger(uid) || uid < 0 || startedAt === "" || command === "") return null;
    return Object.freeze({ pid, uid, started_at: startedAt, command });
  });
  if (typeof runCommand !== "function") throw new Error("runCommand must be a function");
  if (typeof probeLoopback !== "function") throw new Error("probeLoopback must be a function");
  if (typeof inspectKindProcess !== "function") throw new Error("inspectKindProcess must be a function");
  if (authoredInspectProcess !== undefined && typeof authoredInspectProcess !== "function") {
    throw new Error("inspectProcess must be a function");
  }
  if (!Number.isInteger(currentProcessPid) || currentProcessPid < 1) {
    throw new Error("currentProcessPid must be a positive integer");
  }
  const environment = Object.freeze({
    ...sanitizedToolEnvironment(config, deps),
    HOME: path.dirname(kubeconfigPath),
  });
  const inspectProcess = authoredInspectProcess ?? createHostProcessInspector({
    runCommand,
    commandOptions: {
      ...commandOptions(environment),
      maxBuffer: HOST_PROCESS_OUTPUT_BYTES,
    },
  });

  const getMarkerUpdateOwner = async () => {
    const live = await inspectProcess(currentProcessPid);
    if (
      !live
      || live.alive !== true
      || live.pid !== currentProcessPid
      || typeof live.processStartIdentity !== "string"
      || live.processStartIdentity.trim() === ""
    ) {
      throw new Error("Current Kind marker update owner identity is unavailable or ambiguous");
    }
    return Object.freeze({
      pid: currentProcessPid,
      processStartIdentity: live.processStartIdentity,
    });
  };

  const inspectMarkerUpdateOwner = async (owner) => {
    if (!owner || typeof owner !== "object" || Array.isArray(owner)) {
      throw new Error("Kind marker update owner identity is required");
    }
    if (!Number.isInteger(owner.pid) || owner.pid < 1) {
      throw new Error("Kind marker update owner PID must be a positive integer");
    }
    requiredString(owner.processStartIdentity, "Kind marker update owner processStartIdentity");
    return inspectProcess(owner.pid);
  };

  const run = async (executable, args, name) => (
    Promise.resolve(runCommand(executable, [...args], commandOptions(environment)))
      .then((value) => ({ value, name }))
  );

  const inspectKindCluster = async (request) => {
      const { clusterName, kubeContext } = exactKindRequest(request);
      const [kindResult, contextResult] = await Promise.all([
        run(kindPath, ["get", "clusters"], "kind get clusters"),
        run(
          kubectlPath,
          ["--kubeconfig", kubeconfigPath, "config", "get-contexts", "-o", "name"],
          "kubectl context list",
        ),
      ]);
      const kindClusterNames = outputLines(kindResult.value, kindResult.name);
      const kubeContexts = outputLines(contextResult.value, contextResult.name);
      if (new Set(kindClusterNames).size !== kindClusterNames.length) {
        throw new Error("Kind cluster list is ambiguous because it contains duplicates");
      }
      if (new Set(kubeContexts).size !== kubeContexts.length) {
        throw new Error("Kubernetes context list is ambiguous because it contains duplicates");
      }
      const base = { kindClusterNames, kubeContexts };
      if (request.phase === "rollback-unbound" || request.phase === "rollback-proof") {
        return Object.freeze(base);
      }
      const requestedClusterPresent = kindClusterNames.includes(clusterName)
        && kubeContexts.includes(kubeContext);
      if (
        request.phase === "teardown-proof"
        || (request.phase === "teardown-delete" && !requestedClusterPresent)
      ) {
        const [configResult, containerListResult] = await Promise.all([
          run(
            kubectlPath,
            ["--kubeconfig", kubeconfigPath, "config", "view", "--raw", "-o", "json"],
            "kubectl full config view",
          ),
          run(
            dockerPath,
            [
              "ps",
              "--all",
              "--no-trunc",
              "--filter",
              `label=${KIND_CLUSTER_LABEL}=${clusterName}`,
              "--format",
              "{{.ID}}",
            ],
            "docker residual Kind container list",
          ),
        ]);
        const containerIds = outputLines(containerListResult.value, containerListResult.name);
        let containerIdentities = [];
        if (containerIds.length > 0) {
          const dockerResult = await run(
            dockerPath,
            ["inspect", ...containerIds],
            "docker residual Kind container inspection",
          );
          containerIdentities = exactContainerIdentities(
            outputJson(dockerResult.value, dockerResult.name),
            clusterName,
            containerIds,
          );
        }
        return Object.freeze({
          ...base,
          kubeServers: allKubeServers(outputJson(configResult.value, configResult.name)),
          containerIdentities,
        });
      }
      if (!requestedClusterPresent) {
        return Object.freeze(base);
      }

      const scopedKubectl = ["--kubeconfig", kubeconfigPath, "--context", kubeContext];
      const [configResult, containerListResult, readinessResult] = await Promise.all([
        run(
          kubectlPath,
          [...scopedKubectl, "config", "view", "--raw", "--minify", "-o", "json"],
          "kubectl scoped config view",
        ),
        run(
          dockerPath,
          [
            "ps",
            "--all",
            "--no-trunc",
            "--filter",
            `label=${KIND_CLUSTER_LABEL}=${clusterName}`,
            "--format",
            "{{.ID}}",
          ],
          "docker Kind container list",
        ),
        run(
          kubectlPath,
          [...scopedKubectl, "get", "nodes", "-o", "json", "--request-timeout=10s"],
          "kubectl node readiness",
        ),
      ]);
      const containerIds = outputLines(containerListResult.value, containerListResult.name);
      if (containerIds.length === 0) {
        throw new Error(`Kind cluster ${clusterName} has no Docker containers`);
      }
      const dockerResult = await run(
        dockerPath,
        ["inspect", ...containerIds],
        "docker Kind container inspection",
      );
      return Object.freeze({
        ...base,
        inspectedKubeContext: kubeContext,
        kubeServer: exactKubeServer(outputJson(configResult.value, configResult.name), kubeContext),
        containerIdentities: exactContainerIdentities(
          outputJson(dockerResult.value, dockerResult.name),
          clusterName,
          containerIds,
        ),
        ready: nodesReady(outputJson(readinessResult.value, readinessResult.name)),
      });
  };

  const readKindAcpEndpointEvidence = async (owned) => {
    const clusterName = requiredString(owned?.clusterName, "owned.clusterName");
    const kubeContext = requiredString(owned?.kubeContext, "owned.kubeContext");
    const kubeServer = requiredString(owned?.kubeServer, "owned.kubeServer");
    const containerIdentities = Array.isArray(owned?.containerIdentities)
      ? owned.containerIdentities.map((identity) => requiredString(identity, "owned container identity")).toSorted()
      : [];
    if (containerIdentities.length === 0 || kubeContext !== `kind-${clusterName}`) {
      throw new Error("Owned Kind endpoint request is incomplete");
    }
    const kindStateRoot = requiredAbsolutePath(config.kindStateRoot, "kindStateRoot");
    const hostPort = config.backendPort;
    if (!Number.isInteger(hostPort) || hostPort < 1024 || hostPort > 65535) {
      throw new Error("backendPort must be an unprivileged TCP port");
    }
    const canonicalStateRoot = await fs.realpath(kindStateRoot);
    const rootDetails = await fs.lstat(kindStateRoot);
    if (
      canonicalStateRoot !== kindStateRoot
      || rootDetails.isSymbolicLink()
      || !rootDetails.isDirectory()
      || (rootDetails.mode & 0o777) !== 0o700
    ) throw new Error("kindStateRoot must be one mode-0700 canonical directory");
    const stateDirectory = path.join(kindStateRoot, clusterName);
    const stateDirectoryDetails = await fs.lstat(stateDirectory);
    if (
      stateDirectoryDetails.isSymbolicLink()
      || !stateDirectoryDetails.isDirectory()
      || (stateDirectoryDetails.mode & 0o777) !== 0o700
    ) throw new Error("Kind endpoint state directory must be mode 0700");
    const state = await readPrivateJson(
      fs,
      path.join(stateDirectory, "connection-state.json"),
      "Kind connection state",
    );
    const expectedApiUrl = `http://localhost:${hostPort}`;
    const descriptorVerified = state.version === 1
      && state.cluster === clusterName
      && state.context === kubeContext
      && state.namespace === "ambient-code"
      && state.api_url === expectedApiUrl
      && state.ports?.backend === hostPort;
    const processes = await readPrivateJson(
      fs,
      path.join(stateDirectory, "port-forward-processes.json"),
      "Kind port-forward process state",
    );
    const backend = processes.backend;
    const pidSource = await readPrivateText(
      fs,
      path.join(stateDirectory, "kind-pf-backend.pid"),
      "Kind backend PID state",
    );
    const pid = Number(String(pidSource).trim());
    const expectedCommand = new RegExp(
      `(?:^|\\s)(?:\\S*/)?kubectl\\s+--context\\s+${escapePattern(kubeContext)}`
        + `\\s+port-forward\\s+-n\\s+ambient-code\\s+svc/ambient-api-server`
        + `\\s+${hostPort}:8000(?:\\s|$)`,
      "u",
    );
    const liveProcess = Number.isSafeInteger(backend?.pid) && backend.pid > 0
      ? await inspectKindProcess(backend.pid)
      : null;
    const processIdentityVerified = Number.isSafeInteger(backend?.pid)
      && backend.pid > 0
      && pid === backend.pid
      && Number.isSafeInteger(backend.uid)
      && backend.uid >= 0
      && typeof backend.started_at === "string"
      && backend.started_at.length > 0
      && typeof backend.command === "string"
      && expectedCommand.test(backend.command)
      && liveProcess?.pid === backend.pid
      && liveProcess.uid === backend.uid
      && liveProcess.started_at === backend.started_at
      && liveProcess.command === backend.command
      && expectedCommand.test(liveProcess.command);
    const reachable = descriptorVerified
      && processIdentityVerified
      && await probeLoopback(hostPort) === true;
    return Object.freeze({
      clusterName,
      kubeContext,
      kubeServer,
      containerIdentities,
      hostPort,
      descriptorVerified,
      processIdentityVerified,
      reachable,
    });
  };

  const rollbackUnboundKindCluster = async (reservation) => {
    if (!reservation || typeof reservation !== "object" || Array.isArray(reservation)) {
      throw new Error("Unbound Kind reservation is required");
    }
    const scenarioId = requiredString(reservation.scenarioId, "reservation.scenarioId");
    const runId = requiredString(reservation.runId, "reservation.runId");
    const nonce = requiredString(reservation.nonce, "reservation.nonce");
    const clusterName = generatedKindName(scenarioId, runId, nonce);
    const kubeContext = `kind-${clusterName}`;
    const markerRoot = requiredAbsolutePath(reservation.markerRoot, "reservation.markerRoot");
    const markerPath = requiredAbsolutePath(reservation.markerPath, "reservation.markerPath");
    if (
      reservation.version !== 1
      || reservation.toolNamespace !== "acp.demo-creator.android.kind"
      || reservation.clusterName !== clusterName
      || reservation.kubeContext !== kubeContext
      || markerPath !== path.join(markerRoot, `${clusterName}.owner.json`)
    ) {
      throw new Error("Unbound Kind reservation identity is not exact");
    }
    const expectedMarker = {
      version: 1,
      toolNamespace: "acp.demo-creator.android.kind",
      scenarioId,
      runId,
      nonce,
      clusterName,
    };
    const initialMarker = await readExactUnboundMarkerSnapshot(
      fs,
      markerPath,
      expectedMarker,
      "Kind",
    );
    const inspection = await inspectKindCluster({
      phase: "rollback-unbound",
      clusterName,
      kubeContext,
    });
    const resourcePresent = inspection.kindClusterNames.includes(clusterName)
      || inspection.kubeContexts.includes(kubeContext);
    if (resourcePresent) {
      throw new Error(
        `Refusing to delete unbound Kind resources without exact container identity provenance: ${clusterName}`,
      );
    }
    const proof = await inspectKindCluster({ phase: "rollback-proof", clusterName, kubeContext });
    if (
      proof.kindClusterNames.includes(clusterName)
      || proof.kubeContexts.includes(kubeContext)
    ) {
      throw new Error(`Unbound Kind rollback did not prove absence: ${clusterName}`);
    }
    const finalMarker = await readExactUnboundMarkerSnapshot(
      fs,
      markerPath,
      expectedMarker,
      "Kind",
    );
    if (finalMarker.fileIdentity !== initialMarker.fileIdentity) {
      throw new Error("Kind marker file identity changed before removal");
    }
    await fs.unlink(markerPath);
    return Object.freeze({ action: "rolled-back", clusterName, resourceDeleted: false });
  };

  return Object.freeze({
    getMarkerUpdateOwner,
    inspectKindCluster,
    inspectMarkerUpdateOwner,
    readKindAcpEndpointEvidence,
    rollbackUnboundKindCluster,
  });
}

async function canonicalAvdRoot(fs, avdRoot) {
  const canonical = await fs.realpath(avdRoot);
  if (canonical !== avdRoot || path.resolve(canonical) !== canonical) {
    throw new Error(`avdRoot must be canonical and private: ${avdRoot}`);
  }
  const rootStat = await fs.lstat(canonical);
  if (
    !rootStat.isDirectory()
    || rootStat.isSymbolicLink()
    || (rootStat.mode & 0o777) !== 0o700
  ) {
    if ((rootStat.mode & 0o777) !== 0o700) {
      throw new Error(`avdRoot must have mode 0700: ${canonical}`);
    }
    throw new Error(`avdRoot must be a real directory: ${canonical}`);
  }
  return canonical;
}

function parseAvdSummaries(commandResult) {
  const lines = commandOutput(commandResult, "avdmanager list avd").split(/\r?\n/u);
  const summaries = [];
  let summary = {};
  const finish = () => {
    if (Object.keys(summary).length === 0) return;
    if (!summary.avdName || !summary.avdPath) {
      throw new Error("avdmanager returned an incomplete AVD summary");
    }
    summaries.push(summary);
    summary = {};
  };
  for (const line of lines) {
    const nameMatch = /^\s*Name:\s*(\S(?:.*\S)?)\s*$/u.exec(line);
    const pathMatch = /^\s*Path:\s*(\S(?:.*\S)?)\s*$/u.exec(line);
    if (nameMatch) {
      if (summary.avdName) finish();
      summary.avdName = nameMatch[1];
    } else if (pathMatch) {
      if (summary.avdPath) throw new Error("avdmanager returned an ambiguous AVD path");
      summary.avdPath = pathMatch[1];
    } else if (/^-{3,}\s*$/u.test(line)) {
      finish();
    }
  }
  finish();
  if (summaries.length > MAX_KIND_LIST_ITEMS) {
    throw new Error(`avdmanager returned more than ${MAX_KIND_LIST_ITEMS} AVDs`);
  }
  const names = summaries.map(({ avdName }) => avdName);
  const paths = summaries.map(({ avdPath }) => avdPath);
  if (new Set(names).size !== names.length || new Set(paths).size !== paths.length) {
    throw new Error("avdmanager returned ambiguous duplicate AVD identities");
  }
  return summaries;
}

function parseIni(source, configPath) {
  if (typeof source !== "string" && !Buffer.isBuffer(source)) {
    throw new Error(`AVD config is not text: ${configPath}`);
  }
  const text = String(source);
  if (Buffer.byteLength(text, "utf8") > COMMAND_MAX_BUFFER_BYTES) {
    throw new Error(`AVD config exceeds ${COMMAND_MAX_BUFFER_BYTES} bytes: ${configPath}`);
  }
  const values = new Map();
  for (const authoredLine of text.split(/\r?\n/u)) {
    const line = authoredLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) throw new Error(`Invalid AVD config line in ${configPath}`);
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (values.has(key)) throw new Error(`Duplicate AVD config key ${key} in ${configPath}`);
    values.set(key, value);
  }
  return values;
}

function systemImageFromConfig(value, configPath) {
  const normalized = requiredString(value, `image.sysdir.1 in ${configPath}`)
    .replaceAll("\\", "/")
    .replace(/\/+$/u, "");
  const parts = normalized.split("/");
  if (parts.length !== 4 || parts[0] !== "system-images" || parts.some((part) => !part)) {
    throw new Error(`Invalid image.sysdir.1 in ${configPath}`);
  }
  return parts.join(";");
}

async function exactAvdSummary(summary, avdRoot, fs) {
  const avdName = requiredString(summary.avdName, "AVD summary name");
  const avdPath = requiredAbsolutePath(summary.avdPath, `AVD path for ${avdName}`);
  const expectedPath = path.join(avdRoot, `${avdName}.avd`);
  if (avdPath !== expectedPath || path.dirname(avdPath) !== avdRoot) {
    throw new Error(`AVD ${avdName} is outside canonical private avdRoot`);
  }
  const avdCanonical = await fs.realpath(avdPath);
  const avdStat = await fs.lstat(avdPath);
  if (avdCanonical !== avdPath || !avdStat.isDirectory() || avdStat.isSymbolicLink()) {
    throw new Error(`AVD path is not canonical: ${avdPath}`);
  }
  const configPath = path.join(avdPath, "config.ini");
  const configCanonical = await fs.realpath(configPath);
  const configStat = await fs.lstat(configPath);
  if (configCanonical !== configPath || !configStat.isFile() || configStat.isSymbolicLink()) {
    throw new Error(`AVD config path is not canonical: ${configPath}`);
  }
  const definitionPath = path.join(avdRoot, `${avdName}.ini`);
  const definitionCanonical = await fs.realpath(definitionPath);
  const definitionStat = await fs.lstat(definitionPath);
  if (
    definitionCanonical !== definitionPath
    || !definitionStat.isFile()
    || definitionStat.isSymbolicLink()
  ) {
    throw new Error(`AVD definition path is not canonical: ${definitionPath}`);
  }
  const configValues = parseIni(await fs.readFile(configPath, "utf8"), configPath);
  const definitionValues = parseIni(
    await fs.readFile(definitionPath, "utf8"),
    definitionPath,
  );
  if (configValues.get("AvdId") !== avdName || definitionValues.get("path") !== avdPath) {
    throw new Error(`AVD config identity does not match ${avdName}`);
  }
  const systemImage = systemImageFromConfig(configValues.get("image.sysdir.1"), configPath);
  return Object.freeze({
    avdName,
    avdPath,
    configPath,
    definitionPath,
    systemImage,
    config: Object.freeze({ avdName, avdPath, systemImage }),
  });
}

function exactProcessRecord(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new Error("Tracked emulator process record must be an object");
  }
  const avdName = requiredString(record.avdName, "tracked emulator avdName");
  const serial = requiredString(record.serial, "tracked emulator serial");
  const processStartIdentity = requiredString(
    record.processStartIdentity,
    "tracked emulator processStartIdentity",
  );
  if (!Number.isInteger(record.consolePort) || record.consolePort < 1 || record.consolePort > 65535) {
    throw new Error("tracked emulator consolePort must be a TCP port");
  }
  if (serial !== `emulator-${record.consolePort}`) {
    throw new Error("tracked emulator serial must match its exact console port");
  }
  if (!Number.isInteger(record.pid) || record.pid < 1) {
    throw new Error("tracked emulator pid must be a positive integer");
  }
  return {
    avdName,
    serial,
    consolePort: record.consolePort,
    pid: record.pid,
    processStartIdentity,
  };
}

function adbDeviceStates(commandResult) {
  const lines = commandOutput(commandResult, "adb devices").split(/\r?\n/u);
  const states = new Map();
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    const match = /^(\S+)\s+(\S+)\s*$/u.exec(line.trim());
    if (!match) throw new Error("adb devices returned an invalid device row");
    const entries = states.get(match[1]) ?? [];
    entries.push(match[2]);
    states.set(match[1], entries);
  }
  return states;
}

function exactAdbAvdName(commandResult, serial) {
  const names = commandOutput(commandResult, `adb AVD name for ${serial}`)
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line && line !== "OK");
  if (names.length !== 1) throw new Error(`adb returned an ambiguous AVD name for ${serial}`);
  return names[0];
}

function exactLiveProcess(live, expected, expectedCommand = undefined) {
  if (live === null || live === undefined || live.alive === false) return false;
  if (
    live.alive !== true
    || live.pid !== expected.pid
    || live.processStartIdentity !== expected.processStartIdentity
  ) {
    throw new Error(`Tracked emulator PID ${expected.pid} was reused or changed start identity`);
  }
  if (expectedCommand !== undefined && live.command !== expectedCommand) {
    throw new Error(`Tracked emulator PID ${expected.pid} changed executable or arguments`);
  }
  return true;
}

export function createAvdLifecycleDeps(config = {}, deps = {}) {
  const avdRoot = requiredAbsolutePath(config.avdRoot, "avdRoot");
  if (path.resolve(avdRoot) !== avdRoot) throw new Error("avdRoot must be canonical and absolute");
  const adbPath = requiredAbsolutePath(config.adbPath, "adbPath");
  requiredAbsolutePath(config.emulatorPath, "emulatorPath");
  const avdmanagerPath = requiredAbsolutePath(config.avdmanagerPath, "avdmanagerPath");
  const fs = deps.fs ?? config.fs ?? defaultFs;
  const runCommand = deps.runCommand ?? config.runCommand ?? defaultRunCommand;
  const authoredInspectProcess = deps.inspectProcess ?? config.inspectProcess;
  const currentProcessPid = deps.currentProcessPid ?? config.currentProcessPid ?? process.pid;
  const stopEmulator = deps.stopEmulator ?? config.stopEmulator;
  const processRegistry = deps.processRegistry ?? config.processRegistry;
  // In-memory capabilities are deliberately unforgeable outside this exact
  // lifecycle instance. A process restart loses the capability and therefore
  // preserves a partial AVD plus its external marker for operator recovery.
  const createdAvdProofs = new WeakMap();
  if (typeof runCommand !== "function") throw new Error("runCommand must be a function");
  if (authoredInspectProcess !== undefined && typeof authoredInspectProcess !== "function") {
    throw new Error("inspectProcess must be a function");
  }
  if (!Number.isInteger(currentProcessPid) || currentProcessPid < 1) {
    throw new Error("currentProcessPid must be a positive integer");
  }
  if (typeof stopEmulator !== "function") throw new Error("stopEmulator must be a function");
  if (!(processRegistry?.emulators instanceof Map) || !(processRegistry?.recorders instanceof Map)) {
    throw new Error("processRegistry must contain private emulators and recorders Maps");
  }
  const environment = Object.freeze({
    ...sanitizedToolEnvironment(config, deps),
    HOME: path.dirname(avdRoot),
    ANDROID_USER_HOME: path.dirname(avdRoot),
    ANDROID_AVD_HOME: avdRoot,
  });
  const run = (executable, args) => runCommand(executable, [...args], {
    ...commandOptions(environment),
  });
  const inspectProcess = authoredInspectProcess ?? createHostProcessInspector({
    runCommand,
    commandOptions: {
      ...commandOptions(environment),
      maxBuffer: HOST_PROCESS_OUTPUT_BYTES,
    },
  });
  const requireCommandProof = authoredInspectProcess === undefined;

  const getMarkerUpdateOwner = async () => {
    const live = await inspectProcess(currentProcessPid);
    if (
      !live
      || live.alive !== true
      || live.pid !== currentProcessPid
      || typeof live.processStartIdentity !== "string"
      || live.processStartIdentity.trim() === ""
    ) {
      throw new Error("Current marker update owner identity is unavailable or ambiguous");
    }
    return Object.freeze({
      pid: currentProcessPid,
      processStartIdentity: live.processStartIdentity,
    });
  };

  const inspectMarkerUpdateOwner = async (owner) => {
    if (!owner || typeof owner !== "object" || Array.isArray(owner)) {
      throw new Error("Marker update owner identity is required");
    }
    if (!Number.isInteger(owner.pid) || owner.pid < 1) {
      throw new Error("Marker update owner PID must be a positive integer");
    }
    requiredString(owner.processStartIdentity, "marker update owner processStartIdentity");
    return inspectProcess(owner.pid);
  };

  const listAvdSummaries = async () => {
    await canonicalAvdRoot(fs, avdRoot);
    return parseAvdSummaries(await run(avdmanagerPath, ["list", "avd"]));
  };

  const creationFingerprint = async ({ avdName, avdPath, systemImage }) => {
    const candidates = (await listAvdSummaries()).filter((summary) => (
      summary.avdName === avdName || summary.avdPath === avdPath
    ));
    if (candidates.length !== 1) {
      throw new Error(`AVD creation proof requires one exact generated AVD: ${avdName}`);
    }
    const exact = await exactAvdSummary(candidates[0], avdRoot, fs);
    if (
      exact.avdName !== avdName
      || exact.avdPath !== avdPath
      || exact.systemImage !== systemImage
    ) {
      throw new Error(`AVD creation proof identity changed: ${avdName}`);
    }
    const paths = {
      directory: avdPath,
      definition: path.join(avdRoot, `${avdName}.ini`),
      config: path.join(avdPath, "config.ini"),
    };
    const fingerprint = {};
    for (const [name, pathname] of Object.entries(paths)) {
      const canonical = await fs.realpath(pathname);
      const details = await fs.lstat(pathname);
      const validType = name === "directory"
        ? details.isDirectory() && !details.isSymbolicLink()
        : details.isFile() && !details.isSymbolicLink();
      if (
        canonical !== pathname
        || !validType
        || !Number.isSafeInteger(details.dev)
        || details.dev < 0
        || !Number.isSafeInteger(details.ino)
        || details.ino < 1
      ) {
        throw new Error(`AVD creation proof path identity is ambiguous: ${pathname}`);
      }
      fingerprint[name] = {
        path: pathname,
        dev: details.dev,
        ino: details.ino,
        ...(name === "directory" ? {} : {
          sha256: createHash("sha256").update(await fs.readFile(pathname)).digest("hex"),
        }),
      };
    }
    return Object.freeze({
      avdName,
      avdPath,
      systemImage,
      fingerprint: JSON.stringify(fingerprint),
    });
  };

  const recordCreatedAvd = async (ownership) => {
    if (!ownership || typeof ownership !== "object" || Array.isArray(ownership)) {
      throw new Error("Unbound AVD reservation is required for creation proof");
    }
    const scenarioId = requiredString(ownership.scenarioId, "ownership.scenarioId");
    const runId = requiredString(ownership.runId, "ownership.runId");
    const nonce = requiredString(ownership.nonce, "ownership.nonce");
    const avdName = generatedAvdName({ scenarioId, runId, nonce });
    const avdPath = path.join(avdRoot, `${avdName}.avd`);
    const markerPath = requiredAbsolutePath(ownership.markerPath, "ownership.markerPath");
    const systemImage = requiredString(ownership.systemImage, "ownership.systemImage");
    if (
      ownership.version !== 1
      || ownership.toolNamespace !== "acp.demo-creator.android-avd"
      || ownership.avdName !== avdName
      || ownership.avdPath !== avdPath
      || path.basename(markerPath) !== `${avdName}.owner.json`
    ) {
      throw new Error("Unbound AVD reservation identity is not exact");
    }
    await readExactUnboundMarker(fs, markerPath, {
      version: 1,
      toolNamespace: "acp.demo-creator.android-avd",
      scenarioId,
      runId,
      nonce,
      avdName,
      avdPath,
      systemImage,
    }, "AVD");
    if ([...processRegistry.emulators.values()].some((record) => record?.avdName === avdName)) {
      throw new Error(`AVD creation proof refuses a tracked emulator: ${avdName}`);
    }
    const fingerprint = await creationFingerprint({ avdName, avdPath, systemImage });
    const proof = Object.freeze({ version: 1, avdName, avdPath, systemImage });
    createdAvdProofs.set(proof, fingerprint);
    return proof;
  };

  const inspectAvds = async () => {
    const summaries = await listAvdSummaries();
    return Promise.all(summaries.map((summary) => exactAvdSummary(summary, avdRoot, fs)));
  };

  const inspectEmulators = async () => {
    await canonicalAvdRoot(fs, avdRoot);
    const states = adbDeviceStates(await run(adbPath, ["devices"]));
    const emulators = [];
    for (const authoredRecord of processRegistry.emulators.values()) {
      const record = exactProcessRecord(authoredRecord);
      if (
        !authoredRecord.child
        || typeof authoredRecord.child !== "object"
        || authoredRecord.child.pid !== record.pid
      ) {
        throw new Error(`Tracked emulator direct child does not match PID ${record.pid}`);
      }
      const live = await inspectProcess(record.pid);
      const expectedCommand = requireCommandProof
        ? requiredString(authoredRecord.processCommand, "tracked emulator processCommand")
        : undefined;
      if (!exactLiveProcess(live, record, expectedCommand)) continue;
      const serialStates = states.get(record.serial) ?? [];
      if (serialStates.length > 1) {
        throw new Error(`Tracked emulator serial ${record.serial} is ambiguous in adb`);
      }
      const liveAvdName = exactAdbAvdName(
        await run(adbPath, ["-s", record.serial, "emu", "avd", "name"]),
        record.serial,
      );
      if (liveAvdName !== record.avdName) {
        throw new Error(`Tracked emulator serial belongs to a different AVD: ${record.serial}`);
      }
      let ready = false;
      if (serialStates[0] === "device") {
        const boot = commandOutput(
          await run(adbPath, ["-s", record.serial, "shell", "getprop", "sys.boot_completed"]),
          `adb boot readiness for ${record.serial}`,
        ).trim();
        ready = boot === "1";
      }
      emulators.push(Object.freeze({ ...record, ready }));
    }
    return emulators;
  };

  const assertEmulatorAbsent = async (identity) => {
    const expected = exactProcessRecord(identity);
    await canonicalAvdRoot(fs, avdRoot);

    const live = await inspectProcess(expected.pid);
    if (exactLiveProcess(live, expected)) {
      throw new Error(`Exact emulator process is still live: ${expected.serial}`);
    }

    const registryCandidates = [...processRegistry.emulators.values()].filter((authoredRecord) => {
      const record = exactProcessRecord(authoredRecord);
      return record.avdName === expected.avdName
        || record.serial === expected.serial
        || record.consolePort === expected.consolePort
        || record.pid === expected.pid;
    });
    if (registryCandidates.length !== 0) {
      throw new Error(`Tracked emulator identity remains or is ambiguous: ${expected.serial}`);
    }

    const states = adbDeviceStates(await run(adbPath, ["devices"]));
    for (const [serial, serialStates] of states) {
      if (!/^emulator-[1-9][0-9]*$/u.test(serial)) continue;
      if (serialStates.length !== 1) {
        throw new Error(`Live emulator serial is ambiguous in adb: ${serial}`);
      }
      const liveAvdName = exactAdbAvdName(
        await run(adbPath, ["-s", serial, "emu", "avd", "name"]),
        serial,
      );
      if (serial === expected.serial) {
        throw new Error(`Bound serial belongs to a live emulator and is not absent: ${serial}`);
      }
      if (liveAvdName === expected.avdName) {
        throw new Error(`Bound AVD name belongs to a live emulator and is not absent: ${expected.avdName}`);
      }
    }
  };

  const assertNoLiveEmulatorForAvd = async (avdName) => {
    const states = adbDeviceStates(await run(adbPath, ["devices"]));
    for (const [serial, serialStates] of states) {
      if (!/^emulator-[1-9][0-9]*$/u.test(serial)) continue;
      if (serialStates.length !== 1) {
        throw new Error(`Live emulator serial is ambiguous in adb: ${serial}`);
      }
      let liveAvdName;
      try {
        liveAvdName = exactAdbAvdName(
          await run(adbPath, ["-s", serial, "emu", "avd", "name"]),
          serial,
        );
      } catch (error) {
        throw new Error(`Unable to prove live emulator ${serial} is unrelated to ${avdName}`, {
          cause: error,
        });
      }
      if (liveAvdName === avdName) {
        throw new Error(`Unbound AVD rollback refuses a live emulator for ${avdName}`);
      }
    }
  };

  const killEmulator = async (identity) => {
    const expected = exactProcessRecord(identity);
    const candidates = [...processRegistry.emulators.entries()].filter(([, authoredRecord]) => {
      const record = exactProcessRecord(authoredRecord);
      return record.avdName === expected.avdName
        || record.serial === expected.serial
        || record.consolePort === expected.consolePort
        || record.pid === expected.pid;
    });
    if (candidates.length !== 1) {
      throw new Error(
        candidates.length === 0
          ? `Exact tracked emulator identity is missing: ${expected.serial}`
          : `Exact tracked emulator identity is ambiguous: ${expected.serial}`,
      );
    }
    const [registryKey, authoredRecord] = candidates[0];
    const tracked = exactProcessRecord(authoredRecord);
    if (Object.keys(expected).some((field) => expected[field] !== tracked[field])) {
      throw new Error(`Tracked emulator identity changed: ${expected.serial}`);
    }

    // No destructive action occurs until this live start identity has been
    // re-read. A reused PID is never adopted as the owned emulator.
    const live = await inspectProcess(expected.pid);
    const expectedCommand = requireCommandProof
      ? requiredString(authoredRecord.processCommand, "tracked emulator processCommand")
      : undefined;
    if (!exactLiveProcess(live, expected, expectedCommand)) {
      throw new Error(`Exact tracked emulator process is no longer live: ${expected.serial}`);
    }
    if (processRegistry.emulators.get(registryKey) !== authoredRecord) {
      throw new Error(`Tracked emulator registry changed during kill verification: ${expected.serial}`);
    }
    if (
      !authoredRecord.child
      || typeof authoredRecord.child !== "object"
      || authoredRecord.child.pid !== expected.pid
    ) {
      throw new Error(`Tracked emulator direct child does not match PID ${expected.pid}`);
    }
    await stopEmulator(Object.freeze({ ...expected, child: authoredRecord.child }));
    const liveAfterStop = await inspectProcess(expected.pid);
    if (
      liveAfterStop?.alive === true
      && liveAfterStop.pid === expected.pid
      && liveAfterStop.processStartIdentity === expected.processStartIdentity
    ) {
      throw new Error(`Exact emulator child is still live after stop: ${expected.serial}`);
    }
    if (processRegistry.emulators.has(registryKey)) {
      throw new Error(`Exact emulator stop did not remove tracked child ${expected.serial}`);
    }
  };

  const deleteAvd = async (identity, processIdentity = undefined) => {
    if (!identity || typeof identity !== "object" || Array.isArray(identity)) {
      throw new Error("Exact generated AVD identity is required for deletion");
    }
    const avdName = requiredString(identity.avdName, "AVD deletion avdName");
    const avdPath = requiredAbsolutePath(identity.avdPath, "AVD deletion avdPath");
    const systemImage = requiredString(identity.systemImage, "AVD deletion systemImage");
    if (processIdentity === undefined) {
      throw new Error("AVD deletion requires the exact bound emulator absence identity");
    }
    const expectedProcess = exactProcessRecord(processIdentity);
    if (expectedProcess.avdName !== avdName) {
      throw new Error(`Emulator absence identity does not match AVD deletion identity: ${avdName}`);
    }
    if (!/^acp-demo-[a-z0-9-]+-[a-f0-9]{12}$/u.test(avdName)) {
      throw new Error(`Refusing deletion of non-generated AVD name ${avdName}`);
    }
    if (avdPath !== path.join(avdRoot, `${avdName}.avd`) || path.dirname(avdPath) !== avdRoot) {
      throw new Error(`Refusing deletion of AVD outside canonical private avdRoot: ${avdPath}`);
    }
    const tracked = [...processRegistry.emulators.values()]
      .map(exactProcessRecord)
      .filter((record) => record.avdName === avdName);
    if (tracked.length > 0) {
      throw new Error(`Refusing to delete AVD while a tracked emulator remains: ${avdName}`);
    }

    const before = await inspectAvds();
    const candidates = before.filter((avd) => avd.avdName === avdName || avd.avdPath === avdPath);
    if (candidates.length !== 1) {
      throw new Error(
        candidates.length === 0
          ? `Exact generated AVD is missing: ${avdName}`
          : `Exact generated AVD identity is ambiguous: ${avdName}`,
      );
    }
    const avd = candidates[0];
    if (
      avd.avdName !== avdName
      || avd.avdPath !== avdPath
      || avd.systemImage !== systemImage
      || avd.config?.avdName !== avdName
      || avd.config?.avdPath !== avdPath
      || avd.config?.systemImage !== systemImage
    ) {
      throw new Error(`Exact generated AVD identity changed before deletion: ${avdName}`);
    }

    await assertEmulatorAbsent(expectedProcess);
    await run(avdmanagerPath, ["delete", "avd", "--name", avdName]);
    const after = await inspectAvds();
    if (after.some((entry) => entry.avdName === avdName || entry.avdPath === avdPath)) {
      throw new Error(`AVD manager did not remove exact generated AVD ${avdName}`);
    }
    for (const pathname of [avdPath, path.join(avdRoot, `${avdName}.ini`)]) {
      try {
        await fs.lstat(pathname);
      } catch (error) {
        if (error?.code === "ENOENT") continue;
        throw error;
      }
      throw new Error(`AVD manager left exact generated AVD path behind: ${pathname}`);
    }
  };

  const rollbackUnboundAvd = async (ownership, options = {}) => {
    if (!ownership || typeof ownership !== "object" || Array.isArray(ownership)) {
      throw new Error("Unbound AVD reservation is required");
    }
    const scenarioId = requiredString(ownership.scenarioId, "ownership.scenarioId");
    const runId = requiredString(ownership.runId, "ownership.runId");
    const nonce = requiredString(ownership.nonce, "ownership.nonce");
    const avdName = generatedAvdName({ scenarioId, runId, nonce });
    const avdPath = path.join(avdRoot, `${avdName}.avd`);
    const markerPath = requiredAbsolutePath(ownership.markerPath, "ownership.markerPath");
    const systemImage = requiredString(ownership.systemImage, "ownership.systemImage");
    if (
      ownership.version !== 1
      || ownership.toolNamespace !== "acp.demo-creator.android-avd"
      || ownership.avdName !== avdName
      || ownership.avdPath !== avdPath
      || path.basename(markerPath) !== `${avdName}.owner.json`
    ) {
      throw new Error("Unbound AVD reservation identity is not exact");
    }
    const expectedMarker = {
      version: 1,
      toolNamespace: "acp.demo-creator.android-avd",
      scenarioId,
      runId,
      nonce,
      avdName,
      avdPath,
      systemImage,
    };
    const initialMarker = await readExactUnboundMarkerSnapshot(
      fs,
      markerPath,
      expectedMarker,
      "AVD",
    );
    if ([...processRegistry.emulators.values()].some((record) => record?.avdName === avdName)) {
      throw new Error(`Unbound AVD rollback refuses a tracked emulator: ${avdName}`);
    }

    const summaries = await listAvdSummaries();
    const candidates = summaries.filter((summary) => (
      summary.avdName === avdName || summary.avdPath === avdPath
    ));
    if (candidates.length > 1) {
      throw new Error(`Unbound AVD identity is ambiguous: ${avdName}`);
    }
    let resourcePresent = candidates.length === 1;
    if (resourcePresent) {
      if (
        !options
        || typeof options !== "object"
        || Array.isArray(options)
        || Object.keys(options).length !== 1
        || !Object.hasOwn(options, "creationProof")
        || !createdAvdProofs.has(options.creationProof)
      ) {
        throw new Error(`Unbound AVD rollback requires the exact creation proof: ${avdName}`);
      }
      if (candidates[0].avdName !== avdName || candidates[0].avdPath !== avdPath) {
        throw new Error(`Unbound AVD identity does not match generated name and path: ${avdName}`);
      }
      const exact = await exactAvdSummary(candidates[0], avdRoot, fs);
      if (exact.systemImage !== systemImage) {
        throw new Error(`Unbound AVD system image changed: ${avdName}`);
      }
      const recorded = createdAvdProofs.get(options.creationProof);
      const current = await creationFingerprint({ avdName, avdPath, systemImage });
      if (
        recorded.avdName !== current.avdName
        || recorded.avdPath !== current.avdPath
        || recorded.systemImage !== current.systemImage
        || recorded.fingerprint !== current.fingerprint
      ) {
        throw new Error(`Unbound AVD creation identity changed; preserving resource: ${avdName}`);
      }
      await assertNoLiveEmulatorForAvd(avdName);
      const markerBeforeDelete = await readExactUnboundMarkerSnapshot(
        fs,
        markerPath,
        expectedMarker,
        "AVD",
      );
      if (markerBeforeDelete.fileIdentity !== initialMarker.fileIdentity) {
        throw new Error("AVD marker file identity changed before unbound rollback deletion");
      }
      const immediatelyBeforeDelete = await creationFingerprint({
        avdName,
        avdPath,
        systemImage,
      });
      if (
        recorded.avdName !== immediatelyBeforeDelete.avdName
        || recorded.avdPath !== immediatelyBeforeDelete.avdPath
        || recorded.systemImage !== immediatelyBeforeDelete.systemImage
        || recorded.fingerprint !== immediatelyBeforeDelete.fingerprint
      ) {
        throw new Error(`Unbound AVD creation identity changed before deletion; preserving resource: ${avdName}`);
      }
      await run(avdmanagerPath, ["delete", "avd", "--name", avdName]);
    } else {
      for (const pathname of [avdPath, path.join(avdRoot, `${avdName}.ini`)]) {
        try {
          await fs.lstat(pathname);
          resourcePresent = true;
        } catch (error) {
          if (error?.code !== "ENOENT") throw error;
        }
      }
      if (resourcePresent) {
        throw new Error(`Unbound AVD exists without one exact avdmanager identity: ${avdName}`);
      }
    }

    const proof = await listAvdSummaries();
    if (proof.some((summary) => summary.avdName === avdName || summary.avdPath === avdPath)) {
      throw new Error(`Unbound AVD rollback did not prove absence: ${avdName}`);
    }
    for (const pathname of [avdPath, path.join(avdRoot, `${avdName}.ini`)]) {
      try {
        await fs.lstat(pathname);
      } catch (error) {
        if (error?.code === "ENOENT") continue;
        throw error;
      }
      throw new Error(`Unbound AVD rollback did not remove path: ${pathname}`);
    }
    const finalMarker = await readExactUnboundMarkerSnapshot(
      fs,
      markerPath,
      expectedMarker,
      "AVD",
    );
    if (finalMarker.fileIdentity !== initialMarker.fileIdentity) {
      throw new Error("AVD marker file identity changed before removal");
    }
    await fs.unlink(markerPath);
    if (options?.creationProof && createdAvdProofs.has(options.creationProof)) {
      createdAvdProofs.delete(options.creationProof);
    }
    return Object.freeze({ action: "rolled-back", avdName, resourceDeleted: resourcePresent });
  };

  return Object.freeze({
    runtime: Object.freeze({
      inspectAvds,
      inspectEmulators,
      getMarkerUpdateOwner,
      inspectMarkerUpdateOwner,
      assertEmulatorAbsent,
      killEmulator,
      deleteAvd,
    }),
    recordCreatedAvd,
    rollbackUnboundAvd,
  });
}
