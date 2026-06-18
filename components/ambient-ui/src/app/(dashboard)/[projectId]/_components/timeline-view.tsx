'use client'

import { useMemo, useState, useCallback, useRef, useEffect } from 'react'
import Link from 'next/link'
import {
  ChevronRight,
  ChevronDown,
  Ticket,
  GitPullRequest,
  X,
  Plus,
  Minus,
  RotateCcw,
  Clock,
  Bot,
  AlertCircle,
  MessageSquare,
} from 'lucide-react'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
  PopoverArrow,
} from '@/components/ui/popover'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Badge } from '@/components/ui/badge'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { PhaseBadge } from '../sessions/_components/phase-badge'
import { cn } from '@/lib/utils'
import { formatPreciseDuration } from '@/lib/format-timestamp'
import { useSessionMessages } from '@/queries/use-session-messages'
import { useChatSidebar } from '@/components/chat-sidebar-context'
import {
  WORK_JIRA_ISSUE,
  WORK_JIRA_URL,
  WORK_JIRA_SUMMARY,
  WORK_GITHUB_PR,
  WORK_GITHUB_PR_URL,
  LEGACY_JIRA_ISSUE,
  AGENT_STATUS,
  AGENT_STATUS_CRITICALITY,
  parseWorkPhases,
  resolveAgentName,
} from '@/domain/work-annotations'
import type { WorkPhase } from '@/domain/work-annotations'
import type { DomainSession, SessionPhase } from '@/domain/types'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type TimelineViewProps = {
  sessions: DomainSession[]
  projectId: string
  agentNames?: Map<string, string>
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
// Work lifecycle phase colors (from prototype)
// ---------------------------------------------------------------------------

const WORK_PHASE_COLORS: Record<WorkPhase, string> = {
  implementing: '#0066cc',
  reviewing: '#5e40be',
  testing: '#37a3a3',
  deploying: '#f5921b',
  complete: '#63993d',
}

const SESSION_STATUS_BORDER: Record<SessionPhase, string> = {
  Running: '#63993d',
  Completed: '#a3a3a3',
  Failed: '#f0561d',
  Creating: '#f5921b',
  Pending: '#f5921b',
  Stopping: '#a3a3a3',
  Stopped: '#a3a3a3',
}

// Fallback colors for sessions without work.acp.io/phases
const SESSION_PHASE_COLORS: Record<SessionPhase, string> = {
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
): BarPosition | null {
  const totalMs = timeRange.end.getTime() - timeRange.start.getTime()
  if (totalMs <= 0) return { left: '0%', width: '100%' }

  const sessionStart = getSessionStart(session)
  const sessionEnd = getSessionEnd(session) ?? timeRange.end

  const visibleStart = Math.max(sessionStart.getTime(), timeRange.start.getTime())
  const visibleEnd = Math.min(sessionEnd.getTime(), timeRange.end.getTime())

  if (visibleEnd <= visibleStart) return null

  const leftMs = visibleStart - timeRange.start.getTime()
  const widthMs = visibleEnd - visibleStart

  const leftPct = (leftMs / totalMs) * 100
  const widthPct = Math.max(0.3, (widthMs / totalMs) * 100)

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

function buildHourLabels(timeRange: TimeRange, zoom = 1): { label: string; pct: number }[] {
  const totalMs = timeRange.end.getTime() - timeRange.start.getTime()
  if (totalMs <= 0) return []

  const totalHours = totalMs / 3_600_000
  const maxLabels = 12

  let intervalMin: number
  if (totalHours <= 0.5) intervalMin = 5
  else if (totalHours <= 2) intervalMin = 15
  else if (totalHours <= 6) intervalMin = 30
  else if (totalHours <= 12) intervalMin = 60
  else if (totalHours <= 24) intervalMin = 120
  else intervalMin = 240

  if (zoom > 1) {
    const visibleHours = totalHours / zoom
    if (visibleHours <= 0.5) intervalMin = Math.min(intervalMin, 5)
    else if (visibleHours <= 2) intervalMin = Math.min(intervalMin, 15)
    else if (visibleHours <= 6) intervalMin = Math.min(intervalMin, 30)
  }

  const intervalMs = intervalMin * 60_000
  const labels: { label: string; pct: number }[] = []
  const cursor = new Date(timeRange.start)
  cursor.setSeconds(0, 0)
  const remainder = cursor.getMinutes() % intervalMin
  if (remainder !== 0) {
    cursor.setMinutes(cursor.getMinutes() + (intervalMin - remainder))
  }

  const minPctGap = 6
  const rightMargin = 8
  while (cursor.getTime() <= timeRange.end.getTime() && labels.length < maxLabels * zoom) {
    const pct = ((cursor.getTime() - timeRange.start.getTime()) / totalMs) * 100
    if (pct > 100 - rightMargin) break
    const prev = labels.length > 0 ? labels[labels.length - 1].pct : -minPctGap
    if (pct - prev >= minPctGap) {
      const raw = cursor.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
      labels.push({
        label: raw.replace(/\s?(AM|PM)/i, '$1'),
        pct,
      })
    }
    cursor.setTime(cursor.getTime() + intervalMs)
  }

  return labels
}

function buildGroups(sessions: DomainSession[], agentNames?: Map<string, string>): TimelineGroupData[] {
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
        label: resolveAgentName(session, agentNames),
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
// Legend
// ---------------------------------------------------------------------------

const LEGEND_WORK_PHASES: { label: string; color: string }[] = [
  { label: 'Implementing', color: WORK_PHASE_COLORS.implementing },
  { label: 'Reviewing', color: WORK_PHASE_COLORS.reviewing },
  { label: 'Testing', color: WORK_PHASE_COLORS.testing },
  { label: 'Deploying', color: WORK_PHASE_COLORS.deploying },
  { label: 'Complete', color: WORK_PHASE_COLORS.complete },
]

function TimelineLegend() {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1">
      {LEGEND_WORK_PHASES.map((p) => (
        <div key={p.label} className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span
            className="inline-block h-3 w-3 shrink-0 rounded-sm"
            style={{ backgroundColor: p.color }}
          />
          <span>{p.label}</span>
        </div>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Live message feed in popover
// ---------------------------------------------------------------------------

const EVENT_BADGE_STYLES: Record<string, { className: string; label: string }> = {
  tool_use: { className: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300', label: 'tool_call' },
  tool_result: { className: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300', label: 'tool_result' },
  assistant: { className: 'bg-violet-100 text-violet-800 dark:bg-violet-900/30 dark:text-violet-300', label: 'text' },
  text: { className: 'bg-violet-100 text-violet-800 dark:bg-violet-900/30 dark:text-violet-300', label: 'text' },
  error: { className: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300', label: 'error' },
  user: { className: 'bg-gray-100 text-gray-800 dark:bg-gray-800/40 dark:text-gray-300', label: 'user' },
  lifecycle: { className: 'bg-gray-100 text-gray-600 dark:bg-gray-800/40 dark:text-gray-400', label: 'lifecycle' },
}

function PopoverMessages({ sessionId, isRunning }: { sessionId: string; isRunning: boolean }) {
  const { data } = useSessionMessages(sessionId)
  const messages = useMemo(() => {
    if (!data?.items) return []
    return data.items
      .filter((m) => m.eventType !== 'system' && m.eventType !== 'user_feedback')
      .slice(-3)
      .reverse()
  }, [data])

  if (messages.length === 0 && !isRunning) return null

  return (
    <div className="mt-2 border-t pt-2">
      <p className="mb-1 text-[0.625rem] font-bold uppercase tracking-wider text-muted-foreground">
        Recent Activity
      </p>
      <div className="flex max-h-[100px] flex-col gap-1 overflow-y-auto">
        {messages.map((msg) => {
          const badge = EVENT_BADGE_STYLES[msg.eventType] ?? EVENT_BADGE_STYLES.text
          const time = new Date(msg.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
          const payload = truncatePayload(msg.payload)
          return (
            <div key={msg.id} className="flex items-baseline gap-2 text-xs leading-snug">
              <span className="shrink-0 font-mono text-muted-foreground">{time}</span>
              <span className={cn('shrink-0 rounded px-1 py-px text-[0.625rem] font-bold', badge.className)}>
                {badge.label}
              </span>
              <span className="min-w-0 truncate">{payload}</span>
            </div>
          )
        })}
        {isRunning && (
          <div className="flex items-center gap-1 py-1">
            <span className="h-1 w-1 animate-pulse rounded-full bg-muted-foreground" />
            <span className="h-1 w-1 animate-pulse rounded-full bg-muted-foreground [animation-delay:200ms]" />
            <span className="h-1 w-1 animate-pulse rounded-full bg-muted-foreground [animation-delay:400ms]" />
          </div>
        )}
      </div>
    </div>
  )
}

function truncatePayload(raw: string): string {
  try {
    const parsed = JSON.parse(raw)
    if (typeof parsed === 'string') return parsed.slice(0, 120)
    if (parsed.text) return String(parsed.text).slice(0, 120)
    if (parsed.content) return String(parsed.content).slice(0, 120)
    if (parsed.name) return String(parsed.name)
    return raw.slice(0, 120)
  } catch {
    return raw.slice(0, 120)
  }
}

// ---------------------------------------------------------------------------
// Chat sidebar button
// ---------------------------------------------------------------------------

function ChatSidebarButton({ sessionId, sessionName }: { sessionId: string; sessionName: string }) {
  const { openSidebar } = useChatSidebar()
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation()
        openSidebar(sessionId, sessionName)
      }}
      className="inline-flex shrink-0 items-center gap-1 rounded bg-primary/10 px-2 py-1 text-xs font-bold text-primary hover:bg-primary/20"
    >
      <MessageSquare className="size-3" />
      Chat Log
    </button>
  )
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
  agentNames,
}: {
  session: DomainSession
  projectId: string
  jiraKey: string | null
  jiraSummary: string | null
  jiraUrl: string | null
  agentNames?: Map<string, string>
}) {
  const sessionStart = getSessionStart(session)
  const sessionEnd = getSessionEnd(session)
  const startLabel = formatTimeLabel(sessionStart)
  const endLabel = sessionEnd ? formatTimeLabel(sessionEnd) : 'now'
  const duration = formatPreciseDuration(
    sessionStart.toISOString(),
    sessionEnd?.toISOString() ?? null,
  )
  const isRunning = session.phase === 'Running'

  const prRefFull = session.annotations[WORK_GITHUB_PR] ?? null
  const prRef = prRefFull && prRefFull.includes('/') ? `#${prRefFull.split('#').pop()}` : prRefFull
  const prUrl = session.annotations[WORK_GITHUB_PR_URL] ?? null
  const displayAgent = resolveAgentName(session, agentNames)

  const workPhases = parseWorkPhases(session.annotations)
  const currentWorkPhase = workPhases.length > 0 ? workPhases[workPhases.length - 1].phase : null
  const topBorderColor = currentWorkPhase
    ? WORK_PHASE_COLORS[currentWorkPhase]
    : SESSION_PHASE_COLORS[session.phase] ?? SESSION_PHASE_COLORS.Pending

  const blockedStatus = session.annotations[AGENT_STATUS] ?? null
  const blockedCriticality = session.annotations[AGENT_STATUS_CRITICALITY] ?? null
  const isBlocked = blockedCriticality === 'critical' && !!blockedStatus

  return (
    <div className="w-80">
      {/* Title row */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-bold leading-snug">
            {jiraSummary ?? session.name}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {currentWorkPhase && (
            <span
              className="inline-block rounded px-2 py-0.5 text-[0.6875rem] font-bold capitalize"
              style={{
                backgroundColor: `${topBorderColor}18`,
                color: topBorderColor,
                borderTop: `3px solid ${topBorderColor}`,
              }}
            >
              {currentWorkPhase}
            </span>
          )}
          <PhaseBadge phase={session.phase} />
        </div>
      </div>

      {/* Blocked/attention banner */}
      {isBlocked && (
        <div className="mt-1.5 flex items-start gap-1.5 rounded bg-destructive/10 px-2 py-1.5 text-xs text-destructive">
          <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
          <span className="font-medium">{blockedStatus}</span>
        </div>
      )}

      {/* Agent */}
      <div className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
        <Bot className="size-3.5 shrink-0" />
        {session.agentId ? (
          <Link
            href={`/${projectId}/agents/${session.agentId}`}
            className="font-medium text-foreground underline-offset-2 hover:underline"
          >
            {displayAgent}
          </Link>
        ) : (
          <span className="font-medium text-foreground">{displayAgent}</span>
        )}
      </div>

      {/* Time */}
      <div className="mt-1 font-mono text-xs text-muted-foreground">
        {startLabel} – {endLabel} · {duration}
      </div>

      {/* Activity feed (only for running sessions) */}
      {isRunning && <PopoverMessages sessionId={session.id} isRunning />}

      {/* Footer */}
      <div className="mt-2 flex items-center justify-between gap-2 border-t pt-2">
        <div className="flex items-center gap-3">
          {jiraKey && (
            jiraUrl ? (
              <a
                href={jiraUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-xs font-semibold text-muted-foreground hover:text-primary"
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
                className="inline-flex items-center gap-1 text-xs font-semibold text-muted-foreground hover:text-primary"
                title={prRefFull ?? undefined}
              >
                <GitPullRequest className="size-3.5" />
                <span>{prRef}</span>
              </a>
            ) : (
              <span className="inline-flex items-center gap-1 text-xs text-muted-foreground" title={prRefFull ?? undefined}>
                <GitPullRequest className="size-3.5" />
                <span>{prRef}</span>
              </span>
            )
          )}
        </div>
        <ChatSidebarButton sessionId={session.id} sessionName={session.name} />
      </div>
    </div>
  )
}

function computeSegments(
  session: DomainSession,
  timeRange: TimeRange,
): { phase: WorkPhase; flex: number }[] | null {
  const entries = parseWorkPhases(session.annotations)
  if (entries.length === 0) return null

  const sessionStart = getSessionStart(session)
  const sessionEnd = getSessionEnd(session) ?? new Date()

  const visibleStart = Math.max(sessionStart.getTime(), timeRange.start.getTime())
  const visibleEnd = Math.min(sessionEnd.getTime(), timeRange.end.getTime())
  if (visibleEnd <= visibleStart) return null

  const segments: { phase: WorkPhase; flex: number }[] = []
  for (let i = 0; i < entries.length; i++) {
    const segStart = i === 0 ? sessionStart.getTime() : new Date(entries[i].start).getTime()
    const segEnd = i + 1 < entries.length ? new Date(entries[i + 1].start).getTime() : sessionEnd.getTime()

    const clampedStart = Math.max(segStart, visibleStart)
    const clampedEnd = Math.min(segEnd, visibleEnd)
    if (clampedEnd <= clampedStart) continue

    segments.push({ phase: entries[i].phase, flex: clampedEnd - clampedStart })
  }

  if (segments.length === 0) return null
  return segments
}

function TimelineBar({
  session,
  projectId,
  timeRange,
  jiraKey,
  jiraSummary,
  jiraUrl,
  agentNames,
}: {
  session: DomainSession
  projectId: string
  timeRange: TimeRange
  jiraKey: string | null
  jiraSummary: string | null
  jiraUrl: string | null
  agentNames?: Map<string, string>
}) {
  const position = useMemo(
    () => calculateBarPosition(session, timeRange),
    [session, timeRange],
  )

  const segments = useMemo(() => computeSegments(session, timeRange), [session, timeRange])

  const [popoverOpen, setPopoverOpen] = useState(false)
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const openPopover = useCallback(() => {
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current)
    hoverTimerRef.current = setTimeout(() => setPopoverOpen(true), 120)
  }, [])
  const closePopover = useCallback(() => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current)
    closeTimerRef.current = setTimeout(() => setPopoverOpen(false), 250)
  }, [])
  const keepOpen = useCallback(() => {
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current)
  }, [])

  const workPhases = parseWorkPhases(session.annotations)
  const currentWorkPhase = workPhases.length > 0 ? workPhases[workPhases.length - 1].phase : null
  const popoverBorderColor = currentWorkPhase
    ? WORK_PHASE_COLORS[currentWorkPhase]
    : SESSION_PHASE_COLORS[session.phase] ?? SESSION_PHASE_COLORS.Pending

  if (!position) return null

  const isRunning = session.phase === 'Running'
  const isFailed = session.phase === 'Failed'
  const isBlocked = session.annotations[AGENT_STATUS_CRITICALITY] === 'critical' &&
    !!session.annotations[AGENT_STATUS]
  const fallbackColor = SESSION_PHASE_COLORS[session.phase] ?? SESSION_PHASE_COLORS.Pending
  const hasSegments = segments !== null && segments.length > 0

  return (
    <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
      <PopoverTrigger asChild>
        <button
          onMouseEnter={openPopover}
          onMouseLeave={closePopover}
          onFocus={() => setPopoverOpen(true)}
          type="button"
          className={cn(
            'absolute top-1 bottom-1 flex overflow-hidden rounded-sm transition-[width,left,shadow] duration-300 ease-out',
            'hover:shadow-md focus-visible:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
            isRunning && 'rounded-r-none',
            isBlocked && 'border border-dashed border-black/25',
          )}
          style={{
            left: position.left,
            width: position.width,
            minWidth: '8px',
            gap: 0,
            backgroundColor: hasSegments ? WORK_PHASE_COLORS[segments[0].phase] : fallbackColor,
            borderBottom: `4px solid ${SESSION_STATUS_BORDER[session.phase] ?? SESSION_STATUS_BORDER.Pending}`,
          }}
          tabIndex={0}
          aria-label={`${jiraKey ?? resolveAgentName(session, agentNames)}: ${session.phase}`}
        >
          {hasSegments ? (
            segments.map((seg, i) => (
                <div
                  key={i}
                  className={cn(isBlocked && 'opacity-70')}
                  style={{
                    flex: seg.flex,
                    height: '100%',
                    backgroundColor: WORK_PHASE_COLORS[seg.phase],
                  }}
                />
              ))
          ) : null}
          {isRunning && (
            <span
              className="absolute right-0 top-0 bottom-0 w-2"
              style={{
                background: `linear-gradient(to right, transparent, ${hasSegments ? WORK_PHASE_COLORS[segments[segments.length - 1]?.phase ?? 'implementing'] : fallbackColor})`,
                animation: 'timeline-pulse 1.2s ease-in-out infinite',
              }}
            />
          )}
          {isFailed && (
            <span className="absolute right-0 top-0 bottom-0 w-[3px]" style={{ backgroundColor: 'rgb(239 68 68)' }} />
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent
        className="w-auto overflow-hidden p-0"
        side="top"
        sideOffset={8}
        collisionPadding={16}
        onMouseEnter={keepOpen}
        onMouseLeave={closePopover}
        onOpenAutoFocus={(e) => e.preventDefault()}
        onCloseAutoFocus={(e) => e.preventDefault()}
        style={{ borderTop: `5px solid ${popoverBorderColor}` }}
      >
        <PopoverArrow className="fill-popover" />
        <div className="p-3">
        <TimelinePopover
          session={session}
          projectId={projectId}
          jiraKey={jiraKey}
          jiraSummary={jiraSummary}
          jiraUrl={jiraUrl}
          agentNames={agentNames}
        />
        </div>
      </PopoverContent>
    </Popover>
  )
}

// Old TimelineLane, TimelineGroup, TimelineGridLines removed — replaced by
// TimelineGroupRow and TimelineGroupCollapsible below the main component

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Time window presets
// ---------------------------------------------------------------------------

const TIME_WINDOW_OPTIONS = [
  { value: 'auto', label: 'Auto' },
  { value: '5m', label: 'Last 5m', ms: 5 * 60_000 },
  { value: '15m', label: 'Last 15m', ms: 15 * 60_000 },
  { value: '30m', label: 'Last 30m', ms: 30 * 60_000 },
  { value: '1h', label: 'Last 1h', ms: 60 * 60_000 },
  { value: '6h', label: 'Last 6h', ms: 6 * 60 * 60_000 },
  { value: '12h', label: 'Last 12h', ms: 12 * 60 * 60_000 },
  { value: '24h', label: 'Last 24h', ms: 24 * 60 * 60_000 },
] as const

type TimeWindowValue = (typeof TIME_WINDOW_OPTIONS)[number]['value']

function getTimeWindowMs(value: TimeWindowValue): number | null {
  const opt = TIME_WINDOW_OPTIONS.find((o) => o.value === value)
  return opt && 'ms' in opt ? opt.ms : null
}

function TimeWindowSelect({
  value,
  onChange,
}: {
  value: TimeWindowValue
  onChange: (v: TimeWindowValue) => void
}) {
  return (
    <Select value={value} onValueChange={(v) => onChange(v as TimeWindowValue)}>
      <SelectTrigger size="sm" className="!h-7 w-[110px] gap-1 text-xs">
        <Clock className="size-3 shrink-0 text-muted-foreground" />
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {TIME_WINDOW_OPTIONS.map((opt) => (
          <SelectItem key={opt.value} value={opt.value} className="text-xs">
            {opt.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

// ---------------------------------------------------------------------------
// Zoom controls
// ---------------------------------------------------------------------------

const MIN_ZOOM = 1
const MAX_ZOOM = 20
const ZOOM_STEP = 1.15

function ZoomControls({
  zoom,
  onZoomIn,
  onZoomOut,
  onReset,
}: {
  zoom: number
  onZoomIn: () => void
  onZoomOut: () => void
  onReset: () => void
}) {
  return (
    <div className="flex items-center gap-1">
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={onZoomOut}
            disabled={zoom <= MIN_ZOOM}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md border text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-30"
            aria-label="Zoom out"
          >
            <Minus className="size-3.5" />
          </button>
        </TooltipTrigger>
        <TooltipContent>Zoom out</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={onReset}
            disabled={zoom === 1}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md border text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-30"
            aria-label="Reset zoom"
          >
            <RotateCcw className="size-3.5" />
          </button>
        </TooltipTrigger>
        <TooltipContent>Reset zoom</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={onZoomIn}
            disabled={zoom >= MAX_ZOOM}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md border text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-30"
            aria-label="Zoom in"
          >
            <Plus className="size-3.5" />
          </button>
        </TooltipTrigger>
        <TooltipContent>Zoom in</TooltipContent>
      </Tooltip>
      <span className={cn('ml-1 font-mono text-xs text-muted-foreground', zoom <= 1 && 'invisible')}>{Math.round(zoom * 100)}%</span>
    </div>
  )
}

export function TimelineView({ sessions, projectId, agentNames }: TimelineViewProps) {
  const [zoom, setZoom] = useState(1)
  const [timeWindow, setTimeWindow] = useState<TimeWindowValue>('auto')
  const scrollRef = useRef<HTMLDivElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  const timeRange = useMemo(() => {
    const windowMs = getTimeWindowMs(timeWindow)
    if (windowMs) {
      const now = new Date()
      return { start: new Date(now.getTime() - windowMs), end: now }
    }
    return buildTimeRange(sessions)
  }, [sessions, timeWindow])
  const hourLabels = useMemo(() => buildHourLabels(timeRange, zoom), [timeRange, zoom])
  const groups = useMemo(() => buildGroups(sessions, agentNames), [sessions, agentNames])

  const applyZoom = useCallback(
    (newZoom: number, cursorXInContainer?: number) => {
      const clamped = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, newZoom))
      const el = scrollRef.current
      if (el && cursorXInContainer !== undefined) {
        const scrollBefore = el.scrollLeft
        const viewWidth = el.clientWidth
        const cursorFrac = (scrollBefore + cursorXInContainer) / (viewWidth * zoom)
        setZoom(clamped)
        requestAnimationFrame(() => {
          el.scrollLeft = Math.max(0, cursorFrac * viewWidth * clamped - cursorXInContainer)
        })
      } else {
        setZoom(clamped)
      }
    },
    [zoom],
  )

  const handleZoomIn = useCallback(() => applyZoom(zoom * ZOOM_STEP), [zoom, applyZoom])
  const handleZoomOut = useCallback(() => applyZoom(zoom / ZOOM_STEP), [zoom, applyZoom])
  const handleReset = useCallback(() => {
    setZoom(1)
    if (scrollRef.current) scrollRef.current.scrollLeft = 0
  }, [])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return
      e.preventDefault()
      e.stopPropagation()
      const rect = el.getBoundingClientRect()
      const cursorX = e.clientX - rect.left
      const direction = e.deltaY < 0 ? 1 : -1
      const next = zoom * (direction > 0 ? ZOOM_STEP : 1 / ZOOM_STEP)
      applyZoom(next, cursorX)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [zoom, applyZoom])

  if (sessions.length === 0) {
    return (
      <div className="flex items-center justify-center rounded-lg border bg-card p-12 text-sm text-muted-foreground">
        No sessions to display on the timeline
      </div>
    )
  }

  const LABEL_W = 130

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <TimelineLegend />
        <div className="flex items-center gap-2">
          <TimeWindowSelect value={timeWindow} onChange={setTimeWindow} />
          <ZoomControls zoom={zoom} onZoomIn={handleZoomIn} onZoomOut={handleZoomOut} onReset={handleReset} />
        </div>
      </div>
      <div
        ref={containerRef}
        className="overflow-hidden rounded-lg border bg-card"
        role="region"
        aria-label="Gantt-style timeline of sessions"
      >
        {/*
          Single scroll container: scrolls both X (zoom) and Y (many lanes).
          Labels use position:sticky left:0 so they pin while lanes scroll.
        */}
        <div
          ref={scrollRef}
          className="max-h-[420px] overflow-auto"
        >
          <div style={{ width: zoom > 1 ? `calc(${LABEL_W}px + ${(zoom * 100)}%)` : '100%', minWidth: '100%' }}>

            {/* Sticky time-axis header */}
            <div className="sticky top-0 z-10 flex border-b border-border bg-card">
              <div className="sticky left-0 z-[2] w-[130px] shrink-0 border-r border-border bg-card" />
              <div className="relative min-h-7 flex-1">
                {hourLabels.map((hl) => (
                  <span
                    key={hl.label}
                    className="absolute -translate-x-1/2 select-none font-mono text-xs text-muted-foreground"
                    style={{ left: `${hl.pct}%`, bottom: '4px' }}
                  >
                    {hl.label}
                  </span>
                ))}
                <span
                  className="absolute right-1 select-none font-mono text-xs font-bold text-destructive"
                  style={{ bottom: '4px' }}
                >
                  Now
                </span>
              </div>
            </div>

            {/* Swim lanes */}
            {groups.map((group) => (
              <StickyLabelGroup
                key={group.key}
                group={group}
                projectId={projectId}
                timeRange={timeRange}
                agentNames={agentNames}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Sticky-label lane components (labels pin left, bars scroll with zoom)
// ---------------------------------------------------------------------------

function StickyLabelLane({
  label,
  isSub,
  children,
}: {
  label: string
  isSub: boolean
  children: React.ReactNode
}) {
  return (
    <div className="flex border-b border-border last:border-b-0">
      <div
        className={cn(
          'sticky left-0 z-[1] flex w-[130px] shrink-0 items-center overflow-hidden border-r border-border bg-card font-mono text-xs',
          isSub ? 'pl-7 pr-3 text-muted-foreground' : 'px-3 text-foreground',
        )}
        style={{ minHeight: isSub ? 28 : 32 }}
        title={label}
      >
        <span className="truncate">{label}</span>
      </div>
      <div className="relative flex-1" style={{ minHeight: isSub ? 28 : 32 }}>
        {children}
      </div>
    </div>
  )
}

function StickyLabelGroup({
  group,
  projectId,
  timeRange,
  agentNames,
}: {
  group: TimelineGroupData
  projectId: string
  timeRange: TimeRange
  agentNames?: Map<string, string>
}) {
  const [expanded, setExpanded] = useState(false)
  const toggle = useCallback(() => setExpanded((prev) => !prev), [])

  if (!group.isGroup) {
    const session = group.sessions[0]
    if (!session) return null
    return (
      <StickyLabelLane label={group.label} isSub={false}>
        <TimelineBar session={session} projectId={projectId} timeRange={timeRange} jiraKey={null} jiraSummary={null} jiraUrl={null} agentNames={agentNames} />
      </StickyLabelLane>
    )
  }

  const ChevronIcon = expanded ? ChevronDown : ChevronRight

  return (
    <div>
      {/* Group header row */}
      <div className="flex border-b border-border hover:bg-muted/50">
        <button
          type="button"
          onClick={toggle}
          className="sticky left-0 z-[1] flex w-[130px] shrink-0 items-center gap-1 overflow-hidden border-r border-border bg-card px-2 font-mono text-xs font-bold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          style={{ minHeight: 32 }}
          aria-expanded={expanded}
          aria-label={`${group.label}: ${group.sessions.length} sessions`}
        >
          <ChevronIcon className="size-3 shrink-0 text-muted-foreground" />
          <span className="truncate">{group.label}</span>
        </button>
        <div className="relative flex-1" style={{ minHeight: 32 }}>
          {!expanded && group.sessions.map((session) => (
            <TimelineBar key={session.id} session={session} projectId={projectId} timeRange={timeRange} jiraKey={group.key} jiraSummary={group.jiraSummary} jiraUrl={group.jiraUrl} agentNames={agentNames} />
          ))}
        </div>
      </div>

      {/* Expanded sub-lanes */}
      {expanded && group.sessions.map((session) => (
        <StickyLabelLane key={session.id} label={resolveAgentName(session, agentNames)} isSub>
          <TimelineBar session={session} projectId={projectId} timeRange={timeRange} jiraKey={group.key} jiraSummary={group.jiraSummary} jiraUrl={group.jiraUrl} agentNames={agentNames} />
        </StickyLabelLane>
      ))}
    </div>
  )
}
