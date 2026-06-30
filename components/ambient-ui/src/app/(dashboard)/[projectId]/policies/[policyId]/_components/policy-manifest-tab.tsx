'use client'

import { useState, useCallback, useMemo } from 'react'
import { Info, Copy, Download, Check } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import {
  Table,
  TableBody,
  TableCell,
  TableRow,
} from '@/components/ui/table'
import type { DomainPolicy } from '@/domain/types'
import { policyToConfigMapYaml } from '@/lib/policy-yaml'

type ConfigRow = { label: string; value: React.ReactNode; mono?: boolean }

function specToDisplayYaml(obj: Record<string, unknown>, indent = 0): string {
  const pad = ' '.repeat(indent)
  const lines: string[] = []

  for (const [key, value] of Object.entries(obj)) {
    if (value === null || value === undefined) {
      lines.push(`${pad}${key}: ~`)
    } else if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      lines.push(`${pad}${key}: ${String(value)}`)
    } else if (Array.isArray(value)) {
      lines.push(`${pad}${key}:`)
      for (const item of value) {
        if (typeof item === 'object' && item !== null) {
          lines.push(`${pad}  - ${specToDisplayYaml(item as Record<string, unknown>, indent + 4).trimStart()}`)
        } else {
          lines.push(`${pad}  - ${String(item)}`)
        }
      }
    } else if (typeof value === 'object') {
      lines.push(`${pad}${key}:`)
      lines.push(specToDisplayYaml(value as Record<string, unknown>, indent + 2))
    }
  }

  return lines.join('\n')
}

export function PolicyManifestTab({ policy }: { policy: DomainPolicy }) {
  const [copied, setCopied] = useState(false)

  const sourceNamespace =
    policy.annotations['ambient.ai/source-namespace'] ?? policy.namespace

  const yaml = useMemo(
    () =>
      policyToConfigMapYaml({
        name: policy.name,
        namespace: sourceNamespace,
        spec: policy.spec,
      }),
    [policy, sourceNamespace],
  )

  const handleCopy = useCallback(async () => {
    await navigator.clipboard.writeText(yaml)
    setCopied(true)
    globalThis.setTimeout(() => setCopied(false), 2000)
  }, [yaml])

  const handleDownload = useCallback(() => {
    const blob = new Blob([yaml], { type: 'text/yaml' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `policy-${policy.name}.yaml`
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    URL.revokeObjectURL(url)
  }, [yaml, policy.name])

  const configRows: ConfigRow[] = [
    { label: 'Name', value: policy.name, mono: true },
    { label: 'Namespace', value: sourceNamespace, mono: true },
  ]

  const sectionKeys = Object.keys(policy.spec)
  if (sectionKeys.length > 0) {
    configRows.push({
      label: 'Sections',
      value: sectionKeys.join(', '),
    })
  }

  const specYaml = useMemo(
    () =>
      Object.keys(policy.spec).length > 0
        ? specToDisplayYaml(policy.spec)
        : null,
    [policy.spec],
  )

  return (
    <div className="space-y-6 pt-4">
      <div className="flex items-start gap-3 rounded-md border border-muted bg-muted/50 p-4">
        <Info className="size-5 shrink-0 text-muted-foreground mt-0.5" />
        <div>
          <p className="text-sm font-medium">GitOps-managed policy</p>
          <p className="text-sm text-muted-foreground">
            This policy is managed via GitOps in namespace{' '}
            <span className="font-mono">{sourceNamespace}</span>. To modify it,
            update the ConfigMap and re-apply with{' '}
            <span className="font-mono">kubectl apply</span>.
          </p>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Configuration</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableBody>
              {configRows.map((row) => (
                <TableRow key={row.label}>
                  <TableCell className="font-medium text-sm w-40">
                    {row.label}
                  </TableCell>
                  <TableCell
                    className={row.mono ? 'font-mono text-sm' : 'text-sm'}
                  >
                    {row.value}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {specYaml && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Policy Spec</CardTitle>
          </CardHeader>
          <CardContent>
            <pre className="whitespace-pre-wrap rounded-md bg-muted p-4 text-sm font-mono overflow-x-auto">
              {specYaml}
            </pre>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-base">ConfigMap YAML</CardTitle>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={handleCopy}>
                {copied ? (
                  <>
                    <Check className="size-4 mr-1.5" />
                    Copied
                  </>
                ) : (
                  <>
                    <Copy className="size-4 mr-1.5" />
                    Copy
                  </>
                )}
              </Button>
              <Button variant="outline" size="sm" onClick={handleDownload}>
                <Download className="size-4 mr-1.5" />
                Download
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <pre className="whitespace-pre-wrap rounded-md bg-muted p-4 text-sm font-mono overflow-x-auto">
            {yaml}
          </pre>
        </CardContent>
      </Card>
    </div>
  )
}
