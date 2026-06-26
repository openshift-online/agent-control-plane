'use client'

import { useState } from 'react'
import { AlertTriangle, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { DomainCondition } from '@/domain/types'

const CONDITION_TITLES: Record<string, string> = {
  SetupFailed: 'Setup Failed',
  StartupFailed: 'Startup Failed',
  Error: 'Error',
  OOMKilled: 'Out of Memory',
}

function formatConditionTitle(condition: DomainCondition): string {
  const title = (condition.reason && CONDITION_TITLES[condition.reason]) || 'Error'
  if (condition.message) {
    return `${title}: ${condition.message}`
  }
  return title
}

type SessionConditionsProps = {
  conditions: DomainCondition[]
}

export function SessionConditions({ conditions }: SessionConditionsProps) {
  const [dismissed, setDismissed] = useState<Set<number>>(new Set())
  const failedConditions = conditions.filter(c => c.status === 'False')
  const visibleConditions = failedConditions.filter((_, i) => !dismissed.has(i))

  if (visibleConditions.length === 0) return null

  return (
    <div className="space-y-2">
      {failedConditions.map((condition, i) => {
        if (dismissed.has(i)) return null
        return (
          <div
            key={`${condition.type}-${i}`}
            className="flex items-start gap-3 rounded-md border border-status-error/40 bg-status-error/10 px-4 py-3"
            role="alert"
          >
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-status-error-foreground" aria-hidden="true" />
            <p className="min-w-0 flex-1 text-sm text-status-error-foreground break-words">
              {formatConditionTitle(condition)}
            </p>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setDismissed(prev => new Set([...prev, i]))}
              className="mt-0.5 h-6 w-6 shrink-0 text-status-error-foreground/60 hover:text-status-error-foreground hover:bg-status-error/20"
              aria-label="Dismiss"
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        )
      })}
    </div>
  )
}
