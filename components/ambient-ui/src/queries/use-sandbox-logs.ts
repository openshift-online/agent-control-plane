'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import type { SandboxLogEntry } from '@/domain/types'
import type { SandboxObservabilityPort } from '@/ports/sandbox-observability'
import { createSandboxObservabilityAdapterWithFetch } from '@/adapters/sandbox-observability'

let defaultPort: SandboxObservabilityPort | null = null

function getDefaultPort(): SandboxObservabilityPort {
  if (!defaultPort) {
    defaultPort = createSandboxObservabilityAdapterWithFetch()
  }
  return defaultPort
}

type SandboxLogsState = {
  entries: SandboxLogEntry[]
  isConnected: boolean
  isReconnecting: boolean
  error: string | null
  clear: () => void
  retry: () => void
}

const SSE_EVENT_TYPES = ['log', 'platform_event', 'warning', 'status'] as const
const MAX_LOG_ENTRIES = 5000
const MAX_RECONNECTS = 5

function parseSandboxLogEntry(raw: Record<string, unknown>): SandboxLogEntry | null {
  if (typeof raw.timestamp !== 'number' || typeof raw.message !== 'string') return null
  return {
    timestamp: raw.timestamp,
    message: raw.message,
    source: raw.source === 'gateway' || raw.source === 'sandbox' ? raw.source : 'gateway',
    level: typeof raw.level === 'string' ? raw.level : 'INFO',
    module: typeof raw.module === 'string' ? raw.module : '',
    category: typeof raw.category === 'string' ? raw.category : undefined,
    denied: typeof raw.denied === 'boolean' ? raw.denied : undefined,
  }
}

export function useSandboxLogs(
  sessionId: string,
  enabled: boolean,
  port?: SandboxObservabilityPort,
): SandboxLogsState {
  const adapter = port ?? getDefaultPort()
  const [retryKey, setRetryKey] = useState(0)
  const [entries, setEntries] = useState<SandboxLogEntry[]>([])
  const [isConnected, setIsConnected] = useState(false)
  const [isReconnecting, setIsReconnecting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const eventSourceRef = useRef<EventSource | null>(null)
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const reconnectCountRef = useRef(0)

  const clear = useCallback(() => {
    setEntries([])
  }, [])

  const retry = useCallback(() => {
    reconnectCountRef.current = 0
    setError(null)
    setRetryKey(key => key + 1)
  }, [])

  useEffect(() => {
    if (!enabled || !sessionId) return
    let active = true
    reconnectCountRef.current = 0

    function connect() {
      if (!active) return
      const url = adapter.getLogsUrl(sessionId)
      const es = new EventSource(url)
      eventSourceRef.current = es

      es.onopen = () => {
        if (!active) return
        setIsConnected(true)
        setIsReconnecting(false)
        setError(null)
      }

      const handleEvent = (event: MessageEvent) => {
        if (!active) return
        try {
          const raw = JSON.parse(event.data) as Record<string, unknown>
          const entry = parseSandboxLogEntry(raw)
          if (!entry) return
          reconnectCountRef.current = 0
          setEntries(prev => {
            const next = [...prev, entry]
            return next.length > MAX_LOG_ENTRIES ? next.slice(-MAX_LOG_ENTRIES) : next
          })
        } catch {
          // skip unparseable entries
        }
      }

      es.onmessage = handleEvent
      for (const eventType of SSE_EVENT_TYPES) {
        es.addEventListener(eventType, handleEvent as EventListener)
      }

      es.onerror = () => {
        if (!active || es.onerror === null) return
        es.onerror = null
        es.close()
        setIsConnected(false)

        if (enabled && reconnectCountRef.current < MAX_RECONNECTS) {
          reconnectCountRef.current++
          setIsReconnecting(true)
          reconnectTimeoutRef.current = setTimeout(connect, 3000)
        } else {
          setIsReconnecting(false)
          setError('Sandbox logs could not connect after five retries.')
        }
      }
    }

    connect()

    return () => {
      active = false
      if (eventSourceRef.current) {
        eventSourceRef.current.close()
        eventSourceRef.current = null
      }
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current)
        reconnectTimeoutRef.current = null
      }
      setIsConnected(false)
      setIsReconnecting(false)
      setError(null)
    }
  }, [sessionId, enabled, adapter, retryKey])

  return { entries, isConnected, isReconnecting, error, clear, retry }
}
