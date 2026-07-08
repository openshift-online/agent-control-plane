import { useState, useMemo } from 'react'
import Link from 'next/link'
import { XCircle, AlertTriangle, Info } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { formatRelativeTime } from '@/lib/format-timestamp'
import {
  getWorkItemRef,
  resolveAgentName,
  WORK_GITHUB_PR,
  WORK_GITHUB_PR_URL,
} from '@/domain/work-annotations'
import type { NeedsYouItem, Criticality } from '@/domain/work-annotations'
import {
  RowGrid,
  RowHeader,
  JiraChip,
  PrChip,
  AgentLink,
} from './row-grammar'

/* ------------------------------------------------------------------ */
/*  Criticality icon mapping                                           */
/* ------------------------------------------------------------------ */

const CRITICALITY_ICON: Record<Criticality, typeof XCircle> = {
  critical: XCircle,
  warning: AlertTriangle,
  info: Info,
}

const CRITICALITY_TEXT_CLASS: Record<Criticality, string> = {
  critical: 'text-destructive',
  warning: 'text-status-warning-foreground',
  info: 'text-primary',
}

/* ------------------------------------------------------------------ */
/*  NeedsYouQueue                                                      */
/* ------------------------------------------------------------------ */

type NeedsYouQueueProps = {
  items: NeedsYouItem[]
  projectId: string
  agentNames?: Map<string, string>
}

export function NeedsYouQueue({ items, projectId, agentNames }: NeedsYouQueueProps) {
  const [dismissedIds, setDismissedIds] = useState<Set<string>>(new Set())

  const visibleItems = useMemo(
    () => items.filter((item) => !dismissedIds.has(item.session.id)),
    [items, dismissedIds],
  )

  const hasCritical = visibleItems.some((item) => item.criticality === 'critical')

  const dismissItem = (sessionId: string) => {
    setDismissedIds((prev) => new Set(prev).add(sessionId))
  }

  const clearAll = () => {
    setDismissedIds(new Set(items.map((item) => item.session.id)))
  }

  return (
    <section
      className={`rounded-lg border bg-card ${hasCritical ? 'border-destructive/50 bg-destructive/5' : ''}`}
    >
      <div className="flex items-center justify-between px-4 py-3">
        <h2 className="text-sm font-semibold">
          Needs attention{' '}
          {visibleItems.length > 0 && (
            <span className={hasCritical ? 'text-destructive font-bold' : 'text-muted-foreground'}>
              ({visibleItems.length})
            </span>
          )}
        </h2>
        {visibleItems.length > 1 && (
          <Button variant="ghost" size="sm" className="h-7 text-xs text-muted-foreground" onClick={clearAll}>
            Dismiss all
          </Button>
        )}
      </div>

      {visibleItems.length === 0 ? (
        <p className="px-4 pb-4 text-sm text-muted-foreground">All clear</p>
      ) : (
        <div>
          <RowHeader metaLabel="Since" />
          <ul className="divide-y">
            {visibleItems.map((item) => (
              <NeedsYouRow
                key={item.session.id}
                item={item}
                projectId={projectId}
                agentNames={agentNames}
                onDismiss={dismissItem}
              />
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}

/* ------------------------------------------------------------------ */
/*  NeedsYouRow                                                        */
/* ------------------------------------------------------------------ */

type NeedsYouRowProps = {
  item: NeedsYouItem
  projectId: string
  agentNames?: Map<string, string>
  onDismiss: (sessionId: string) => void
}

function NeedsYouRow({ item, projectId, agentNames, onDismiss }: NeedsYouRowProps) {
  const { session, statusText, criticality, waitingSince } = item
  const Icon = CRITICALITY_ICON[criticality]
  const ref = getWorkItemRef(session.annotations)
  const prRef = session.annotations[WORK_GITHUB_PR] ?? null
  const prUrl = session.annotations[WORK_GITHUB_PR_URL] ?? null
  const agentName = resolveAgentName(session, agentNames)

  return (
    <li>
      <RowGrid className="hover:bg-accent/50">
        {/* spacer */}
        <div />

        {/* Status cell */}
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="flex min-w-0 items-start gap-1.5">
              <Icon
                className={`mt-0.5 size-4 shrink-0 ${CRITICALITY_TEXT_CLASS[criticality]}`}
              />
              <span className="line-clamp-2 text-sm font-medium leading-snug">{statusText}</span>
            </div>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="max-w-xs">
            {statusText}
          </TooltipContent>
        </Tooltip>

        {/* Issue + summary */}
        <div className="flex min-w-0 items-center gap-2">
          {ref?.type === 'jira' && (
            <JiraChip issueKey={ref.key} url={ref.url} annotations={session.annotations} />
          )}
          {ref?.type === 'github-pr' && !prRef && (
            <PrChip prRef={ref.key} url={ref.url} />
          )}
          <span className="min-w-0 truncate text-sm text-muted-foreground">
            {session.annotations['work.acp.io/jira/summary'] ?? ''}
          </span>
        </div>

        {/* PR */}
        <div className="hidden min-w-0 overflow-hidden @md:block">
          {prRef ? <PrChip prRef={prRef} url={prUrl} /> : null}
        </div>

        {/* Agent */}
        <div className="hidden min-w-0 overflow-hidden @lg:block">
          <AgentLink
            agentName={agentName}
            projectId={projectId}
            agentId={session.agentId}
          />
        </div>

        {/* Meta: wait time */}
        <div className="text-xs text-muted-foreground">
          {formatRelativeTime(waitingSince)}
        </div>

        {/* Action */}
        <div className="flex items-center gap-1.5">
          <Button variant="outline" size="sm" className="h-7 text-xs" asChild>
            <Link href={`/${projectId}/sessions/${session.id}`}>View session</Link>
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs text-muted-foreground"
            onClick={() => onDismiss(session.id)}
          >
            Dismiss
          </Button>
        </div>
      </RowGrid>
    </li>
  )
}
