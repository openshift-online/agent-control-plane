'use client'

import { useParams, useSearchParams, useRouter } from 'next/navigation'
import { useCallback, useMemo } from 'react'
import { LayoutDashboard, List, GanttChart } from 'lucide-react'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { EmptyState } from '@/components/empty-state'
import { useSessions } from '@/queries/use-sessions'
import { useAgentNames } from '@/queries/use-agents'
import { getNeedsYouItems, getWorkItemCards, getCompletionItems, AGENT_STATUS } from '@/domain/work-annotations'
import type { DomainSession, SessionPhase } from '@/domain/types'
import { NeedsYouQueue } from './_components/needs-you-queue'
import { ActiveWorkSection } from './_components/active-work-section'
import { RecentActivity } from './_components/recent-activity'
import { TimelineView } from './_components/timeline-view'
import { Sparkline } from './_components/sparkline'

type ViewMode = 'list' | 'timeline'

function isViewMode(value: string | null): value is ViewMode {
  return value === 'list' || value === 'timeline'
}

const SPARKLINE_HOURS = 6

const ACTIVE_PHASES: ReadonlySet<SessionPhase> = new Set([
  'Running',
  'Creating',
  'Pending',
])

function computeHourlyCounts(
  sessions: DomainSession[],
  filter: (s: DomainSession) => boolean,
  timeField: (s: DomainSession) => string | null,
  hours: number,
): number[] {
  const now = Date.now()
  const buckets = new Array<number>(hours).fill(0)

  for (const session of sessions) {
    if (!filter(session)) continue
    const ts = timeField(session)
    if (!ts) continue
    const t = new Date(ts).getTime()
    const hoursAgo = (now - t) / (1000 * 60 * 60)
    if (hoursAgo < 0 || hoursAgo >= hours) continue
    const bucket = Math.floor(hoursAgo)
    // Index 0 = oldest bucket, last = most recent
    buckets[hours - 1 - bucket] += 1
  }

  return buckets
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
      computeHourlyCounts(
        sessions,
        (s) => Boolean(s.annotations[AGENT_STATUS]) || s.phase === 'Failed',
        (s) => s.updatedAt,
        SPARKLINE_HOURS,
      ),
    [sessions],
  )

  const inFlightTrend = useMemo(
    () =>
      computeHourlyCounts(
        sessions,
        (s) => ACTIVE_PHASES.has(s.phase),
        (s) => s.updatedAt,
        SPARKLINE_HOURS,
      ),
    [sessions],
  )

  const completedTrend = useMemo(
    () =>
      computeHourlyCounts(
        sessions,
        (s) => s.phase === 'Completed',
        (s) => s.completionTime,
        SPARKLINE_HOURS,
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

      {/* Summary bar */}
      <div className="flex items-center gap-4 text-sm text-muted-foreground">
        <div className="flex items-center gap-2">
          <span className="font-medium text-foreground">{needsCount}</span>
          <span>need{needsCount === 1 ? 's' : ''} attention</span>
          <Sparkline data={needsAttentionTrend} color="hsl(var(--destructive))" />
        </div>
        <span aria-hidden="true">&middot;</span>
        <div className="flex items-center gap-2">
          <span className="font-medium text-foreground">{inFlightCount}</span>
          <span>in flight</span>
          <Sparkline data={inFlightTrend} color="hsl(var(--primary))" />
        </div>
        <span aria-hidden="true">&middot;</span>
        <div className="flex items-center gap-2">
          <span className="font-medium text-foreground">{completedCount}</span>
          <span>completed today</span>
          <Sparkline data={completedTrend} color="rgb(34 197 94)" />
        </div>
      </div>

      {/* View content */}
      {view === 'list' ? (
        <>
          <NeedsYouQueue items={needsYouItems} projectId={projectId} agentNames={agentNames} />
          <ActiveWorkSection cards={workItemCards} projectId={projectId} />
          <RecentActivity items={recentItems} projectId={projectId} agentNames={agentNames} />
        </>
      ) : (
        <TimelineView sessions={sessions} projectId={projectId} agentNames={agentNames} />
      )}
    </div>
  )
}
