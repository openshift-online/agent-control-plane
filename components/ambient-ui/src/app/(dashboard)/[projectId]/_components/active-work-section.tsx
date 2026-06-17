import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { formatRelativeTime } from '@/lib/format-timestamp'
import type { WorkItemCard } from '@/domain/work-annotations'

type ActiveWorkSectionProps = {
  cards: WorkItemCard[]
  projectId: string
}

/* ---------- Jira status badge ---------- */

const JIRA_STATUS_CLASSES: Record<string, string> = {
  'in progress': 'border-primary bg-primary/10 text-primary',
  'done': 'border-status-success-border bg-status-success text-status-success-foreground',
  'blocked': 'border-status-error-border bg-status-error text-status-error-foreground',
  'to do': 'border-border bg-muted text-muted-foreground',
  'in review': 'border-status-info-border bg-status-info text-status-info-foreground',
}

function JiraStatusBadge({ status }: { status: string }) {
  const cls = JIRA_STATUS_CLASSES[status.toLowerCase()] ?? ''
  return (
    <Badge variant="outline" className={cls}>
      {status}
    </Badge>
  )
}

/* ---------- PR status badge ---------- */

const PR_STATUS_CLASSES: Record<string, string> = {
  open: 'border-status-success-border text-status-success-foreground',
  draft: 'border-border bg-muted text-muted-foreground',
  merged: 'border-status-info-border bg-status-info text-status-info-foreground',
  closed: 'border-destructive bg-destructive/10 text-destructive',
}

const PR_STATUS_LABELS: Record<string, string> = {
  open: 'Open',
  draft: 'Draft',
  merged: 'Merged',
  closed: 'Closed',
}

function PrStatusBadge({ status }: { status: string }) {
  const cls = PR_STATUS_CLASSES[status.toLowerCase()] ?? ''
  const label = PR_STATUS_LABELS[status.toLowerCase()] ?? status
  return (
    <Badge variant="outline" className={cls}>
      {label}
    </Badge>
  )
}

/* ---------- CI checks badge ---------- */

const CI_CLASSES: Record<string, string> = {
  passing: 'border-status-success-border bg-status-success text-status-success-foreground',
  failing: 'border-destructive bg-destructive/10 text-destructive',
  pending: 'border-status-warning-border bg-status-warning text-status-warning-foreground',
}

const CI_LABELS: Record<string, string> = {
  passing: 'CI Passing',
  failing: 'CI Failing',
  pending: 'CI Pending',
}

function CiChecksBadge({ checks }: { checks: string }) {
  const cls = CI_CLASSES[checks.toLowerCase()] ?? ''
  const label = CI_LABELS[checks.toLowerCase()] ?? checks
  return (
    <Badge variant="outline" className={cls}>
      {label}
    </Badge>
  )
}

/* ---------- PR review badge ---------- */

const REVIEW_CLASSES: Record<string, string> = {
  approved: 'border-status-success-border bg-status-success text-status-success-foreground',
  'changes-requested': 'border-destructive bg-destructive/10 text-destructive',
  pending: 'border-status-warning-border bg-status-warning text-status-warning-foreground',
}

const REVIEW_LABELS: Record<string, string> = {
  approved: 'Approved',
  'changes-requested': 'Changes Requested',
  pending: 'Review Pending',
}

function PrReviewBadge({ review }: { review: string }) {
  if (review.toLowerCase() === 'none') return null
  const cls = REVIEW_CLASSES[review.toLowerCase()] ?? ''
  const label = REVIEW_LABELS[review.toLowerCase()] ?? review
  return (
    <Badge variant="outline" className={cls}>
      {label}
    </Badge>
  )
}

/* ---------- Clickable reference helper ---------- */

function ClickableRef({
  label,
  url,
  className,
}: {
  label: string
  url: string | null
  className?: string
}) {
  if (url) {
    return (
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className={className ?? 'truncate font-medium text-link hover:text-link-hover'}
      >
        {label}
      </a>
    )
  }
  return <span className={className ?? 'truncate font-medium'}>{label}</span>
}

/* ---------- Format PR display label ---------- */

function formatPrLabel(prRef: string): string {
  const hashIdx = prRef.indexOf('#')
  if (hashIdx !== -1) {
    return `PR #${prRef.slice(hashIdx + 1)}`
  }
  return prRef
}

/* ---------- Work Item Card (with Jira and/or PR) ---------- */

function InFlightCard({
  card,
  projectId,
}: {
  card: WorkItemCard
  projectId: string
}) {
  const isJiraPrimary = card.ref.type === 'jira'
  const agents = card.sessions
    .map((s) => s.agentName ?? s.name)
    .filter(Boolean)

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex min-w-0 items-center gap-2 text-sm">
          <ClickableRef
            label={isJiraPrimary ? card.ref.key : formatPrLabel(card.ref.key)}
            url={card.ref.url}
          />
          {isJiraPrimary && card.jiraStatus && (
            <span className="ml-auto shrink-0">
              <JiraStatusBadge status={card.jiraStatus} />
            </span>
          )}
          {!isJiraPrimary && card.prStatus && (
            <span className="ml-auto shrink-0">
              <PrStatusBadge status={card.prStatus} />
            </span>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {/* Summary */}
        {card.jiraSummary && (
          <p className="truncate text-xs text-muted-foreground">{card.jiraSummary}</p>
        )}

        {/* PR row — only for Jira-primary cards that also have a PR */}
        {isJiraPrimary && card.prRef && (
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <ClickableRef
              label={formatPrLabel(card.prRef)}
              url={card.prUrl}
              className="shrink-0 text-xs font-medium font-mono text-link hover:text-link-hover"
            />
            {card.prStatus && <PrStatusBadge status={card.prStatus} />}
            {card.prChecks && <CiChecksBadge checks={card.prChecks} />}
            {card.prReview && <PrReviewBadge review={card.prReview} />}
          </div>
        )}

        {/* PR badges row for PR-primary cards */}
        {!isJiraPrimary && (
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            {card.prChecks && <CiChecksBadge checks={card.prChecks} />}
            {card.prReview && <PrReviewBadge review={card.prReview} />}
          </div>
        )}

        {/* Agent row */}
        {agents.length > 0 && (
          <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            <span className="truncate">{agents.join(', ')}</span>
          </div>
        )}

        {/* Footer — relative time */}
        <p className="text-xs text-muted-foreground">
          Updated {formatRelativeTime(card.lastUpdated)}
        </p>
      </CardContent>
    </Card>
  )
}

/* ---------- Exported section ---------- */

export function ActiveWorkSection({ cards, projectId }: ActiveWorkSectionProps) {
  if (cards.length === 0) {
    return (
      <div>
        <h2 className="mb-3 text-sm font-semibold">In-flight work</h2>
        <p className="text-center text-sm text-muted-foreground">
          No active work items
        </p>
      </div>
    )
  }

  return (
    <div>
      <h2 className="mb-3 text-sm font-semibold">In-flight work</h2>
      <div className="grid gap-3 @md:grid-cols-2 @2xl:grid-cols-3">
        {cards.map((card) => (
          <InFlightCard
            key={`${card.ref.type}:${card.ref.key}`}
            card={card}
            projectId={projectId}
          />
        ))}
      </div>
    </div>
  )
}
