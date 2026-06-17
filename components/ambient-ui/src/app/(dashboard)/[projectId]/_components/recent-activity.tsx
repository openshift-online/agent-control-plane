import Link from 'next/link'
import { ExternalLink, Ticket, GitPullRequest } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { PhaseBadge } from '../sessions/_components/phase-badge'
import { formatPreciseDuration, formatRelativeTime } from '@/lib/format-timestamp'
import {
  ROW_GRID_TEMPLATE,
  WORK_GITHUB_PR_URL,
  type CompletionItem,
} from '@/domain/work-annotations'

type RecentActivityProps = {
  items: CompletionItem[]
  projectId: string
}

const RESULT_CONFIG = {
  completed: { label: 'Completed', phase: 'Completed' as const },
  failed: { label: 'Failed', phase: 'Failed' as const },
  stopped: { label: 'Stopped', phase: 'Stopped' as const },
} as const

const STATUS_STRIPE_COLOR: Record<CompletionItem['result'], string> = {
  completed: 'bg-green-500',
  failed: 'bg-red-500',
  stopped: 'bg-muted-foreground',
}

function JiraChip({ issueKey, url }: { issueKey: string; url: string | null }) {
  const content = (
    <>
      <Ticket className="size-3 shrink-0" />
      <span className="font-mono text-xs">{issueKey}</span>
    </>
  )

  if (url) {
    return (
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1 rounded-sm border px-1.5 py-0.5 text-link hover:text-link-hover hover:bg-accent transition-colors"
      >
        {content}
      </a>
    )
  }

  return (
    <span className="inline-flex items-center gap-1 rounded-sm border px-1.5 py-0.5 text-muted-foreground">
      {content}
    </span>
  )
}

function PrChip({ prRef, url }: { prRef: string; url: string | null }) {
  const shortRef = prRef.includes('#') ? `#${prRef.split('#').pop()}` : prRef

  const content = (
    <>
      <GitPullRequest className="size-3 shrink-0" />
      <span className="font-mono text-xs">{shortRef}</span>
    </>
  )

  if (url) {
    return (
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1 rounded-sm border px-1.5 py-0.5 text-link hover:text-link-hover hover:bg-accent transition-colors"
      >
        {content}
      </a>
    )
  }

  return (
    <span className="inline-flex items-center gap-1 rounded-sm border px-1.5 py-0.5 text-muted-foreground">
      {content}
    </span>
  )
}

export function RecentActivity({ items, projectId }: RecentActivityProps) {
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
          <div className="hidden @md:block" />
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
                {/* Status stripe */}
                <div
                  className={`h-full w-1 rounded-full ${STATUS_STRIPE_COLOR[result]}`}
                />

                {/* Result badge */}
                <div>
                  <PhaseBadge phase={config.phase} />
                </div>

                {/* Issue + summary */}
                <div className="flex min-w-0 items-center gap-2">
                  {ref ? (
                    <span className="shrink-0">
                      <JiraChip issueKey={ref.key} url={ref.url} />
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
                <div className="hidden @md:block">
                  {session.agentName ? (
                    <Link
                      href={`/${projectId}/sessions?agent=${encodeURIComponent(session.agentName)}`}
                      className="truncate text-xs text-link hover:text-link-hover"
                    >
                      {session.agentName}
                    </Link>
                  ) : (
                    <span className="text-xs text-muted-foreground">&mdash;</span>
                  )}
                </div>

                {/* Duration / completion time */}
                <div className="text-xs font-mono text-muted-foreground">
                  {duration ?? formatRelativeTime(completionTime)}
                </div>

                {/* Action (reserved) */}
                <div />

                {/* Links */}
                <div className="hidden @md:flex items-center gap-1">
                  {ref?.url ? (
                    <a
                      href={ref.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="rounded-sm p-1 text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
                      title={`Open ${ref.key} in Jira`}
                    >
                      <Ticket className="size-3.5" />
                    </a>
                  ) : null}
                  {prUrl ? (
                    <a
                      href={prUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="rounded-sm p-1 text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
                      title={`Open ${prRef} on GitHub`}
                    >
                      <ExternalLink className="size-3.5" />
                    </a>
                  ) : null}
                </div>
              </li>
            )
          })}
        </ul>
      </div>
    </div>
  )
}
