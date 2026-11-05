import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { BrowserWindow } from 'electron'

const showMessageBox = vi.fn()
vi.mock('electron', () => ({ dialog: { showMessageBox } }))

const { toolDialog } = await import('../toolDialog')
const { WorkspaceService } = await import('../../../services/WorkspaceService')
const { sanitizeSettings } = await import('../../../services/SettingsService')

const win = { isDestroyed: () => false } as unknown as BrowserWindow
const question = { type: 'question' as const, buttons: ['Deny', 'Allow'], defaultId: 0, title: 'T', message: 'M' }

describe('toolDialog', () => {
  beforeEach(() => showMessageBox.mockReset())

  it('asks over the window, with Deny as the cancel answer and the reply\'s stop signal', async () => {
    showMessageBox.mockResolvedValue({ response: 1 })
    const controller = new AbortController()
    await expect(toolDialog(win, controller.signal).showMessageBox(question)).resolves.toEqual({ response: 1 })
    expect(showMessageBox).toHaveBeenCalledWith(win, expect.objectContaining({ cancelId: 0, signal: controller.signal }))
  })

  it('refuses without asking when there is no window', async () => {
    await expect(toolDialog(null).showMessageBox(question)).rejects.toMatchObject({ code: 'USER_DENIED' })
    const destroyed = { isDestroyed: () => true } as unknown as BrowserWindow
    await expect(toolDialog(destroyed).showMessageBox(question)).rejects.toMatchObject({ code: 'USER_DENIED' })
    expect(showMessageBox).not.toHaveBeenCalled()
  })

  it('refuses when the reply was stopped, before or while asking', async () => {
    const stopped = new AbortController()
    stopped.abort()
    await expect(toolDialog(win, stopped.signal).showMessageBox(question)).rejects.toMatchObject({ code: 'CANCELLED' })
    expect(showMessageBox).not.toHaveBeenCalled()

    const controller = new AbortController()
    showMessageBox.mockImplementation(async () => {
      controller.abort()
      return { response: 0 }
    })
    await expect(toolDialog(win, controller.signal).showMessageBox(question)).rejects.toMatchObject({ code: 'CANCELLED' })
  })
})

describe('file tools without a window', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'rl-tooldialog-'))
    showMessageBox.mockReset()
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  function workspace(strictMode: boolean) {
    const service = new WorkspaceService(() => ({ ...sanitizeSettings(undefined), strictMode }))
    service.setWorkspacePath(root)
    return service
  }

  it('never overwrites a file unconfirmed', async () => {
    writeFileSync(join(root, 'notes.txt'), 'original')
    await expect(workspace(false).writeFile(toolDialog(null), 'notes.txt', 'replaced'))
      .rejects.toMatchObject({ code: 'USER_DENIED' })
    expect(readFileSync(join(root, 'notes.txt'), 'utf-8')).toBe('original')
  })

  it('refuses Strict Mode operations instead of skipping the question', async () => {
    writeFileSync(join(root, 'notes.txt'), 'original')
    const service = workspace(true)
    await expect(service.readFileSlice(toolDialog(null), 'notes.txt')).rejects.toMatchObject({ code: 'USER_DENIED' })
    await expect(service.editFile(toolDialog(null), 'notes.txt', 'edited')).rejects.toMatchObject({ code: 'USER_DENIED' })
    await expect(service.writeFile(toolDialog(null), 'new.txt', 'x')).rejects.toMatchObject({ code: 'USER_DENIED' })
    expect(readFileSync(join(root, 'notes.txt'), 'utf-8')).toBe('original')
  })

  it('still creates new files outside Strict Mode, where nothing asks', async () => {
    await workspace(false).writeFile(toolDialog(null), 'new.txt', 'hello')
    expect(readFileSync(join(root, 'new.txt'), 'utf-8')).toBe('hello')
  })
})
