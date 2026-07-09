import { ProviderAPI } from 'ambient-sdk'
import type { Provider } from 'ambient-sdk'
import type { ProvidersPort } from '@/ports/providers'
import type { DomainProvider } from '@/domain/types'
import { getConfig } from './sdk-client'

function getProjectScopedAPI(projectId: string): ProviderAPI {
  return new ProviderAPI({ ...getConfig(), project: projectId })
}

function parseJsonObject(raw: string | Record<string, unknown> | unknown): Record<string, string> {
  if (!raw) return {}
  let obj: unknown = raw
  if (typeof raw === 'string') {
    try {
      obj = JSON.parse(raw)
    } catch {
      return {}
    }
  }
  if (typeof obj === 'object' && obj !== null && !Array.isArray(obj)) {
    const result: Record<string, string> = {}
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      result[key] = String(value)
    }
    return result
  }
  return {}
}

function mapSdkProviderToDomain(sdk: Provider): DomainProvider {
  return {
    id: sdk.id,
    name: sdk.name,
    type: sdk.type ?? '',
    secret: sdk.secret ?? '',
    namespace: sdk.namespace ?? '',
    projectId: sdk.project_id,
    annotations: parseJsonObject(sdk.annotations),
    labels: parseJsonObject(sdk.labels),
    createdAt: sdk.created_at ?? '',
    updatedAt: sdk.updated_at ?? '',
  }
}

export function createProvidersAdapter(): ProvidersPort {
  return {
    async list(projectId: string): Promise<DomainProvider[]> {
      const api = getProjectScopedAPI(projectId)
      const result = await api.list({ size: 100 })
      return result.items.map(mapSdkProviderToDomain)
    },

    async get(projectId: string, id: string): Promise<DomainProvider> {
      const api = getProjectScopedAPI(projectId)
      const provider = await api.get(id)
      return mapSdkProviderToDomain(provider)
    },
  }
}
