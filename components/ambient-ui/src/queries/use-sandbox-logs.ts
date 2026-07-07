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
      }

      es.onmessage = (event) => {
        try {
          const entry = JSON.parse(event.data) as SandboxLogEntry
          setEntries(prev => [...prev, entry])
        } catch {
          // skip unparseable entries
        }
      }

      es.onerror = () => {
        es.close()
        setIsConnected(false)

        if (enabled) {
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
