'use client'

import dynamic from 'next/dynamic'
import { useParams, useSearchParams, useRouter } from 'next/navigation'
import { useCallback, useMemo } from 'react'
import { LayoutDashboard, List, GanttChart } from 'lucide-react'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { EmptyState } from '@/components/empty-state'
import { useSessions } from '@/queries/use-sessions'
import { useAgentNames } from '@/queries/use-agents'
import { getNeedsYouItems, getWorkItemCards, getCompletionItems, AGENT_STATUS } from '@/domain/work-annotations'
import type { DomainSession, SessionPhase } from '@/domain/types'
import { NeedsYouQueue } from './_components/needs-you-queue'
import { ActiveWorkSection } from './_components/active-work-section'
import { RecentActivity } from './_components/recent-activity'
import { Sparkline } from './_components/sparkline'

const TimelineView = dynamic(
  () => import('./_components/timeline-view').then((m) => ({ default: m.TimelineView })),
  { ssr: false, loading: () => <Skeleton className="h-[300px] w-full" /> },
)

type ViewMode = 'list' | 'timeline'

function isViewMode(value: string | null): value is ViewMode {
  return value === 'list' || value === 'timeline'
}

const TREND_HOURS = 6
const BUCKET_MINUTES = 15
const BUCKET_COUNT = (TREND_HOURS * 60) / BUCKET_MINUTES // 24

const ACTIVE_PHASES: ReadonlySet<SessionPhase> = new Set([
  'Running',
  'Creating',
  'Pending',
])

function computeQuarterHourlyCounts(
  sessions: DomainSession[],
  filter: (s: DomainSession) => boolean,
  timeField: (s: DomainSession) => string | null,
): number[] {
  const now = Date.now()
  const windowMs = TREND_HOURS * 60 * 60 * 1000
  const bucketMs = BUCKET_MINUTES * 60 * 1000
  const buckets = new Array<number>(BUCKET_COUNT).fill(0)

  for (const session of sessions) {
    if (!filter(session)) continue
    const ts = timeField(session)
    if (!ts) continue
    const t = new Date(ts).getTime()
    const age = now - t
    if (age < 0 || age >= windowMs) continue
    const bucketIndex = Math.floor(age / bucketMs)
    // Index 0 = oldest bucket, last = most recent
    buckets[BUCKET_COUNT - 1 - bucketIndex] += 1
  }

  return buckets
}

type TrendDirection = 'up' | 'down' | 'flat'

type TrendSummary = {
  peak: number
  peakBucketIndex: number
  current: number
  direction: TrendDirection
  previousPeriod: number
}

function computeTrendSummary(data: number[]): TrendSummary {
  const current = data[data.length - 1] ?? 0
  const previousPeriod = data[data.length - 2] ?? 0

  let peak = 0
  let peakBucketIndex = 0
  for (let i = 0; i < data.length; i++) {
    if (data[i] > peak) {
      peak = data[i]
      peakBucketIndex = i
    }
  }

  let direction: TrendDirection = 'flat'
  if (current > previousPeriod) direction = 'up'
  else if (current < previousPeriod) direction = 'down'

  return { peak, peakBucketIndex, current, direction, previousPeriod }
}

function bucketIndexToTimeLabel(index: number): string {
  const bucketsAgo = BUCKET_COUNT - 1 - index
  const minutesAgo = bucketsAgo * BUCKET_MINUTES
  if (minutesAgo === 0) return 'now'
  if (minutesAgo < 60) return `${minutesAgo}m ago`
  const hours = Math.floor(minutesAgo / 60)
  const mins = minutesAgo % 60
  if (mins === 0) return `${hours}h ago`
  return `${hours}h ${mins}m ago`
}

const DIRECTION_ARROW: Record<TrendDirection, string> = {
  up: '↑',
  down: '↓',
  flat: '→',
}

type TrendCardProps = {
  label: string
  data: number[]
  color: string
}

function TrendCard({ label, data, color }: TrendCardProps) {
  const summary = useMemo(() => computeTrendSummary(data), [data])

  const tooltipText = summary.peak > 0
    ? `Peak: ${summary.peak} at ${bucketIndexToTimeLabel(summary.peakBucketIndex)} ${DIRECTION_ARROW[summary.direction]} ${summary.current} now (was ${summary.previousPeriod})`
    : 'No activity in the last 6 hours'

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="rounded-lg border border-border/50 px-3 py-2 transition-colors hover:border-border">
          <div className="mb-1 flex items-center justify-between">
            <span className="text-xs text-muted-foreground">{label}</span>
            <span className="text-xs font-medium tabular-nums" style={{ color }}>
              {summary.current}
            </span>
          </div>
          <Sparkline data={data} color={color} height={28} />
        </div>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        <p>{tooltipText}</p>
      </TooltipContent>
    </Tooltip>
  )
}

export default function DashboardPage() {
  const { projectId } = useParams<{ projectId: string }>()
  const searchParams = useSearchParams()
  const router = useRouter()
  const { data, isLoading, error } = useSessions(projectId)
  const { data: agentNames } = useAgentNames(projectId)

  const rawView = searchParams.get('view')
  const view: ViewMode = isViewMode(rawView) ? rawView : 'list'

  const setView = useCallback(
    (next: string) => {
      const params = new URLSearchParams(searchParams.toString())
      if (next === 'list') {
        params.delete('view')
      } else {
        params.set('view', next)
      }
      const qs = params.toString()
      router.replace(`/${projectId}${qs ? `?${qs}` : ''}`, { scroll: false })
    },
    [projectId, router, searchParams],
  )

  const sessions = data?.items ?? []

  const needsYouItems = useMemo(
    () => getNeedsYouItems(sessions),
    [sessions],
  )

  const workItemCards = useMemo(
    () => getWorkItemCards(sessions),
    [sessions],
  )

  const recentItems = useMemo(
    () => getCompletionItems(sessions),
    [sessions],
  )

  const needsAttentionTrend = useMemo(
    () =>
      computeQuarterHourlyCounts(
        sessions,
        (s) => Boolean(s.annotations[AGENT_STATUS]) || s.phase === 'Failed',
        (s) => s.updatedAt,
      ),
    [sessions],
  )

  const inFlightTrend = useMemo(
    () =>
      computeQuarterHourlyCounts(
        sessions,
        (s) => ACTIVE_PHASES.has(s.phase),
        (s) => s.updatedAt,
      ),
    [sessions],
  )

  const completedTrend = useMemo(
    () =>
      computeQuarterHourlyCounts(
        sessions,
        (s) => s.phase === 'Completed',
        (s) => s.completionTime,
      ),
    [sessions],
  )

  if (error) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
        <p className="text-sm text-destructive">
          Failed to load dashboard data. Please try again later.
        </p>
      </div>
    )
  }

  if (isLoading) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-48 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    )
  }

  if (sessions.length === 0) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
        <EmptyState
          icon={LayoutDashboard}
          title="No sessions yet"
          description="Create a session from the Sessions page to see your dashboard come to life."
        />
      </div>
    )
  }

  const needsCount = needsYouItems.length
  const inFlightCount = workItemCards.length
  const completedCount = recentItems.length

  return (
    <div className="@container space-y-6">
      {/* Heading row with view toggle */}
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
        <Tabs value={view} onValueChange={setView}>
          <TabsList>
            <TabsTrigger value="list">
              <List className="mr-1.5 size-4" />
              List
            </TabsTrigger>
            <TabsTrigger value="timeline">
              <GanttChart className="mr-1.5 size-4" />
              Timeline
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      {/* Summary bar -- current state only, no sparklines */}
      <div className="flex items-center gap-4 text-sm text-muted-foreground">
        <div className="flex items-center gap-1.5">
          <span className="font-medium text-foreground">{needsCount}</span>
          <span>need{needsCount === 1 ? 's' : ''} attention</span>
        </div>
        <span aria-hidden="true">&middot;</span>
        <div className="flex items-center gap-1.5">
          <span className="font-medium text-foreground">{inFlightCount}</span>
          <span>in flight</span>
        </div>
        <span aria-hidden="true">&middot;</span>
        <div className="flex items-center gap-1.5">
          <span className="font-medium text-foreground">{completedCount}</span>
          <span>completed today</span>
        </div>
      </div>

      {/* Trends -- 6-hour sparklines in their own visual group */}
      <TooltipProvider>
        <div className="grid grid-cols-3 gap-3">
          <TrendCard label="Attention" data={needsAttentionTrend} color="hsl(var(--destructive))" />
          <TrendCard label="Active work" data={inFlightTrend} color="hsl(var(--primary))" />
          <TrendCard label="Completions" data={completedTrend} color="rgb(34 197 94)" />
        </div>
      </TooltipProvider>

      {/* View content */}
      {view === 'list' ? (
        <>
          <NeedsYouQueue items={needsYouItems} projectId={projectId} agentNames={agentNames} />
          <ActiveWorkSection cards={workItemCards} projectId={projectId} agentNames={agentNames} />
          <RecentActivity items={recentItems} projectId={projectId} agentNames={agentNames} />
        </>
      ) : (
        <TimelineView sessions={sessions} projectId={projectId} agentNames={agentNames} />
      )}
    </div>
  )
}
