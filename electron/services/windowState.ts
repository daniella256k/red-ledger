import { readFileSync, renameSync, writeFileSync } from 'fs'

/**
 * Window size and position, remembered between launches in window-state.json.
 * No Electron imports: the caller passes the screens' work areas.
 */
export interface WindowState {
  x: number
  y: number
  width: number
  height: number
  isMaximized: boolean
}

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** Least of the window that must sit on a screen, so its title bar can still be grabbed. */
const MIN_VISIBLE_PX = 100

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

export function parseWindowState(raw: unknown): WindowState | null {
  if (!raw || typeof raw !== 'object') return null
  const { x, y, width, height, isMaximized } = raw as Record<string, unknown>
  if (!isFiniteNumber(x) || !isFiniteNumber(y) || !isFiniteNumber(width) || !isFiniteNumber(height)) return null
  if (width <= 0 || height <= 0) return null
  return { x, y, width, height, isMaximized: isMaximized === true }
}

/**
 * The saved state if it still fits a connected screen, or null to use the
 * defaults (say, after the monitor it was on was unplugged). Size is clamped
 * to the window's minimum and to the screen it lands on.
 */
export function fitWindowState(
  state: WindowState | null,
  workAreas: Rect[],
  minSize: { width: number; height: number }
): WindowState | null {
  if (!state) return null
  const area = workAreas.find((a) =>
    state.x + state.width - MIN_VISIBLE_PX >= a.x
    && state.x + MIN_VISIBLE_PX <= a.x + a.width
    && state.y >= a.y
    && state.y + MIN_VISIBLE_PX <= a.y + a.height
  )
  if (!area) return null
  return {
    ...state,
    width: Math.round(Math.min(Math.max(state.width, minSize.width), area.width)),
    height: Math.round(Math.min(Math.max(state.height, minSize.height), area.height))
  }
}

export function loadWindowState(path: string): WindowState | null {
  try {
    return parseWindowState(JSON.parse(readFileSync(path, 'utf-8')))
  } catch {
    return null
  }
}

/** Best effort: a failed write only means the next launch uses the defaults. */
export function saveWindowState(path: string, state: WindowState): void {
  const tempPath = `${path}.tmp`
  try {
    writeFileSync(tempPath, JSON.stringify(state), 'utf-8')
    renameSync(tempPath, path)
  } catch (err) {
    console.warn('[windowState] Could not save window state:', err)
  }
}
