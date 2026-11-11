import { useSyncExternalStore } from 'react'
import type { CustomToolsStatus } from '@/types'

/**
 * The loaded custom tool files, as the main process reports them. One shared
 * copy for the settings panel and the tool cards; asked for once, then kept
 * up to date by the main process's status events.
 */

let current: CustomToolsStatus | null = null
let started = false
const listeners = new Set<() => void>()

/** Put a newer status in place (also used with the answer to a reload). */
export function setCustomToolsStatus(status: CustomToolsStatus): void {
  current = status
  for (const listener of listeners) listener()
}

function start(): void {
  if (started || typeof window === 'undefined' || !window.redLedger) return
  started = true
  window.redLedger.onCustomToolsStatus(setCustomToolsStatus)
  window.redLedger.getCustomToolsStatus().then(setCustomToolsStatus).catch(() => {
    // Stays unknown; the panel shows nothing loaded and Reload asks again.
  })
}

function subscribe(listener: () => void): () => void {
  start()
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** The custom tools status, or null until the main process has answered. */
export function useCustomToolsStatus(): CustomToolsStatus | null {
  return useSyncExternalStore(subscribe, () => current, () => null)
}
