'use client'

import { AlertTriangle } from 'lucide-react'
import { usePlatformHealth } from '@/hooks/use-platform-health'

export function PlatformHealthBanner() {
  const { apiServer, controlPlane, isHealthy, isLoading } = usePlatformHealth()

  if (isLoading || isHealthy) {
    return null
  }

  return (
    <div
      role="alert"
      className="flex items-center gap-2 border-b border-status-warning-border/40 bg-status-warning/10 px-4 py-2 text-sm text-status-warning-foreground"
    >
      <AlertTriangle className="size-4 shrink-0" aria-hidden="true" />
      <span>
        Platform services are degraded. There may be issues starting, stopping,
        or modifying sessions until the issue is resolved.
      </span>
    </div>
  )
}
