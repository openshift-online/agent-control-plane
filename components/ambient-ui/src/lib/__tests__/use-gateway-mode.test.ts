import { renderHook } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { useGatewayMode } from '../use-gateway-mode'
import type { UseQueryResult } from '@tanstack/react-query'
import type { PlatformInfo } from '@/queries/use-platform-info'

vi.mock('@/queries/use-platform-info', () => ({
  usePlatformInfo: vi.fn(),
}))

import { usePlatformInfo } from '@/queries/use-platform-info'

describe('useGatewayMode', () => {
  it('returns enabled=true when platform info says gateway mode', () => {
    vi.mocked(usePlatformInfo).mockReturnValue({
      data: { gateway_mode: true },
      isLoading: false,
      isError: false,
      error: null,
    } as UseQueryResult<PlatformInfo, Error>)

    const { result } = renderHook(() => useGatewayMode())
    expect(result.current.enabled).toBe(true)
    expect(result.current.isLoading).toBe(false)
  })

  it('returns enabled=false when platform info says no gateway mode', () => {
    vi.mocked(usePlatformInfo).mockReturnValue({
      data: { gateway_mode: false },
      isLoading: false,
      isError: false,
      error: null,
    } as UseQueryResult<PlatformInfo, Error>)

    const { result } = renderHook(() => useGatewayMode())
    expect(result.current.enabled).toBe(false)
    expect(result.current.isLoading).toBe(false)
  })

  it('returns enabled=false when data is undefined', () => {
    vi.mocked(usePlatformInfo).mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: false,
      error: null,
    } as UseQueryResult<PlatformInfo, Error>)

    const { result } = renderHook(() => useGatewayMode())
    expect(result.current.enabled).toBe(false)
    expect(result.current.isLoading).toBe(false)
  })

  it('returns isLoading=true when platform info is loading', () => {
    vi.mocked(usePlatformInfo).mockReturnValue({
      data: undefined,
      isLoading: true,
      isError: false,
      error: null,
    } as UseQueryResult<PlatformInfo, Error>)

    const { result } = renderHook(() => useGatewayMode())
    expect(result.current.enabled).toBe(false)
    expect(result.current.isLoading).toBe(true)
  })
})
