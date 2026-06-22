'use client'

import { Badge } from '@/components/ui/badge'
import { useSession } from '@/queries/use-sessions'
import type { DomainAgent } from '@/domain/types'

type AgentAnnotationsTabProps = {
  agent: DomainAgent
}

function AnnotationTable({
  title,
  annotations,
  emptyMessage,
}: {
  title: string
  annotations: Record<string, string>
  emptyMessage: string
}) {
  const entries = Object.entries(annotations).sort(([a], [b]) => a.localeCompare(b))

  return (
    <div>
      <h3 className="mb-2 text-xs font-bold uppercase tracking-wider text-muted-foreground">
        {title}
        {entries.length > 0 && (
          <Badge variant="secondary" className="ml-2 text-[0.625rem]">
            {entries.length}
          </Badge>
        )}
      </h3>
      {entries.length === 0 ? (
        <p className="rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">
          {emptyMessage}
        </p>
      ) : (
        <div className="rounded-lg border">
          <table className="w-full">
            <thead>
              <tr className="border-b text-left text-xs font-medium text-muted-foreground">
                <th className="px-3 py-2 font-medium">Key</th>
                <th className="px-3 py-2 font-medium">Value</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {entries.map(([key, value]) => (
                <tr key={key} className="transition-colors hover:bg-accent/50">
                  <td className="px-3 py-2 align-top font-mono text-xs text-foreground">
                    {key}
                  </td>
                  <td className="max-w-md px-3 py-2 align-top font-mono text-xs text-muted-foreground">
                    <span className="whitespace-pre-wrap break-all">{value}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

export function AgentAnnotationsTab({ agent }: AgentAnnotationsTabProps) {
  const { data: session } = useSession(agent.currentSessionId ?? '')

  return (
    <div className="space-y-6">
      <AnnotationTable
        title="Agent Annotations"
        annotations={agent.annotations}
        emptyMessage="No annotations on the agent"
      />
      {agent.currentSessionId && (
        <AnnotationTable
          title="Current Session Annotations"
          annotations={session?.annotations ?? {}}
          emptyMessage={session ? 'No annotations on the current session' : 'Loading session...'}
        />
      )}
      {!agent.currentSessionId && (
        <p className="text-sm text-muted-foreground">No active session</p>
      )}
    </div>
  )
}
