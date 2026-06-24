export const RoleName = {
  PlatformAdmin: 'platform:admin',
  PlatformViewer: 'platform:viewer',
  ProjectOwner: 'project:owner',
  ProjectEditor: 'project:editor',
  ProjectViewer: 'project:viewer',
  AgentOperator: 'agent:operator',
  AgentObserver: 'agent:observer',
  AgentRunner: 'agent:runner',
  AgentEditor: 'agent:editor',
  CredentialOwner: 'credential:owner',
  CredentialViewer: 'credential:viewer',
  CredentialTokenReader: 'credential:token-reader',
} as const

export type RoleNameValue = (typeof RoleName)[keyof typeof RoleName]

const ROLE_LEVEL: Record<string, number> = {
  [RoleName.PlatformAdmin]: 4,
  [RoleName.ProjectOwner]: 3,
  [RoleName.ProjectEditor]: 2,
  [RoleName.ProjectViewer]: 1,
}

export function getRoleLevel(roleName: string | null): number {
  return roleName ? (ROLE_LEVEL[roleName] ?? 0) : 0
}

export function canEditProject(roleName: string | null): boolean {
  return getRoleLevel(roleName) >= ROLE_LEVEL[RoleName.ProjectEditor]!
}

export function getDisplayRole(roleName: string): string {
  const parts = roleName.split(':')
  const label = parts[parts.length - 1] ?? roleName
  return label.charAt(0).toUpperCase() + label.slice(1)
}
