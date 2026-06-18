import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { PhaseBadge } from '../sessions/_components/phase-badge'
import { RowGrid, RowHeader, JiraChip, PrChip, AgentLink } from './row-grammar'
import { formatRelativeTime } from '@/lib/format-timestamp'
import { resolveAgentName } from '@/domain/work-annotations'
import type { WorkItemCard } from '@/domain/work-annotations'

type ActiveWorkSectionProps = {
  cards: WorkItemCard[]
  projectId: string
  agentNames?: Map<string, string>
}

/* ---------- Phase mapping for Jira status ---------- */

const JIRA_STATUS_TO_PHASE = {
  'in progress': 'Running',
  'in review': 'Running',
  'to do': 'Pending',
  'blocked': 'Failed',
  'done': 'Completed',
} as const

function jiraStatusToPhase(status: string | null): 'Running' | 'Pending' | 'Failed' | 'Completed' {
  if (!status) return 'Running'
  return JIRA_STATUS_TO_PHASE[status.toLowerCase() as keyof typeof JIRA_STATUS_TO_PHASE] ?? 'Running'
}

/* ---------- Row ---------- */

type ActiveWorkRowProps = {
  card: WorkItemCard
  projectId: string
  agentNames?: Map<string, string>
}

function ActiveWorkRow({ card, projectId, agentNames }: ActiveWorkRowProps) {
  const phase = jiraStatusToPhase(card.jiraStatus)
  const firstSession = card.sessions[0]
  const agentDisplay = card.sessions
    .map((s) => resolveAgentName(s, agentNames))
    .filter((name, idx, arr) => arr.indexOf(name) === idx)
    .join(', ')

  return (
    <li>
      <RowGrid className="hover:bg-accent/50">
        {/* spacer */}
        <div />

        {/* Phase pill */}
        <div>
          <PhaseBadge phase={phase} />
        </div>

        {/* Issue + summary */}
        <div className="flex min-w-0 items-center gap-2">
          {card.ref.type === 'jira' && (
            <span className="shrink-0">
              <JiraChip
                issueKey={card.ref.key}
                url={card.ref.url}
                annotations={firstSession?.annotations}
              />
            </span>
          )}
          <span className="min-w-0 truncate text-sm text-muted-foreground">
            {card.jiraSummary ?? ''}
          </span>
        </div>

        {/* PR */}
        <div className="hidden min-w-0 overflow-hidden @md:block">
          {card.prRef ? (
            <PrChip prRef={card.prRef} url={card.prUrl} />
          ) : null}
        </div>

        {/* Agent */}
        <div className="hidden min-w-0 overflow-hidden @lg:block">
          {firstSession ? (
            <AgentLink
              agentName={agentDisplay}
              projectId={projectId}
              agentId={card.sessions.length === 1 ? firstSession.agentId : null}
            />
          ) : (
            <span className="truncate text-sm text-muted-foreground">&mdash;</span>
          )}
        </div>

        {/* Meta: last updated */}
        <div className="text-xs text-muted-foreground">
          {formatRelativeTime(card.lastUpdated)}
        </div>

        {/* Action */}
        <div>
          {firstSession && (
            <Button variant="outline" size="sm" className="h-7 text-xs" asChild>
              <Link href={`/${projectId}/sessions/${firstSession.id}`}>
                View session
              </Link>
            </Button>
          )}
        </div>
      </RowGrid>
    </li>
  )
}

/* ---------- Exported section ---------- */

export function ActiveWorkSection({ cards, projectId, agentNames }: ActiveWorkSectionProps) {
  return (
    <section className="rounded-lg border bg-card">
      <h2 className="px-4 py-3 text-sm font-semibold">
        In-flight work{' '}
        {cards.length > 0 && (
          <span className="text-muted-foreground">({cards.length})</span>
        )}
      </h2>

      {cards.length === 0 ? (
        <p className="px-4 pb-4 text-center text-sm text-muted-foreground">
          No active work
        </p>
      ) : (
        <div>
          <RowHeader metaLabel="Updated" />
          <ul className="divide-y">
            {cards.map((card) => (
              <ActiveWorkRow
                key={`${card.ref.type}:${card.ref.key}`}
                card={card}
                projectId={projectId}
                agentNames={agentNames}
              />
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}
