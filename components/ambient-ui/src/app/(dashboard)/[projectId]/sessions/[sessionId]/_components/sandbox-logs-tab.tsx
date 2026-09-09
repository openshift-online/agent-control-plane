'use client'

import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import type { DomainSession, SandboxLogEntry } from '@/domain/types'
import { useSandboxLogs } from '@/queries/use-sandbox-logs'
import { useLiveTail, LiveIndicator, JumpToLatestPill } from './live-tail-indicator'
import { cn } from '@/lib/utils'

function formatTimestamp(ts: number): string {
  const date = new Date(ts)
  return date.toLocaleTimeString('en-US', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

function formatFullTimestamp(ts: number): string {
  return new Date(ts).toISOString()
}

type SourceBadgeProps = { source: SandboxLogEntry['source'] }

function SourceBadge({ source }: SourceBadgeProps) {
  const className =
    source === 'gateway'
      ? 'bg-blue-500/10 text-blue-600 border-blue-500/20 dark:text-blue-400'
      : 'bg-emerald-500/10 text-emerald-600 border-emerald-500/20 dark:text-emerald-400'
  return (
    <Badge variant="outline" className={cn('text-[10px] font-mono uppercase', className)}>
      {source}
    </Badge>
  )
}

type LevelBadgeProps = { level: string }

function LevelBadge({ level }: LevelBadgeProps) {
  let className = 'bg-muted text-muted-foreground border-muted'
  if (level === 'WARN' || level === 'MED') {
    className = 'bg-amber-500/10 text-amber-600 border-amber-500/20 dark:text-amber-400'
  } else if (level === 'OCSF') {
    className = 'bg-purple-500/10 text-purple-600 border-purple-500/20 dark:text-purple-400'
  }
  return (
    <Badge variant="outline" className={cn('text-[10px] font-mono uppercase', className)}>
      {level}
    </Badge>
  )
}

type LogEntryRowProps = { entry: SandboxLogEntry }

function LogEntryRow({ entry }: LogEntryRowProps) {
  return (
    <div
      className={cn(
        'flex items-start gap-2 px-3 py-1.5 text-xs font-mono hover:bg-muted/50',
        entry.denied && 'border-l-2 border-l-red-500 bg-red-500/5',
      )}
    >
      <span
        className="text-muted-foreground shrink-0 tabular-nums"
        title={formatFullTimestamp(entry.timestamp)}
      >
        {formatTimestamp(entry.timestamp)}
      </span>
      <span className="shrink-0">
        <SourceBadge source={entry.source} />
      </span>
      <span className="shrink-0">
        <LevelBadge level={entry.level} />
      </span>
      {entry.category && (
        <Badge variant="outline" className="text-[10px] font-mono shrink-0">
          {entry.category}
        </Badge>
      )}
      {entry.denied && (
        <Badge variant="destructive" className="text-[10px] font-mono shrink-0">
          DENIED
        </Badge>
      )}
      <span className="text-foreground break-all min-w-0">{entry.message}</span>
    </div>
  )
}

export function SandboxLogsTab({ session }: { session: DomainSession }) {
  const isActive = session.phase === 'Running'
  const isSandboxPending = session.phase === 'Pending' || session.phase === 'Creating'
  const { entries, isConnected, isReconnecting, error, retry } = useSandboxLogs(
    session.id,
    isActive,
  )

  const isHistorical = !isActive && !isSandboxPending && entries.length === 0 && session.sandboxLogsSnapshot !== null
  const displayEntries = isHistorical ? (session.sandboxLogsSnapshot ?? []) : entries

  const { scrollRef, sentinelRef, isAtBottom, newEventCount, scrollToBottom } =
    useLiveTail(displayEntries.length)

  const connectionStatus = isSandboxPending
    ? 'Sandbox is not yet running. Logs will stream once the sandbox starts.'
    : !isActive
      ? isHistorical ? 'Saved sandbox logs.' : 'Session is not running. Logs stream while the sandbox is active.'
      : error ? 'Log connection unavailable.'
        : isReconnecting ? 'Reconnecting...'
          : isConnected ? 'Live' : 'Connecting to sandbox logs...'

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
        <span role="status" aria-live="polite" aria-atomic="true">
          {isActive && isConnected && !error ? <LiveIndicator /> : connectionStatus}
        </span>
        {isHistorical && <Badge variant="secondary" className="text-[10px]">Historical</Badge>}
        {(isConnected || isHistorical) && <span>{displayEntries.length} entries</span>}
      </div>

      {isActive && error && (
        <div className="flex flex-wrap items-center gap-3 rounded-md border border-status-error-border bg-status-error p-3 text-sm text-status-error-foreground">
          <p role="alert" className="min-w-0 break-words">{error}</p>
          <Button variant="outline" size="sm" onClick={retry}>Retry</Button>
        </div>
      )}

      <Card className="relative">
        {isAtBottom && displayEntries.length > 0 && isConnected && !isHistorical && (
          <div className="absolute top-2 right-3 z-10" aria-hidden="true">
            <LiveIndicator />
          </div>
        )}

        <CardContent className="p-0">
          {displayEntries.length === 0 ? (
            <p className="p-6 text-center text-sm text-muted-foreground">
              {isActive && !error
                ? 'Waiting for sandbox logs...'
                : 'No sandbox logs available.'}
            </p>
          ) : (
            <div
              ref={scrollRef}
              className="max-h-[600px] overflow-y-auto relative"
              role="log"
              aria-label="Sandbox logs"
            >
              <div className="divide-y divide-border/50">
                {displayEntries.map((entry, index) => (
                  <LogEntryRow key={index} entry={entry} />
                ))}
              </div>
              <div ref={sentinelRef} className="h-1" aria-hidden="true" />
              <JumpToLatestPill
                newEventCount={newEventCount}
                onClick={scrollToBottom}
              />
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
