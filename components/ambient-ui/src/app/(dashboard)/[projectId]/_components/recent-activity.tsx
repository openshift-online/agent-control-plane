import Link from 'next/link'
import { PhaseBadge } from '../sessions/_components/phase-badge'
import { JiraChip, PrChip } from './row-grammar'
import { formatPreciseDuration, formatRelativeTime } from '@/lib/format-timestamp'
import {
  ROW_GRID_TEMPLATE,
  WORK_GITHUB_PR_URL,
  resolveAgentName,
  type CompletionItem,
} from '@/domain/work-annotations'

type RecentActivityProps = {
  items: CompletionItem[]
  projectId: string
  agentNames?: Map<string, string>
}

const RESULT_CONFIG = {
  completed: { label: 'Completed', phase: 'Completed' as const },
  failed: { label: 'Failed', phase: 'Failed' as const },
  stopped: { label: 'Stopped', phase: 'Stopped' as const },
} as const

export function RecentActivity({ items, projectId, agentNames }: RecentActivityProps) {
  if (items.length === 0) {
    return (
      <div>
        <h2 className="mb-3 text-sm font-semibold">Completed today</h2>
        <p className="text-sm text-muted-foreground">
          No completed work today
        </p>
      </div>
    )
  }

  return (
    <div>
      <h2 className="mb-3 text-sm font-semibold">Completed today</h2>
      <div className="rounded-lg border">
        {/* Column headers */}
        <div
          className={`grid ${ROW_GRID_TEMPLATE} items-center border-b px-3 py-2 text-xs font-medium text-muted-foreground`}
        >
          {/* Stripe spacer */}
          <div />
          <div>Result</div>
          <div>Issue</div>
          <div className="hidden @md:block">PR</div>
          <div className="hidden @md:block">Agent</div>
          <div>Duration</div>
          {/* Action (reserved) */}
          <div />
        </div>

        {/* Rows */}
        <ul className="divide-y">
          {items.map((item) => {
            const { session, ref, result, prRef } = item
            const config = RESULT_CONFIG[result]
            const prUrl = session.annotations[WORK_GITHUB_PR_URL] ?? null
            const duration = session.startTime
              ? formatPreciseDuration(session.startTime, session.completionTime)
              : null
            const completionTime = session.completionTime ?? session.updatedAt

            return (
              <li
                key={session.id}
                className={`grid ${ROW_GRID_TEMPLATE} items-center px-3 py-2.5 transition-colors hover:bg-accent/50`}
              >
                {/* spacer */}
                <div />

                {/* Result badge */}
                <div>
                  <PhaseBadge phase={config.phase} />
                </div>

                {/* Issue + summary */}
                <div className="flex min-w-0 items-center gap-2">
                  {ref ? (
                    <span className="shrink-0">
                      <JiraChip issueKey={ref.key} url={ref.url} annotations={session.annotations} />
                    </span>
                  ) : null}
                  <Link
                    href={`/${projectId}/sessions/${session.id}`}
                    className="min-w-0 truncate text-sm text-link hover:text-link-hover"
                  >
                    {session.name}
                  </Link>
                </div>

                {/* PR */}
                <div className="hidden @md:block">
                  {prRef ? (
                    <PrChip prRef={prRef} url={prUrl} />
                  ) : (
                    <span className="text-xs text-muted-foreground">&mdash;</span>
                  )}
                </div>

                {/* Agent */}
                <div className="hidden min-w-0 overflow-hidden @md:block">
                  {session.agentId ? (
                    <Link
                      href={`/${projectId}/agents/${session.agentId}`}
                      className="truncate text-xs text-link hover:text-link-hover"
                    >
                      {resolveAgentName(session, agentNames)}
                    </Link>
                  ) : (
                    <span className="truncate text-xs text-muted-foreground">
                      {resolveAgentName(session, agentNames)}
                    </span>
                  )}
                </div>

                {/* Duration / completion time */}
                <div className="text-xs font-mono text-muted-foreground">
                  {duration ?? formatRelativeTime(completionTime)}
                </div>

                {/* Action (reserved) */}
                <div />
              </li>
            )
          })}
        </ul>
      </div>
    </div>
  )
}
