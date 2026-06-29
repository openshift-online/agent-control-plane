import type { DomainPolicy } from '@/domain/types'

export type PoliciesPort = {
  list: (projectId: string) => Promise<DomainPolicy[]>
  get: (projectId: string, id: string) => Promise<DomainPolicy>
}
