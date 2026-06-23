'use client'

import { useCallback, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useQuery } from '@tanstack/react-query'
import { Loader2, Users } from 'lucide-react'
import { toast } from 'sonner'

import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { Popover, PopoverContent, PopoverAnchor } from '@/components/ui/popover'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
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
import { Skeleton } from '@/components/ui/skeleton'

import { useCurrentUser } from '@/hooks/use-current-user'
import { useUserSearch } from '@/queries/use-users'
import {
  useAllRoleBindings,
  useCreateRoleBinding,
  usePatchRoleBinding,
  useDeleteRoleBinding,
} from '@/queries/use-role-bindings'
import { useRoles } from '@/queries/use-roles'
import { queryKeys } from '@/queries/query-keys'
import type { DomainRoleBinding, DomainUserSearchResult } from '@/domain/types'
import type { DomainRole } from '@/ports/roles'
import { RoleName, getRoleLevel, getDisplayRole } from '@/domain/roles'
import { createUsersAdapter } from '@/adapters/sdk-users'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type CollaboratorManagerProps = {
  projectId: string
  currentUserRole?: string | null
  readOnly?: boolean
}

type ResolvedCollaborator = {
  binding: DomainRoleBinding
  username: string
  name: string
  initials: string
  roleName: string
  roleDisplayName: string
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const AVATAR_COLORS = [
  'bg-red-600', 'bg-blue-600', 'bg-green-600', 'bg-purple-600',
  'bg-orange-600', 'bg-teal-600', 'bg-pink-600', 'bg-indigo-600',
]

function avatarColor(username: string): string {
  let hash = 0
  for (let i = 0; i < username.length; i++) {
    hash = ((hash << 5) - hash + username.charCodeAt(i)) | 0
  }
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length]!
}

function getAssignableRoles(
  currentUserRole: string | null,
  allRoles: DomainRole[],
): DomainRole[] {
  const callerLevel = getRoleLevel(currentUserRole)
  if (callerLevel === 0) return []

  const assignableNames: string[] = []
  if (callerLevel >= getRoleLevel(RoleName.PlatformAdmin)) assignableNames.push(RoleName.ProjectOwner)
  if (callerLevel >= getRoleLevel(RoleName.ProjectOwner)) assignableNames.push(RoleName.ProjectEditor)
  if (callerLevel >= getRoleLevel(RoleName.ProjectEditor)) assignableNames.push(RoleName.ProjectViewer)

  return allRoles.filter((r) => assignableNames.includes(r.name))
}

function getInitials(name: string, username: string): string {
  if (name && name.trim().length > 0) {
    const words = name.trim().split(/\s+/)
    if (words.length >= 2) {
      return (words[0]![0]! + words[words.length - 1]![0]!).toUpperCase()
    }
    return name.trim().slice(0, 2).toUpperCase()
  }
  return username.slice(0, 2).toUpperCase()
}

// ---------------------------------------------------------------------------
// Batch user fetch by username
// ---------------------------------------------------------------------------

function useUsersByUsernames(usernames: string[]) {
  const sortedNames = useMemo(() => [...usernames].sort(), [usernames])
  const key = sortedNames.join(',')

  return useQuery({
    queryKey: [...queryKeys.users.all, 'by-usernames', key],
    queryFn: async () => {
      if (sortedNames.length === 0) return new Map<string, DomainUserSearchResult>()
      const adapter = createUsersAdapter()
      const quoted = sortedNames.map((u) => `'${u}'`).join(',')
      const result = await adapter.list({
        search: `username in (${quoted})`,
        size: 100,
      })
      const map = new Map<string, DomainUserSearchResult>()
      for (const user of result.items) {
        map.set(user.username, user)
      }
      return map
    },
    enabled: sortedNames.length > 0,
    staleTime: 60_000,
  })
}

// ---------------------------------------------------------------------------
// User avatar
// ---------------------------------------------------------------------------

function UserAvatar({ initials, username }: { initials: string; username: string }) {
  return (
    <div className={`flex size-9 shrink-0 items-center justify-center rounded-full text-xs font-medium text-white ${avatarColor(username)}`}>
      {initials}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Search input (Google Drive style)
// ---------------------------------------------------------------------------

function UserSearchInput({
  assignableRoles,
  projectId,
  existingUsernames,
}: {
  assignableRoles: DomainRole[]
  projectId: string
  existingUsernames: Set<string>
}) {
  const [searchQuery, setSearchQuery] = useState('')
  const [open, setOpen] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const { data: searchResults, isLoading: isSearching } = useUserSearch(searchQuery)
  const createBinding = useCreateRoleBinding()

  const filteredResults = useMemo(
    () => (searchResults ?? []).filter((u) => !existingUsernames.has(u.username)),
    [searchResults, existingUsernames],
  )

  const defaultRoleId = useMemo(() => {
    const viewer = assignableRoles.find((r) => r.name === RoleName.ProjectViewer)
    return viewer?.id ?? assignableRoles[0]?.id ?? ''
  }, [assignableRoles])

  const handleSelect = useCallback((user: DomainUserSearchResult) => {
    if (!defaultRoleId) return

    createBinding.mutate(
      {
        roleId: defaultRoleId,
        scope: 'project',
        userId: user.username,
        projectId,
      },
      {
        onSuccess: () => {
          toast.success(`Added ${user.name || user.username}`)
          setSearchQuery('')
          setOpen(false)
        },
        onError: (error) => {
          const message = error instanceof Error ? error.message : 'Failed to add collaborator'
          if (message.includes('409') || message.toLowerCase().includes('conflict')) {
            toast.error('User already has access to this project')
          } else {
            toast.error(message)
          }
        },
      },
    )
  }, [defaultRoleId, projectId, createBinding])

  const showDropdown = searchQuery.length > 0 && (filteredResults.length > 0 || isSearching)

  return (
    <Popover open={open && showDropdown} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        <div className="relative">
          <Command shouldFilter={false} className="border rounded-md">
            <CommandInput
              ref={inputRef}
              placeholder="Add people..."
              value={searchQuery}
              onValueChange={(v) => {
                setSearchQuery(v)
                if (v.length > 0) setOpen(true)
              }}
              onFocus={() => { if (searchQuery.length > 0) setOpen(true) }}
              className="h-11"
            />
          </Command>
        </div>
      </PopoverAnchor>
      <PopoverContent
        className="w-[--radix-popover-trigger-width] p-0"
        align="start"
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <Command shouldFilter={false}>
          <CommandList>
            {isSearching && (
              <div className="flex items-center justify-center py-4">
                <Loader2 className="size-4 animate-spin text-muted-foreground" />
              </div>
            )}
            {!isSearching && filteredResults.length === 0 && searchQuery.length > 0 && (
              <CommandEmpty>No users found.</CommandEmpty>
            )}
            {filteredResults.length > 0 && (
              <CommandGroup>
                {filteredResults.map((user) => (
                  <CommandItem
                    key={user.id}
                    value={user.id}
                    onSelect={() => handleSelect(user)}
                    disabled={createBinding.isPending}
                  >
                    <UserAvatar initials={getInitials(user.name, user.username)} username={user.username} />
                    <div className="ml-2 flex flex-col">
                      <span className="text-sm font-medium">{user.name || user.username}</span>
                      {user.name && (
                        <span className="text-xs text-muted-foreground">@{user.username}</span>
                      )}
                    </div>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

// ---------------------------------------------------------------------------
// Collaborator row (Google Drive style)
// ---------------------------------------------------------------------------

function CollaboratorRow({
  collaborator,
  assignableRoles,
  allRoles,
  isCurrentUser,
  isSoleOwner,
  readOnly,
}: {
  collaborator: ResolvedCollaborator
  assignableRoles: DomainRole[]
  allRoles: DomainRole[]
  isCurrentUser: boolean
  isSoleOwner: boolean
  readOnly: boolean
}) {
  const router = useRouter()
  const patchBinding = usePatchRoleBinding()
  const deleteBinding = useDeleteRoleBinding()
  const [confirmOpen, setConfirmOpen] = useState(false)

  const canMutate = !readOnly && assignableRoles.length > 0
  const isOwnerRole = collaborator.roleName === RoleName.ProjectOwner

  const canChangeRole =
    canMutate &&
    !isSoleOwner &&
    assignableRoles.some((r) => r.name === collaborator.roleName)

  const handleRoleChange = useCallback(
    (value: string) => {
      if (value === '__remove__') {
        setConfirmOpen(true)
        return
      }
      if (value === '__leave__') {
        setConfirmOpen(true)
        return
      }
      const newRole = allRoles.find((r) => r.id === value)
      patchBinding.mutate(
        { id: collaborator.binding.id, request: { roleId: value } },
        {
          onSuccess: () => {
            toast.success(
              `Changed ${collaborator.name || collaborator.username} to ${newRole ? getDisplayRole(newRole.name) : 'new role'}`,
            )
          },
          onError: (error) => {
            toast.error(error instanceof Error ? error.message : 'Failed to change role')
          },
        },
      )
    },
    [collaborator, patchBinding, allRoles],
  )

  const handleConfirmRemove = useCallback(() => {
    deleteBinding.mutate(collaborator.binding.id, {
      onSuccess: () => {
        if (isCurrentUser) {
          toast.success('You have left the project')
          router.push('/')
        } else {
          toast.success(`Removed ${collaborator.name || collaborator.username}`)
        }
        setConfirmOpen(false)
      },
      onError: (error) => {
        toast.error(error instanceof Error ? error.message : 'Failed to remove')
        setConfirmOpen(false)
      },
    })
  }, [collaborator, isCurrentUser, deleteBinding, router])

  return (
    <>
      <div className="flex items-center gap-3 py-2">
        <UserAvatar initials={collaborator.initials} username={collaborator.username} />

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-sm font-medium">
              {collaborator.name || collaborator.username}
            </span>
            {isCurrentUser && (
              <span className="text-xs text-muted-foreground">(you)</span>
            )}
          </div>
          <span className="text-xs text-muted-foreground">
            @{collaborator.username}
          </span>
        </div>

        {/* Role: static text for owners / non-editable, Select dropdown otherwise */}
        {canChangeRole ? (
          <Select
            value={collaborator.binding.roleId}
            onValueChange={handleRoleChange}
            disabled={patchBinding.isPending || deleteBinding.isPending}
          >
            <SelectTrigger className="w-[120px] shrink-0 border-0 shadow-none h-8 text-sm text-muted-foreground hover:text-foreground">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {assignableRoles.map((role) => (
                <SelectItem key={role.id} value={role.id}>
                  {getDisplayRole(role.name)}
                </SelectItem>
              ))}
              <SelectSeparator />
              <SelectItem
                value={isCurrentUser ? '__leave__' : '__remove__'}
                className="text-destructive focus:text-destructive"
              >
                {isCurrentUser ? 'Leave project' : 'Remove access'}
              </SelectItem>
            </SelectContent>
          </Select>
        ) : (
          <span className="text-sm text-muted-foreground pr-2">
            {collaborator.roleDisplayName}
          </span>
        )}
      </div>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {isCurrentUser ? 'Leave project?' : `Remove ${collaborator.name || collaborator.username}?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {isCurrentUser
                ? 'You will lose access to this project.'
                : `${collaborator.name || collaborator.username} will lose access to this project.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleConfirmRemove}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleteBinding.isPending && <Loader2 className="mr-2 size-4 animate-spin" />}
              {isCurrentUser ? 'Leave' : 'Remove'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function CollaboratorManager({
  projectId,
  currentUserRole,
  readOnly = false,
}: CollaboratorManagerProps) {
  const { user: currentUser } = useCurrentUser()

  const searchFilter = `scope = 'project' and project_id = '${projectId}'`
  const {
    data: bindings,
    isLoading: bindingsLoading,
    error: bindingsError,
  } = useAllRoleBindings(searchFilter)

  const { data: rolesData, isLoading: rolesLoading } = useRoles({ size: 100 })
  const allRoles = useMemo(() => rolesData?.items ?? [], [rolesData])

  const roleMap = useMemo(() => {
    const map = new Map<string, DomainRole>()
    for (const role of allRoles) {
      map.set(role.id, role)
    }
    return map
  }, [allRoles])

  const usernames = useMemo(() => {
    if (!bindings) return []
    const names = new Set<string>()
    for (const b of bindings) {
      if (b.userId) names.add(b.userId)
    }
    return [...names]
  }, [bindings])

  const { data: usersMap, isLoading: usersLoading } = useUsersByUsernames(usernames)

  const collaborators: ResolvedCollaborator[] = useMemo(() => {
    if (!bindings || !usersMap) return []
    return bindings
      .filter((b) => b.userId !== null)
      .map((b) => {
        const user = usersMap.get(b.userId!)
        const role = roleMap.get(b.roleId)
        const username = b.userId ?? 'unknown'
        const name = user?.name ?? ''
        return {
          binding: b,
          username,
          name,
          initials: getInitials(name, username),
          roleName: role?.name ?? '',
          roleDisplayName: role ? getDisplayRole(role.name) : 'Unknown',
        }
      })
      .sort((a, b) => {
        const aLevel = getRoleLevel(a.roleName)
        const bLevel = getRoleLevel(b.roleName)
        if (aLevel !== bLevel) return bLevel - aLevel
        return a.username.localeCompare(b.username)
      })
  }, [bindings, usersMap, roleMap])

  const globalBindingsSearch = currentUser
    ? `scope = 'global' and user_id = '${currentUser.username}'`
    : undefined
  const { data: globalBindings } = useAllRoleBindings(globalBindingsSearch)

  const isPlatformAdmin = useMemo(() => {
    if (!globalBindings || !roleMap.size) return false
    return globalBindings.some((b) => {
      const role = roleMap.get(b.roleId)
      return role?.name === RoleName.PlatformAdmin
    })
  }, [globalBindings, roleMap])

  const resolvedUserRole = useMemo(() => {
    if (currentUserRole) return currentUserRole
    if (isPlatformAdmin) return RoleName.PlatformAdmin
    if (!currentUser || !bindings) return null
    const userBinding = bindings.find((b) => b.userId === currentUser.username)
    if (!userBinding) return null
    const role = roleMap.get(userBinding.roleId)
    return role?.name ?? null
  }, [currentUserRole, isPlatformAdmin, currentUser, bindings, roleMap])

  const assignableRoles = useMemo(
    () => getAssignableRoles(resolvedUserRole, allRoles),
    [resolvedUserRole, allRoles],
  )

  const existingUsernames = useMemo(
    () => new Set(collaborators.map((c) => c.username)),
    [collaborators],
  )

  const ownerCount = useMemo(
    () => collaborators.filter((c) => c.roleName === RoleName.ProjectOwner).length,
    [collaborators],
  )

  const isLoading = bindingsLoading || rolesLoading || (usernames.length > 0 && usersLoading)

  if (bindingsError) {
    return (
      <div className="rounded-md border border-destructive/50 bg-destructive/5 p-4">
        <p className="text-sm text-destructive">
          Failed to load collaborators. Please try again later.
        </p>
      </div>
    )
  }

  if (isLoading) {
    return (
      <div className="space-y-5">
        <Skeleton className="h-11 w-full rounded-md" />
        <div className="space-y-1">
          <Skeleton className="h-4 w-32 mb-3" />
          {[1, 2].map((i) => (
            <div key={i} className="flex items-center gap-3 py-2">
              <Skeleton className="size-9 rounded-full" />
              <div className="flex-1 space-y-1">
                <Skeleton className="h-4 w-32" />
                <Skeleton className="h-3 w-24" />
              </div>
              <Skeleton className="h-5 w-14" />
            </div>
          ))}
        </div>
      </div>
    )
  }

  const effectiveReadOnly = readOnly === true || assignableRoles.length === 0

  return (
    <div className="space-y-5">
      {/* Search input */}
      {!effectiveReadOnly && (
        <UserSearchInput
          assignableRoles={assignableRoles}
          projectId={projectId}
          existingUsernames={existingUsernames}
        />
      )}

      {/* People with access */}
      <div>
        <h3 className="text-sm font-medium mb-2">People with access</h3>

        {collaborators.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-6 text-center">
            <Users className="size-8 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">
              No collaborators yet
            </p>
          </div>
        ) : (
          <div>
            {collaborators.map((collaborator) => {
              const isCurrentUser = currentUser?.username === collaborator.username
              const isSoleOwner = collaborator.roleName === RoleName.ProjectOwner && ownerCount === 1
              return (
                <CollaboratorRow
                  key={collaborator.binding.id}
                  collaborator={collaborator}
                  assignableRoles={assignableRoles}
                  allRoles={allRoles}
                  isCurrentUser={isCurrentUser}
                  isSoleOwner={isSoleOwner}
                  readOnly={effectiveReadOnly}
                />
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
