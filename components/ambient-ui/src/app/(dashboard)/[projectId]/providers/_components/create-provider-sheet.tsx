'use client'

import { useState, useCallback } from 'react'
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
import { YamlPreview } from '@/components/yaml-preview'
import { providerToYaml } from '@/lib/provider-yaml'

const PROVIDER_TYPES = [
  'github',
  'vertex',
  'generic',
]

export function CreateProviderSheet({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [name, setName] = useState('')
  const [type, setType] = useState('')
  const [secret, setSecret] = useState('')
  const [generatedYaml, setGeneratedYaml] = useState<string | null>(null)

  function resetForm() {
    setName('')
    setType('')
    setSecret('')
    setGeneratedYaml(null)
  }

  const handleGenerate = useCallback(() => {
    const yaml = providerToYaml({
      name,
      type: type || '',
      secret: secret || '',
      annotations: {},
      labels: {},
    })
    setGeneratedYaml(yaml)
  }, [name, type, secret])

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
          <SheetTitle>Generate Provider Manifest</SheetTitle>
          <SheetDescription>
            Define a provider and generate its manifest.
          </SheetDescription>
        </SheetHeader>

        <form
          onSubmit={(e) => { e.preventDefault(); handleGenerate() }}
          className="flex flex-col gap-4 px-4 pb-4"
        >
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

          {generatedYaml && (
            <YamlPreview
              yaml={generatedYaml}
              name={name}
              kind="provider"
            />
          )}

          <SheetFooter className="px-0">
            <Button
              type="button"
              variant="outline"
              onClick={() => { resetForm(); onOpenChange(false) }}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!name.trim()}>
              Generate Manifest
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  )
}
