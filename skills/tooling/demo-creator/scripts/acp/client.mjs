import { lookup as defaultDnsLookup } from "node:dns/promises";

const API_PREFIX = "/api/ambient/v1";

const REQUIRED_ENVIRONMENT = Object.freeze([
  "ACP_URL",
  "ACP_PROJECT",
  "ACP_BEARER_TOKEN",
]);

function requiredEnvironmentValue(environment, name) {
  const value = environment?.[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} must be set in the environment`);
  }
  if (/[\r\n\0]/u.test(value)) {
    throw new Error(`${name} contains unsupported control characters`);
  }
  return value;
}

export function isLoopbackHostname(hostname) {
  const normalized = String(hostname).toLowerCase().replace(/^\[|\]$/gu, "").replace(/\.$/u, "");
  if (normalized === "localhost" || normalized === "::1") return true;
  const octets = normalized.split(".");
  return octets.length === 4
    && octets[0] === "127"
    && octets.every((octet) => /^\d{1,3}$/u.test(octet) && Number(octet) <= 255);
}

export function isLoopbackAddress(address) {
  const normalized = String(address).toLowerCase().replace(/^\[|\]$/gu, "");
  if (normalized === "::1") return true;
  if (normalized.startsWith("::ffff:")) {
    return isLoopbackHostname(normalized.slice("::ffff:".length));
  }
  return isLoopbackHostname(normalized) && normalized !== "localhost";
}

export function parseAcpOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("ACP_URL must be a valid HTTPS origin or loopback HTTP origin");
  }
  if (!["http:", "https:"].includes(url.protocol)
    || url.username
    || url.password
    || url.search
    || url.hash
    || !["", "/"].includes(url.pathname)) {
    throw new Error("ACP_URL must be an exact HTTPS origin or loopback HTTP origin without credentials, a path, query, or fragment");
  }
  if (url.protocol === "http:" && !isLoopbackHostname(url.hostname)) {
    throw new Error("ACP_URL requires HTTPS unless the host is loopback");
  }
  return url;
}

export function readAcpEnvironment(environment = process.env) {
  const values = Object.fromEntries(
    REQUIRED_ENVIRONMENT.map((name) => [name, requiredEnvironmentValue(environment, name)]),
  );

  const url = parseAcpOrigin(values.ACP_URL);

  return Object.freeze({
    baseUrl: url.origin,
    project: values.ACP_PROJECT,
    token: values.ACP_BEARER_TOKEN,
  });
}

export class AcpRequestError extends Error {
  constructor(message, { status = undefined, code = undefined } = {}) {
    super(message);
    this.name = "AcpRequestError";
    this.status = status;
    this.code = code;
  }
}

function requestSignal(signal, timeoutMilliseconds) {
  const timeoutSignal = AbortSignal.timeout(timeoutMilliseconds);
  return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
}

export function createAcpClient({
  environment = process.env,
  fetchImpl = globalThis.fetch,
  dnsLookup = defaultDnsLookup,
  timeoutMilliseconds = 15_000,
} = {}) {
  const config = readAcpEnvironment(environment);
  const origin = parseAcpOrigin(config.baseUrl);
  if (typeof fetchImpl !== "function") throw new Error("A fetch implementation is required");
  if (typeof dnsLookup !== "function") throw new Error("A DNS lookup implementation is required");
  if (!Number.isInteger(timeoutMilliseconds) || timeoutMilliseconds <= 0) {
    throw new Error("timeoutMilliseconds must be a positive integer");
  }

  let originPreflight;
  let pinnedAddress;
  function preflightOrigin() {
    if (origin.hostname.toLowerCase().replace(/\.$/u, "") !== "localhost") {
      return Promise.resolve();
    }
    originPreflight ??= (async () => {
      let results;
      try {
        results = await dnsLookup(origin.hostname, { all: true, verbatim: true });
      } catch {
        throw new AcpRequestError("ACP localhost DNS preflight failed", {
          code: "dns_preflight_failed",
        });
      }
      if (!Array.isArray(results)
        || results.length === 0
        || results.some((result) => !result || !isLoopbackAddress(result.address))) {
        throw new AcpRequestError("ACP localhost DNS preflight resolved outside the loopback interface", {
          code: "unsafe_origin",
        });
      }
      // Pin the connection to a validated loopback address so the socket uses
      // the same address that passed validation (closes the DNS-rebinding window).
      pinnedAddress = results[0].address;
    })();
    return originPreflight;
  }

  async function request(method, path, { body, signal, allowNotFound = false } = {}) {
    await preflightOrigin();
    const target = new URL(`${config.baseUrl}${API_PREFIX}${path}`);
    const headers = {
      Accept: "application/json",
      Authorization: `Bearer ${config.token}`,
      "X-Ambient-Project": config.project,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    };
    if (pinnedAddress) {
      // Preserve the intended authority, then connect to the validated IP.
      // IPv6 literals must be bracketed or the URL hostname setter silently
      // ignores them, leaving "localhost" to be re-resolved at connect time and
      // reopening the DNS-rebinding window this pin exists to close.
      headers.Host = target.host;
      target.hostname = pinnedAddress.includes(":") ? `[${pinnedAddress}]` : pinnedAddress;
    }
    let response;
    try {
      response = await fetchImpl(target, {
        method,
        redirect: "error",
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: requestSignal(signal, timeoutMilliseconds),
      });
    } catch {
      throw new AcpRequestError(`ACP ${method} request failed before receiving a response`, {
        code: "request_failed",
      });
    }

    if (allowNotFound && response.status === 404) return null;
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new AcpRequestError(`ACP ${method} request failed with HTTP ${response.status}`, {
        status: response.status,
        code: "http_error",
      });
    }
    if (response.status === 204) return undefined;
    try {
      return await response.json();
    } catch {
      throw new AcpRequestError(`ACP ${method} response was not valid JSON`, {
        status: response.status,
        code: "invalid_response",
      });
    }
  }

  return Object.freeze({
    project: config.project,
    getProject(name, options = {}) {
      return request("GET", `/projects/${encodeURIComponent(name)}`, {
        ...options,
        allowNotFound: true,
      });
    },
    createProject(project, options = {}) {
      return request("POST", "/projects", { ...options, body: project });
    },
    updateProject(name, project, options = {}) {
      return request("PATCH", `/projects/${encodeURIComponent(name)}`, {
        ...options,
        body: project,
      });
    },
    deleteProject(name, options = {}) {
      return request("DELETE", `/projects/${encodeURIComponent(name)}`, options);
    },
  });
}
