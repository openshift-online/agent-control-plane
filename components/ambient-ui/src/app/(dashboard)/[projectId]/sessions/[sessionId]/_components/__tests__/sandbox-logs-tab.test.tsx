import { describe, it, expect, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import type { DomainSession } from '@/domain/types'
import { SandboxLogsTab } from '../sandbox-logs-tab'

const { retry } = vi.hoisted(() => ({ retry: vi.fn() }))
vi.mock('@/queries/use-sandbox-logs', () => ({
  useSandboxLogs: () => ({ entries: [], isConnected: false, isReconnecting: false,
    error: 'Sandbox logs could not connect after five retries.', retry, clear: vi.fn() }),
}))

function makeSession(overrides: Partial<DomainSession> = {}): DomainSession {
  return {
    id: 'sess-001',
    name: 'test-session',
    phase: 'Running',
    agentId: null,
    agentName: null,
    projectId: 'proj-001',
    model: null,
    temperature: null,
    maxTokens: null,
    timeout: null,
    workflowId: null,
    prompt: null,
    sdkRestartCount: 0,
    startTime: null,
    completionTime: null,
    createdAt: '2026-01-15T10:00:00Z',
    updatedAt: '2026-01-15T10:00:00Z',
    annotations: {},
    labels: {},
    environmentVariables: {},
    repos: [],
    reconciledRepos: [],
    conditions: [],
    kubeNamespace: null,
    sandboxLogsSnapshot: null,
    sandboxPolicySnapshot: null,
    stopOnRunFinished: null,
    ...overrides,
  }
}


describe('SandboxLogsTab connection failure', () => {
  it('shows an error and working Retry button when no entries were received', () => {
    render(<SandboxLogsTab session={makeSession()} />)
    expect(screen.getByRole('alert')).toHaveTextContent('five retries')
    expect(screen.queryByText('Waiting for sandbox logs...')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', {name: 'Retry'}))
    expect(retry).toHaveBeenCalledOnce()
  })
})
