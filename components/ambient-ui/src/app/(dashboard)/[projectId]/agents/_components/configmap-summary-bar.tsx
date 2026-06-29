'use client'

import { KeyRound, Shield } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { useProviders } from '@/queries/use-providers'
import { usePolicies } from '@/queries/use-policies'

export function ConfigMapSummaryBar({ projectId }: { projectId: string }) {
  const { data: providers } = useProviders(projectId)
  const { data: policies } = usePolicies(projectId)

  const providerCount = providers?.length ?? 0
  const policyCount = policies?.length ?? 0

  if (providerCount === 0 && policyCount === 0) return null

  return (
    <div className="flex items-center gap-3 text-sm text-muted-foreground">
      {providerCount > 0 && (
        <Badge variant="secondary" className="gap-1">
          <KeyRound className="size-3" />
          {providerCount} {providerCount === 1 ? 'Provider' : 'Providers'}
        </Badge>
      )}
      {policyCount > 0 && (
        <Badge variant="secondary" className="gap-1">
          <Shield className="size-3" />
          {policyCount} {policyCount === 1 ? 'Policy' : 'Policies'}
        </Badge>
      )}
    </div>
  )
}
