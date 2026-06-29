'use client'

import { useState, useMemo, useCallback } from 'react'
import { useRouter, useParams } from 'next/navigation'
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useCreateAgent } from '@/queries/use-agents'
import type { DomainAgentCreateRequest, DomainPayload } from '@/domain/types'
import { MODEL_OPTIONS } from '@/domain/models'
import { useGatewayMode } from '@/lib/use-gateway-mode'
import { agentToConfigMapYaml } from '@/lib/agent-yaml'
import type { ConfigMapAgentInput } from '@/lib/agent-yaml'
import { SandboxConfigFields, INITIAL_SANDBOX_CONFIG } from './sandbox-config-fields'
import type { SandboxConfigState } from './sandbox-config-fields'
import { ConfigMapYamlPreview } from './configmap-yaml-preview'

export function CreateAgentSheet({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const router = useRouter()
  const { projectId } = useParams<{ projectId: string }>()
  const createAgent = useCreateAgent()
  const gatewayMode = useGatewayMode()

  const [name, setName] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [model, setModel] = useState('')
  const [prompt, setPrompt] = useState('')
  const [repoUrl, setRepoUrl] = useState('')
  const [description, setDescription] = useState('')
  const [error, setError] = useState<string | null>(null)

  const [sandboxConfig, setSandboxConfig] = useState<SandboxConfigState>({
    ...INITIAL_SANDBOX_CONFIG,
    namespace: projectId ?? '',
  })
  const [generatedYaml, setGeneratedYaml] = useState<string | null>(null)

  function resetForm() {
    setName('')
    setDisplayName('')
    setModel('')
    setPrompt('')
    setRepoUrl('')
    setDescription('')
    setError(null)
    setSandboxConfig({ ...INITIAL_SANDBOX_CONFIG, namespace: projectId ?? '' })
    setGeneratedYaml(null)
  }

  const buildConfigMapInput = useCallback((): ConfigMapAgentInput => {
    const providers = sandboxConfig.providers
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean)

    const environment: Record<string, string> = {}
    for (const row of sandboxConfig.envRows) {
      if (row.key.trim()) {
        environment[row.key.trim()] = row.value
      }
    }

    const payloads: DomainPayload[] = sandboxConfig.payloadRows
      .filter((row) => row.sandboxPath.trim())
      .map((row) => ({
        sandbox_path: row.sandboxPath.trim(),
        ...(row.repoUrl.trim() ? { repo_url: row.repoUrl.trim() } : {}),
        ...(row.ref.trim() ? { ref: row.ref.trim() } : {}),
        ...(!row.repoUrl.trim() && row.content.trim() ? { content: row.content.trim() } : {}),
      }))

    return {
      name: name.trim(),
      namespace: sandboxConfig.namespace.trim() || projectId,
      ...(displayName.trim() ? { displayName: displayName.trim() } : {}),
      ...(description.trim() ? { description: description.trim() } : {}),
      ...(model ? { model } : {}),
      ...(prompt.trim() ? { prompt: prompt.trim() } : {}),
      ...(repoUrl.trim() ? { repoUrl: repoUrl.trim() } : {}),
      ...(sandboxConfig.entrypoint.trim() ? { entrypoint: sandboxConfig.entrypoint.trim() } : {}),
      ...(providers.length > 0 ? { providers } : {}),
      ...(payloads.length > 0 ? { payloads } : {}),
      ...(Object.keys(environment).length > 0 ? { environment } : {}),
      ...(sandboxConfig.sandboxPolicy.trim() ? { sandboxPolicy: sandboxConfig.sandboxPolicy.trim() } : {}),
      ...((sandboxConfig.image.trim() || sandboxConfig.cpu.trim() || sandboxConfig.memory.trim()) ? {
        sandboxTemplate: {
          ...(sandboxConfig.image.trim() ? { image: sandboxConfig.image.trim() } : {}),
          ...((sandboxConfig.cpu.trim() || sandboxConfig.memory.trim()) ? {
            resources: {
              ...(sandboxConfig.cpu.trim() ? { cpu: sandboxConfig.cpu.trim() } : {}),
              ...(sandboxConfig.memory.trim() ? { memory: sandboxConfig.memory.trim() } : {}),
            },
          } : {}),
        },
      } : {}),
    }
  }, [name, displayName, description, model, prompt, repoUrl, sandboxConfig, projectId])

  function handleGenerateYaml(e: React.FormEvent) {
    e.preventDefault()
    setError(null)

    if (!name.trim()) {
      setError('Name is required.')
      return
    }
    if (!sandboxConfig.namespace.trim()) {
      setError('Namespace is required.')
      return
    }

    const yaml = agentToConfigMapYaml(buildConfigMapInput())
    setGeneratedYaml(yaml)
  }

  async function handleSubmitApi(e: React.FormEvent) {
    e.preventDefault()
    setError(null)

    if (!name.trim()) {
      setError('Name is required.')
      return
    }

    const request: DomainAgentCreateRequest = {
      name: name.trim(),
      projectId,
    }

    if (displayName.trim()) request.displayName = displayName.trim()
    if (model) request.model = model
    if (prompt.trim()) request.prompt = prompt.trim()
    if (repoUrl.trim()) request.repoUrl = repoUrl.trim()
    if (description.trim()) request.description = description.trim()

    try {
      const agent = await createAgent.mutateAsync({ projectId, request })
      resetForm()
      onOpenChange(false)
      router.push(`/${projectId}/agents/${agent.id}`)
    } catch (err) {
      console.error('create agent failed', err)
      setError('Failed to create agent. Please try again.')
    }
  }

  const previewYaml = useMemo(() => {
    if (!gatewayMode || !name.trim()) return null
    try {
      return agentToConfigMapYaml(buildConfigMapInput())
    } catch {
      return null
    }
  }, [gatewayMode, name, buildConfigMapInput])

  return (
    <Sheet open={open} onOpenChange={(v) => { if (!v) resetForm(); onOpenChange(v) }}>
      <SheetContent side="right" className="sm:max-w-lg overflow-y-auto">
        <SheetHeader>
          <SheetTitle>{gatewayMode ? 'Generate Agent YAML' : 'New Agent'}</SheetTitle>
          <SheetDescription>
            {gatewayMode
              ? 'Define an agent and generate a ConfigMap YAML for kubectl apply.'
              : 'Create a new agent definition in this project.'}
          </SheetDescription>
        </SheetHeader>

        <form
          onSubmit={gatewayMode ? handleGenerateYaml : handleSubmitApi}
          className="flex flex-col gap-4 px-4 pb-4"
        >
          <div className="space-y-1.5">
            <label htmlFor="agent-name" className="text-sm font-medium">
              Name <span className="text-destructive">*</span>
            </label>
            <Input
              id="agent-name"
              placeholder="my-agent"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />
          </div>

          <div className="space-y-1.5">
            <label htmlFor="agent-display-name" className="text-sm font-medium">
              Display Name
            </label>
            <Input
              id="agent-display-name"
              placeholder="My Agent"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
            />
          </div>

          <div className="space-y-1.5">
            <label htmlFor="agent-model" className="text-sm font-medium">
              Model
            </label>
            <Select value={model} onValueChange={setModel}>
              <SelectTrigger id="agent-model" className="w-full">
                <SelectValue placeholder="Select a model (optional)" />
              </SelectTrigger>
              <SelectContent>
                {MODEL_OPTIONS.map((m) => (
                  <SelectItem key={m} value={m}>
                    {m}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <label htmlFor="agent-prompt" className="text-sm font-medium">
              Prompt
            </label>
            <Textarea
              id="agent-prompt"
              placeholder="System prompt for the agent..."
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              className="min-h-24 font-mono text-sm"
            />
          </div>

          <div className="space-y-1.5">
            <label htmlFor="agent-repo-url" className="text-sm font-medium">
              Repository URL
            </label>
            <Input
              id="agent-repo-url"
              placeholder="https://github.com/org/repo"
              value={repoUrl}
              onChange={(e) => setRepoUrl(e.target.value)}
            />
          </div>

          <div className="space-y-1.5">
            <label htmlFor="agent-description" className="text-sm font-medium">
              Description
            </label>
            <Textarea
              id="agent-description"
              placeholder="What does this agent do?"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="min-h-20"
            />
          </div>

          {gatewayMode && (
            <SandboxConfigFields
              state={sandboxConfig}
              onChange={setSandboxConfig}
            />
          )}

          {error && (
            <p className="text-sm text-destructive">{error}</p>
          )}

          {gatewayMode && generatedYaml && (
            <ConfigMapYamlPreview yaml={generatedYaml} agentName={name.trim()} />
          )}

          <SheetFooter className="px-0">
            <Button
              type="button"
              variant="outline"
              onClick={() => { resetForm(); onOpenChange(false) }}
            >
              Cancel
            </Button>
            {gatewayMode ? (
              <Button type="submit" disabled={!name.trim()}>
                Generate YAML
              </Button>
            ) : (
              <Button
                type="submit"
                disabled={createAgent.isPending || !name.trim()}
              >
                {createAgent.isPending ? 'Creating...' : 'Create Agent'}
              </Button>
            )}
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  )
}
