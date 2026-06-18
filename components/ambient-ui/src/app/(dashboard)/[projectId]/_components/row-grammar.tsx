import Link from 'next/link'
import { GitPullRequest, Ticket } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from '@/components/ui/hover-card'
import { cn } from '@/lib/utils'
import {
  ROW_GRID_TEMPLATE,
  WORK_JIRA_STATUS,
  WORK_JIRA_SUMMARY,
  WORK_GITHUB_PR,
  WORK_GITHUB_PR_URL,
} from '@/domain/work-annotations'
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
    </RowGrid>
  )
}

/* ------------------------------------------------------------------ */
/*  JiraChip                                                           */
/* ------------------------------------------------------------------ */

type JiraChipProps = {
  issueKey: string
  url?: string | null
  annotations?: Record<string, string>
}

const JIRA_STATUS_CLASSES: Record<string, string> = {
  'In Progress': 'border-blue-500/40 bg-blue-500/10 text-blue-700 dark:text-blue-400',
  'Done': 'border-green-500/40 bg-green-500/10 text-green-700 dark:text-green-400',
  'Blocked': 'border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-400',
  'To Do': 'border-muted-foreground/40 bg-muted text-muted-foreground',
  'In Review': 'border-purple-500/40 bg-purple-500/10 text-purple-700 dark:text-purple-400',
}

function JiraDetailCard({ issueKey, annotations }: { issueKey: string; annotations: Record<string, string> }) {
  const summary = annotations[WORK_JIRA_SUMMARY] ?? null
  const status = annotations[WORK_JIRA_STATUS] ?? null
  const prRef = annotations[WORK_GITHUB_PR] ?? null
  const prUrl = annotations[WORK_GITHUB_PR_URL] ?? null

  return (
    <div className="flex max-w-[320px] flex-col gap-2">
      {/* Title: issue key + summary */}
      <div className="flex flex-col gap-0.5">
        <span className="font-mono text-xs text-muted-foreground">{issueKey}</span>
        {summary && (
          <span className="text-sm font-semibold leading-snug">{summary}</span>
        )}
      </div>

      {/* Status badge */}
      {status && (
        <div>
          <Badge
            variant="outline"
            className={cn('text-xs', JIRA_STATUS_CLASSES[status] ?? JIRA_STATUS_CLASSES['To Do'])}
          >
            {status}
          </Badge>
        </div>
      )}

      {/* PR reference */}
      {prRef && (
        <div className="flex items-center gap-1.5">
          {prUrl ? (
            <a
              href={prUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex hover:opacity-80"
            >
              <Badge variant="outline" className="gap-1 font-mono text-xs">
                <GitPullRequest className="size-3 shrink-0" />
                {prRef}
              </Badge>
            </a>
          ) : (
            <Badge variant="outline" className="gap-1 font-mono text-xs">
              <GitPullRequest className="size-3 shrink-0" />
              {prRef}
            </Badge>
          )}
        </div>
      )}
    </div>
  )
}

export function JiraChip({ issueKey, url, annotations }: JiraChipProps) {
  const chip = (
    <Badge variant="outline" className="gap-1 font-mono text-xs">
      <Ticket className="size-3 shrink-0" />
      {issueKey}
    </Badge>
  )

  const linked = url ? (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex hover:opacity-80"
    >
      {chip}
    </a>
  ) : (
    chip
  )

  if (!annotations) {
    return linked
  }

  return (
    <HoverCard>
      <HoverCardTrigger asChild>{linked}</HoverCardTrigger>
      <HoverCardContent className="w-auto max-w-[320px]">
        <JiraDetailCard issueKey={issueKey} annotations={annotations} />
      </HoverCardContent>
    </HoverCard>
  )
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

