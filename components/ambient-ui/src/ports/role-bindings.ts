import type {
  DomainRoleBinding,
  DomainRoleBindingCreateRequest,
  DomainRoleBindingPatchRequest,
  ListParams,
  PaginatedResult,
} from '@/domain/types'

export type RoleBindingsPort = {
  list: (params?: ListParams) => Promise<PaginatedResult<DomainRoleBinding>>
  create: (request: DomainRoleBindingCreateRequest) => Promise<DomainRoleBinding>
  patch: (id: string, request: DomainRoleBindingPatchRequest) => Promise<DomainRoleBinding>
  delete: (id: string) => Promise<void>
}
