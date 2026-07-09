'use client'

import { useQuery } from '@tanstack/react-query'
import type { PoliciesPort } from '@/ports/policies'
import { createPoliciesAdapter } from '@/adapters/sdk-policies'
import { queryKeys } from './query-keys'

let defaultPort: PoliciesPort | null = null

function getDefaultPort(): PoliciesPort {
  if (!defaultPort) {
    defaultPort = createPoliciesAdapter()
  }
  return defaultPort
}

export function usePolicies(
  projectId: string,
  port?: PoliciesPort,
) {
  const adapter = port ?? getDefaultPort()
  return useQuery({
    queryKey: queryKeys.policies.list(projectId),
    queryFn: () => adapter.list(projectId),
    enabled: !!projectId,
  })
}

export function usePolicy(
  projectId: string,
  id: string,
  port?: PoliciesPort,
) {
  const adapter = port ?? getDefaultPort()
  return useQuery({
    queryKey: queryKeys.policies.detail(projectId, id),
    queryFn: () => adapter.get(projectId, id),
    enabled: !!projectId && !!id,
  })
}
