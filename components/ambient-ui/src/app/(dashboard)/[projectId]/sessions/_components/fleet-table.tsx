'use client'

import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { useRouter, useParams } from 'next/navigation'
import {
  useReactTable,
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  flexRender,
} from '@tanstack/react-table'
import type { SortingState, ColumnFiltersState, RowSelectionState } from '@tanstack/react-table'
import { ChevronUp, ChevronDown, ChevronLeft, ChevronRight } from 'lucide-react'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Button } from '@/components/ui/button'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { DomainSession } from '@/domain/types'
import { sessionMatchesPath } from '@/domain/folder-tree'
import { useTableKeyboardNav } from '@/hooks/use-table-keyboard-nav'
import { cn } from '@/lib/utils'
import { fleetColumns } from './fleet-columns'
import type { FleetTableMeta } from './fleet-columns'
import { BulkActionBar } from './bulk-action-bar'

const TEST_SESSION_ANNOTATION = 'ambient-code.io/ui/test-session'

export function FleetTable({
  sessions,
  searchFilter,
  agentNames,
  showTestRuns = false,
  pathFilter,
  onFilteredCountChange,
  currentPage,
  totalPages,
  pageSize,
  serverTotal,
  onPageChange,
}: {
  sessions: DomainSession[]
  searchFilter: string
  agentNames?: Map<string, string>
  showTestRuns?: boolean
  pathFilter?: string | null
  onFilteredCountChange?: (count: number) => void
  currentPage?: number
  totalPages?: number
  pageSize?: number
  serverTotal?: number
  onPageChange?: (page: number) => void
}) {
  const router = useRouter()
  const { projectId } = useParams<{ projectId: string }>()
  const containerRef = useRef<HTMLDivElement>(null)

  const [sorting, setSorting] = useState<SortingState>([
    { id: 'phase', desc: false },
    { id: 'lastActivity', desc: true },
  ])

  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([])
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({})
  const [useAbsoluteTime, setUseAbsoluteTime] = useState(false)

  const filteredSessions = useMemo(() => {
    let result = sessions
    if (!showTestRuns) {
      result = result.filter(
        (s) => s.annotations[TEST_SESSION_ANNOTATION] !== 'true',
      )
    }
    if (pathFilter) {
      result = result.filter((s) => sessionMatchesPath(s, pathFilter))
    }
    return result
  }, [sessions, showTestRuns, pathFilter])

  const handleToggleTimeFormat = useCallback(() => {
    setUseAbsoluteTime(prev => !prev)
  }, [])

  const tableMeta: FleetTableMeta = {
    agentNames,
    useAbsoluteTime,
    onToggleTimeFormat: handleToggleTimeFormat,
  }

  const table = useReactTable({
    data: filteredSessions,
    columns: fleetColumns,
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getSortedRowModel: getSortedRowModel(),
    globalFilterFn: 'includesString',
    enableRowSelection: true,
    state: {
      globalFilter: searchFilter,
      sorting,
      columnFilters,
      rowSelection,
    },
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    onRowSelectionChange: setRowSelection,
    meta: tableMeta,
    filterFns: {},
  })

  // Report filtered count back to parent
  const filteredRowCount = table.getFilteredRowModel().rows.length
  useEffect(() => {
    onFilteredCountChange?.(filteredRowCount)
  }, [filteredRowCount, onFilteredCountChange])

  // Clear selection when data changes (e.g., after bulk stop/delete)
  useEffect(() => {
    setRowSelection({})
  }, [filteredSessions.length])

  const visibleRows = table.getRowModel().rows
  const handleKeyboardSelect = useCallback(
    (index: number) => {
      const row = visibleRows[index]
      if (row) {
        router.push(`/${projectId}/sessions/${row.original.id}`)
      }
    },
    [visibleRows, router, projectId],
  )

  const { selectedIndex } = useTableKeyboardNav({
    rowCount: visibleRows.length,
    onSelect: handleKeyboardSelect,
    containerRef,
  })

  const selectedRows = table.getSelectedRowModel().rows
  const selectedSessions = selectedRows.map(row => row.original)

  const handleClearSelection = useCallback(() => {
    setRowSelection({})
  }, [])

  return (
    <TooltipProvider delayDuration={300}>
      {selectedSessions.length > 0 && (
        <BulkActionBar
          selectedSessions={selectedSessions}
          onClearSelection={handleClearSelection}
        />
      )}
    <div ref={containerRef} tabIndex={-1} className="rounded-md border outline-none">
      <Table>
        <TableHeader>
          {table.getHeaderGroups().map(headerGroup => (
            <TableRow key={headerGroup.id}>
              {headerGroup.headers.map(header => {
                const canSort = header.column.getCanSort()
                const sorted = header.column.getIsSorted()
                const isChat = header.column.id === 'chat'
                const isSelect = header.column.id === 'select'

                return (
                  <TableHead
                    key={header.id}
                    {...(isChat ? { 'data-sticky': 'right' } : {})}
                    className={canSort && !isSelect ? 'cursor-pointer select-none' : undefined}
                    onClick={canSort && !isSelect ? header.column.getToggleSortingHandler() : undefined}
                    style={header.column.columnDef.size ? { width: header.column.columnDef.size } : undefined}
                  >
                    <div className="flex items-center gap-1">
                      {header.isPlaceholder
                        ? null
                        : flexRender(header.column.columnDef.header, header.getContext())}
                      {canSort && !isSelect && sorted === 'asc' && (
                        <ChevronUp className="size-3.5 text-foreground" />
                      )}
                      {canSort && !isSelect && sorted === 'desc' && (
                        <ChevronDown className="size-3.5 text-foreground" />
                      )}
                      {canSort && !isSelect && !sorted && (
                        <ChevronDown className="size-3.5 text-muted-foreground/40" />
                      )}
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
                  'cursor-pointer group',
                  rowIndex === selectedIndex && 'bg-muted ring-2 ring-ring ring-inset',
                )}
                tabIndex={0}
                data-state={
                  row.getIsSelected()
                    ? 'selected'
                    : rowIndex === selectedIndex
                      ? 'selected'
                      : undefined
                }
                onClick={() => router.push(`/${projectId}/sessions/${row.original.id}`)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    router.push(`/${projectId}/sessions/${row.original.id}`)
                  }
                }}
              >
                {row.getVisibleCells().map(cell => {
                  const isChat = cell.column.id === 'chat'
                  return (
                    <TableCell
                      key={cell.id}
                      {...(isChat ? { 'data-sticky': 'right' } : {})}
                    >
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  )
                })}
              </TableRow>
            ))
          ) : (
            <TableRow>
              <TableCell colSpan={fleetColumns.length} className="h-24 text-center text-muted-foreground">
                No sessions match your filter.
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
    {currentPage != null && totalPages != null && totalPages > 1 && onPageChange && (
      <div className="flex items-center justify-between px-2 py-3">
        <p className="text-sm text-muted-foreground">
          Showing {((currentPage - 1) * (pageSize ?? 20)) + 1}–{Math.min(currentPage * (pageSize ?? 20), serverTotal ?? 0)} of {serverTotal} sessions
        </p>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={currentPage <= 1}
            onClick={() => onPageChange(currentPage - 1)}
          >
            <ChevronLeft className="mr-1 size-4" />
            Previous
          </Button>
          <span className="text-sm text-muted-foreground">
            Page {currentPage} of {totalPages}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={currentPage >= totalPages}
            onClick={() => onPageChange(currentPage + 1)}
          >
            Next
            <ChevronRight className="ml-1 size-4" />
          </Button>
        </div>
      </div>
    )}
    </TooltipProvider>
  )
}
