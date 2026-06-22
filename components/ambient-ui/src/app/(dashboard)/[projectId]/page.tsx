'use client'

import dynamic from 'next/dynamic'
import { useParams, useSearchParams, useRouter } from 'next/navigation'
import { useCallback, useMemo } from 'react'
import { LayoutDashboard, List, GanttChart } from 'lucide-react'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { EmptyState } from '@/components/empty-state'
import { useSessions } from '@/queries/use-sessions'
import { useAgentNames } from '@/queries/use-agents'
import { getNeedsYouItems, getWorkItemCards, getCompletionItems } from '@/domain/work-annotations'
import { NeedsYouQueue } from './_components/needs-you-queue'
import { ActiveWorkSection } from './_components/active-work-section'
import { RecentActivity } from './_components/recent-activity'

const TimelineView = dynamic(
  () => import('./_components/timeline-view').then((m) => ({ default: m.TimelineView })),
  { ssr: false, loading: () => <Skeleton className="h-[300px] w-full" /> },
)

type ViewMode = 'list' | 'timeline'

function isViewMode(value: string | null): value is ViewMode {
  return value === 'list' || value === 'timeline'
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
