export type SessionPhase =
  | 'Pending'
  | 'Creating'
  | 'Running'
  | 'Stopping'
  | 'Completed'
  | 'Failed'
  | 'Stopped'

export type DomainRepo = {
  url: string
  branch: string | null
  name: string | null
  autoPush: boolean
}

export type ReconciledRepoStatus = 'Cloning' | 'Ready' | 'Failed'

export type DomainReconciledRepo = {
  url: string
  name: string | null
  status: ReconciledRepoStatus | null
  currentActiveBranch: string | null
  defaultBranch: string | null
  clonedAt: string | null
}

export type ConditionStatus = 'True' | 'False' | 'Unknown'

export type DomainCondition = {
  type: string
  status: ConditionStatus
  reason: string | null
  message: string | null
  lastTransitionTime: string | null
}

export type DomainSession = {
  id: string
  name: string
  phase: SessionPhase
  agentId: string | null
  agentName: string | null
  projectId: string | null
  model: string | null
  temperature: number | null
  maxTokens: number | null
  timeout: number | null
  workflowId: string | null
  prompt: string | null
  sdkRestartCount: number
  startTime: string | null
  completionTime: string | null
  createdAt: string
  updatedAt: string
  annotations: Record<string, string>
  labels: Record<string, string>
  environmentVariables: Record<string, string>
  repos: DomainRepo[]
  reconciledRepos: DomainReconciledRepo[]
  conditions: DomainCondition[]
  kubeNamespace: string | null
  sandboxLogsSnapshot: SandboxLogEntry[] | null
  sandboxPolicySnapshot: SandboxPolicyResponse | null
}

export type DomainProject = {
  id: string
  name: string
  description: string | null
  status: string | null
  createdAt: string
  updatedAt: string
}

export type PaginatedResult<T> = {
  items: T[]
  total: number
  page: number
  size: number
  hasMore: boolean
}

export type ListParams = {
  page?: number
  size?: number
  search?: string
  orderBy?: string
  phase?: SessionPhase
}

export type SessionEventType =
  | 'user'
  | 'assistant'
  | 'text'
  | 'tool_use'
  | 'tool_result'
  | 'error'
  | 'lifecycle'
  | 'user_feedback'
  | 'system'

export type DomainSessionMessage = {
  id: string
  sessionId: string
  eventType: SessionEventType
  payload: string
  seq: number
  createdAt: string
}

export type DomainSessionEvent = {
  id: string
  sessionId: string
  seq: number
  eventType: string
  payload: string
  createdAt: string
  completedAt: string | null
  eventCount: number
}

export type DomainPayload = {
  sandbox_path: string
  content?: string
  repo_url?: string
  ref?: string
}

export type DomainResourceRequirements = {
  cpu?: string
  memory?: string
}

export type DomainGpuRequirements = {
  count?: number
}

export type DomainSandboxTemplate = {
  image?: string
  resources?: DomainResourceRequirements
  gpu?: DomainGpuRequirements
  runtime_class_name?: string
  log_level?: string
}

export type DomainAgent = {
  id: string
  name: string
  displayName: string | null
  description: string | null
  model: string | null
  ownerUserId: string | null
  currentSessionId: string | null
  projectId: string | null
  prompt: string | null
  repoUrl: string | null
  workflowId: string | null
  entrypoint: string | null
  providers: string[]
  payloads: DomainPayload[]
  environment: Record<string, string>
  sandboxTemplate: DomainSandboxTemplate | null
  sandboxPolicy: string | null
  annotations: Record<string, string>
  labels: Record<string, string>
  createdAt: string
  updatedAt: string
}

export type DomainSessionCreateRequest = {
  name: string
  projectId: string
  agentId?: string
  prompt?: string
  model?: string
  temperature?: number
  maxTokens?: number
  timeout?: number
  annotations?: Record<string, string>
}

export type DomainAgentCreateRequest = {
  name: string
  projectId: string
  displayName?: string
  model?: string
  prompt?: string
  repoUrl?: string
  description?: string
  entrypoint?: string
  providers?: string[]
  payloads?: DomainPayload[]
  environment?: Record<string, string>
  sandboxTemplate?: DomainSandboxTemplate
  sandboxPolicy?: string
}

export type DomainAgentUpdateRequest = {
  displayName?: string
  model?: string
  prompt?: string
  repoUrl?: string
  description?: string
  entrypoint?: string
  providers?: string[]
  payloads?: DomainPayload[]
  environment?: Record<string, string>
  sandboxTemplate?: DomainSandboxTemplate
  sandboxPolicy?: string
}

export type FeedbackItem = {
  id: string
  type: 'element' | 'region'
  comment: string
  position: { x: number; y: number }
  dimensions?: { width: number; height: number }
  capturedHtml?: string
  viewportWidth: number
  viewportHeight: number
  deviceSize: string
  timestamp: string
}

export type FeedbackBatch = {
  items: FeedbackItem[]
  sessionId: string
  previewUrl: string
}

export type DomainCredential = {
  id: string
  name: string
  provider: string
  description: string | null
  email: string | null
  url: string | null
  annotations: Record<string, string>
  labels: Record<string, string>
  createdAt: string
  updatedAt: string
}

export type DomainCredentialCreateRequest = {
  name: string
  provider: string
  description?: string
  email?: string
  url?: string
  token?: string
}

export type DomainCredentialUpdateRequest = {
  name?: string
  description?: string
  email?: string
  url?: string
  token?: string
}

export type DomainRoleBinding = {
  id: string
  roleId: string
  scope: string
  userId: string | null
  projectId: string | null
  agentId: string | null
  credentialId: string | null
  sessionId: string | null
  createdAt: string
  updatedAt: string
}

export type DomainRoleBindingCreateRequest = {
  roleId: string
  scope: string
  userId?: string
  projectId?: string
  agentId?: string
  credentialId?: string
  sessionId?: string
}

export type DomainRoleBindingPatchRequest = {
  roleId?: string
}

export type DomainUserSearchResult = {
  id: string
  username: string
  name: string
}

export type OverlapPolicy = 'skip' | 'allow'

export type DomainScheduledSession = {
  id: string
  name: string
  description: string | null
  projectId: string
  agentId: string | null
  createdByUserId: string | null
  schedule: string
  timezone: string
  enabled: boolean
  overlapPolicy: OverlapPolicy
  sessionPrompt: string | null
  lastRunAt: string | null
  nextRunAt: string | null
  timeout: number | null
  inactivityTimeout: number | null
  stopOnRunFinished: boolean | null
  runnerType: string | null
  createdAt: string
  updatedAt: string
}

export type DomainScheduledSessionCreateRequest = {
  name: string
  projectId: string
  agentId?: string
  schedule: string
  timezone?: string
  enabled?: boolean
  overlapPolicy?: OverlapPolicy
  sessionPrompt?: string
  timeout?: number
  inactivityTimeout?: number
  stopOnRunFinished?: boolean
  runnerType?: string
  description?: string
}

export type DomainScheduledSessionUpdateRequest = {
  name?: string
  description?: string
  agentId?: string
  schedule?: string
  timezone?: string
  enabled?: boolean
  overlapPolicy?: OverlapPolicy
  sessionPrompt?: string
  timeout?: number
  inactivityTimeout?: number
  stopOnRunFinished?: boolean
  runnerType?: string
}

export type DomainProvider = {
  id: string
  name: string
  type: string
  secret: string
  namespace: string
  projectId: string
  annotations: Record<string, string>
  labels: Record<string, string>
  createdAt: string
  updatedAt: string
}

export type DomainPolicy = {
  id: string
  name: string
  namespace: string
  projectId: string
  spec: Record<string, unknown>
  annotations: Record<string, string>
  labels: Record<string, string>
  createdAt: string
  updatedAt: string
}

export type SandboxLogEntry = {
  timestamp: number
  source: 'gateway' | 'sandbox'
  level: string
  module: string
  message: string
  category?: string
  denied?: boolean
}

export type SandboxNetworkEndpoint = {
  host: string
  port: number
  protocol?: string
  tls?: string
  enforcement?: string
  access?: string
}

export type SandboxNetworkBinary = {
  path: string
}

export type SandboxNetworkPolicy = {
  name: string
  endpoints: SandboxNetworkEndpoint[]
  binaries?: SandboxNetworkBinary[]
}

export type SandboxPolicyData = {
  version: number
  filesystem_policy: {
    include_workdir: boolean
    read_only: string[]
    read_write: string[]
  }
  landlock: {
    compatibility: string
  }
  process: {
    run_as_user: string
    run_as_group: string
  }
  network_policies: Record<string, SandboxNetworkPolicy>
}

export type SandboxPolicyResponse = {
  version: number
  hash: string
  status: string
  source: string
  config_revision: string
  policy: SandboxPolicyData
}

export type DomainApplication = {
  id: string
  name: string
  sourceRepoUrl: string
  sourceTargetRevision: string | null
  sourcePath: string
  destinationAmbientUrl: string | null
  destinationProject: string
  credentialId: string | null
  autoSync: boolean
  autoPrune: boolean
  selfHeal: boolean
  syncOptions: string | null
  retryLimit: number
  syncStatus: string | null
  healthStatus: string | null
  syncRevision: string | null
  operationPhase: string | null
  operationMessage: string | null
  resourceStatus: string | null
  conditions: string | null
  annotations: Record<string, string>
  labels: Record<string, string>
  lastSyncedAt: string | null
  createdAt: string
  updatedAt: string
}

export type DomainApplicationCreateRequest = {
  name: string
  sourceRepoUrl: string
  sourcePath: string
  destinationProject: string
  sourceTargetRevision?: string
  destinationAmbientUrl?: string
  credentialId?: string
  autoSync?: boolean
  autoPrune?: boolean
  selfHeal?: boolean
  syncOptions?: string
  retryLimit?: number
}

export type DomainApplicationUpdateRequest = {
  name?: string
  sourceRepoUrl?: string
  sourcePath?: string
  destinationProject?: string
  sourceTargetRevision?: string
  destinationAmbientUrl?: string
  credentialId?: string
  autoSync?: boolean
  autoPrune?: boolean
  selfHeal?: boolean
  syncOptions?: string
  retryLimit?: number
}
