import type {
  DomainScheduledSession,
  DomainScheduledSessionCreateRequest,
  DomainScheduledSessionUpdateRequest,
  DomainSession,
  ListParams,
  PaginatedResult,
} from '@/domain/types'

export type ScheduledSessionsPort = {
  list: (projectId: string, params?: ListParams) => Promise<PaginatedResult<DomainScheduledSession>>
  get: (projectId: string, id: string) => Promise<DomainScheduledSession>
  create: (projectId: string, request: DomainScheduledSessionCreateRequest) => Promise<DomainScheduledSession>
  update: (projectId: string, id: string, request: DomainScheduledSessionUpdateRequest) => Promise<DomainScheduledSession>
  delete: (projectId: string, id: string) => Promise<void>
  suspend: (projectId: string, id: string) => Promise<DomainScheduledSession>
  resume: (projectId: string, id: string) => Promise<DomainScheduledSession>
  trigger: (projectId: string, id: string) => Promise<DomainSession>
  runs: (projectId: string, id: string) => Promise<PaginatedResult<DomainSession>>
}
