import { PolicyAPI } from 'ambient-sdk'
import type { Policy } from 'ambient-sdk'
import type { PoliciesPort } from '@/ports/policies'
import type { DomainPolicy } from '@/domain/types'
import { getConfig } from './sdk-client'

function getProjectScopedAPI(projectId: string): PolicyAPI {
  return new PolicyAPI({ ...getConfig(), project: projectId })
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

function parseSpec(raw: string | Record<string, unknown> | unknown): Record<string, unknown> {
  if (!raw) return {}
  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
    return raw as Record<string, unknown>
  }
  if (typeof raw === 'string') {
    try {
      const parsed: unknown = JSON.parse(raw)
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
      return {}
    } catch {
      return {}
    }
  }
  return {}
}

function mapSdkPolicyToDomain(sdk: Policy): DomainPolicy {
  return {
    id: sdk.id,
    name: sdk.name,
    namespace: sdk.namespace ?? '',
    projectId: sdk.project_id,
    spec: parseSpec(sdk.spec),
    annotations: parseJsonObject(sdk.annotations),
    labels: parseJsonObject(sdk.labels),
    createdAt: sdk.created_at ?? '',
    updatedAt: sdk.updated_at ?? '',
  }
}

export function createPoliciesAdapter(): PoliciesPort {
  return {
    async list(projectId: string): Promise<DomainPolicy[]> {
      const api = getProjectScopedAPI(projectId)
      const result = await api.list({ size: 100 })
      return result.items.map(mapSdkPolicyToDomain)
    },

    async get(projectId: string, id: string): Promise<DomainPolicy> {
      const api = getProjectScopedAPI(projectId)
      const policy = await api.get(id)
      return mapSdkPolicyToDomain(policy)
    },
  }
}
