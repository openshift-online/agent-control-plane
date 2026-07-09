import { cn } from '@/lib/utils'
import type { DomainSession, SessionPhase } from '@/domain/types'
import { getPhaseStyle } from '@/lib/status-colors'
import { PhaseBadge } from './phase-badge'

const VARIANT_RING_CLASS: Record<string, string> = {
  success: 'ring-status-success-border',
  error: 'ring-status-error-border',
  warning: 'ring-status-warning-border',
  info: 'ring-status-info-border',
  default: 'ring-border',
}

export function FleetSummary({
  sessions,
  serverTotal,
  filteredCount,
  activePhase,
  onPhaseFilter,
}: {
  sessions: DomainSession[]
  serverTotal?: number
  filteredCount?: number
  activePhase?: SessionPhase | null
  onPhaseFilter?: (phase: SessionPhase | null) => void
}) {
  const counts = sessions.reduce<Partial<Record<SessionPhase, number>>>((acc, s) => {
    acc[s.phase] = (acc[s.phase] ?? 0) + 1
    return acc
  }, {})

  const displayTotal = serverTotal ?? sessions.length
  const total = sessions.length
  const showFiltered = filteredCount !== undefined && filteredCount !== total

  const phases: SessionPhase[] = ['Running', 'Pending', 'Creating', 'Stopping', 'Failed', 'Completed', 'Stopped']

  return (
    <div className="flex items-center gap-4 text-sm rounded-lg border bg-muted/30 px-4 py-2.5">
      <span className="font-medium">
        {showFiltered
          ? `Showing ${filteredCount} of ${displayTotal} sessions`
          : `${displayTotal} sessions`}
      </span>
      <span className="text-muted-foreground">—</span>
      {phases.map(phase => {
        const count = counts[phase]
        if (!count) return null
        const isActive = activePhase === phase

        if (onPhaseFilter) {
          const ringClass = VARIANT_RING_CLASS[getPhaseStyle(phase).variant] ?? 'ring-border'
          return (
            <button
              key={phase}
              type="button"
              className={cn(
                'flex items-center gap-1.5 rounded-md px-1.5 py-0.5 transition-colors',
                isActive
                  ? `bg-accent ring-1 ${ringClass}`
                  : 'hover:bg-accent/50'
              )}
              onClick={() => onPhaseFilter(isActive ? null : phase)}
              aria-pressed={isActive}
              aria-label={`Filter by ${phase}`}
            >
              <PhaseBadge phase={phase} />
              <span className="text-muted-foreground">{count}</span>
            </button>
          )
        }

        return (
          <div key={phase} className="flex items-center gap-1.5">
            <PhaseBadge phase={phase} />
            <span className="text-muted-foreground">{count}</span>
          </div>
        )
      })}
    </div>
  )
}
