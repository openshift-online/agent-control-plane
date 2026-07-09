'use client'

import { useCallback, useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { Button } from '@/components/ui/button'

export function CopyableValue({ value }: { value: string }) {
  const [copied, setCopied] = useState(false)

  const handleCopy = useCallback(async () => {
    await navigator.clipboard.writeText(value)
    setCopied(true)
    globalThis.setTimeout(() => setCopied(false), 2000)
  }, [value])

  return (
    <span className="inline-flex items-center gap-1 font-mono text-xs">
      {value}
      <Button
        variant="ghost"
        size="icon"
        className="size-5"
        onClick={handleCopy}
      >
        {copied ? (
          <Check className="size-3 text-green-500" />
        ) : (
          <Copy className="size-3 text-muted-foreground" />
        )}
      </Button>
    </span>
  )
}
