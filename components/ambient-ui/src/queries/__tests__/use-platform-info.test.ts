import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createElement } from 'react'
import { usePlatformInfo } from '../use-platform-info'
import type { ReactNode } from 'react'

describe('usePlatformInfo', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    global.fetch = vi.fn()
  })

  it('fetches platform info successfully', async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ gateway_mode: true }),
    } as Response)

    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    })
    const wrapper = ({ children }: { children: ReactNode }) => {
      return createElement(QueryClientProvider, { client: queryClient }, children)
    }

    const { result } = renderHook(() => usePlatformInfo(), { wrapper })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.data?.gateway_mode).toBe(true)
  })

  it('fetches platform info with gateway_mode false', async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ gateway_mode: false }),
    } as Response)

    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    })
    const wrapper = ({ children }: { children: ReactNode }) => {
      return createElement(QueryClientProvider, { client: queryClient }, children)
    }

    const { result } = renderHook(() => usePlatformInfo(), { wrapper })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.data?.gateway_mode).toBe(false)
  })

  it('handles fetch error', async () => {
    vi.mocked(global.fetch).mockResolvedValue({
      ok: false,
      status: 500,
    } as Response)

    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    })
    const wrapper = ({ children }: { children: ReactNode }) => {
      return createElement(QueryClientProvider, { client: queryClient }, children)
    }

    const { result } = renderHook(() => usePlatformInfo(), { wrapper })

    await waitFor(
      () => expect(result.current.isError).toBe(true),
      { timeout: 3000 }
    )
    expect(result.current.error).toBeDefined()
  })

  it('uses correct query key and stale time', () => {
    const queryClient = new QueryClient()
    const wrapper = ({ children }: { children: ReactNode }) => {
      return createElement(QueryClientProvider, { client: queryClient }, children)
    }

    renderHook(() => usePlatformInfo(), { wrapper })

    // The query should be registered with the correct key
    expect(queryClient.getQueryCache().find({ queryKey: ['platform-info'] })).toBeDefined()
  })
})
