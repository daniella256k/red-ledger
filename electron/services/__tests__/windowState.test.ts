import { describe, expect, it } from 'vitest'
import { fitWindowState, parseWindowState } from '../windowState'

const SCREEN = { x: 0, y: 0, width: 1920, height: 1040 }
const MIN = { width: 900, height: 600 }

describe('parseWindowState', () => {
  it('reads a saved state', () => {
    expect(parseWindowState({ x: 10, y: 20, width: 1200, height: 800, isMaximized: true }))
      .toEqual({ x: 10, y: 20, width: 1200, height: 800, isMaximized: true })
  })

  it('rejects missing or bad numbers', () => {
    expect(parseWindowState(null)).toBeNull()
    expect(parseWindowState({ x: 0, y: 0, width: 1200 })).toBeNull()
    expect(parseWindowState({ x: 0, y: 0, width: -5, height: 800 })).toBeNull()
    expect(parseWindowState({ x: 'a', y: 0, width: 1200, height: 800 })).toBeNull()
  })
})

describe('fitWindowState', () => {
  it('keeps a state that is on screen', () => {
    const state = { x: 100, y: 50, width: 1400, height: 900, isMaximized: false }
    expect(fitWindowState(state, [SCREEN], MIN)).toEqual(state)
  })

  it('drops a state whose screen is gone', () => {
    const state = { x: 2500, y: 50, width: 1400, height: 900, isMaximized: false }
    expect(fitWindowState(state, [SCREEN], MIN)).toBeNull()
  })

  it('drops a state with the title bar above the screen', () => {
    const state = { x: 100, y: -300, width: 1400, height: 900, isMaximized: false }
    expect(fitWindowState(state, [SCREEN], MIN)).toBeNull()
  })

  it('finds a second screen', () => {
    const left = { x: -1280, y: 0, width: 1280, height: 1000 }
    const state = { x: -1200, y: 10, width: 1000, height: 700, isMaximized: false }
    expect(fitWindowState(state, [SCREEN, left], MIN)).toEqual(state)
  })

  it('clamps the size to the minimum and to the screen', () => {
    expect(fitWindowState({ x: 0, y: 0, width: 400, height: 300, isMaximized: false }, [SCREEN], MIN))
      .toMatchObject({ width: 900, height: 600 })
    expect(fitWindowState({ x: 0, y: 0, width: 4000, height: 3000, isMaximized: false }, [SCREEN], MIN))
      .toMatchObject({ width: 1920, height: 1040 })
  })
})
