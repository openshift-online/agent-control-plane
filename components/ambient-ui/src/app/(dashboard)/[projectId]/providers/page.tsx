'use client'

// Feature-gated by NEXT_PUBLIC_OPENSHELL_USE_GATEWAY env var (sidebar nav only visible when enabled)
import { useState } from 'react'
import { useParams } from 'next/navigation'
import { KeyRound, Plus } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState } from '@/components/empty-state'
import { useProviders } from '@/queries/use-providers'
import { ProvidersTable } from './_components/providers-table'
import { CreateProviderSheet } from './_components/create-provider-sheet'

export default function ProvidersPage() {
  const { projectId } = useParams<{ projectId: string }>()
  const [search, setSearch] = useState('')
  const [createSheetOpen, setCreateSheetOpen] = useState(false)
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
          <Skeleton className="h-8 w-64" />
          <Skeleton className="h-[400px] w-full" />
        </div>
      </div>
    )
  }

  if (!providers || providers.length === 0) {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-semibold tracking-tight">Providers</h1>
          <Button size="sm" onClick={() => setCreateSheetOpen(true)}>
            <Plus className="size-4" />
            Generate Provider YAML
          </Button>
        </div>
        <EmptyState
          icon={KeyRound}
          title="No providers"
          description="No providers have been declared via GitOps yet."
          action={
            <Button onClick={() => setCreateSheetOpen(true)}>
              <Plus className="size-4 mr-1.5" />
              Generate Provider YAML
            </Button>
          }
        />
        <CreateProviderSheet
          open={createSheetOpen}
          onOpenChange={setCreateSheetOpen}
        />
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">Providers</h1>
          <Input
            placeholder="Filter by name, type, or secret..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-80"
          />
        </div>
        <Button size="sm" onClick={() => setCreateSheetOpen(true)}>
          <Plus className="size-4" />
          Generate Provider YAML
        </Button>
      </div>
      <ProvidersTable providers={providers} searchFilter={search} />
      <CreateProviderSheet
        open={createSheetOpen}
        onOpenChange={setCreateSheetOpen}
      />
    </div>
  )
}
