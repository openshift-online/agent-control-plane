import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { FleetSummary } from '../fleet-summary'
import type { SessionPhase } from '@/domain/types'
import type { SessionPhaseCounts } from '@/ports/sessions'

describe('FleetSummary', () => {
  it('shows total session count', () => {
    render(<FleetSummary serverTotal={3} phaseCounts={{ Running: 3 }} pageItemCount={3} />)
    expect(screen.getByText('3 sessions')).toBeInTheDocument()
  })

  it('shows phase counts grouped by phase', () => {
    const phaseCounts: SessionPhaseCounts = {
      Running: 2,
      Failed: 1,
      Completed: 1,
    }

    render(<FleetSummary serverTotal={4} phaseCounts={phaseCounts} pageItemCount={4} />)
    expect(screen.getByText('4 sessions')).toBeInTheDocument()
    expect(screen.getByText('Running')).toBeInTheDocument()
    expect(screen.getByText('Failed')).toBeInTheDocument()
    expect(screen.getByText('Completed')).toBeInTheDocument()
    expect(screen.getByText('2')).toBeInTheDocument()
    expect(screen.getAllByText('1')).toHaveLength(2)
  })

  it('does not render phases with zero count', () => {
    render(<FleetSummary serverTotal={1} phaseCounts={{ Running: 1 }} pageItemCount={1} />)
    expect(screen.queryByText('Pending')).not.toBeInTheDocument()
    expect(screen.queryByText('Failed')).not.toBeInTheDocument()
    expect(screen.queryByText('Stopped')).not.toBeInTheDocument()
  })

  it('handles empty phase counts', () => {
    render(<FleetSummary serverTotal={0} phaseCounts={{}} pageItemCount={0} />)
    expect(screen.getByText('0 sessions')).toBeInTheDocument()
  })

  it('shows filtered count when filteredCount differs from page items', () => {
    render(
      <FleetSummary
        serverTotal={100}
        phaseCounts={{ Running: 50, Completed: 50 }}
        pageItemCount={20}
        filteredCount={5}
      />
    )
    expect(screen.getByText('Showing 5 of 100 sessions')).toBeInTheDocument()
  })

  it('shows normal count when filteredCount equals page items', () => {
    render(
      <FleetSummary
        serverTotal={100}
        phaseCounts={{ Running: 100 }}
        pageItemCount={20}
        filteredCount={20}
      />
    )
    expect(screen.getByText('100 sessions')).toBeInTheDocument()
  })

  it('shows server total even when page has fewer items', () => {
    render(
      <FleetSummary
        serverTotal={100}
        phaseCounts={{ Running: 50, Completed: 50 }}
        pageItemCount={20}
      />
    )
    expect(screen.getByText('100 sessions')).toBeInTheDocument()
  })

  it('calls onPhaseFilter when a phase chip is clicked', () => {
    const onPhaseFilter = vi.fn()

    render(
      <FleetSummary
        serverTotal={2}
        phaseCounts={{ Running: 1, Failed: 1 }}
        pageItemCount={2}
        onPhaseFilter={onPhaseFilter}
      />
    )

    const runningButton = screen.getByRole('button', { name: 'Filter by Running' })
    fireEvent.click(runningButton)
    expect(onPhaseFilter).toHaveBeenCalledWith('Running')
  })

  it('clears phase filter when active phase chip is clicked', () => {
    const onPhaseFilter = vi.fn()

    render(
      <FleetSummary
        serverTotal={1}
        phaseCounts={{ Running: 1 }}
        pageItemCount={1}
        activePhase={'Running' as SessionPhase}
        onPhaseFilter={onPhaseFilter}
      />
    )

    const runningButton = screen.getByRole('button', { name: 'Filter by Running' })
    fireEvent.click(runningButton)
    expect(onPhaseFilter).toHaveBeenCalledWith(null)
  })

  it('renders phase chips as buttons when onPhaseFilter is provided', () => {
    render(
      <FleetSummary
        serverTotal={1}
        phaseCounts={{ Running: 1 }}
        pageItemCount={1}
        onPhaseFilter={() => {}}
      />
    )

    expect(screen.getByRole('button', { name: 'Filter by Running' })).toBeInTheDocument()
  })

  it('renders phase chips as non-interactive when onPhaseFilter is not provided', () => {
    render(
      <FleetSummary
        serverTotal={1}
        phaseCounts={{ Running: 1 }}
        pageItemCount={1}
      />
    )
    expect(screen.queryByRole('button', { name: 'Filter by Running' })).not.toBeInTheDocument()
  })
})
