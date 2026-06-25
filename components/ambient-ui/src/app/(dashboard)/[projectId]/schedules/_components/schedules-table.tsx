'use client'

import { useState } from 'react'
import {
  useReactTable,
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  flexRender,
  type SortingState,
} from '@tanstack/react-table'
import { ArrowUpDown, MoreHorizontal, Play, Pause, PlayCircle, Trash2, Pencil, List } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import type { DomainScheduledSession } from '@/domain/types'
import { schedulesColumns } from './schedules-columns'

type SchedulesTableProps = {
  schedules: DomainScheduledSession[]
  searchFilter: string
  onEdit: (schedule: DomainScheduledSession) => void
  onDelete: (id: string) => void
  onSuspend: (id: string) => void
  onResume: (id: string) => void
  onTrigger: (id: string) => void
  onViewRuns: (schedule: DomainScheduledSession) => void
}

export function SchedulesTable({
  schedules,
  searchFilter,
  onEdit,
  onDelete,
  onSuspend,
  onResume,
  onTrigger,
  onViewRuns,
}: SchedulesTableProps) {
  const [sorting, setSorting] = useState<SortingState>([])
  const [deleteTarget, setDeleteTarget] = useState<DomainScheduledSession | null>(null)

  const table = useReactTable({
    data: schedules,
    columns: [
      ...schedulesColumns,
      {
        id: 'actions',
        header: '',
        cell: ({ row }) => {
          const schedule = row.original
          return (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="h-8 w-8" onClick={e => e.stopPropagation()}>
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => onEdit(schedule)}>
                  <Pencil className="mr-2 h-4 w-4" />
                  Edit
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => onTrigger(schedule.id)}>
                  <PlayCircle className="mr-2 h-4 w-4" />
                  Trigger Now
                </DropdownMenuItem>
                {schedule.enabled ? (
                  <DropdownMenuItem onClick={() => onSuspend(schedule.id)}>
                    <Pause className="mr-2 h-4 w-4" />
                    Suspend
                  </DropdownMenuItem>
                ) : (
                  <DropdownMenuItem onClick={() => onResume(schedule.id)}>
                    <Play className="mr-2 h-4 w-4" />
                    Resume
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem onClick={() => onViewRuns(schedule)}>
                  <List className="mr-2 h-4 w-4" />
                  View Runs
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  className="text-destructive"
                  onClick={() => setDeleteTarget(schedule)}
                >
                  <Trash2 className="mr-2 h-4 w-4" />
                  Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )
        },
      },
    ],
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getSortedRowModel: getSortedRowModel(),
    globalFilterFn: 'includesString',
    state: { globalFilter: searchFilter, sorting },
    onSortingChange: setSorting,
  })

  return (
    <>
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            {table.getHeaderGroups().map(headerGroup => (
              <TableRow key={headerGroup.id}>
                {headerGroup.headers.map(header => {
                  const canSort = header.column.getCanSort()
                  return (
                    <TableHead
                      key={header.id}
                      className={canSort ? 'cursor-pointer select-none' : undefined}
                      onClick={canSort ? header.column.getToggleSortingHandler() : undefined}
                    >
                      <div className="flex items-center gap-1">
                        {flexRender(header.column.columnDef.header, header.getContext())}
                        {canSort && <ArrowUpDown className="h-3 w-3 text-muted-foreground" />}
                      </div>
                    </TableHead>
                  )
                })}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {table.getRowModel().rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={table.getAllColumns().length} className="h-24 text-center text-muted-foreground">
                  No schedules match your filter.
                </TableCell>
              </TableRow>
            ) : (
              table.getRowModel().rows.map(row => (
                <TableRow key={row.id}>
                  {row.getVisibleCells().map(cell => (
                    <TableCell key={cell.id}>
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <AlertDialog open={!!deleteTarget} onOpenChange={open => { if (!open) setDeleteTarget(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete schedule?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete &quot;{deleteTarget?.name}&quot;. Running sessions created by this schedule will not be affected.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                if (deleteTarget) onDelete(deleteTarget.id)
                setDeleteTarget(null)
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
