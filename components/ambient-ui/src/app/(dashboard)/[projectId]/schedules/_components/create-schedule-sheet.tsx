'use client'

import { useState, useMemo, useEffect } from 'react'
import { useParams } from 'next/navigation'
import cronstrue from 'cronstrue'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { useAgents } from '@/queries/use-agents'
import { useCreateScheduledSession, useUpdateScheduledSession } from '@/queries/use-scheduled-sessions'
import type { DomainScheduledSession, DomainScheduledSessionCreateRequest, DomainScheduledSessionUpdateRequest, OverlapPolicy } from '@/domain/types'

const COMMON_TIMEZONES = [
  'UTC', 'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles',
  'Europe/London', 'Europe/Berlin', 'Europe/Paris', 'Asia/Tokyo', 'Asia/Shanghai',
  'Asia/Kolkata', 'Australia/Sydney', 'Pacific/Auckland',
]

type CreateScheduleSheetProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  editTarget?: DomainScheduledSession | null
}

export function CreateScheduleSheet({ open, onOpenChange, editTarget }: CreateScheduleSheetProps) {
  const { projectId } = useParams<{ projectId: string }>()
  const { data: agentsData } = useAgents(projectId, { size: 100 })
  const createMutation = useCreateScheduledSession()
  const updateMutation = useUpdateScheduledSession()

  const isEdit = !!editTarget

  const [name, setName] = useState(editTarget?.name ?? '')
  const [agentId, setAgentId] = useState(editTarget?.agentId ?? '')
  const [schedule, setSchedule] = useState(editTarget?.schedule ?? '')
  const [timezone, setTimezone] = useState(editTarget?.timezone ?? 'UTC')
  const [prompt, setPrompt] = useState(editTarget?.sessionPrompt ?? '')
  const [enabled, setEnabled] = useState(editTarget?.enabled ?? true)
  const [overlapPolicy, setOverlapPolicy] = useState<OverlapPolicy>(editTarget?.overlapPolicy ?? 'skip')
  const [timeout, setTimeout] = useState(editTarget?.timeout?.toString() ?? '')
  const [inactivityTimeout, setInactivityTimeout] = useState(editTarget?.inactivityTimeout?.toString() ?? '')
  const [stopOnRunFinished, setStopOnRunFinished] = useState(editTarget?.stopOnRunFinished ?? true)
  const [description, setDescription] = useState(editTarget?.description ?? '')
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const agents = agentsData?.items ?? []

  useEffect(() => {
    setName(editTarget?.name ?? '')
    setAgentId(editTarget?.agentId ?? '')
    setSchedule(editTarget?.schedule ?? '')
    setTimezone(editTarget?.timezone ?? 'UTC')
    setPrompt(editTarget?.sessionPrompt ?? '')
    setEnabled(editTarget?.enabled ?? true)
    setOverlapPolicy(editTarget?.overlapPolicy ?? 'skip')
    setTimeout(editTarget?.timeout?.toString() ?? '')
    setInactivityTimeout(editTarget?.inactivityTimeout?.toString() ?? '')
    setStopOnRunFinished(editTarget?.stopOnRunFinished ?? true)
    setDescription(editTarget?.description ?? '')
    setShowAdvanced(false)
    setError(null)
  }, [editTarget])

  const cronHint = useMemo(() => {
    if (!schedule.trim()) return null
    try {
      return cronstrue.toString(schedule.trim(), { use24HourTimeFormat: false })
    } catch {
      return null
    }
  }, [schedule])

  function resetForm() {
    setName(editTarget?.name ?? '')
    setAgentId(editTarget?.agentId ?? '')
    setSchedule(editTarget?.schedule ?? '')
    setTimezone(editTarget?.timezone ?? 'UTC')
    setPrompt(editTarget?.sessionPrompt ?? '')
    setEnabled(editTarget?.enabled ?? true)
    setOverlapPolicy(editTarget?.overlapPolicy ?? 'skip')
    setTimeout(editTarget?.timeout?.toString() ?? '')
    setInactivityTimeout(editTarget?.inactivityTimeout?.toString() ?? '')
    setStopOnRunFinished(editTarget?.stopOnRunFinished ?? true)
    setDescription(editTarget?.description ?? '')
    setShowAdvanced(false)
    setError(null)
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)

    if (!name.trim()) { setError('Name is required.'); return }
    if (!schedule.trim()) { setError('Schedule (cron expression) is required.'); return }
    if (!agentId) { setError('Agent is required.'); return }

    try {
      if (isEdit && editTarget) {
        const request: DomainScheduledSessionUpdateRequest = {
          name: name.trim(),
          description: description.trim() || undefined,
          agentId: agentId || undefined,
          schedule: schedule.trim(),
          timezone,
          enabled,
          overlapPolicy,
          sessionPrompt: prompt.trim() || undefined,
          timeout: timeout ? parseInt(timeout, 10) : undefined,
          inactivityTimeout: inactivityTimeout ? parseInt(inactivityTimeout, 10) : undefined,
          stopOnRunFinished,
        }
        await updateMutation.mutateAsync({ projectId, id: editTarget.id, request })
      } else {
        const request: DomainScheduledSessionCreateRequest = {
          name: name.trim(),
          projectId,
          agentId: agentId || undefined,
          schedule: schedule.trim(),
          timezone,
          enabled,
          overlapPolicy,
          sessionPrompt: prompt.trim() || undefined,
          timeout: timeout ? parseInt(timeout, 10) : undefined,
          inactivityTimeout: inactivityTimeout ? parseInt(inactivityTimeout, 10) : undefined,
          stopOnRunFinished,
          description: description.trim() || undefined,
        }
        await createMutation.mutateAsync({ projectId, request })
      }
      resetForm()
      onOpenChange(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Operation failed.')
    }
  }

  const isPending = createMutation.isPending || updateMutation.isPending

  return (
    <Sheet open={open} onOpenChange={v => { if (!v) resetForm(); onOpenChange(v) }}>
      <SheetContent side="right" className="sm:max-w-lg overflow-y-auto">
        <SheetHeader>
          <SheetTitle>{isEdit ? 'Edit Schedule' : 'New Schedule'}</SheetTitle>
          <SheetDescription>
            {isEdit ? 'Update the scheduled session configuration.' : 'Create a recurring schedule that triggers agent sessions automatically.'}
          </SheetDescription>
        </SheetHeader>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4 px-4 pb-4">
          <div className="space-y-1.5">
            <label htmlFor="sched-name" className="text-sm font-medium">
              Name <span className="text-destructive">*</span>
            </label>
            <Input id="sched-name" placeholder="nightly-ci" value={name} onChange={e => setName(e.target.value)} required />
          </div>

          <div className="space-y-1.5">
            <label htmlFor="sched-agent" className="text-sm font-medium">
              Agent <span className="text-destructive">*</span>
            </label>
            <Select value={agentId} onValueChange={setAgentId}>
              <SelectTrigger id="sched-agent">
                <SelectValue placeholder="Select an agent" />
              </SelectTrigger>
              <SelectContent>
                {agents.map(agent => (
                  <SelectItem key={agent.id} value={agent.id}>
                    {agent.displayName ?? agent.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <label htmlFor="sched-cron" className="text-sm font-medium">
              Schedule <span className="text-destructive">*</span>
            </label>
            <Input id="sched-cron" placeholder="0 9 * * 1-5" value={schedule} onChange={e => setSchedule(e.target.value)} required />
            {cronHint && (
              <p className="text-xs text-emerald-600 dark:text-emerald-400">{cronHint}</p>
            )}
            <p className="text-xs text-muted-foreground">Standard cron expression (minute hour day month weekday). Examples: <code className="bg-muted px-1 rounded">0 9 * * 1-5</code> = weekdays at 9am, <code className="bg-muted px-1 rounded">*/30 * * * *</code> = every 30 min</p>
          </div>

          <div className="space-y-1.5">
            <label htmlFor="sched-tz" className="text-sm font-medium">Timezone</label>
            <Select value={timezone} onValueChange={setTimezone}>
              <SelectTrigger id="sched-tz">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {COMMON_TIMEZONES.map(tz => (
                  <SelectItem key={tz} value={tz}>{tz}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <label htmlFor="sched-prompt" className="text-sm font-medium">Prompt</label>
            <Textarea
              id="sched-prompt"
              placeholder="Task for each triggered session..."
              value={prompt}
              onChange={e => setPrompt(e.target.value)}
              rows={3}
            />
          </div>

          <div className="space-y-1.5">
            <label htmlFor="sched-desc" className="text-sm font-medium">Description</label>
            <Input id="sched-desc" placeholder="Optional description" value={description} onChange={e => setDescription(e.target.value)} />
          </div>

          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="sched-enabled"
              checked={enabled}
              onChange={e => setEnabled(e.target.checked)}
              className="h-4 w-4 rounded border-gray-300"
            />
            <label htmlFor="sched-enabled" className="text-sm font-medium">Enabled</label>
          </div>

          <button
            type="button"
            className="text-sm text-muted-foreground underline hover:text-foreground text-left"
            onClick={() => setShowAdvanced(prev => !prev)}
          >
            {showAdvanced ? 'Hide advanced settings' : 'Show advanced settings'}
          </button>

          {showAdvanced && (
            <div className="space-y-4 rounded-md border p-4">
              <div className="space-y-1.5">
                <label htmlFor="sched-overlap" className="text-sm font-medium">Overlap Policy</label>
                <Select value={overlapPolicy} onValueChange={v => setOverlapPolicy(v as OverlapPolicy)}>
                  <SelectTrigger id="sched-overlap">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="skip">Skip (default)</SelectItem>
                    <SelectItem value="allow">Allow concurrent</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">Skip: don&apos;t create if previous run is still active</p>
              </div>

              <div className="space-y-1.5">
                <label htmlFor="sched-timeout" className="text-sm font-medium">Timeout (seconds)</label>
                <Input id="sched-timeout" type="number" placeholder="3600" value={timeout} onChange={e => setTimeout(e.target.value)} />
              </div>

              <div className="space-y-1.5">
                <label htmlFor="sched-inactivity" className="text-sm font-medium">Inactivity Timeout (seconds)</label>
                <Input id="sched-inactivity" type="number" placeholder="600" value={inactivityTimeout} onChange={e => setInactivityTimeout(e.target.value)} />
              </div>

              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="sched-stop-on-finish"
                  checked={stopOnRunFinished}
                  onChange={e => setStopOnRunFinished(e.target.checked)}
                  className="h-4 w-4 rounded border-gray-300"
                />
                <label htmlFor="sched-stop-on-finish" className="text-sm font-medium">Stop on run finished</label>
              </div>
            </div>
          )}

          {error && <p className="text-sm text-destructive">{error}</p>}

          <SheetFooter className="px-0">
            <Button type="button" variant="outline" onClick={() => { resetForm(); onOpenChange(false) }}>
              Cancel
            </Button>
            <Button type="submit" disabled={isPending || !name.trim() || !schedule.trim()}>
              {isPending ? (isEdit ? 'Saving...' : 'Creating...') : (isEdit ? 'Save Changes' : 'Create Schedule')}
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  )
}
