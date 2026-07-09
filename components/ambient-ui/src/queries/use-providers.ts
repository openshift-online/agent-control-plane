'use client'

import { useQuery } from '@tanstack/react-query'
import type { ProvidersPort } from '@/ports/providers'
import { createProvidersAdapter } from '@/adapters/sdk-providers'
import { queryKeys } from './query-keys'

let defaultPort: ProvidersPort | null = null

function getDefaultPort(): ProvidersPort {
  if (!defaultPort) {
    defaultPort = createProvidersAdapter()
  }
  return defaultPort
}

export function useProviders(
  projectId: string,
  port?: ProvidersPort,
) {
  const adapter = port ?? getDefaultPort()
  return useQuery({
    queryKey: queryKeys.providers.list(projectId),
    queryFn: () => adapter.list(projectId),
    enabled: !!projectId,
  })
}

export function useProvider(
  projectId: string,
  id: string,
  port?: ProvidersPort,
) {
  const adapter = port ?? getDefaultPort()
  return useQuery({
    queryKey: queryKeys.providers.detail(projectId, id),
    queryFn: () => adapter.get(projectId, id),
    enabled: !!projectId && !!id,
  })
}
