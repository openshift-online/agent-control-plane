'use client'

import { useParams, useRouter } from 'next/navigation'
import { useState, useCallback } from 'react'
import { ArrowLeft, GitBranch, Trash2, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
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
import { useApplication, useDeleteApplication } from '@/queries/use-applications'
import { useWorkspaceFlag } from '@/services/queries/use-feature-flags-admin'
import type { DomainApplication } from '@/domain/types'

function DetailField({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div>
      <dt className="text-sm font-medium text-muted-foreground">{label}</dt>
      <dd className="mt-1 text-sm">{value || '-'}</dd>
    </div>
  )
}

function StatusSection({ app }: { app: DomainApplication }) {
  return (
    <div className="rounded-md border p-4 space-y-4">
      <h2 className="text-lg font-semibold">Status</h2>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <div>
          <span className="text-sm text-muted-foreground">Sync</span>
          <div className="mt-1">
            <Badge variant={app.syncStatus === 'Synced' ? 'default' : app.syncStatus === 'OutOfSync' ? 'destructive' : 'secondary'}>
              {app.syncStatus || 'Unknown'}
            </Badge>
          </div>
        </div>
        <div>
          <span className="text-sm text-muted-foreground">Health</span>
          <div className="mt-1">
            <Badge variant={app.healthStatus === 'Healthy' ? 'default' : app.healthStatus === 'Degraded' ? 'destructive' : 'secondary'}>
              {app.healthStatus || 'Unknown'}
            </Badge>
          </div>
        </div>
        <div>
          <span className="text-sm text-muted-foreground">Operation</span>
          <div className="mt-1">
            <Badge variant={app.operationPhase === 'Succeeded' ? 'default' : app.operationPhase === 'Failed' ? 'destructive' : 'secondary'}>
              {app.operationPhase || 'None'}
            </Badge>
          </div>
        </div>
        <DetailField label="Last Synced" value={app.lastSyncedAt ? new Date(app.lastSyncedAt).toLocaleString() : null} />
      </div>
      {app.operationMessage && (
        <div>
          <span className="text-sm text-muted-foreground">Message</span>
          <p className="mt-1 text-sm">{app.operationMessage}</p>
        </div>
      )}
    </div>
  )
}

export default function ApplicationDetailPage() {
  const { enabled: applicationsEnabled } = useWorkspaceFlag(undefined, 'feature.applications.enabled')
  const { applicationId } = useParams<{ applicationId: string }>()
  const router = useRouter()
  const { data: app, isLoading, error } = useApplication(applicationId)
  const deleteApp = useDeleteApplication()
  const [confirmDelete, setConfirmDelete] = useState(false)

  const handleDelete = useCallback(() => {
    deleteApp.mutate(applicationId, {
      onSuccess: () => {
        toast.success('Application deleted')
        router.push('/applications')
      },
      onError: (err) => {
        toast.error(err instanceof Error ? err.message : 'Failed to delete application')
      },
    })
  }, [applicationId, deleteApp, router])

  if (!applicationsEnabled) return null

  if (error) {
    return (
      <div className="space-y-6">
        <Button variant="ghost" size="sm" onClick={() => router.push('/applications')}>
          <ArrowLeft className="mr-1 size-4" /> Back
        </Button>
        <p className="text-sm text-destructive">
          Failed to load application: {error.message}
        </p>
      </div>
    )
  }

  if (isLoading || !app) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-[300px] w-full" />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" onClick={() => router.push('/applications')}>
            <ArrowLeft className="mr-1 size-4" /> Back
          </Button>
          <GitBranch className="size-5 text-muted-foreground" />
          <h1 className="text-2xl font-semibold tracking-tight">{app.name}</h1>
        </div>
        <Button variant="destructive" size="sm" onClick={() => setConfirmDelete(true)}>
          <Trash2 className="mr-1 size-4" />
          Delete
        </Button>
      </div>

      <StatusSection app={app} />

      <div className="rounded-md border p-4 space-y-4">
        <h2 className="text-lg font-semibold">Source</h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <DetailField label="Repository" value={app.sourceRepoUrl} />
          <DetailField label="Revision" value={app.sourceTargetRevision} />
          <DetailField label="Path" value={app.sourcePath} />
        </div>
      </div>

      <div className="rounded-md border p-4 space-y-4">
        <h2 className="text-lg font-semibold">Destination</h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <DetailField label="Project" value={app.destinationProject} />
          <DetailField label="Ambient URL" value={app.destinationAmbientUrl} />
          <DetailField label="Credential" value={app.credentialId} />
        </div>
      </div>

      <div className="rounded-md border p-4 space-y-4">
        <h2 className="text-lg font-semibold">Sync Policy</h2>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <div>
            <span className="text-sm text-muted-foreground">Auto Sync</span>
            <div className="mt-1">
              <Badge variant={app.autoSync ? 'default' : 'outline'}>
                {app.autoSync ? 'On' : 'Off'}
              </Badge>
            </div>
          </div>
          <div>
            <span className="text-sm text-muted-foreground">Auto Prune</span>
            <div className="mt-1">
              <Badge variant={app.autoPrune ? 'default' : 'outline'}>
                {app.autoPrune ? 'On' : 'Off'}
              </Badge>
            </div>
          </div>
          <div>
            <span className="text-sm text-muted-foreground">Self Heal</span>
            <div className="mt-1">
              <Badge variant={app.selfHeal ? 'default' : 'outline'}>
                {app.selfHeal ? 'On' : 'Off'}
              </Badge>
            </div>
          </div>
          <DetailField label="Retry Limit" value={String(app.retryLimit)} />
        </div>
        {app.syncOptions && (
          <DetailField label="Sync Options" value={app.syncOptions} />
        )}
      </div>

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete application?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete <strong>{app.name}</strong>. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleteApp.isPending && <Loader2 className="mr-2 size-4 animate-spin" />}
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
