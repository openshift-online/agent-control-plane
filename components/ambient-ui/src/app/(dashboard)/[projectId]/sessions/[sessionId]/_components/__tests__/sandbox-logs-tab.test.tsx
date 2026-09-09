import { beforeEach, describe, it, expect, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import type { DomainSession, SandboxLogEntry } from '@/domain/types'
import { SandboxLogsTab } from '../sandbox-logs-tab'

const { retry, streamState } = vi.hoisted(() => ({
  retry: vi.fn(),
  streamState: { entries: [] as SandboxLogEntry[], isConnected: false, isReconnecting: false,
    error: 'Sandbox logs could not connect after five retries.' as string | null },
}))
vi.mock('@/queries/use-sandbox-logs', () => ({
  useSandboxLogs: () => ({ ...streamState, retry, clear: vi.fn() }),
}))
beforeEach(() => {
  retry.mockClear()
  streamState.entries = []
  streamState.isConnected = false
  streamState.isReconnecting = false
  streamState.error = 'Sandbox logs could not connect after five retries.'
})

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


it('removes Retry and shows the stopped explanation after a failed stream stops', () => {
  const { rerender } = render(<SandboxLogsTab session={makeSession()} />)
  expect(screen.getByRole('button', {name: 'Retry'})).toBeInTheDocument()
  rerender(<SandboxLogsTab session={makeSession({phase: 'Stopped'})} />)
  expect(screen.queryByRole('button', {name: 'Retry'})).not.toBeInTheDocument()
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  expect(screen.getByText('Session is not running. Logs stream while the sandbox is active.')).toBeInTheDocument()
})


it('announces connection state in a persistent status region without entry counts', () => {
  streamState.error = null
  streamState.isReconnecting = true
  const { rerender } = render(<SandboxLogsTab session={makeSession()} />)
  const status = screen.getByRole('status')
  expect(status).toHaveTextContent('Reconnecting...')
  streamState.isReconnecting = false
  streamState.isConnected = true
  rerender(<SandboxLogsTab session={makeSession()} />)
  expect(screen.getByRole('status')).toBe(status)
  expect(status).toHaveTextContent('Live')
  expect(status).not.toHaveTextContent('entries')
  expect(screen.getByText('0 entries')).toBeInTheDocument()
})
