import type { AmbientClientConfig, RequestOptions } from './base';
import { ambientFetch } from './base';
import type { Project, ProjectList } from './project';
import type { Session, SessionList } from './session';

/** Requires the configured control plane identity. Inventory includes deleted records. */
export class RuntimeAPI {
  constructor(private readonly config: AmbientClientConfig) {}

  projects(page = 1, size = 100, opts?: RequestOptions): Promise<ProjectList> {
    return ambientFetch<ProjectList>(this.config, 'GET', `/runtime/projects?page=${page}&size=${size}`, undefined, opts);
  }

  sessions(page = 1, size = 100, opts?: RequestOptions): Promise<SessionList> {
    return ambientFetch<SessionList>(this.config, 'GET', `/runtime/sessions?page=${page}&size=${size}`, undefined, opts);
  }

  patchProject(id: string, version: number, fields: Record<string, string | null>, opts?: RequestOptions): Promise<Project> {
    return ambientFetch<Project>(this.config, 'PATCH', `/runtime/projects/${encodeURIComponent(id)}`, { ...fields, runtime_version: version }, opts);
  }

  patchSession(id: string, version: number, fields: Record<string, string | null>, opts?: RequestOptions): Promise<Session> {
    return ambientFetch<Session>(this.config, 'PATCH', `/runtime/sessions/${encodeURIComponent(id)}`, { ...fields, runtime_version: version }, opts);
  }
}
