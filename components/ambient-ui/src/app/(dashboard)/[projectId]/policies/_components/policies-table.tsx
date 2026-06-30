'use client'

import { useState, useRef, useCallback } from 'react'
import { useRouter, useParams } from 'next/navigation'
import {
  useReactTable,
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  createColumnHelper,
  flexRender,
} from '@tanstack/react-table'
import type { SortingState } from '@tanstack/react-table'
import { ChevronUp, ChevronDown } from 'lucide-react'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import type { DomainPolicy } from '@/domain/types'
import { formatRelativeTime } from '@/lib/format-timestamp'
import { useTableKeyboardNav } from '@/hooks/use-table-keyboard-nav'
import { cn } from '@/lib/utils'
import { LifecycleBadge } from '../../agents/_components/lifecycle-badge'

const col = createColumnHelper<DomainPolicy>()

const policyColumns = [
  col.accessor('name', {
    header: 'Name',
    cell: (info) => <span className="font-medium">{info.getValue()}</span>,
  }),
  col.display({
    id: 'source',
    header: 'Source',
    cell: () => <LifecycleBadge lifecycle="gitops" />,
  }),
  col.display({
    id: 'sections',
    header: 'Sections',
    cell: ({ row }) => (
      <span className="text-sm text-muted-foreground">
        {Object.keys(row.original.spec).join(', ') || '—'}
      </span>
    ),
  }),
  col.accessor('updatedAt', {
    id: 'lastUpdated',
    header: 'Last Updated',
    sortingFn: (rowA, rowB) =>
      new Date(rowA.original.updatedAt).getTime() -
      new Date(rowB.original.updatedAt).getTime(),
    cell: ({ row }) => (
      <span className="text-muted-foreground text-xs">
        {row.original.updatedAt
          ? formatRelativeTime(row.original.updatedAt)
          : '—'}
      </span>
    ),
  }),
]

export function PoliciesTable({
  policies,
  searchFilter,
}: {
  policies: DomainPolicy[]
  searchFilter: string
}) {
  const router = useRouter()
  const { projectId } = useParams<{ projectId: string }>()
  const containerRef = useRef<HTMLDivElement>(null)
  const [sorting, setSorting] = useState<SortingState>([
    { id: 'lastUpdated', desc: true },
  ])

  const table = useReactTable({
    data: policies,
    columns: policyColumns,
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getSortedRowModel: getSortedRowModel(),
    globalFilterFn: 'includesString',
    state: {
      globalFilter: searchFilter,
      sorting,
    },
    onSortingChange: setSorting,
  })

  const visibleRows = table.getRowModel().rows

  const navigateToPolicy = useCallback(
    (policy: DomainPolicy) => {
      router.push(`/${projectId}/policies/${policy.id}`)
    },
    [router, projectId],
  )

  const handleKeyboardSelect = useCallback(
    (index: number) => {
      const row = visibleRows[index]
      if (row) {
        navigateToPolicy(row.original)
      }
    },
    [visibleRows, navigateToPolicy],
  )

  const { selectedIndex } = useTableKeyboardNav({
    rowCount: visibleRows.length,
    onSelect: handleKeyboardSelect,
    containerRef,
  })

  return (
    <div
      ref={containerRef}
      tabIndex={-1}
      className="rounded-md border outline-none"
    >
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
                    className={
                      canSort ? 'cursor-pointer select-none' : undefined
                    }
                    onClick={
                      canSort
                        ? header.column.getToggleSortingHandler()
                        : undefined
                    }
                  >
                    <div className="flex items-center gap-1">
                      {header.isPlaceholder
                        ? null
                        : flexRender(
                            header.column.columnDef.header,
                            header.getContext(),
                          )}
                      {canSort && sorted === 'asc' && (
                        <ChevronUp className="size-3.5 text-foreground" />
                      )}
                      {canSort && sorted === 'desc' && (
                        <ChevronDown className="size-3.5 text-foreground" />
                      )}
                      {canSort && !sorted && (
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
                  rowIndex === selectedIndex &&
                    'bg-muted ring-2 ring-ring ring-inset',
                )}
                tabIndex={0}
                data-state={
                  rowIndex === selectedIndex ? 'selected' : undefined
                }
                onClick={() => navigateToPolicy(row.original)}
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
              <TableCell
                colSpan={policyColumns.length}
                className="h-24 text-center text-muted-foreground"
              >
                No policies match your filter.
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  )
}
