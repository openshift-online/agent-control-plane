'use client'

import { useState } from 'react'
import { useParams } from 'next/navigation'
import { Bot, Plus } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState } from '@/components/empty-state'
import { useAgents } from '@/queries/use-agents'
import { AgentsTable } from './_components/agents-table'
import { CreateAgentSheet } from './_components/create-agent-sheet'
import { ConfigMapSummaryBar } from './_components/configmap-summary-bar'
import { useGatewayMode } from '@/lib/use-gateway-mode'

export default function AgentsPage() {
  const { projectId } = useParams<{ projectId: string }>()
  const [search, setSearch] = useState('')
  const [createSheetOpen, setCreateSheetOpen] = useState(false)
  const { data, isLoading, error } = useAgents(projectId)
  const gatewayMode = useGatewayMode()

  if (error) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-semibold tracking-tight">Agents</h1>
        <p className="text-sm text-destructive">
          Failed to load agents: {error.message}
        </p>
      </div>
    )
  }

  if (isLoading) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-semibold tracking-tight">Agents</h1>
        <div className="space-y-3">
          <Skeleton className="h-8 w-64" />
          <Skeleton className="h-[400px] w-full" />
        </div>
      </div>
    )
  }

  const agents = data?.items ?? []

  if (agents.length === 0) {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-semibold tracking-tight">Agents</h1>
          <Button size="sm" onClick={() => setCreateSheetOpen(true)}>
            <Plus className="size-4" />
            {gatewayMode ? 'Generate Agent YAML' : 'New Agent'}
          </Button>
        </div>
        <EmptyState
          icon={Bot}
          title="No agents"
          description={gatewayMode
            ? 'No agents have been declared via GitOps yet.'
            : 'This project has no agents yet.'}
          action={
            <Button onClick={() => setCreateSheetOpen(true)}>
              <Plus className="size-4 mr-1.5" />
              {gatewayMode ? 'Generate Agent YAML' : 'Create Agent'}
            </Button>
          }
        />
        <CreateAgentSheet open={createSheetOpen} onOpenChange={setCreateSheetOpen} />
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">Agents</h1>
          <Input
            placeholder="Filter by name, model, or owner..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="w-80"
          />
        </div>
        <Button size="sm" onClick={() => setCreateSheetOpen(true)}>
          <Plus className="size-4" />
          {gatewayMode ? 'Generate Agent YAML' : 'New Agent'}
        </Button>
      </div>
      {gatewayMode && <ConfigMapSummaryBar projectId={projectId} />}
      <AgentsTable
        agents={agents}
        searchFilter={search}
      />
      <CreateAgentSheet open={createSheetOpen} onOpenChange={setCreateSheetOpen} />
    </div>
  )
}
