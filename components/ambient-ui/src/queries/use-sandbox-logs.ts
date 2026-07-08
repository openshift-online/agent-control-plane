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

  useEffect(() => {
    if (!enabled || !sessionId) return

    function connect() {
      const url = adapter.getLogsUrl(sessionId)
      const es = new EventSource(url)
      eventSourceRef.current = es

      es.onopen = () => {
        setIsConnected(true)
        setIsReconnecting(false)
        setError(null)
        reconnectCountRef.current = 0
      }

      const handleEvent = (event: MessageEvent) => {
        try {
          const raw = JSON.parse(event.data) as Record<string, unknown>
          const entry = parseSandboxLogEntry(raw)
          if (!entry) return
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
        es.close()
        setIsConnected(false)

        if (enabled && reconnectCountRef.current < MAX_RECONNECTS) {
          reconnectCountRef.current++
          setIsReconnecting(true)
          reconnectTimeoutRef.current = setTimeout(connect, 3000)
        }
      }
    }

    connect()

    return () => {
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
    }
  }, [sessionId, enabled, adapter])

  return { entries, isConnected, isReconnecting, error, clear }
}
