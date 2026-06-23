'use client'

import Link from 'next/link'
import {
  Bell,
  XCircle,
  AlertTriangle,
  Info,
  CheckCircle,
  Ticket,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { useAllSessions } from '@/queries/use-sessions'
import { getNeedsYouItems, ACTIONABLE_CRITICALITIES } from '@/domain/work-annotations'
import type { Criticality, NeedsYouItem } from '@/domain/work-annotations'
import { WORK_JIRA_ISSUE } from '@/domain/work-annotations'
import { formatRelativeTime } from '@/lib/format-timestamp'
import { cn } from '@/lib/utils'

type NotificationBellProps = Record<string, never>

const CRITICALITY_ICON: Record<Criticality, typeof XCircle> = {
  critical: XCircle,
  warning: AlertTriangle,
  info: Info,
}

const CRITICALITY_ICON_CLASS: Record<Criticality, string> = {
  critical: 'text-destructive',
  warning: 'text-amber-500',
  info: 'text-blue-500',
}

function TrayItem({ item }: { item: NeedsYouItem }) {
  const Icon = CRITICALITY_ICON[item.criticality]
  const jiraKey = item.session.annotations[WORK_JIRA_ISSUE] ?? null
  const sessionProjectId = item.session.projectId

  return (
    <Link
      href={sessionProjectId ? `/${sessionProjectId}/sessions/${item.session.id}` : '#'}
      className={cn(
        'flex items-start gap-2 rounded-md px-2 py-2 text-sm transition-colors hover:bg-accent',
        item.criticality === 'critical' && 'bg-destructive/5',
      )}
    >
      <Icon
        className={cn(
          'mt-0.5 size-4 shrink-0',
          CRITICALITY_ICON_CLASS[item.criticality],
        )}
      />
      <div className="min-w-0 flex-1">
        <p className="line-clamp-3 font-medium leading-tight">
          {item.statusText}
        </p>
        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          {sessionProjectId && (
            <span className="rounded bg-muted px-1 py-px text-[10px] font-medium">
              {sessionProjectId}
            </span>
          )}
          {jiraKey && (
            <span className="inline-flex items-center gap-0.5 rounded bg-muted px-1 py-px font-mono text-[10px]">
              <Ticket className="size-3" />
              {jiraKey}
            </span>
          )}
          <span className="text-muted-foreground/70">{item.session.agentName ?? item.session.name}</span>
          <span>·</span>
          <span>{formatRelativeTime(item.waitingSince)}</span>
        </div>
      </div>
    </Link>
  )
}

export function NotificationBell(_props: NotificationBellProps) {
  const { data } = useAllSessions()
  const allItems = getNeedsYouItems(data?.items ?? [])
  const items = allItems.filter((item) => ACTIONABLE_CRITICALITIES.has(item.criticality))
  const count = items.length

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="relative h-8 w-8"
          aria-label={
            count > 0
              ? `${count} item${count === 1 ? '' : 's'} need${count === 1 ? 's' : ''} attention`
              : 'No items need attention'
          }
        >
          <Bell className="size-4" />
          {count > 0 && (
            <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-medium leading-none text-destructive-foreground">
              {count > 99 ? '99+' : count}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-0" align="end">
        <div className="border-b px-3 py-2">
          <p className="text-sm font-semibold">Needs You</p>
        </div>
        {items.length === 0 ? (
          <div className="flex flex-col items-center gap-1 py-6 text-muted-foreground">
            <CheckCircle className="size-5" />
            <p className="text-sm">All clear</p>
          </div>
        ) : (
          <div className="max-h-80 overflow-y-auto p-1">
            {items.map((item) => (
              <TrayItem
                key={item.session.id}
                item={item}
              />
            ))}
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}
