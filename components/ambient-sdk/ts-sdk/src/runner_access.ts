import type { AmbientClientConfig, RequestOptions } from './base';
import { ambientFetch } from './base';

export type RunnerAccessMethod = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** Check the caller's session permission without changing state. */
export async function checkRunnerAccess(
  config: AmbientClientConfig, sessionId: string, method: RunnerAccessMethod,
  action: '' | 'stop' = '', opts?: RequestOptions,
): Promise<void> {
  if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
    throw new Error('unsupported runner access method');
  }
  if (action && (action !== 'stop' || method !== 'POST')) {
    throw new Error('unsupported runner access action');
  }
  const suffix = action ? '/stop' : '';
  return ambientFetch<void>(config, method, `/sessions/${encodeURIComponent(sessionId)}/runner/access${suffix}`, undefined, opts);
}
