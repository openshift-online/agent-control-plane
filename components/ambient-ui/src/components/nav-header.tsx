'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { LogOut, Search, UserPlus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb'
import { SidebarTrigger } from '@/components/ui/sidebar'
import { Separator } from '@/components/ui/separator'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useCurrentUser } from '@/hooks/use-current-user'
import { useAllRoleBindings } from '@/queries/use-role-bindings'
import { useRoles } from '@/queries/use-roles'
import { NotificationBell } from '@/components/notification-bell'
import { ShareDialog } from '@/app/(dashboard)/[projectId]/_components/share-dialog'
type NavHeaderProps = {
  projectId?: string | null
  effectiveProjectId?: string | null
  projectName?: string | null
  pageName?: string | null
  sessionName?: string | null
  detailName?: string | null
}

const BREADCRUMB_LABEL_MAP: Record<string, string> = {}

function displayLabel(raw: string): string {
  return BREADCRUMB_LABEL_MAP[raw] ?? raw
}

function useIsMac() {
  const [isMac, setIsMac] = useState(false)

  useEffect(() => {
    setIsMac(navigator.platform.toUpperCase().includes('MAC'))
  }, [])

  return isMac
}

function SearchTrigger() {
  const isMac = useIsMac()

  const handleClick = useCallback(() => {
    document.dispatchEvent(new CustomEvent('open-command-palette'))
  }, [])

  return (
    <button
      type="button"
      onClick={handleClick}
      className="inline-flex items-center gap-2 rounded-md border border-input bg-muted/50 px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      aria-label="Search"
    >
      <Search className="size-4" />
      <span className="hidden sm:inline">Search...</span>
      <kbd className="pointer-events-none hidden h-5 select-none items-center gap-0.5 rounded border bg-background px-1.5 font-mono text-[10px] font-medium opacity-70 sm:inline-flex">
        {isMac ? '⌘' : 'Ctrl+'}K
      </kbd>
    </button>
  )
}

function UserMenu() {
  const { user, isLoading } = useCurrentUser()

  if (isLoading || !user) {
    return null
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 rounded-full text-xs font-medium"
          aria-label="User menu"
        >
          {user.initials}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel className="font-normal">
          <div className="flex flex-col gap-1">
            <p className="text-sm font-medium leading-none">{user.name}</p>
            <p className="text-xs leading-none text-muted-foreground">{user.email}</p>
          </div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <a href="/api/auth/sso/logout" className="flex items-center gap-2 cursor-pointer">
            <LogOut className="h-4 w-4" />
            Sign out
          </a>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function useCurrentUserRole(projectId: string | null | undefined) {
  const { user } = useCurrentUser()
  const bindingSearch = projectId ? `scope = 'project' and project_id = '${projectId}'` : ''
  const { data: bindings } = useAllRoleBindings(bindingSearch)
  const { data: rolesData } = useRoles({ size: 100 })

  return useMemo(() => {
    if (!user || !bindings || !rolesData || !projectId) return null
    const binding = bindings.find((b) => b.userId === user.username)
    if (!binding) return null
    const role = rolesData.items.find((r) => r.id === binding.roleId)
    return role?.name ?? null
  }, [user, bindings, rolesData, projectId])
}

export function NavHeader({ projectId, effectiveProjectId, projectName, pageName, sessionName, detailName }: NavHeaderProps) {
  const mappedPageName = pageName ? displayLabel(pageName) : null
  const currentUserRole = useCurrentUserRole(projectId)

  return (
    <header className="sticky top-0 z-20 flex h-14 items-center gap-2 border-b bg-background px-4">
      <SidebarTrigger />
      <Separator orientation="vertical" className="mx-2 h-5" />

      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink asChild>
              <Link href="/">
                <span>Projects</span>
              </Link>
            </BreadcrumbLink>
          </BreadcrumbItem>

          {projectId && (
            <>
              <BreadcrumbSeparator />
              <BreadcrumbItem>
                <BreadcrumbLink asChild>
                  <Link href={`/${projectId}`}>{projectName ?? projectId}</Link>
                </BreadcrumbLink>
              </BreadcrumbItem>
            </>
          )}

          {mappedPageName && (
            <>
              <BreadcrumbSeparator />
              <BreadcrumbItem>
                {sessionName || detailName ? (
                  <BreadcrumbLink asChild>
                    <Link href={`/${projectId}/${mappedPageName.toLowerCase()}`}>{mappedPageName}</Link>
                  </BreadcrumbLink>
                ) : (
                  <BreadcrumbPage>{mappedPageName}</BreadcrumbPage>
                )}
              </BreadcrumbItem>
            </>
          )}

          {(sessionName ?? detailName) && (
            <>
              <BreadcrumbSeparator />
              <BreadcrumbItem>
                <BreadcrumbPage>{sessionName ?? detailName}</BreadcrumbPage>
              </BreadcrumbItem>
            </>
          )}
        </BreadcrumbList>
      </Breadcrumb>

      <div className="ml-auto flex items-center gap-2">
        <SearchTrigger />
        {projectId && (
          <ShareDialog
            projectId={projectId}
            currentUserRole={currentUserRole}
            trigger={
              <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="Share project" title="Share">
                <UserPlus className="size-4" />
              </Button>
            }
          />
        )}
        <NotificationBell />
        <UserMenu />
      </div>
    </header>
  )
}
