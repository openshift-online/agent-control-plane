'use client'

import { useCallback, useSyncExternalStore } from 'react'

const STORAGE_KEY = 'ambient:last-active-project'

type LastActiveProject = {
  id: string
  name: string | null
}

let listeners: Array<() => void> = []

function emitChange() {
  for (const listener of listeners) {
    listener()
  }
}

function subscribe(listener: () => void): () => void {
  listeners = [...listeners, listener]
  return () => {
    listeners = listeners.filter((l) => l !== listener)
  }
}

function read(): LastActiveProject | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'id' in parsed &&
      typeof (parsed as Record<string, unknown>).id === 'string'
    ) {
      const obj = parsed as Record<string, unknown>
      return {
        id: obj.id as string,
        name: typeof obj.name === 'string' ? obj.name : null,
      }
    }
    return null
  } catch {
    return null
  }
}

function write(project: LastActiveProject): void {
  if (typeof window === 'undefined') return
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(project))
  } catch {
    // storage full or blocked
  }
}

let snapshot: LastActiveProject | null = read()

function getSnapshot(): LastActiveProject | null {
  return snapshot
}

function getServerSnapshot(): LastActiveProject | null {
  return null
}

export function useLastActiveProject() {
  const lastProject = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)

  const setLastProject = useCallback((id: string, name: string | null) => {
    const next: LastActiveProject = { id, name }
    write(next)
    snapshot = next
    emitChange()
  }, [])

  return { lastProject, setLastProject } as const
}
