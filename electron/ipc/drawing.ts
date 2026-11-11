import { dialog, BrowserWindow } from 'electron'
import { writeFile } from 'fs/promises'
import { handleIpc } from './typedIpc'
import { assertString } from './validate'
import { drawingFileName } from '../../src/lib/svgDrawing'

/** Largest drawing file the page may ask to save. */
const MAX_DRAWING_BYTES = 64 * 1024 * 1024
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

/**
 * Saving a draw_svg drawing from the chat. The page sends the content (the
 * sanitized SVG source, or a PNG it rendered); the user picks where it goes
 * in a save dialog, so the page never names a path itself.
 */
export function registerDrawingHandlers(): void {
  handleIpc('drawing:save', async (event, nameRaw, formatRaw, data) => {
    assertString(nameRaw, 'name')
    if (formatRaw !== 'svg' && formatRaw !== 'png') throw new Error('format must be "svg" or "png"')

    let content: string | Uint8Array
    if (formatRaw === 'svg') {
      content = assertString(data, 'data')
      if (!/<svg[\s>]/i.test(content.slice(0, 2000))) throw new Error('data is not an SVG document')
    } else {
      if (!(data instanceof Uint8Array)) throw new Error('data must be PNG bytes')
      if (!PNG_SIGNATURE.every((byte, index) => data[index] === byte)) throw new Error('data is not a PNG image')
      content = data
    }
    if (content.length > MAX_DRAWING_BYTES) throw new Error('The drawing is too large to save')

    const win = BrowserWindow.fromWebContents(event.sender) || null
    const dialogOptions = {
      title: 'Save Drawing',
      defaultPath: `${drawingFileName(nameRaw)}.${formatRaw}`,
      filters: [
        formatRaw === 'svg'
          ? { name: 'SVG Image', extensions: ['svg'] }
          : { name: 'PNG Image', extensions: ['png'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    }

    const result = win
      ? await dialog.showSaveDialog(win, dialogOptions)
      : await dialog.showSaveDialog(dialogOptions)

    if (result.canceled || !result.filePath) {
      return { ok: false, canceled: true } as const
    }

    try {
      await writeFile(result.filePath, content, typeof content === 'string' ? 'utf-8' : undefined)
      return { ok: true, path: result.filePath } as const
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { ok: false, canceled: false, error: message } as const
    }
  })
}
