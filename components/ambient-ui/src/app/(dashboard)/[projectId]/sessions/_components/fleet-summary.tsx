import { cn } from '@/lib/utils'
import type { SessionPhase } from '@/domain/types'
import type { SessionPhaseCounts } from '@/ports/sessions'
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
  serverTotal,
  phaseCounts,
  pageItemCount,
  filteredCount,
  activePhase,
  onPhaseFilter,
}: {
  serverTotal: number
  phaseCounts: SessionPhaseCounts
  pageItemCount: number
  filteredCount?: number
  activePhase?: SessionPhase | null
  onPhaseFilter?: (phase: SessionPhase | null) => void
}) {
  const showFiltered = filteredCount !== undefined && filteredCount !== pageItemCount

  const phases: SessionPhase[] = ['Running', 'Pending', 'Creating', 'Stopping', 'Failed', 'Completed', 'Stopped']

  return (
    <div className="flex items-center gap-4 text-sm rounded-lg border bg-muted/30 px-4 py-2.5">
      <span className="font-medium">
        {showFiltered
          ? `Showing ${filteredCount} of ${serverTotal} sessions`
          : `${serverTotal} sessions`}
      </span>
      <span className="text-muted-foreground">—</span>
      {phases.map(phase => {
        const count = phaseCounts[phase]
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
