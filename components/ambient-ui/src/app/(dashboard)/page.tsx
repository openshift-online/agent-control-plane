'use client'

import { useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { FolderOpen, Users } from 'lucide-react'
import { useProjects } from '@/queries/use-projects'
import { useAllRoleBindings } from '@/queries/use-role-bindings'
import { useRoles } from '@/queries/use-roles'
import { useCurrentUser } from '@/hooks/use-current-user'
import { CreateProjectDialog } from './_components/create-project-dialog'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState } from '@/components/empty-state'
import type { DomainProject, DomainRoleBinding } from '@/domain/types'
import type { DomainRole } from '@/ports/roles'

type RoleVariant = 'default' | 'secondary' | 'outline'

function getRoleDisplay(roleName: string): { label: string; variant: RoleVariant } {
  const stripped = roleName.replace(/^project:/, '')
  const capitalized = stripped.charAt(0).toUpperCase() + stripped.slice(1)
  switch (stripped) {
    case 'owner':
      return { label: capitalized, variant: 'default' }
    case 'editor':
      return { label: capitalized, variant: 'secondary' }
    case 'viewer':
      return { label: capitalized, variant: 'outline' }
    default:
      return { label: capitalized, variant: 'outline' }
  }
}

function getInitialsFromUserId(userId: string): string {
  const parts = userId.split(/[.\-_@\s]+/).filter(Boolean)
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase()
  }
  return userId.slice(0, 2).toUpperCase()
}

function ProjectCardSkeleton() {
  return (
    <Card>
      <CardHeader>
        <Skeleton className="h-5 w-32" />
        <Skeleton className="h-4 w-48" />
      </CardHeader>
      <CardContent>
        <div className="flex items-center justify-between">
          <Skeleton className="h-5 w-24" />
          <Skeleton className="h-6 w-16 rounded-full" />
        </div>
      </CardContent>
    </Card>
  )
}

type ProjectCardProps = {
  project: DomainProject
  bindings: DomainRoleBinding[] | undefined
  roleMap: Map<string, DomainRole>
  currentUsername: string | null
  bindingsLoaded: boolean
  onClick: () => void
}

function ProjectCard({
  project,
  bindings,
  roleMap,
  currentUsername,
  bindingsLoaded,
  onClick,
}: ProjectCardProps) {
  const userBinding = bindings?.find((b) => b.userId === currentUsername)
  const role = userBinding ? roleMap.get(userBinding.roleId) : undefined
  const roleDisplay = role ? getRoleDisplay(role.name) : null

  const isShared = (bindings?.length ?? 0) > 1
  const collaborators = bindings
    ?.filter((b) => b.userId !== currentUsername && b.userId !== null)
    .slice(0, 3) ?? []

  return (
    <Card
      className="cursor-pointer transition-shadow hover:shadow-md"
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onClick()
        }
      }}
    >
      <CardHeader>
        <CardTitle>{project.name}</CardTitle>
        {project.description && (
          <CardDescription>{project.description}</CardDescription>
        )}
      </CardHeader>
      <CardContent>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <p className="text-xs text-muted-foreground">
              {project.status ?? 'Active'}
            </p>
            {!bindingsLoaded && (
              <Skeleton className="h-5 w-14" />
            )}
            {bindingsLoaded && roleDisplay && (
              <Badge variant={roleDisplay.variant} className="text-[10px] px-1.5 py-0">
                {roleDisplay.label}
              </Badge>
            )}
          </div>
          {bindingsLoaded && isShared && (
            <div className="flex items-center gap-1.5">
              <Users className="h-3.5 w-3.5 text-muted-foreground" />
              <div className="flex -space-x-1.5">
                {collaborators.map((collab) => (
                  <span
                    key={collab.id}
                    className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-muted text-[9px] font-medium ring-1 ring-background"
                    title={collab.userId ?? undefined}
                  >
                    {collab.userId ? getInitialsFromUserId(collab.userId) : '?'}
                  </span>
                ))}
              </div>
            </div>
          )}
          {!bindingsLoaded && (
            <Skeleton className="h-5 w-12 rounded-full" />
          )}
        </div>
      </CardContent>
    </Card>
  )
}

export default function ProjectPickerPage() {
  const router = useRouter()
  const { data, isLoading, isError } = useProjects()
  const { user } = useCurrentUser()
  const { data: allBindings } = useAllRoleBindings("scope = 'project'")
  const { data: rolesData } = useRoles()

  const roleMap = useMemo(() => {
    const map = new Map<string, DomainRole>()
    if (rolesData?.items) {
      for (const role of rolesData.items) {
        map.set(role.id, role)
      }
    }
    return map
  }, [rolesData])

  const bindingsByProject = useMemo(() => {
    const map = new Map<string, DomainRoleBinding[]>()
    if (allBindings) {
      for (const binding of allBindings) {
        if (binding.projectId) {
          const existing = map.get(binding.projectId)
          if (existing) {
            existing.push(binding)
          } else {
            map.set(binding.projectId, [binding])
          }
        }
      }
    }
    return map
  }, [allBindings])

  if (isLoading) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-semibold">Projects</h1>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 3 }, (_, i) => (
            <ProjectCardSkeleton key={i} />
          ))}
        </div>
      </div>
    )
  }

  if (isError) {
    return (
      <EmptyState
        icon={FolderOpen}
        title="Failed to load projects"
        description="Something went wrong while loading your projects. Please try again."
      />
    )
  }

  const projects = data?.items ?? []

  if (projects.length === 0) {
    return (
      <div className="space-y-6">
        <EmptyState
          icon={FolderOpen}
          title="No projects found"
          description="Create a project to get started with ACP."
        />
        <div className="flex justify-center">
          <CreateProjectDialog />
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Projects</h1>
        <CreateProjectDialog />
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {projects.map((project) => (
          <ProjectCard
            key={project.id}
            project={project}
            bindings={bindingsByProject.get(project.id)}
            roleMap={roleMap}
            currentUsername={user?.username ?? null}
            bindingsLoaded={allBindings !== undefined}
            onClick={() => router.push(`/${project.id}`)}
          />
        ))}
      </div>
    </div>
  )
}
