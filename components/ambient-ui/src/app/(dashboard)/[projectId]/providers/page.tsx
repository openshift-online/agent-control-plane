'use client'

// Feature-gated by NEXT_PUBLIC_OPENSHELL_USE_GATEWAY env var (sidebar nav only visible when enabled)
import { useParams } from 'next/navigation'
import { KeyRound } from 'lucide-react'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState } from '@/components/empty-state'
import { useProviders } from '@/queries/use-providers'
import { ProvidersTable } from './_components/providers-table'

export default function ProvidersPage() {
  const { projectId } = useParams<{ projectId: string }>()
  const { data: providers, isLoading, error } = useProviders(projectId)

  if (error) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-semibold tracking-tight">Providers</h1>
        <p className="text-sm text-destructive">
          Failed to load providers: {error.message}
        </p>
      </div>
    )
  }

  if (isLoading) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-semibold tracking-tight">Providers</h1>
        <div className="space-y-3">
          <Skeleton className="h-[300px] w-full" />
        </div>
      </div>
    )
  }

  if (!providers || providers.length === 0) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-semibold tracking-tight">Providers</h1>
        <EmptyState
          icon={KeyRound}
          title="No providers"
          description="No providers have been declared yet. Create a ConfigMap with label ambient.ai/kind: provider and apply it with kubectl."
        />
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">
          Providers ({providers.length})
        </h1>
      </div>
      <p className="text-sm text-muted-foreground">
        Providers are managed via GitOps. Use <code className="bg-muted px-1 py-0.5 rounded text-xs">kubectl apply</code> to create or update.
      </p>
      <ProvidersTable providers={providers} />
    </div>
  )
}
