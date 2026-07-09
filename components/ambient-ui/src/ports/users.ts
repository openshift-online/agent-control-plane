import type {
  DomainUserSearchResult,
  ListParams,
  PaginatedResult,
} from '@/domain/types'

export type UsersPort = {
  search: (query: string) => Promise<DomainUserSearchResult[]>
  list: (params?: ListParams) => Promise<PaginatedResult<DomainUserSearchResult>>
}
