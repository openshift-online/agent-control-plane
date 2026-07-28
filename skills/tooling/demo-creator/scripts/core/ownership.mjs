export const OWNERSHIP_LABEL = "acp.dev/demo-creator-owner";
export const OWNERSHIP_VALUE = "demo-creator-skill-v1";
export const SCENARIO_LABEL = "acp.dev/demo-creator-scenario";

export function ownershipMarker(scenarioId) {
  return Object.freeze({
    [OWNERSHIP_LABEL]: OWNERSHIP_VALUE,
    [SCENARIO_LABEL]: scenarioId,
  });
}

export function expectedProjectName(scenarioId) {
  const projectName = `demo-${scenarioId}`;
  if (projectName.length > 63) throw new Error("Scenario id is too long to derive an ACP project name");
  return projectName;
}

export function assertProjectOwned(project, scenarioId) {
  if (!project || typeof project !== "object") throw new Error("Project metadata is required before mutation");
  const labels = project.labels ?? project.metadata?.labels ?? {};
  if (labels[OWNERSHIP_LABEL] !== OWNERSHIP_VALUE || labels[SCENARIO_LABEL] !== scenarioId) {
    throw new Error(`Refusing to modify unowned ACP project ${project.name ?? project.metadata?.name ?? "<unknown>"}`);
  }
  return true;
}

export function assertProjectName(projectName, scenario) {
  const expected = expectedProjectName(scenario.id);
  if (scenario.acp?.project !== expected) {
    throw new Error(`Scenario ACP project must be ${expected}`);
  }
  if (projectName !== scenario.acp.project) {
    throw new Error(`ACP project mismatch: expected ${expected}`);
  }
  return true;
}
