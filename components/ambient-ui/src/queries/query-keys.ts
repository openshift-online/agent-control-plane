import type { ListParams } from '@/domain/types'

export const queryKeys = {
  sessions: {
    all: ['sessions'] as const,
    lists: () => [...queryKeys.sessions.all, 'list'] as const,
    list: (projectId: string, params?: ListParams) =>
      [...queryKeys.sessions.lists(), projectId, params] as const,
    listAll: (params?: ListParams) =>
      [...queryKeys.sessions.lists(), 'all-projects', params] as const,
    details: () => [...queryKeys.sessions.all, 'detail'] as const,
    detail: (sessionId: string) =>
      [...queryKeys.sessions.details(), sessionId] as const,
    phaseCounts: (projectId: string) =>
      [...queryKeys.sessions.all, 'phase-counts', projectId] as const,
  },
  projects: {
    all: ['projects'] as const,
    lists: () => [...queryKeys.projects.all, 'list'] as const,
    list: (params?: ListParams) =>
      [...queryKeys.projects.lists(), params] as const,
    details: () => [...queryKeys.projects.all, 'detail'] as const,
    detail: (projectId: string) =>
      [...queryKeys.projects.details(), projectId] as const,
  },
  agents: {
    all: ['agents'] as const,
    lists: () => [...queryKeys.agents.all, 'list'] as const,
    list: (projectId: string, params?: ListParams) =>
      [...queryKeys.agents.lists(), projectId, params] as const,
    details: () => [...queryKeys.agents.all, 'detail'] as const,
    detail: (projectId: string, agentId: string) =>
      [...queryKeys.agents.details(), projectId, agentId] as const,
    names: (projectId: string) =>
      [...queryKeys.agents.all, 'names', projectId] as const,
  },
  messages: {
    all: ['messages'] as const,
    lists: () => [...queryKeys.messages.all, 'list'] as const,
    list: (sessionId: string) =>
      [...queryKeys.messages.lists(), sessionId] as const,
  },
  sessionEvents: {
    all: ['sessionEvents'] as const,
    lists: () => [...queryKeys.sessionEvents.all, 'list'] as const,
    list: (sessionId: string) =>
      [...queryKeys.sessionEvents.lists(), sessionId] as const,
  },
  credentials: {
    all: ['credentials'] as const,
    lists: () => [...queryKeys.credentials.all, 'list'] as const,
    list: (params?: ListParams) =>
      [...queryKeys.credentials.lists(), params] as const,
    details: () => [...queryKeys.credentials.all, 'detail'] as const,
    detail: (id: string) =>
      [...queryKeys.credentials.details(), id] as const,
  },
  roleBindings: {
    all: ['roleBindings'] as const,
    lists: () => [...queryKeys.roleBindings.all, 'list'] as const,
    list: (params?: ListParams) =>
      [...queryKeys.roleBindings.lists(), params] as const,
  },
  roles: {
    all: ['roles'] as const,
    lists: () => [...queryKeys.roles.all, 'list'] as const,
    list: (params?: ListParams) =>
      [...queryKeys.roles.lists(), params] as const,
  },
  users: {
    all: ['users'] as const,
    lists: () => [...queryKeys.users.all, 'list'] as const,
    list: (params?: ListParams) =>
      [...queryKeys.users.lists(), params] as const,
  },
  scheduledSessions: {
    all: ['scheduledSessions'] as const,
    lists: () => [...queryKeys.scheduledSessions.all, 'list'] as const,
    list: (projectId: string, params?: ListParams) =>
      [...queryKeys.scheduledSessions.lists(), projectId, params] as const,
    details: () => [...queryKeys.scheduledSessions.all, 'detail'] as const,
    detail: (projectId: string, id: string) =>
      [...queryKeys.scheduledSessions.details(), projectId, id] as const,
    runs: (projectId: string, id: string) =>
      [...queryKeys.scheduledSessions.all, 'runs', projectId, id] as const,
  },
  providers: {
    all: ['providers'] as const,
    lists: () => [...queryKeys.providers.all, 'list'] as const,
    list: (projectId: string) =>
      [...queryKeys.providers.lists(), projectId] as const,
    details: () => [...queryKeys.providers.all, 'detail'] as const,
    detail: (projectId: string, id: string) =>
      [...queryKeys.providers.details(), projectId, id] as const,
  },
  policies: {
    all: ['policies'] as const,
    lists: () => [...queryKeys.policies.all, 'list'] as const,
    list: (projectId: string) =>
      [...queryKeys.policies.lists(), projectId] as const,
    details: () => [...queryKeys.policies.all, 'detail'] as const,
    detail: (projectId: string, id: string) =>
      [...queryKeys.policies.details(), projectId, id] as const,
  },
  applications: {
    all: ['applications'] as const,
    lists: () => [...queryKeys.applications.all, 'list'] as const,
    list: (params?: ListParams) =>
      [...queryKeys.applications.lists(), params] as const,
    details: () => [...queryKeys.applications.all, 'detail'] as const,
    detail: (id: string) =>
      [...queryKeys.applications.details(), id] as const,
  },
  sandboxPolicy: {
    all: ['sandboxPolicy'] as const,
    detail: (sessionId: string) =>
      [...queryKeys.sandboxPolicy.all, sessionId] as const,
  },
  platformInfo: {
    all: ['platform-info'] as const,
  },
} as const
