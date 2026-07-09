import type { DomainSession, DomainSessionCreateRequest, ListParams, PaginatedResult, SessionPhase } from '@/domain/types'

export type SessionPhaseCounts = Partial<Record<SessionPhase, number>>

export type SessionsPort = {
  list: (projectId: string, params?: ListParams) => Promise<PaginatedResult<DomainSession>>
  listAll: (params?: ListParams) => Promise<PaginatedResult<DomainSession>>
  get: (sessionId: string) => Promise<DomainSession>
  create: (request: DomainSessionCreateRequest) => Promise<DomainSession>
  stop: (sessionId: string) => Promise<void>
  start: (sessionId: string) => Promise<DomainSession>
  delete: (sessionId: string) => Promise<void>
  phaseCounts: (projectId: string) => Promise<SessionPhaseCounts>
}
