import { setTimeout as delay } from "node:timers/promises";
import {
  OWNERSHIP_LABEL,
  OWNERSHIP_VALUE,
  SCENARIO_LABEL,
  assertProjectName,
  expectedProjectName,
  ownershipMarker,
} from "../core/ownership.mjs";
import { AcpRequestError, createAcpClient } from "./client.mjs";

export const SEED_ANNOTATION = "acp.dev/demo-creator-seed";
export const SEED_VERSION = "project-v1";
const CONFLICT_READ_ATTEMPTS = 3;
const CONFLICT_READ_DELAY_MILLISECONDS = 100;

function sortedJson(value) {
  return JSON.stringify(Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))));
}

function stringMap(value, fieldName) {
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new Error(`ACP project ${fieldName} is not valid JSON`);
    }
  }
  if (parsed === undefined || parsed === null || parsed === "") return {};
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`ACP project ${fieldName} must be a JSON object`);
  }
  for (const [key, mapValue] of Object.entries(parsed)) {
    if (typeof mapValue !== "string") {
      throw new Error(`ACP project ${fieldName}.${key} must be a string`);
    }
  }
  return parsed;
}

function scenarioContext(scenario, client) {
  if (!scenario || typeof scenario !== "object" || typeof scenario.id !== "string") {
    throw new Error("A validated demo scenario is required");
  }
  const name = expectedProjectName(scenario.id);
  assertProjectName(client.project, scenario);
  return { name, scenarioId: scenario.id };
}

export function desiredProjectForScenario(scenario) {
  if (!scenario || typeof scenario !== "object" || typeof scenario.id !== "string") {
    throw new Error("A validated demo scenario is required");
  }
  const name = expectedProjectName(scenario.id);
  if (scenario.acp?.project !== name) {
    throw new Error(`Scenario ACP project must be ${name}`);
  }
  return Object.freeze({
    name,
    description: `Dedicated reusable demo-creator project for scenario ${scenario.id}.`,
    prompt: `Use deterministic synthetic data for demo scenario ${scenario.id}.`,
    labels: sortedJson(ownershipMarker(scenario.id)),
    annotations: sortedJson({ [SEED_ANNOTATION]: SEED_VERSION }),
  });
}

export function assertOwnedProject(project, scenario) {
  const expectedName = expectedProjectName(scenario.id);
  if (!project || typeof project !== "object" || project.name !== expectedName) {
    throw new Error(`Refusing to modify ACP project whose name is not ${expectedName}`);
  }
  const labels = stringMap(project.labels, "labels");
  if (labels[OWNERSHIP_LABEL] !== OWNERSHIP_VALUE || labels[SCENARIO_LABEL] !== scenario.id) {
    throw new Error(`Refusing to modify unowned ACP project ${expectedName}`);
  }
  return project;
}

function deterministicDifferences(project, desired) {
  const differences = [];
  if (project.name !== desired.name) differences.push("name");
  if (project.description !== desired.description) differences.push("description");
  if (project.prompt !== desired.prompt) differences.push("prompt");
  if (sortedJson(stringMap(project.labels, "labels")) !== desired.labels) differences.push("labels");
  if (sortedJson(stringMap(project.annotations, "annotations")) !== desired.annotations) differences.push("annotations");
  return differences;
}

function mutationFingerprint(project) {
  return JSON.stringify({
    id: project.id ?? null,
    name: project.name ?? null,
    description: project.description ?? null,
    prompt: project.prompt ?? null,
    labels: sortedJson(stringMap(project.labels, "labels")),
    annotations: sortedJson(stringMap(project.annotations, "annotations")),
  });
}

async function confirmProjectUnchanged(client, name, observed, scenario, signal) {
  const current = await client.getProject(name, { signal });
  if (!current) throw new Error(`ACP demo project ${name} disappeared before mutation`);
  assertOwnedProject(current, scenario);
  if (mutationFingerprint(current) !== mutationFingerprint(observed)) {
    throw new Error(`ACP demo project ${name} changed before mutation; rerun after reviewing its current state`);
  }
  return current;
}

function lifecycleClient(options) {
  return options.client ?? createAcpClient(options);
}

async function readProjectAfterConflict(client, name, signal) {
  for (let attempt = 1; attempt <= CONFLICT_READ_ATTEMPTS; attempt += 1) {
    const project = await client.getProject(name, { signal });
    if (project) return project;
    if (attempt < CONFLICT_READ_ATTEMPTS) {
      await delay(CONFLICT_READ_DELAY_MILLISECONDS, undefined, { signal });
    }
  }
  return null;
}

export async function verifyAcpProject(scenario, options = {}) {
  const client = lifecycleClient(options);
  const { name } = scenarioContext(scenario, client);
  const desired = desiredProjectForScenario(scenario);
  const project = await client.getProject(name, { signal: options.signal });
  if (!project) throw new Error(`ACP demo project ${name} does not exist`);
  assertOwnedProject(project, scenario);
  const differences = deterministicDifferences(project, desired);
  if (differences.length > 0) {
    throw new Error(`ACP demo project ${name} is not deterministic: ${differences.join(", ")}`);
  }
  return Object.freeze({ action: "verified", project });
}

export async function seedAcpProject(scenario, options = {}) {
  const client = lifecycleClient(options);
  const { name } = scenarioContext(scenario, client);
  const desired = desiredProjectForScenario(scenario);
  let existing = await client.getProject(name, { signal: options.signal });

  if (!existing) {
    if (options.dryRun) return Object.freeze({ action: "would-create", projectName: name });
    try {
      const created = await client.createProject(desired, { signal: options.signal });
      assertOwnedProject(created, scenario);
      const remaining = deterministicDifferences(created, desired);
      if (remaining.length > 0) {
        throw new Error(`ACP demo project ${name} was created with non-deterministic fields: ${remaining.join(", ")}`);
      }
      return Object.freeze({ action: "created", project: created });
    } catch (error) {
      if (!(error instanceof AcpRequestError) || error.status !== 409) throw error;
      existing = await readProjectAfterConflict(client, name, options.signal);
      if (!existing) {
        throw new Error(
          `ACP demo project ${name} is unavailable after a prior deletion; `
          + "ACP reserves soft-deleted project names, so restore or remove the tombstone before retrying",
        );
      }
    }
  }

  assertOwnedProject(existing, scenario);
  const differences = deterministicDifferences(existing, desired);
  if (differences.length === 0) return Object.freeze({ action: "unchanged", project: existing });
  if (options.dryRun) {
    return Object.freeze({ action: "would-update", projectName: name, differences });
  }
  await confirmProjectUnchanged(client, name, existing, scenario, options.signal);
  const updated = await client.updateProject(name, {
    description: desired.description,
    prompt: desired.prompt,
    labels: desired.labels,
    annotations: desired.annotations,
  }, { signal: options.signal });
  assertOwnedProject(updated, scenario);
  const remaining = deterministicDifferences(updated, desired);
  if (remaining.length > 0) {
    throw new Error(`ACP demo project ${name} remained non-deterministic after seeding: ${remaining.join(", ")}`);
  }
  const verified = await client.getProject(name, { signal: options.signal });
  if (!verified) throw new Error(`ACP demo project ${name} disappeared after seeding`);
  assertOwnedProject(verified, scenario);
  const verifiedDifferences = deterministicDifferences(verified, desired);
  if (verifiedDifferences.length > 0) {
    throw new Error(`ACP demo project ${name} did not retain deterministic state after seeding: ${verifiedDifferences.join(", ")}`);
  }
  return Object.freeze({ action: "updated", project: verified, differences });
}

export async function cleanupAcpProject(scenario, options = {}) {
  const client = lifecycleClient(options);
  const { name } = scenarioContext(scenario, client);
  const existing = await client.getProject(name, { signal: options.signal });
  if (!existing) {
    if (options.expectPresent === true || options.keepProject === true) {
      throw new Error(`ACP demo project ${name} disappeared before cleanup verification`);
    }
    return Object.freeze({ action: "absent", projectName: name });
  }
  assertOwnedProject(existing, scenario);
  const differences = deterministicDifferences(existing, desiredProjectForScenario(scenario));
  if (differences.length > 0) {
    throw new Error(`Refusing to retain non-deterministic ACP demo project ${name}: ${differences.join(", ")}`);
  }
  if (options.keepProject === true) return Object.freeze({ action: "kept", projectName: name });
  if (options.dryRun) return Object.freeze({ action: "would-retain-for-reuse", projectName: name });

  // ACP soft-deletes projects while reserving the name-backed project ID. A
  // DELETE therefore makes the stable scenario name impossible to recreate.
  // Retain only the exactly marker-owned deterministic envelope; the next seed
  // re-verifies ownership and reconciles its declared state before reuse.
  return Object.freeze({ action: "retained-for-reuse", projectName: name });
}
