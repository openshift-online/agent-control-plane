import { describe, expect, it } from 'vitest'
import { getPollingInterval, getSessionPollingInterval } from '../use-sessions'
import type { DomainRuntime, SessionPhase } from '@/domain/types'

const stopping: DomainRuntime = { backend: 'hypershell', status: 'Stopping', error: null, gatewayId: 'gateway' }

describe('session runtime polling', () => {
  it.each<SessionPhase>(['Completed', 'Failed', 'Stopped'])('polls %s until runtime cleanup completes', phase => {
    const session = { phase, runtime: stopping }
    expect(getSessionPollingInterval(session)).toBe(1000)
    expect(getPollingInterval([session, { phase: 'Completed', runtime: null }])).toBe(1000)
    const stopped = { phase, runtime: { ...stopping, status: 'Stopped' } }
    expect(getSessionPollingInterval(stopped)).toBe(false)
    expect(getPollingInterval([stopped])).toBe(false)
  })

  it('keeps active and pending polling unchanged', () => {
    expect(getSessionPollingInterval({ phase: 'Running' })).toBe(3000)
    expect(getSessionPollingInterval({ phase: 'Pending' })).toBe(1000)
    expect(getPollingInterval([])).toBe(15000)
  })
})
