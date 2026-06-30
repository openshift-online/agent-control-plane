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
import { Textarea } from '@/components/ui/textarea'
import { ConfigMapYamlPreview } from '@/components/configmap-yaml-preview'
import { policyToConfigMapYaml } from '@/lib/policy-yaml'

const POLICY_TEMPLATE = `filesystem:
  read_write:
    - /sandbox
    - /tmp
  read_only:
    - /usr
    - /etc
process:
  run_as_user: sandbox
  run_as_group: sandbox`

export function CreatePolicySheet({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { projectId } = useParams<{ projectId: string }>()

  const [name, setName] = useState('')
  const [namespace, setNamespace] = useState(projectId ?? '')
  const [specYaml, setSpecYaml] = useState(POLICY_TEMPLATE)
  const [generatedYaml, setGeneratedYaml] = useState<string | null>(null)
  const [parseError, setParseError] = useState<string | null>(null)

  function resetForm() {
    setName('')
    setNamespace(projectId ?? '')
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

    const yaml = policyToConfigMapYaml({ name, namespace, spec })
    setGeneratedYaml(yaml)
  }, [name, namespace, specYaml])

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
          <SheetTitle>Generate Policy YAML</SheetTitle>
          <SheetDescription>
            Generate a ConfigMap declaration for a sandbox policy. Apply it with
            kubectl to register the policy.
          </SheetDescription>
        </SheetHeader>

        <div className="space-y-4 py-4">
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
            <label htmlFor="policy-namespace" className="text-sm font-medium">
              Namespace
            </label>
            <Input
              id="policy-namespace"
              value={namespace}
              onChange={(e) => setNamespace(e.target.value)}
              placeholder="tenant-a"
            />
          </div>

          <div className="space-y-1.5">
            <label htmlFor="policy-spec" className="text-sm font-medium">
              Policy Spec (YAML)
            </label>
            <Textarea
              id="policy-spec"
              value={specYaml}
              onChange={(e) => setSpecYaml(e.target.value)}
              placeholder="filesystem:&#10;  read_write:&#10;    - /sandbox"
              className="min-h-48 font-mono text-sm"
            />
            <p className="text-xs text-muted-foreground">
              The spec is included as-is in the ConfigMap data value.
            </p>
            {parseError && (
              <p className="text-xs text-destructive">{parseError}</p>
            )}
          </div>

          {generatedYaml && (
            <ConfigMapYamlPreview
              yaml={generatedYaml}
              name={name}
              kind="policy"
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
