'use client'

import { useParams } from 'next/navigation'
import { Badge } from '@/components/ui/badge'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Skeleton } from '@/components/ui/skeleton'
import { useScheduledSessionRuns } from '@/queries/use-scheduled-sessions'
import type { DomainScheduledSession } from '@/domain/types'

type RunsDialogProps = {
  schedule: DomainScheduledSession | null
  open: boolean
  onOpenChange: (open: boolean) => void
}

function phaseBadgeVariant(phase: string): 'default' | 'secondary' | 'destructive' | 'outline' {
  switch (phase) {
    case 'Running': return 'default'
    case 'Completed': return 'secondary'
    case 'Failed': return 'destructive'
    default: return 'outline'
  }
}

export function RunsDialog({ schedule, open, onOpenChange }: RunsDialogProps) {
  const { projectId } = useParams<{ projectId: string }>()
  const { data, isLoading } = useScheduledSessionRuns(
    projectId,
    schedule?.id ?? '',
  )

  const runs = data?.items ?? []

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Runs: {schedule?.name}</DialogTitle>
          <DialogDescription>
            Sessions triggered by this schedule.
          </DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : runs.length === 0 ? (
          <p className="text-sm text-muted-foreground py-8 text-center">
            No runs yet. Trigger the schedule or wait for the next cron tick.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Phase</TableHead>
                <TableHead>Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {runs.map(session => (
                <TableRow key={session.id}>
                  <TableCell className="font-medium">{session.name}</TableCell>
                  <TableCell>
                    <Badge variant={phaseBadgeVariant(session.phase)}>
                      {session.phase}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {new Date(session.createdAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </DialogContent>
    </Dialog>
  )
}
