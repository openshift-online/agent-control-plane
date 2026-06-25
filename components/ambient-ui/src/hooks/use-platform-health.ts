'use client'

import { useQuery } from '@tanstack/react-query'
import { useCurrentUser } from '@/hooks/use-current-user'

type ComponentStatus = 'healthy' | 'unreachable' | 'unchecked'

type PlatformHealthResponse = {
  components: {
    apiServer: ComponentStatus
    controlPlane: ComponentStatus
  }
}

type UsePlatformHealthReturn = {
  apiServer: ComponentStatus
  controlPlane: ComponentStatus
  isHealthy: boolean
  isLoading: boolean
}

async function fetchPlatformHealth(): Promise<PlatformHealthResponse> {
  const res = await fetch('/api/health/platform')
  if (!res.ok) {
    throw new Error(`Platform health check failed: ${res.status}`)
  }
  return res.json() as Promise<PlatformHealthResponse>
}

export function usePlatformHealth(): UsePlatformHealthReturn {
  const { user, isLoading: userLoading } = useCurrentUser()

  const { data, isPending } = useQuery({
    queryKey: ['platform-health'],
    queryFn: fetchPlatformHealth,
    refetchInterval: 30_000,
    retry: 1,
    enabled: user !== null,
  })

  if (userLoading || user === null) {
    return { apiServer: 'healthy', controlPlane: 'unchecked', isHealthy: true, isLoading: true }
  }

  const apiServer = data?.components.apiServer ?? 'healthy'
  const controlPlane = data?.components.controlPlane ?? 'unchecked'

  const isHealthy =
    apiServer === 'healthy' &&
    (controlPlane === 'healthy' || controlPlane === 'unchecked')

  return { apiServer, controlPlane, isHealthy, isLoading: isPending }
}
