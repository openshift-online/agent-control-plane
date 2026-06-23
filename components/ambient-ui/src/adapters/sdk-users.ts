import { UserAPI } from 'ambient-sdk'
import type { UsersPort } from '@/ports/users'
import type {
  DomainUserSearchResult,
  ListParams,
  PaginatedResult,
} from '@/domain/types'
import { getConfig } from './sdk-client'

function getAPI(): UserAPI {
  return new UserAPI(getConfig())
}

function sanitizeSearch(value: string): string {
  return value.replace(/['"%;\\]/g, '')
}

function mapSdkUserToDomain(sdk: { id: string; username: string; name: string }): DomainUserSearchResult {
  return {
    id: sdk.id,
    username: sdk.username,
    name: sdk.name,
  }
}

export function createUsersAdapter(): UsersPort {
  return {
    async search(query: string): Promise<DomainUserSearchResult[]> {
      const api = getAPI()
      const sanitized = sanitizeSearch(query)
      if (!sanitized) return []
      const result = await api.list({
        search: `username like '${sanitized}%' or name like '%${sanitized}%'`,
        size: 10,
        fields: 'id,username,name',
      })
      return result.items.map(mapSdkUserToDomain)
    },

    async list(params?: ListParams): Promise<PaginatedResult<DomainUserSearchResult>> {
      const api = getAPI()
      const page = Math.max(1, params?.page ?? 1)
      const size = Math.min(100, Math.max(1, params?.size ?? 100))
      const result = await api.list({
        page,
        size,
        search: params?.search,
      })
      return {
        items: result.items.map(mapSdkUserToDomain),
        total: result.total,
        page,
        size,
        hasMore: page * size < result.total,
      }
    },
  }
}
