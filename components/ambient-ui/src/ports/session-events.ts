import type { DomainSessionEvent, PaginatedResult } from '@/domain/types'

export type SessionEventListParams = {
  afterSeq?: number
  eventType?: string
  limit?: number
}

export type SessionEventsPort = {
  list: (sessionId: string, params?: SessionEventListParams) => Promise<PaginatedResult<DomainSessionEvent>>
}
