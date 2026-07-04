import type { SessionEventsPort, SessionEventListParams } from '@/ports/session-events'
import type { DomainSessionEvent, PaginatedResult } from '@/domain/types'
import { mapSessionEventToDomain } from './mappers'
import type { SdkSessionEventShape } from './mappers'

type SessionEventListResponse = {
  kind: string
  page: number
  size: number
  total: number
  items: SdkSessionEventShape[]
}

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>

function sanitizeSessionId(value: string): string {
  return encodeURIComponent(value)
}

function createSessionEventsAdapter(fetchFn: FetchFn): SessionEventsPort {
  return {
    async list(
      sessionId: string,
      params?: SessionEventListParams,
    ): Promise<PaginatedResult<DomainSessionEvent>> {
      const parts: string[] = []
      if (params?.afterSeq) parts.push(`after_seq=${params.afterSeq}`)
      if (params?.eventType) parts.push(`event_type=${encodeURIComponent(params.eventType)}`)
      if (params?.limit) parts.push(`limit=${params.limit}`)
      const qs = parts.length > 0 ? `?${parts.join('&')}` : ''

      const url = `/api/ambient/v1/sessions/${sanitizeSessionId(sessionId)}/events/history${qs}`
      const response = await fetchFn(url, { method: 'GET' })
      if (!response.ok) {
        throw new Error(`Failed to list session events: ${response.status}`)
      }

      const data = (await response.json()) as SessionEventListResponse
      if (!data.items || !Array.isArray(data.items)) {
        return { items: [], total: 0, page: 1, size: 0, hasMore: false }
      }
      const items = data.items.map(mapSessionEventToDomain)
      return {
        items,
        total: data.total,
        page: data.page,
        size: data.size,
        hasMore: data.page * data.size < data.total,
      }
    },
  }
}

export function createSessionEventsAdapterWithFetch(fetchFn?: FetchFn): SessionEventsPort {
  return createSessionEventsAdapter(fetchFn ?? globalThis.fetch.bind(globalThis))
}
