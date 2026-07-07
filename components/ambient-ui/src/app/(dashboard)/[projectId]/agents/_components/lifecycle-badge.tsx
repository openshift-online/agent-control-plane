'use client'

import { FileStack, CircleDashed } from 'lucide-react'
import { Badge } from '@/components/ui/badge'

export type ResourceLifecycle = 'unmanaged' | 'gitops'

/** @deprecated Use ResourceLifecycle instead */
export type AgentLifecycle = ResourceLifecycle

export function getResourceLifecycle(annotations: Record<string, string>): ResourceLifecycle {
  if (
    annotations['ambient.ai/source'] === 'configmap' ||
    annotations['ambient-code.io/managed-by'] === 'gitops'
  ) {
    return 'gitops'
  }
  return 'unmanaged'
}

export function LifecycleBadge({ lifecycle }: { lifecycle: ResourceLifecycle }) {
  if (lifecycle === 'gitops') {
    return (
      <Badge variant="secondary" className="gap-1 text-blue-600 dark:text-blue-400">
        <FileStack className="size-3" />
        GitOps
      </Badge>
    )
  }

  return (
    <Badge variant="outline" className="gap-1">
      <CircleDashed className="size-3" />
      Unmanaged
    </Badge>
  )
}
