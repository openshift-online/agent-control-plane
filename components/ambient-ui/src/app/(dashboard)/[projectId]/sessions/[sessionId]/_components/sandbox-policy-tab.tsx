'use client'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import type { DomainSession } from '@/domain/types'
import { useSandboxPolicy } from '@/queries/use-sandbox-policy'
import { Copy, Check } from 'lucide-react'
import { useState, useCallback, useMemo } from 'react'

function toYaml(value: unknown, indent = 0): string {
  const pad = '  '.repeat(indent)
  if (value === null || value === undefined) return `${pad}~`
  if (typeof value === 'boolean' || typeof value === 'number') return `${pad}${value}`
  if (typeof value === 'string') return `${pad}${value}`
  if (Array.isArray(value)) {
    if (value.length === 0) return `${pad}[]`
    return value
      .map(item => {
        if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
          const entries = Object.entries(item)
          if (entries.length === 0) return `${pad}- {}`
          const [firstKey, firstVal] = entries[0]
          const rest = entries.slice(1)
          const firstLine = typeof firstVal === 'object' && firstVal !== null
            ? `${pad}- ${firstKey}:\n${toYaml(firstVal, indent + 2)}`
            : `${pad}- ${firstKey}: ${toYaml(firstVal, 0).trim()}`
          if (rest.length === 0) return firstLine
          const restLines = rest
            .map(([k, v]) =>
              typeof v === 'object' && v !== null
                ? `${pad}  ${k}:\n${toYaml(v, indent + 3)}`
                : `${pad}  ${k}: ${toYaml(v, 0).trim()}`,
            )
            .join('\n')
          return `${firstLine}\n${restLines}`
        }
        return `${pad}- ${toYaml(item, 0).trim()}`
      })
      .join('\n')
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
    if (entries.length === 0) return `${pad}{}`
    return entries
      .map(([k, v]) =>
        typeof v === 'object' && v !== null
          ? `${pad}${k}:\n${toYaml(v, indent + 1)}`
          : `${pad}${k}: ${toYaml(v, 0).trim()}`,
      )
      .join('\n')
  }
  return `${pad}${String(value)}`
}

export function SandboxPolicyTab({ session }: { session: DomainSession }) {
  const isActive = session.phase === 'Running'
  const { data: policyResponse, isLoading, error } = useSandboxPolicy(
    session.id,
    isActive,
  )
  const [copied, setCopied] = useState(false)

  const effectivePolicy = policyResponse ?? session.sandboxPolicySnapshot
  const isHistorical = !isActive && !policyResponse && session.sandboxPolicySnapshot !== null

  const policyYaml = useMemo(
    () => (effectivePolicy ? toYaml(effectivePolicy.policy) : ''),
    [effectivePolicy],
  )

  const handleCopy = useCallback(async () => {
    if (!policyYaml) return
    await navigator.clipboard.writeText(policyYaml)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }, [policyYaml])

  if (!isActive && !effectivePolicy) {
    return (
      <div className="pt-4">
        <p className="text-sm text-muted-foreground">
          Sandbox is not running. Policy is available while the sandbox is active.
        </p>
      </div>
    )
  }

  if (error) {
    return (
      <div className="pt-4">
        <p className="text-sm text-muted-foreground">
          Sandbox policy is not available for this session.
        </p>
      </div>
    )
  }

  if (isLoading) {
    return (
      <div className="space-y-4 pt-4">
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-[300px] w-full" />
      </div>
    )
  }

  if (!effectivePolicy) {
    return (
      <div className="pt-4">
        <p className="text-sm text-muted-foreground">
          No sandbox policy found.
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm font-medium">Policy Metadata</CardTitle>
            <div className="flex items-center gap-2">
              {isHistorical && (
                <Badge variant="secondary" className="text-xs">Historical</Badge>
              )}
              <Badge variant="outline" className="text-xs">
                {effectivePolicy.status}
              </Badge>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-4">
            <div>
              <dt className="text-muted-foreground text-xs">Version</dt>
              <dd className="font-mono">{effectivePolicy.version}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground text-xs">Source</dt>
              <dd className="font-mono">{effectivePolicy.source}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground text-xs">Hash</dt>
              <dd className="font-mono truncate" title={effectivePolicy.hash}>
                {effectivePolicy.hash.slice(0, 16)}...
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground text-xs">Config Revision</dt>
              <dd className="font-mono truncate" title={effectivePolicy.config_revision}>
                {effectivePolicy.config_revision.slice(0, 16)}...
              </dd>
            </div>
          </dl>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm font-medium">Policy Configuration</CardTitle>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs gap-1.5"
              onClick={handleCopy}
            >
              {copied ? (
                <>
                  <Check className="size-3" /> Copied
                </>
              ) : (
                <>
                  <Copy className="size-3" /> Copy YAML
                </>
              )}
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <pre className="rounded-md bg-muted p-4 text-xs font-mono overflow-x-auto max-h-[500px] overflow-y-auto whitespace-pre">
            {policyYaml}
          </pre>
        </CardContent>
      </Card>
    </div>
  )
}
