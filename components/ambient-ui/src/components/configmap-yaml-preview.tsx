'use client'

import { useState, useCallback } from 'react'
import { Copy, Download, Check } from 'lucide-react'
import { Button } from '@/components/ui/button'

export function ConfigMapYamlPreview({
  yaml,
  name,
  kind,
}: {
  yaml: string
  name: string
  kind: string
}) {
  const [copied, setCopied] = useState(false)

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
    link.download = `${kind}-${name}.yaml`
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    URL.revokeObjectURL(url)
  }, [yaml, name, kind])

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium">Generated ConfigMap</p>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={handleCopy}>
            {copied ? (
              <><Check className="size-4 mr-1.5" />Copied</>
            ) : (
              <><Copy className="size-4 mr-1.5" />Copy</>
            )}
          </Button>
          <Button variant="outline" size="sm" onClick={handleDownload}>
            <Download className="size-4 mr-1.5" />
            Download
          </Button>
        </div>
      </div>
      <pre className="whitespace-pre-wrap rounded-md bg-muted p-4 text-sm font-mono overflow-x-auto max-h-80 overflow-y-auto">
        {yaml}
      </pre>
      <p className="text-xs text-muted-foreground">
        Apply with: <code className="bg-muted px-1 py-0.5 rounded">kubectl apply -f {kind}-{name}.yaml</code>
      </p>
    </div>
  )
}
