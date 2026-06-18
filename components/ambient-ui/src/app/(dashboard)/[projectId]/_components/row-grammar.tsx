import Link from 'next/link'
import { ExternalLink, GitPullRequest, Ticket } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { ROW_GRID_TEMPLATE } from '@/domain/work-annotations'
import type { Criticality } from '@/domain/work-annotations'

/* ------------------------------------------------------------------ */
/*  Stripe color mapping                                               */
/* ------------------------------------------------------------------ */

type StripeVariant = Criticality | 'success' | 'neutral'

const STRIPE_CLASSES: Record<StripeVariant, string> = {
  critical: 'border-l-destructive',
  warning: 'border-l-status-warning-border',
  info: 'border-l-primary',
  success: 'border-l-status-success-border',
  neutral: 'border-l-transparent',
}

/* ------------------------------------------------------------------ */
/*  RowGrid                                                            */
/* ------------------------------------------------------------------ */

type RowGridProps = {
  children: React.ReactNode
  className?: string
}

export function RowGrid({ children, className }: RowGridProps) {
  return (
    <div
      className={cn(
        'grid items-center gap-x-3 px-3 py-3',
        ROW_GRID_TEMPLATE,
        className,
      )}
    >
      {children}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  RowHeader — column headers for each section                        */
/* ------------------------------------------------------------------ */

type RowHeaderProps = {
  metaLabel: string
}

export function RowHeader({ metaLabel }: RowHeaderProps) {
  return (
    <RowGrid className="border-b text-xs font-medium text-muted-foreground">
      {/* stripe placeholder */}
      <div />
      <div>Status</div>
      <div>Issue</div>
      <div className="hidden @md:block">PR</div>
      <div className="hidden @lg:block">Agent</div>
      <div>{metaLabel}</div>
      <div />
      <div className="hidden @lg:block" />
    </RowGrid>
  )
}

/* ------------------------------------------------------------------ */
/*  StatusStripe                                                       */
/* ------------------------------------------------------------------ */

type StatusStripeProps = {
  variant: StripeVariant
}

export function StatusStripe({ variant }: StatusStripeProps) {
  return (
    <div
      className={cn(
        'h-full w-1 rounded-full border-l-4',
        STRIPE_CLASSES[variant],
      )}
    />
  )
}

/* ------------------------------------------------------------------ */
/*  JiraChip                                                           */
/* ------------------------------------------------------------------ */

type JiraChipProps = {
  issueKey: string
  url?: string | null
}

export function JiraChip({ issueKey, url }: JiraChipProps) {
  const content = (
    <Badge variant="outline" className="gap-1 font-mono text-xs">
      <Ticket className="size-3 shrink-0" />
      {issueKey}
    </Badge>
  )

  if (url) {
    return (
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex hover:opacity-80"
      >
        {content}
      </a>
    )
  }

  return content
}

/* ------------------------------------------------------------------ */
/*  PrChip                                                             */
/* ------------------------------------------------------------------ */

type PrChipProps = {
  prRef: string
  url?: string | null
}

export function PrChip({ prRef, url }: PrChipProps) {
  const short = prRef.includes('/') ? `#${prRef.split('#').pop()}` : prRef
  const content = (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge variant="outline" className="max-w-full gap-1 font-mono text-xs">
          <GitPullRequest className="size-3 shrink-0" />
          <span className="truncate">{short}</span>
        </Badge>
      </TooltipTrigger>
      <TooltipContent>{prRef}</TooltipContent>
    </Tooltip>
  )

  if (url) {
    return (
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex hover:opacity-80"
      >
        {content}
      </a>
    )
  }

  return content
}

/* ------------------------------------------------------------------ */
/*  AgentLink                                                          */
/* ------------------------------------------------------------------ */

type AgentLinkProps = {
  agentName: string
  projectId: string
  agentId?: string | null
}

export function AgentLink({ agentName, projectId, agentId }: AgentLinkProps) {
  if (!agentId) {
    return (
      <span className="truncate text-sm text-muted-foreground">
        {agentName}
      </span>
    )
  }

  return (
    <Link
      href={`/${projectId}/agents/${agentId}`}
      className="truncate text-sm font-medium text-foreground hover:underline"
    >
      {agentName}
    </Link>
  )
}

/* ------------------------------------------------------------------ */
/*  ExternalLinks                                                      */
/* ------------------------------------------------------------------ */

type ExternalLinksProps = {
  jiraUrl?: string | null
  prUrl?: string | null
}

export function ExternalLinks({ jiraUrl, prUrl }: ExternalLinksProps) {
  if (!jiraUrl && !prUrl) {
    return <div />
  }

  return (
    <div className="hidden items-center gap-1 @lg:flex">
      {jiraUrl && (
        <Tooltip>
          <TooltipTrigger asChild>
            <a
              href={jiraUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <ExternalLink className="size-3.5" />
            </a>
          </TooltipTrigger>
          <TooltipContent>Open in Jira</TooltipContent>
        </Tooltip>
      )}
      {prUrl && (
        <Tooltip>
          <TooltipTrigger asChild>
            <a
              href={prUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <GitPullRequest className="size-3.5" />
            </a>
          </TooltipTrigger>
          <TooltipContent>Open PR</TooltipContent>
        </Tooltip>
      )}
    </div>
  )
}
