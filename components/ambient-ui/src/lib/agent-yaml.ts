import type { DomainAgent, DomainPayload, DomainSandboxTemplate } from '@/domain/types'

export type ConfigMapAgentInput = {
  name: string
  namespace: string
  displayName?: string
  description?: string
  model?: string
  prompt?: string
  repoUrl?: string
  entrypoint?: string
  providers?: string[]
  payloads?: DomainPayload[]
  environment?: Record<string, string>
  sandboxTemplate?: DomainSandboxTemplate
  sandboxPolicy?: string
}

export function agentToYaml(agent: DomainAgent): string {
  const lines: string[] = [
    'apiVersion: ambient-code.io/v1',
    'kind: Agent',
    'metadata:',
    `  name: ${agent.name}`,
  ]

  const annotationEntries = Object.entries(agent.annotations)
  if (annotationEntries.length > 0) {
    lines.push('  annotations:')
    for (const [key, value] of annotationEntries) {
      lines.push(`    ${key}: "${value}"`)
    }
  }

  const labelEntries = Object.entries(agent.labels)
  if (labelEntries.length > 0) {
    lines.push('  labels:')
    for (const [key, value] of labelEntries) {
      lines.push(`    ${key}: "${value}"`)
    }
  }

  lines.push('spec:')
  if (agent.displayName) lines.push(`  displayName: "${agent.displayName}"`)
  if (agent.description) lines.push(`  description: "${agent.description}"`)
  if (agent.model) lines.push(`  model: ${agent.model}`)
  if (agent.repoUrl) lines.push(`  repoUrl: ${agent.repoUrl}`)
  if (agent.workflowId) lines.push(`  workflowId: ${agent.workflowId}`)
  if (agent.entrypoint) lines.push(`  entrypoint: ${agent.entrypoint}`)
  if (agent.sandboxPolicy) lines.push(`  sandboxPolicy: ${agent.sandboxPolicy}`)
  if (agent.prompt) {
    lines.push('  prompt: |')
    for (const promptLine of agent.prompt.split('\n')) {
      lines.push(`    ${promptLine}`)
    }
  }
  if (agent.providers.length > 0) {
    lines.push('  providers:')
    for (const p of agent.providers) {
      lines.push(`    - ${p}`)
    }
  }
  if (agent.payloads.length > 0) {
    lines.push('  payloads:')
    for (const payload of agent.payloads) {
      lines.push(`    - sandbox_path: ${payload.sandbox_path}`)
      if (payload.repo_url) lines.push(`      repo_url: ${payload.repo_url}`)
      if (payload.ref) lines.push(`      ref: ${payload.ref}`)
      if (payload.content) {
        lines.push('      content: |')
        for (const cl of payload.content.split('\n')) {
          lines.push(`        ${cl}`)
        }
      }
    }
  }
  const envEntries = Object.entries(agent.environment)
  if (envEntries.length > 0) {
    lines.push('  environment:')
    for (const [key, value] of envEntries) {
      lines.push(`    ${key}: "${value}"`)
    }
  }
  if (agent.sandboxTemplate) {
    lines.push('  sandboxTemplate:')
    if (agent.sandboxTemplate.image) lines.push(`    image: ${agent.sandboxTemplate.image}`)
    if (agent.sandboxTemplate.resources) {
      lines.push('    resources:')
      if (agent.sandboxTemplate.resources.cpu) lines.push(`      cpu: "${agent.sandboxTemplate.resources.cpu}"`)
      if (agent.sandboxTemplate.resources.memory) lines.push(`      memory: ${agent.sandboxTemplate.resources.memory}`)
    }
    if (agent.sandboxTemplate.gpu) {
      lines.push('    gpu:')
      if (agent.sandboxTemplate.gpu.count !== undefined) lines.push(`      count: ${agent.sandboxTemplate.gpu.count}`)
    }
  }

  return lines.join('\n') + '\n'
}

export function agentToConfigMapYaml(input: ConfigMapAgentInput): string {
  const dataLines: string[] = []
  dataLines.push(`    name: ${input.name}`)
  if (input.displayName) dataLines.push(`    display_name: ${input.displayName}`)
  if (input.description) dataLines.push(`    description: ${input.description}`)
  if (input.model) dataLines.push(`    model: ${input.model}`)
  if (input.entrypoint) dataLines.push(`    entrypoint: ${input.entrypoint}`)
  if (input.repoUrl) dataLines.push(`    repo_url: ${input.repoUrl}`)
  if (input.prompt) {
    dataLines.push('    prompt: |')
    for (const line of input.prompt.split('\n')) {
      dataLines.push(`      ${line}`)
    }
  }
  if (input.providers && input.providers.length > 0) {
    dataLines.push('    providers:')
    for (const p of input.providers) {
      dataLines.push(`      - ${p}`)
    }
  }
  if (input.payloads && input.payloads.length > 0) {
    dataLines.push('    payloads:')
    for (const payload of input.payloads) {
      dataLines.push(`      - sandbox_path: ${payload.sandbox_path}`)
      if (payload.repo_url) dataLines.push(`        repo_url: ${payload.repo_url}`)
      if (payload.ref) dataLines.push(`        ref: ${payload.ref}`)
      if (payload.content) {
        dataLines.push('        content: |')
        for (const cl of payload.content.split('\n')) {
          dataLines.push(`          ${cl}`)
        }
      }
    }
  }
  const envEntries = Object.entries(input.environment ?? {})
  if (envEntries.length > 0) {
    dataLines.push('    environment:')
    for (const [key, value] of envEntries) {
      dataLines.push(`      ${key}: "${value}"`)
    }
  }
  if (input.sandboxTemplate) {
    const st = input.sandboxTemplate
    const hasFields = st.image || st.resources?.cpu || st.resources?.memory || st.gpu?.count != null
    if (hasFields) {
      dataLines.push('    sandbox_template:')
      if (st.image) dataLines.push(`      image: ${st.image}`)
      if (st.resources?.cpu || st.resources?.memory) {
        dataLines.push('      resources:')
        if (st.resources.cpu) dataLines.push(`        cpu: "${st.resources.cpu}"`)
        if (st.resources.memory) dataLines.push(`        memory: ${st.resources.memory}`)
      }
      if (st.gpu?.count != null) {
        dataLines.push('      gpu:')
        dataLines.push(`        count: ${st.gpu.count}`)
      }
    }
  }
  if (input.sandboxPolicy) dataLines.push(`    sandbox_policy: ${input.sandboxPolicy}`)

  const lines: string[] = [
    'apiVersion: v1',
    'kind: ConfigMap',
    'metadata:',
    `  name: agent-${input.name}`,
    `  namespace: ${input.namespace}`,
    '  labels:',
    '    ambient.ai/kind: agent',
    'data:',
    `  ${input.name}: |`,
    ...dataLines,
  ]

  return lines.join('\n') + '\n'
}
