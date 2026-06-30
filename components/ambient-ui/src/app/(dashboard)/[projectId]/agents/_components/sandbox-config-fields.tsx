'use client'

import { useState } from 'react'
import { Plus, X, ChevronDown, ChevronRight } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Button } from '@/components/ui/button'

export type PayloadRow = {
  sandboxPath: string
  repoUrl: string
  ref: string
  content: string
}

export type SandboxConfigState = {
  namespace: string
  entrypoint: string
  providers: string
  sandboxPolicy: string
  image: string
  cpu: string
  memory: string
  envRows: { key: string; value: string }[]
  payloadRows: PayloadRow[]
}

export const INITIAL_SANDBOX_CONFIG: SandboxConfigState = {
  namespace: '',
  entrypoint: '',
  providers: '',
  sandboxPolicy: '',
  image: '',
  cpu: '',
  memory: '',
  envRows: [],
  payloadRows: [],
}

export function SandboxConfigFields({
  state,
  onChange,
}: {
  state: SandboxConfigState
  onChange: (state: SandboxConfigState) => void
}) {
  const [expanded, setExpanded] = useState(false)

  function update(partial: Partial<SandboxConfigState>) {
    onChange({ ...state, ...partial })
  }

  function addEnvRow() {
    onChange({ ...state, envRows: [...state.envRows, { key: '', value: '' }] })
  }

  function removeEnvRow(index: number) {
    const next = state.envRows.filter((_, i) => i !== index)
    onChange({ ...state, envRows: next })
  }

  function updateEnvRow(index: number, field: 'key' | 'value', val: string) {
    const next = state.envRows.map((row, i) =>
      i === index ? { ...row, [field]: val } : row
    )
    onChange({ ...state, envRows: next })
  }

  function addPayloadRow() {
    onChange({
      ...state,
      payloadRows: [...state.payloadRows, { sandboxPath: '', repoUrl: '', ref: '', content: '' }],
    })
  }

  function removePayloadRow(index: number) {
    const next = state.payloadRows.filter((_, i) => i !== index)
    onChange({ ...state, payloadRows: next })
  }

  function updatePayloadRow(index: number, field: keyof PayloadRow, val: string) {
    const next = state.payloadRows.map((row, i) =>
      i === index ? { ...row, [field]: val } : row
    )
    onChange({ ...state, payloadRows: next })
  }

  return (
    <div className="space-y-3">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="w-full justify-start text-sm font-medium px-0"
        onClick={() => setExpanded(!expanded)}
      >
        {expanded ? <ChevronDown className="size-4 mr-1" /> : <ChevronRight className="size-4 mr-1" />}
        Sandbox Configuration (optional)
      </Button>

      {expanded && (
        <div className="space-y-4 pl-1">
          <div className="space-y-1.5">
            <label htmlFor="sandbox-namespace" className="text-sm font-medium">
              Namespace <span className="text-destructive">*</span>
            </label>
            <Input
              id="sandbox-namespace"
              placeholder="tenant-a"
              value={state.namespace}
              onChange={(e) => update({ namespace: e.target.value })}
            />
          </div>

          <div className="space-y-1.5">
            <label htmlFor="sandbox-entrypoint" className="text-sm font-medium">
              Entrypoint
            </label>
            <Input
              id="sandbox-entrypoint"
              placeholder="claude"
              value={state.entrypoint}
              onChange={(e) => update({ entrypoint: e.target.value })}
            />
          </div>

          <div className="space-y-1.5">
            <label htmlFor="sandbox-providers" className="text-sm font-medium">
              Providers (comma-separated)
            </label>
            <Input
              id="sandbox-providers"
              placeholder="github, anthropic"
              value={state.providers}
              onChange={(e) => update({ providers: e.target.value })}
            />
          </div>

          <div className="space-y-1.5">
            <label htmlFor="sandbox-policy" className="text-sm font-medium">
              Sandbox Policy
            </label>
            <Input
              id="sandbox-policy"
              placeholder="restricted-github-only"
              value={state.sandboxPolicy}
              onChange={(e) => update({ sandboxPolicy: e.target.value })}
            />
          </div>

          <div className="space-y-1.5">
            <label htmlFor="sandbox-image" className="text-sm font-medium">
              Image
            </label>
            <Input
              id="sandbox-image"
              placeholder="quay.io/ambient_code/ambient_runner_openshell:latest"
              value={state.image}
              onChange={(e) => update({ image: e.target.value })}
            />
            <p className="text-xs text-muted-foreground">
              Images must be from an allowed registry: <code className="text-[11px] bg-muted px-1 py-0.5 rounded">quay.io/ambient_code/</code> or <code className="text-[11px] bg-muted px-1 py-0.5 rounded">ghcr.io/nvidia/</code>. Images from other registries will be rejected.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label htmlFor="sandbox-cpu" className="text-sm font-medium">
                CPU
              </label>
              <Input
                id="sandbox-cpu"
                placeholder="2"
                value={state.cpu}
                onChange={(e) => update({ cpu: e.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="sandbox-memory" className="text-sm font-medium">
                Memory
              </label>
              <Input
                id="sandbox-memory"
                placeholder="4Gi"
                value={state.memory}
                onChange={(e) => update({ memory: e.target.value })}
              />
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium">Payloads</label>
              <Button type="button" variant="ghost" size="sm" onClick={addPayloadRow}>
                <Plus className="size-4 mr-1" />
                Add
              </Button>
            </div>
            {state.payloadRows.map((row, i) => (
              <div key={i} className="space-y-2 rounded-md border p-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-muted-foreground">Payload {i + 1}</span>
                  <Button type="button" variant="ghost" size="icon" className="size-6" onClick={() => removePayloadRow(i)}>
                    <X className="size-3" />
                  </Button>
                </div>
                <div className="space-y-1">
                  <label className="text-xs text-muted-foreground">Sandbox path</label>
                  <Input
                    placeholder="/sandbox/workspace"
                    value={row.sandboxPath}
                    onChange={(e) => updatePayloadRow(i, 'sandboxPath', e.target.value)}
                    className="font-mono text-sm"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-xs text-muted-foreground">Repository URL</label>
                  <div className="grid grid-cols-[1fr_auto] gap-2">
                    <Input
                      placeholder="https://github.com/org/repo"
                      value={row.repoUrl}
                      onChange={(e) => {
                        updatePayloadRow(i, 'repoUrl', e.target.value)
                        if (e.target.value.trim()) {
                          updatePayloadRow(i, 'content', '')
                        }
                      }}
                      className="text-sm"
                      disabled={!!row.content.trim()}
                    />
                    <Input
                      placeholder="ref (main)"
                      value={row.ref}
                      onChange={(e) => updatePayloadRow(i, 'ref', e.target.value)}
                      className="font-mono text-sm w-28"
                      disabled={!!row.content.trim()}
                    />
                  </div>
                </div>
                <div className="flex items-center gap-2 py-0.5">
                  <div className="h-px flex-1 bg-border" />
                  <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">or</span>
                  <div className="h-px flex-1 bg-border" />
                </div>
                <div className="space-y-1">
                  <label className="text-xs text-muted-foreground">Inline content</label>
                  <Textarea
                    placeholder="File content written directly to the sandbox path"
                    value={row.content}
                    onChange={(e) => {
                      updatePayloadRow(i, 'content', e.target.value)
                      if (e.target.value.trim()) {
                        updatePayloadRow(i, 'repoUrl', '')
                        updatePayloadRow(i, 'ref', '')
                      }
                    }}
                    className="min-h-16 font-mono text-xs"
                    disabled={!!row.repoUrl.trim()}
                  />
                </div>
              </div>
            ))}
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium">Environment Variables</label>
              <Button type="button" variant="ghost" size="sm" onClick={addEnvRow}>
                <Plus className="size-4 mr-1" />
                Add
              </Button>
            </div>
            {state.envRows.map((row, i) => (
              <div key={i} className="flex items-center gap-2">
                <Input
                  placeholder="KEY"
                  value={row.key}
                  onChange={(e) => updateEnvRow(i, 'key', e.target.value)}
                  className="font-mono text-sm"
                />
                <Input
                  placeholder="value"
                  value={row.value}
                  onChange={(e) => updateEnvRow(i, 'value', e.target.value)}
                  className="text-sm"
                />
                <Button type="button" variant="ghost" size="icon" className="size-8 shrink-0" onClick={() => removeEnvRow(i)}>
                  <X className="size-4" />
                </Button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
