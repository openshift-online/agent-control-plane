'use client'

// Feature-gated by NEXT_PUBLIC_OPENSHELL_USE_GATEWAY env var (sidebar nav only visible when enabled)
import { useParams } from 'next/navigation'
import { Shield } from 'lucide-react'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState } from '@/components/empty-state'
import { usePolicies } from '@/queries/use-policies'
import { PoliciesTable } from './_components/policies-table'

export default function PoliciesPage() {
  const { projectId } = useParams<{ projectId: string }>()
  const { data: policies, isLoading, error } = usePolicies(projectId)

  if (error) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-semibold tracking-tight">Policies</h1>
        <p className="text-sm text-destructive">
          Failed to load policies: {error.message}
        </p>
      </div>
    )
  }

  if (isLoading) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-semibold tracking-tight">Policies</h1>
        <div className="space-y-3">
          <Skeleton className="h-[300px] w-full" />
        </div>
      </div>
    )
  }

  if (!policies || policies.length === 0) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-semibold tracking-tight">Policies</h1>
        <EmptyState
          icon={Shield}
          title="No policies"
          description="No sandbox policies have been declared yet. Create a ConfigMap with label ambient.ai/kind: policy and apply it with kubectl."
        />
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">
          Policies ({policies.length})
        </h1>
      </div>
      <p className="text-sm text-muted-foreground">
        Sandbox policies are managed via GitOps. Use <code className="bg-muted px-1 py-0.5 rounded text-xs">kubectl apply</code> to create or update.
      </p>
      <PoliciesTable policies={policies} />
    </div>
  )
}
