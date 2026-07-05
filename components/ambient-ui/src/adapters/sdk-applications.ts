import { ApplicationAPI } from 'ambient-sdk'
import type { ApplicationCreateRequest, ApplicationPatchRequest } from 'ambient-sdk'
import type { ApplicationsPort } from '@/ports/applications'
import type {
  DomainApplication,
  DomainApplicationCreateRequest,
  DomainApplicationUpdateRequest,
  ListParams,
  PaginatedResult,
} from '@/domain/types'
import { mapSdkApplicationToDomain } from './mappers'
import { getConfig } from './sdk-client'

function getAPI(): ApplicationAPI {
  return new ApplicationAPI(getConfig())
}

function sanitizeSearch(value: string): string {
  return value.replace(/['"%;\\\_]/g, '')
}

function buildSdkListOptions(params?: ListParams) {
  return {
    page: params?.page ?? 1,
    size: params?.size ?? 20,
    search: params?.search
      ? `name like '%${sanitizeSearch(params.search)}%'`
      : undefined,
    orderBy: params?.orderBy,
  }
}

function mapDomainCreateToSdk(request: DomainApplicationCreateRequest): ApplicationCreateRequest {
  const sdkReq: ApplicationCreateRequest = {
    name: request.name,
    source_repo_url: request.sourceRepoUrl,
    source_path: request.sourcePath,
    destination_project: request.destinationProject,
  }
  if (request.sourceTargetRevision) sdkReq.source_target_revision = request.sourceTargetRevision
  if (request.destinationAmbientUrl) sdkReq.destination_ambient_url = request.destinationAmbientUrl
  if (request.credentialId) sdkReq.credential_id = request.credentialId
  if (request.autoSync !== undefined) sdkReq.auto_sync = request.autoSync
  if (request.autoPrune !== undefined) sdkReq.auto_prune = request.autoPrune
  if (request.selfHeal !== undefined) sdkReq.self_heal = request.selfHeal
  if (request.syncOptions) sdkReq.sync_options = request.syncOptions
  if (request.retryLimit !== undefined) sdkReq.retry_limit = request.retryLimit
  return sdkReq
}

function mapDomainUpdateToSdk(request: DomainApplicationUpdateRequest): ApplicationPatchRequest {
  const sdkReq: ApplicationPatchRequest = {}
  if (request.name !== undefined) sdkReq.name = request.name
  if (request.sourceRepoUrl !== undefined) sdkReq.source_repo_url = request.sourceRepoUrl
  if (request.sourcePath !== undefined) sdkReq.source_path = request.sourcePath
  if (request.destinationProject !== undefined) sdkReq.destination_project = request.destinationProject
  if (request.sourceTargetRevision !== undefined) sdkReq.source_target_revision = request.sourceTargetRevision
  if (request.destinationAmbientUrl !== undefined) sdkReq.destination_ambient_url = request.destinationAmbientUrl
  if (request.credentialId !== undefined) sdkReq.credential_id = request.credentialId
  if (request.autoSync !== undefined) sdkReq.auto_sync = request.autoSync
  if (request.autoPrune !== undefined) sdkReq.auto_prune = request.autoPrune
  if (request.selfHeal !== undefined) sdkReq.self_heal = request.selfHeal
  if (request.syncOptions !== undefined) sdkReq.sync_options = request.syncOptions
  if (request.retryLimit !== undefined) sdkReq.retry_limit = request.retryLimit
  return sdkReq
}

export function createApplicationsAdapter(): ApplicationsPort {
  return {
    async list(params?: ListParams): Promise<PaginatedResult<DomainApplication>> {
      const api = getAPI()
      const opts = buildSdkListOptions(params)
      const result = await api.list(opts)
      const page = opts.page
      const size = opts.size
      return {
        items: result.items.map(mapSdkApplicationToDomain),
        total: result.total,
        page,
        size,
        hasMore: page * size < result.total,
      }
    },
    async get(id: string): Promise<DomainApplication> {
      const api = getAPI()
      const app = await api.get(id)
      return mapSdkApplicationToDomain(app)
    },
    async create(request: DomainApplicationCreateRequest): Promise<DomainApplication> {
      const api = getAPI()
      const sdkReq = mapDomainCreateToSdk(request)
      const app = await api.create(sdkReq)
      return mapSdkApplicationToDomain(app)
    },
    async update(id: string, request: DomainApplicationUpdateRequest): Promise<DomainApplication> {
      const api = getAPI()
      const sdkReq = mapDomainUpdateToSdk(request)
      const app = await api.update(id, sdkReq)
      return mapSdkApplicationToDomain(app)
    },
    async delete(id: string): Promise<void> {
      const api = getAPI()
      await api.delete(id)
    },
  }
}
