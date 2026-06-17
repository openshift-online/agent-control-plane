'use client'

import { useMemo, useState, useCallback } from 'react'
import Link from 'next/link'
import {
  ChevronRight,
  ChevronDown,
  ExternalLink,
  Ticket,
  GitPullRequest,
  X,
} from 'lucide-react'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { PhaseBadge } from '../sessions/_components/phase-badge'
import { cn } from '@/lib/utils'
import { formatPreciseDuration } from '@/lib/format-timestamp'
import { getPhaseStyle } from '@/lib/status-colors'
import {
  getWorkItemRef,
  WORK_JIRA_ISSUE,
  WORK_JIRA_URL,
  WORK_JIRA_SUMMARY,
  WORK_GITHUB_PR,
  WORK_GITHUB_PR_URL,
  LEGACY_JIRA_ISSUE,
} from '@/domain/work-annotations'
import type { DomainSession, SessionPhase } from '@/domain/types'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type TimelineViewProps = {
  sessions: DomainSession[]
  projectId: string
}

type TimeRange = {
  start: Date
  end: Date
}

type BarPosition = {
  left: string
  width: string
}

type TimelineGroupData = {
  key: string
  label: string
  jiraUrl: string | null
  jiraSummary: string | null
  sessions: DomainSession[]
  isGroup: boolean
  latestActivity: number
}

// ---------------------------------------------------------------------------
// Phase color mapping
// ---------------------------------------------------------------------------

const PHASE_BAR_COLORS: Record<SessionPhase, string> = {
  Running: 'bg-green-500',
  Completed: 'bg-blue-500',
  Failed: 'bg-red-500',
  Creating: 'bg-amber-500',
  Pending: 'bg-amber-500',
  Stopping: 'bg-muted-foreground',
  Stopped: 'bg-muted-foreground',
}

const PHASE_BAR_CSS_COLORS: Record<SessionPhase, string> = {
  Running: 'rgb(34 197 94)',
  Completed: 'rgb(59 130 246)',
  Failed: 'rgb(239 68 68)',
  Creating: 'rgb(245 158 11)',
  Pending: 'rgb(245 158 11)',
  Stopping: 'rgb(115 115 115)',
  Stopped: 'rgb(115 115 115)',
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getJiraIssueKey(session: DomainSession): string | null {
  return (
    session.annotations[WORK_JIRA_ISSUE] ??
    session.annotations[LEGACY_JIRA_ISSUE] ??
    null
  )
}

function getSessionStart(session: DomainSession): Date {
  return new Date(session.startTime ?? session.createdAt)
}

function getSessionEnd(session: DomainSession): Date | null {
  if (session.completionTime) return new Date(session.completionTime)
  if (
    session.phase === 'Completed' ||
    session.phase === 'Failed' ||
    session.phase === 'Stopped'
  ) {
    return new Date(session.updatedAt)
  }
  return null
}

function calculateBarPosition(
  session: DomainSession,
  timeRange: TimeRange,
): BarPosition {
  const totalMs = timeRange.end.getTime() - timeRange.start.getTime()
  if (totalMs <= 0) return { left: '0%', width: '100%' }

  const sessionStart = getSessionStart(session)
  const sessionEnd = getSessionEnd(session) ?? timeRange.end

  const leftMs = Math.max(0, sessionStart.getTime() - timeRange.start.getTime())
  const widthMs = Math.max(0, sessionEnd.getTime() - sessionStart.getTime())

  const leftPct = (leftMs / totalMs) * 100
  const widthPct = Math.max(0.3, (widthMs / totalMs) * 100) // min 0.3% ~ 4px at typical widths

  return {
    left: `${leftPct}%`,
    width: `${Math.min(widthPct, 100 - leftPct)}%`,
  }
}

function formatTimeLabel(date: Date): string {
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

function buildTimeRange(sessions: DomainSession[]): TimeRange {
  const now = new Date()

  if (sessions.length === 0) {
    const oneHourAgo = new Date(now.getTime() - 3600000)
    return { start: oneHourAgo, end: now }
  }

  let earliest = now.getTime()
  for (const s of sessions) {
    const start = getSessionStart(s).getTime()
    if (start < earliest) earliest = start
  }

  // Round start down to the hour
  const startDate = new Date(earliest)
  startDate.setMinutes(0, 0, 0)

  return { start: startDate, end: now }
}

function buildHourLabels(timeRange: TimeRange): { label: string; pct: number }[] {
  const labels: { label: string; pct: number }[] = []
  const totalMs = timeRange.end.getTime() - timeRange.start.getTime()
  if (totalMs <= 0) return labels

  const cursor = new Date(timeRange.start)
  cursor.setMinutes(0, 0, 0)
  if (cursor < timeRange.start) {
    cursor.setHours(cursor.getHours() + 1)
  }

  while (cursor.getTime() <= timeRange.end.getTime()) {
    const pct = ((cursor.getTime() - timeRange.start.getTime()) / totalMs) * 100
    labels.push({
      label: cursor.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
      pct,
    })
    cursor.setHours(cursor.getHours() + 1)
  }

  return labels
}

function buildGroups(sessions: DomainSession[]): TimelineGroupData[] {
  const jiraMap = new Map<string, TimelineGroupData>()
  const ungrouped: TimelineGroupData[] = []

  for (const session of sessions) {
    const jiraKey = getJiraIssueKey(session)
    if (jiraKey) {
      const existing = jiraMap.get(jiraKey)
      if (existing) {
        existing.sessions.push(session)
        const activityTime = new Date(session.startTime ?? session.createdAt).getTime()
        if (activityTime > existing.latestActivity) {
          existing.latestActivity = activityTime
        }
        if (!existing.jiraSummary) {
          existing.jiraSummary = session.annotations[WORK_JIRA_SUMMARY] ?? null
        }
        if (!existing.jiraUrl) {
          existing.jiraUrl = session.annotations[WORK_JIRA_URL] ?? null
        }
      } else {
        jiraMap.set(jiraKey, {
          key: jiraKey,
          label: jiraKey,
          jiraUrl: session.annotations[WORK_JIRA_URL] ?? null,
          jiraSummary: session.annotations[WORK_JIRA_SUMMARY] ?? null,
          sessions: [session],
          isGroup: true,
          latestActivity: new Date(session.startTime ?? session.createdAt).getTime(),
        })
      }
    } else {
      ungrouped.push({
        key: `ungrouped-${session.id}`,
        label: session.agentName ?? session.name,
        jiraUrl: null,
        jiraSummary: null,
        sessions: [session],
        isGroup: false,
        latestActivity: new Date(session.startTime ?? session.createdAt).getTime(),
      })
    }
  }

  const allGroups = [...jiraMap.values(), ...ungrouped]
  // Sort by most recent activity descending
  allGroups.sort((a, b) => b.latestActivity - a.latestActivity)

  return allGroups
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function TimelinePopover({
  session,
  projectId,
  jiraKey,
  jiraSummary,
  jiraUrl,
  timeRange,
}: {
  session: DomainSession
  projectId: string
  jiraKey: string | null
  jiraSummary: string | null
  jiraUrl: string | null
  timeRange: TimeRange
}) {
  const sessionStart = getSessionStart(session)
  const sessionEnd = getSessionEnd(session)
  const startLabel = formatTimeLabel(sessionStart)
  const endLabel = sessionEnd ? formatTimeLabel(sessionEnd) : 'now'
  const duration = formatPreciseDuration(
    sessionStart.toISOString(),
    sessionEnd?.toISOString() ?? null,
  )

  const prRef = session.annotations[WORK_GITHUB_PR] ?? null
  const prUrl = session.annotations[WORK_GITHUB_PR_URL] ?? null
  const title = jiraKey && jiraSummary
    ? `${jiraKey} - ${jiraSummary}`
    : jiraKey ?? session.name

  return (
    <div className="w-72 space-y-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-semibold leading-snug">{title}</p>
        </div>
        <div className="shrink-0">
          <PhaseBadge phase={session.phase} />
        </div>
      </div>

      <div>
        <Link
          href={`/${projectId}/sessions/${session.id}`}
          className="text-sm font-semibold text-primary hover:underline"
        >
          {session.agentName ?? session.name}
        </Link>
      </div>

      <div className="font-mono text-xs text-muted-foreground">
        {startLabel} – {endLabel} ({duration})
      </div>

      <div className="flex items-center justify-between gap-2 border-t pt-2">
        <div className="flex items-center gap-3">
          {jiraKey && (
            jiraUrl ? (
              <a
                href={jiraUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-primary"
              >
                <Ticket className="size-3.5" />
                <span>{jiraKey}</span>
              </a>
            ) : (
              <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                <Ticket className="size-3.5" />
                <span>{jiraKey}</span>
              </span>
            )
          )}
          {prRef && (
            prUrl ? (
              <a
                href={prUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-primary"
              >
                <GitPullRequest className="size-3.5" />
                <span>{prRef}</span>
              </a>
            ) : (
              <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                <GitPullRequest className="size-3.5" />
                <span>{prRef}</span>
              </span>
            )
          )}
        </div>
        <Link
          href={`/${projectId}/sessions/${session.id}`}
          className="inline-flex shrink-0 items-center gap-1 text-xs font-semibold text-primary hover:underline"
        >
          View Session
          <ExternalLink className="size-3" />
        </Link>
      </div>
    </div>
  )
}

function TimelineBar({
  session,
  projectId,
  timeRange,
  jiraKey,
  jiraSummary,
  jiraUrl,
}: {
  session: DomainSession
  projectId: string
  timeRange: TimeRange
  jiraKey: string | null
  jiraSummary: string | null
  jiraUrl: string | null
}) {
  const position = useMemo(
    () => calculateBarPosition(session, timeRange),
    [session, timeRange],
  )

  const isRunning = session.phase === 'Running'
  const isFailed = session.phase === 'Failed'
  const barColor = PHASE_BAR_CSS_COLORS[session.phase] ?? PHASE_BAR_CSS_COLORS.Pending

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            'absolute top-1 bottom-1 flex items-center rounded-sm transition-shadow',
            'hover:shadow-md focus-visible:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
            isRunning && 'rounded-r-none',
          )}
          style={{
            left: position.left,
            width: position.width,
            minWidth: '4px',
            backgroundColor: barColor,
          }}
          tabIndex={0}
          aria-label={`${jiraKey ?? session.agentName ?? session.name}: ${session.phase}`}
        >
          {isRunning && (
            <span
              className="absolute right-0 top-0 bottom-0 w-1.5 animate-pulse"
              style={{ backgroundColor: barColor, opacity: 0.5 }}
            />
          )}
          {isFailed && (
            <X className="ml-auto size-3 shrink-0 text-white" />
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent
        className="w-auto p-3"
        side="top"
        sideOffset={8}
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <TimelinePopover
          session={session}
          projectId={projectId}
          jiraKey={jiraKey}
          jiraSummary={jiraSummary}
          jiraUrl={jiraUrl}
          timeRange={timeRange}
        />
      </PopoverContent>
    </Popover>
  )
}

function TimelineLane({
  session,
  projectId,
  timeRange,
  jiraKey,
  jiraSummary,
  jiraUrl,
  label,
  isSub,
}: {
  session: DomainSession
  projectId: string
  timeRange: TimeRange
  jiraKey: string | null
  jiraSummary: string | null
  jiraUrl: string | null
  label: string
  isSub: boolean
}) {
  return (
    <div className="flex border-b border-border last:border-b-0">
      <div
        className={cn(
          'flex w-[130px] shrink-0 items-center overflow-hidden border-r border-border font-mono text-xs',
          isSub
            ? 'min-h-7 pl-7 pr-3 text-muted-foreground'
            : 'min-h-8 px-3 text-foreground',
        )}
        title={label}
      >
        <span className="truncate">{label}</span>
      </div>
      <div className="relative min-h-8 flex-1">
        <TimelineBar
          session={session}
          projectId={projectId}
          timeRange={timeRange}
          jiraKey={jiraKey}
          jiraSummary={jiraSummary}
          jiraUrl={jiraUrl}
        />
      </div>
    </div>
  )
}

function TimelineGroup({
  group,
  projectId,
  timeRange,
}: {
  group: TimelineGroupData
  projectId: string
  timeRange: TimeRange
}) {
  const [expanded, setExpanded] = useState(false)

  const toggle = useCallback(() => setExpanded((prev) => !prev), [])

  // Single-session group without Jira: no collapse, just render the lane
  if (!group.isGroup) {
    const session = group.sessions[0]
    if (!session) return null
    return (
      <TimelineLane
        session={session}
        projectId={projectId}
        timeRange={timeRange}
        jiraKey={null}
        jiraSummary={null}
        jiraUrl={null}
        label={group.label}
        isSub={false}
      />
    )
  }

  const ChevronIcon = expanded ? ChevronDown : ChevronRight

  return (
    <div className="group/timeline-group">
      {/* Group header with collapsed bars */}
      <div className="flex border-b border-border hover:bg-muted/50">
        <button
          type="button"
          onClick={toggle}
          className="flex w-[130px] shrink-0 items-center gap-1 overflow-hidden border-r border-border px-2 font-mono text-xs font-bold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          aria-expanded={expanded}
          aria-label={`${group.label}: ${group.sessions.length} sessions, click to ${expanded ? 'collapse' : 'expand'}`}
        >
          <ChevronIcon className="size-3 shrink-0 text-muted-foreground" />
          <span className="truncate">{group.label}</span>
        </button>
        <div className="relative min-h-8 flex-1">
          {!expanded &&
            group.sessions.map((session) => (
              <TimelineBar
                key={session.id}
                session={session}
                projectId={projectId}
                timeRange={timeRange}
                jiraKey={group.key}
                jiraSummary={group.jiraSummary}
                jiraUrl={group.jiraUrl}
              />
            ))}
        </div>
      </div>

      {/* Expanded sub-lanes */}
      {expanded &&
        group.sessions.map((session) => (
          <TimelineLane
            key={session.id}
            session={session}
            projectId={projectId}
            timeRange={timeRange}
            jiraKey={group.key}
            jiraSummary={group.jiraSummary}
            jiraUrl={group.jiraUrl}
            label={session.agentName ?? session.name}
            isSub
          />
        ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Grid lines + "Now" marker
// ---------------------------------------------------------------------------

function TimelineGridLines({
  timeRange,
  hourLabels,
}: {
  timeRange: TimeRange
  hourLabels: { label: string; pct: number }[]
}) {
  const totalMs = timeRange.end.getTime() - timeRange.start.getTime()
  const nowPct = totalMs > 0 ? 100 : 0

  return (
    <>
      {hourLabels.map((hl) => (
        <div
          key={hl.label}
          className="pointer-events-none absolute top-0 bottom-0 border-l border-dashed border-border"
          style={{ left: `${hl.pct}%` }}
        />
      ))}
      {/* "Now" marker */}
      <div
        className="pointer-events-none absolute top-0 bottom-0 z-[1] border-l-2 border-destructive"
        style={{ left: `${nowPct}%` }}
      />
    </>
  )
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function TimelineView({ sessions, projectId }: TimelineViewProps) {
  const timeRange = useMemo(() => buildTimeRange(sessions), [sessions])
  const hourLabels = useMemo(() => buildHourLabels(timeRange), [timeRange])
  const groups = useMemo(() => buildGroups(sessions), [sessions])

  if (sessions.length === 0) {
    return (
      <div className="flex items-center justify-center rounded-lg border bg-card p-12 text-sm text-muted-foreground">
        No sessions to display on the timeline
      </div>
    )
  }

  return (
    <div
      className="overflow-hidden rounded-lg border bg-card"
      role="region"
      aria-label="Gantt-style timeline of sessions"
    >
      {/* Scrollable content */}
      <div className="max-h-[420px] overflow-y-auto">
        {/* Sticky time-axis header */}
        <div className="sticky top-0 z-10 flex border-b border-border bg-card">
          <div className="w-[130px] shrink-0 border-r border-border" />
          <div className="relative flex min-h-7 flex-1 items-end pb-1">
            {hourLabels.map((hl) => (
              <span
                key={hl.label}
                className="absolute -translate-x-1/2 select-none font-mono text-xs text-muted-foreground"
                style={{ left: `${hl.pct}%` }}
              >
                {hl.label}
              </span>
            ))}
            <span
              className="absolute -translate-x-1/2 select-none font-mono text-xs font-bold text-destructive"
              style={{ left: '100%' }}
            >
              Now
            </span>
          </div>
        </div>

        {/* Swim lanes */}
        {groups.map((group) => (
          <div key={group.key} className="relative">
            {/* Grid lines rendered in each lane's flex-1 area would be complex,
                so we draw them once in an overlay per-group */}
            <TimelineGroup
              group={group}
              projectId={projectId}
              timeRange={timeRange}
            />
          </div>
        ))}
      </div>
    </div>
  )
}
