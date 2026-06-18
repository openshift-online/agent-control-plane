'use client'

import { useRouter } from 'next/navigation'
import { FolderOpen } from 'lucide-react'
import { useProjects } from '@/queries/use-projects'
import { domainProbe } from '@/lib/observability'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'

type ProjectSelectorProps = {
  projectId: string | null
  effectiveProjectId: string | null
}

export function ProjectSelector({ projectId, effectiveProjectId }: ProjectSelectorProps) {
  const router = useRouter()
  const { data, isLoading } = useProjects()

  if (isLoading) {
    return <Skeleton className="h-9 w-full" />
  }

  const projects = data?.items ?? []

  return (
    <Select
      value={effectiveProjectId ?? undefined}
      onValueChange={(value) => {
        domainProbe.projectSelected({ projectId: value })
        router.push(`/${value}`)
      }}
    >
      <SelectTrigger className="w-full" aria-label="Select project">
        <div className="flex items-center gap-2">
          <FolderOpen aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
          <SelectValue placeholder="Select project..." />
        </div>
      </SelectTrigger>
      <SelectContent>
        {projects.map((project) => (
          <SelectItem key={project.id} value={project.id}>
            {project.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
