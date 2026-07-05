'use client'

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { ApplicationsPort } from '@/ports/applications'
import type { DomainApplicationCreateRequest, DomainApplicationUpdateRequest, ListParams } from '@/domain/types'
import { createApplicationsAdapter } from '@/adapters/sdk-applications'
import { queryKeys } from './query-keys'

let defaultPort: ApplicationsPort | null = null

function getDefaultPort(): ApplicationsPort {
  if (!defaultPort) {
    defaultPort = createApplicationsAdapter()
  }
  return defaultPort
}

export function useApplications(params?: ListParams, port?: ApplicationsPort, enabled = true) {
  const adapter = port ?? getDefaultPort()
  return useQuery({
    queryKey: queryKeys.applications.list(params),
    queryFn: () => adapter.list(params),
    enabled,
  })
}

export function useApplication(id: string, port?: ApplicationsPort) {
  const adapter = port ?? getDefaultPort()
  return useQuery({
    queryKey: queryKeys.applications.detail(id),
    queryFn: () => adapter.get(id),
    enabled: !!id,
  })
}

export function useCreateApplication(port?: ApplicationsPort) {
  const queryClient = useQueryClient()
  const adapter = port ?? getDefaultPort()
  return useMutation({
    mutationFn: (request: DomainApplicationCreateRequest) =>
      adapter.create(request),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.applications.all })
    },
  })
}

export function useUpdateApplication(port?: ApplicationsPort) {
  const queryClient = useQueryClient()
  const adapter = port ?? getDefaultPort()
  return useMutation({
    mutationFn: ({ id, request }: { id: string; request: DomainApplicationUpdateRequest }) =>
      adapter.update(id, request),
    onSuccess: (updatedApp, { id }) => {
      queryClient.setQueryData(queryKeys.applications.detail(id), updatedApp)
      queryClient.invalidateQueries({ queryKey: queryKeys.applications.lists() })
    },
  })
}

export function useDeleteApplication(port?: ApplicationsPort) {
  const queryClient = useQueryClient()
  const adapter = port ?? getDefaultPort()
  return useMutation({
    mutationFn: (id: string) =>
      adapter.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.applications.all })
    },
  })
}
