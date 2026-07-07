'use client'

import { useQuery } from '@tanstack/react-query'
import type { SandboxObservabilityPort } from '@/ports/sandbox-observability'
import { createSandboxObservabilityAdapterWithFetch } from '@/adapters/sandbox-observability'
import { queryKeys } from './query-keys'

let defaultPort: SandboxObservabilityPort | null = null

function getDefaultPort(): SandboxObservabilityPort {
  if (!defaultPort) {
    defaultPort = createSandboxObservabilityAdapterWithFetch()
  }
  return defaultPort
}

export function useSandboxPolicy(
  sessionId: string,
  port?: SandboxObservabilityPort,
) {
  const adapter = port ?? getDefaultPort()
  return useQuery({
    queryKey: queryKeys.sandboxPolicy.detail(sessionId),
    queryFn: () => adapter.getPolicy(sessionId),
    enabled: !!sessionId,
    staleTime: 30_000,
  })
}
