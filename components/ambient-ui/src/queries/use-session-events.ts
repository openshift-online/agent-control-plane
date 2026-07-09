'use client'

import { useQuery } from '@tanstack/react-query'
import type { SessionEventsPort, SessionEventListParams } from '@/ports/session-events'
import { createSessionEventsAdapterWithFetch } from '@/adapters/session-events'
import { queryKeys } from './query-keys'

let defaultPort: SessionEventsPort | null = null

function getDefaultPort(): SessionEventsPort {
  if (!defaultPort) {
    defaultPort = createSessionEventsAdapterWithFetch()
  }
  return defaultPort
}

export function useSessionEvents(
  sessionId: string,
  params?: SessionEventListParams,
  port?: SessionEventsPort,
) {
  const adapter = port ?? getDefaultPort()
  return useQuery({
    queryKey: queryKeys.sessionEvents.list(sessionId),
    queryFn: () => adapter.list(sessionId, params),
    enabled: !!sessionId,
  })
}
