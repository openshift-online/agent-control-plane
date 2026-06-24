'use client'

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { FolderOpen, Users, Search, Activity, MoreHorizontal, Pencil, Trash2, Settings } from 'lucide-react'
import { useProjects, usePatchProject, useDeleteProject } from '@/queries/use-projects'
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
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
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
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { EmptyState } from '@/components/empty-state'
import type { DomainProject, DomainRoleBinding, SessionPhase } from '@/domain/types'
import type { DomainRole } from '@/ports/roles'
import { RoleName, getDisplayRole } from '@/domain/roles'

type RoleVariant = 'default' | 'secondary' | 'outline'

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
  const router = useRouter()
  const { data: sessionsData } = useSessions(project.id)
  const sessions = sessionsData?.items ?? []
  const patchProject = usePatchProject()
  const deleteProject = useDeleteProject()

  const [showRename, setShowRename] = useState(false)
  const [showDelete, setShowDelete] = useState(false)
  const [renameValue, setRenameValue] = useState(project.name)

  const userBinding = bindings?.find((b) => b.userId === currentUsername)
  const role = userBinding ? roleMap.get(userBinding.roleId) : undefined
  const roleDisplay = role ? getRoleBadge(role.name) : null
  const isOwner = role?.name === RoleName.ProjectOwner

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
    return sessions.reduce((latest, s) =>
      s.updatedAt > latest ? s.updatedAt : latest,
      sessions[0].updatedAt,
    )
  }, [sessions])

  return (
    <>
      <Card
        className="group/card relative flex cursor-pointer flex-col transition-all duration-150 hover:shadow-md hover:border-primary/30 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
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
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="absolute right-2 top-2 z-10 h-7 w-7 text-muted-foreground opacity-0 transition-opacity hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100 group-hover/card:opacity-100"
                onClick={(e) => e.stopPropagation()}
                aria-label="Project actions"
              >
                <MoreHorizontal className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
              <DropdownMenuItem onClick={() => router.push(`/${project.id}/settings`)}>
                <Settings className="mr-2 size-4" />
                Settings
              </DropdownMenuItem>
              {isOwner && (
                <>
                  <DropdownMenuItem onClick={() => { setRenameValue(project.name); setShowRename(true) }}>
                    <Pencil className="mr-2 size-4" />
                    Rename
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    className="text-destructive focus:text-destructive"
                    onClick={() => setShowDelete(true)}
                  >
                    <Trash2 className="mr-2 size-4" />
                    Delete
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        <CardHeader>
            <div className="flex items-center gap-2 pr-8">
              <CardTitle className="truncate">{project.name}</CardTitle>
              {!bindingsLoaded && <Skeleton className="h-5 w-14" />}
              {bindingsLoaded && roleDisplay && (
                <Badge variant={roleDisplay.variant} className="shrink-0 text-xs px-2 py-0.5">
                  {roleDisplay.label}
                </Badge>
              )}
            </div>
            <CardDescription className="line-clamp-1">
              {project.description || ' '}
            </CardDescription>
        </CardHeader>

        <CardContent className="mt-auto">
          <div className="flex min-h-[24px] items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              {needsAttentionCount > 0 && (
                <Badge variant="destructive" className="text-[0.6875rem] px-1.5 py-0">
                  {needsAttentionCount} need{needsAttentionCount === 1 ? 's' : ''} attention
                </Badge>
              )}
              {runningCount > 0 && (
                <span className="inline-flex items-center gap-1">
                  <span className="inline-block h-1.5 w-1.5 rounded-full bg-green-500" />
                  {runningCount} running
                </span>
              )}
              {lastActivity && (
                <span>{formatRelativeTime(lastActivity)}</span>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              {bindingsLoaded && isShared && (
                <>
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
                </>
              )}
              {!bindingsLoaded && <Skeleton className="h-5 w-12 rounded-full" />}
            </div>
          </div>
        </CardContent>
      </Card>

      <Dialog open={showRename} onOpenChange={setShowRename}>
        <DialogContent className="sm:max-w-sm" onClick={(e) => e.stopPropagation()}>
          <DialogHeader>
            <DialogTitle>Rename project</DialogTitle>
          </DialogHeader>
          <Input
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            placeholder="Project name"
            autoFocus
            onKeyDown={(e) => {
              if (e.key === 'Enter' && renameValue.trim()) {
                patchProject.mutate({ projectId: project.id, input: { name: renameValue.trim() } })
                setShowRename(false)
              }
            }}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowRename(false)}>Cancel</Button>
            <Button
              disabled={!renameValue.trim() || renameValue.trim() === project.name}
              onClick={() => {
                patchProject.mutate({ projectId: project.id, input: { name: renameValue.trim() } })
                setShowRename(false)
              }}
            >
              Rename
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={showDelete} onOpenChange={setShowDelete}>
        <AlertDialogContent onClick={(e) => e.stopPropagation()}>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete &ldquo;{project.name}&rdquo;?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete the project and all its sessions, agents, and settings. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => deleteProject.mutate(project.id)}
            >
              Delete project
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
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
