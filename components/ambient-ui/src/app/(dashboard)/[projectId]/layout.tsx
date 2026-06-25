'use client'

import { useParams } from 'next/navigation'
import { FolderX } from 'lucide-react'
import { useProject } from '@/queries/use-projects'
import { Skeleton } from '@/components/ui/skeleton'

export default function ProjectLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const { projectId } = useParams<{ projectId: string }>()
  const { data, isLoading, error } = useProject(projectId)

  if (isLoading) {
    return (
      <div className="space-y-6 p-6">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-48 w-full" />
      </div>
    )
  }

  if (error || !data) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 py-24 text-center">
        <FolderX className="size-12 text-muted-foreground" />
        <h2 className="text-xl font-semibold">Project not found</h2>
        <p className="text-sm text-muted-foreground">
          No project with ID &ldquo;{projectId}&rdquo; exists. Select a project from the sidebar.
        </p>
      </div>
    )
  }

  return <>{children}</>
}
