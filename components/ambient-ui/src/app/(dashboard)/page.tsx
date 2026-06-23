'use client'

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { FolderOpen, Users, Search, Activity } from 'lucide-react'
import { useProjects } from '@/queries/use-projects'
import { useSessions } from '@/queries/use-sessions'
import { useAllRoleBindings } from '@/queries/use-role-bindings'
import { useRoles } from '@/queries/use-roles'
import { useCurrentUser } from '@/hooks/use-current-user'
import { getNeedsYouItems } from '@/domain/work-annotations'
import { formatRelativeTime } from '@/lib/format-timestamp'
import { CreateProjectDialog } from './_components/create-project-dialog'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState } from '@/components/empty-state'
import type { DomainProject, DomainRoleBinding, SessionPhase } from '@/domain/types'
import type { DomainRole } from '@/ports/roles'
import { RoleName, getDisplayRole } from '@/domain/roles'

type RoleVariant = 'default' | 'secondary' | 'outline'

const BORDER_COLORS = [
  '#37a3a3', // teal-50
  '#5e40be', // purple-50
  '#f5921b', // orange-40
  '#0066cc', // interaction-blue-50
  '#63993d', // success-green-50
] as const

function getProjectBorderColor(name: string): string {
  const hash = name.split('').reduce((a, c) => a + c.charCodeAt(0), 0) % 5
  return BORDER_COLORS[hash]
}

const RUNNING_PHASES: ReadonlySet<SessionPhase> = new Set([
  'Running',
  'Creating',
  'Pending',
])

function getRoleBadge(roleName: string): { label: string; variant: RoleVariant } {
  const label = getDisplayRole(roleName)
  switch (roleName) {
    case RoleName.ProjectOwner:
      return { label, variant: 'default' }
    case RoleName.ProjectEditor:
      return { label, variant: 'secondary' }
    default:
      return { label, variant: 'outline' }
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
  const { data: sessionsData } = useSessions(project.id)
  const sessions = sessionsData?.items ?? []

  const userBinding = bindings?.find((b) => b.userId === currentUsername)
  const role = userBinding ? roleMap.get(userBinding.roleId) : undefined
  const roleDisplay = role ? getRoleBadge(role.name) : null

  const isShared = (bindings?.length ?? 0) > 1
  const collaborators = bindings
    ?.filter((b) => b.userId !== currentUsername && b.userId !== null)
    .slice(0, 3) ?? []

  const needsAttentionCount = useMemo(
    () => getNeedsYouItems(sessions).length,
    [sessions],
  )

  const runningCount = useMemo(
    () => sessions.filter((s) => RUNNING_PHASES.has(s.phase)).length,
    [sessions],
  )

  const lastActivity = useMemo(() => {
    if (sessions.length === 0) return null
    const mostRecent = sessions.reduce((latest, s) =>
      s.updatedAt > latest ? s.updatedAt : latest,
      sessions[0].updatedAt,
    )
    return mostRecent
  }, [sessions])

  const borderColor = getProjectBorderColor(project.name)

  return (
    <Card
      className="cursor-pointer border-l-4 transition-all duration-150 hover:shadow-md hover:border-primary/30 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      style={{ borderLeftColor: borderColor }}
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
        <div className="flex items-center gap-2">
          <CardTitle>{project.name}</CardTitle>
          {!bindingsLoaded && (
            <Skeleton className="h-5 w-14" />
          )}
          {bindingsLoaded && roleDisplay && (
            <Badge variant={roleDisplay.variant} className="text-xs px-2 py-0.5">
              {roleDisplay.label}
            </Badge>
          )}
        </div>
        {project.description && (
          <CardDescription>{project.description}</CardDescription>
        )}
      </CardHeader>
      <CardContent>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            {needsAttentionCount > 0 && (
              <Badge variant="destructive" className="text-xs px-2 py-0.5">
                {needsAttentionCount} need{needsAttentionCount === 1 ? 's' : ''} attention
              </Badge>
            )}
            {runningCount > 0 && (
              <span className="inline-flex items-center gap-1">
                <Activity className="h-3 w-3 text-green-500" />
                {runningCount} running
              </span>
            )}
            {lastActivity && (
              <span>Last active {formatRelativeTime(lastActivity)}</span>
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
  const [searchQuery, setSearchQuery] = useState('')

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
          description="Create your first project to start running agent sessions."
          action={<CreateProjectDialog />}
        />
      </div>
    )
  }

  const filteredProjects = searchQuery
    ? projects.filter((p) =>
        p.name.toLowerCase().includes(searchQuery.toLowerCase()),
      )
    : projects

  const gridCols =
    projects.length >= 6 ? 'lg:grid-cols-3' : 'lg:grid-cols-2'

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">
          Projects ({projects.length})
        </h1>
        <CreateProjectDialog />
      </div>
      {projects.length > 6 && (
        <div className="relative max-w-sm">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search projects..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9"
          />
        </div>
      )}
      <div className={`grid gap-4 sm:grid-cols-2 ${gridCols}`}>
        {filteredProjects.map((project) => (
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
