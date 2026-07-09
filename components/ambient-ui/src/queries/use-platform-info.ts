'use client'

import { useQuery } from '@tanstack/react-query'
import { queryKeys } from './query-keys'

export type PlatformInfo = {
  gateway_mode: boolean
}

async function fetchPlatformInfo(): Promise<PlatformInfo> {
  const res = await fetch('/api/ambient/v1/platform-info')
  if (!res.ok) {
    throw new Error(`platform-info returned ${res.status}`)
  }
  return res.json()
}

export function usePlatformInfo() {
  return useQuery({
    queryKey: queryKeys.platformInfo.all,
    queryFn: fetchPlatformInfo,
    staleTime: 5 * 60 * 1000, // 5 min — config rarely changes
    retry: 1,
  })
}
