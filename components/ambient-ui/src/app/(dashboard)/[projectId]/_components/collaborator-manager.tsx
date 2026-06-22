'use client'

import { useCallback, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useQueryClient, useQuery } from '@tanstack/react-query'
import { Loader2, Search, UserPlus, X, LogOut, Trash2, Users } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Select,
  SelectContent,
  SelectItem,
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
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
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
// Role hierarchy helpers
// ---------------------------------------------------------------------------

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
// Batch user fetch hook using list endpoint
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
// Sub-components
// ---------------------------------------------------------------------------

function UserAvatar({ initials }: { initials: string }) {
  return (
    <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium text-muted-foreground">
      {initials}
    </div>
  )
}

// ---------------------------------------------------------------------------
// User search combobox
// ---------------------------------------------------------------------------

function UserSearchCombobox({
  assignableRoles,
  projectId,
  existingUsernames,
}: {
  assignableRoles: DomainRole[]
  projectId: string
  existingUsernames: Set<string>
}) {
  const [open, setOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [selectedUser, setSelectedUser] = useState<DomainUserSearchResult | null>(null)
  const [selectedRoleId, setSelectedRoleId] = useState<string>(
    () => {
      const viewer = assignableRoles.find((r) => r.name === RoleName.ProjectViewer)
      return viewer?.id ?? assignableRoles[0]?.id ?? ''
    },
  )

  const { data: searchResults, isLoading: isSearching } = useUserSearch(searchQuery)
  const createBinding = useCreateRoleBinding()

  const filteredResults = useMemo(
    () => (searchResults ?? []).filter((u) => !existingUsernames.has(u.username)),
    [searchResults, existingUsernames],
  )

  const handleSelect = useCallback((user: DomainUserSearchResult) => {
    setSelectedUser(user)
    setOpen(false)
    setSearchQuery('')
  }, [])

  const handleAdd = useCallback(() => {
    if (!selectedUser || !selectedRoleId) return

    createBinding.mutate(
      {
        roleId: selectedRoleId,
        scope: 'project',
        userId: selectedUser.username,
        projectId,
      },
      {
        onSuccess: () => {
          toast.success(`Added ${selectedUser.name || selectedUser.username}`)
          setSelectedUser(null)
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
  }, [selectedUser, selectedRoleId, projectId, createBinding])

  return (
    <div className="flex items-center gap-2">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            role="combobox"
            aria-expanded={open}
            className="w-full justify-start text-sm font-normal"
          >
            {selectedUser ? (
              <span className="truncate">
                {selectedUser.name || selectedUser.username}
              </span>
            ) : (
              <span className="flex items-center gap-2 text-muted-foreground">
                <Search className="size-4" />
                Search users...
              </span>
            )}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-[300px] p-0" align="start">
          <Command shouldFilter={false}>
            <CommandInput
              placeholder="Search by name or username..."
              value={searchQuery}
              onValueChange={setSearchQuery}
            />
            <CommandList>
              {isSearching && searchQuery.length > 0 && (
                <div className="flex items-center justify-center py-4">
                  <Loader2 className="size-4 animate-spin text-muted-foreground" />
                </div>
              )}
              {!isSearching && searchQuery.length > 0 && filteredResults.length === 0 && (
                <CommandEmpty>No users found.</CommandEmpty>
              )}
              {filteredResults.length > 0 && (
                <CommandGroup>
                  {filteredResults.map((user) => (
                    <CommandItem
                      key={user.id}
                      value={user.id}
                      onSelect={() => handleSelect(user)}
                    >
                      <UserAvatar initials={getInitials(user.name, user.username)} />
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

      {assignableRoles.length > 1 && (
        <Select value={selectedRoleId} onValueChange={setSelectedRoleId}>
          <SelectTrigger className="w-[120px] shrink-0">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {assignableRoles.map((role) => (
              <SelectItem key={role.id} value={role.id}>
                {getDisplayRole(role.name)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}

      <Button
        size="sm"
        onClick={handleAdd}
        disabled={!selectedUser || !selectedRoleId || createBinding.isPending}
      >
        {createBinding.isPending ? (
          <Loader2 className="size-4 animate-spin" />
        ) : (
          <UserPlus className="mr-1 size-4" />
        )}
        Add
      </Button>

      {selectedUser && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setSelectedUser(null)}
          className="shrink-0 px-2"
        >
          <X className="size-4" />
        </Button>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Collaborator row
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

  // Whether the current caller can change this user's role:
  // They can only change to roles they can assign, and the row user's current
  // role must also be within the roles they can assign (strictly-below rule)
  const canChangeRole =
    canMutate &&
    !isSoleOwner &&
    assignableRoles.some((r) => r.name === collaborator.roleName)

  const canRemove = canMutate && !(isSoleOwner && isCurrentUser)

  const handleRoleChange = useCallback(
    (newRoleId: string) => {
      const newRole = allRoles.find((r) => r.id === newRoleId)
      patchBinding.mutate(
        { id: collaborator.binding.id, request: { roleId: newRoleId } },
        {
          onSuccess: () => {
            toast.success(
              `Changed ${collaborator.name || collaborator.username} to ${newRole ? getDisplayRole(newRole.name) : 'new role'}`,
            )
          },
          onError: (error) => {
            toast.error(
              error instanceof Error ? error.message : 'Failed to change role',
            )
          },
        },
      )
    },
    [collaborator, patchBinding, allRoles],
  )

  const handleRemove = useCallback(() => {
    deleteBinding.mutate(collaborator.binding.id, {
      onSuccess: () => {
        if (isCurrentUser) {
          toast.success('You have left the project')
          router.push('/')
        } else {
          toast.success(
            `Removed ${collaborator.name || collaborator.username}`,
          )
        }
        setConfirmOpen(false)
      },
      onError: (error) => {
        toast.error(
          error instanceof Error ? error.message : 'Failed to remove collaborator',
        )
        setConfirmOpen(false)
      },
    })
  }, [collaborator, isCurrentUser, deleteBinding, router])

  return (
    <>
      <div className="flex items-center gap-3 rounded-md px-2 py-2 hover:bg-muted/50">
        <UserAvatar initials={collaborator.initials} />

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

        {/* Role selector or display */}
        <div className="flex items-center gap-2">
          {canChangeRole ? (
            <Select
              value={collaborator.binding.roleId}
              onValueChange={handleRoleChange}
              disabled={patchBinding.isPending}
            >
              <SelectTrigger size="sm" className="w-[110px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {assignableRoles.map((role) => (
                  <SelectItem key={role.id} value={role.id}>
                    {getDisplayRole(role.name)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <span className="text-sm text-muted-foreground">
              {collaborator.roleDisplayName}
            </span>
          )}

          {/* Remove / Leave button */}
          {canRemove && !isSoleOwner ? (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="shrink-0 px-2 text-destructive hover:text-destructive"
                    onClick={() => setConfirmOpen(true)}
                    disabled={deleteBinding.isPending}
                  >
                    {deleteBinding.isPending ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : isCurrentUser ? (
                      <LogOut className="size-4" />
                    ) : (
                      <Trash2 className="size-4" />
                    )}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  {isCurrentUser ? 'Leave project' : 'Remove'}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          ) : isSoleOwner && isCurrentUser ? (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="shrink-0 px-2"
                      disabled
                    >
                      <LogOut className="size-4" />
                    </Button>
                  </span>
                </TooltipTrigger>
                <TooltipContent>
                  Transfer project ownership before leaving
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          ) : null}
        </div>
      </div>

      {/* Confirmation dialog */}
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {isCurrentUser ? 'Leave project?' : `Remove ${collaborator.name || collaborator.username}?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {isCurrentUser
                ? 'You will lose access to this project. This action cannot be undone.'
                : `${collaborator.name || collaborator.username} will lose access to this project.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleRemove}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleteBinding.isPending ? (
                <Loader2 className="mr-2 size-4 animate-spin" />
              ) : null}
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

  // Fetch project-scoped role bindings
  const searchFilter = `scope = 'project' and project_id = '${projectId}'`
  const {
    data: bindings,
    isLoading: bindingsLoading,
    error: bindingsError,
  } = useAllRoleBindings(searchFilter)

  // Fetch all roles to resolve roleId → name
  const { data: rolesData, isLoading: rolesLoading } = useRoles({ size: 100 })
  const allRoles = useMemo(() => rolesData?.items ?? [], [rolesData])

  // Build a roleId → role lookup
  const roleMap = useMemo(() => {
    const map = new Map<string, DomainRole>()
    for (const role of allRoles) {
      map.set(role.id, role)
    }
    return map
  }, [allRoles])

  // Collect unique usernames from bindings for batch fetch
  const usernames = useMemo(() => {
    if (!bindings) return []
    const names = new Set<string>()
    for (const b of bindings) {
      if (b.userId) names.add(b.userId)
    }
    return [...names]
  }, [bindings])

  const { data: usersMap, isLoading: usersLoading } = useUsersByUsernames(usernames)

  // Resolve collaborators
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

  // Check if the current user has a global platform:admin binding
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

  // Self-resolve the current user's role from bindings if not provided by parent
  const resolvedUserRole = useMemo(() => {
    if (currentUserRole) return currentUserRole
    if (isPlatformAdmin) return RoleName.PlatformAdmin
    if (!currentUser || !bindings) return null
    const userBinding = bindings.find((b) => b.userId === currentUser.username)
    if (!userBinding) return null
    const role = roleMap.get(userBinding.roleId)
    return role?.name ?? null
  }, [currentUserRole, isPlatformAdmin, currentUser, bindings, roleMap])

  // Determine assignable roles based on resolvedUserRole
  const assignableRoles = useMemo(
    () => getAssignableRoles(resolvedUserRole, allRoles),
    [resolvedUserRole, allRoles],
  )

  // Set of existing usernames for filtering autocomplete
  const existingUsernames = useMemo(
    () => new Set(collaborators.map((c) => c.username)),
    [collaborators],
  )

  // Count owners to determine sole-owner status
  const ownerCount = useMemo(
    () => collaborators.filter((c) => c.roleName === RoleName.ProjectOwner).length,
    [collaborators],
  )

  const isLoading = bindingsLoading || rolesLoading || (usernames.length > 0 && usersLoading)

  // Error state
  if (bindingsError) {
    return (
      <div className="rounded-md border border-destructive/50 bg-destructive/5 p-4">
        <p className="text-sm text-destructive">
          Failed to load collaborators. Please try again later.
        </p>
      </div>
    )
  }

  // Loading state
  if (isLoading) {
    return (
      <div className="space-y-4">
        {!readOnly && assignableRoles.length > 0 && (
          <Skeleton className="h-10 w-full" />
        )}
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

  const effectiveReadOnly = readOnly === true || assignableRoles.length === 0

  return (
    <div className="space-y-4">
      {/* Add collaborator section */}
      {!effectiveReadOnly && (
        <UserSearchCombobox
          assignableRoles={assignableRoles}
          projectId={projectId}
          existingUsernames={existingUsernames}
        />
      )}

      {/* Collaborator list */}
      {collaborators.length === 0 ? (
        <div className="flex flex-col items-center gap-2 py-8 text-center">
          <Users className="size-8 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">
            No collaborators yet — share this project to get started
          </p>
        </div>
      ) : (
        <div className="space-y-1">
          {collaborators.map((collaborator) => {
            const isCurrentUser =
              currentUser?.username === collaborator.username
            const isSoleOwner =
              collaborator.roleName === RoleName.ProjectOwner && ownerCount === 1
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
  )
}
