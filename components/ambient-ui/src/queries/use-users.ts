'use client'

import { useQuery } from '@tanstack/react-query'
import type { UsersPort } from '@/ports/users'
import { createUsersAdapter } from '@/adapters/sdk-users'
import { queryKeys } from './query-keys'

let defaultPort: UsersPort | null = null

function getDefaultPort(): UsersPort {
  if (!defaultPort) {
    defaultPort = createUsersAdapter()
  }
  return defaultPort
}

export function useUserSearch(
  query: string,
  port?: UsersPort,
) {
  const adapter = port ?? getDefaultPort()
  return useQuery({
    queryKey: [...queryKeys.users.all, 'search', query],
    queryFn: () => adapter.search(query),
    enabled: query.length >= 1,
    staleTime: 30_000,
  })
}
