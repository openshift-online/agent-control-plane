'use client'

// Feature-gated by NEXT_PUBLIC_OPENSHELL_USE_GATEWAY env var (sidebar nav only visible when enabled)
import { useState } from 'react'
import { useParams } from 'next/navigation'
import { Shield } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState } from '@/components/empty-state'
import { usePolicies } from '@/queries/use-policies'
import { PoliciesTable } from './_components/policies-table'

export default function PoliciesPage() {
  const { projectId } = useParams<{ projectId: string }>()
  const [search, setSearch] = useState('')
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
          <Skeleton className="h-8 w-64" />
          <Skeleton className="h-[400px] w-full" />
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
          description="No policies have been declared yet."
        />
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Policies</h1>
        <Input
          placeholder="Filter by name..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-80"
        />
      </div>
      <PoliciesTable policies={policies} searchFilter={search} />
    </div>
  )
}
