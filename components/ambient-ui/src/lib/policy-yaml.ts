import type { DomainPolicy } from '@/domain/types'

export type PolicyYamlInput = Pick<
  DomainPolicy,
  'name' | 'spec' | 'labels' | 'annotations'
>

function yamlValue(value: unknown, indent: number): string {
  const pad = ' '.repeat(indent)
  if (value === null || value === undefined) return `${pad}~`
  if (typeof value === 'string') return `${pad}${value}`
  if (typeof value === 'number' || typeof value === 'boolean') return `${pad}${String(value)}`

  if (Array.isArray(value)) {
    if (value.length === 0) return `${pad}[]`
    return value
      .map((item) => {
        if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
          const entries = Object.entries(item as Record<string, unknown>)
          if (entries.length === 0) return `${pad}- {}`
          const [firstKey, firstVal] = entries[0]
          const firstLine = `${pad}- ${firstKey}: ${typeof firstVal === 'object' ? '' : String(firstVal)}`
          const rest = entries.slice(1).map(([k, v]) => yamlValue({ [k]: v }, indent + 2)).join('\n')
          return rest ? `${firstLine}\n${rest}` : firstLine
        }
        return `${pad}- ${String(item)}`
      })
      .join('\n')
  }

  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
    if (entries.length === 0) return `${pad}{}`
    return entries
      .map(([key, val]) => {
        if (typeof val === 'object' && val !== null) {
          return `${pad}${key}:\n${yamlValue(val, indent + 2)}`
        }
        return `${pad}${key}: ${String(val)}`
      })
      .join('\n')
  }

  return `${pad}${String(value)}`
}

export function policyToYaml(policy: PolicyYamlInput): string {
  const lines: string[] = [
    'kind: Policy',
    `name: ${policy.name}`,
  ]

  if (policy.spec && Object.keys(policy.spec).length > 0) {
    const specYaml = yamlValue(policy.spec, 0)
    lines.push(specYaml)
  }

  const labelEntries = Object.entries(policy.labels)
  if (labelEntries.length > 0) {
    lines.push('labels:')
    for (const [key, value] of labelEntries) {
      lines.push(`  ${key}: ${value}`)
    }
  }

  const annotationEntries = Object.entries(policy.annotations).filter(
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
