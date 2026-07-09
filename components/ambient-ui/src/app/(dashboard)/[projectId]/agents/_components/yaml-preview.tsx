'use client'

import { YamlPreview as SharedPreview } from '@/components/yaml-preview'

export function YamlPreview({
  yaml,
  agentName,
}: {
  yaml: string
  agentName: string
}) {
  return <SharedPreview yaml={yaml} name={agentName} kind="agent" />
}
