import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { RuntimeStatus } from '../runtime-status'
import type { DomainRuntime } from '@/domain/types'

const runtime: DomainRuntime = { backend: 'hypershell', status: 'Running', error: null, gatewayId: 'gateway-a' }

describe('RuntimeStatus', () => {
  it('keeps workspace running in preparation until readiness is confirmed', () => {
    const { rerender } = render(<RuntimeStatus runtime={runtime} label="Workspace sandbox service" resource="workspace" />)
    expect(screen.getByRole('status')).toHaveTextContent('Preparing sandbox service')
    expect(screen.queryByText('Hypershell')).not.toBeInTheDocument()
    rerender(<RuntimeStatus runtime={{...runtime, status: 'Ready'}} label="Workspace sandbox service" resource="workspace" />)
    expect(screen.getByRole('status')).toHaveTextContent('Ready')
    rerender(<RuntimeStatus runtime={runtime} label="Session sandbox" />)
    expect(screen.getByRole('status')).toHaveTextContent('Running')
  })

  it('provides a recovery instruction when failure has no error details', () => {
    render(<RuntimeStatus runtime={{...runtime, status: 'Failed'}} label="Session sandbox" />)
    expect(screen.getByRole('alert')).toHaveTextContent('Contact your workspace administrator for help.')
  })

  it('does not imply progress when status is unknown', () => {
    render(<RuntimeStatus runtime={{...runtime, status: 'unexpected'}} label="Session sandbox" />)
    expect(screen.getByRole('status')).toHaveTextContent('Status unavailable')
  })

  it('renders long errors as text in the alert', () => {
    const error = '<script>' + 'identifier'.repeat(40)
    render(<RuntimeStatus runtime={{...runtime, error}} label="Session sandbox" />)
    expect(screen.getByRole('alert')).toHaveTextContent(error)
    expect(screen.getByText(error)).toHaveClass('min-w-0', 'break-words')
    expect(screen.getByRole('alert')).toHaveClass('text-status-error-foreground')
  })

  it('does not show managed status for another backend', () => {
    render(<RuntimeStatus runtime={{...runtime, backend: 'kubernetes'}} label="Session sandbox" />)
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })
})

it('shows a supported degraded state and recovery action for an unhealthy gateway', () => {
  render(<RuntimeStatus runtime={{...runtime, status: 'Degraded'}} label="Workspace sandbox service" resource="workspace" />)
  expect(screen.getByRole('status')).toHaveTextContent('Service needs attention')
  expect(screen.getByRole('alert')).toHaveTextContent('Contact your workspace administrator for help.')
  expect(screen.queryByText('Status unavailable')).not.toBeInTheDocument()
})
