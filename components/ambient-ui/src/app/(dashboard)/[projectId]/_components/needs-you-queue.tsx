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
  WORK_GITHUB_PR,
  WORK_GITHUB_PR_URL,
  WORK_JIRA_URL,
} from '@/domain/work-annotations'
import type { NeedsYouItem, Criticality } from '@/domain/work-annotations'
import {
  RowGrid,
  RowHeader,
  StatusStripe,
  JiraChip,
  PrChip,
  AgentLink,
  ExternalLinks,
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
}

export function NeedsYouQueue({ items, projectId }: NeedsYouQueueProps) {
  return (
    <section className="rounded-lg border bg-card">
      <h2 className="px-4 py-3 text-sm font-semibold">
        Needs attention{' '}
        {items.length > 0 && (
          <span className="text-muted-foreground">({items.length})</span>
        )}
      </h2>

      {items.length === 0 ? (
        <p className="px-4 pb-4 text-sm text-muted-foreground">All clear</p>
      ) : (
        <div>
          <RowHeader metaLabel="Waiting" />
          <ul className="divide-y">
            {items.map((item) => (
              <NeedsYouRow
                key={item.session.id}
                item={item}
                projectId={projectId}
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
}

function NeedsYouRow({ item, projectId }: NeedsYouRowProps) {
  const { session, statusText, criticality, waitingSince } = item
  const Icon = CRITICALITY_ICON[criticality]
  const ref = getWorkItemRef(session.annotations)
  const prRef = session.annotations[WORK_GITHUB_PR] ?? null
  const prUrl = session.annotations[WORK_GITHUB_PR_URL] ?? null
  const jiraUrl = session.annotations[WORK_JIRA_URL] ?? null
  const agentName = session.agentName ?? session.name

  return (
    <li>
      <RowGrid className="hover:bg-accent/50">
        {/* Status stripe */}
        <StatusStripe variant={criticality} />

        {/* Status cell */}
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="flex min-w-0 items-center gap-1.5">
              <Icon
                className={`size-4 shrink-0 ${CRITICALITY_TEXT_CLASS[criticality]}`}
              />
              <span className="truncate text-sm font-medium">{statusText}</span>
            </div>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="max-w-xs">
            {statusText}
          </TooltipContent>
        </Tooltip>

        {/* Issue + summary */}
        <div className="flex min-w-0 items-center gap-2">
          {ref?.type === 'jira' && (
            <JiraChip issueKey={ref.key} url={ref.url} />
          )}
          {ref?.type === 'github-pr' && !prRef && (
            <PrChip prRef={ref.key} url={ref.url} />
          )}
          <span className="min-w-0 truncate text-sm text-muted-foreground">
            {session.annotations['work.acp.io/jira/summary'] ?? ''}
          </span>
        </div>

        {/* PR */}
        <div className="hidden md:block">
          {prRef ? <PrChip prRef={prRef} url={prUrl} /> : null}
        </div>

        {/* Agent */}
        <div className="hidden lg:block">
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
        <div>
          <Button variant="outline" size="sm" className="h-7 text-xs" asChild>
            <Link href={`/${projectId}/sessions/${session.id}`}>View</Link>
          </Button>
        </div>

        {/* External links */}
        <ExternalLinks jiraUrl={jiraUrl} prUrl={prUrl} />
      </RowGrid>
    </li>
  )
}
