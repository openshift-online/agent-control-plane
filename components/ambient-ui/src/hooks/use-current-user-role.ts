import { useCurrentUser } from './use-current-user'
import { useAllRoleBindings } from '@/queries/use-role-bindings'
import { useRoles } from '@/queries/use-roles'
import { useMemo } from 'react'

const ADMIN_GROUP = '/ambient-admins'

export function useCurrentUserRole(projectId: string): {
  roleName: string | null
  isLoading: boolean
} {
  const { user, isLoading: userLoading } = useCurrentUser()
  const searchFilter = `user_id = '${user?.username}'`
  const { data: bindings, isLoading: bindingsLoading } = useAllRoleBindings(
    user?.username ? searchFilter : undefined,
  )
  const { data: rolesData, isLoading: rolesLoading } = useRoles()

  const roleName = useMemo(() => {
    if (user?.groups?.includes(ADMIN_GROUP)) return 'platform:admin'

    if (!bindings || bindings.length === 0 || !rolesData) return null

    const relevant = bindings.filter(
      (b) => b.scope === 'global' || b.projectId === projectId,
    )
    if (relevant.length === 0) return null

    const roleMap = new Map(rolesData.items?.map(r => [r.id, r.name]) ?? [])

    const roles = relevant.map((b) => roleMap.get(b.roleId)).filter(Boolean) as string[]
    if (roles.includes('platform:admin')) return 'platform:admin'
    if (roles.includes('project:owner')) return 'project:owner'
    if (roles.includes('project:editor')) return 'project:editor'
    if (roles.includes('agent:operator')) return 'agent:operator'
    if (roles.includes('project:viewer')) return 'project:viewer'

    return roles[0] ?? null
  }, [user, bindings, rolesData, projectId])

  return { roleName, isLoading: userLoading || bindingsLoading || rolesLoading }
}
