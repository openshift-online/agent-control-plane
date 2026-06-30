export type ConfigMapPolicyInput = {
  name: string
  namespace: string
  spec?: Record<string, unknown>
}

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

export function policyToConfigMapYaml(input: ConfigMapPolicyInput): string {
  const dataLines: string[] = []
  dataLines.push(`    name: ${input.name}`)

  if (input.spec && Object.keys(input.spec).length > 0) {
    const specYaml = yamlValue(input.spec, 4)
    dataLines.push(specYaml)
  }

  const lines: string[] = [
    'apiVersion: v1',
    'kind: ConfigMap',
    'metadata:',
    `  name: policy-${input.name}`,
    `  namespace: ${input.namespace}`,
    '  labels:',
    '    ambient.ai/kind: policy',
    'data:',
    `  ${input.name}: |`,
    ...dataLines,
  ]

  return lines.join('\n') + '\n'
}
