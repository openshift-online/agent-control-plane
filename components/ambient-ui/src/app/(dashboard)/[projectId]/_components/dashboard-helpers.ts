import type { DomainSession, SessionPhase } from '@/domain/types'
import {
  getNeedsYouItems,
  getWorkItemRef as getWorkItemRefFromAnnotations,
  getWorkItemCards,
  getCompletionItems,
  isStale,
  getStaleMinutes,
  getCriticality,
  ROW_GRID_TEMPLATE,
  LEGACY_JIRA_ISSUE,
  LEGACY_GITHUB_PR,
  LEGACY_COST,
  LEGACY_NEEDS_INPUT,
  LEGACY_REVIEW_STATUS,
  type WorkItemRef,
  type NeedsYouItem,
  type WorkItemCard,
  type CompletionItem,
  type Criticality,
} from '@/domain/work-annotations'

export type {
  WorkItemRef,
  NeedsYouItem,
  WorkItemCard,
  CompletionItem,
  Criticality,
}

export {
  getNeedsYouItems,
  getWorkItemCards,
  getCompletionItems,
  isStale,
  getStaleMinutes,
  getCriticality,
  ROW_GRID_TEMPLATE,
}

/** @deprecated Use NeedsYouItem instead */
export type AttentionReason = 'failed' | 'needs-review' | 'needs-input'

/** @deprecated Use NeedsYouItem instead */
export type AttentionItem = {
  session: DomainSession
  reason: AttentionReason
}

/** @deprecated Use WorkItemRef from work-annotations instead */
export type WorkItemGroup = {
  ref: WorkItemRef
  sessions: DomainSession[]
}

/** @deprecated Use CompletionItem instead */
export type RecentActivityItem = {
  session: DomainSession
  ref: WorkItemRef | null
  cost: string | null
}

const ACTIVE_PHASES: ReadonlySet<SessionPhase> = new Set([
  'Running',
  'Creating',
  'Pending',
  'Stopping',
])

const TERMINAL_PHASES: ReadonlySet<SessionPhase> = new Set([
  'Completed',
  'Failed',
  'Stopped',
])

/** Sessions that need operator attention — backward-compatible wrapper around getNeedsYouItems */
export function getAttentionItems(sessions: DomainSession[]): AttentionItem[] {
  const needsYou = getNeedsYouItems(sessions)
  const items: AttentionItem[] = []

  for (const item of needsYou) {
    if (item.session.phase === 'Failed') {
      items.push({ session: item.session, reason: 'failed' })
    } else if (item.statusText.startsWith('Waiting for')) {
      items.push({ session: item.session, reason: 'needs-input' })
    } else {
      items.push({ session: item.session, reason: 'needs-review' })
    }
  }

  // Preserve legacy review status items not captured by getNeedsYouItems
  const coveredIds = new Set(items.map((i) => i.session.id))
  for (const session of sessions) {
    if (coveredIds.has(session.id)) continue
    const reviewStatus = session.annotations[LEGACY_REVIEW_STATUS]
    if (reviewStatus === 'needs-review') {
      items.push({ session, reason: 'needs-review' })
    }
  }

  return items
}

/** @deprecated Use getWorkItemRef from work-annotations instead */
function getWorkItemRefLegacy(session: DomainSession): WorkItemRef | null {
  return getWorkItemRefFromAnnotations(session.annotations)
}

/** @deprecated Use getWorkItemCards instead */
export function getActiveWorkItems(sessions: DomainSession[]): {
  grouped: WorkItemGroup[]
  ungrouped: DomainSession[]
} {
  const activeSessions = sessions.filter((s) => ACTIVE_PHASES.has(s.phase))

  const groupMap = new Map<string, WorkItemGroup>()
  const ungrouped: DomainSession[] = []

  for (const session of activeSessions) {
    const ref = getWorkItemRefLegacy(session)
    if (!ref) {
      ungrouped.push(session)
      continue
    }

    const groupKey = `${ref.type}:${ref.key}`
    const existing = groupMap.get(groupKey)
    if (existing) {
      existing.sessions.push(session)
    } else {
      groupMap.set(groupKey, { ref, sessions: [session] })
    }
  }

  return {
    grouped: Array.from(groupMap.values()),
    ungrouped,
  }
}

/** @deprecated Use getCompletionItems instead */
export function getRecentActivity(sessions: DomainSession[]): RecentActivityItem[] {
  const completed = sessions
    .filter((s) => TERMINAL_PHASES.has(s.phase))
    .sort((a, b) => {
      const aTime = a.completionTime ?? a.updatedAt
      const bTime = b.completionTime ?? b.updatedAt
      return new Date(bTime).getTime() - new Date(aTime).getTime()
    })
    .slice(0, 10)

  return completed.map((session) => ({
    session,
    ref: getWorkItemRefLegacy(session),
    cost: session.annotations[LEGACY_COST] ?? null,
  }))
}
