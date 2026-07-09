import type { SandboxObservabilityPort } from '@/ports/sandbox-observability'
import type { SandboxPolicyResponse } from '@/domain/types'

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>

function sanitizeSessionId(value: string): string {
  return encodeURIComponent(value)
}

function createSandboxObservabilityAdapter(fetchFn: FetchFn): SandboxObservabilityPort {
  return {
    async getPolicy(sessionId: string): Promise<SandboxPolicyResponse> {
      const url = `/api/ambient/v1/sessions/${sanitizeSessionId(sessionId)}/sandbox/policy`
      const response = await fetchFn(url)
      if (!response.ok) {
        throw new Error(`Failed to fetch sandbox policy: ${response.status}`)
      }
      return response.json() as Promise<SandboxPolicyResponse>
    },

    getLogsUrl(sessionId: string): string {
      return `/api/ambient/v1/sessions/${sanitizeSessionId(sessionId)}/sandbox/logs`
    },
  }
}

export function createSandboxObservabilityAdapterWithFetch(
  fetchFn?: FetchFn,
): SandboxObservabilityPort {
  return createSandboxObservabilityAdapter(fetchFn ?? globalThis.fetch.bind(globalThis))
}
