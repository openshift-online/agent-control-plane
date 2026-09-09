import { AlertCircle, Server } from 'lucide-react'
import type { DomainRuntime } from '@/domain/types'

const STATUS_LABELS: Record<string, string> = {
  Provisioning: 'Preparing sandbox service',
  Pending: 'Waiting to start',
  WaitingForGateway: 'Waiting for workspace sandbox service',
  Creating: 'Creating sandbox',
  Running: 'Running',
  Ready: 'Ready',
  Stopping: 'Stopping sandbox',
  Stopped: 'Stopped',
  Deleting: 'Removing sandbox',
  DeletionRequested: 'Removing sandbox service',
  Deleted: 'Removed',
  Failed: 'Action needed',
  Degraded: 'Service needs attention',
}

export function RuntimeStatus({ runtime, label, resource = 'session' }: {
  runtime?: DomainRuntime | null
  label: string
  resource?: 'workspace' | 'session'
}) {
  if (runtime?.backend !== 'hypershell') return null

  const status = resource === 'workspace' && runtime.status === 'Running'
    ? 'Preparing sandbox service'
    : STATUS_LABELS[runtime.status ?? ''] ?? 'Status unavailable'
  const error = runtime.error || ((runtime.status === 'Failed' || runtime.status === 'Degraded')
    ? 'Contact your workspace administrator for help.'
    : null)

  return (
    <div className="min-w-0 space-y-2 rounded-md border p-3 text-sm">
      <p className="flex flex-wrap items-center gap-2" role="status">
        <Server className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="font-medium">{label}</span>
        <span>{status}</span>
      </p>
      {error && (
        <p className="flex min-w-0 items-start gap-2 rounded border border-status-error-border bg-status-error p-2 text-status-error-foreground" role="alert">
          <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span className="min-w-0 break-words [overflow-wrap:anywhere]">{error}</span>
        </p>
      )}
    </div>
  )
}

export function RuntimeResourceDetails({ runtime }: { runtime?: DomainRuntime | null }) {
  if (runtime?.backend !== 'hypershell') return null

  const items = [
    ['Gateway', runtime.gatewayId],
    ['Sandbox', runtime.sandboxName],
    ['OpenShell workspace', runtime.workspace],
  ].filter((item): item is [string, string] => Boolean(item[1]))

  return (
    <section className="space-y-3 rounded-md border p-4" aria-label="Sandbox resources">
      <h3 className="text-sm font-medium">Sandbox resources</h3>
      <dl className="grid min-w-0 gap-3 text-sm sm:grid-cols-[auto_1fr]">
        <div className="contents">
          <dt className="text-muted-foreground">Backend</dt>
          <dd>Hypershell</dd>
        </div>
        {items.map(([label, value]) => (
          <div className="contents" key={label}>
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="break-all font-mono text-xs">{value}</dd>
          </div>
        ))}
      </dl>
      {items.length === 0 && <p className="text-muted-foreground">The sandbox is not assigned yet.</p>}
    </section>
  )
}
