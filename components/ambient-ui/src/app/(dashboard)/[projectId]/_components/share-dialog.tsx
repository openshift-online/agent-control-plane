'use client'

import { Share2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'

import { CollaboratorManager } from './collaborator-manager'

type ShareDialogProps = {
  projectId: string
  currentUserRole: string | null
  trigger?: React.ReactNode
}

export function ShareDialog({
  projectId,
  currentUserRole,
  trigger,
}: ShareDialogProps) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        {trigger ?? (
          <Button variant="outline" size="sm">
            <Share2 className="mr-1.5 size-4" />
            Share
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Share project</DialogTitle>
          <DialogDescription>
            Add collaborators and manage access to this project.
          </DialogDescription>
        </DialogHeader>
        <CollaboratorManager
          projectId={projectId}
          currentUserRole={currentUserRole}
        />
      </DialogContent>
    </Dialog>
  )
}
