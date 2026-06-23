import type { DomainProject, ListParams, PaginatedResult } from '@/domain/types'

export type ProjectCreateInput = {
  name: string
  description?: string
}

export type ProjectPatchInput = {
  name?: string
  description?: string
}

export type ProjectsPort = {
  list: (params?: ListParams) => Promise<PaginatedResult<DomainProject>>
  get: (projectId: string) => Promise<DomainProject>
  create: (input: ProjectCreateInput) => Promise<DomainProject>
  patch: (projectId: string, input: ProjectPatchInput) => Promise<DomainProject>
  delete: (projectId: string) => Promise<void>
}
