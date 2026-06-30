'use client'

// Feature-gated by NEXT_PUBLIC_OPENSHELL_USE_GATEWAY env var (sidebar nav only visible when enabled)
import { useState, useEffect } from 'react'
import { useParams } from 'next/navigation'
import { FileCode, Tags, KeyRound } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { useProvider } from '@/queries/use-providers'
import { LifecycleBadge } from '../../agents/_components/lifecycle-badge'
import { formatRelativeTime } from '@/lib/format-timestamp'
import { ProviderManifestTab } from './_components/provider-manifest-tab'

export default function ProviderDetailPage() {
  const { projectId, providerId } = useParams<{
    projectId: string
    providerId: string
  }>()
  const [activeTab, setActiveTab] = useState('manifest')
  const { data: provider, isLoading, error } = useProvider(projectId, providerId)

  useEffect(() => {
    const tab = new URL(window.location.href).searchParams.get('tab')
    if (tab) setActiveTab(tab)
  }, [])

  const handleTabChange = (value: string) => {
    setActiveTab(value)
    const url = new URL(window.location.href)
    url.searchParams.set('tab', value)
    window.history.replaceState({}, '', url.toString())
  }

  if (error) {
    return (
      <p className="text-sm text-destructive">
        Failed to load provider: {error.message}
      </p>
    )
  }

  if (isLoading || !provider) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-[400px] w-full" />
      </div>
    )
  }

  const annotationEntries = Object.entries(provider.annotations)
  const labelEntries = Object.entries(provider.labels)

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div className="space-y-1">
          <div className="flex items-center gap-3">
            <KeyRound className="size-6 text-muted-foreground" />
            <h1 className="text-2xl font-semibold tracking-tight">
              {provider.name}
            </h1>
            <LifecycleBadge lifecycle="gitops" />
          </div>
          <div className="flex flex-wrap items-center gap-4 text-sm text-muted-foreground">
            {provider.type && (
              <span>
                Type: <Badge variant="secondary">{provider.type}</Badge>
              </span>
            )}
            <span>
              Namespace:{' '}
              <span className="font-mono">{provider.namespace}</span>
            </span>
            {provider.updatedAt && (
              <span>Updated {formatRelativeTime(provider.updatedAt)}</span>
            )}
          </div>
        </div>
      </div>

      <Tabs value={activeTab} onValueChange={handleTabChange}>
        <TabsList className="w-full *:flex-1">
          <TabsTrigger value="manifest">
            <FileCode className="size-4 mr-1.5" /> Manifest
          </TabsTrigger>
          <TabsTrigger value="annotations">
            <Tags className="size-4 mr-1.5" /> Annotations
          </TabsTrigger>
        </TabsList>
        <TabsContent value="manifest">
          <ProviderManifestTab provider={provider} />
        </TabsContent>
        <TabsContent value="annotations">
          <div className="space-y-6 pt-4">
            {annotationEntries.length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">
                    Annotations ({annotationEntries.length})
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Key</TableHead>
                        <TableHead>Value</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {annotationEntries.map(([key, value]) => (
                        <TableRow key={key}>
                          <TableCell className="font-mono text-xs">
                            {key}
                          </TableCell>
                          <TableCell className="text-sm">{value}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
            )}
            {labelEntries.length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">
                    Labels ({labelEntries.length})
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="flex flex-wrap gap-2">
                    {labelEntries.map(([key, value]) => (
                      <Badge key={key} variant="secondary" className="text-xs">
                        {key}: {value}
                      </Badge>
                    ))}
                  </div>
                </CardContent>
              </Card>
            )}
            {annotationEntries.length === 0 && labelEntries.length === 0 && (
              <p className="text-sm text-muted-foreground text-center py-8">
                No annotations or labels.
              </p>
            )}
          </div>
        </TabsContent>
      </Tabs>
    </div>
  )
}
