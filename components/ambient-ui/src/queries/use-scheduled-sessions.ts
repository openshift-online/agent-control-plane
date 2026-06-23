'use client'

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { ScheduledSessionsPort } from '@/ports/scheduled-sessions'
import type {
  DomainScheduledSessionCreateRequest,
  DomainScheduledSessionUpdateRequest,
  ListParams,
} from '@/domain/types'
import { queryKeys } from './query-keys'
import { createScheduledSessionsAdapter } from '@/adapters/sdk-scheduled-sessions'

let defaultPort: ScheduledSessionsPort | null = null
function getDefaultPort(): ScheduledSessionsPort {
  if (!defaultPort) defaultPort = createScheduledSessionsAdapter()
  return defaultPort
}

export function useScheduledSessions(
  projectId: string,
  params?: ListParams,
  port?: ScheduledSessionsPort,
) {
  const adapter = port ?? getDefaultPort()
  return useQuery({
    queryKey: queryKeys.scheduledSessions.list(projectId, params),
    queryFn: () => adapter.list(projectId, params),
    enabled: !!projectId,
  })
}

export function useScheduledSession(
  projectId: string,
  id: string,
  port?: ScheduledSessionsPort,
) {
  const adapter = port ?? getDefaultPort()
  return useQuery({
    queryKey: queryKeys.scheduledSessions.detail(projectId, id),
    queryFn: () => adapter.get(projectId, id),
    enabled: !!projectId && !!id,
  })
}

export function useScheduledSessionRuns(
  projectId: string,
  id: string,
  port?: ScheduledSessionsPort,
) {
  const adapter = port ?? getDefaultPort()
  return useQuery({
    queryKey: queryKeys.scheduledSessions.runs(projectId, id),
    queryFn: () => adapter.runs(projectId, id),
    enabled: !!projectId && !!id,
  })
}

export function useCreateScheduledSession(port?: ScheduledSessionsPort) {
  const queryClient = useQueryClient()
  const adapter = port ?? getDefaultPort()
  return useMutation({
    mutationFn: ({ projectId, request }: { projectId: string; request: DomainScheduledSessionCreateRequest }) =>
      adapter.create(projectId, request),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.scheduledSessions.all })
    },
  })
}

export function useUpdateScheduledSession(port?: ScheduledSessionsPort) {
  const queryClient = useQueryClient()
  const adapter = port ?? getDefaultPort()
  return useMutation({
    mutationFn: ({ projectId, id, request }: { projectId: string; id: string; request: DomainScheduledSessionUpdateRequest }) =>
      adapter.update(projectId, id, request),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.scheduledSessions.all })
    },
  })
}

export function useDeleteScheduledSession(port?: ScheduledSessionsPort) {
  const queryClient = useQueryClient()
  const adapter = port ?? getDefaultPort()
  return useMutation({
    mutationFn: ({ projectId, id }: { projectId: string; id: string }) =>
      adapter.delete(projectId, id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.scheduledSessions.all })
    },
  })
}

export function useSuspendScheduledSession(port?: ScheduledSessionsPort) {
  const queryClient = useQueryClient()
  const adapter = port ?? getDefaultPort()
  return useMutation({
    mutationFn: ({ projectId, id }: { projectId: string; id: string }) =>
      adapter.suspend(projectId, id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.scheduledSessions.all })
    },
  })
}

export function useResumeScheduledSession(port?: ScheduledSessionsPort) {
  const queryClient = useQueryClient()
  const adapter = port ?? getDefaultPort()
  return useMutation({
    mutationFn: ({ projectId, id }: { projectId: string; id: string }) =>
      adapter.resume(projectId, id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.scheduledSessions.all })
    },
  })
}

export function useTriggerScheduledSession(port?: ScheduledSessionsPort) {
  const queryClient = useQueryClient()
  const adapter = port ?? getDefaultPort()
  return useMutation({
    mutationFn: ({ projectId, id }: { projectId: string; id: string }) =>
      adapter.trigger(projectId, id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.scheduledSessions.all })
      queryClient.invalidateQueries({ queryKey: queryKeys.sessions.all })
    },
  })
}
