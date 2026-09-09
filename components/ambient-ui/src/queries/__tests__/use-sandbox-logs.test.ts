import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useSandboxLogs } from '../use-sandbox-logs'
import type { SandboxObservabilityPort } from '@/ports/sandbox-observability'

class FakeEventSource {
  static instances: FakeEventSource[] = []
  onopen: (() => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: (() => void) | null = null
  close = vi.fn()
  addEventListener = vi.fn()
  constructor(readonly url: string) { FakeEventSource.instances.push(this) }
}
const port: SandboxObservabilityPort = {
  getLogsUrl: session => `/logs/${session}`,
  getPolicy: async () => { throw new Error('unused') },
}

beforeEach(() => {
  vi.useFakeTimers()
  FakeEventSource.instances = []
  vi.stubGlobal('EventSource', FakeEventSource)
})
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals() })

describe('sandbox log retries', () => {
  it('stops after five retries and permits an explicit retry with no entries', () => {
    const { result } = renderHook(() => useSandboxLogs('session-a', true, port))
    for (let attempt = 0; attempt < 5; attempt++) {
      act(() => FakeEventSource.instances[attempt].onerror?.())
      expect(result.current.isReconnecting).toBe(true)
      act(() => vi.advanceTimersByTime(3000))
    }
    act(() => FakeEventSource.instances[5].onerror?.())
    expect(result.current.isReconnecting).toBe(false)
    expect(result.current.isConnected).toBe(false)
    expect(result.current.error).toMatch('five retries')
    expect(result.current.entries).toEqual([])
    act(() => vi.advanceTimersByTime(30000))
    expect(FakeEventSource.instances).toHaveLength(6)
    act(() => result.current.retry())
    expect(result.current.error).toBeNull()
    expect(FakeEventSource.instances).toHaveLength(7)
    act(() => FakeEventSource.instances[6].onopen?.())
    expect(result.current.isConnected).toBe(true)
  })

  it('clears an exhausted connection error when streaming stops', () => {
    const { result, rerender } = renderHook(({enabled}) => useSandboxLogs('session-a', enabled, port), {initialProps: {enabled: true}})
    for (let attempt = 0; attempt < 5; attempt++) {
      act(() => FakeEventSource.instances[attempt].onerror?.())
      act(() => vi.advanceTimersByTime(3000))
    }
    act(() => FakeEventSource.instances[5].onerror?.())
    expect(result.current.error).toMatch('five retries')
    rerender({enabled: false})
    expect(result.current.error).toBeNull()
    expect(result.current.isReconnecting).toBe(false)
    act(() => result.current.retry())
    act(() => vi.advanceTimersByTime(30000))
    expect(FakeEventSource.instances).toHaveLength(6)
  })

  it('cancels pending retry when the session stops', () => {
    const { result, rerender } = renderHook(({enabled}) => useSandboxLogs('session-a', enabled, port), {initialProps: {enabled: true}})
    act(() => FakeEventSource.instances[0].onerror?.())
    rerender({enabled: false})
    act(() => vi.advanceTimersByTime(30000))
    expect(FakeEventSource.instances).toHaveLength(1)
    expect(result.current.isReconnecting).toBe(false)
  })
})
