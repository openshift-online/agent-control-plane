'use client'

import { useState } from 'react'
import { useParams } from 'next/navigation'
import { CalendarClock, Plus } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import {
  useScheduledSessions,
  useDeleteScheduledSession,
  useSuspendScheduledSession,
  useResumeScheduledSession,
  useTriggerScheduledSession,
} from '@/queries/use-scheduled-sessions'
import type { DomainScheduledSession } from '@/domain/types'
import { SchedulesTable } from './_components/schedules-table'
import { CreateScheduleSheet } from './_components/create-schedule-sheet'
import { RunsDialog } from './_components/runs-dialog'
import { useGatewayMode } from '@/lib/use-gateway-mode'
import { useCurrentUserRole } from '@/hooks/use-current-user-role'
import { canManageSchedules } from '@/domain/roles'

export default function SchedulesPage() {
  const { projectId } = useParams<{ projectId: string }>()
  const { data, isLoading, error } = useScheduledSessions(projectId)
  const deleteMutation = useDeleteScheduledSession()
  const suspendMutation = useSuspendScheduledSession()
  const resumeMutation = useResumeScheduledSession()
  const triggerMutation = useTriggerScheduledSession()

  const [search, setSearch] = useState('')
  const [createOpen, setCreateOpen] = useState(false)
  const [editTarget, setEditTarget] = useState<DomainScheduledSession | null>(null)
  const [runsTarget, setRunsTarget] = useState<DomainScheduledSession | null>(null)

  const { enabled: gatewayMode } = useGatewayMode()
  const { roleName } = useCurrentUserRole(projectId)

  const schedules = data?.items ?? []
  const showScheduleControls = !gatewayMode || canManageSchedules(roleName)

  function handleDelete(id: string) {
    deleteMutation.mutate(
      { projectId, id },
      {
        onSuccess: () => toast.success('Schedule deleted'),
        onError: (err) => toast.error(err instanceof Error ? err.message : 'Delete failed'),
      },
    )
  }

  function handleSuspend(id: string) {
    suspendMutation.mutate(
      { projectId, id },
      {
        onSuccess: () => toast.success('Schedule suspended'),
        onError: (err) => toast.error(err instanceof Error ? err.message : 'Suspend failed'),
      },
    )
  }

  function handleResume(id: string) {
    resumeMutation.mutate(
      { projectId, id },
      {
        onSuccess: () => toast.success('Schedule resumed'),
        onError: (err) => toast.error(err instanceof Error ? err.message : 'Resume failed'),
      },
    )
  }

  function handleTrigger(id: string) {
    triggerMutation.mutate(
      { projectId, id },
      {
        onSuccess: (session) => toast.success(`Session "${session.name}" created`),
        onError: (err) => toast.error(err instanceof Error ? err.message : 'Trigger failed'),
      },
    )
  }

  if (error) {
    return (
      <div className="p-6">
        <p className="text-destructive">Failed to load schedules: {error instanceof Error ? error.message : 'Unknown error'}</p>
      </div>
    )
  }

  if (isLoading) {
    return (
      <div className="space-y-4 p-6">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64 w-full" />
      </div>
    )
  }

  if (schedules.length === 0 && !search) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 py-24">
        <CalendarClock className="h-12 w-12 text-muted-foreground" />
        <h2 className="text-lg font-semibold">No schedules</h2>
        <p className="text-sm text-muted-foreground max-w-sm text-center">
          Schedules automatically trigger agent sessions on a recurring cron schedule.
        </p>
        {showScheduleControls && (
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="mr-2 h-4 w-4" />
            New Schedule
          </Button>
        )}
        <CreateScheduleSheet open={createOpen} onOpenChange={setCreateOpen} />
      </div>
    )
  }

  return (
    <div className="space-y-4 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold tracking-tight">Schedules</h1>
        <div className="flex items-center gap-2">
          <Input
            placeholder="Filter by name..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="w-64"
          />
          {showScheduleControls && (
            <Button onClick={() => { setEditTarget(null); setCreateOpen(true) }}>
              <Plus className="mr-2 h-4 w-4" />
              New Schedule
            </Button>
          )}
        </div>
      </div>

      <SchedulesTable
        schedules={schedules}
        searchFilter={search}
        onEdit={showScheduleControls ? (schedule => { setEditTarget(schedule); setCreateOpen(true) }) : () => {}}
        onDelete={showScheduleControls ? handleDelete : () => {}}
        onSuspend={showScheduleControls ? handleSuspend : () => {}}
        onResume={showScheduleControls ? handleResume : () => {}}
        onTrigger={showScheduleControls ? handleTrigger : () => {}}
        onViewRuns={schedule => setRunsTarget(schedule)}
      />

      <CreateScheduleSheet
        open={createOpen}
        onOpenChange={open => { setCreateOpen(open); if (!open) setEditTarget(null) }}
        editTarget={editTarget}
      />

      <RunsDialog
        schedule={runsTarget}
        open={!!runsTarget}
        onOpenChange={open => { if (!open) setRunsTarget(null) }}
      />
    </div>
  )
}
