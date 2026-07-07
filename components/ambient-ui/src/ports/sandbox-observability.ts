import type { SandboxPolicyResponse } from '@/domain/types'

export type SandboxObservabilityPort = {
  getPolicy: (sessionId: string) => Promise<SandboxPolicyResponse>
  getLogsUrl: (sessionId: string) => string
}
