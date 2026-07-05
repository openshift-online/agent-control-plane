import type {
  DomainApplication,
  DomainApplicationCreateRequest,
  DomainApplicationUpdateRequest,
  ListParams,
  PaginatedResult,
} from '@/domain/types'

export type ApplicationsPort = {
  list: (params?: ListParams) => Promise<PaginatedResult<DomainApplication>>
  get: (id: string) => Promise<DomainApplication>
  create: (request: DomainApplicationCreateRequest) => Promise<DomainApplication>
  update: (id: string, request: DomainApplicationUpdateRequest) => Promise<DomainApplication>
  delete: (id: string) => Promise<void>
}
