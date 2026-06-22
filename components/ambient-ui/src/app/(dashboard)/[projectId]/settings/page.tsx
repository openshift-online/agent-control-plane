'use client'

import { useCallback, useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import { AlertCircle, Loader2 } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'

import { useProject, usePatchProject } from '@/queries/use-projects'
import { useAllRoleBindings } from '@/queries/use-role-bindings'
import { useRoles } from '@/queries/use-roles'
import { useCurrentUser } from '@/hooks/use-current-user'
import { useWorkspaceFlag } from '@/services/queries/use-feature-flags-admin'
import { CollaboratorManager } from '../_components/collaborator-manager'
import { RoleName, canEditProject } from '@/domain/roles'
import type { DomainRoleBinding } from '@/domain/types'

// ---------------------------------------------------------------------------
// Hook: resolve current user's role name from bindings + roles
// ---------------------------------------------------------------------------

function useCurrentUserRoleName(
  currentUsername: string | null,
  bindings: DomainRoleBinding[],
): { roleName: string | null; isLoading: boolean } {
  const { data: rolesData, isLoading: rolesLoading } = useRoles({ size: 100 })

  if (rolesLoading || !rolesData) {
    return { roleName: null, isLoading: true }
  }

  if (!currentUsername) {
    return { roleName: null, isLoading: false }
  }

  const userBinding = bindings.find((b) => b.userId === currentUsername)
  if (!userBinding) {
    return { roleName: null, isLoading: false }
  }

  const role = rolesData.items.find((r) => r.id === userBinding.roleId)
  return { roleName: role?.name ?? null, isLoading: false }
}

// ---------------------------------------------------------------------------
// Loading skeletons
// ---------------------------------------------------------------------------

function GeneralTabSkeleton() {
  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-10 w-full max-w-md" />
      </div>
      <div className="space-y-2">
        <Skeleton className="h-4 w-28" />
        <Skeleton className="h-24 w-full max-w-md" />
      </div>
      <Skeleton className="h-9 w-16" />
    </div>
  )
}

function MembersTabSkeleton() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-10 w-full" />
      <div className="space-y-2">
        {[1, 2, 3].map((i) => (
          <div key={i} className="flex items-center gap-3 px-2 py-2">
            <Skeleton className="size-8 rounded-full" />
            <div className="flex-1 space-y-1">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-3 w-24" />
            </div>
            <Skeleton className="h-8 w-[110px]" />
          </div>
        ))}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Error banner
// ---------------------------------------------------------------------------

function ErrorBanner({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex items-center gap-3 rounded-md border border-destructive/50 bg-destructive/5 p-4">
      <AlertCircle className="size-5 shrink-0 text-destructive" />
      <div className="flex-1">
        <p className="text-sm text-destructive">{message}</p>
      </div>
      <Button variant="outline" size="sm" onClick={onRetry}>
        Retry
      </Button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// General tab
// ---------------------------------------------------------------------------

function GeneralTab({
  projectId,
  currentUserRole,
}: {
  projectId: string
  currentUserRole: string | null
}) {
  const { data: project, isLoading, error, refetch } = useProject(projectId)
  const patchProject = usePatchProject()

  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [isDirty, setIsDirty] = useState(false)

  useEffect(() => {
    if (project) {
      setName(project.name)
      setDescription(project.description ?? '')
      setIsDirty(false)
    }
  }, [project])

  const handleNameChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setName(e.target.value)
    setIsDirty(true)
  }, [])

  const handleDescriptionChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setDescription(e.target.value)
    setIsDirty(true)
  }, [])

  const handleSave = useCallback(() => {
    if (!project) return

    const input: { name?: string; description?: string } = {}
    if (name !== project.name) input.name = name
    if (description !== (project.description ?? '')) input.description = description

    if (Object.keys(input).length === 0) return

    patchProject.mutate(
      { projectId, input },
      {
        onSuccess: () => {
          toast.success('Project settings saved')
          setIsDirty(false)
        },
        onError: (err) => {
          toast.error(err instanceof Error ? err.message : 'Failed to save project settings')
        },
      },
    )
  }, [project, projectId, name, description, patchProject])

  if (isLoading) {
    return <GeneralTabSkeleton />
  }

  if (error) {
    return (
      <ErrorBanner
        message="Failed to load project details."
        onRetry={() => { refetch() }}
      />
    )
  }

  const readOnly = !canEditProject(currentUserRole)

  return (
    <div className="space-y-6 max-w-md">
      <div className="space-y-2">
        <label htmlFor="project-name" className="text-sm font-medium leading-none">
          Project name
        </label>
        <Input
          id="project-name"
          value={name}
          onChange={handleNameChange}
          readOnly={readOnly}
          disabled={readOnly}
          placeholder="Project name"
        />
      </div>

      <div className="space-y-2">
        <label htmlFor="project-description" className="text-sm font-medium leading-none">
          Description
        </label>
        <Textarea
          id="project-description"
          value={description}
          onChange={handleDescriptionChange}
          readOnly={readOnly}
          disabled={readOnly}
          placeholder="Describe this project..."
          rows={4}
        />
      </div>

      {!readOnly && (
        <Button
          onClick={handleSave}
          disabled={!isDirty || patchProject.isPending}
        >
          {patchProject.isPending && (
            <Loader2 className="mr-2 size-4 animate-spin" />
          )}
          Save
        </Button>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// General tab with role resolution
// ---------------------------------------------------------------------------

function GeneralTabWithRole({
  projectId,
  currentUsername,
  bindings,
}: {
  projectId: string
  currentUsername: string | null
  bindings: DomainRoleBinding[]
}) {
  const { roleName, isLoading } = useCurrentUserRoleName(currentUsername, bindings)

  if (isLoading) {
    return <GeneralTabSkeleton />
  }

  return <GeneralTab projectId={projectId} currentUserRole={roleName} />
}

// ---------------------------------------------------------------------------
// Members tab with role resolution
// ---------------------------------------------------------------------------

function MembersTabWithRole({
  projectId,
  currentUsername,
  bindings,
}: {
  projectId: string
  currentUsername: string | null
  bindings: DomainRoleBinding[]
}) {
  const { roleName, isLoading } = useCurrentUserRoleName(currentUsername, bindings)

  if (isLoading) {
    return <MembersTabSkeleton />
  }

  const readOnly = roleName === RoleName.ProjectViewer || roleName === null

  return (
    <CollaboratorManager
      projectId={projectId}
      currentUserRole={roleName}
      readOnly={readOnly}
    />
  )
}

// ---------------------------------------------------------------------------
// Settings page (feature-flag gated)
// ---------------------------------------------------------------------------

export default function ProjectSettingsPage() {
  const { projectId } = useParams<{ projectId: string }>()
  const { user: currentUser } = useCurrentUser()
  const { enabled: sharingEnabled } = useWorkspaceFlag(projectId, 'feature.project-sharing.enabled')

  const bindingsSearch = `scope = 'project' and project_id = '${projectId}'`
  const {
    data: bindings,
    isLoading: bindingsLoading,
    error: bindingsError,
    refetch: refetchBindings,
  } = useAllRoleBindings(bindingsSearch)

  if (!sharingEnabled) {
    return null
  }

  if (bindingsError) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <ErrorBanner
          message="Failed to load project settings."
          onRetry={() => { refetchBindings() }}
        />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>

      <Tabs defaultValue="general">
        <TabsList>
          <TabsTrigger value="general">General</TabsTrigger>
          <TabsTrigger value="members">Members</TabsTrigger>
        </TabsList>

        <TabsContent value="general" className="mt-6">
          {bindingsLoading ? (
            <GeneralTabSkeleton />
          ) : (
            <GeneralTabWithRole
              projectId={projectId}
              currentUsername={currentUser?.username ?? null}
              bindings={bindings ?? []}
            />
          )}
        </TabsContent>

        <TabsContent value="members" className="mt-6">
          {bindingsLoading ? (
            <MembersTabSkeleton />
          ) : (
            <MembersTabWithRole
              projectId={projectId}
              currentUsername={currentUser?.username ?? null}
              bindings={bindings ?? []}
            />
          )}
        </TabsContent>
      </Tabs>
    </div>
  )
}
