'use client'

import { useState } from 'react'
import { UserPlus } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { useProject } from '@/queries/use-projects'
import { CollaboratorManager } from './collaborator-manager'

type ShareDialogProps = {
  projectId: string
  currentUserRole?: string | null
  trigger?: React.ReactNode
}

export function ShareDialog({
  projectId,
  currentUserRole,
  trigger,
}: ShareDialogProps) {
  const [open, setOpen] = useState(false)
  const { data: project } = useProject(projectId)
  const projectName = project?.name ?? projectId

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {trigger ?? (
          <Button variant="outline" size="sm">
            <UserPlus className="mr-1.5 size-4" />
            Share
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg gap-0 p-0">
        <DialogHeader className="px-6 pt-6 pb-4">
          <DialogTitle>Share &ldquo;{projectName}&rdquo;</DialogTitle>
        </DialogHeader>
        <div className="px-6">
          <CollaboratorManager
            projectId={projectId}
            currentUserRole={currentUserRole}
          />
        </div>
        <DialogFooter className="px-6 py-4 border-t">
          <Button onClick={() => setOpen(false)}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
