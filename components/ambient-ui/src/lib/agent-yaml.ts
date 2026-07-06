import type { DomainAgent, DomainPayload } from '@/domain/types'

export type AgentYamlInput = Pick<
  DomainAgent,
  'name' | 'prompt' | 'providers' | 'payloads' | 'environment' | 'labels' | 'annotations'
>

export function agentToYaml(agent: AgentYamlInput): string {
  const lines: string[] = [
    'kind: Agent',
    `name: ${agent.name}`,
  ]

  if (agent.prompt) {
    lines.push('prompt: |')
    for (const promptLine of agent.prompt.split('\n')) {
      lines.push(`  ${promptLine}`)
    }
  }
  if (agent.providers.length > 0) {
    lines.push('providers:')
    for (const p of agent.providers) {
      lines.push(`  - ${p}`)
    }
  }
  if (agent.payloads.length > 0) {
    lines.push('payloads:')
    for (const payload of agent.payloads) {
      lines.push(`  - sandbox_path: ${payload.sandbox_path}`)
      if (payload.repo_url) lines.push(`    repo_url: ${payload.repo_url}`)
      if (payload.ref) lines.push(`    ref: ${payload.ref}`)
      if (payload.content) {
        lines.push('    content: |')
        for (const cl of payload.content.split('\n')) {
          lines.push(`      ${cl}`)
        }
      }
    }
  }
  const envEntries = Object.entries(agent.environment)
  if (envEntries.length > 0) {
    lines.push('environment:')
    for (const [key, value] of envEntries) {
      lines.push(`  ${key}: "${value}"`)
    }
  }

  const labelEntries = Object.entries(agent.labels)
  if (labelEntries.length > 0) {
    lines.push('labels:')
    for (const [key, value] of labelEntries) {
      lines.push(`  ${key}: ${value}`)
    }
  }

  const annotationEntries = Object.entries(agent.annotations).filter(
    ([k]) => !k.startsWith('ambient.ai/'),
  )
  if (annotationEntries.length > 0) {
    lines.push('annotations:')
    for (const [key, value] of annotationEntries) {
      lines.push(`  ${key}: "${value}"`)
    }
  }

  return lines.join('\n') + '\n'
}
