'use client'

import { useState, memo, useMemo } from 'react'
import { ChevronRight, Folder, FolderOpen } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { FolderNode } from '@/domain/folder-tree'
import { Badge } from '@/components/ui/badge'

const TreeNode = memo(function TreeNode({
  node,
  selectedPath,
  onSelect,
  depth = 0,
}: {
  node: FolderNode
  selectedPath: string | null
  onSelect: (path: string | null) => void
  depth?: number
}) {
  const [expanded, setExpanded] = useState(true)
  const hasChildren = node.children.length > 0
  const isSelected = selectedPath === node.path
  const FolderIcon = expanded && hasChildren ? FolderOpen : Folder

  const totalCount = useMemo(() => countDescendants(node), [node])

  return (
    <div>
      <button
        type="button"
        className={cn(
          'flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-sm hover:bg-muted',
          isSelected && 'bg-muted font-medium',
        )}
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
        onClick={() => {
          if (isSelected) {
            onSelect(null)
          } else {
            onSelect(node.path)
          }
        }}
      >
        {hasChildren ? (
          <ChevronRight
            className={cn('size-3.5 shrink-0 transition-transform', expanded && 'rotate-90')}
            onClick={(e) => {
              e.stopPropagation()
              setExpanded((prev) => !prev)
            }}
          />
        ) : (
          <span className="w-3.5" />
        )}
        <FolderIcon className="size-4 shrink-0 text-muted-foreground" />
        <span className="truncate">{node.name}</span>
        <Badge variant="secondary" className="ml-auto shrink-0 text-xs">
          {totalCount}
        </Badge>
      </button>
      {expanded && hasChildren && (
        <div>
          {node.children.map((child) => (
            <TreeNode
              key={child.path}
              node={child}
              selectedPath={selectedPath}
              onSelect={onSelect}
              depth={depth + 1}
            />
          ))}
        </div>
      )}
    </div>
  )
})

function countDescendants(node: FolderNode): number {
  let total = node.sessionCount
  for (const child of node.children) {
    total += countDescendants(child)
  }
  return total
}

export function FolderTreePanel({
  tree,
  selectedPath,
  onSelect,
}: {
  tree: FolderNode[]
  selectedPath: string | null
  onSelect: (path: string | null) => void
}) {
  if (tree.length === 0) return null

  return (
    <div className="w-56 shrink-0 rounded-md border p-2">
      <p className="mb-1 px-2 text-xs font-medium text-muted-foreground">Folders</p>
      {tree.map((node) => (
        <TreeNode
          key={node.path}
          node={node}
          selectedPath={selectedPath}
          onSelect={onSelect}
        />
      ))}
    </div>
  )
}
