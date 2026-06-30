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
import type { DomainProvider } from '@/domain/types'
import { providerToConfigMapYaml } from '@/lib/provider-yaml'

type ConfigRow = { label: string; value: React.ReactNode; mono?: boolean }

export function ProviderManifestTab({ provider }: { provider: DomainProvider }) {
  const [copied, setCopied] = useState(false)

  const sourceNamespace =
    provider.annotations['ambient.ai/source-namespace'] ?? provider.namespace

  const yaml = useMemo(
    () =>
      providerToConfigMapYaml({
        name: provider.name,
        namespace: sourceNamespace,
        type: provider.type || undefined,
        secret: provider.secret || undefined,
      }),
    [provider, sourceNamespace],
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
    link.download = `provider-${provider.name}.yaml`
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    URL.revokeObjectURL(url)
  }, [yaml, provider.name])

  const configRows: ConfigRow[] = [
    { label: 'Name', value: provider.name, mono: true },
  ]
  if (provider.type) configRows.push({ label: 'Type', value: provider.type })
  if (provider.secret)
    configRows.push({ label: 'Secret', value: provider.secret, mono: true })
  configRows.push({ label: 'Namespace', value: sourceNamespace, mono: true })

  return (
    <div className="space-y-6 pt-4">
      <div className="flex items-start gap-3 rounded-md border border-muted bg-muted/50 p-4">
        <Info className="size-5 shrink-0 text-muted-foreground mt-0.5" />
        <div>
          <p className="text-sm font-medium">GitOps-managed provider</p>
          <p className="text-sm text-muted-foreground">
            This provider is managed via GitOps in namespace{' '}
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
