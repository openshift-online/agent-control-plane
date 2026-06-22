import type { DomainSession, SessionPhase } from '@/domain/types'

export const WORK_JIRA_ISSUE = 'work.acp.io/jira/issue'
export const WORK_JIRA_URL = 'work.acp.io/jira/url'
export const WORK_JIRA_STATUS = 'work.acp.io/jira/status'
export const WORK_JIRA_SUMMARY = 'work.acp.io/jira/summary'
export const WORK_GITHUB_PR = 'work.acp.io/github/pr'
export const WORK_GITHUB_PR_URL = 'work.acp.io/github/pr-url'
export const WORK_GITHUB_PR_STATUS = 'work.acp.io/github/pr-status'
export const WORK_GITHUB_PR_CHECKS = 'work.acp.io/github/pr-checks'
export const WORK_GITHUB_PR_REVIEW = 'work.acp.io/github/pr-review'
export const AGENT_STATUS = 'agent.acp.io/status'
export const AGENT_STATUS_CRITICALITY = 'agent.acp.io/status-criticality'
export const AGENT_NEEDS_INPUT = 'agent.acp.io/needs-input'
export const WORK_PHASES = 'work.acp.io/phases'

export const LEGACY_JIRA_ISSUE = 'ambient-code.io/jira/issue'
export const LEGACY_GITHUB_PR = 'ambient-code.io/github/pr'
export const LEGACY_GITLAB_MR = 'ambient-code.io/gitlab/mr'
export const LEGACY_GERRIT_CHANGE = 'ambient-code.io/gerrit/change'
export const LEGACY_NEEDS_INPUT = 'ambient-code.io/agent/needs-input'
export const LEGACY_REVIEW_STATUS = 'ambient-code.io/review/status'
export const LEGACY_COST = 'ambient-code.io/cost/estimate'

export type Criticality = 'critical' | 'warning' | 'info'

export type JiraStatus = 'To Do' | 'In Progress' | 'In Review' | 'Done' | 'Blocked'

export const JIRA_TERMINAL_STATUSES: ReadonlySet<string> = new Set<JiraStatus>(['Done'])

export type WorkPhase = 'implementing' | 'reviewing' | 'testing' | 'deploying' | 'complete'

export type WorkPhaseEntry = {
  phase: WorkPhase
  start: string
}

const VALID_WORK_PHASES: ReadonlySet<string> = new Set([
  'implementing',
  'reviewing',
  'testing',
  'deploying',
  'complete',
])

export function parseWorkPhases(annotations: Record<string, string>): WorkPhaseEntry[] {
  const raw = annotations[WORK_PHASES]
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter(
        (entry): entry is WorkPhaseEntry =>
          typeof entry === 'object' &&
          entry !== null &&
          typeof entry.phase === 'string' &&
          VALID_WORK_PHASES.has(entry.phase) &&
          typeof entry.start === 'string',
      )
      .sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime())
  } catch {
    return []
  }
}

export type NeedsYouItem = {
  session: DomainSession
  statusText: string
  criticality: Criticality
  waitingSince: string
}

export type WorkItemRef = {
  type: 'jira' | 'github-pr'
  key: string
  url: string | null
}

export type WorkItemCard = {
  ref: WorkItemRef
  jiraStatus: string | null
  jiraSummary: string | null
  prRef: string | null
  prUrl: string | null
  prStatus: string | null
  prChecks: string | null
  prReview: string | null
  sessions: DomainSession[]
  lastUpdated: string
}

export type CompletionItem = {
  session: DomainSession
  ref: WorkItemRef | null
  result: 'completed' | 'failed' | 'stopped'
  prRef: string | null
  duration: string | null
  completedAt: string
  cost: string | null
}

const ACTIVE_PHASES: ReadonlySet<SessionPhase> = new Set([
  'Running',
  'Creating',
  'Pending',
])

const TERMINAL_PHASES: ReadonlySet<SessionPhase> = new Set([
  'Completed',
  'Failed',
  'Stopped',
])

const CRITICALITY_SORT_ORDER: Record<Criticality, number> = {
  critical: 1,
  warning: 2,
  info: 3,
}

export const ACTIONABLE_CRITICALITIES: ReadonlySet<Criticality> = new Set<Criticality>(['critical', 'warning'])

const STALE_THRESHOLD_MS = 15 * 60 * 1000

const RECENT_COMPLETIONS_LIMIT = 10

export function getCriticality(annotations: Record<string, string>): Criticality {
  const value = annotations[AGENT_STATUS_CRITICALITY]
  if (value === 'critical' || value === 'warning' || value === 'info') {
    return value
  }
  return 'warning'
}

export function getWorkItemRef(annotations: Record<string, string>): WorkItemRef | null {
  const workJiraKey = annotations[WORK_JIRA_ISSUE]
  if (workJiraKey) {
    return {
      type: 'jira',
      key: workJiraKey,
      url: annotations[WORK_JIRA_URL] ?? null,
    }
  }

  const workPrRef = annotations[WORK_GITHUB_PR]
  if (workPrRef) {
    return {
      type: 'github-pr',
      key: workPrRef,
      url: annotations[WORK_GITHUB_PR_URL] ?? null,
    }
  }

  const legacyJiraKey = annotations[LEGACY_JIRA_ISSUE]
  if (legacyJiraKey) {
    return {
      type: 'jira',
      key: legacyJiraKey,
      url: null,
    }
  }

  const legacyPrRef = annotations[LEGACY_GITHUB_PR]
  if (legacyPrRef) {
    return {
      type: 'github-pr',
      key: legacyPrRef,
      url: null,
    }
  }

  return null
}

export function getNeedsYouItems(sessions: DomainSession[]): NeedsYouItem[] {
  const items: NeedsYouItem[] = []

  for (const session of sessions) {
    const agentStatus = session.annotations[AGENT_STATUS]
    if (agentStatus) {
      items.push({
        session,
        statusText: agentStatus,
        criticality: getCriticality(session.annotations),
        waitingSince: session.updatedAt,
      })
      continue
    }

    if (session.phase === 'Failed') {
      items.push({
        session,
        statusText: 'Failed',
        criticality: 'critical',
        waitingSince: session.completionTime ?? session.updatedAt,
      })
      continue
    }

    const needsInput =
      session.annotations[AGENT_NEEDS_INPUT] ??
      session.annotations[LEGACY_NEEDS_INPUT]
    if (needsInput && needsInput !== 'false') {
      items.push({
        session,
        statusText: `Waiting for ${needsInput}`,
        criticality: 'warning',
        waitingSince: session.updatedAt,
      })
    }
  }

  return items.sort((a, b) => {
    const critDiff = CRITICALITY_SORT_ORDER[a.criticality] - CRITICALITY_SORT_ORDER[b.criticality]
    if (critDiff !== 0) return critDiff
    return new Date(b.waitingSince).getTime() - new Date(a.waitingSince).getTime()
  })
}

export function getWorkItemCards(sessions: DomainSession[]): WorkItemCard[] {
  const activeSessions = sessions.filter(
    (s) => ACTIVE_PHASES.has(s.phase) && !JIRA_TERMINAL_STATUSES.has(s.annotations[WORK_JIRA_STATUS] ?? ''),
  )
  const groupMap = new Map<string, WorkItemCard>()

  for (const session of activeSessions) {
    const ref = getWorkItemRef(session.annotations)
    if (!ref) continue

    const groupKey = `${ref.type}:${ref.key}`
    const existing = groupMap.get(groupKey)

    if (existing) {
      existing.sessions.push(session)
      if (session.updatedAt > existing.lastUpdated) {
        existing.lastUpdated = session.updatedAt
      }
      if (!existing.prRef) {
        existing.prRef = session.annotations[WORK_GITHUB_PR] ?? null
      }
      if (!existing.prUrl) {
        existing.prUrl = session.annotations[WORK_GITHUB_PR_URL] ?? null
      }
      if (!existing.prStatus) {
        existing.prStatus = session.annotations[WORK_GITHUB_PR_STATUS] ?? null
      }
      if (!existing.prChecks) {
        existing.prChecks = session.annotations[WORK_GITHUB_PR_CHECKS] ?? null
      }
      if (!existing.prReview) {
        existing.prReview = session.annotations[WORK_GITHUB_PR_REVIEW] ?? null
      }
      if (!existing.jiraStatus) {
        existing.jiraStatus = session.annotations[WORK_JIRA_STATUS] ?? null
      }
      if (!existing.jiraSummary) {
        existing.jiraSummary = session.annotations[WORK_JIRA_SUMMARY] ?? null
      }
    } else {
      groupMap.set(groupKey, {
        ref,
        jiraStatus: session.annotations[WORK_JIRA_STATUS] ?? null,
        jiraSummary: session.annotations[WORK_JIRA_SUMMARY] ?? null,
        prRef: session.annotations[WORK_GITHUB_PR] ?? null,
        prUrl: session.annotations[WORK_GITHUB_PR_URL] ?? null,
        prStatus: session.annotations[WORK_GITHUB_PR_STATUS] ?? null,
        prChecks: session.annotations[WORK_GITHUB_PR_CHECKS] ?? null,
        prReview: session.annotations[WORK_GITHUB_PR_REVIEW] ?? null,
        sessions: [session],
        lastUpdated: session.updatedAt,
      })
    }
  }

  return Array.from(groupMap.values())
}

const RESULT_SORT_ORDER: Record<string, number> = {
  Failed: 1,
  Stopped: 2,
  Completed: 3,
}

export function getCompletionItems(sessions: DomainSession[]): CompletionItem[] {
  return sessions
    .filter((s) => TERMINAL_PHASES.has(s.phase))
    .sort((a, b) => {
      const resultDiff = (RESULT_SORT_ORDER[a.phase] ?? 4) - (RESULT_SORT_ORDER[b.phase] ?? 4)
      if (resultDiff !== 0) return resultDiff
      const aTime = a.completionTime ?? a.updatedAt
      const bTime = b.completionTime ?? b.updatedAt
      return new Date(bTime).getTime() - new Date(aTime).getTime()
    })
    .slice(0, RECENT_COMPLETIONS_LIMIT)
    .map((session) => {
      const completedAt = session.completionTime ?? session.updatedAt
      let duration: string | null = null
      if (session.startTime) {
        const durationMs = new Date(completedAt).getTime() - new Date(session.startTime).getTime()
        if (durationMs >= 0) {
          const totalMinutes = Math.floor(durationMs / 60000)
          const hours = Math.floor(totalMinutes / 60)
          const minutes = totalMinutes % 60
          duration = hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`
        }
      }

      return {
        session,
        ref: getWorkItemRef(session.annotations),
        result: session.phase.toLowerCase() as 'completed' | 'failed' | 'stopped',
        prRef: session.annotations[WORK_GITHUB_PR] ?? session.annotations[LEGACY_GITHUB_PR] ?? null,
        duration,
        completedAt,
        cost: session.annotations[LEGACY_COST] ?? null,
      }
    })
}

export function resolveAgentName(
  session: DomainSession,
  agentNames?: Map<string, string>,
): string {
  if (session.agentName) return session.agentName
  if (session.agentId && agentNames?.has(session.agentId)) return agentNames.get(session.agentId) ?? session.name
  return session.name
}

export function isStale(session: DomainSession): boolean {
  if (session.phase !== 'Running') return false
  const elapsed = Date.now() - new Date(session.updatedAt).getTime()
  return elapsed > STALE_THRESHOLD_MS
}

export function getStaleMinutes(session: DomainSession): number | null {
  if (!isStale(session)) return null
  return Math.floor((Date.now() - new Date(session.updatedAt).getTime()) / 60000)
}

export const ROW_GRID_TEMPLATE = 'grid-cols-[4px_minmax(160px,240px)_1fr_72px_110px_80px_88px]'
