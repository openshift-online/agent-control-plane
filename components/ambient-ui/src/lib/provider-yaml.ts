export type ConfigMapProviderInput = {
  name: string
  namespace: string
  type?: string
  secret?: string
}

export function providerToConfigMapYaml(input: ConfigMapProviderInput): string {
  const dataLines: string[] = []
  dataLines.push(`    name: ${input.name}`)
  if (input.type) dataLines.push(`    type: ${input.type}`)
  if (input.secret) dataLines.push(`    secret: ${input.secret}`)

  const lines: string[] = [
    'apiVersion: v1',
    'kind: ConfigMap',
    'metadata:',
    `  name: provider-${input.name}`,
    `  namespace: ${input.namespace}`,
    '  labels:',
    '    ambient.ai/kind: provider',
    'data:',
    `  ${input.name}: |`,
    ...dataLines,
  ]

  return lines.join('\n') + '\n'
}
