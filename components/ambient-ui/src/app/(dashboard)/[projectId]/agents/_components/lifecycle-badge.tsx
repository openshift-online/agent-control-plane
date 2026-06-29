'use client'

import { FileStack, CircleDashed } from 'lucide-react'
import { Badge } from '@/components/ui/badge'

export type AgentLifecycle = 'unmanaged' | 'gitops'

export function getAgentLifecycle(annotations: Record<string, string>): AgentLifecycle {
  if (
    annotations['ambient.ai/source'] === 'configmap' ||
    annotations['ambient-code.io/managed-by'] === 'gitops'
  ) {
    return 'gitops'
  }
  return 'unmanaged'
}

export function LifecycleBadge({ lifecycle }: { lifecycle: AgentLifecycle }) {
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
