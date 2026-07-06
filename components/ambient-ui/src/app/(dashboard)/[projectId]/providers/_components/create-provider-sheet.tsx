'use client'

import { useState, useCallback } from 'react'
import { useParams } from 'next/navigation'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetFooter,
} from '@/components/ui/sheet'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { YamlPreview } from '@/components/configmap-yaml-preview'
import { providerToYaml } from '@/lib/provider-yaml'

const PROVIDER_TYPES = [
  'github',
  'anthropic',
  'jira',
  'google',
  'kubernetes',
  'custom',
]

export function CreateProviderSheet({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { projectId } = useParams<{ projectId: string }>()

  const [name, setName] = useState('')
  const [type, setType] = useState('')
  const [secret, setSecret] = useState('')
  const [namespace, setNamespace] = useState(projectId ?? '')
  const [generatedYaml, setGeneratedYaml] = useState<string | null>(null)

  function resetForm() {
    setName('')
    setType('')
    setSecret('')
    setNamespace(projectId ?? '')
    setGeneratedYaml(null)
  }

  const handleGenerate = useCallback(() => {
    const yaml = providerToYaml({
      id: '',
      name,
      type: type || '',
      secret: secret || '',
      namespace,
      projectId: projectId ?? '',
      annotations: {},
      labels: {},
      createdAt: '',
      updatedAt: '',
    })
    setGeneratedYaml(yaml)
  }, [name, namespace, type, secret])

  const handleClose = useCallback(
    (isOpen: boolean) => {
      if (!isOpen) resetForm()
      onOpenChange(isOpen)
    },
    [onOpenChange],
  )

  return (
    <Sheet open={open} onOpenChange={handleClose}>
      <SheetContent className="sm:max-w-lg overflow-y-auto">
        <SheetHeader>
          <SheetTitle>New Provider</SheetTitle>
          <SheetDescription>
            Define a provider and generate its manifest.
          </SheetDescription>
        </SheetHeader>

        <div className="space-y-4 py-4">
          <div className="space-y-1.5">
            <label htmlFor="provider-name" className="text-sm font-medium">
              Name *
            </label>
            <Input
              id="provider-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="github"
            />
          </div>

          <div className="space-y-1.5">
            <label htmlFor="provider-type" className="text-sm font-medium">
              Type
            </label>
            <Select value={type} onValueChange={setType}>
              <SelectTrigger id="provider-type" className="w-full">
                <SelectValue placeholder="Select type" />
              </SelectTrigger>
              <SelectContent>
                {PROVIDER_TYPES.map((t) => (
                  <SelectItem key={t} value={t}>
                    {t}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <label htmlFor="provider-secret" className="text-sm font-medium">
              Secret Reference
            </label>
            <Input
              id="provider-secret"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              placeholder="my-secret-name"
            />
            <p className="text-xs text-muted-foreground">
              Name of the K8s Secret containing the credentials.
            </p>
          </div>

          <div className="space-y-1.5">
            <label
              htmlFor="provider-namespace"
              className="text-sm font-medium"
            >
              Namespace
            </label>
            <Input
              id="provider-namespace"
              value={namespace}
              onChange={(e) => setNamespace(e.target.value)}
              placeholder="tenant-a"
            />
          </div>

          {generatedYaml && (
            <YamlPreview
              yaml={generatedYaml}
              name={name}
              kind="provider"
            />
          )}
        </div>

        <SheetFooter>
          <Button
            onClick={handleGenerate}
            disabled={!name.trim()}
          >
            Generate YAML
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}
