'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useTheme } from 'next-themes'
import {
  LayoutDashboard,
  Monitor,
  CalendarClock,
  Bot,
  KeyRound,
  Shield,
  Settings,
  Moon,
  Sun,
  GraduationCap,
} from 'lucide-react'
import { useSessions } from '@/queries/use-sessions'
import { getAttentionItems } from '@/app/(dashboard)/[projectId]/_components/dashboard-helpers'
import { ProjectSelector } from '@/components/project-selector'
import { Button } from '@/components/ui/button'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@/components/ui/sidebar'

type AppSidebarProps = {
  projectId: string | null
  effectiveProjectId: string | null
}

type NavItem = { readonly label: string; readonly icon: typeof Monitor; readonly href: string; readonly global?: boolean }

const operateNavItems: readonly NavItem[] = [
  { label: 'Dashboard', icon: LayoutDashboard, href: '' },
  { label: 'Sessions', icon: Monitor, href: 'sessions' },
  { label: 'Schedules', icon: CalendarClock, href: 'schedules' },
]

const configNavItems: readonly NavItem[] = [
  { label: 'Agents', icon: Bot, href: 'agents' },
  { label: 'Providers', icon: KeyRound, href: 'providers' },
  { label: 'Policies', icon: Shield, href: 'policies' },
]

const projectNavItems: readonly NavItem[] = [
  { label: 'Settings', icon: Settings, href: 'settings' },
]

const learnNavItems: readonly NavItem[] = [
  { label: 'Learn', icon: GraduationCap, href: '/learn', global: true },
]

function NavGroup({
  label,
  items,
  effectiveProjectId,
  pathname,
  badgeCounts,
}: {
  label: string
  items: readonly NavItem[]
  effectiveProjectId: string | null
  pathname: string
  badgeCounts?: Record<string, number>
}) {
  return (
    <SidebarGroup>
      <SidebarGroupLabel>{label}</SidebarGroupLabel>
      <SidebarGroupContent>
        <SidebarMenu>
          {items.map((item) => {
            const isGlobal = item.global === true
            const needsProject = !isGlobal && !effectiveProjectId

            const href = isGlobal
              ? item.href
              : effectiveProjectId
                ? item.href
                  ? `/${effectiveProjectId}/${item.href}`
                  : `/${effectiveProjectId}`
                : '/'

            const isActive = isGlobal
              ? pathname === href || pathname.startsWith(href + '/')
              : item.href
                ? pathname === href || pathname.startsWith(href + '/')
                : pathname === href

            const badgeCount = badgeCounts?.[item.label] ?? 0

            return (
              <SidebarMenuItem key={item.label}>
                {needsProject ? (
                  <SidebarMenuButton
                    disabled
                    tooltip={item.label}
                  >
                    <item.icon />
                    <span>{item.label}</span>
                  </SidebarMenuButton>
                ) : (
                  <SidebarMenuButton
                    asChild
                    isActive={isActive}
                    tooltip={item.label}
                  >
                    <Link href={href}>
                      <item.icon />
                      <span>{item.label}</span>
                    </Link>
                  </SidebarMenuButton>
                )}
                {badgeCount > 0 && (
                  <SidebarMenuBadge>{badgeCount}</SidebarMenuBadge>
                )}
              </SidebarMenuItem>
            )
          })}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  )
}

export function AppSidebar({ projectId, effectiveProjectId }: AppSidebarProps) {
  const pathname = usePathname()
  const { theme, setTheme } = useTheme()
  const { data: sessionsData } = useSessions(effectiveProjectId ?? '', undefined)

  const operateBadges = (() => {
    if (!sessionsData?.items) return undefined
    const count = getAttentionItems(sessionsData.items).length
    return count > 0 ? { Dashboard: count } : undefined
  })()

  return (
    <Sidebar>
      <SidebarHeader>
        <div className="flex items-center gap-2 px-2 py-1.5">
          <Bot className="size-5 text-primary" />
          <span className="text-sm font-semibold tracking-tight">ACP</span>
        </div>
        <ProjectSelector projectId={projectId} effectiveProjectId={effectiveProjectId} />
      </SidebarHeader>

      <SidebarContent>
        <NavGroup label="Operate" items={operateNavItems} effectiveProjectId={effectiveProjectId} pathname={pathname} badgeCounts={operateBadges} />
        <NavGroup label="Config" items={configNavItems} effectiveProjectId={effectiveProjectId} pathname={pathname} />
        <NavGroup label="Project" items={projectNavItems} effectiveProjectId={effectiveProjectId} pathname={pathname} />
        <NavGroup label="Resources" items={learnNavItems} effectiveProjectId={effectiveProjectId} pathname={pathname} />
      </SidebarContent>

      <SidebarFooter>
        <div className="flex items-center justify-between px-2 py-1">
          <span className="text-xs text-muted-foreground">Theme</span>
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
            aria-label="Toggle theme"
          >
            <Sun aria-hidden="true" className="size-4 rotate-0 scale-100 transition-all dark:-rotate-90 dark:scale-0" />
            <Moon aria-hidden="true" className="absolute size-4 rotate-90 scale-0 transition-all dark:rotate-0 dark:scale-100" />
          </Button>
        </div>
        {process.env.NEXT_PUBLIC_GIT_COMMIT && process.env.NEXT_PUBLIC_GIT_COMMIT !== 'unknown' && (
          <div className="px-2 pb-1">
            <span className="text-[0.65rem] text-muted-foreground/60">
              {process.env.NEXT_PUBLIC_GIT_COMMIT.slice(0, 8)}
            </span>
          </div>
        )}
      </SidebarFooter>
    </Sidebar>
  )
}
