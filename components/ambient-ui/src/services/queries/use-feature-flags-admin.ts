// TODO: Replace with real Unleash/workspace feature flag evaluation.
// This stub always returns { enabled: true } so that feature-flag-gated
// surfaces compile and render during development. The production
// implementation should evaluate against the workspace's ConfigMap overrides
// and the Unleash server state.

export function useWorkspaceFlag(
  _projectName: string | undefined,
  _flagName: string,
): { enabled: boolean } {
  return { enabled: true }
}
