'use client'

import { ConfigMapYamlPreview as SharedPreview } from '@/components/configmap-yaml-preview'

export function ConfigMapYamlPreview({
  yaml,
  agentName,
}: {
  yaml: string
  agentName: string
}) {
  return <SharedPreview yaml={yaml} name={agentName} kind="agent" />
}
