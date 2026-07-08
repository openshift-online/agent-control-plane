'use client'

import { useState, useMemo } from 'react'
import { AlertTriangle, ChevronRight, ChevronDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { tryFormatJson, tryParseToolPayload, tryParseToolResult } from '@/components/chat-messages'
import type { DomainSessionMessage } from '@/domain/types'
import { formatRelativeTime } from '@/lib/format-timestamp'
import { cn } from '@/lib/utils'
import { EventTypeBadge } from './event-type-badge'

const MAX_CONTENT_LENGTH = 300
const MAX_RESULT_LINES = 4

const COL_TIME = 'shrink-0 w-[100px] font-mono text-xs text-muted-foreground pt-0.5'
const COL_BADGE = 'shrink-0 w-[90px] pt-0.5 flex items-center gap-1'
const COL_CONTENT = 'min-w-0 flex-1'

function truncateContent(content: string): { text: string; truncated: boolean } {
  if (content.length <= MAX_CONTENT_LENGTH) {
    return { text: content, truncated: false }
  }
  return {
    text: content.slice(0, MAX_CONTENT_LENGTH),
    truncated: true,
  }
}

function truncateToLines(text: string, maxLines: number): { text: string; truncated: boolean } {
  const lines = text.split('\n')
  if (lines.length <= maxLines) {
    return { text, truncated: false }
  }
  return {
    text: lines.slice(0, maxLines).join('\n'),
    truncated: true,
  }
}

function formatToolResultPayload(payload: string): string {
  const parsed = tryParseToolResult(payload)
  if (parsed) return parsed.result
  return tryFormatJson(payload)
}

// ---- Collapsible row: collapsed by default, shows a title label ----

function CollapsibleRow({
  message,
  label,
}: {
  message: DomainSessionMessage
  label: string
}) {
  const [expanded, setExpanded] = useState(false)
  const formattedPayload = useMemo(() => tryFormatJson(message.payload), [message.payload])
  const relativeTime = message.createdAt ? formatRelativeTime(message.createdAt) : '--'
  const contentId = `collapsible-${message.id}`

  return (
    <article
      aria-label={`${label}, ${relativeTime}`}
      className="flex gap-3 px-3 py-2 text-sm"
    >
      <span className={COL_TIME}>{relativeTime}</span>
      <span className={COL_BADGE}>
        <EventTypeBadge eventType={message.eventType} />
      </span>
      <div className={COL_CONTENT}>
        <button
          type="button"
          className="flex items-center gap-1 text-xs font-mono font-medium text-foreground hover:text-primary transition-colors"
          onClick={() => setExpanded(prev => !prev)}
          aria-expanded={expanded}
          aria-controls={contentId}
        >
          {expanded ? (
            <ChevronDown className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          )}
          {label}
        </button>
        {expanded && (
          <pre id={contentId} className="mt-1 whitespace-pre-wrap break-words font-mono text-xs text-foreground">
            {formattedPayload}
          </pre>
        )}
      </div>
    </article>
  )
}

// ---- Tool Result: line-based truncation ----

function ToolResultRow({
  message,
  isFollowingToolUse,
}: {
  message: DomainSessionMessage
  isFollowingToolUse: boolean
}) {
  const [expanded, setExpanded] = useState(false)
  const formattedPayload = useMemo(() => formatToolResultPayload(message.payload), [message.payload])
  const { text: truncatedText, truncated } = truncateToLines(formattedPayload, MAX_RESULT_LINES)
  const relativeTime = message.createdAt ? formatRelativeTime(message.createdAt) : '--'

  return (
    <article
      aria-label={`Tool Result, ${relativeTime}`}
      className={cn(
        'flex gap-3 px-3 py-2 text-sm',
        isFollowingToolUse && 'mt-0 pt-1 border-l-2 border-l-border ml-4',
      )}
    >
      <span className={COL_TIME}>{relativeTime}</span>
      <span className={COL_BADGE}>
        <EventTypeBadge eventType={message.eventType} />
      </span>
      <div className={COL_CONTENT}>
        <pre className="whitespace-pre-wrap break-words font-mono text-xs text-foreground">
          {expanded ? formattedPayload : truncatedText}
          {truncated && !expanded && '...'}
        </pre>
        {truncated && (
          <Button
            variant="link"
            size="sm"
            className="h-auto p-0 text-xs text-muted-foreground"
            onClick={() => setExpanded(prev => !prev)}
          >
            {expanded ? 'Show less' : 'Show more'}
          </Button>
        )}
      </div>
    </article>
  )
}

// ---- Generic: character-based truncation for other event types ----

function GenericEventRow({ message }: { message: DomainSessionMessage }) {
  const [expanded, setExpanded] = useState(false)
  const isError = message.eventType === 'error'
  const formattedPayload = useMemo(() => tryFormatJson(message.payload), [message.payload])
  const { text, truncated } = truncateContent(formattedPayload)
  const relativeTime = message.createdAt ? formatRelativeTime(message.createdAt) : '--'
  const ariaLabel = `${message.eventType} event, ${relativeTime}`

  return (
    <article
      aria-label={ariaLabel}
      className={cn(
        'flex gap-3 px-3 py-2 text-sm',
        isError && 'border-l-2 border-l-status-error-foreground bg-status-error/20',
      )}
    >
      <span className={COL_TIME}>{relativeTime}</span>
      <span className={COL_BADGE}>
        {isError && (
          <AlertTriangle className="h-3.5 w-3.5 text-status-error-foreground" aria-hidden="true" />
        )}
        <EventTypeBadge eventType={message.eventType} />
      </span>
      <div className={COL_CONTENT}>
        <pre className="whitespace-pre-wrap break-words font-mono text-xs text-foreground">
          {expanded ? formattedPayload : text}
          {truncated && !expanded && '...'}
        </pre>
        {truncated && (
          <Button
            variant="link"
            size="sm"
            className="h-auto p-0 text-xs text-muted-foreground"
            onClick={() => setExpanded(prev => !prev)}
          >
            {expanded ? 'Show less' : 'Show more'}
          </Button>
        )}
      </div>
    </article>
  )
}

// ---- Public EventRow: dispatches to the right sub-component ----

type EventRowProps = {
  message: DomainSessionMessage
  isToolResultFollowingToolUse: boolean
}

export function EventRow({ message, isToolResultFollowingToolUse }: EventRowProps) {
  const toolLabel = useMemo(
    () => message.eventType === 'tool_use'
      ? tryParseToolPayload(message.payload)?.name ?? 'Unknown Tool'
      : null,
    [message.eventType, message.payload],
  )

  if (message.eventType === 'tool_use') {
    return <CollapsibleRow message={message} label={toolLabel ?? 'Unknown Tool'} />
  }
  if (message.eventType === 'system') {
    return <CollapsibleRow message={message} label="System" />
  }
  if (message.eventType === 'tool_result') {
    return (
      <ToolResultRow
        message={message}
        isFollowingToolUse={isToolResultFollowingToolUse}
      />
    )
  }
  return <GenericEventRow message={message} />
}
