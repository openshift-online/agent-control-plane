import type { DomainProvider } from '@/domain/types'

export type ProvidersPort = {
  list: (projectId: string) => Promise<DomainProvider[]>
  get: (projectId: string, id: string) => Promise<DomainProvider>
}
