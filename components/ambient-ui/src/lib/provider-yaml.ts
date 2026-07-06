import type { DomainProvider } from '@/domain/types'

export type ProviderYamlInput = Pick<
  DomainProvider,
  'name' | 'type' | 'secret' | 'labels' | 'annotations'
>

export function providerToYaml(provider: ProviderYamlInput): string {
  const lines: string[] = [
    'kind: Provider',
    `name: ${provider.name}`,
  ]
  if (provider.type) lines.push(`type: ${provider.type}`)
  if (provider.secret) lines.push(`secret: ${provider.secret}`)

  const labelEntries = Object.entries(provider.labels)
  if (labelEntries.length > 0) {
    lines.push('labels:')
    for (const [key, value] of labelEntries) {
      lines.push(`  ${key}: ${value}`)
    }
  }

  const annotationEntries = Object.entries(provider.annotations).filter(
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
