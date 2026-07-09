'use client'

import { useState, useMemo, useRef, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import {
  useReactTable,
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  flexRender,
  createColumnHelper,
} from '@tanstack/react-table'
import type { SortingState } from '@tanstack/react-table'
import { GitBranch, ChevronUp, ChevronDown } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Badge } from '@/components/ui/badge'
import { EmptyState } from '@/components/empty-state'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { useApplications } from '@/queries/use-applications'
import { useWorkspaceFlag } from '@/services/queries/use-feature-flags-admin'
import { useTableKeyboardNav } from '@/hooks/use-table-keyboard-nav'
import { cn } from '@/lib/utils'
import type { DomainApplication } from '@/domain/types'

const col = createColumnHelper<DomainApplication>()

function SyncBadge({ status }: { status: string | null }) {
  if (!status) return <Badge variant="outline">Unknown</Badge>
  const variant = status === 'Synced' ? 'default' : status === 'OutOfSync' ? 'destructive' : 'secondary'
  return <Badge variant={variant}>{status}</Badge>
}

function HealthBadge({ status }: { status: string | null }) {
  if (!status) return <Badge variant="outline">Unknown</Badge>
  const variant = status === 'Healthy' ? 'default' : status === 'Degraded' ? 'destructive' : 'secondary'
  return <Badge variant={variant}>{status}</Badge>
}

const columns = [
  col.accessor('name', {
    header: 'Name',
    cell: (info) => <span className="font-medium">{info.getValue()}</span>,
  }),
  col.accessor('sourceRepoUrl', {
    header: 'Repository',
    cell: (info) => {
      const url = info.getValue()
      const short = url.replace(/^https?:\/\//, '').replace(/\.git$/, '')
      return <span className="truncate text-muted-foreground">{short}</span>
    },
  }),
  col.accessor('destinationProject', {
    header: 'Project',
    cell: (info) => info.getValue(),
  }),
  col.accessor('syncStatus', {
    header: 'Sync',
    cell: (info) => <SyncBadge status={info.getValue()} />,
  }),
  col.accessor('healthStatus', {
    header: 'Health',
    cell: (info) => <HealthBadge status={info.getValue()} />,
  }),
  col.accessor('autoSync', {
    header: 'Auto Sync',
    cell: (info) => (
      <Badge variant={info.getValue() ? 'default' : 'outline'}>
        {info.getValue() ? 'On' : 'Off'}
      </Badge>
    ),
  }),
]

export default function ApplicationsPage() {
  const { enabled: applicationsEnabled } = useWorkspaceFlag(undefined, 'feature.applications.enabled')
  const router = useRouter()
  const containerRef = useRef<HTMLDivElement>(null)
  const [search, setSearch] = useState('')
  const { data, isLoading, error } = useApplications(undefined, undefined, applicationsEnabled)

  const [sorting, setSorting] = useState<SortingState>([
    { id: 'name', desc: false },
  ])

  const applications = useMemo(() => data?.items ?? [], [data])

  const table = useReactTable({
    data: applications,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getSortedRowModel: getSortedRowModel(),
    globalFilterFn: 'includesString',
    state: {
      globalFilter: search,
      sorting,
    },
    onSortingChange: setSorting,
  })

  const visibleRows = table.getRowModel().rows
  const handleKeyboardSelect = useCallback(
    (index: number) => {
      const row = visibleRows[index]
      if (row) {
        router.push(`/applications/${row.original.id}`)
      }
    },
    [visibleRows, router],
  )

  const { selectedIndex } = useTableKeyboardNav({
    rowCount: visibleRows.length,
    onSelect: handleKeyboardSelect,
    containerRef,
  })

  if (!applicationsEnabled) return null

  if (error) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-semibold tracking-tight">Applications</h1>
        <p className="text-sm text-destructive">
          Failed to load applications: {error.message}
        </p>
      </div>
    )
  }

  if (isLoading) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-semibold tracking-tight">Applications</h1>
        <div className="space-y-3">
          <Skeleton className="h-8 w-64" />
          <Skeleton className="h-[400px] w-full" />
        </div>
      </div>
    )
  }

  if (applications.length === 0) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-semibold tracking-tight">Applications</h1>
        <EmptyState
          icon={GitBranch}
          title="No applications"
          description="GitOps applications sync agent fleet definitions from a git repository."
        />
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">Applications</h1>
          <Input
            placeholder="Filter by name, repo, or project..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-80"
          />
        </div>
      </div>
      <div ref={containerRef} tabIndex={-1} className="rounded-md border outline-none">
        <Table>
          <TableHeader>
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id}>
                {headerGroup.headers.map((header) => {
                  const canSort = header.column.getCanSort()
                  const sorted = header.column.getIsSorted()
                  return (
                    <TableHead
                      key={header.id}
                      className={canSort ? 'cursor-pointer select-none' : undefined}
                      onClick={canSort ? header.column.getToggleSortingHandler() : undefined}
                    >
                      <div className="flex items-center gap-1">
                        {header.isPlaceholder
                          ? null
                          : flexRender(header.column.columnDef.header, header.getContext())}
                        {canSort && sorted === 'asc' && <ChevronUp className="size-3.5 text-foreground" />}
                        {canSort && sorted === 'desc' && <ChevronDown className="size-3.5 text-foreground" />}
                        {canSort && !sorted && <ChevronDown className="size-3.5 text-muted-foreground/40" />}
                      </div>
                    </TableHead>
                  )
                })}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {visibleRows.length ? (
              visibleRows.map((row, rowIndex) => (
                <TableRow
                  key={row.id}
                  className={cn(
                    'cursor-pointer',
                    rowIndex === selectedIndex && 'bg-muted ring-2 ring-ring ring-inset',
                  )}
                  tabIndex={0}
                  onClick={() => router.push(`/applications/${row.original.id}`)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') router.push(`/applications/${row.original.id}`)
                  }}
                >
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id}>
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell colSpan={columns.length} className="h-24 text-center text-muted-foreground">
                  No applications match your filter.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}
