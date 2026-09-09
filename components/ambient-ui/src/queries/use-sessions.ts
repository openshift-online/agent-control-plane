'use client'

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { SessionsPort } from '@/ports/sessions'
import type { DomainSession, DomainSessionCreateRequest, ListParams, SessionPhase } from '@/domain/types'
import { createSessionsAdapter } from '@/adapters/sdk-sessions'
import { queryKeys } from './query-keys'

const TRANSITIONING_PHASES: ReadonlySet<SessionPhase> = new Set([
  'Pending',
  'Creating',
  'Stopping',
])

const TERMINAL_PHASES: ReadonlySet<SessionPhase> = new Set([
  'Completed',
  'Failed',
  'Stopped',
])

type PollingSession = Pick<DomainSession, 'phase' | 'runtime'>

const TRANSITIONING_RUNTIME_STATES = new Set([
  'Provisioning', 'Pending', 'WaitingForGateway', 'Creating',
  'Stopping', 'Deleting', 'DeletionRequested',
])

export function getSessionPollingInterval(session: PollingSession | undefined): number | false {
  if (!session) return 3000
  if (TRANSITIONING_PHASES.has(session.phase) || (
    session.runtime?.backend === 'hypershell' &&
    TRANSITIONING_RUNTIME_STATES.has(session.runtime.status ?? '')
  )) return 1000
  if (TERMINAL_PHASES.has(session.phase)) {
    if (session.runtime?.backend === 'hypershell' &&
      session.runtime.status !== 'Stopped' && session.runtime.status !== 'Deleted') return 1000
    return false
  }
  return 3000
}

export function getPollingInterval(sessions: PollingSession[] | undefined): number | false {
  if (!sessions || sessions.length === 0) return 15000
  const intervals = sessions.map(getSessionPollingInterval)
  if (intervals.includes(1000)) return 1000
  if (intervals.every(interval => interval === false)) return false
  return 3000
}

let defaultPort: SessionsPort | null = null

function getDefaultPort(): SessionsPort {
  if (!defaultPort) {
    defaultPort = createSessionsAdapter()
  }
  return defaultPort
}

export function useSessions(
  projectId: string,
  params?: ListParams,
  port?: SessionsPort,
) {
  const adapter = port ?? getDefaultPort()
  return useQuery({
    queryKey: queryKeys.sessions.list(projectId, params),
    queryFn: () => adapter.list(projectId, params),
    enabled: !!projectId,
    refetchInterval: (query) => {
      const result = query.state.data
      return getPollingInterval(result?.items)
    },
  })
}

export function useAllSessions(
  port?: SessionsPort,
) {
  const adapter = port ?? getDefaultPort()
  return useQuery({
    queryKey: queryKeys.sessions.listAll(),
    queryFn: () => adapter.listAll({ size: 200 }),
    refetchInterval: 10_000,
  })
}

export function useSessionPhaseCounts(
  projectId: string,
  port?: SessionsPort,
) {
  const adapter = port ?? getDefaultPort()
  return useQuery({
    queryKey: queryKeys.sessions.phaseCounts(projectId),
    queryFn: () => adapter.phaseCounts(projectId),
    enabled: !!projectId,
    staleTime: 4000,
    refetchInterval: 5000,
  })
}

export function useSession(
  sessionId: string,
  port?: SessionsPort,
) {
  const adapter = port ?? getDefaultPort()
  return useQuery({
    queryKey: queryKeys.sessions.detail(sessionId),
    queryFn: () => adapter.get(sessionId),
    enabled: !!sessionId,
    refetchInterval: (query) => {
      return getSessionPollingInterval(query.state.data)
    },
  })
}

export function useStopSession(port?: SessionsPort) {
  const queryClient = useQueryClient()
  const adapter = port ?? getDefaultPort()

  return useMutation({
    mutationFn: (sessionId: string) => adapter.stop(sessionId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.sessions.all })
    },
  })
}

export function useStartSession(port?: SessionsPort) {
  const queryClient = useQueryClient()
  const adapter = port ?? getDefaultPort()

  return useMutation({
    mutationFn: (sessionId: string) => adapter.start(sessionId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.sessions.all })
    },
  })
}

export function useDeleteSession(port?: SessionsPort) {
  const queryClient = useQueryClient()
  const adapter = port ?? getDefaultPort()

  return useMutation({
    mutationFn: (sessionId: string) => adapter.delete(sessionId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.sessions.all })
    },
  })
}

export function useCreateSession(port?: SessionsPort) {
  const queryClient = useQueryClient()
  const adapter = port ?? getDefaultPort()

  return useMutation({
    mutationFn: (request: DomainSessionCreateRequest) => adapter.create(request),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.sessions.all })
    },
  })
}
