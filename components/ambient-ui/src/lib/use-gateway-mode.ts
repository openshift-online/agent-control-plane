'use client'

import { usePlatformInfo } from '@/queries/use-platform-info'

export function useGatewayMode(): { enabled: boolean; isLoading: boolean } {
  const { data, isLoading } = usePlatformInfo()

  return {
    enabled: data?.gateway_mode ?? false,
    isLoading,
  }
}
