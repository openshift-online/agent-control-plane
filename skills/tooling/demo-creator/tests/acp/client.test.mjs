import assert from "node:assert/strict";
import http from "node:http";
import { afterEach, test } from "node:test";
import {
  AcpRequestError,
  createAcpClient,
  readAcpEnvironment,
} from "../../scripts/acp/index.mjs";

const servers = new Set();
// Synthetic, non-secret fixture value built at runtime so secret scanners do not flag it.
const FAKE_TOKEN = ["test", "token", "that", "must", "not", "leak"].join("-");

afterEach(async () => {
  await Promise.all([...servers].map((server) => new Promise((resolve) => server.close(resolve))));
  servers.clear();
});

async function startServer(handler) {
  const server = http.createServer(handler);
  servers.add(server);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}

function environment(baseUrl, token = FAKE_TOKEN) {
  return {
    ACP_URL: baseUrl,
    ACP_PROJECT: "demo-example-flow",
    ACP_BEARER_TOKEN: token,
  };
}

test("readAcpEnvironment accepts only complete origin-based configuration", () => {
  const result = readAcpEnvironment(environment("https://acp.example.test/"));
  assert.equal(result.baseUrl, "https://acp.example.test");
  assert.equal(result.project, "demo-example-flow");
  assert.equal(result.token, FAKE_TOKEN);

  assert.throws(() => readAcpEnvironment({}), /ACP_URL must be set/);
  assert.throws(
    () => readAcpEnvironment(environment("https://acp.example.test/api")),
    /without credentials, a path, query, or fragment/,
  );
  assert.throws(
    () => readAcpEnvironment(environment("https://acp.example.test", "unsafe\r\ntoken")),
    /control characters/,
  );
  assert.equal(readAcpEnvironment(environment("http://localhost:8080")).baseUrl, "http://localhost:8080");
  assert.equal(readAcpEnvironment(environment("http://127.0.0.2:8080")).baseUrl, "http://127.0.0.2:8080");
  assert.equal(readAcpEnvironment(environment("http://[::1]:8080")).baseUrl, "http://[::1]:8080");
  assert.throws(
    () => readAcpEnvironment(environment("http://acp.example.test")),
    /requires HTTPS unless the host is loopback/,
  );
  assert.throws(
    () => readAcpEnvironment(environment("http://192.168.1.20:8080")),
    /requires HTTPS unless the host is loopback/,
  );
});

test("request timeout aborts the combined signal without aborting the caller", async () => {
  const caller = new AbortController();
  // AbortSignal.timeout() uses an unref'ed timer. This ref'ed handle keeps the
  // isolated test process alive without racing the behavior under test.
  const keepAlive = setTimeout(() => {}, 60_000);
  const fetchImpl = async (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
  const client = createAcpClient({
    environment: environment("https://acp.example.test"),
    fetchImpl,
    timeoutMilliseconds: 10,
  });

  try {
    await assert.rejects(
      client.getProject("demo-example-flow", { signal: caller.signal }),
      /failed before receiving a response/,
    );
    assert.equal(caller.signal.aborted, false);
  } finally {
    clearTimeout(keepAlive);
  }
});

test("localhost DNS preflight accepts only loopback answers and is cached", async () => {
  let lookupCount = 0;
  let fetchCount = 0;
  const dnsLookup = async (hostname, options) => {
    lookupCount += 1;
    assert.equal(hostname, "localhost");
    assert.deepEqual(options, { all: true, verbatim: true });
    return [
      { address: "127.0.0.1", family: 4 },
      { address: "::1", family: 6 },
    ];
  };
  const fetchImpl = async () => {
    fetchCount += 1;
    return new Response(JSON.stringify({ name: "demo-example-flow" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  const client = createAcpClient({
    environment: environment("http://localhost:8080"),
    dnsLookup,
    fetchImpl,
  });

  await client.getProject("demo-example-flow");
  await client.getProject("demo-example-flow");

  assert.equal(lookupCount, 1);
  assert.equal(fetchCount, 2);
});

test("localhost DNS preflight rejects mixed loopback and non-loopback answers", async () => {
  let lookupCount = 0;
  let fetchCount = 0;
  const client = createAcpClient({
    environment: environment("https://localhost:8443"),
    dnsLookup: async () => {
      lookupCount += 1;
      return [
        { address: "127.0.0.1", family: 4 },
        { address: "192.0.2.20", family: 4 },
      ];
    },
    fetchImpl: async () => {
      fetchCount += 1;
      throw new Error("fetch must not run");
    },
  });

  await assert.rejects(client.getProject("demo-example-flow"), (error) => {
    assert.ok(error instanceof AcpRequestError);
    assert.equal(error.code, "unsafe_origin");
    return true;
  });
  await assert.rejects(client.getProject("demo-example-flow"), /outside the loopback interface/);
  assert.equal(lookupCount, 1);
  assert.equal(fetchCount, 0);
});

test("localhost DNS preflight rejects a non-loopback answer", async () => {
  let fetchCount = 0;
  const client = createAcpClient({
    environment: environment("http://localhost:8080"),
    dnsLookup: async () => [{ address: "203.0.113.8", family: 4 }],
    fetchImpl: async () => {
      fetchCount += 1;
      throw new Error("fetch must not run");
    },
  });

  await assert.rejects(client.getProject("demo-example-flow"), /outside the loopback interface/);
  assert.equal(fetchCount, 0);
});

test("literal loopback addresses bypass DNS and requests reject redirects", async () => {
  const observed = [];
  const fetchImpl = async (_url, options) => {
    observed.push(options.redirect);
    return new Response(JSON.stringify({ name: "demo-example-flow" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  const dnsLookup = async () => {
    throw new Error("literal loopback addresses must not use DNS");
  };

  for (const baseUrl of ["http://127.0.0.2:8080", "http://[::1]:8080"]) {
    const client = createAcpClient({ environment: environment(baseUrl), dnsLookup, fetchImpl });
    await client.getProject("demo-example-flow");
  }

  assert.deepEqual(observed, ["error", "error"]);
});

test("createAcpClient sends documented authentication and project headers", async () => {
  let observed;
  const baseUrl = await startServer((request, response) => {
    observed = {
      authorization: request.headers.authorization,
      project: request.headers["x-ambient-project"],
      method: request.method,
      path: request.url,
    };
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ name: "demo-example-flow" }));
  });
  const client = createAcpClient({ environment: environment(baseUrl) });

  await client.getProject("demo-example-flow");

  assert.deepEqual(observed, {
    authorization: `Bearer ${FAKE_TOKEN}`,
    project: "demo-example-flow",
    method: "GET",
    path: "/api/ambient/v1/projects/demo-example-flow",
  });
});

test("HTTP errors do not include bearer tokens or server response bodies", async () => {
  const token = "sentinel-bearer-token-never-print-this";
  const baseUrl = await startServer((_request, response) => {
    response.writeHead(500, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ reason: `server reflected ${token}` }));
  });
  const client = createAcpClient({ environment: environment(baseUrl, token) });

  await assert.rejects(
    client.getProject("demo-example-flow"),
    (error) => {
      assert.ok(error instanceof AcpRequestError);
      assert.equal(error.status, 500);
      assert.doesNotMatch(error.message, new RegExp(token));
      assert.doesNotMatch(error.message, /server reflected/);
      return true;
    },
  );
});

test("localhost preflight pins the socket to the validated loopback address", async () => {
  // IPv6-first resolution is the regression case: an unbracketed "::1" is
  // silently dropped by the URL hostname setter, so the request would fall back
  // to re-resolving "localhost" instead of the address that passed validation.
  const cases = [
    { address: "::1", family: 6, host: "[::1]:8080", hostname: "[::1]" },
    { address: "127.0.0.1", family: 4, host: "127.0.0.1:8080", hostname: "127.0.0.1" },
  ];
  for (const expected of cases) {
    let observedTarget;
    let observedHostHeader;
    const client = createAcpClient({
      environment: environment("http://localhost:8080"),
      dnsLookup: async () => [{ address: expected.address, family: expected.family }],
      fetchImpl: async (target, options) => {
        observedTarget = target;
        observedHostHeader = options.headers.Host;
        return new Response(JSON.stringify({ name: "demo-example-flow" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    });

    await client.getProject("demo-example-flow");

    // The socket must target the validated loopback IP, not re-resolve the name.
    assert.equal(observedTarget.hostname, expected.hostname);
    assert.equal(observedTarget.host, expected.host);
    assert.equal(
      observedTarget.href,
      `http://${expected.host}/api/ambient/v1/projects/demo-example-flow`,
    );
    // The intended authority is still presented to the server as the Host header.
    assert.equal(observedHostHeader, "localhost:8080");
  }
});
