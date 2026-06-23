import { AlertTriangle } from 'lucide-react'
import type { DomainCondition } from '@/domain/types'

type SessionConditionsProps = {
  conditions: DomainCondition[]
}

export function SessionConditions({ conditions }: SessionConditionsProps) {
  const failedConditions = conditions.filter(c => c.status === 'False')

  if (failedConditions.length === 0) return null

  return (
    <div className="space-y-2">
      {failedConditions.map((condition, i) => (
        <div
          key={`${condition.type}-${i}`}
          className="flex items-start gap-3 rounded-md border border-status-error/40 bg-status-error/10 px-4 py-3"
          role="alert"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-status-error-foreground" aria-hidden="true" />
          <div className="min-w-0 flex-1 text-sm">
            <p className="font-medium text-status-error-foreground">
              {condition.reason ?? condition.type} failed
            </p>
            {condition.message && (
              <p className="mt-1 text-muted-foreground break-words">
                {condition.message}
              </p>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}
