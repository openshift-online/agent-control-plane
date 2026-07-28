import assert from "node:assert/strict";
import http from "node:http";
import { afterEach, test } from "node:test";
import {
  SEED_ANNOTATION,
  SEED_VERSION,
  cleanupAcpProject,
  createAcpClient,
  desiredProjectForScenario,
  seedAcpProject,
  verifyAcpProject,
} from "../../scripts/acp/index.mjs";

const scenario = Object.freeze({
  id: "example-flow",
  title: "Example flow",
  acp: Object.freeze({ project: "demo-example-flow" }),
});

const servers = new Set();

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

function environment(baseUrl, project = scenario.acp.project) {
  return {
    ACP_URL: baseUrl,
    ACP_PROJECT: project,
    ACP_BEARER_TOKEN: "synthetic-test-bearer-token",
  };
}

function ownedProject(overrides = {}) {
  return {
    id: "project-id",
    ...desiredProjectForScenario(scenario),
    ...overrides,
  };
}

async function jsonBody(request) {
  let source = "";
  for await (const chunk of request) source += chunk;
  return source ? JSON.parse(source) : undefined;
}

function json(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

test("desired project state has stable ownership and seed markers", () => {
  const desired = desiredProjectForScenario(scenario);
  assert.equal(desired.name, "demo-example-flow");
  assert.deepEqual(JSON.parse(desired.labels), {
    "acp.dev/demo-creator-owner": "demo-creator-skill-v1",
    "acp.dev/demo-creator-scenario": "example-flow",
  });
  assert.deepEqual(JSON.parse(desired.annotations), {
    [SEED_ANNOTATION]: SEED_VERSION,
  });
});

test("seed creates a missing project with deterministic metadata", async () => {
  const requests = [];
  const baseUrl = await startServer(async (request, response) => {
    requests.push({ method: request.method, body: await jsonBody(request) });
    if (request.method === "GET") return json(response, 404, { reason: "not found" });
    if (request.method === "POST") return json(response, 201, ownedProject(requests.at(-1).body));
    return json(response, 405, {});
  });

  const result = await seedAcpProject(scenario, { environment: environment(baseUrl) });

  assert.equal(result.action, "created");
  assert.deepEqual(requests.map(({ method }) => method), ["GET", "POST"]);
  assert.deepEqual(requests[1].body, desiredProjectForScenario(scenario));
});

test("seed refuses an existing project without both exact ownership markers", async () => {
  const methods = [];
  const baseUrl = await startServer((request, response) => {
    methods.push(request.method);
    json(response, 200, ownedProject({
      labels: JSON.stringify({ "acp.dev/demo-creator-owner": "someone-else" }),
    }));
  });

  await assert.rejects(
    seedAcpProject(scenario, { environment: environment(baseUrl) }),
    /Refusing to modify unowned ACP project/,
  );
  assert.deepEqual(methods, ["GET"]);
});

test("seed reconciles an owned project to deterministic state", async () => {
  const requests = [];
  let current = ownedProject({ description: "stale", prompt: "stale" });
  const baseUrl = await startServer(async (request, response) => {
    const body = await jsonBody(request);
    requests.push({ method: request.method, body });
    if (request.method === "GET") return json(response, 200, current);
    if (request.method === "PATCH") {
      current = ownedProject(body);
      return json(response, 200, current);
    }
    return json(response, 405, {});
  });

  const result = await seedAcpProject(scenario, { environment: environment(baseUrl) });

  assert.equal(result.action, "updated");
  assert.deepEqual(result.differences, ["description", "prompt"]);
  assert.deepEqual(requests.map(({ method }) => method), ["GET", "GET", "PATCH", "GET"]);
  assert.deepEqual(requests[2].body, {
    description: desiredProjectForScenario(scenario).description,
    prompt: desiredProjectForScenario(scenario).prompt,
    labels: desiredProjectForScenario(scenario).labels,
    annotations: desiredProjectForScenario(scenario).annotations,
  });
});

test("seed refuses to patch when the project changes after its ownership check", async () => {
  let getCount = 0;
  const methods = [];
  const baseUrl = await startServer((request, response) => {
    methods.push(request.method);
    if (request.method === "GET") {
      getCount += 1;
      const project = ownedProject({
        description: getCount === 1 ? "stale" : "changed concurrently",
      });
      return json(response, 200, project);
    }
    return json(response, 405, {});
  });

  await assert.rejects(
    seedAcpProject(scenario, { environment: environment(baseUrl) }),
    /changed before mutation/,
  );
  assert.deepEqual(methods, ["GET", "GET"]);
});

test("seed dry-run reports changes without mutating ACP", async () => {
  const methods = [];
  const baseUrl = await startServer((request, response) => {
    methods.push(request.method);
    json(response, 404, {});
  });

  const result = await seedAcpProject(scenario, {
    dryRun: true,
    environment: environment(baseUrl),
  });

  assert.deepEqual(result, { action: "would-create", projectName: "demo-example-flow" });
  assert.deepEqual(methods, ["GET"]);
});

test("seed handles a create race only when the winning project is owned", async () => {
  let getCount = 0;
  const baseUrl = await startServer((request, response) => {
    if (request.method === "GET") {
      getCount += 1;
      return getCount === 1
        ? json(response, 404, {})
        : json(response, 200, ownedProject());
    }
    if (request.method === "POST") return json(response, 409, {});
    return json(response, 405, {});
  });

  const result = await seedAcpProject(scenario, { environment: environment(baseUrl) });
  assert.equal(result.action, "unchanged");
});

test("seed bounds conflict reads while allowing a winning create to become visible", async () => {
  let getCount = 0;
  const methods = [];
  const baseUrl = await startServer((request, response) => {
    methods.push(request.method);
    if (request.method === "GET") {
      getCount += 1;
      return getCount < 4
        ? json(response, 404, {})
        : json(response, 200, ownedProject());
    }
    if (request.method === "POST") return json(response, 409, {});
    return json(response, 405, {});
  });

  const result = await seedAcpProject(scenario, { environment: environment(baseUrl) });

  assert.equal(result.action, "unchanged");
  assert.deepEqual(methods, ["GET", "POST", "GET", "GET", "GET"]);
});

test("seed explains an unreadable conflict caused by a reserved soft-deleted name", async () => {
  let getCount = 0;
  const methods = [];
  const baseUrl = await startServer((request, response) => {
    methods.push(request.method);
    if (request.method === "GET") {
      getCount += 1;
      return json(response, 404, {});
    }
    if (request.method === "POST") return json(response, 409, {});
    return json(response, 405, {});
  });

  await assert.rejects(
    seedAcpProject(scenario, { environment: environment(baseUrl) }),
    /unavailable after a prior deletion.*reserves soft-deleted project names/,
  );
  assert.equal(getCount, 4);
  assert.deepEqual(methods, ["GET", "POST", "GET", "GET", "GET"]);
});

test("verify requires marker ownership and exact deterministic state", async () => {
  const baseUrl = await startServer((_request, response) => json(response, 200, ownedProject()));
  const result = await verifyAcpProject(scenario, { environment: environment(baseUrl) });
  assert.equal(result.action, "verified");
});

test("cleanup retains an owned project so its stable name remains reusable", async () => {
  const methods = [];
  const baseUrl = await startServer((request, response) => {
    methods.push(request.method);
    if (request.method === "GET") return json(response, 200, ownedProject());
    return json(response, 405, {});
  });

  const result = await cleanupAcpProject(scenario, { environment: environment(baseUrl) });

  assert.deepEqual(result, { action: "retained-for-reuse", projectName: "demo-example-flow" });
  assert.deepEqual(methods, ["GET"]);
});

test("default cleanup followed by seed reuses the same deterministic project", async () => {
  const methods = [];
  const baseUrl = await startServer((request, response) => {
    methods.push(request.method);
    if (request.method === "GET") return json(response, 200, ownedProject());
    return json(response, 405, {});
  });

  const cleanup = await cleanupAcpProject(scenario, { environment: environment(baseUrl) });
  const seed = await seedAcpProject(scenario, { environment: environment(baseUrl) });

  assert.equal(cleanup.action, "retained-for-reuse");
  assert.equal(seed.action, "unchanged");
  assert.deepEqual(methods, ["GET", "GET"]);
});

test("cleanup refuses to retain owned project state that is no longer deterministic", async () => {
  const methods = [];
  const baseUrl = await startServer((request, response) => {
    methods.push(request.method);
    json(response, 200, ownedProject({ prompt: "changed during capture" }));
  });

  await assert.rejects(
    cleanupAcpProject(scenario, { environment: environment(baseUrl) }),
    /Refusing to retain non-deterministic ACP demo project.*prompt/,
  );
  assert.deepEqual(methods, ["GET"]);
});

test("cleanup refuses unowned projects and honors keepProject", async () => {
  const methods = [];
  let owned = false;
  const baseUrl = await startServer((request, response) => {
    methods.push(request.method);
    json(response, 200, owned ? ownedProject() : ownedProject({ labels: "{}" }));
  });
  const client = createAcpClient({ environment: environment(baseUrl) });

  await assert.rejects(cleanupAcpProject(scenario, { client }), /unowned ACP project/);
  assert.deepEqual(methods, ["GET"]);

  owned = true;
  const kept = await cleanupAcpProject(scenario, { client, keepProject: true });
  assert.deepEqual(kept, { action: "kept", projectName: "demo-example-flow" });
  assert.deepEqual(methods, ["GET", "GET"]);
});

test("cleanup expectPresent fails closed when a seeded project is missing", async () => {
  const methods = [];
  const baseUrl = await startServer((request, response) => {
    methods.push(request.method);
    json(response, 404, {});
  });

  await assert.rejects(
    cleanupAcpProject(scenario, {
      environment: environment(baseUrl),
      expectPresent: true,
    }),
    /disappeared before cleanup verification/,
  );
  assert.deepEqual(methods, ["GET"]);
});

test("cleanup keepProject cannot bypass verification when the project is missing", async () => {
  const methods = [];
  const baseUrl = await startServer((request, response) => {
    methods.push(request.method);
    json(response, 404, {});
  });

  await assert.rejects(
    cleanupAcpProject(scenario, {
      environment: environment(baseUrl),
      keepProject: true,
    }),
    /disappeared before cleanup verification/,
  );
  assert.deepEqual(methods, ["GET"]);
});

test("cleanup dry-run proves ownership and reports reusable retention", async () => {
  const methods = [];
  const baseUrl = await startServer((request, response) => {
    methods.push(request.method);
    json(response, 200, ownedProject());
  });

  const result = await cleanupAcpProject(scenario, {
    dryRun: true,
    environment: environment(baseUrl),
  });

  assert.deepEqual(result, { action: "would-retain-for-reuse", projectName: "demo-example-flow" });
  assert.deepEqual(methods, ["GET"]);
});

test("lifecycle rejects ACP_PROJECT values that do not match the scenario", async () => {
  await assert.rejects(
    seedAcpProject(scenario, {
      environment: environment("https://acp.example.test", "demo-other-flow"),
      fetchImpl: async () => {
        throw new Error("must not issue a request");
      },
    }),
    /ACP project mismatch/,
  );
});
