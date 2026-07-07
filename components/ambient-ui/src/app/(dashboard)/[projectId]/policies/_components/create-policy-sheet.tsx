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
import { ExternalLink } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { YamlPreview } from '@/components/yaml-preview'
import { policyToYaml } from '@/lib/policy-yaml'

const POLICY_TEMPLATE = `version: 1

# Static: locked at sandbox creation. Paths the agent can read vs read/write.
filesystem:
  read_only: [/usr, /lib, /etc]
  read_write: [/sandbox, /tmp]

# Static: Landlock LSM kernel enforcement. best_effort uses highest ABI the host supports.
landlock:
  compatibility: best_effort

# Static: Unprivileged user/group the agent process runs as.
process:
  run_as_user: sandbox
  run_as_group: sandbox

# Dynamic: hot-reloadable. Named blocks of endpoints + binaries allowed to reach them.
network_policies:
  my_api:
    name: my-api
    endpoints:
      - host: api.example.com
        port: 443
        protocol: rest
        enforcement: enforce
        access: full
    binaries:
      - path: /usr/bin/curl`

export function CreatePolicySheet({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [name, setName] = useState('')
  const [specYaml, setSpecYaml] = useState(POLICY_TEMPLATE)
  const [generatedYaml, setGeneratedYaml] = useState<string | null>(null)
  const [parseError, setParseError] = useState<string | null>(null)

  function resetForm() {
    setName('')
    setSpecYaml(POLICY_TEMPLATE)
    setGeneratedYaml(null)
    setParseError(null)
  }

  const handleGenerate = useCallback(() => {
    setParseError(null)

    let spec: Record<string, unknown> = {}
    if (specYaml.trim()) {
      try {
        spec = parseSimpleYaml(specYaml)
      } catch (err) {
        setParseError(
          err instanceof Error ? err.message : 'Invalid YAML format',
        )
        return
      }
    }

    const yaml = policyToYaml({
      name,
      spec,
      annotations: {},
      labels: {},
    })
    setGeneratedYaml(yaml)
  }, [name, specYaml])

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
          <SheetTitle>Generate Policy Manifest</SheetTitle>
          <SheetDescription>
            Define a sandbox policy and generate its manifest.
          </SheetDescription>
        </SheetHeader>

        <form
          onSubmit={(e) => { e.preventDefault(); handleGenerate() }}
          className="flex flex-col gap-4 px-4 pb-4"
        >
          <div className="space-y-1.5">
            <label htmlFor="policy-name" className="text-sm font-medium">
              Name *
            </label>
            <Input
              id="policy-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="restricted-github-only"
            />
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <label htmlFor="policy-spec" className="text-sm font-medium">
                Policy Spec (YAML)
              </label>
              <a
                href="https://docs.nvidia.com/openshell/sandboxes/policies"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
              >
                Docs <ExternalLink className="size-3" />
              </a>
            </div>
            <Textarea
              id="policy-spec"
              value={specYaml}
              onChange={(e) => setSpecYaml(e.target.value)}
              placeholder="filesystem:&#10;  read_write: [/sandbox, /tmp]"
              className="min-h-64 font-mono text-sm"
            />
            <p className="text-xs text-muted-foreground">
              The spec fields are included inline in the manifest.
            </p>
            {parseError && (
              <p className="text-xs text-destructive">{parseError}</p>
            )}
          </div>

          {generatedYaml && (
            <YamlPreview
              yaml={generatedYaml}
              name={name}
              kind="policy"
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

function parseSimpleYaml(text: string): Record<string, unknown> {
  const lines = text.split('\n')
  const result: Record<string, unknown> = {}
  const stack: { indent: number; obj: Record<string, unknown> }[] = [
    { indent: -1, obj: result },
  ]

  for (const line of lines) {
    if (!line.trim() || line.trim().startsWith('#')) continue

    const indent = line.search(/\S/)
    const content = line.trim()

    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) {
      stack.pop()
    }

    const parent = stack[stack.length - 1].obj

    if (content.startsWith('- ')) {
      const lastKey = Object.keys(parent).pop()
      if (lastKey && Array.isArray(parent[lastKey])) {
        ;(parent[lastKey] as unknown[]).push(content.slice(2))
      }
      continue
    }

    const colonIdx = content.indexOf(':')
    if (colonIdx === -1) continue

    const key = content.slice(0, colonIdx).trim()
    const value = content.slice(colonIdx + 1).trim()

    if (value === '' || value === '|') {
      const child: Record<string, unknown> = {}
      parent[key] = child
      stack.push({ indent, obj: child })
    } else if (value.startsWith('[') || value.startsWith('{')) {
      try {
        parent[key] = JSON.parse(value)
      } catch {
        parent[key] = value
      }
    } else {
      const nextLine = lines[lines.indexOf(line) + 1]
      if (nextLine && nextLine.trim().startsWith('- ')) {
        parent[key] = [] as unknown[]
      } else {
        parent[key] = value
      }
    }
  }

  return result
}
