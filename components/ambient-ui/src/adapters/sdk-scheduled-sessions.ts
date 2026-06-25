import type { ScheduledSession, ScheduledSessionCreateRequest, ScheduledSessionPatchRequest, Session } from 'ambient-sdk'
import type { ScheduledSessionsPort } from '@/ports/scheduled-sessions'
import type {
  DomainScheduledSession,
  DomainScheduledSessionCreateRequest,
  DomainScheduledSessionUpdateRequest,
  DomainSession,
  ListParams,
  OverlapPolicy,
  PaginatedResult,
} from '@/domain/types'
import { mapSdkSessionToDomain } from './mappers'
import { getScheduledSessionAPI } from './sdk-client'

function mapSdkToDomain(ss: ScheduledSession): DomainScheduledSession {
  return {
    id: ss.id ?? '',
    name: ss.name ?? '',
    description: ss.description ?? null,
    projectId: ss.project_id ?? '',
    agentId: ss.agent_id ?? null,
    createdByUserId: ss.created_by_user_id ?? null,
    schedule: ss.schedule ?? '',
    timezone: ss.timezone ?? 'UTC',
    enabled: ss.enabled ?? false,
    overlapPolicy: (ss.overlap_policy as OverlapPolicy) ?? 'skip',
    sessionPrompt: ss.session_prompt ?? null,
    lastRunAt: ss.last_run_at ?? null,
    nextRunAt: ss.next_run_at ?? null,
    timeout: ss.timeout ?? null,
    inactivityTimeout: ss.inactivity_timeout ?? null,
    stopOnRunFinished: ss.stop_on_run_finished ?? null,
    runnerType: ss.runner_type ?? null,
    createdAt: ss.created_at ?? '',
    updatedAt: ss.updated_at ?? '',
  }
}

function mapCreateToSdk(req: DomainScheduledSessionCreateRequest): ScheduledSessionCreateRequest {
  const sdk: ScheduledSessionCreateRequest = {
    name: req.name,
    project_id: req.projectId,
    schedule: req.schedule,
  }
  if (req.agentId) sdk.agent_id = req.agentId
  if (req.timezone) sdk.timezone = req.timezone
  if (req.enabled !== undefined) sdk.enabled = req.enabled
  if (req.overlapPolicy) sdk.overlap_policy = req.overlapPolicy
  if (req.sessionPrompt) sdk.session_prompt = req.sessionPrompt
  if (req.timeout !== undefined) sdk.timeout = req.timeout
  if (req.inactivityTimeout !== undefined) sdk.inactivity_timeout = req.inactivityTimeout
  if (req.stopOnRunFinished !== undefined) sdk.stop_on_run_finished = req.stopOnRunFinished
  if (req.runnerType) sdk.runner_type = req.runnerType
  if (req.description) sdk.description = req.description
  return sdk
}

function mapUpdateToSdk(req: DomainScheduledSessionUpdateRequest): ScheduledSessionPatchRequest {
  const sdk: ScheduledSessionPatchRequest = {}
  if (req.name !== undefined) sdk.name = req.name
  if (req.description !== undefined) sdk.description = req.description
  if (req.agentId !== undefined) sdk.agent_id = req.agentId
  if (req.schedule !== undefined) sdk.schedule = req.schedule
  if (req.timezone !== undefined) sdk.timezone = req.timezone
  if (req.enabled !== undefined) sdk.enabled = req.enabled
  if (req.overlapPolicy !== undefined) sdk.overlap_policy = req.overlapPolicy
  if (req.sessionPrompt !== undefined) sdk.session_prompt = req.sessionPrompt
  if (req.timeout !== undefined) sdk.timeout = req.timeout
  if (req.inactivityTimeout !== undefined) sdk.inactivity_timeout = req.inactivityTimeout
  if (req.stopOnRunFinished !== undefined) sdk.stop_on_run_finished = req.stopOnRunFinished
  if (req.runnerType !== undefined) sdk.runner_type = req.runnerType
  return sdk
}

export function createScheduledSessionsAdapter(): ScheduledSessionsPort {
  return {
    async list(projectId: string, params?: ListParams): Promise<PaginatedResult<DomainScheduledSession>> {
      const api = getScheduledSessionAPI(projectId)
      const page = params?.page ?? 1
      const size = params?.size ?? 100
      const result = await api.list({ page, size })
      return {
        items: result.items.map(mapSdkToDomain),
        total: result.total,
        page,
        size,
        hasMore: page * size < result.total,
      }
    },

    async get(projectId: string, id: string): Promise<DomainScheduledSession> {
      const api = getScheduledSessionAPI(projectId)
      const result = await api.get(id)
      return mapSdkToDomain(result)
    },

    async create(projectId: string, request: DomainScheduledSessionCreateRequest): Promise<DomainScheduledSession> {
      const api = getScheduledSessionAPI(projectId)
      const result = await api.create(mapCreateToSdk(request))
      return mapSdkToDomain(result)
    },

    async update(projectId: string, id: string, request: DomainScheduledSessionUpdateRequest): Promise<DomainScheduledSession> {
      const api = getScheduledSessionAPI(projectId)
      const result = await api.update(id, mapUpdateToSdk(request))
      return mapSdkToDomain(result)
    },

    async delete(projectId: string, id: string): Promise<void> {
      const api = getScheduledSessionAPI(projectId)
      await api.delete(id)
    },

    async suspend(projectId: string, id: string): Promise<DomainScheduledSession> {
      const api = getScheduledSessionAPI(projectId)
      const result = await api.suspend(id)
      return mapSdkToDomain(result)
    },

    async resume(projectId: string, id: string): Promise<DomainScheduledSession> {
      const api = getScheduledSessionAPI(projectId)
      const result = await api.resume(id)
      return mapSdkToDomain(result)
    },

    async trigger(projectId: string, id: string): Promise<DomainSession> {
      const api = getScheduledSessionAPI(projectId)
      const result = await api.trigger(id)
      return mapSdkSessionToDomain(result as unknown as Session)
    },

    async runs(projectId: string, id: string): Promise<PaginatedResult<DomainSession>> {
      const api = getScheduledSessionAPI(projectId)
      const result = await api.runs(id) as { items?: unknown[]; total?: number }
      const items = Array.isArray(result.items)
        ? result.items.map((item) => mapSdkSessionToDomain(item as unknown as Session))
        : []
      return {
        items,
        total: result.total ?? items.length,
        page: 1,
        size: items.length,
        hasMore: false,
      }
    },
  }
}
