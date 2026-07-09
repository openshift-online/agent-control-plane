'use client'

import { createColumnHelper } from '@tanstack/react-table'
import cronstrue from 'cronstrue'
import { Badge } from '@/components/ui/badge'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import type { DomainScheduledSession } from '@/domain/types'

const col = createColumnHelper<DomainScheduledSession>()

function formatDate(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

function cronDescription(expr: string): string {
  try {
    return cronstrue.toString(expr, { use24HourTimeFormat: false })
  } catch {
    return expr
  }
}

export const schedulesColumns = [
  col.accessor('name', {
    header: 'Name',
    cell: info => <span className="font-medium">{info.getValue()}</span>,
  }),
  col.accessor('schedule', {
    header: 'Schedule',
    cell: info => {
      const expr = info.getValue()
      return (
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="text-sm">{cronDescription(expr)}</span>
            </TooltipTrigger>
            <TooltipContent>
              <code>{expr}</code>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )
    },
  }),
  col.accessor('timezone', {
    header: 'Timezone',
    cell: info => <span className="text-muted-foreground text-sm">{info.getValue()}</span>,
  }),
  col.accessor('enabled', {
    header: 'Status',
    cell: info => (
      <Badge variant={info.getValue() ? 'default' : 'secondary'}>
        {info.getValue() ? 'Enabled' : 'Disabled'}
      </Badge>
    ),
  }),
  col.accessor('nextRunAt', {
    header: 'Next Run',
    cell: info => <span className="text-sm">{formatDate(info.getValue())}</span>,
  }),
  col.accessor('lastRunAt', {
    header: 'Last Run',
    cell: info => <span className="text-sm">{formatDate(info.getValue())}</span>,
  }),
  col.accessor('overlapPolicy', {
    header: 'Overlap',
    cell: info => (
      <Badge variant="outline" className="text-xs">
        {info.getValue()}
      </Badge>
    ),
  }),
]
