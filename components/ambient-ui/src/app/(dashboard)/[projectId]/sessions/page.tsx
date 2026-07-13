'use client'

import { useState, useCallback, useMemo } from 'react'
import { useParams } from 'next/navigation'
import { Monitor, Plus, FlaskConical, FolderTree } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState } from '@/components/empty-state'
import { useSessions, useSessionPhaseCounts } from '@/queries/use-sessions'
import { useAgentNames } from '@/queries/use-agents'
import type { SessionPhase } from '@/domain/types'
import { buildFolderTree } from '@/domain/folder-tree'
import { FleetTable } from './_components/fleet-table'
import { FleetSummary } from './_components/fleet-summary'
import { FolderTreePanel } from './_components/folder-tree-panel'
import { CreateSessionSheet } from './_components/create-session-sheet'

const PAGE_SIZE = 20

export default function FleetPage() {
  const { projectId } = useParams<{ projectId: string }>()
  const [search, setSearch] = useState('')
  const [phaseFilter, setPhaseFilter] = useState<SessionPhase | null>(null)
  const [filteredCount, setFilteredCount] = useState<number | undefined>(undefined)
  const [createOpen, setCreateOpen] = useState(false)
  const [showTestRuns, setShowTestRuns] = useState(false)
  const [showFolderTree, setShowFolderTree] = useState(false)
  const [pathFilter, setPathFilter] = useState<string | null>(null)
  const [currentPage, setCurrentPage] = useState(1)
  const { data, isLoading, error } = useSessions(projectId, {
    page: currentPage,
    size: PAGE_SIZE,
    orderBy: 'created_at desc',
    phase: phaseFilter ?? undefined,
  })
  const { data: phaseCounts } = useSessionPhaseCounts(projectId)
  const { data: agentNames } = useAgentNames(projectId)

  const handlePhaseFilter = useCallback((phase: SessionPhase | null) => {
    setPhaseFilter(phase)
    setCurrentPage(1)
  }, [])

  const handleFilteredCountChange = useCallback((count: number) => {
    setFilteredCount(count)
  }, [])

  const sessions = data?.items ?? []
  const serverTotal = data?.total ?? 0
  const totalPages = Math.max(1, Math.ceil(serverTotal / PAGE_SIZE))
  const testSessionCount = sessions.filter(
    (s) => s.annotations['ambient-code.io/ui/test-session'] === 'true',
  ).length
  const folderTree = useMemo(() => buildFolderTree(sessions), [sessions])
  const hasFolders = folderTree.length > 0

  if (error) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-semibold tracking-tight">Sessions</h1>
        <p className="text-sm text-destructive">
          Failed to load sessions: {error.message}
        </p>
      </div>
    )
  }

  if (isLoading) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-semibold tracking-tight">Sessions</h1>
        <div className="space-y-3">
          <Skeleton className="h-8 w-64" />
          <Skeleton className="h-[400px] w-full" />
        </div>
      </div>
    )
  }

  if (sessions.length === 0 && currentPage === 1 && !phaseFilter) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-semibold tracking-tight">Sessions</h1>
        <EmptyState
          icon={Monitor}
          title="No sessions"
          description="This project has no agentic sessions yet. Create one to get started."
          action={
            <Button onClick={() => setCreateOpen(true)}>
              <Plus className="mr-1.5 size-4" />
              New Session
            </Button>
          }
        />
        <CreateSessionSheet open={createOpen} onOpenChange={setCreateOpen} />
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">Sessions</h1>
          <Input
            placeholder="Filter by name, agent, or model..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="w-80"
          />
        </div>
        <div className="flex items-center gap-2">
          {hasFolders && (
            <Button
              variant={showFolderTree ? 'secondary' : 'ghost'}
              size="sm"
              onClick={() => {
                setShowFolderTree((prev) => !prev)
                if (showFolderTree) setPathFilter(null)
              }}
              className="text-xs text-muted-foreground"
            >
              <FolderTree className="mr-1 size-3.5" />
              Folders
            </Button>
          )}
          {testSessionCount > 0 && (
            <Button
              variant={showTestRuns ? 'secondary' : 'ghost'}
              size="sm"
              onClick={() => setShowTestRuns((prev) => !prev)}
              className="text-xs text-muted-foreground"
            >
              <FlaskConical className="mr-1 size-3.5" />
              {showTestRuns
                ? 'Hide test runs'
                : `Show test runs (${testSessionCount})`}
            </Button>
          )}
          <Button onClick={() => setCreateOpen(true)} size="sm">
            <Plus className="mr-1.5 size-4" />
            New Session
          </Button>
        </div>
      </div>
      <FleetSummary
        serverTotal={serverTotal}
        phaseCounts={phaseCounts ?? {}}
        pageItemCount={sessions.length}
        filteredCount={filteredCount}
        activePhase={phaseFilter}
        onPhaseFilter={handlePhaseFilter}
      />
      <div className="flex gap-4">
        {showFolderTree && (
          <FolderTreePanel
            tree={folderTree}
            selectedPath={pathFilter}
            onSelect={setPathFilter}
          />
        )}
        <div className="min-w-0 flex-1">
          <FleetTable
            sessions={sessions}
            searchFilter={search}
            agentNames={agentNames}
            showTestRuns={showTestRuns}
            pathFilter={pathFilter}
            onFilteredCountChange={handleFilteredCountChange}
            currentPage={currentPage}
            totalPages={totalPages}
            pageSize={PAGE_SIZE}
            serverTotal={serverTotal}
            onPageChange={setCurrentPage}
          />
        </div>
      </div>
      <CreateSessionSheet open={createOpen} onOpenChange={setCreateOpen} />
    </div>
  )
}
